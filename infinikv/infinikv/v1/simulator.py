from dataclasses import dataclass
import torch
import math
from typing import Tuple, Optional, assert_type
from infinikv.logging import init_logger

from typing import List, Dict
from infinikv.third_pkg.llm_viewer.model_analyzer import ModelAnalyzer, system_info

import flashinfer.green_ctx as green_ctx

logger = init_logger(__name__)


class StreamController:
    """
    Manages a pool of CUDA streams, each partitioned to a specific number of SMs.

    This controller pre-creates multiple streams with different SM resource allocations
    using green contexts. It provides an interface to get the most
    appropriate stream for a given number of concurrent tasks (e.g., I/O operations),
    effectively "padding" the resource request to the next available stream size.

    Args:
        device (torch.device): The CUDA device to create streams on.
        min_sm_partition (int): The number of SMs for the smallest stream partition.
        sm_partition_step (int): The increment in SMs for each subsequent stream partition.
        sms_per_io_task (int): An estimated heuristic for how many SMs are needed
                               per concurrent I/O task. This is used to calculate
                               the total required SMs.
    """

    def __init__(self,
                 device: torch.device,
                 min_sm_partition: int = 8,
                 sm_partition_step: int = 8,
                 sms_per_io_task: int = 1):
        if not torch.cuda.is_available() or device.type != 'cuda':
            raise ValueError("StreamController requires a CUDA device.")

        self.device = device
        self.per_device_total_sm: Dict[torch.device, int] = {}
        self.per_device_streams: Dict[torch.device,
                                      Dict[int, torch.cuda.Stream]] = {}
        self.per_device_sorted_sm_counts: Dict[torch.device, List[int]] = {}

        self.min_sm_partition = min_sm_partition
        self.sm_partition_step = sm_partition_step
        # 根据经验测试值设定, 每个io task(chunk粒度)需要多少sm
        # 对于通信而言，最大的sm数是32
        self.sms_per_io_task = sms_per_io_task
        # A dictionary mapping the SM count of a partition to its stream
        self.sm_count_to_stream: Dict[torch.device,
                                      Dict[int, torch.cuda.Stream]] = {}

        # 初始化数据结构
        self.per_device_streams[device] = {}
        self.per_device_sorted_sm_counts[device] = []
        self.per_device_total_sm[device] = torch.cuda.get_device_properties(
            device).multi_processor_count

        # 为该设备创建流
        self._init_stream_pool_for_device(device)

    def _init_stream_pool_for_device(self, device: torch.device):
        """
        Creates the pool of SM-partitioned streams for a specific device.
        """
        total_sm = self.per_device_total_sm[device]
        logger.info(
            f"Initializing stream pool on device {device} with {total_sm} total SMs.")

        sm_partitions = list(
            range(self.min_sm_partition, total_sm, self.sm_partition_step))

        self.per_device_sorted_sm_counts[device] = sm_partitions
        if not sm_partitions:
            logger.warning(
                f"Could not create any SM partitions on device {device} with the given configuration.")
            return

        try:
            for sm_count in sm_partitions:
                streams, _ = green_ctx.split_device_green_ctx_by_sm_count(device, [
                                                                          sm_count])
                self.per_device_streams[device][sm_count] = streams[0]
                logger.info(
                    f"Successfully created 1 streams on {device} with SM counts: {sm_count}")

        except Exception as e:
            logger.error(
                f"Failed to initialize flashinfer green contexts on {device}: {e}")
            raise

    def max_io_count(self, device: torch.device) -> int:
        return self.per_device_sorted_sm_counts.get(device)[-1] * self.sms_per_io_task

    def get_matched_stream(self, device: torch.device, io_count: int) -> Optional[torch.cuda.Stream]:
        """
        Gets the most suitable stream for a given number of I/O tasks on a specific device.

        Args:
            device (torch.device): The device for which to retrieve a stream.
            io_count (int): The number of concurrent I/O requests to be processed.

        Returns:
            Optional[torch.cuda.Stream]: The best-matched CUDA stream, or None.
        """
        if io_count <= 0:
            return None

        # 根据 device 参数查找对应的流池
        sorted_sm_counts = self.per_device_sorted_sm_counts.get(device)
        sm_count_to_stream = self.per_device_streams.get(device)

        if not sorted_sm_counts or not sm_count_to_stream:
            logger.error(
                f"No streams available in the pool for device {device}. Cannot match a stream.")
            return None

        required_sms = (io_count + self.sms_per_io_task -
                        1) // self.sms_per_io_task

        for sm_count in sorted_sm_counts:
            if sm_count >= required_sms:
                logger.info(
                    f"Device {device}: Matched {io_count} tasks (needs {required_sms} SMs) to stream with {sm_count} SMs.")
                # print("get_matched_stream", sm_count_to_stream[sm_count],
                #             "sm_count:", sm_count, "required_sms:", required_sms,
                #             "current_stream: ", torch.cuda.current_stream(device),
                #             "default_stream: ", torch.cuda.default_stream(device))
                return sm_count_to_stream[sm_count]

        largest_sm_count = sorted_sm_counts[-1]
        logger.warning(
            f"Device {device}: Required SMs ({required_sms}) exceeds the largest partition ({largest_sm_count}). "
            f"Returning the largest available stream."
        )
        return sm_count_to_stream[largest_sm_count]

    def get_matched_stream_by_sm(self, device: torch.device, sm_count: int) -> Optional[torch.cuda.Stream]:
        sm_count_to_stream = self.per_device_streams.get(device)
        if not sm_count_to_stream:
            logger.error(
                f"No streams available in the pool for device {device}.")
            return None
        assert sm_count <= 112
        print("debug: sm_count_to_stream", sm_count_to_stream[sm_count])
        print("debug: sm_count", sm_count)
        return sm_count_to_stream[sm_count]


