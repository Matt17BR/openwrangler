from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
import tomllib
from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.version import Version
from scripts import python_runtime_dependency_authority as authority

from openwrangler_runtime import dependency_guard

ROOT = Path(__file__).parents[2]


def _authority_json() -> dict[str, Any]:
    return json.loads(authority.AUTHORITY_PATH.read_text(encoding="utf-8"))


def _write_authority(path: Path, value: Any) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def _inside_prerelease(minimum: str) -> str:
    release = list(Version(minimum).release)
    release.append(1)
    return f"{'.'.join(str(part) for part in release)}rc1"


def _inside_development_release(minimum: str) -> str:
    release = list(Version(minimum).release)
    release.append(1)
    return f"{'.'.join(str(part) for part in release)}.dev1"


def _boundary_cases(dependency: authority.Dependency) -> tuple[tuple[str, bool], ...]:
    if dependency.exact_version is not None:
        exact = dependency.exact_version
        release = ".".join(str(part) for part in Version(exact).release)
        next_release = list(Version(exact).release)
        next_release[-1] += 1
        return (
            (exact, True),
            (f"{exact}+openwrangler.1", True),
            (f"{release}rc1", False),
            (f"{release}.dev1", False),
            (".".join(str(part) for part in next_release), False),
        )

    assert dependency.minimum_version is not None
    assert dependency.maximum_version_exclusive is not None
    minimum = dependency.minimum_version
    maximum = dependency.maximum_version_exclusive
    minimum_release = ".".join(str(part) for part in Version(minimum).release)
    maximum_release = ".".join(str(part) for part in Version(maximum).release)
    return (
        (minimum, True),
        (dependency.tested_maximum_version, True),
        (f"{minimum}+openwrangler.1", True),
        (f"{minimum_release}rc1", False),
        (_inside_prerelease(minimum), True),
        (_inside_development_release(minimum), True),
        (f"{maximum_release}rc1", False),
        (maximum, False),
        (f"{maximum}.post1", False),
    )


def _guard_descriptor(dependency: authority.Dependency) -> dict[str, object]:
    descriptor = dependency.descriptor()
    return {
        "importModule": descriptor["importModule"],
        "distribution": descriptor["distribution"],
        "installSpec": descriptor["installSpec"],
        "exactVersion": descriptor.get("exactVersion"),
        "minimumVersion": descriptor.get("minimumVersion"),
        "maximumVersionExclusive": descriptor.get("maximumVersionExclusive"),
    }


def test_generated_consumers_match_the_dependency_authority() -> None:
    dependencies = authority.load_authority()
    assert authority.synchronize(write=False) == ()

    metadata = tomllib.loads(authority.PYPROJECT_PATH.read_text(encoding="utf-8"))
    runtime_specs = [dependency.install_spec for dependency in dependencies if dependency.pyproject_group == "runtime"]
    development_specs = [dependency.install_spec for dependency in dependencies if dependency.pyproject_group == "dev"]
    assert metadata["project"]["dependencies"] == runtime_specs
    for install_spec in development_specs:
        assert metadata["project"]["optional-dependencies"]["dev"].count(install_spec) == 1

    host = authority.HOST_PATH.read_text(encoding="utf-8")
    generated_host = authority._render_host(dependencies)
    assert f"{authority.HOST_START}\n{generated_host}\n{authority.HOST_END}" in host


def test_every_authority_descriptor_uses_the_guard_pep440_contract() -> None:
    for dependency in authority.load_authority():
        guard_descriptor = _guard_descriptor(dependency)
        assert dependency_guard._normalize_dependency(guard_descriptor, code="invalid_request") == guard_descriptor
        specifier = SpecifierSet(dependency.specifier)
        for version, supported in _boundary_cases(dependency):
            assert specifier.contains(Version(version), prereleases=True) is supported
            assert dependency_guard._dependency_version_supported(guard_descriptor, version) is supported


