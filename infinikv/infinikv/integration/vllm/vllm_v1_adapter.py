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
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional, List, Set

from torch.profiler import schedule
# Third Party
from vllm.config import VllmConfig
from vllm.distributed.kv_transfer.kv_connector.v1.base import (
    KVConnectorBase_V1,
    KVConnectorMetadata,
    KVConnectorRole,
)
from vllm.utils.math_utils import cdiv
from vllm.v1.core.sched.output import SchedulerOutput
import torch

# First Party
from infinikv.integration.vllm.utils import apply_mm_hashes_to_token_ids, infinikv_get_config
from infinikv.logging import init_logger
from infinikv.utils import _infinikv_nvtx_annotate, GPUFileMetadata
from infinikv.v1.lookup_client import LookupClientFactory
from infinikv.v1.simulator import (
    SmallStreamController, StreamController, Simulator,
    model_info, model_system_info
)

if TYPE_CHECKING:
    # Third Party
    from vllm.forward_context import ForwardContext
    from vllm.multimodal.inputs import PlaceholderRange
    from vllm.v1.core.sched.output import NewRequestData
    from vllm.v1.request import Request


from typing import TYPE_CHECKING, Optional
# Third Party
import torch

# Third Party
from vllm.v1.attention.backend import AttentionMetadata

# Third Party
from vllm.utils.torch_utils import get_kv_cache_torch_dtype

from infinikv.config import InfiniKVEngineMetadata
from infinikv.integration.vllm.utils import ENGINE_NAME, infinikv_get_config, extract_mm_features
from infinikv.logging import init_logger
from infinikv.config import InfiniKVEngineConfig
from infinikv.v1.infinikv_engine import InfiniKVEngine, InfiniKVEngineBuilder

logger = init_logger(__name__)

from vllm.config import (
    CacheConfig,
    ModelConfig,
    ParallelConfig,
    SchedulerConfig,
)

VLLM_CACHE_CONFIG: Optional[CacheConfig] = None
VLLM_MODEL_CONFIG: Optional[ModelConfig] = None
VLLM_PARALLEL_CONFIG: Optional[ParallelConfig] = None
VLLM_SCHEDULER_CONFIG: Optional[SchedulerConfig] = None

def init_infinikv_engine(
    model_config: ModelConfig,
    parallel_config: ParallelConfig,
    cache_config: CacheConfig,
    scheduler_config: SchedulerConfig,
) -> Optional[InfiniKVEngine]:
    """Initialize the InfiniKV engine by the given model config and parallel
    config. This function will check the environment variable
    `INFINIKV_CONFIG_FILE` to load the configuration file. If that environment
    variable is not set, this function will return None.

    :param model_config: The model configuration in vLLM.
    :type model_config: ModelConfig
    :param parallel_config: The parallel configuration in vLLM.
    :type parallel_config: ParallelConfig
    :param cache_config: The KV cache configuration in vLLM.
    :type cache_config: CacheConfig
    :param scheduler_config: The scheduler configuration in vLLM.
    :type scheduler_config: SchedulerConfig

    :return: The initialized InfiniKV engine or None (if the environment variable
        `INFINIKV_CONFIG_FILE` is not set).
    :rtype: Optional[InfiniKVEngine]
    """
    if InfiniKVEngineBuilder.get(ENGINE_NAME) is not None:
        return None

    global VLLM_CACHE_CONFIG
    global VLLM_PARALLEL_CONFIG
    global VLLM_MODEL_CONFIG
    global VLLM_SCHEDULER_CONFIG
    VLLM_CACHE_CONFIG = cache_config
    VLLM_PARALLEL_CONFIG = parallel_config
    VLLM_MODEL_CONFIG = model_config
    VLLM_SCHEDULER_CONFIG = scheduler_config

    config = infinikv_get_config()
    assert isinstance(config, InfiniKVEngineConfig), (
        "InfiniKV v1 configuration is should be passed."
    )

    kv_dtype = get_kv_cache_torch_dtype(cache_config.cache_dtype, model_config.dtype)

    use_mla = False
    if (
        hasattr(model_config, "use_mla")
        and isinstance(model_config.use_mla, bool)
        and model_config.use_mla
    ):
        use_mla = True

    if use_mla and (config.remote_serde != "naive" and config.remote_serde is not None):
        raise ValueError("MLA only works with naive serde mode..")

    # construct kv shape (for mem pool)
    num_layer = model_config.get_num_layers(parallel_config)
    chunk_size = config.chunk_size
    # 确保 infinikv 的 chunk size 与 vLLM 的 block size 一致
    if chunk_size != cache_config.block_size:
        logger.info("InfiniKV chunk size is not equal to vLLM's block size!")
        chunk_size = cache_config.block_size

    num_kv_head = model_config.get_num_kv_heads(parallel_config)
    head_size = model_config.get_head_size()
    kv_shape = (num_layer, 1 if use_mla else 2, chunk_size, num_kv_head, head_size)
    logger.info(f"use mla: {use_mla}, kv shape: {kv_shape}")

    # Change current device.
    torch.cuda.device(parallel_config.rank)
    device = torch.device(f"cuda:{parallel_config.rank}")
    # torch.cuda.set_device(device)
    metadata = InfiniKVEngineMetadata(
        model_config.model,
        parallel_config.world_size,
        parallel_config.rank,
        "vllm",
        kv_dtype,
        kv_shape,
        use_mla,
    )

    engine = InfiniKVEngineBuilder.get_or_create(
        ENGINE_NAME, config, metadata
    )

    return engine
# 实现兼容版本, 该版本用于兼容infinikv和geminifs
@dataclass
class LoadSpec:
    # Number of tokens cached in vLLM
    vllm_cached_tokens: int
    # Number of tokens that are cached in InfiniKV or gStore
    external_cached_tokens: int
    # Whether the scheduler allow us to load the tokens
    can_load: bool
    # GPU files to load from
    gpu_files: Optional[list[GPUFileMetadata]] = None

    block_ids_to_load: Optional[List[int]] = None


