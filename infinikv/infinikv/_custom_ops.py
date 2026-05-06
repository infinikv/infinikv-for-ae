import torch
from infinikv.logging import init_logger

logger = init_logger(__name__)

# Import geminifs C++ extensions
try:
    import infinikv.c_ops as geminifs_ops
    _geminifs_available = True
    logger.info("Successfully imported infinikv.c_ops")
except ImportError as e:
    _geminifs_available = False
    logger.warning("Failed to import infinikv.c_ops with %r", e)
    geminifs_ops = None

# Global GeminiFS instance
_geminifs_instance = None


def initialize_geminifs(config_file_path: str, gpu_file_nums: int = 100, 
                       gpu_file_shape: list = None, reset: bool = False) -> bool:
    """Initialize GeminiFS with configuration."""
    global _geminifs_instance
    
    if not _geminifs_available:
        logger.error("GeminiFS C++ extension not available")
        return False
    
    if gpu_file_shape is None:
        logger.error("GPU File Shape must be provided")
        return False
    
    try:
        _geminifs_instance = geminifs_ops.GeminiFS(config_file_path, gpu_file_nums, gpu_file_shape, reset)
        logger.info(f"GeminiFS initialized with config: {config_file_path}")
        import time 
        time.sleep(10)
        return True
    except Exception as e:
        logger.error(f"Failed to initialize GeminiFS: {e}")
        return False


def get_gpu_controller(device_id: int):
    """Get GPU controller."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return None
    
    try:
        return _geminifs_instance.geminifs_get_gpu_controller(device_id)
    except Exception as e:
        logger.error(f"Failed to get GPU controller: {e}")
        return None


def register_tensor_with_gpu(tensor: torch.Tensor, granularity: int = 0) -> bool:
    """Register tensor with GPU."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False
    
    try:
        return _geminifs_instance.geminifs_register_tensor_with_gpu(tensor, granularity)
    except Exception as e:
        logger.error(f"Failed to register tensor: {e}")
        return False


def register_tensors_with_gpu(tensors: list[torch.Tensor], granularity: int = 0) -> bool:
    """Register a list of tensors with GPU in one call.
    Falls back to iterative single-tensor registration if the C++ batch API
    is not available.
    """
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False
    if not isinstance(tensors, (list, tuple)) or len(tensors) == 0:
        logger.error("register_tensors_with_gpu expects a non-empty list/tuple of tensors")
        return False
    # Try batch API first; fall back to iterative calls
    if hasattr(_geminifs_instance, 'geminifs_register_tensors_with_gpu'):
        try:
            return _geminifs_instance.geminifs_register_tensors_with_gpu(list(tensors), granularity)
        except Exception as e:
            logger.error(f"Failed to batch register tensors: {e}")
            return False
    else:
        for i, t in enumerate(tensors):
            try:
                logger.info(f"Registering tensor {i}: shape={t.shape}, dtype={t.dtype}, device={t.device}, granularity={granularity}")
                ok = _geminifs_instance.geminifs_register_tensor_with_gpu(t, granularity)
                if not ok:
                    logger.error(f"Failed to register tensor {i}: shape={t.shape}, device={t.device}, granularity={granularity}")
                    return False
            except Exception as e:
                logger.error(f"Failed to register tensor {i}: {e}")
                return False
        return True


def unregister_tensor_from_gpu(tensor: torch.Tensor) -> bool:
    """Unregister tensor from GPU."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False
    
    try:
        return _geminifs_instance.geminifs_unregister_tensor_from_gpu(tensor)
    except Exception as e:
        logger.error(f"Failed to unregister tensor: {e}")
        return False


# def get_tensor_dma_from_gpu(tensor: Tensor):
#     """Get tensor DMA context."""
#     if _geminifs_instance is None:
#         logger.error("GeminiFS not initialized")
#         return None
    
#     try:
#         return _geminifs_instance.geminifs_get_tensor_dma_from_gpu(tensor)
#     except Exception as e:
#         logger.error(f"Failed to get tensor DMA: {e}")
#         return None


def gpu_open_file(device_id: int):
    """Open GPU file and return (success, gpu_file_id)."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return None
    
    try:
        success, gpu_file_id = _geminifs_instance.geminifs_gpu_open_file(device_id)
        if success:
            return gpu_file_id
        return None
    except Exception as e:
        logger.error(f"Failed to open GPU file: {e}")
        return None


def geminifs_batched_read(k_caches: list[torch.Tensor], 
                          v_caches: list[torch.Tensor], 
                          gpu_file_ids: list[int], 
                          layer_ids: int, 
                          gpu_controller, 
                          stream_id: int) -> bool:
    """GPU read kernel."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False
    
    try:
        return _geminifs_instance.geminifs_batched_read(k_caches, v_caches, gpu_file_ids, layer_ids, gpu_controller, stream_id)
    except Exception as e:
        logger.error(f"Failed to execute GPU read kernel: {e}")
        return False


def geminifs_batched_write(k_caches: list[torch.Tensor],
                          v_caches: list[torch.Tensor],
                          gpu_file_ids: list[int],
                          layer_ids: int,
                          gpu_controller,
                          stream_id: int) -> bool:
    """GPU write kernel."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False

    try:
        return _geminifs_instance.geminifs_batched_write(k_caches, v_caches, gpu_file_ids, layer_ids, gpu_controller, stream_id)
    except Exception as e:
        logger.error(f"Failed to execute GPU write kernel: {e}")
        return False


def geminifs_batched_read_unified(caches: list[torch.Tensor],
                                   gpu_file_ids: list[int],
                                   layer_id: int,
                                   gpu_controller,
                                   stream_id: int) -> bool:
    """Unified (MLA) GPU read: single tensor per layer, no K/V split."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False

    try:
        return _geminifs_instance.geminifs_batched_read_unified(caches, gpu_file_ids, layer_id, gpu_controller, stream_id)
    except Exception as e:
        logger.error(f"Failed to execute unified GPU read: {e}")
        return False


def geminifs_batched_write_unified(caches: list[torch.Tensor],
                                    gpu_file_ids: list[int],
                                    layer_id: int,
                                    gpu_controller,
                                    stream_id: int) -> bool:
    """Unified (MLA) GPU write: single tensor per layer, no K/V split."""
    if _geminifs_instance is None:
        logger.error("GeminiFS not initialized")
        return False

    try:
        return _geminifs_instance.geminifs_batched_write_unified(caches, gpu_file_ids, layer_id, gpu_controller, stream_id)
    except Exception as e:
        logger.error(f"Failed to execute unified GPU write: {e}")
        return False