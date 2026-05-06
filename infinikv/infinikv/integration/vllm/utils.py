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
from typing import TYPE_CHECKING, Tuple
import os

if TYPE_CHECKING:
    from vllm.config import ModelConfig
    from vllm.multimodal.inputs import PlaceholderRange
    from vllm.v1.request import Request

# Third Party
import torch

# First Party
from infinikv.logging import init_logger
from infinikv.config import InfiniKVEngineConfig as InfiniKVV1Config  # type: ignore[assignment]

logger = init_logger(__name__)
ENGINE_NAME = "vllm-instance"


def is_false(value: str) -> bool:
    """Check if the given string value is equivalent to 'false'."""
    return value.lower() in ("false", "0", "no", "n", "off")



def infinikv_get_config() -> InfiniKVV1Config:
    """Get the InfiniKV configuration from the environment variable
    `INFINIKV_CONFIG_FILE`. If the environment variable is not set, this
    function will return the default configuration.
    """
    if "INFINIKV_CONFIG_FILE" not in os.environ:
        logger.warn(
            "No InfiniKV configuration file is set. Trying to read"
            " configurations from the environment variables."
        )
        logger.warn(
            "You can set the configuration file through "
            "the environment variable: INFINIKV_CONFIG_FILE"
        )
        logger.warn(
            "You can set the configuration file through "
            "the environment variable: INFINIKV_CONFIG_FILE"
        )
        config = InfiniKVV1Config.from_env()
    else:
        config_file = os.environ["INFINIKV_CONFIG_FILE"]
        logger.info(f"Loading InfiniKV config file {config_file}")
        config = InfiniKVV1Config.from_file(config_file)
    return config


def hex_hash_to_int16(s: str) -> int:
    """
    Convert a hex hash string to a 16-bit integer.
    """
    return int(s, 16) & 0xFFFF

def extract_mm_features(
    request: "Request", modify: bool = False
) -> Tuple[list[str], list["PlaceholderRange"]]:
    """
    Normalize multimodal information from a Request into parallel lists.

    This helper reads either:
      1) `request.mm_features` (objects each exposing `.identifier` and
      `.mm_position`), or
      2) legacy fields `request.mm_hashes` and `request.mm_positions`.

    It returns two equally sized lists: the multimodal hash identifiers and their
    corresponding positions. If the request contains no multimodal info, it returns
    `([], [])`.

    Args:
        request (Request): The source object.
        modify (bool):
            Controls copy semantics for the legacy-path return values.
            - If True and legacy fields are used, shallow-copies are returned so
              the caller can mutate the lists without affecting `request`.
            - If False, the original legacy sequences are returned as-is
              (zero-copy); treat them as read-only.

    Returns:
        Tuple[list[str], list[PlaceholderRange]]: (`mm_hashes`, `mm_positions`).
        May be `([], [])` when no multimodal data is present.
    """
    if getattr(request, "mm_features", None):
        mm_hashes, mm_positions = zip(
            *((f.identifier, f.mm_position) for f in request.mm_features), strict=False
        )
        return (list(mm_hashes), list(mm_positions))
    elif getattr(request, "mm_hashes", None):
        if modify:
            return (request.mm_hashes.copy(), request.mm_positions.copy())
        else:
            return (request.mm_hashes, request.mm_positions)
    else:
        return ([], [])

def apply_mm_hashes_to_token_ids(
    token_ids: torch.Tensor,
    mm_hashes: list[str],
    mm_positions: list["PlaceholderRange"],
) -> torch.Tensor:
    """
    Overwrite token_ids in-place for multimodal placeholders using
    efficient slice assignments.
    """
    n = token_ids.size(0)
    for hash_str, placeholder in zip(mm_hashes, mm_positions, strict=False):
        start, length = placeholder.offset, placeholder.length
        if start >= n:
            continue
        end = min(start + length, n)
        token_ids[start:end] = hex_hash_to_int16(hash_str)
    return token_ids