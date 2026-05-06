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
from dataclasses import dataclass, field
from typing import Any, Optional, List, Tuple
import json
import os
# Third Party
import yaml
import torch

# First Party
from infinikv.logging import init_logger

logger = init_logger(__name__)

@dataclass
class InfiniKVEngineMetadata:
    """name of the LLM model"""

    model_name: str
    """ world size when running under a distributed setting """
    world_size: int
    """ worker id when running under a distributed setting """
    worker_id: int
    """ the format of kv tensors """
    fmt: str
    """ the data type of kv tensors """
    kv_dtype: torch.dtype
    """ the shape of kv tensors """
    """ (num_layer, 2, chunk_size, num_kv_head, head_size) """
    kv_shape: tuple[int, int, int, int, int]
    """ whether use MLA"""
    use_mla: bool = False
    """ whether the model is a hybrid architecture (e.g. full_attention + linear_attention) """
    is_hybrid: bool = False
    """ per-layer type list, e.g. ['full_attention', 'linear_attention', ...] """
    layer_types: Optional[List[str]] = None
    """ indices of full_attention layers (only these have KV cache managed by INFINIKV) """
    attn_layer_indices: Optional[List[int]] = None
    """ shapes of GDN/mamba recurrent states, one tuple per state tensor """
    mamba_state_shapes: Optional[Tuple[Tuple[int, ...], ...]] = None
    """ dtypes of GDN/mamba recurrent states, one dtype per state tensor """
    mamba_state_dtypes: Optional[Tuple[torch.dtype, ...]] = None

