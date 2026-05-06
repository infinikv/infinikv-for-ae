# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: Copyright contributors to the vLLM project
import inspect
from collections.abc import Callable
from functools import wraps

from vllm.distributed.kv_transfer import (
    get_kv_transfer_group,
    has_kv_transfer_group,
    is_v1_kv_transfer_group,
)


def maybe_transfer_kv_layer(func: Callable) -> Callable:
    """Decorator that handles KV layer transfer prior and after execution of
    an attention layer, if enabled. Otherwise, the wrapper is a no-op.

    On entry: waits for the KV layer from the connector.
    On exit: saves the KV layer to the connector.
    """
    # Import at runtime to avoid circular dependency
    from vllm.model_executor.layers.attention.attention import get_attention_context

    # Inspect the signature ONCE when the decorator is applied.
    sig = inspect.signature(func)
    param_names = list(sig.parameters.keys())

    # Find the index of 'layer_name' parameter.
    try:
        layer_name_index = param_names.index("layer_name")
    except ValueError as e:
        raise TypeError(
            f"Function {func.__name__} must have a 'layer_name' parameter"
        ) from e

    @wraps(func)
    def wrapper(*args, **kwargs):
        if not has_kv_transfer_group() or not is_v1_kv_transfer_group():
            return func(*args, **kwargs)

        layer_name: str = args[layer_name_index]

        # Extract attention context (metadata, layer, kv_cache, layer_slot_mapping)
        attn_metadata, _, kv_cache, _ = get_attention_context(layer_name)
        connector = get_kv_transfer_group()
        if attn_metadata is None or not connector.has_connector_metadata():
            return func(*args, **kwargs)

        # Wait for KV layer on entry
        connector.wait_for_layer_load(layer_name)

        # Execute the function
        result = func(*args, **kwargs)

        # Save KV cache layer on exit
        connector.save_kv_layer(layer_name, kv_cache, attn_metadata)

        return result

    return wrapper


def maybe_transfer_mamba_state(func: Callable) -> Callable:
    """Decorator that handles mamba/GDN recurrent state transfer for hybrid
    models with Infinikv connector. This is the mamba-state analogue of
    ``maybe_transfer_kv_layer``.

    The decorated function must have a ``layer_name`` parameter.

    When a InfiniKV connector with mamba state support is active:
    - On entry: loads the mamba state for this layer from the connector.
    - On exit: saves the mamba state for this layer to the connector.

    When no connector is active or the connector does not support mamba
    states, the decorator is a no-op.
    """
    sig = inspect.signature(func)
    param_names = list(sig.parameters.keys())

    try:
        layer_name_index = param_names.index("layer_name")
    except ValueError as e:
        raise TypeError(
            f"Function {func.__name__} must have a 'layer_name' parameter"
        ) from e

    @wraps(func)
    def wrapper(*args, **kwargs):
        if not has_kv_transfer_group() or not is_v1_kv_transfer_group():
            return func(*args, **kwargs)

        connector = get_kv_transfer_group()

        # Check if the connector supports mamba state transfer
        if not hasattr(connector, 'save_mamba_state'):
            return func(*args, **kwargs)

        layer_name: str = args[layer_name_index]

        # Load mamba state before execution
        load_fn = getattr(connector, 'load_mamba_state', None)
        if callable(load_fn):
            load_fn(layer_name)

        # Execute the function
        result = func(*args, **kwargs)

        # Save mamba state after execution
        save_fn = getattr(connector, 'save_mamba_state', None)
        if callable(save_fn):
            save_fn(layer_name)

        return result

    return wrapper
