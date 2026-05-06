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
from typing import TYPE_CHECKING, Optional
import threading

# Third Party
from vllm.utils.network_utils import make_zmq_socket
from vllm.v1.serial_utils import MsgpackDecoder, MsgpackEncoder
import torch
import vllm.envs as envs
import zmq

# First Party
from infinikv.logging import init_logger
from infinikv.v1.infinikv_engine import InfiniKVEngine
from infinikv.v1.lookup_client.abstract_client import LookupClientInterface

if TYPE_CHECKING:
    # Third Party
    from vllm.config import VllmConfig
    from vllm.distributed.kv_transfer.kv_connector.v1.base import KVConnectorRole

logger = init_logger(__name__)


def get_zmq_rpc_path_infinikv(
    role: "KVConnectorRole",
    is_tp: bool = False,
    vllm_config: Optional["VllmConfig"] = None,
) -> str:
    """Get the ZMQ RPC path for InfiniKV lookup communication."""
    base_url = envs.VLLM_RPC_BASE_PATH
    # Default to 0 if not configured
    rpc_port = 0
    if vllm_config is not None:
        rpc_port = vllm_config.kv_transfer_config.get_from_extra_config(
            "infinikv_rpc_port", 0
        )
    logger.debug("Base URL: %s, RPC Port: %s", base_url, rpc_port)
    return f"ipc://{base_url}/infinikv_rpc_port_{rpc_port}"


class InfiniKVLookupClient(LookupClientInterface):
    """ZMQ-based lookup client that communicates with a lookup server."""

    def __init__(self, role: "KVConnectorRole", is_tp: bool, vllm_config: "VllmConfig"):
        self.encoder = MsgpackEncoder()
        self.ctx = zmq.Context()  # type: ignore[attr-defined]
        socket_path = get_zmq_rpc_path_infinikv(role, is_tp, vllm_config)
        self.socket = make_zmq_socket(
            self.ctx,
            socket_path,
            zmq.REQ,  # type: ignore[attr-defined]
            bind=False,
        )

    def lookup(self, token_ids: torch.Tensor) -> int:
        request = self.encoder.encode(token_ids)
        self.socket.send_multipart(request, copy=False)
        resp = self.socket.recv()
        result = int.from_bytes(resp, "big")
        return result

    def close(self):
        self.socket.close(linger=0)


class InfiniKVLookupServer:
    """ZMQ-based lookup server that handles lookup requests using InfiniKVEngine."""

    def __init__(
        self,
        infinikv_engine: InfiniKVEngine,
        role: "KVConnectorRole",
        is_tp: bool,
        vllm_config: "VllmConfig",
    ):
        self.decoder = MsgpackDecoder(torch.Tensor)
        self.ctx = zmq.Context()  # type: ignore[attr-defined]
        socket_path = get_zmq_rpc_path_infinikv(role, is_tp, vllm_config)
        self.socket = make_zmq_socket(
            self.ctx,
            socket_path,
            zmq.REP,  # type: ignore[attr-defined]
            bind=True,
        )

        self.infinikv_engine = infinikv_engine
        self.running = True

        def process_request():
            while self.running:
                # try:
                # request = self.socket.recv()
                frames = self.socket.recv_multipart(copy=False)
                token_ids = self.decoder.decode(frames)
                result = self.infinikv_engine.lookup(token_ids, pin=True)
                response = result.to_bytes(4, "big")
                self.socket.send(response)
                # except Exception as e:
                #    logger.error("Error in InfiniKV lookup server: %s", e)
                #    break
                # continue

        self.thread = threading.Thread(target=process_request, daemon=True)
        self.thread.start()

    def close(self):
        self.socket.close(linger=0)
        # TODO: close the thread!