class SmallStreamController:
    """
    Manage a pool of CUDA streams per device by partitioning total SMs
    into repeated chunks of size `min_sm_partition` (e.g., 8,8,8,...),
    with the last partition taking any remainder so that the sum equals
    the device's total SMs. Streams are created once via FlashInfer green
    contexts and then allocated/released from a pool.

    APIs:
      - get_matched_stream(device, io_count): allocate one free stream
      - acquire_stream(device): alias for allocation
      - mark_stream_done(device, stream): release a stream back to the pool
      - max_io_count(device): total stream count (upper bound of concurrency)
    """

    def __init__(self,
                 devices: List[torch.device],
                 min_sm_partition: int = 8,
                 sms_per_io_task: int = 1):
        if not torch.cuda.is_available() or devices[0].type != 'cuda':
            raise ValueError("StreamController requires a CUDA device.")

        self.devices = devices
        self.min_sm_partition = min_sm_partition
        self.sms_per_io_task = sms_per_io_task

        self.per_device_total_sm: Dict[torch.device, int] = {}
        self.per_device_partitions: Dict[torch.device, List[int]] = {}
        self.per_device_available_streams: Dict[torch.device, List[torch.cuda.Stream]] = {
        }
        self.per_device_inuse_streams: Dict[torch.device, set[torch.cuda.Stream]] = {
        }

        for device in self.devices:
            if not torch.cuda.is_available() or device.type != 'cuda':
                raise ValueError(
                    f"Device {device} is not a valid CUDA device.")
            self.per_device_total_sm[device] = torch.cuda.get_device_properties(
                device).multi_processor_count
            self._init_stream_pool_for_device(device)

    def _init_stream_pool_for_device(self, device: torch.device):
        total_sm = self.per_device_total_sm[device]
        logger.info(
            f"Initializing small-stream pool on {device} with {total_sm} SMs.")

        if self.min_sm_partition <= 0 or self.min_sm_partition > total_sm:
            partitions = [total_sm]
        else:
            full = total_sm // self.min_sm_partition
            partitions = [self.min_sm_partition] * full

        # Create one stream per partition using FlashInfer green contexts
        streams, _ = green_ctx.split_device_green_ctx_by_sm_count(
            device, partitions)

        self.per_device_partitions[device] = partitions
        self.per_device_available_streams[device] = streams
        self.per_device_inuse_streams[device] = set()

    def max_io_count(self, device: torch.device) -> int:
        return 0

    def get_matched_stream(self, device: torch.device, io_count: int) -> Optional[torch.cuda.Stream]:
        # io_count is not used to choose partitions in this simple pool model
        avail = self.per_device_available_streams.get(device)
        inuse = self.per_device_inuse_streams.get(device)
        if avail is None or inuse is None:
            logger.error(f"No stream pool tracked for device {device}.")
            return None
        if len(avail) == 0:
            logger.debug(f"No available streams on device {device} now.")
            return None
        stream = avail.pop()
        inuse.add(stream)
        return stream

    def acquire_stream(self, device: torch.device) -> Optional[torch.cuda.Stream]:
        return self.get_matched_stream(device, io_count=1)

    def mark_stream_done(self, device: torch.device, stream: torch.cuda.Stream) -> None:
        avail = self.per_device_available_streams.get(device)
        inuse = self.per_device_inuse_streams.get(device)
        if avail is None or inuse is None:
            logger.error(f"No stream pool tracked for device {device}.")
            return
        if stream in inuse:
            inuse.remove(stream)
            avail.append(stream)
        else:
            if stream not in avail:
                avail.append(stream)


