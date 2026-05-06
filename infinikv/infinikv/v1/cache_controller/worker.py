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
from typing import TYPE_CHECKING
import asyncio
import threading

# Third Party
import msgspec
import zmq

# First Party
from infinikv.config import InfiniKVEngineMetadata
from infinikv.logging import init_logger
from infinikv.v1.cache_controller.message import (
    ClearWorkerMsg,
    ClearWorkerRetMsg,
    DeRegisterMsg,
    ErrorMsg,
    Msg,
    RegisterMsg,
    WorkerMsg,
)
from infinikv.v1.cache_controller.rpc_utils import (
    close_zmq_socket,
    get_ip,
    get_zmq_context,
    get_zmq_socket,
)
from infinikv.config import InfiniKVEngineConfig

if TYPE_CHECKING:
    # First Party
    from infinikv.v1.cache_engine import InfiniKVEngine

logger = init_logger(__name__)


class InfiniKVWorker:
    """
    InfiniKV Worker class to handle the execution of cache operations.
    This class is responsible for receiving requests from the executor and
    executing the corresponding operations on the InfiniKV engine.
    Each worker is associated with a specific InfiniKV instance and a worker id.
    """

    def __init__(
        self,
        config: InfiniKVEngineConfig,
        metadata: InfiniKVEngineMetadata,
        infinikv_engine: "InfiniKVEngine",
    ):
        # TODO (Jiayi): "instance_id" might not be needed anymore.
        # Please consider removing it.
        self.infinikv_instance_id = config.infinikv_instance_id
        assert self.infinikv_instance_id is not None
        self.infinikv_engine = infinikv_engine
        self.worker_id = metadata.worker_id

        self.context = get_zmq_context()

        assert config.controller_url is not None

        self.push_socket = get_zmq_socket(
            self.context,
            config.controller_url,
            protocol="tcp",
            role=zmq.PUSH,  # type: ignore[attr-defined]
            bind_or_connect="connect",
        )

        # TODO(Jiayi): Make this less hard-coded
        infinikv_worker_port = config.infinikv_worker_port
        assert infinikv_worker_port is not None
        # TODO(Jiayi): Make this port assignment smarter
        infinikv_worker_port += self.worker_id

        self.infinikv_worker_internal_url = f"*:{infinikv_worker_port}"
        self.infinikv_worker_ip = get_ip()
        self.infinikv_worker_port = infinikv_worker_port

        self.reply_socket = get_zmq_socket(
            self.context,
            self.infinikv_worker_internal_url,
            protocol="tcp",
            role=zmq.REP,  # type: ignore[attr-defined]
            bind_or_connect="bind",
        )

        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        asyncio.run_coroutine_threadsafe(self.start_all(), self.loop)

        self.msg_queue: asyncio.Queue[WorkerMsg] = asyncio.Queue()

        self.register()

    def register(self):
        """
        Register the infinikv worker with the controller.
        """
        assert self.infinikv_instance_id is not None
        logger.info(
            "Registering infinikv instance-worker: "
            f"{(self.infinikv_instance_id, self.worker_id)}"
        )
        self.put_msg(
            RegisterMsg(
                instance_id=self.infinikv_instance_id,
                worker_id=self.worker_id,
                ip=self.infinikv_worker_ip,
                port=self.infinikv_worker_port,
            )
        )

    def deregister(self):
        """
        De-register the infinikv worker from the controller.
        """
        assert self.infinikv_instance_id is not None
        self.put_msg(
            DeRegisterMsg(
                instance_id=self.infinikv_instance_id,
                worker_id=self.worker_id,
                ip=self.infinikv_worker_ip,
                port=self.infinikv_worker_port,
            )
        )

    def put_msg(self, msg: WorkerMsg):
        """
        Put a message into the message queue.
        """
        self.loop.call_soon_threadsafe(self.msg_queue.put_nowait, msg)

    async def batched_get_msg(self, max_bsz: int = 50) -> list[WorkerMsg]:
        """
        Get a batch of messages from the message queue.
        """
        batch = []

        # use blocking get for the first msg
        try:
            item = await self.msg_queue.get()
            batch.append(item)
        except asyncio.CancelledError:
            return batch  # shutdown path

        for _ in range(max_bsz - 1):
            try:
                item = self.msg_queue.get_nowait()
                batch.append(item)
            except asyncio.QueueEmpty:
                break
        return batch

    async def push(self):
        while True:
            try:
                msgs = await self.batched_get_msg()
                logger.debug(f"Sending {len(msgs)} messages")
                self.push_socket.send_multipart(
                    [msgspec.msgpack.encode(msg) for msg in msgs]
                )

            except Exception as e:
                logger.error(f"Push error: {e}")

    async def handle_request(self):
        """
        Handle incoming requests (control msgs) from the controller.
        """
        while True:
            try:
                serialized_request = await self.reply_socket.recv()
                request = msgspec.msgpack.decode(serialized_request, type=Msg)
                logger.debug(f"Received message: {request}")
                if isinstance(request, ClearWorkerMsg):
                    tokens = request.tokens
                    result = self.infinikv_engine.clear(tokens)
                    serialized_ret_msg = msgspec.msgpack.encode(
                        ClearWorkerRetMsg(success=result > 0)
                    )
                else:
                    logger.error(f"Unknown message: {request}")
                    serialized_ret_msg = msgspec.msgpack.encode(
                        ErrorMsg(error=f"Unknown message: {request}")
                    )

                await self.reply_socket.send(serialized_ret_msg)
            except Exception as e:
                logger.error(f"Worker error: {e}")
                serialized_ret_msg = msgspec.msgpack.encode(
                    ErrorMsg(error=f"Worker error: {e}")
                )
                await self.reply_socket.send(serialized_ret_msg)

    async def start_all(self):
        try:
            logger.info(
                f"Starting infinikv worker {self.worker_id}"
                f"for instance {self.infinikv_instance_id}"
            )
            await asyncio.gather(
                self.push(),
                self.handle_request(),
            )
        except Exception as e:
            logger.error(
                f"Instance {self.infinikv_instance_id}, "
                f"worker {self.worker_id} error: {e}"
            )

    def close(self):
        self.deregister()
        if self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread.is_alive():
            self.thread.join()
        close_zmq_socket(self.push_socket)
        close_zmq_socket(self.reply_socket)
