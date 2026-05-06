# Copyright 2024-2025 InfiniKV Authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Standard
from collections import OrderedDict
from concurrent.futures import Future
from typing import TYPE_CHECKING, List, Optional, Dict
import asyncio
import os
import threading
import time
import pickle
import json
import hashlib
from collections import defaultdict
from pathlib import Path
# Third Party
import torch
import nvtx

# First Party
from infinikv.config import InfiniKVEngineMetadata, InfiniKVEngineConfig
from infinikv.logging import init_logger
from infinikv.observability import InfiniKVStatsMonitor
from infinikv.utils import CacheEngineKey, _infinikv_nvtx_annotate, GPUFileMetadata
from infinikv.v1.cache_controller.message import KVAdmitMsg, KVEvictMsg
from infinikv.v1.lookup_server import LookupServerInterface
from infinikv.v1.storage_backend.evictor import LRUEvictor
try:
    import infinikv._custom_ops as geminifs_ops
    _geminifs_available = True
    print("Successfully imported infinikv._custom_ops")
except ImportError as e:
    _geminifs_available = False
    print("Failed to import infinikv._custom_ops with %r", e)
    geminifs_ops = None

import infinikv.c_ops as infinikv_ops

if TYPE_CHECKING:
    # First Party
    from infinikv.v1.cache_controller.worker import InfiniKVWorker


logger = init_logger(__name__)