@dataclass
class model_info:
    num_layers: int
    num_heads: int
    hidden_size: int
    num_kv_heads: int
    head_size: int
    gpu_tflops: float


@dataclass
class model_system_info:
    comm_io_bandwidth: float
    storage_io_bandwidth_Bps: float
    block_size: int
    tp_size: int
    dp_size: int
    w_bit: int
    a_bit: int
    kv_bit: int


class Simulator:
    def __init__(self, model_info: model_info, model_system_info: model_system_info, streamController: StreamController):
        self.model_info = model_info
        self.model_system_info = model_system_info
        self.streamController = streamController

        # TODO: 改用配置文件而非硬编码
        self.model_analyzer = ModelAnalyzer(model_id="Llama-3.1-8B-Instruct", hardware="nvidia_H100",
                                            system_info=system_info(
                                                w_bit=self.model_system_info.w_bit,
                                                a_bit=self.model_system_info.a_bit,
                                                kv_bit=self.model_system_info.kv_bit,
                                                tp_size=self.model_system_info.tp_size),
                                            source="Llama")

    def _estimate_prefill_comm_time_ms(self, num_tokens: int) -> float:
        result = self.model_analyzer.estimate_batch_step_time(
            stage="prefill", token_len=num_tokens, batch_size=1, use_flashattention=True)
        return result["prefill_comm_time"]

    def _estimate_decode_step_time_ms(self, num_tokens: int) -> float:
        result = self.model_analyzer.estimate_batch_step_time(
            stage="decode", token_len=num_tokens, batch_size=1, use_flashattention=True)
        return result["decode_time"]

    def execute(self, num_tokens: int, device: torch.device, exist_io_num: int, stage: str = "prefill") -> Tuple[int, Optional[torch.cuda.Stream]]:
        if stage == "prefill":
            overlap_window_s = self._estimate_prefill_comm_time_ms(num_tokens)
        elif stage == "decode":
            overlap_window_s = self._estimate_decode_step_time_ms(num_tokens)
        else:
            raise ValueError(f"Invalid stage: {stage}")
        if overlap_window_s <= 0:
            print("DEBUG: overlap_window_s <= 0", overlap_window_s)
            return 0, None

        # 2bytes * (k + v) * num_kv_heads * head_size * block_size
        chunk_bytes = self.model_info.num_kv_heads * \
            self.model_info.head_size * self.model_system_info.block_size * 2 * 2
        total_bytes_to_write = overlap_window_s * \
            self.model_system_info.storage_io_bandwidth_Bps
        io_count = min(min(exist_io_num, math.floor(
            total_bytes_to_write / chunk_bytes)), self.streamController.max_io_count(device))
        stream = self.streamController.get_matched_stream(device, io_count)
        return [io_count, stream]
