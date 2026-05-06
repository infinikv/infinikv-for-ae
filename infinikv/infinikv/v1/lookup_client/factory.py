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

# First Party
from infinikv.integration.vllm.utils import infinikv_get_config
from infinikv.logging import init_logger
from infinikv.v1.infinikv_engine import InfiniKVEngine
from infinikv.v1.lookup_client.abstract_client import LookupClientInterface

if TYPE_CHECKING:
    # Third Party
    from vllm.config import VllmConfig
    from vllm.distributed.kv_transfer.kv_connector.v1.base import KVConnectorRole

    # First Party
    from infinikv.v1.lookup_client.infinikv_lookup_client import InfiniKVLookupServer

logger = init_logger(__name__)


class LookupClientFactory:
    """Factory for creating lookup clients and servers based on configuration."""

    @staticmethod
    def create_lookup_client(
        role: "KVConnectorRole",
        is_tp: bool,
        vllm_config: "VllmConfig",
    ) -> LookupClientInterface:
        """
        Create a lookup client based on the configuration.

        Args:
            role: The KV connector role
            is_tp: Whether tensor parallelism is enabled
            vllm_config: The vLLM configuration

        Returns:
            A lookup client instance
        """
        config = infinikv_get_config()

        # Check if external_lookup_client is configured
        if config.external_lookup_client is not None:
            return LookupClientFactory._create_external_lookup_client(
                config.external_lookup_client, role, is_tp, vllm_config
            )
        else:
            # First Party
            from infinikv.v1.lookup_client.infinikv_lookup_client import (
                InfiniKVLookupClient,
            )

            return InfiniKVLookupClient(role, is_tp, vllm_config)

    @staticmethod
    def create_lookup_server(
        infinikv_engine: InfiniKVEngine,
        role: "KVConnectorRole",
        is_tp: bool,
        vllm_config: "VllmConfig",
    ) -> Optional["InfiniKVLookupServer"]:
        """
        Create a lookup server based on the configuration.

        Args:
            infinikv_engine: The InfiniKV engine instance
            role: The KV connector role
            is_tp: Whether tensor parallelism is enabled
            vllm_config: The vLLM configuration

        Returns:
            A lookup server instance, or None if no server should be created
        """
        config = infinikv_get_config()

        # Only create the KV lookup API server on worker rank 0
        # when there are multiple workers and when not using external lookup client
        if (
            vllm_config.parallel_config.rank == 0
            and config.external_lookup_client is None
        ):
            # First Party
            from infinikv.v1.lookup_client.infinikv_lookup_client import InfiniKVLookupServer

            return InfiniKVLookupServer(infinikv_engine, role, is_tp, vllm_config)

        return None

    @staticmethod
    def _create_external_lookup_client(
        external_lookup_uri: str,
        role: "KVConnectorRole",
        is_tp: bool,
        vllm_config: "VllmConfig",
    ) -> LookupClientInterface:
        """
        Create an external lookup client based on the URI format.

        Args:
            external_lookup_uri: URI in format <scheme>://<address>
            role: The KV connector role
            is_tp: Whether tensor parallelism is enabled
            vllm_config: The vLLM configuration

        Returns:
            A lookup client instance

        Raises:
            ValueError: If the URI format is unsupported
        """
        raise ValueError(
            f"Unsupported external lookup client scheme: {external_lookup_uri}. "
            "Supported schemes: redis"
        )
