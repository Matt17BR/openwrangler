from __future__ import annotations

import json
from pathlib import Path

import pytest

from openwrangler_runtime import dependency_guard

ROOT = Path(__file__).parents[2]


def exact_fsspec_dependency(version: str = "2026.7.0") -> dict[str, object]:
    return {
        "importModule": "fsspec",
        "distribution": "fsspec",
        "installSpec": f"fsspec=={version}",
        "exactVersion": version,
        "minimumVersion": None,
        "maximumVersionExclusive": None,
    }


def test_exact_dependency_normalization_requires_matching_install_and_probe_versions() -> None:
    dependency = exact_fsspec_dependency()
    assert dependency_guard._normalize_dependency(dependency, code="invalid_request") == dependency

    for invalid in (
        {**dependency, "exactVersion": None},
        {**dependency, "exactVersion": "2026.6.0"},
        {**dependency, "minimumVersion": "2026.7.0"},
        {**dependency, "maximumVersionExclusive": "2026.8.0"},
        {
            **dependency,
            "installSpec": "fsspec>=2026.2.0,==2026.7.0",
            "exactVersion": None,
            "minimumVersion": "2026.2.0",
        },
    ):
        with pytest.raises(dependency_guard.GuardError, match="invalid_request"):
            dependency_guard._normalize_dependency(invalid, code="invalid_request")


def test_exact_dependency_validation_uses_pep440_equality(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dependency_guard.importlib, "import_module", lambda _module: object())
    for observed in ("2026.7", "2026.7.0", "2026.7.0+local"):
        monkeypatch.setattr(dependency_guard.importlib.metadata, "version", lambda _distribution, value=observed: value)
        dependency_guard._validate_dependencies([exact_fsspec_dependency()])

    for observed in ("2026.7.0rc1", "2026.7.0.post1", "2026.8.0", "invalid"):
        monkeypatch.setattr(dependency_guard.importlib.metadata, "version", lambda _distribution, value=observed: value)
        with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
            dependency_guard._validate_dependencies([exact_fsspec_dependency()])

    def missing(_distribution: str) -> str:
        raise dependency_guard.importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(dependency_guard.importlib.metadata, "version", missing)
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([exact_fsspec_dependency()])


def test_dependency_validation_matches_pep440_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    contract = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))
    dependency = contract["dependency"]
    monkeypatch.setattr(dependency_guard.importlib, "import_module", lambda _module: object())

    for case in contract["cases"]:
        monkeypatch.setattr(
            dependency_guard.importlib.metadata,
            "version",
            lambda _distribution, value=case["version"]: value,
        )
        if case["supported"]:
            dependency_guard._validate_dependencies([dependency])
        else:
            with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
                dependency_guard._validate_dependencies([dependency])


def test_dependency_validation_fails_closed_without_pep440_authority(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dependency_guard.importlib, "import_module", lambda _module: object())
    monkeypatch.setattr(dependency_guard.importlib.metadata, "version", lambda _distribution: "1.5.4")
    monkeypatch.setattr(dependency_guard, "_pep440_specifier", lambda _specifier: (_ for _ in ()).throw(ImportError()))

    dependency = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))[
        "dependency"
    ]
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([dependency])
