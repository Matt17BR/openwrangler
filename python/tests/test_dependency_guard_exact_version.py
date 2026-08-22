from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

import pytest

from openwrangler_runtime import dependency_guard

ROOT = Path(__file__).parents[2]


def exact_dependency(version: str = "2026.7.0") -> dict[str, object]:
    return {
        "importModule": "openwrangler_exact_probe",
        "distribution": "openwrangler-exact-probe",
        "installSpec": f"openwrangler-exact-probe=={version}",
        "exactVersion": version,
        "minimumVersion": None,
        "maximumVersionExclusive": None,
    }


def _install_owned_distribution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    dependency: dict[str, object],
    version: str,
) -> Path:
    root = tmp_path / "owned-distribution"
    root.mkdir()
    module_name = str(dependency["importModule"])
    (root / f"{module_name}.py").write_text("VALUE = 1\n", encoding="utf-8")
    distribution_name = str(dependency["distribution"])
    metadata_name = distribution_name.replace("-", "_")
    metadata_root = root / f"{metadata_name}-0.dist-info"
    metadata_root.mkdir()
    metadata = metadata_root / "METADATA"
    _write_distribution_version(metadata, dependency, version)
    (metadata_root / "RECORD").write_text(f"{module_name}.py,,\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(root))
    importlib.invalidate_caches()
    return metadata


def _write_distribution_version(metadata: Path, dependency: dict[str, object], version: str) -> None:
    distribution_name = str(dependency["distribution"])
    metadata.write_text(
        f"Metadata-Version: 2.1\nName: {distribution_name}\nVersion: {version}\n",
        encoding="utf-8",
    )
    sys.modules.pop(str(dependency["importModule"]), None)
    importlib.invalidate_caches()


def test_exact_dependency_normalization_requires_matching_install_and_probe_versions() -> None:
    dependency = exact_dependency()
    assert dependency_guard._normalize_dependency(dependency, code="invalid_request") == dependency

    for invalid in (
        {**dependency, "exactVersion": None},
        {**dependency, "exactVersion": "2026.6.0"},
        {**dependency, "minimumVersion": "2026.7.0"},
        {**dependency, "maximumVersionExclusive": "2026.8.0"},
        {
            **dependency,
            "installSpec": "openwrangler-exact-probe>=2026.2.0,==2026.7.0",
            "exactVersion": None,
            "minimumVersion": "2026.2.0",
        },
    ):
        with pytest.raises(dependency_guard.GuardError, match="invalid_request"):
            dependency_guard._normalize_dependency(invalid, code="invalid_request")


def test_exact_dependency_validation_uses_pep440_equality(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependency = exact_dependency()
    metadata = _install_owned_distribution(tmp_path, monkeypatch, dependency, "2026.7.0")
    for observed in ("2026.7", "2026.7.0", "2026.7.0+local"):
        _write_distribution_version(metadata, dependency, observed)
        dependency_guard._validate_dependencies([dependency])

    for observed in ("2026.7.0rc1", "2026.7.0.post1", "2026.8.0", "invalid"):
        _write_distribution_version(metadata, dependency, observed)
        with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
            dependency_guard._validate_dependencies([dependency])

    missing = {**dependency, "distribution": "openwrangler-missing-exact-probe"}
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([missing])


def test_dependency_validation_matches_pep440_contract(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    contract = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))
    dependency = contract["dependency"]
    assert contract["maximumVersionLength"] == dependency_guard.VERSION_FIELD_MAX_LENGTH
    metadata = _install_owned_distribution(tmp_path, monkeypatch, dependency, "1.5.4")

    for case in contract["cases"]:
        _write_distribution_version(metadata, dependency, case["version"])
        if case["supported"]:
            dependency_guard._validate_dependencies([dependency])
        else:
            with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
                dependency_guard._validate_dependencies([dependency])


def test_dependency_validation_fails_closed_without_pep440_authority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependency = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))[
        "dependency"
    ]
    _install_owned_distribution(tmp_path, monkeypatch, dependency, "1.5.4")
    monkeypatch.setattr(dependency_guard, "_pep440_specifier", lambda _specifier: (_ for _ in ()).throw(ImportError()))
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([dependency])
