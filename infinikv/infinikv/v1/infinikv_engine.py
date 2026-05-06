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
from typing import Dict, Generator, List, Optional, Union, Tuple
import multiprocessing
import time

# Third Party
import torch

# First Party
from infinikv.config import InfiniKVEngineMetadata
from infinikv.logging import init_logger
from infinikv.observability import InfiniKVStatsLogger, InfiniKVStatsMonitor
from infinikv.utils import CacheEngineKey, _infinikv_nvtx_annotate, GPUFileMetadata
from infinikv.config import InfiniKVEngineConfig

from infinikv.v1.lookup_server import LookupServerInterface

from infinikv.v1.storage_backend.geminifs_backend import GeminiFSBackend
from infinikv.v1.token_database import (
    ChunkedTokenDatabase,
    TokenDatabase,
)

logger = init_logger(__name__)


class CacheEngineEndSignal:
    pass


class InfiniKVEngine:
    """The main class for the cache engine.

    When storing the KV caches into the cache engine, it takes GPU KV
    caches from the serving engine and convert them into MemoryObjs that
    resides in the CPU. The MemoryObjs are then being stored into the
    StorageBackends in an asynchronous manner.

    When retrieving the KV caches from the cache engine, it fetches the
    MemoryObjs from the StorageBackends and convert them into GPU KV caches
    by GPUConnectors specialized for the serving engine.

    It also supports prefetching the KV caches from the StorageBackends.
    It relies on the StorageBackends to manage the requests of prefetching
    and real retrieval and avoid the conflicts.
    """

    def __init__(
        self,
        config: InfiniKVEngineConfig,
        metadata: InfiniKVEngineMetadata,
        token_database: TokenDatabase,
    ):
        logger.info(f"Creating InfiniKVEngine with config: {config}")
        self.config = config
        self.metadata = metadata

        self.token_database = token_database

        # NOTE: Unix systems use fork by default
        multiprocessing.set_start_method("spawn", force=True)

        self.lookup_server: Optional[LookupServerInterface] = None

        # avoid circular import
        # First Party
        from infinikv.v1.cache_controller import InfiniKVWorker

        self.infinikv_worker: Optional[InfiniKVWorker] = None
        if self.config.enable_controller:
            self.infinikv_worker = InfiniKVWorker(config, metadata, self)

        self.storage_backend = GeminiFSBackend(
            config, metadata, self.infinikv_worker, self.lookup_server)

        self.num_layers = metadata.kv_shape[0]

        self.lookup_cache = {}

        # NOTE: ignore it for now
        # InitializeInfiniKVUsageContext(config, metadata)
        self.stats_monitor = InfiniKVStatsMonitor.GetOrCreate()

    # @_infinikv_nvtx_annotate
    # def register_kv_caches(self, kv_caches: dict[str, torch.Tensor]):
    #     self.storage_backend.register_kv_caches(kv_caches)

    @_infinikv_nvtx_annotate
    def register_kv_caches(self, kv_caches: dict[str, torch.Tensor]):
        """
        Batch register KV caches to the backend using GeminiFS batch API.
        """
        self.storage_backend.register_kv_caches_batch(kv_caches)

    @_infinikv_nvtx_annotate
    def register_cross_layers_kv_cache(self, kv_cache: torch.Tensor):
        """
        Register a single cross-layer KV cache tensor with GeminiFS.
        This is preferred over register_kv_caches as it requires only
        one DMA registration for the entire KV cache buffer.
        """
        self.storage_backend.register_single_tensor(kv_cache)

    @_infinikv_nvtx_annotate
    def register_mamba_caches_batch(
        self, mamba_caches: List[torch.Tensor]
    ) -> None:
        """Register mamba/GDN recurrent state tensors to GeminiFS.

        For hybrid models, these tensors store conv_state + ssm_state
        for each linear_attention layer.

        Args:
            mamba_caches: list of mamba state tensors to register.
        """
        self.storage_backend.register_mamba_caches_batch(mamba_caches)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def prepare_for_load_mamba(
        self,
        tokens: torch.Tensor,
        mask: Optional[torch.Tensor],
        block_ids: Optional[torch.Tensor],
    ) -> Tuple[torch.Tensor, List[GPUFileMetadata], List[int]]:
        """Prepare to load mamba states from GeminiFS.

        Uses the same prefix-based token hashing as KV cache to locate
        cached mamba states.

        Returns:
            (ret_mask, gpu_files, blocks_to_load) same structure as
            prepare_for_load.
        """
        # Mamba states share the same prefix hash keys as KV cache
        return self.prepare_for_load(tokens, mask, block_ids)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def prepare_for_store_mamba(
        self,
        tokens: torch.Tensor,
        mask: Optional[torch.Tensor],
        block_ids: Optional[torch.Tensor],
        offset: Optional[int] = None,
    ) -> Tuple[List[GPUFileMetadata], List[int]]:
        """Prepare to store mamba states to GeminiFS.

        Uses the same prefix-based token hashing as KV cache.

        Returns:
            (gpu_files, blocks_to_save) same structure as prepare_for_store.
        """
        return self.prepare_for_store(tokens, mask, block_ids, offset)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def retrieve_mamba_state(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Load mamba recurrent states from GeminiFS.

        Args:
            mamba_caches: list of mamba state tensors (one per mamba layer).
            gpu_files: GPU file metadata for each block to load.
            block_ids: vLLM block IDs corresponding to each gpu_file.
            stream: CUDA stream to execute on.
        """
        self.storage_backend.mamba_batched_get(
            mamba_caches, gpu_files, block_ids, stream
        )

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def store_mamba_state(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Store mamba recurrent states to GeminiFS.

        Args:
            mamba_caches: list of mamba state tensors (one per mamba layer).
            gpu_files: GPU file metadata for each block to store.
            block_ids: vLLM block IDs corresponding to each gpu_file.
            stream: CUDA stream to execute on.
        """
        self.storage_backend.mamba_batched_put(
            mamba_caches, gpu_files, block_ids, stream
        )

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def prepare_for_load(
        self,
        tokens: torch.Tensor,
        mask: Optional[torch.Tensor] = None,
        block_ids: Optional[torch.Tensor] = None
    ) -> Tuple[torch.Tensor,
               List[GPUFileMetadata],
               List[int]
               ]:
        """
            return cached_file_ids and inner_block_ids
        """
        if mask is not None:
            num_required_tokens = torch.sum(mask).item()
        else:
            num_required_tokens = len(tokens)
        monitor_req_id = self.stats_monitor.on_retrieve_request(
            num_required_tokens)

        ret_mask = torch.zeros_like(tokens, dtype=torch.bool, device="cpu")

        gpu_files = []
        blocks_to_load = []
        index = 0

        for start, end, key in self.token_database.process_tokens(tokens, mask):
            assert isinstance(key, CacheEngineKey)

            if key in self.lookup_cache:
                # TODO(Jiayi): we can reduce the number of `contains` calls
                # by checking the lookup cache first (should be updated in `lookup`)
                pass
            else:
                gpu_file_meta = self.storage_backend.get(key)
                if gpu_file_meta is None:
                    break

                ret_mask[start:end] = True
                gpu_files.append(gpu_file_meta)
                blocks_to_load.append(block_ids[index].item())
                index += 1

        retrieved_tokens = torch.sum(ret_mask)
        self.stats_monitor.on_retrieve_finished(
            monitor_req_id, retrieved_tokens)
        logger.debug(
            f"Prepare to retrieve {retrieved_tokens} "
            f"out of {num_required_tokens} "
            f"out of total {len(tokens)} tokens"
        )
        return ret_mask, gpu_files, blocks_to_load

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def prepare_for_store(
        self,
        tokens: torch.Tensor,
        mask: Optional[torch.Tensor] = None,
        block_ids: Optional[torch.Tensor] = None,
        offset: Optional[int] = None,
    ) -> Tuple[List[GPUFileMetadata], List[int]]:
        if mask is not None:
            num_to_store_tokens = torch.sum(mask).item()
        else:
            num_to_store_tokens = len(tokens)
        monitor_req_id = self.stats_monitor.on_store_request(
            num_to_store_tokens)

        tot_token_num = 0
        keys = []
        gpu_files = []
        blocks_to_save = []
        index = 0

        for start, end, key in self.token_database.process_tokens(tokens, mask):
            assert isinstance(key, CacheEngineKey)
            if self.storage_backend.contains(key):
                continue
            # Allocate the gpu file
            num_tokens = end - start
            # TODO: 批量分配 gpufile
            # NOTE: 这里会提前更新索引，一致性要求不高，即使索引更新但 kv 未持久化，只要重算 chunk 就行
            gpu_file = self.storage_backend.allocate(key)

            if gpu_file is None:
                # no file to store
                break
            blocks_to_save.append(block_ids[index].item())
            index += 1

            keys.append(key)
            gpu_files.append(gpu_file)
            tot_token_num += num_tokens

        if self.lookup_server is not None:
            self.lookup_server.batched_insert(keys)

        self.stats_monitor.on_store_finished(monitor_req_id, tot_token_num)

        return gpu_files, blocks_to_save

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def retrive(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
    ):
        self.storage_backend.batched_get(kvcaches, gpu_files, block_ids)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def store(
        self,
        request_id: str,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: torch.Tensor,
    ):
        self.storage_backend.batched_put(
            request_id, kvcaches, gpu_files, block_ids)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def store_layer(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        layer_ids: List[int],
        stream: torch.cuda.Stream
    ):
        self.storage_backend.layerwise_batch_put(
            kvcaches, gpu_files, block_ids, layer_ids, stream)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def store_layer_for_async(
        self,
        kvcaches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        layer_ids: List[int],
        stream: torch.cuda.stream,
        load_stream: torch.cuda.stream,
        completion_event: torch.Event
    ):
        self.storage_backend.layerwise_batch_put_for_async(
            kvcaches, gpu_files, block_ids, layer_ids, stream, load_stream, completion_event)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def retrieve_layer(
        self,
        kvcaches: List[torch.Tensor],
        next_layer: int,
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.stream
    ):
        if next_layer >= self.num_layers:
            return
        self.storage_backend.layerwise_batch_get(
            kvcaches, next_layer, gpu_files, block_ids, stream)

    # TODO(Jiayi): Currently, search_range is only used for testing.
    @_infinikv_nvtx_annotate
    def lookup(
        self,
        tokens: Union[torch.Tensor, List[int]],
        search_range: Optional[List[str]] = None,
        pin: bool = False,
    ) -> int:
        """
        Checks the existence of KV cache of the tokens from the cache engine.

        :param tokens: the input tokens, with shape [seq_len]

        :param Optional[List[str]] search_range: The range of storage backends
        to search in. Should be a subset of
        ["LocalCPUBackend", "LocalDiskBackend"] for now.
        If None, search in all backends.

        :param bool pin: If True, pin the KV cache in the storage.

        :return: An int indicating how many prefix tokens are cached.
        """
        end = 0
        old_end = 0

        for start, end, key in self.token_database.process_tokens(tokens):
            assert isinstance(key, CacheEngineKey)

            if self.storage_backend.contains(key, pin):
                old_end = end
                continue
            return old_end

        return end

    @_infinikv_nvtx_annotate
    def clear(
        self,
        tokens: Optional[Union[torch.Tensor, List[int]]] = None,
        locations: Optional[List[str]] = None,
    ) -> int:
        assert isinstance(self.storage_backend, GeminiFSBackend), \
            "InfiniKVEngine only supports GeminiFSBackend for now."
        # Clear all caches if tokens is None
        if tokens is None or len(tokens) == 0:
            num_cleared = self.storage_backend.clear(locations)
            return num_cleared

        num_removed = 0
        # Only remove the caches for the given tokens
        for start, end, key in self.token_database.process_tokens(tokens):
            assert isinstance(key, CacheEngineKey)
            removed = self.storage_backend.remove(key, locations)
            num_removed += removed
        return num_removed

    def close(self) -> None:
        """Close the cache engine and free all the resources"""

        if self.enable_p2p:
            self.distributed_server.close()

        if self.infinikv_worker is not None:
            self.infinikv_worker.close()

        self.storage_backend.close()
        logger.info("InfiniKVEngine closed.")

    # ==============================
    # Mamba / GDN recurrent state API
    # ==============================

    @_infinikv_nvtx_annotate
    def register_mamba_caches_batch(
        self,
        mamba_caches: List[torch.Tensor],
    ) -> None:
        """Register mamba/GDN state tensors with GeminiFS so they can
        be stored/retrieved alongside KV caches.

        Args:
            mamba_caches: List of mamba state tensors (one per linear_attention
                layer).  Each tensor is the paged mamba state buffer.
        """
        self.storage_backend.register_mamba_caches_batch(mamba_caches)

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def store_mamba_state(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Store mamba/GDN recurrent state to GeminiFS.

        The state is stored as a single fixed-size blob per block, not
        layer-wise like KV cache.

        Args:
            mamba_caches: list of per-layer mamba state tensors.
            gpu_files: allocated GPU file handles.
            block_ids: block IDs mapping state to GPU page locations.
            stream: CUDA stream for async copy.
        """
        self.storage_backend.mamba_batched_put(
            mamba_caches, gpu_files, block_ids, stream
        )

    @_infinikv_nvtx_annotate
    @torch.inference_mode()
    def retrieve_mamba_state(
        self,
        mamba_caches: List[torch.Tensor],
        gpu_files: List[GPUFileMetadata],
        block_ids: List[int],
        stream: torch.cuda.Stream,
    ) -> None:
        """Retrieve mamba/GDN recurrent state from GeminiFS.

        Args:
            mamba_caches: list of per-layer mamba state tensors.
            gpu_files: GPU file handles pointing to stored state.
            block_ids: block IDs mapping to GPU page locations.
            stream: CUDA stream for async copy.
        """
        self.storage_backend.mamba_batched_get(
            mamba_caches, gpu_files, block_ids, stream
        )


class InfiniKVEngineBuilder:
    _instances: Dict[str, InfiniKVEngine] = {}
    _cfgs: Dict[str, InfiniKVEngineConfig] = {}
    _metadatas: Dict[str, InfiniKVEngineMetadata] = {}
    _stat_loggers: Dict[str, InfiniKVStatsLogger] = {}

    @staticmethod
    def _Create_token_database(
        config: InfiniKVEngineConfig,
        metadata: InfiniKVEngineMetadata,
    ) -> TokenDatabase:
        return ChunkedTokenDatabase(config, metadata)

    @classmethod
    def get_or_create(
        cls,
        instance_id: str,
        config: InfiniKVEngineConfig,
        metadata: InfiniKVEngineMetadata,
    ) -> InfiniKVEngine:
        """
        Builds a new InfiniKVEngine instance if it doesn't already exist for the
        given ID.

        raises: ValueError if the instance already exists with a different
            configuration.
        """
        logger.info(f"Creating InfiniKVEngine instance {instance_id}")
        if instance_id not in cls._instances:
            token_database = cls._Create_token_database(config, metadata)
            stat_logger = InfiniKVStatsLogger(metadata, log_interval=10)

            engine = InfiniKVEngine(
                config,
                metadata,
                token_database,
            )

            cls._instances[instance_id] = engine
            cls._cfgs[instance_id] = config
            cls._metadatas[instance_id] = metadata
            cls._stat_loggers[instance_id] = stat_logger
            return engine
        else:
            if (
                cls._cfgs[instance_id] != config
                or cls._metadatas[instance_id] != metadata
            ):
                raise ValueError(
                    f"Instance {instance_id} already exists with a different "
                    f"configuration or metadata."
                )
            return cls._instances[instance_id]

    @classmethod
    def get(cls, instance_id: str) -> Optional[InfiniKVEngine]:
        """Returns the InfiniKVEngine instance associated with the instance ID,
        or None if not found."""
        return cls._instances.get(instance_id)

    @classmethod
    def destroy(cls, instance_id: str) -> None:
        """Close and delete the InfiniKVEngine instance by the instance ID"""
        # TODO: unit test for this
        if instance_id in cls._instances:
            stat_logger = cls._stat_loggers[instance_id]
            stat_logger.shutdown()
            engine = cls._instances[instance_id]
            engine.close()
            cls._instances.pop(instance_id, None)
            cls._cfgs.pop(instance_id, None)
            cls._metadatas.pop(instance_id, None)
            cls._stat_loggers.pop(instance_id, None)
            InfiniKVStatsMonitor.DestroyInstance()