def test_guard_rejects_noncanonical_or_malformed_authority_descriptors() -> None:
    descriptor = _guard_descriptor(authority.load_authority()[0])
    distribution = descriptor["distribution"]
    minimum = descriptor["minimumVersion"]
    maximum = descriptor["maximumVersionExclusive"]
    assert isinstance(distribution, str)
    assert isinstance(minimum, str)
    assert isinstance(maximum, str)
    invalid = (
        {**descriptor, "installSpec": f"{distribution}>=0"},
        {**descriptor, "installSpec": f"{distribution}<{maximum}"},
        {**descriptor, "minimumVersion": "not-a-version"},
        {**descriptor, "minimumVersion": maximum},
        {**descriptor, "maximumVersionExclusive": minimum},
        {
            **descriptor,
            "installSpec": distribution,
            "minimumVersion": None,
            "maximumVersionExclusive": None,
        },
        {**descriptor, "installSpec": f"{distribution}>={minimum}", "maximumVersionExclusive": None},
    )
    for dependency in invalid:
        with pytest.raises(dependency_guard.GuardError, match="^invalid_request$"):
            dependency_guard._normalize_dependency(dependency, code="invalid_request")


def test_authority_failures_are_bounded_and_do_not_echo_input(tmp_path: Path) -> None:
    baseline = _authority_json()
    malformed: list[tuple[dict[str, Any], str]] = []

    bad_version = copy.deepcopy(baseline)
    bad_version["dependencies"][0]["minimumVersion"] = "secret-not-a-version"
    malformed.append((bad_version, "invalid_authority_version"))

    reversed_range = copy.deepcopy(baseline)
    reversed_range["dependencies"][0]["minimumVersion"] = reversed_range["dependencies"][0]["maximumVersionExclusive"]
    malformed.append((reversed_range, "invalid_authority_range"))

    unbounded = copy.deepcopy(baseline)
    unbounded["dependencies"][0]["maximumVersionExclusive"] = None
    malformed.append((unbounded, "unbounded_authority_range"))

    unqualified_minimum = copy.deepcopy(baseline)
    unqualified_minimum["dependencies"][0]["minimumVersion"] = "0"
    malformed.append((unqualified_minimum, "invalid_authority_evidence"))

    unsupported_evidence = copy.deepcopy(baseline)
    unsupported_evidence["dependencies"][0]["testedMaximumVersion"] = unsupported_evidence["dependencies"][0][
        "maximumVersionExclusive"
    ]
    malformed.append((unsupported_evidence, "invalid_authority_evidence"))

    external_evidence = copy.deepcopy(baseline)
    external_evidence["dependencies"][0]["evidence"] = ["../outside"]
    malformed.append((external_evidence, "invalid_authority_text"))

    duplicate_distribution = copy.deepcopy(baseline)
    duplicate_distribution["dependencies"][0]["distribution"] = "example.package"
    duplicate_entry = copy.deepcopy(duplicate_distribution["dependencies"][0])
    duplicate_entry["id"] = "polars_alias"
    duplicate_entry["importModule"] = "polars_alias"
    duplicate_entry["distribution"] = "example-package"
    duplicate_distribution["dependencies"].append(duplicate_entry)
    malformed.append((duplicate_distribution, "duplicate_authority_dependency"))

    for index, (value, code) in enumerate(malformed):
        path = _write_authority(tmp_path / f"malformed-{index}.json", value)
        with pytest.raises(authority.AuthorityError) as raised:
            authority.load_authority(path)
        assert str(raised.value) == code
        assert "secret" not in str(raised.value)

    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text('{"schemaVersion":1,"schemaVersion":1,"dependencies":[]}', encoding="utf-8")
    with pytest.raises(authority.AuthorityError, match="^duplicate_authority_key$"):
        authority.load_authority(duplicate)

    boolean_schema = copy.deepcopy(baseline)
    boolean_schema["schemaVersion"] = True
    with pytest.raises(authority.AuthorityError, match="^unsupported_authority_schema$"):
        authority.load_authority(_write_authority(tmp_path / "boolean-schema.json", boolean_schema))

    recursive = tmp_path / "recursive.json"
    recursive.write_text("[" * 20_000 + "0" + "]" * 20_000, encoding="utf-8")
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_shape$"):
        authority.load_authority(recursive)

    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b" " * (authority.MAX_AUTHORITY_BYTES + 1))
    with pytest.raises(authority.AuthorityError, match="^authority_too_large$"):
        authority.load_authority(oversized)


@pytest.mark.parametrize("failure", [RecursionError, MemoryError])
def test_parser_resource_failures_are_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException]
) -> None:
    path = _write_authority(tmp_path / "authority.json", _authority_json())

    def raise_failure(*_args: Any, **_kwargs: Any) -> Any:
        raise failure

    monkeypatch.setattr(authority.json, "loads", raise_failure)
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_json$"):
        authority.load_authority(path)
