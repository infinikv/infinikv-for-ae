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
from enum import Enum
from typing import TYPE_CHECKING, Optional
import dataclasses

# Third Party
import torch

if TYPE_CHECKING:
    from vllm.worker.model_runner import ModelInputForGPUWithSamplingMetadata

# Third Party
from vllm.v1.attention.backend import AttentionMetadata

try:
    # New vLLM (v1 path)
    from vllm.v1.attention.backends.flash_attn import (
        FlashAttentionMetadata,
    )
except ImportError:
    try:
        # Third Party
        from vllm.attention.backends.flash_attn import FlashAttentionMetadata
    except (ModuleNotFoundError, ImportError):
        # vllm_flash_attn is not installed, try the ROCm FA metadata
        from vllm.attention.backends.rocm_flash_attn import (
            ROCmFlashAttentionMetadata as FlashAttentionMetadata,
        )

# Third Party
from vllm.v1.attention.backends.mla.flashmla import FlashMLAMetadata
from vllm.model_executor.layers.attention.mla_attention import MLACommonMetadata
from vllm.config import (
    CacheConfig,
    ModelConfig,
    ParallelConfig,
    SchedulerConfig,
)
from vllm.utils.torch_utils import get_kv_cache_torch_dtype

# First Party
from infinikv.config import InfiniKVEngineMetadata
from infinikv.integration.vllm.utils import ENGINE_NAME, infinikv_get_config
from infinikv.logging import init_logger
from infinikv.config import InfiniKVEngineConfig
from infinikv.v1.infinikv_engine import InfiniKVEngine, InfiniKVEngineBuilder

logger = init_logger(__name__)


SUPPORTED_BACKEND_METADATA = (
    FlashAttentionMetadata,
    FlashMLAMetadata,
    MLACommonMetadata,
)

VLLM_CACHE_CONFIG: Optional[CacheConfig] = None
VLLM_MODEL_CONFIG: Optional[ModelConfig] = None
VLLM_PARALLEL_CONFIG: Optional[ParallelConfig] = None
VLLM_SCHEDULER_CONFIG: Optional[SchedulerConfig] = None


class StoreStatus(Enum):
    PREFILL = 1
    CHUNK_PREFILL = 2
    DECODE = 3
    SUFFIX_PREFILL = 4
    NONE = 5


class RetrieveStatus(Enum):
    PREFILL = 1  # include (1) normal_prefill
    # (2) chunk_prefill_last
    # (3) prefix_prefill
    CHUNK_PREFILL = 2  # not last chunk
    NONE = 4



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

    if use_mla and getattr(config, 'remote_serde', None) not in (None, "naive"):
        raise ValueError("MLA only works with naive serde mode..")

    # Detect hybrid model architecture (e.g. Qwen3-Next with full_attention + linear_attention)
    is_hybrid = False
    layer_types = None
    attn_layer_indices = None
    mamba_state_shapes = None
    mamba_state_dtypes = None

    hf_config = model_config.hf_text_config if hasattr(model_config, "hf_text_config") else model_config.hf_config
    if hasattr(hf_config, "layer_types") and hf_config.layer_types is not None:
        layer_types = list(hf_config.layer_types)
        attn_layer_indices = [
            i for i, lt in enumerate(layer_types) if lt == "full_attention"
        ]
        if any(lt != "full_attention" for lt in layer_types):
            is_hybrid = True
            logger.info(
                "Detected hybrid model: %d full_attention layers, %d other layers",
                len(attn_layer_indices),
                len(layer_types) - len(attn_layer_indices),
            )

    # construct kv shape (for mem pool)
    num_layer = model_config.get_num_layers(parallel_config)
    # For hybrid models, INFINIKV only manages full_attention layers' KV cache
    if is_hybrid and attn_layer_indices is not None:
        num_layer = len(attn_layer_indices)
        logger.info(
            "Hybrid model: INFINIKV managing %d full_attention layers out of %d total",
            num_layer, len(layer_types),
        )
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
        is_hybrid=is_hybrid,
        layer_types=layer_types,
        attn_layer_indices=attn_layer_indices,
        mamba_state_shapes=mamba_state_shapes,
        mamba_state_dtypes=mamba_state_dtypes,
    )

    engine = InfiniKVEngineBuilder.get_or_create(
        ENGINE_NAME, config, metadata
    )

    return engine