@dataclass
class SaveSpec:
    req_id: str
    # Skip already saved tokens
    skip_leading_tokens: int
    # Whether the scheduler allow us to save the tokens
    can_save: bool
    # GPU files to save to
    gpu_files: Optional[list[GPUFileMetadata]] = None

    block_ids_to_save: Optional[List[int]] = None


@dataclass
class IOSpec:
    gpu_file: GPUFileMetadata
    block_id: int
    layer: int
    request_id: str = ""


@dataclass
class StoreLayerTask:
    gpu_files: List[GPUFileMetadata]
    block_ids: List[int]
    layer_ids: List[int]
    completion_event: torch.Event

# 任务队列


class TaskQueueforSave():
    def __init__(self, num_layers: int):
        self._tasks: deque[IOSpec] = deque()
        self._pending_block_ids: Set[int] = set()
        self.num_layers = num_layers

    def get_exist_io_num(self):
        return len(self._tasks)

    def submit_tasks(self, tasks: List[IOSpec]):
        success_submit = 0
        for task in tasks:
            # 判断是否存在历史block id
            if task.block_id not in self._pending_block_ids:
                self._pending_block_ids.add(task.block_id)
                self._tasks.append(task)
                success_submit += 1
        logger.info(f"sucess submit {success_submit} tasks")

    # 这里的调用是为当前计算所需写盘的io准备的
    def get_next_ntasks(self, n=1) -> List[IOSpec]:
        tasks_to_execute: List[IOSpec] = []
        num_to_pop = min(n, len(self._tasks))
        if num_to_pop == 0:
            return []
        for i in range(num_to_pop):
            tasks_to_execute.append(self._tasks.popleft())
            self._pending_block_ids.remove(tasks_to_execute[-1].block_id)
        return tasks_to_execute

    # 当请求内存被释放，对应的save task也应该一同回收
    def withdraw_tasks(self, request_id: str) -> int:
        tasks_to_keep = deque()
        withdraw_block_ids = set()
        for task in self._tasks:
            if task.request_id == request_id:
                withdraw_block_ids.add(task.block_id)
            else:
                tasks_to_keep.append(task)
        withdraw_count = len(self._tasks) - len(tasks_to_keep)
        if withdraw_count > 0:
            self._tasks = tasks_to_keep
            self._pending_block_ids.difference_update(withdraw_block_ids)
        return withdraw_count


@dataclass
class RequestTracker:
    # Request id
    req_id: str

    # The token ids that has been scheduled so far
    token_ids: list[int]

    # The block ids that has been allocated so far
    # NOTE: allocated blocks could be more than the number of tokens
    # FIXME: need to check whether the block ids will be changed after
    #        preemption
    allocated_block_ids: list[int]

    # The number of tokens that has been saved
    num_saved_tokens: int = 0

    # Multimodal hashes and positions
    mm_hashes: Optional[list[str]] = None
    mm_positions: Optional[list["PlaceholderRange"]] = None

    @staticmethod
    def from_new_request(
        new_request: "NewRequestData",
        num_tokens_to_compute: int,
        external_cached_tokens: int,
    ) -> "RequestTracker":
        """Create the request tracker from a new request.

        Args:
            new_request (NewRequestData): the new request data.
            num_tokens_to_compute (int): the number of tokens that will
                be 'computed', including the `num_computed_tokens` (vLLM's
                local cache hit) and new tokens that will be scheduled.

        """
        # vLLM 0.9.0 update: request.block_ids changed from list[int] to
        # list[list[int]]
        # Need to check the type of request.block_ids

        unfolded_block_ids = []

        if not isinstance(new_request.block_ids[0], list):
            unfolded_block_ids = new_request.block_ids.copy()
        else:
            # According to the vLLM code
            # (https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/
            # sched/scheduler.py#L943),
            # only one KVCacheGroup is supported in connector for now.

            # TODO: Please support multiple KVCacheGroup in connector.
            # NOTE: Also, `update` method in RequestTracker should be
            # updated accordingly.
            unfolded_block_ids = new_request.block_ids[0].copy()
        
        mm_hashes, mm_positions = extract_mm_features(new_request)

        return RequestTracker(
            req_id=new_request.req_id,
            token_ids=new_request.prompt_token_ids[:num_tokens_to_compute].copy(
            ),
            allocated_block_ids=unfolded_block_ids,
            num_saved_tokens=external_cached_tokens,
            mm_hashes=[f.mm_hash for f in new_request.mm_features
                       if f.mm_hash is not None],
            mm_positions=[f.mm_position for f in new_request.mm_features
                          if f.mm_hash is not None],
        )

    def update(
        self,
        new_token_ids: list[int],
        new_block_ids: tuple[list[int], ...],
    ) -> None:
        """Update the request tracker when a running request is
        scheduled again
        """

        self.token_ids.extend(new_token_ids)
        # logger.info(f"new_block_ids: {new_block_ids}, new_token_ids: {new_token_ids}")

        if new_block_ids is None or len(new_block_ids) == 0:
            new_block_ids = []
        else:
            assert isinstance(new_block_ids[0], list), (
                "The new_block_ids should be a tuple of lists, "
                "the vllm version might be too old!"
            )
            new_block_ids = new_block_ids[0]
        self.allocated_block_ids.extend(new_block_ids)

# 兼容实现


