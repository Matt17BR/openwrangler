from __future__ import annotations

import pytest

from openwrangler_runtime import dependency_guard


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


def test_exact_dependency_validation_accepts_only_the_selected_distribution_version(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependency_guard._validate_dependencies([exact_fsspec_dependency()])

    for observed in ("2026.6.0", "2026.8.0"):
        monkeypatch.setattr(dependency_guard.importlib.metadata, "version", lambda _distribution, value=observed: value)
        with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
            dependency_guard._validate_dependencies([exact_fsspec_dependency()])

    def missing(_distribution: str) -> str:
        raise dependency_guard.importlib.metadata.PackageNotFoundError

    monkeypatch.setattr(dependency_guard.importlib.metadata, "version", missing)
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([exact_fsspec_dependency()])