@dataclass
class InfiniKVEngineConfig:
    # common configurations
    chunk_size: int
    sys_config_path: str
    # sys_config_path1: str
    max_num_local_file: int
    max_local_disk_size: int # GB
    save_decode_cache: bool
    local_device: int # gpu rank in cluster
    
    # Error handling related configurations
    error_handling: bool = False  # whether to enable error handling
    
    # Controller related configurations
    enable_controller: Optional[bool] = False,  # whether to enable controller
    mount_path: str = "/mnt/infinikv"
    snapshot_filename: str = "geminifs_backend_snapshot.pkl"
    # the id of the infinikv instance
    infinikv_instance_id: str = "infinikv_default_instance"
    # controller url
    controller_url: Optional[str] = None
    # infinikv worker url
    # NOTE: port number will add `worker_id`
    infinikv_worker_port: Optional[int] = None
     # The extra config
    extra_config: Optional[dict] = None

    # By default, all chunks are saved
    # But in some scenarios, such as reuse, save unfull chunk is unnecessary
    save_unfull_chunk: bool = False

    # Set timeout(seconds) to improve infinikv stability
    # when calling get_blocking method in remote backend
    blocking_timeout_secs: int = 10

    # Optional external lookup client configuration
    # Supports URI-style format: mooncakestore://<MASTER_ADDRESS>
    # When set, uses external lookup client instead of regular lookup server
    external_lookup_client: Optional[str] = None
    
    @staticmethod
    def from_defaults(
            chunk_size: int = 128,
            snapshot_filename: str = "geminifs_backend_snapshot.pkl",
            mount_path: str = "/mnt/infinikv",
            max_num_local_file: int = 1000,
            max_local_disk_size: int = 100, # GB
            local_device: int = 0, # gpu rank in cluster
            save_decode_cache: bool = False,
            error_handling: bool = False,
            enable_controller: Optional[bool] = False,
            infinikv_instance_id: str = "infinikv_default_instance",
            controller_url: Optional[str] = None,
            infinikv_worker_port: Optional[int] = None,
            extra_config: Optional[dict] = None,
            save_unfull_chunk: bool = False,
            blocking_timeout_secs: int = 10,
            external_lookup_client: Optional[str] = None,
    ) -> "InfiniKVEngineConfig":
        return InfiniKVEngineConfig(
            chunk_size=chunk_size,
            snapshot_filename=snapshot_filename,
            mount_path=mount_path,
            max_num_local_file=max_num_local_file,
            max_local_disk_size=max_local_disk_size,
            local_device=local_device,
            save_decode_cache=save_decode_cache,
            error_handling=error_handling,
            enable_controller=enable_controller,
            infinikv_instance_id=infinikv_instance_id,
            controller_url=controller_url,
            infinikv_worker_port=infinikv_worker_port,
            extra_config=extra_config,
            save_unfull_chunk=save_unfull_chunk,
            blocking_timeout_secs=blocking_timeout_secs,
            external_lookup_client=external_lookup_client
            ).validate()

    @staticmethod
    def from_legacy(
        chunk_size: int = 128,
        sys_config_path: str = "/mnt/sys_config.ini",
        sys_config_path1: str = "/mnt/sys_config1.ini",
        mount_path: str = "/mnt/infinikv",
        snapshot_filename: str = "geminifs_backend_snapshot.pkl",
        max_num_local_file: int = 1000,
        max_local_disk_size: int = 100, # GB
        local_device: int = 0, # gpu rank in cluster
        save_decode_cache: bool = False,
        infinikv_instance_id: str = "infinikv_default_instance",
        save_unfull_chunk: bool = False,
    ) -> "InfiniKVEngineConfig":

        return (
            InfiniKVEngineConfig(
            chunk_size=chunk_size,
            sys_config_path=sys_config_path,
            # sys_config_path1=sys_config_path1,
            mount_path=mount_path,
            snapshot_filename=snapshot_filename,
            max_num_local_file=max_num_local_file,
            max_local_disk_size=max_local_disk_size,
            local_device=local_device,
            save_decode_cache=save_decode_cache,
            infinikv_instance_id=infinikv_instance_id,
            save_unfull_chunk=save_unfull_chunk,
            ).validate().log_config()
            )

    @staticmethod
    def from_file(file_path: str) -> "InfiniKVEngineConfig":
        """
        Load the config from a yaml file
        """
        with open(file_path, "r") as fin:
            config = yaml.safe_load(fin)
        
        chunk_size = config.get("chunk_size", 128)
        sys_config_path = config.get("sys_config_path", "/mnt/sys_config.ini")
        # sys_config_path1 = config.get("sys_config_path1", "/mnt/sys_config1.ini")
        mount_path = config.get("mount_path", "/mnt/infinikv")
        snapshot_filename = config.get("snapshot_filename", "geminifs_backend_snapshot.pkl")
        max_num_local_file = config.get("max_num_local_file", 1000)
        max_local_disk_size = config.get("max_local_disk_size", 100)
        local_device = config.get("local_device", 0)
        save_decode_cache = config.get("save_decode_cache", False)
        error_handling = config.get("error_handling", False)
        enable_controller = config.get("enable_controller", False)
        infinikv_instance_id = config.get("infinikv_instance_id", "infinikv_default_instance")
        controller_url = config.get("controller_url", None)
        infinikv_worker_port = config.get("infinikv_worker_port", None)
        extra_config = config.get("extra_config", None)
        save_unfull_chunk = config.get("save_unfull_chunk", False)
        blocking_timeout_secs = config.get("blocking_timeout_secs", 10)
        external_lookup_client = config.get("external_lookup_client", None)
        

        return (
            InfiniKVEngineConfig(
                chunk_size=chunk_size,
                sys_config_path=sys_config_path,
                # sys_config_path1=sys_config_path1,
                mount_path=mount_path,
                snapshot_filename=snapshot_filename,
                max_num_local_file=max_num_local_file,
                max_local_disk_size=max_local_disk_size,
                local_device=local_device,
                save_decode_cache=save_decode_cache,
                error_handling=error_handling,
                enable_controller=enable_controller,
                infinikv_instance_id=infinikv_instance_id,
                controller_url=controller_url,
                infinikv_worker_port=infinikv_worker_port,
                extra_config=extra_config,
                save_unfull_chunk=save_unfull_chunk,
                blocking_timeout_secs=blocking_timeout_secs,
                external_lookup_client=external_lookup_client
            ).validate().log_config()
        )
   
    @staticmethod
    def from_env() -> "InfiniKVEngineConfig":
        """Load the config from the environment variables

        It will first create a config by `from_defaults` and overwrite
        the configuration values from the environment variables.

        The environment variables should starts with INFINIKV and be in
        uppercase. For example, `INFINIKV_CHUNK_SIZE`.
        
        :note: the default configuration only uses cpu
        """

        def get_env_name(attr_name: str) -> str:
            return f"INFINIKV_{attr_name.upper()}"

        def parse_env(name: str, default: Optional[Any]) -> Optional[str]:
            if default is not None:
                return os.getenv(name, str(default))
            else:
                return os.getenv(name)

        def to_bool(value: Optional[str]) -> bool:
            if value is None:
                return False
            return value.lower() in ["true", "1"]

        def to_int(value: Optional[str]) -> int:
            if value is None:
                return 0
            return int(value)

        def to_float(value: Optional[str]) -> float:
            if value is None:
                return 0.0
            return float(value)

        def to_dict(value: Optional[str]) -> Optional[dict]:
            if value is None:
                return None
            res = json.loads(value)
            assert isinstance(res, dict), "value must be a dict"
            return res

        config = InfiniKVEngineConfig.from_defaults()

        config.chunk_size = to_int(parse_env(get_env_name("chunk_size"), config.chunk_size))
        config.sys_config_path = parse_env(get_env_name("sys_config_path"), config.sys_config_path)
        # config.sys_config_path1 = parse_env(get_env_name("sys_config_path1"), config.sys_config_path1)
        config.mount_path = parse_env(get_env_name("mount_path"), config.mount_path)
        config.snapshot_filename = parse_env(get_env_name("snapshot_filename"), config.snapshot_filename)
        config.max_num_local_file = to_int(parse_env(get_env_name("max_num_local_file"), config.max_num_local_file))
        config.max_local_disk_size = to_int(parse_env(get_env_name("max_local_disk_size"), config.max_local_disk_size))
        config.local_device = to_int(parse_env(get_env_name("local_device"), config.local_device))
        config.save_decode_cache = to_bool(parse_env(get_env_name("save_decode_cache"), config.save_decode_cache))
        config.error_handling = to_bool(parse_env(get_env_name("error_handling"), config.error_handling))
        config.enable_controller = to_bool(parse_env(get_env_name("enable_controller"), config.enable_controller))
        config.infinikv_instance_id = parse_env(get_env_name("infinikv_instance_id"), config.infinikv_instance_id)
        config.controller_url = parse_env(get_env_name("controller_url"), config.controller_url)
        config.infinikv_worker_port = to_int(parse_env(get_env_name("infinikv_worker_port"), config.infinikv_worker_port))
        config.extra_config = to_dict(parse_env(get_env_name("extra_config"), config.extra_config))
        config.save_unfull_chunk = to_bool(parse_env(get_env_name("save_unfull_chunk"), config.save_unfull_chunk))
        config.blocking_timeout_secs = to_int(parse_env(get_env_name("blocking_timeout_secs"), config.blocking_timeout_secs))
        config.external_lookup_client = parse_env(get_env_name("external_lookup_client"), config.external_lookup_client)

        return config.validate().log_config()

    def validate(self) -> "InfiniKVEngineConfig":
        """Validate the config"""
        assert self.sys_config_path is not None, "mount_path must be set"
        assert self.mount_path is not None, "mount_path must be set"
        assert self.max_num_local_file > 0, "max_num_local_file must be greater than 0"
        assert self.max_local_disk_size > 0, "max_local_disk_size must be greater than 0"
        assert self.local_device is not None, "local_device must be set"
        return self
        

    def log_config(self) -> "InfiniKVEngineConfig":
        """log the configuration in InfiniKV"""
        config_dict = {
            "chunk_size": self.chunk_size,
            "sys_config_path": self.sys_config_path,
            "mount_path": self.mount_path,
            "snapshot_filename": self.snapshot_filename,
            "max_num_local_file": self.max_num_local_file,
            "max_local_disk_size": f"{self.max_local_disk_size} GB",
            "local_device": self.local_device,
            "save_decode_cache": self.save_decode_cache,
            "error_handling": self.error_handling,
            "enable_controller": self.enable_controller,
            "infinikv_instance_id": self.infinikv_instance_id,  
            "controller_url": self.controller_url,
            "infinikv_worker_port": self.infinikv_worker_port,
            "extra_config": self.extra_config,
            "save_unfull_chunk": self.save_unfull_chunk,
            "blocking_timeout_secs": self.blocking_timeout_secs,
            "external_lookup_client": self.external_lookup_client,
            
        }
        logger.info(f"InfiniKV Configuration: {config_dict}")
        return self