@dataclass
class ReqMeta:
    # Request id
    req_id: str
    # Request tokens
    token_ids: torch.Tensor
    # Slot mapping of current request, 由 request 里的 block_ids 计算出
    slot_mapping: torch.Tensor

    block_ids: torch.Tensor

    # Skip save or not
    save_spec: Optional[SaveSpec] = None
    # load_spec
    load_spec: Optional[LoadSpec] = None

    @staticmethod
    def from_request_tracker(
        tracker: RequestTracker,
        block_size: int,
        external_chunk_size: int = 256,
        load_spec: Optional[LoadSpec] = None,
        skip_save: bool = False,
        discard_partial_chunks: bool = True,
    ) -> Optional["ReqMeta"]:
        """Create the request metadata from a request tracker.

        Args:
            tracker (RequestTracker): the request tracker.
            block_size (int): the block size in vLLM.
            external_chunk_size (int): the chunk size for InfiniKV or gStore.
            load_spec (Optional[LoadSpec]): the load spec for KV cache loading.
            skip_save (bool): whether to skip the save operation.
            discard_partial_chunks (bool): whether to discard partial chunks.

        Returns:
            the request metadata if we need to perform load/save
            operations, None otherwise.
        """
        input_token_ids = tracker.token_ids
        input_token_len = len(input_token_ids)

        # For save operation: do not save if the following condition is met
        # 1. has already been saved before (num_saved_tokens > 0)
        # 2. number of unsaved tokens is not reached the chunk boundary
        skip_leading_tokens = tracker.num_saved_tokens

        def cdiv(a: int, b: int) -> int:
            return -(a // -b)
        
        chunk_boundary = (
            cdiv(tracker.num_saved_tokens + 1,
                 external_chunk_size) * external_chunk_size
        )
        skip_save = skip_save or (input_token_len < chunk_boundary)
        
        # logger.info(f"skip_leading_tokens: {skip_leading_tokens}, skip_save: {skip_save}")

        if skip_save and load_spec is None:
            return None

        # Calculate number of tokens to save based on discard_partial_chunks
        # setting
        num_tokens_to_save = (
            (input_token_len // external_chunk_size * external_chunk_size)
            if discard_partial_chunks
            else input_token_len
        )

        # logger.info(f"input_token_len: {input_token_len}, num_tokens_to_save: {num_tokens_to_save}, discard_partial_chunks: {discard_partial_chunks}")

        # If we need to save, update the number of saved tokens
        if not skip_save:
            tracker.num_saved_tokens = num_tokens_to_save
        save_spec = SaveSpec(
            tracker.req_id, skip_leading_tokens, not skip_save)

        # Calculate the token ids and slot mappings for load and save
        # OPTIMIZATION: pre-allocate the buffer for token ids and block
        # ids
        token_ids = torch.tensor(input_token_ids)[:num_tokens_to_save]

        # If the request has multimodal hashes, apply them to the token ids
        if tracker.mm_hashes:
            apply_mm_hashes_to_token_ids(
                token_ids, tracker.mm_hashes, tracker.mm_positions
            )

        num_blocks = len(tracker.allocated_block_ids)

        block_ids = torch.tensor(tracker.allocated_block_ids, dtype=torch.long)

        if len(token_ids) > num_blocks * block_size:
            logger.error(
                "The number of tokens is more than the number of blocks."
                "Something might be wrong in scheduling logic!"
            )
            logger.error(
                "Num tokens: %d, num blocks: %d, block size: %d",
                len(token_ids),
                num_blocks,
                block_size,
            )

        block_offsets = torch.arange(0, block_size, dtype=torch.long)
        slot_mapping = (
            block_offsets.reshape((1, block_size))
            + block_ids.reshape((num_blocks, 1)) * block_size
        )

        slot_mapping = slot_mapping.flatten()[: len(token_ids)]
        assert slot_mapping.dtype == torch.long  # TODO: this could be removed

        # For load operation: check whether the request is scheduled to load
        if load_spec is not None and load_spec.can_load:
            logger.info(
                "Scheduled to load %d tokens for request %s",
                load_spec.external_cached_tokens,
                tracker.req_id,
            )
        else:
            # Do not load if not in `can_load` state
            load_spec = None

        # logger.info(f"token ids: {len(token_ids)}, save_spec: {save_spec}")
        return ReqMeta(
            req_id=tracker.req_id,
            token_ids=token_ids,
            slot_mapping=slot_mapping,
            block_ids=block_ids,
            save_spec=save_spec,
            load_spec=load_spec,
        )


@dataclass
class InfiniKVConnectorMetadata(KVConnectorMetadata):
    requests: list[ReqMeta]
    num_total_scheduled_tokens: int
    stage: str
    io_count: int
    save_stream: Optional[torch.cuda.Stream] = None
    io_tasks: Optional[List[IOSpec]] = None
    preempted_reqs: Optional[List[str]] = None

    def __init__(self):
        self.requests = []

    def add_request(self, req_meta: ReqMeta) -> None:
        """Add a request to the metadata.

        Args:
            req_meta (ReqMeta): the request metadata.
        """
        self.requests.append(req_meta)


class InfiniKVConnectorV1Impl():
    def __init__(self, vllm_config: "VllmConfig", role: KVConnectorRole,
                 parent: KVConnectorBase_V1, kv_cache_config=None):
        self._parent = parent
        self._kv_cache_config = kv_cache_config
        self.kv_role = vllm_config.kv_transfer_config.kv_role
        is_tp = vllm_config.parallel_config.tensor_parallel_size > 1
        self.rank = vllm_config.parallel_config.rank
        self.num_layers = vllm_config.model_config.get_num_layers(
            vllm_config.parallel_config
        )

        # For hybrid models, num_layers for INFINIKV only counts full_attention layers
        hf_config = getattr(vllm_config.model_config, "hf_text_config",
                            getattr(vllm_config.model_config, "hf_config", None))
        self._is_hybrid = False
        self._attn_layer_indices = None
        if hf_config is not None and hasattr(hf_config, "layer_types") and hf_config.layer_types is not None:
            layer_types = list(hf_config.layer_types)
            self._attn_layer_indices = [
                i for i, lt in enumerate(layer_types) if lt == "full_attention"
            ]
            if any(lt != "full_attention" for lt in layer_types):
                self._is_hybrid = True
                self.num_layers = len(self._attn_layer_indices)
                logger.info(
                    "Hybrid model detected: INFINIKV managing %d attention layers",
                    self.num_layers,
                )
        if role == KVConnectorRole.SCHEDULER:
            # 由于scheduler端不需要初始化infinikv引擎，所以在查询外部缓存命中时，需要
            # 通过lookup client 查询
            self.lookup_client = LookupClientFactory.create_lookup_client(
                role, is_tp, vllm_config
            )
            self._requests_in_step: dict[str, Request] = {}
        else:
            
            # 初始化infinikv引擎
            self.infinikv_engine = init_infinikv_engine(
                vllm_config.model_config,
                vllm_config.parallel_config,
                vllm_config.cache_config,
                vllm_config.scheduler_config,
            )

            assert self.infinikv_engine is not None
            self.lookup_server = LookupClientFactory.create_lookup_server(
                self.infinikv_engine, role, is_tp, vllm_config
            )
            
            self.simulator = self._initialize_simulator(vllm_config)
            # 初始化任务队列
            self.task_queue = TaskQueueforSave(self.num_layers)
            # 初始化Stream Pool
            self.stream_controller = StreamController(
                device=torch.device(f"cuda:{self.rank}"),
                min_sm_partition=8,
                sm_partition_step=8,
                sms_per_io_task=2
            )
            # self.small_stream_controller = SmallStreamController(
            #     devices=[torch.device("cuda", i)
            #              for i in range(torch.cuda.device_count())],
            #     min_sm_partition=8,
            #     sms_per_io_task=1,
            # )
            # self.load_stream = self.stream_controller.acquire_stream(
            #     device=torch.device(f"cuda:{self.rank}"))
            # self.save_stream = self.small_stream_controller.acquire_stream(
            #     device=torch.device(f"cuda:{self.rank}"))
            self.load_stream = self.stream_controller.get_matched_stream_by_sm(
                device=torch.device(f"cuda:{self.rank}"),
                sm_count=16
            )
            # self.load_stream = torch.cuda.current_stream()
            self.save_stream = self.stream_controller.get_matched_stream_by_sm(
                device=torch.device(f"cuda:{self.rank}"),
                sm_count=8
            )
            self.pending_store_layer_tasks: deque[StoreLayerTask] = deque()

        self.kv_caches: dict[str, torch.Tensor] = {}

        self.kvcaches: List[torch.Tensor] = []

        self._block_size = vllm_config.cache_config.block_size
        # vLLM 的块大小与底层一致
        self._infinikv_chunk_size = self._block_size

        # request_id -> (vllm cached tokes, external cached tokens)
        self.load_specs: dict[str, LoadSpec] = {}

        # request_id -> full_token_ids
        self._request_trackers: dict[str, RequestTracker] = {}

        # Whether to discard partial chunks
        self._discard_partial_chunks = (
            vllm_config.kv_transfer_config.get_from_extra_config(
                "discard_partial_chunks", True
            )
        )

        self.skip_last_n_tokens = vllm_config.kv_transfer_config.get_from_extra_config(
            "skip_last_n_tokens", 0
        )

        self.current_layer = 0

    def _initialize_simulator(self, vllm_config: "VllmConfig"):
        gpu_tflops = 30
        comm_io_bandwidth = 520 * 1024 * 1024 * 1024  # 520GB/s
        # 如果是多卡，nvlink 带宽为 600GB/s

        storage_io_bandwidth_Bps = 10 * 1024 * 1024 * 1024  # 10GB/s
        # 等待具体数值

        if vllm_config.quant_config is None:
            w_bit = 16
        elif vllm_config.quant_config.get_name() == "awq":
            w_bit = 4
        elif vllm_config.quant_config.get_name() == "bitsandbytes":
            w_bit = 4 if vllm_config.quant_config.load_in_4bit else 8
        elif vllm_config.quant_config.get_name() == "gguf":
            # TODO: GGUF 需要判断文件, 可能是 8
            w_bit = 4
        elif vllm_config.quant_config.get_name() == "torchao":
            w_bit = 8
        elif vllm_config.quant_config.get_name() == "tpu_int8":
            w_bit = 8
        elif vllm_config.quant_config.get_name() == "compressed-tensors":
            w_bit = 4
        elif vllm_config.quant_config.get_name() == "quark":
            w_bit = 4
        else:
            raise ValueError(
                f"Unsupported quantization method: {vllm_config.quant_config.get_name()}")

        model_dtype = vllm_config.model_config.dtype
        if model_dtype == torch.float16 or model_dtype == torch.bfloat16:
            a_bit = 16
        elif model_dtype == torch.float32:
            a_bit = 32
        else:
            # 默认情况
            a_bit = 16

        # 如果是FP8，激活值也是8位
        if vllm_config.quant_config is not None and vllm_config.quant_config.get_name() == "fp8":
            a_bit = 8
        if vllm_config.cache_config is not None:
            kv_cache_dtype_str = vllm_config.cache_config.cache_dtype
        else:
            kv_cache_dtype_str = "float16"
        kv_cache_dtype_str = vllm_config.cache_config.cache_dtype
        if "int8" in kv_cache_dtype_str or "fp8" in kv_cache_dtype_str:
            kv_bit = 8
        elif "auto" in kv_cache_dtype_str:
            # For "auto", the KV cache bit width matches the model's data type.
            # We get the size in bytes from the torch dtype and convert to bits.
            model_dtype = vllm_config.model_config.dtype
            kv_bit = model_dtype.itemsize * 8
        else:
            # All other supported types like 'half', 'bfloat16' are 16-bit.
            kv_bit = 16

        return Simulator(
            model_system_info=model_system_info(
                comm_io_bandwidth=comm_io_bandwidth,
                storage_io_bandwidth_Bps=storage_io_bandwidth_Bps,
                block_size=vllm_config.cache_config.block_size,  # 一个 token 预期占用多少 byte
                tp_size=vllm_config.parallel_config.tensor_parallel_size,
                dp_size=vllm_config.parallel_config.data_parallel_size,
                w_bit=w_bit,
                a_bit=a_bit,
                kv_bit=kv_bit,
            ),
            model_info=model_info(
                num_layers=vllm_config.model_config.get_num_layers(
                    vllm_config.parallel_config),
                num_heads=vllm_config.model_config.get_num_attention_heads(
                    vllm_config.parallel_config),
                hidden_size=vllm_config.model_config.get_hidden_size(),
                num_kv_heads=vllm_config.model_config.get_num_kv_heads(
                    vllm_config.parallel_config),  # num heads per GPU
                head_size=vllm_config.model_config.get_head_size(),
                gpu_tflops=gpu_tflops,
            ),
            streamController=StreamController(
                device=torch.device(f"cuda:{self.rank}"),
                min_sm_partition=8,
                sm_partition_step=8,
                sms_per_io_task=2
            ),
        )

    def _init_kv_caches_from_forward_context(self, forward_context: "ForwardContext"):
        for layer_name in forward_context.no_compile_layers:
            attn_layer = forward_context.no_compile_layers[layer_name]

            # Skip non-attention layers (e.g. MambaBase / GDN layers in hybrid models)
            try:
                from vllm.model_executor.layers.mamba.abstract import MambaBase
                if isinstance(attn_layer, MambaBase):
                    logger.debug(
                        "Skipping MambaBase layer %s for KV cache registration",
                        layer_name)
                    continue
            except ImportError:
                pass

            if not hasattr(attn_layer, "kv_cache"):
                logger.debug(
                    "The layer %s does not have kv_cache, skip it", layer_name)
                continue

            if layer_name not in self.kv_caches:
                # 从attention layer中获取绑定的kv cache
                self.kv_caches[layer_name] = attn_layer.kv_cache[
                    forward_context.virtual_engine
                ]
        self.kvcaches = list(self.kv_caches.values())

        # Also collect mamba/GDN state caches for hybrid models
        if self._is_hybrid:
            self._init_mamba_caches_from_forward_context(forward_context)

    def _init_mamba_caches_from_forward_context(self, forward_context: "ForwardContext"):
        """Collect mamba state tensors from GDN layers in hybrid models."""
        try:
            from vllm.model_executor.layers.mamba.abstract import MambaBase
        except ImportError:
            return

        if not hasattr(self, '_mamba_caches'):
            self._mamba_caches = []

        if len(self._mamba_caches) > 0:
            return  # already initialized

        for layer_name in forward_context.no_compile_layers:
            layer = forward_context.no_compile_layers[layer_name]
            if isinstance(layer, MambaBase):
                # MambaBase layers have state tensors managed by vLLM
                self._mamba_caches.append(layer_name)

        if len(self._mamba_caches) > 0:
            logger.info(
                "Collected %d mamba/GDN layers for state offload",
                len(self._mamba_caches),
            )

    def save_mamba_state(self, layer_name: str) -> None:
        """Save mamba/GDN recurrent state for a given layer.

        This is called by the maybe_transfer_mamba_state decorator after
        the GDN layer's forward pass completes.
        """
        if not self._is_hybrid or self.infinikv_engine is None:
            return
        # Mamba state saving is handled in bulk during _prepare_for_save
        # alongside KV cache. Individual layer calls are no-ops for now.
        pass

    def load_mamba_state(self, layer_name: str) -> None:
        """Load mamba/GDN recurrent state for a given layer.

        This is called by the maybe_transfer_mamba_state decorator before
        the GDN layer's forward pass begins.
        """
        if not self._is_hybrid or self.infinikv_engine is None:
            return
        # Mamba state loading is handled in bulk during start_load_kv
        # alongside KV cache. Individual layer calls are no-ops for now.
        pass

    ####################
    # Worker side APIs
    ####################
    @_infinikv_nvtx_annotate
    def register_kv_caches(self, kv_caches: dict[str, torch.Tensor]):
        self.infinikv_engine.register_kv_caches(kv_caches)

    @_infinikv_nvtx_annotate
    def register_cross_layers_kv_cache(self, kv_cache: torch.Tensor):
        """Register a single cross-layer KV cache tensor with GeminiFS.

        This avoids registering many individual per-layer tensors, which
        can trigger 'tensor without storage' errors from GeminiFS DMA
        registration side-effects on the CUDA memory pool.
        """
        self.infinikv_engine.register_cross_layers_kv_cache(kv_cache)

    @_infinikv_nvtx_annotate
    def start_load_kv(
        self,
        forward_context: "ForwardContext",
        **kwargs
    ) -> None:
        """
        Args:
            forward_context (ForwardContext): the forward context.
            **kwargs: additional arguments for the load operation
        Note:
            The number of elements in kv_caches and layer_names should be the same.
        """
        if len(self.kv_caches) == 0:
            self._init_kv_caches_from_forward_context(forward_context)

        # used for layerwise prefetch
        self.current_layer = 0

        # 在模型推理之前就把 load 和 store 的元信息准备好
        self._prepare_for_load()
        self._prepare_for_save()

    @_infinikv_nvtx_annotate
    def _prepare_for_load(self) -> None:
        metadata = self._parent._get_connector_metadata()
        assert isinstance(metadata, InfiniKVConnectorMetadata)

        assert len(self.kvcaches) > 0
        assert self.infinikv_engine is not None

        all_req_file_ids = []
        all_req_block_ids = []

        for idx, request in enumerate(metadata.requests):
            if request.load_spec is None:
                continue

            tokens = request.token_ids
            block_ids = request.block_ids
            
            # import math
            # assert math.ceil(len(tokens) / self._infinikv_chunk_size) == len(block_ids)

            # import math
            # assert math.ceil(
            #     len(tokens) / self._infinikv_chunk_size) == len(block_ids), f"tokens mismatched, len tokens: {len(tokens)}, len block_ids: {len(block_ids)}"

            token_mask = torch.ones_like(tokens, dtype=torch.bool)
            masked_token_count = (
                request.load_spec.vllm_cached_tokens
                // self._infinikv_chunk_size
                * self._infinikv_chunk_size
            )
            token_mask[:masked_token_count] = False

            external_cached_tokens = request.load_spec.external_cached_tokens

            # 进行前缀匹配,为后续读操作准备 load_spec
            ret_token_mask, file_ids, block_ids_to_load = self.infinikv_engine.prepare_for_load(
                tokens[:external_cached_tokens],
                token_mask[:external_cached_tokens],
                block_ids
            )

            request.load_spec.gpu_files = file_ids
            request.load_spec.block_ids_to_load = block_ids_to_load

            all_req_file_ids.extend(file_ids)
            all_req_block_ids.extend(block_ids_to_load)

            num_retrieved_tokens = ret_token_mask.sum().item()
            num_expected_tokens = external_cached_tokens - \
                request.load_spec.vllm_cached_tokens
            if num_retrieved_tokens < num_expected_tokens:
                logger.warning(
                    "The number of retrieved tokens is less than the number of expected tokens. "
                    "Request id: %s, num_retrieved_tokens: %d, num_expected_tokens: %d",
                    request.req_id, num_retrieved_tokens, num_expected_tokens
                )

        if len(all_req_file_ids) == 0:
            return
        # 取第一层 kv_cache
        self.infinikv_engine.retrieve_layer(
            kvcaches=self.kvcaches,
            next_layer=-1,  # 底层会自动加 1
            gpu_files=all_req_file_ids,
            block_ids=all_req_block_ids,
            # stream=self.load_stream
            stream=torch.cuda.current_stream()
        )
        # TODO: 这里先全部加载，后续改为更高效的计算 IO 重叠加载
        # self.infinikv_engine.retrive(
        #     kvcaches=self.kvcaches,
        #     gpu_files=file_ids,
        #     block_ids=block_ids_to_load,
        # )

    @_infinikv_nvtx_annotate
    def _prepare_for_save(self) -> None:
        connector_metadata = self._parent._get_connector_metadata()
        assert isinstance(connector_metadata, InfiniKVConnectorMetadata)

        assert self.infinikv_engine is not None

        io_tasks = []
        # 判断所有请求是否有新的落盘任务加入 io 队列
        for idx, request in enumerate(connector_metadata.requests):
            save_spec = request.save_spec
            if save_spec is None or not save_spec.can_save:
                continue

            token_ids = request.token_ids
            block_ids = request.block_ids

            # import math
            # assert math.ceil(len(token_ids) / self._infinikv_chunk_size) == len(block_ids)
            # assert math.ceil(len(token_ids) /
            #                  self._infinikv_chunk_size) == len(block_ids), f"tokens mismatched, len tokens: {len(token_ids)}, len block_ids: {len(block_ids)}"

            skip_leading_tokens = save_spec.skip_leading_tokens

            if skip_leading_tokens == len(token_ids):
                continue  # skip this request
            # Align to infinikv chunk size
            skip_leading_tokens = (
                skip_leading_tokens
                // self._infinikv_chunk_size
                * self._infinikv_chunk_size
            )

            store_mask = torch.ones_like(token_ids, dtype=torch.bool)
            store_mask[:skip_leading_tokens] = False

            logger.info(
                "Preparing for storing KV cache for %d out of %d tokens "
                "(skip_leading_tokens=%d) for request %s",
                len(token_ids) - skip_leading_tokens,
                len(token_ids),
                skip_leading_tokens,
                request.req_id,
            )
            gpu_files, block_ids_to_save = self.infinikv_engine.prepare_for_store(
                token_ids,
                mask=store_mask,
                block_ids=block_ids,
                offset=skip_leading_tokens,
            )

            if len(gpu_files) == 0:
                request.save_spec.can_save = False
                continue

            request.save_spec.gpu_files = gpu_files
            request.save_spec.block_ids_to_save = block_ids_to_save

            # contruct IOSpec
            for gpu_file, block_id in zip(gpu_files, block_ids_to_save):
                io_tasks.append(IOSpec(gpu_file, block_id, 0))


        connector_metadata.io_count = 0
        connector_metadata.io_tasks = None

        if len(io_tasks) > 0:
            self.task_queue.submit_tasks(io_tasks)
        io_count, stream = self.simulator.execute(
                                    connector_metadata.num_total_scheduled_tokens, 
                                    device=torch.device(f"cuda:{self.rank}"),
                                    exist_io_num=self.task_queue.get_exist_io_num(), 
                                    stage=connector_metadata.stage)
        if stream is None:
            connector_metadata.save_stream = None
            return
        
        # assert io_count <= self.task_queue.get_exist_io_num()
        io_count = self.task_queue.get_exist_io_num()

        connector_metadata.io_count = io_count
        connector_metadata.io_tasks = self.task_queue.get_next_ntasks(io_count)

    def _launch_pending_store_layer_tasks(self, budget: Optional[int] = None):
        while len(self.pending_store_layer_tasks) > 0 and (budget is None or budget > 0):
            budget -= 1
            store_layer_task = self.pending_store_layer_tasks.popleft()
            self.infinikv_engine.store_layer_for_async(
                kvcaches=self.kvcaches,
                gpu_files=store_layer_task.gpu_files,
                block_ids=store_layer_task.block_ids,
                layer_ids=store_layer_task.layer_ids,
                stream=self.save_stream,
                load_stream=self.load_stream,
                completion_event=store_layer_task.completion_event
            )

    @_infinikv_nvtx_annotate
    def check_for_layer_need_load(self, layer_name: str) -> bool:
        metadata = self._parent._get_connector_metadata()
        assert isinstance(metadata, InfiniKVConnectorMetadata)

        assert len(self.kvcaches) > 0

        all_req_file_ids = []
        all_req_block_ids = []

        for idx, request in enumerate(metadata.requests):
            load_spec = request.load_spec
            if load_spec is None:
                continue
            all_req_file_ids.extend(load_spec.gpu_files)
            all_req_block_ids.extend(load_spec.block_ids_to_load)

        if len(all_req_file_ids) == 0:
            return False

        return True

    @_infinikv_nvtx_annotate
    def wait_for_layer_load(self, layer_name: str) -> None:
        # return
        metadata = self._parent._get_connector_metadata()
        assert isinstance(metadata, InfiniKVConnectorMetadata)

        assert len(self.kvcaches) > 0

        all_req_file_ids = []
        all_req_block_ids = []

        for idx, request in enumerate(metadata.requests):
            load_spec = request.load_spec
            if load_spec is None:
                continue
            all_req_file_ids.extend(load_spec.gpu_files)
            all_req_block_ids.extend(load_spec.block_ids_to_load)

        if len(all_req_file_ids) == 0:
            return

        self.infinikv_engine.retrieve_layer(
            self.kvcaches,
            self.current_layer,
            all_req_file_ids,
            all_req_block_ids,
            # stream=self.load_stream
            stream=torch.cuda.current_stream()
        )

    @_infinikv_nvtx_annotate
    def save_kv_layer(
        self,
        layer_name: str,
        kv_layer: torch.Tensor,
        attn_metadata: "AttentionMetadata",
        **kwargs,
    ) -> None:
        """ 
        Args:
            layer_name (str): the name of the layer.
            kv_layer (torch.Tensor): the paged KV buffer of the current
                layer in vLLM.
            attn_metadata (AttentionMetadata): the attention metadata.
            **kwargs: additional arguments for the save operation.
        """

        connector_metadata = self._parent._get_connector_metadata()
        assert isinstance(connector_metadata, InfiniKVConnectorMetadata)
        assert len(self.kvcaches) > 0

        # 用于按层读取
        self.current_layer += 1

        if connector_metadata.io_count == 0 or connector_metadata.io_tasks is None or connector_metadata.save_stream is None:
            return

        gpu_files = []
        block_ids = []
        layer_ids = []

        for io_task in connector_metadata.io_tasks:
            if io_task.layer >= self.num_layers:
                continue
            gpu_files.append(io_task.gpu_file)
            block_ids.append(io_task.block_id)
            layer_ids.append(io_task.layer)
            io_task.layer += 1
        self.infinikv_engine.store_layer(
            kvcaches=self.kvcaches,
            gpu_files=gpu_files,
            block_ids=block_ids,
            layer_ids=layer_ids,
            # stream=self.save_stream
            stream=torch.cuda.current_stream()
        )

    @_infinikv_nvtx_annotate
    def save_kv_layer_async(self,
                            layer_name: str,
                            kv_layer: torch.Tensor,
                            completion_event: torch.Event,
                            attn_metadata: "AttentionMetadata",
                            **kwargs) -> None:
        """
        Args:
            layer_name (str): the name of the layer.
            kv_layer (torch.Tensor): the paged KV buffer of the current
                layer in vLLM.
            attn_metadata (AttentionMetadata): the attention metadata.
            **kwargs: additional arguments for the save operation.
        """
        connector_metadata = self._parent._get_connector_metadata()
        assert isinstance(connector_metadata, InfiniKVConnectorMetadata)
        assert len(self.kvcaches) > 0

        # 用于按层读取
        self.current_layer += 1

        if connector_metadata.io_count == 0 or connector_metadata.io_tasks is None:
            return

        gpu_files = []
        block_ids = []
        layer_ids = []

        for io_task in connector_metadata.io_tasks:
            if io_task.layer >= self.num_layers:
                continue
            gpu_files.append(io_task.gpu_file)
            block_ids.append(io_task.block_id)
            layer_ids.append(io_task.layer)
            io_task.layer += 1
        self.pending_store_layer_tasks.append(StoreLayerTask(
            gpu_files=gpu_files,
            block_ids=block_ids,
            layer_ids=layer_ids,
            completion_event=completion_event,
        ))

    @_infinikv_nvtx_annotate
    def wait_for_save(self):
        # do nothing
        return

    def get_finished(
        self, finished_req_ids: set[str]
    ) -> tuple[Optional[set[str]], Optional[set[str]]]:
        return None, None
    ###################
    # Scheduler side APIs
    ####################

    @_infinikv_nvtx_annotate
    def get_num_new_matched_tokens(
        self,
        request: "Request",
        num_computed_tokens: int,
    ) -> int:
        """
        Check for external KV cache hit.

        Args:
            request (Request): the request object.
            num_computed_tokens (int): the number of locally
                computed tokens for this request

        Returns:
            the number of tokens that can be loaded from the
            external KV cache beyond what is already computed.
        """
        if self.kv_role == "kv_producer" and not hasattr(
            self.lookup_client, "supports_producer_reuse"
        ):
            return 0

        token_ids = torch.tensor(request.prompt_token_ids)

        # If the request has multimodal features, apply their hashes
        if request.mm_features:
            mm_hashes = [f.mm_hash for f in request.mm_features
                         if f.mm_hash is not None]
            mm_positions = [f.mm_position for f in request.mm_features
                           if f.mm_hash is not None]
            if mm_hashes:
                apply_mm_hashes_to_token_ids(
                    token_ids, mm_hashes, mm_positions
                )

        if self.skip_last_n_tokens > 0:
            num_external_hit_tokens = self.lookup_client.lookup(
                token_ids[: -self.skip_last_n_tokens]
            )
        else:
            num_external_hit_tokens = self.lookup_client.lookup(token_ids)

        # When prompt length is divisible by the block size and all
        # blocks are cached, we need to recompute the last token.
        # This will be removed in the future if vLLM's scheduler provides
        # a better support for this case.
        need_to_allocate = num_external_hit_tokens - num_computed_tokens

        # In, full-prompt-hit case, we need to recompute the last token
        if num_external_hit_tokens == request.num_tokens:
            need_to_allocate -= 1

        logger.info(
            "Reqid: %s, Total tokens %d, InfiniKV hit tokens: %d, need to load: %d",
            request.request_id,
            request.num_tokens,
            num_external_hit_tokens,
            need_to_allocate,
        )
        if need_to_allocate <= 0:
            return 0

        self.load_specs[request.request_id] = LoadSpec(
            vllm_cached_tokens=num_computed_tokens,
            external_cached_tokens=num_external_hit_tokens,
            can_load=False,
        )

        # TODO: Align to vLLM block size. Should test whether it can be removed
        # need_to_allocate = need_to_allocate // self._block_size * \
        #        self._block_size

        return need_to_allocate

    @_infinikv_nvtx_annotate
    def update_state_after_alloc(self, request: "Request", num_external_tokens: int):
        """
        Update KVConnector state after temporary buffer alloc.

        For SharedStorageConnector, update _request_needs_load
        if the CacheManager this allocated blocks for us.
        """

        self._requests_in_step[request.request_id] = request

        if request.request_id not in self.load_specs:
            # No KV tokens from external KV cache, return
            return

        if num_external_tokens == 0:
            # No need to load anything
            self.load_specs[request.request_id].can_load = False
            return

        # Only check for non-prompt-hit case
        if (
            self.load_specs[request.request_id].external_cached_tokens
            != request.num_tokens
        ):
            assert (
                num_external_tokens > 0
                and num_external_tokens
                == self.load_specs[request.request_id].external_cached_tokens
                - self.load_specs[request.request_id].vllm_cached_tokens
            ), (
                f"Mismatch in number of tokens: {num_external_tokens} vs "
                f"{self.load_specs[request.request_id].external_cached_tokens} - "
                f"{self.load_specs[request.request_id].vllm_cached_tokens}"
                f" for request {request.request_id}"
            )

        self.load_specs[request.request_id].can_load = True

    @_infinikv_nvtx_annotate
    def launch_io(self, budget: Optional[int] = None) -> None:
        """
        Advance pending asynchronous IO tasks if applicable.
        Default implementation is a no-op.
        """
        self._launch_pending_store_layer_tasks(budget)

    @_infinikv_nvtx_annotate
    def build_connector_meta(
        self, scheduler_output: SchedulerOutput
    ) -> KVConnectorMetadata:
        """Attach the connector metadata to the request object.

        This function should NOT modify other fields in the scheduler_output
        except the `kv_connector_metadata` field.
        Also, calling this function will reset the state of the connector.

        Args:
            scheduler_output (SchedulerOutput): the scheduler output object.
        """

        # 清除已经完成的请求，修改缓存的请求metadata，修改即将执行计算的请求metadata
        force_skip_save = self.kv_role == "kv_consumer"

        meta = InfiniKVConnectorMetadata()
        meta.num_total_scheduled_tokens = scheduler_output.total_num_scheduled_tokens
        meta.stage = "decode"

        # 处理计算完成的请求
        for finished_req_id in scheduler_output.finished_req_ids:
            self._request_trackers.pop(finished_req_id, None)
            self._requests_in_step.pop(finished_req_id, None)

        cached_reqs = scheduler_output.scheduled_cached_reqs

        for request in scheduler_output.scheduled_new_reqs:
            meta.stage = "prefill"
            # Right now, we only load KV for new requests
            load_spec = self.load_specs.pop(request.req_id, None)
            num_tokens_to_compute = (
                request.num_computed_tokens
                + scheduler_output.num_scheduled_tokens[request.req_id]
            )
            external_cached_tokens = 0
            if load_spec is not None:
                external_cached_tokens = load_spec.external_cached_tokens
            # 创建request_tracker，用于追踪请求有那些token被缓存
            request_tracker = RequestTracker.from_new_request(
                request,
                num_tokens_to_compute,
                external_cached_tokens,
            )
            self._request_trackers[request.req_id] = request_tracker

            req_meta = ReqMeta.from_request_tracker(
                request_tracker,
                self._block_size,
                self._infinikv_chunk_size,
                load_spec=load_spec,
                skip_save=force_skip_save,
                discard_partial_chunks=self._discard_partial_chunks,
            )
            if req_meta is not None:
                meta.add_request(req_meta)

        # NOTE: For backward compatibility with vllm version < 0.9.2,
        # In the latest vllm version, the type of scheduled_cached_reqs has
        # changed from list to object `CachedRequestData`
        if isinstance(cached_reqs, list):
            for i, req in enumerate(cached_reqs):
                request_tracker = self._request_trackers[req.req_id]
                request_tracker.update(req.new_token_ids, req.new_block_ids)

                if scheduler_output.num_scheduled_tokens[req.req_id] > 1:
                    meta.stage = "prefill"

                req_meta = ReqMeta.from_request_tracker(
                    request_tracker,
                    self._block_size,
                    self._infinikv_chunk_size,
                    load_spec=None,
                    skip_save=force_skip_save,
                    discard_partial_chunks=self._discard_partial_chunks,
                )
                if req_meta is not None:
                    meta.add_request(req_meta)
            return meta

        for i, req_id in enumerate(cached_reqs.req_ids):
            request_tracker = self._request_trackers[req_id]
            num_new_tokens = scheduler_output.num_scheduled_tokens[req_id]
            if num_new_tokens > 1:
                meta.stage = "prefill"
            if request := self._requests_in_step.get(req_id):
                num_current_tokens = len(request_tracker.token_ids)
                new_token_ids = request.all_token_ids[
                    num_current_tokens: num_current_tokens + num_new_tokens
                ]
            else:
                raise ValueError(
                    f"Request {req_id} is not in _requests_in_step, "
                    f"but it is scheduled to be cached"
                )
            new_block_ids = cached_reqs.new_block_ids[i]

            request_tracker.update(new_token_ids, new_block_ids)

            req_meta = ReqMeta.from_request_tracker(
                request_tracker,
                self._block_size,
                self._infinikv_chunk_size,
                load_spec=None,
                skip_save=force_skip_save,
                discard_partial_chunks=self._discard_partial_chunks,
            )
            if req_meta is not None:
                meta.add_request(req_meta)

        return meta

    def request_finished(
        self,
        request: "Request",
        block_ids: list[int],
    ) -> tuple[bool, Optional[dict[str, Any]]]:
        params = request.kv_transfer_params
        return_params = None

        # NOTE: Used to stream back the first token
        # for disagg prefill
        if params is not None and "ret_first_tok" in params:
            return_params = {
                "first_tok": request._output_token_ids[0],
            }

        return 0, return_params
