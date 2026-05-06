# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright contributors to the vLLM project
from collections.abc import Iterable
from math import gcd
from typing import TYPE_CHECKING, Any

import torch
from infinikv.integration.vllm.vllm_v1_adapter import InfiniKVConnectorV1Impl

from vllm.config import VllmConfig
from vllm.distributed.kv_transfer.kv_connector.v1.base import (
    KVConnectorBase_V1,
    KVConnectorMetadata,
    KVConnectorRole,
)
from vllm.logger import init_logger
from vllm.v1.attention.backend import AttentionMetadata
from vllm.v1.core.sched.output import SchedulerOutput

if TYPE_CHECKING:
    from vllm.distributed.kv_events import KVCacheEvent
    from vllm.forward_context import ForwardContext
    from vllm.v1.attention.backend import AttentionBackend
    from vllm.v1.core.kv_cache_manager import KVCacheBlocks
    from vllm.v1.kv_cache_interface import KVCacheConfig
    from vllm.v1.outputs import KVConnectorOutput
    from vllm.v1.request import Request

logger = init_logger(__name__)

# GeminiFS requires registered GPU tensors to have sizes aligned to this value
# for DMA operations (GPU-direct NVMe access).
_GEMINIFS_GPU_PAGE_SIZE = 65536


class InfiniKVConnectorV1(KVConnectorBase_V1):

    @classmethod
    def requires_piecewise_for_cudagraph(
        cls, extra_config: dict[str, Any]
    ) -> bool:
        """InfiniKV uses layer-by-layer async operations
        (wait_for_layer_load / save_kv_layer) that cannot be captured
        in CUDA graphs. PIECEWISE mode is always required."""
        return True

    @property
    def prefer_cross_layer_blocks(self) -> bool:
        """Prefer a single cross-layer KV cache tensor.

        When True, vLLM allocates ONE contiguous GPU buffer for all
        layers and calls register_cross_layers_kv_cache() instead of
        register_kv_caches().  This avoids registering many individual
        tensors with GeminiFS, which can trigger 'tensor without
        storage' errors due to DMA registration side-effects on the
        CUDA memory pool.
        """
        return True

    @staticmethod
    def _align_num_blocks_for_geminifs(
        kv_cache_config: "KVCacheConfig",
    ) -> None:
        """Align num_blocks so every KV cache tensor size is a multiple of
        GPU_PAGE_SIZE (65536 bytes).

        GeminiFS registers GPU tensors for direct NVMe DMA.  The hardware
        requires both the base pointer *and* the total region size to be
        page-aligned.  For models whose per-block byte size is not a multiple
        of 65536 (e.g. DeepSeek MLA where per_block = 128*576*2 = 147456,
        and 147456 / 65536 = 2.25), we round *down* num_blocks to the
        nearest value that satisfies alignment for every tensor.

        This modifies *kv_cache_config* in-place so the subsequent tensor
        allocation in gpu_model_runner already uses the corrected sizes.
        """
        num_blocks = kv_cache_config.num_blocks
        if num_blocks <= 0:
            return

        aligned = num_blocks
        for tensor in kv_cache_config.kv_cache_tensors:
            per_block_bytes = tensor.size // num_blocks
            if per_block_bytes == 0:
                continue
            if (per_block_bytes * num_blocks) % _GEMINIFS_GPU_PAGE_SIZE == 0:
                continue  # already aligned
            g = gcd(per_block_bytes, _GEMINIFS_GPU_PAGE_SIZE)
            blocks_per_align = _GEMINIFS_GPU_PAGE_SIZE // g
            aligned = min(
                aligned,
                (num_blocks // blocks_per_align) * blocks_per_align,
            )

        if aligned < num_blocks:
            logger.info(
                "Adjusting num_blocks %d -> %d for GeminiFS page alignment "
                "(lost %d blocks, %.3f%%)",
                num_blocks,
                aligned,
                num_blocks - aligned,
                (num_blocks - aligned) / num_blocks * 100,
            )
            for tensor in kv_cache_config.kv_cache_tensors:
                per_block_bytes = tensor.size // num_blocks
                tensor.size = per_block_bytes * aligned
            kv_cache_config.num_blocks = aligned

    def __init__(
        self,
        vllm_config: "VllmConfig",
        role: KVConnectorRole,
        kv_cache_config: "KVCacheConfig | None" = None,
    ):
        # Align num_blocks for GeminiFS before KV cache tensors are allocated.
        # This __init__ runs inside ensure_kv_transfer_initialized(), which is
        # called *before* gpu_model_runner.initialize_kv_cache() allocates the
        # actual GPU tensors — so the modified config propagates correctly.
        if kv_cache_config is not None:
            self._align_num_blocks_for_geminifs(kv_cache_config)

        super().__init__(
            vllm_config=vllm_config,
            role=role,
            kv_cache_config=kv_cache_config,
        )
        self._infinikv_engine = InfiniKVConnectorV1Impl(
            vllm_config, role, self, kv_cache_config=kv_cache_config
        )

    # ==============================
    # Worker-side methods
    # ==============================
    def register_kv_caches(self, kv_caches: dict[str, torch.Tensor]):
        return self._infinikv_engine.register_kv_caches(kv_caches)

    def register_cross_layers_kv_cache(
        self,
        kv_cache: torch.Tensor,
        attn_backend: "type[AttentionBackend]",
    ):
        """Register a single cross-layer KV cache tensor with GeminiFS.

        When prefer_cross_layer_blocks is True, vLLM allocates one
        contiguous buffer for all layers.  We register that single
        tensor for DMA instead of many per-layer tensors.
        """
        self._infinikv_engine.register_cross_layers_kv_cache(kv_cache)

    def start_load_kv(
        self, forward_context: "ForwardContext", **kwargs: Any
    ) -> None:
        self._infinikv_engine.start_load_kv(forward_context, **kwargs)

    def wait_for_layer_load(self, layer_name: str) -> None:
        self._infinikv_engine.wait_for_layer_load(layer_name)

    def save_kv_layer(
        self,
        layer_name: str,
        kv_layer: torch.Tensor,
        attn_metadata: AttentionMetadata,
        **kwargs: Any,
    ) -> None:
        self._infinikv_engine.save_kv_layer(
            layer_name, kv_layer, attn_metadata, **kwargs
        )

    def wait_for_save(self):
        self._infinikv_engine.wait_for_save()

    def get_finished(
        self, finished_req_ids: set[str]
    ) -> tuple[set[str] | None, set[str] | None]:
        return self._infinikv_engine.get_finished(finished_req_ids)

    def get_block_ids_with_load_errors(self) -> set[int]:
        return set()

    def get_kv_connector_kv_cache_events(self):
        return None

    # ==============================
    # Scheduler-side methods
    # ==============================
    def get_num_new_matched_tokens(
        self,
        request: "Request",
        num_computed_tokens: int,
    ) -> tuple[int | None, bool]:
        return self._infinikv_engine.get_num_new_matched_tokens(
            request, num_computed_tokens
        ), False

    def update_state_after_alloc(
        self,
        request: "Request",
        blocks: "KVCacheBlocks",
        num_external_tokens: int,
    ):
        self._infinikv_engine.update_state_after_alloc(
            request, num_external_tokens
        )

    def build_connector_meta(
        self, scheduler_output: SchedulerOutput
    ) -> KVConnectorMetadata:
        return self._infinikv_engine.build_connector_meta(scheduler_output)

    def update_connector_output(
        self, connector_output: "KVConnectorOutput"
    ):
        # No-op for now; can be extended later.
        return

    def request_finished(
        self,
        request: "Request",
        block_ids: list[int],
    ) -> tuple[bool, dict[str, Any] | None]:
        return self._infinikv_engine.request_finished(request, block_ids)

    def take_events(self) -> Iterable["KVCacheEvent"]:
        return ()
