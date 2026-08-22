# Generated from fixtures/pyspark-version-contract.json. Do not edit.
from __future__ import annotations

MAX_PYSPARK_VERSION_CHARACTERS = 64
PYSPARK_SUPPORTED_MAJOR = "4"
PYSPARK_SUPPORTED_MINOR = "2"
PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL = frozenset(["4.2.0.dev5"])
_LOCAL_VERSION_CHARACTERS = frozenset("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_LOCAL_VERSION_SEPARATORS = frozenset("._-")


def classify_pyspark_version(version: object) -> str:
    if _is_supported_final_version(version):
        return "supported-final"
    if isinstance(version, str) and version in PYSPARK_ACCEPTANCE_PRERELEASE_DENIAL:
        return "acceptance-denial"
    return "unsupported"


def is_supported_pyspark_version(version: object) -> bool:
    return classify_pyspark_version(version) == "supported-final"


def safe_pyspark_version_diagnostic(version: object) -> str | None:
    if not isinstance(version, str) or not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return None
    return version if all(0x20 <= ord(character) <= 0x7E for character in version) else None


def _is_supported_final_version(version: object) -> bool:
    if not isinstance(version, str) or not 0 < len(version) <= MAX_PYSPARK_VERSION_CHARACTERS:
        return False
    local_parts = version.split("+")
    if len(local_parts) > 2:
        return False
    release_parts = local_parts[0].split(".")
    if (
        len(release_parts) != 3
        or not all(_is_ascii_integer(component) for component in release_parts)
        or _normalize_release_component(release_parts[0]) != PYSPARK_SUPPORTED_MAJOR
        or _normalize_release_component(release_parts[1]) != PYSPARK_SUPPORTED_MINOR
    ):
        return False
    return len(local_parts) == 1 or _is_valid_local_version(local_parts[1])


def _is_ascii_integer(value: str) -> bool:
    return bool(value) and all("0" <= character <= "9" for character in value)


def _is_valid_local_version(value: str) -> bool:
    if not value:
        return False
    segment_length = 0
    for character in value:
        if character in _LOCAL_VERSION_CHARACTERS:
            segment_length += 1
            continue
        if character not in _LOCAL_VERSION_SEPARATORS or segment_length == 0:
            return False
        segment_length = 0
    return segment_length > 0


def _normalize_release_component(component: str) -> str:
    return component.lstrip("0") or "0"