class GeminiFSBackend:
    def __init__(
        self,
        config: InfiniKVEngineConfig,
        metadata: InfiniKVEngineMetadata,
        infinikv_worker: Optional["InfiniKVWorker"] = None,
        lookup_server: Optional[LookupServerInterface] = None,
    ):

        # 内存索引，后续用可持久化的数据结构代替
        self.dict: Dict[CacheEngineKey, GPUFileMetadata] = {}
        # TODO: 需要这个锁吗？
        self.disk_lock = threading.Lock()
        self.stats_monitor = InfiniKVStatsMonitor.GetOrCreate()

        self.usage = 0

        self.lookup_server = lookup_server

        self.infinikv_worker = infinikv_worker
        self.instance_id = config.infinikv_instance_id

        assert config.sys_config_path is not None
        self.sys_config_path: str = config.sys_config_path

        self.mount_path: str = config.mount_path
        self.snapshot_filename: str = config.snapshot_filename
        self.snapshot_path: str = os.path.join(
            self.mount_path, self.snapshot_filename)

        # self._restore_from_snapshot()

        self.max_capacity: int = config.max_local_disk_size * \
            1024 * 1024 * 1024  # convert to bytes

        # get config for kv shape and dtype
        # (num_layer, 2 , chunk_size, num_kv_head, head_size)
        self.kv_shape = metadata.kv_shape  # tuple[int, int, int, int, int]
        self.kv_dtype = metadata.kv_dtype  # torch.dtype
        self.use_mla = metadata.use_mla

        kv_size = self.kv_shape[2] * self.kv_shape[3] * \
            self.kv_shape[4] * self.kv_dtype.itemsize

        self.num_layers = self.kv_shape[0]

        # GeminiFS C++ K+V API uses layer_idx * len * 2 offsets;
        # unified MLA API uses layer_idx * len. Set shape[0] accordingly.
        kv_dim = 1 if self.use_mla else 2
        self.gpu_file_shape = [kv_dim, self.kv_shape[0], kv_size]

        self.per_file_size = self.gpu_file_shape[0] * \
            self.gpu_file_shape[1] * self.gpu_file_shape[2]

        self.max_num_local_file = self.max_capacity // self.per_file_size
        logger.info(f"GeminiFSBackend initialized with max capacity {self.max_num_local_file} files, ")
        # Initialize the evictor
        self.evictor = LRUEvictor(max_cache_size=config.max_local_disk_size)

        self.device_id = torch.cuda.current_device()

        print(f"Initializing GeminiFS on device : {self.device_id}", flush=True)

        # GeminiFS 会从 config 文件找到自己对应的 GPU 配置进行初始化
        assert geminifs_ops.initialize_geminifs(config.sys_config_path,
                                                self.max_num_local_file,
                                                self.gpu_file_shape,
                                                True)
        # TODO: 利用一个  gpu buffer: torch.Tensor 替代
        self.gpu_buffers: dict[str, torch.Tensor] = {}

        self.load_stream = torch.cuda.Stream(self.device_id)
        self.load_stream1 = torch.cuda.Stream(self.device_id)

        self.load_streams = [torch.cuda.Stream(
            self.device_id) for _ in range(self.num_layers // 8)]

        self.store_stream = torch.cuda.Stream(self.device_id)
        self.num_gpu_files = 0

        # 模型层级流并发读
        self.registered: set[int] = set()

    def __str__(self):
        return self.__class__.__name__

    def _get_kv_block(self, kvcache: torch.Tensor, block_id: int):
        """Get K and V cache slices for a block, handling MLA vs standard.

        For MLA: kvcache shape is (num_blocks, block_size, head_size),
                 returns the same tensor as both K and V.
        For standard: kvcache shape is (2, num_blocks, block_size, ...),
                      returns kvcache[0, block_id] and kvcache[1, block_id].
        """
        if self.use_mla:
            block = kvcache[block_id]
            return block, block
        else:
            return kvcache[0, block_id], kvcache[1, block_id]

    def register_kv_caches(self, kv_caches: dict[str, torch.Tensor]):
        for layer_name, kvcache in kv_caches.items():
            assert kvcache.device.index == self.device_id
            if not geminifs_ops.register_tensor_with_gpu(kvcache, self.gpu_file_shape[2]):
                logger.error("register kvcache failed")
                assert False
            logger.info(
                f"register kvcache {layer_name} with shape {kvcache.shape} and granularity {self.gpu_file_shape[2]}")

    def register_kv_caches_batch(self, kv_caches: dict[str, torch.Tensor]):
        """
        Batch register a list of layer tensors to GeminiFS in one call.
        """
        tensor_list: list[torch.Tensor] = []
        for layer_name, kvcache in kv_caches.items():
            assert kvcache.device.index == self.device_id
            tensor_list.append(kvcache)
        if len(tensor_list) == 0:
            logger.warning(
                "register_kv_caches_batch called with empty kv_caches")
            return
        ok = geminifs_ops.register_tensors_with_gpu(
            tensor_list, self.gpu_file_shape[2])
        if not ok:
            logger.error("Batch register kvcaches failed")
            assert False
        logger.info(
            f"Batch registered {len(tensor_list)} KV layer tensors with granularity {self.gpu_file_shape[2]}")

    def register_single_tensor(self, kv_cache: torch.Tensor):
        """Register a single (cross-layer) KV cache tensor with GeminiFS.

        This is the preferred path: one contiguous GPU buffer covering
        all layers is registered for DMA instead of many per-layer
        tensors.  This avoids issues where successive DMA registrations
        corrupt the CUDA memory pool and cause 'tensor without storage'
        errors.
        """
        assert kv_cache.device.index == self.device_id
        granularity = self.gpu_file_shape[2]
        tensor_bytes = kv_cache.numel() * kv_cache.element_size()
        logger.info(
            "Registering cross-layer KV cache: shape=%s, dtype=%s, "
            "size=%d bytes, granularity=%d",
            kv_cache.shape, kv_cache.dtype, tensor_bytes, granularity,
        )
        if not geminifs_ops.register_tensor_with_gpu(kv_cache, granularity):
            logger.error(
                "Failed to register cross-layer KV cache tensor "
                "(shape=%s, size=%d bytes)", kv_cache.shape, tensor_bytes,
            )
            assert False, (
                f"GeminiFS register_tensor_with_gpu failed for cross-layer "
                f"tensor of shape {kv_cache.shape} ({tensor_bytes} bytes)"
            )
        logger.info(
            "Successfully registered cross-layer KV cache with GeminiFS"
        )

    # 返回的是存储kv的路径
    def _key_to_path(
        self,
        key: CacheEngineKey,
    ) -> str:
        return os.path.join(self.path, key.to_string().replace("/", "-") + ".pt")

    def contains(self, key: CacheEngineKey, pin: bool = False) -> bool:
        with self.disk_lock:
            if key not in self.dict:
                return False
            return True

    def get(self, key: CacheEngineKey) -> GPUFileMetadata:
        with self.disk_lock:
            if key in self.dict:
                return self.dict[key]
            return None

    def allocate(self, key: CacheEngineKey) -> GPUFileMetadata:
        gpu_file_id = geminifs_ops.gpu_open_file(self.device_id)
        if gpu_file_id is None:
            logger.warning("Failed to allocate gpu file")
            return None
        self.num_gpu_files += 1
        # logger.info(f"current num gpu files: {self.num_gpu_files}")
        gpu_file_meta = GPUFileMetadata(gpu_file_id, key)
        self.dict[key] = gpu_file_meta
        return gpu_file_meta

    @_infinikv_nvtx_annotate
    def layerwise_batch_put(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        layer_ids: List[int],
        stream: torch.cuda.Stream
    ):
        assert len(gpu_files) == len(block_ids) and len(
            block_ids) == len(layer_ids)
        gpu_file_ids = []
        layer = layer_ids[0]
        rng = nvtx.start_range("prepare kv cache", color="blue")
        if self.use_mla:
            caches = []
            for gpu_file, block_id, layer_id in zip(gpu_files, block_ids, layer_ids):
                assert layer == layer_id
                cache = kvcaches[layer_id][block_id]
                assert cache.is_contiguous() and cache.is_cuda
                caches.append(cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            stream.wait_stream(torch.cuda.current_stream())
            geminifs_ops.geminifs_batched_write_unified(
                caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)
        else:
            k_caches = []
            v_caches = []
            for gpu_file, block_id, layer_id in zip(gpu_files, block_ids, layer_ids):
                assert layer == layer_id
                k_cache, v_cache = self._get_kv_block(kvcaches[layer_id], block_id)
                assert k_cache.is_contiguous() and k_cache.is_cuda
                k_caches.append(k_cache)
                v_caches.append(v_cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            stream.wait_stream(torch.cuda.current_stream())
            geminifs_ops.geminifs_batched_write(
                k_caches, v_caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)

    @_infinikv_nvtx_annotate
    def layerwise_batch_put_for_async(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        layer_ids: List[int],
        stream: torch.cuda.Stream,
        load_stream: torch.cuda.stream,
        completion_event: torch.Event,
    ):
        assert len(gpu_files) == len(block_ids) and len(
            block_ids) == len(layer_ids)
        gpu_file_ids = []
        layer = layer_ids[0]
        rng = nvtx.start_range("prepare kv cache", color="blue")
        if self.use_mla:
            caches = []
            for gpu_file, block_id, layer_id in zip(gpu_files, block_ids, layer_ids):
                assert layer == layer_id
                cache = kvcaches[layer_id][block_id]
                assert cache.is_contiguous() and cache.is_cuda
                caches.append(cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            stream.wait_stream(load_stream)
            stream.wait_event(completion_event)
            geminifs_ops.geminifs_batched_write_unified(
                caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)
        else:
            k_caches = []
            v_caches = []
            for gpu_file, block_id, layer_id in zip(gpu_files, block_ids, layer_ids):
                assert layer == layer_id
                k_cache, v_cache = self._get_kv_block(kvcaches[layer_id], block_id)
                assert k_cache.is_contiguous() and k_cache.is_cuda
                k_caches.append(k_cache)
                v_caches.append(v_cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            stream.wait_stream(load_stream)
            stream.wait_event(completion_event)
            geminifs_ops.geminifs_batched_write(
                k_caches, v_caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)

    def batched_get(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
    ):
        assert len(block_ids) == len(gpu_files)

        for layer in range(self.num_layers):
            kvcache = kvcaches[layer]
            assert kvcache.is_contiguous()
            gpu_file_ids = []
            stream = self.load_stream if layer % 2 == 0 else self.load_stream1
            if self.use_mla:
                caches = []
                for gpu_file, block_id in zip(gpu_files, block_ids):
                    cache = kvcache[int(block_id)]
                    assert cache.is_contiguous()
                    caches.append(cache)
                    gpu_file_ids.append(gpu_file.id)
                geminifs_ops.geminifs_batched_read_unified(
                    caches, gpu_file_ids, layer,
                    geminifs_ops.get_gpu_controller(self.device_id),
                    stream.cuda_stream)
            else:
                k_caches = []
                v_caches = []
                for gpu_file, block_id in zip(gpu_files, block_ids):
                    k_cache, v_cache = self._get_kv_block(kvcache, int(block_id))
                    assert k_cache.is_contiguous()
                    k_caches.append(k_cache)
                    v_caches.append(v_cache)
                    gpu_file_ids.append(gpu_file.id)
                geminifs_ops.geminifs_batched_read(
                    k_caches, v_caches, gpu_file_ids, layer,
                    geminifs_ops.get_gpu_controller(self.device_id),
                    stream.cuda_stream)
        self.load_stream.synchronize()
        self.load_stream1.synchronize()

    def batched_put(
        self,
        request_id: str,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: torch.Tensor,
    ):
        assert len(block_ids) == len(gpu_files)
        assert len(block_ids) > 0 and len(gpu_files) > 0
        block_ids_list = block_ids.tolist()
        with torch.cuda.stream(self.store_stream):
            for layer in range(self.num_layers):
                kvcache = kvcaches[layer]
                assert kvcache.is_contiguous()
                gpu_file_ids = []
                if self.use_mla:
                    caches = []
                    for gpu_file, block_id in zip(gpu_files, block_ids_list):
                        cache = kvcache[int(block_id)]
                        assert cache.is_contiguous()
                        caches.append(cache)
                        gpu_file_ids.append(gpu_file.id)
                    geminifs_ops.geminifs_batched_write_unified(
                        caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), self.store_stream)
                else:
                    k_caches = []
                    v_caches = []
                    for gpu_file, block_id in zip(gpu_files, block_ids_list):
                        k_cache, v_cache = self._get_kv_block(kvcache, int(block_id))
                        assert k_cache.is_contiguous()
                        k_caches.append(k_cache)
                        v_caches.append(v_cache)
                        gpu_file_ids.append(gpu_file.id)
                    geminifs_ops.geminifs_batched_write(
                        k_caches, v_caches, gpu_file_ids, layer, geminifs_ops.get_gpu_controller(self.device_id), self.store_stream)

    @_infinikv_nvtx_annotate
    def layerwise_batch_get(
        self,
        kvcaches: List[torch.Tensor],
        layer: int,
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.stream
    ):
        """
        同步上一层发起的本层 kvcache 的预取，发起下一层 kvcache 的预取
        """
        current_stream = torch.cuda.current_stream()
        current_stream.wait_stream(stream)

        if layer + 1 >= self.num_layers:
            return
        kv_cache = kvcaches[layer + 1]
        assert kv_cache.is_cuda
        assert len(gpu_files) == len(block_ids)
        gpu_file_ids = []
        rng = nvtx.start_range("prepare kv cache", color="blue")
        if self.use_mla:
            caches = []
            for gpu_file, block_id in zip(gpu_files, block_ids):
                cache = kv_cache[block_id]
                assert cache.is_contiguous() and cache.is_cuda
                caches.append(cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            geminifs_ops.geminifs_batched_read_unified(
                caches, gpu_file_ids, layer + 1,
                geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)
        else:
            k_caches = []
            v_caches = []
            for gpu_file, block_id in zip(gpu_files, block_ids):
                k_cache, v_cache = self._get_kv_block(kv_cache, block_id)
                assert k_cache.is_contiguous() and k_cache.is_cuda
                k_caches.append(k_cache)
                v_caches.append(v_cache)
                gpu_file_ids.append(gpu_file.id)
            nvtx.end_range(rng)
            geminifs_ops.geminifs_batched_read(
                k_caches, v_caches, gpu_file_ids, layer + 1,
                geminifs_ops.get_gpu_controller(self.device_id), stream.cuda_stream)

    def persist(
        self,
    ) -> bool:
        """
        Persist the current dict state to the disk snapshot file

        Returns:
            bool: Whether the persistence is successful
        """
        try:
            with self.disk_lock:
                # 准备要序列化的数据
                snapshot_data = {
                    'dict': self.dict,
                    'usage': self.usage,
                    'instance_id': self.instance_id,
                    'timestamp': time.time(),
                    'version': '1.0'
                }

                # 创建临时文件，避免写入过程中的数据损坏
                temp_snapshot_path = self.snapshot_path + '.tmp'

                with open(temp_snapshot_path, 'wb') as f:
                    pickle.dump(snapshot_data, f)

                # 原子性地重命名文件
                os.replace(temp_snapshot_path, self.snapshot_path)

                logger.info(f"Successfully persisted dict snapshot to {self.snapshot_path}, "
                            f"contains {len(self.dict)} entries, total usage: {self.usage} bytes")
                return True

        except Exception as e:
            logger.error(f"Failed to persist dict snapshot: {e}")
            return False

    def pin(
        self,
        key: CacheEngineKey,
    ) -> bool:
        with self.disk_lock:
            if key in self.dict:
                self.dict[key].pin()
                return True
            else:
                return False

    def unpin(
        self,
        key: CacheEngineKey,
    ) -> bool:
        with self.disk_lock:
            if key in self.dict:
                self.dict[key].unpin()
                return True
            else:
                return False

    def remove(
        self,
        key: CacheEngineKey,
    ) -> None:
        id = self.dict[key].id
        size = self.dict[key].size

        self.disk_lock.acquire()
        self.dict.pop(key)
        self.disk_lock.release()

        self.usage -= size
        self.stats_monitor.update_local_storage_usage(self.usage)

        # push kv evict msg
        if self.infinikv_worker is not None:
            self.infinikv_worker.put_msg(
                KVEvictMsg(self.instance_id, key.worker_id,
                           key.chunk_hash, "geminifs_disk")
            )

    @_infinikv_nvtx_annotate
    def insert_key(self, key: CacheEngineKey) -> None:
        id = self._key_to_id(key)

        has_stored = False
        with self.disk_lock:
            # Need to do reinsert to update cache recency
            if key in self.dict:
                self.dict.pop(key)
                has_stored = True
            # 重新插入到队尾
            self.dict[key] = GPUFileMetadata(id, self.per_file_size, torch.Size(
                self.kv_shape), self.kv_dtype, False, has_stored)

        # push kv admit msg
        if self.infinikv_worker is not None and not has_stored:
            self.infinikv_worker.put_msg(
                KVAdmitMsg(self.instance_id, key.worker_id,
                           key.chunk_hash, "geminifs_disk")
            )

    @_infinikv_nvtx_annotate
    def _restore_from_snapshot(self) -> bool:
        """
        restore the dict state from the snapshot file

        Returns:
            bool: whether the restoration is successful
        """
        try:
            if not os.path.exists(self.snapshot_path):
                logger.info(
                    f"snapshot file not found: {self.snapshot_path}, skip restoration")
                return False

            with open(self.snapshot_path, 'rb') as f:
                snapshot_data = pickle.load(f)

            # verify the snapshot data
            if not isinstance(snapshot_data, dict):
                logger.error(
                    "snapshot file format error: not a valid dictionary")
                return False

            required_keys = ['dict', 'usage', 'instance_id', 'timestamp']
            if not all(key in snapshot_data for key in required_keys):
                logger.error(
                    "snapshot file format error: missing required fields")
                return False

            # restore the data
            with self.disk_lock:
                self.dict = snapshot_data['dict']
                # 更新当前的usage
                self.usage = snapshot_data['usage']
                assert self.usage <= self.max_capacity, "usage is greater than max capacity"
                # verify the restored data
                if not isinstance(self.dict, OrderedDict):
                    logger.error("snapshot dict format error")
                    return False

                # update the statistics
                self.stats_monitor.update_local_storage_usage(self.usage)

                logger.info(f"successfully restored dict state from snapshot: {self.snapshot_path}, "
                            f"contains {len(self.dict)} entries, total usage: {self.usage} bytes, "
                            f"snapshot time: {time.ctime(snapshot_data['timestamp'])}")
                return True

        except Exception as e:
            logger.error(f"failed to restore dict state from snapshot: {e}")
            return False

    @_infinikv_nvtx_annotate
    def get_snapshot_info(self) -> Optional[dict]:
        """
        get the information of the snapshot file

        Returns:
            Optional[dict]: the snapshot information, return None if not exists
        """
        try:
            if not os.path.exists(self.snapshot_path):
                return None

            with open(self.snapshot_path, 'rb') as f:
                snapshot_data = pickle.load(f)

            return {
                'snapshot_path': self.snapshot_path,
                'file_size': os.path.getsize(self.snapshot_path),
                'timestamp': snapshot_data.get('timestamp'),
                'instance_id': snapshot_data.get('instance_id'),
                'dict_size': len(snapshot_data.get('dict', {})),
                'usage': snapshot_data.get('usage', 0)
            }

        except Exception as e:
            logger.error(f"failed to get snapshot information: {e}")
            return None

    def close(self) -> None:
        # logger.info("Saving dict snapshot...")
        # self.persist()

        if self.lookup_server is not None:
            self.disk_lock.acquire()
            self.lookup_server.batched_remove(list(self.dict.keys()))
            self.disk_lock.release()

        # TODO: Free GeminiFS

    # ==============================
    # Mamba / GDN recurrent state support
    # ==============================

    def register_mamba_caches_batch(
        self, mamba_caches: List[torch.Tensor]
    ) -> None:
        """Register mamba state tensors with GeminiFS.

        Mamba states are stored as fixed-size blobs per block, unlike KV cache
        which is layer-wise. Each tensor in mamba_caches corresponds to one
        mamba layer's state pool.

        Args:
            mamba_caches: list of mamba state tensors to register.
        """
        if len(mamba_caches) == 0:
            logger.warning("register_mamba_caches_batch called with empty list")
            return

        for i, cache in enumerate(mamba_caches):
            assert cache.is_cuda, f"Mamba cache {i} must be on GPU"
            # Calculate per-block granularity: total_size / num_blocks
            # Mamba state shape is typically [num_blocks, state_dim]
            if cache.dim() >= 2:
                per_block_bytes = cache[0].numel() * cache[0].element_size()
            else:
                per_block_bytes = cache.numel() * cache.element_size()

            if not geminifs_ops.register_tensor_with_gpu(cache, per_block_bytes):
                logger.error(f"Failed to register mamba cache {i}")
                assert False
        logger.info(
            f"Registered {len(mamba_caches)} mamba state tensors with GeminiFS"
        )

    def mamba_batched_get(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Load mamba states from GeminiFS.

        Reads the complete mamba state blob for each (gpu_file, block_id) pair.
        Unlike KV cache which is read layer-by-layer, mamba states are read
        as a single contiguous blob per block.

        Args:
            mamba_caches: list of mamba state tensors (one per mamba layer).
            gpu_files: GPU file metadata for blocks to load.
            block_ids: block indices into the mamba_caches tensors.
            stream: CUDA stream to use.
        """
        if len(gpu_files) == 0:
            return

        # For each mamba layer, read the state for all blocks
        for layer_idx, cache in enumerate(mamba_caches):
            src_tensors = []
            gpu_file_ids = []
            for gpu_file, block_id in zip(gpu_files, block_ids):
                state_slice = cache[block_id]
                assert state_slice.is_contiguous() and state_slice.is_cuda
                src_tensors.append(state_slice)
                gpu_file_ids.append(gpu_file.id)
            # Use dummy k/v read with mamba state as k and empty v
            # The GeminiFS read API treats data as opaque blobs
            geminifs_ops.geminifs_batched_read(
                src_tensors, src_tensors, gpu_file_ids, layer_idx,
                geminifs_ops.get_gpu_controller(self.device_id),
                stream.cuda_stream,
            )
        current_stream = torch.cuda.current_stream()
        current_stream.wait_stream(stream)

    def mamba_batched_put(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Store mamba states to GeminiFS.

        Writes the complete mamba state blob for each (gpu_file, block_id) pair.

        Args:
            mamba_caches: list of mamba state tensors (one per mamba layer).
            gpu_files: GPU file metadata for blocks to store.
            block_ids: block indices into the mamba_caches tensors.
            stream: CUDA stream to use.
        """
        if len(gpu_files) == 0:
            return

        for layer_idx, cache in enumerate(mamba_caches):
            src_tensors = []
            gpu_file_ids = []
            for gpu_file, block_id in zip(gpu_files, block_ids):
                state_slice = cache[block_id]
                assert state_slice.is_contiguous() and state_slice.is_cuda
                src_tensors.append(state_slice)
                gpu_file_ids.append(gpu_file.id)
            stream.wait_stream(torch.cuda.current_stream())
            geminifs_ops.geminifs_batched_write(
                src_tensors, src_tensors, gpu_file_ids, layer_idx,
                geminifs_ops.get_gpu_controller(self.device_id),
                stream.cuda_stream,
            )
