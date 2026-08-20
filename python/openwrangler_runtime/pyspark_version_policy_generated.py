# Generated from fixtures/pyspark-version-contract.json. Do not edit.
from __future__ import annotations

import re

MAX_PYSPARK_VERSION_CHARACTERS = 64
PYSPARK_SUPPORTED_MAJOR = "4"
PYSPARK_SUPPORTED_MINOR = "2"
PYSPARK_FINAL_VERSION_PATTERN = (
    "^([0123456789]+)\\.([0123456789]+)\\.[0123456789]+(?:\\+[0123456789ABCDEFGHIJKLMNOP"
    "QRSTUVWXYZabcdefghijklmnopqrstuvwxyz]+(?:[._\\-][0123456789ABCDEFGHIJKLMNOPQRSTUV"
    "WXYZabcdefghijklmnopqrstuvwxyz]+)*)?$"
)

_FINAL_PYSPARK_VERSION = re.compile(PYSPARK_FINAL_VERSION_PATTERN)


def is_supported_pyspark_version(version: str) -> bool:
    if not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return False
    match = _FINAL_PYSPARK_VERSION.fullmatch(version)
    if match is None:
        return False
    return (
        _normalize_release_component(match[1]) == PYSPARK_SUPPORTED_MAJOR
        and _normalize_release_component(match[2]) == PYSPARK_SUPPORTED_MINOR
    )


def _normalize_release_component(component: str) -> str:
    return component.lstrip("0") or "0"
