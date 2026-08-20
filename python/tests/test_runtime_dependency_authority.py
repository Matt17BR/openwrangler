from __future__ import annotations

import copy
import importlib
import importlib.metadata
import json
import os
import subprocess
import sys
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
        (dependency.qualified_versions[-1], True),
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
    malformed.append((unqualified_minimum, "invalid_authority_qualification"))

    unsupported_qualification = copy.deepcopy(baseline)
    unsupported_qualification["dependencies"][0]["qualification"]["qualifiedVersions"][-1] = "2"
    malformed.append((unsupported_qualification, "invalid_authority_qualification"))

    unordered_qualification = copy.deepcopy(baseline)
    unordered_qualification["dependencies"][0]["qualification"]["qualifiedVersions"].reverse()
    malformed.append((unordered_qualification, "invalid_authority_qualification"))

    duplicate_qualification = copy.deepcopy(baseline)
    qualified = duplicate_qualification["dependencies"][0]["qualification"]["qualifiedVersions"]
    qualified.append(qualified[-1])
    malformed.append((duplicate_qualification, "invalid_authority_qualification"))

    unsupported_upper = copy.deepcopy(baseline)
    unsupported_upper["dependencies"][0]["maximumVersionExclusive"] = "3"
    malformed.append((unsupported_upper, "invalid_authority_qualification"))

    false_minimum_claim = copy.deepcopy(baseline)
    false_minimum_claim["dependencies"][0]["qualification"]["minimumStatus"] = "declared-unqualified"
    malformed.append((false_minimum_claim, "invalid_authority_qualification"))

    unexpected_evidence_key = copy.deepcopy(baseline)
    unexpected_evidence_key["dependencies"][0]["evidence"] = ["secret-path"]
    malformed.append((unexpected_evidence_key, "invalid_authority_shape"))

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


def test_epoch_and_supported_pandas_cohorts_have_pep440_boundaries(tmp_path: Path) -> None:
    value = _authority_json()
    entry = copy.deepcopy(value["dependencies"][0])
    entry.update(
        {
            "id": "example",
            "importModule": "example",
            "distribution": "example",
            "exactVersion": None,
            "minimumVersion": "1!2.3",
            "maximumVersionExclusive": "1!4",
            "pyprojectGroup": "runtime",
            "qualification": {
                "cohortKind": "major",
                "minimumStatus": "qualified",
                "qualifiedVersions": ["1!2.3", "1!3.9"],
            },
        }
    )
    value["dependencies"] = [entry]
    dependency = authority.load_authority(_write_authority(tmp_path / "epoch.json", value))[0]
    descriptor = _guard_descriptor(dependency)
    assert dependency.specifier == ">=1!2.3,<1!4"
    for version, supported in (
        ("1!2.3", True),
        ("1!2.3+local.1", True),
        ("1!2.3rc1", False),
        ("1!2.4.dev1", True),
        ("1!3.9", True),
        ("1!4rc1", False),
        ("1!4", False),
    ):
        assert dependency_guard._dependency_version_supported(descriptor, version) is supported

    pandas = next(item for item in authority.load_authority() if item.identifier == "pandas")
    assert pandas.specifier == ">=2.2,<4"
    assert tuple(Version(version).major for version in pandas.qualified_versions) == (2, 3)
    assert dependency_guard._dependency_version_supported(_guard_descriptor(pandas), "3.99.0")
    assert not dependency_guard._dependency_version_supported(_guard_descriptor(pandas), "4.0.0")


def test_every_qualified_dependency_is_imported_and_exercised(tmp_path: Path) -> None:
    dependencies = authority.load_authority()
    modules = {dependency.identifier: importlib.import_module(dependency.import_module) for dependency in dependencies}
    for dependency in dependencies:
        observed = Version(importlib.metadata.version(dependency.distribution))
        assert any(observed == Version(qualified) for qualified in dependency.qualified_versions), dependency.identifier

    assert modules["pandas"].DataFrame({"value": [1, 2]})["value"].sum() == 3
    polars_frame = modules["polars"].DataFrame({"value": [1, 2]})
    assert polars_frame.select(modules["polars"].col("value").sum()).item() == 3
    connection = modules["duckdb"].connect(":memory:")
    try:
        assert connection.execute("SELECT 1 + 2").fetchone() == (3,)
    finally:
        connection.close()

    filesystem = modules["fsspec"].filesystem("memory")
    memory_path = "/openwrangler-authority-probe"
    filesystem.pipe(memory_path, b"qualified")
    assert filesystem.cat(memory_path) == b"qualified"
    filesystem.rm(memory_path)

    from datetime import datetime

    localized = modules["pytz"].UTC.localize(datetime(2026, 1, 1))
    assert localized.utcoffset().total_seconds() == 0
    arrow_table = modules["pyarrow"].table({"value": [1, 2]})
    assert arrow_table.column("value").to_pylist() == [1, 2]

    workbook_path = tmp_path / "qualified.xlsx"
    workbook = modules["openpyxl"].Workbook()
    workbook.active.append(["value"])
    workbook.active.append([7])
    workbook.save(workbook_path)
    loaded = modules["openpyxl"].load_workbook(workbook_path, read_only=True)
    try:
        assert loaded.active["A2"].value == 7
    finally:
        loaded.close()
    assert modules["xlrd"].book.Book().nsheets == 0

    transformer = modules["ipython"].core.inputtransformer2.TransformerManager()
    assert transformer.transform_cell("value = 1") == "value = 1\n"
    fast_workbook = modules["fastexcel"].read_excel(workbook_path)
    assert fast_workbook.load_sheet(0).to_arrow().num_rows == 1


def test_generation_markers_are_exact_ordered_standalone_lines() -> None:
    blocks = (("# START ONE", "# END ONE", "new one"), ("# START TWO", "# END TWO", "new two"))
    source = "before\n# START ONE\nold one\n# END ONE\nmiddle\n# START TWO\nold two\n# END TWO\nafter\n"
    assert authority._replace_blocks(source, blocks) == (
        "before\n# START ONE\nnew one\n# END ONE\nmiddle\n# START TWO\nnew two\n# END TWO\nafter\n"
    )

    malformed = (
        (source.replace("# START ONE", "prefix # START ONE secret"), "malformed_generation_marker"),
        (source.replace("# START ONE", "# START ONE\r"), "malformed_generation_marker"),
        (source.replace("# END ONE\n", ""), "missing_generation_marker"),
        (source + "# START ONE\n", "duplicate_generation_marker"),
        ("# END ONE\n# START ONE\n# START TWO\n# END TWO\n", "reversed_generation_marker"),
        ("# START TWO\n# END TWO\n# START ONE\n# END ONE\n", "reversed_generation_marker"),
        ("# START ONE\n# START TWO\n# END TWO\n# END ONE\n", "nested_generation_marker"),
    )
    for candidate, code in malformed:
        with pytest.raises(authority.AuthorityError) as raised:
            authority._replace_blocks(candidate, blocks)
        assert str(raised.value) == code
        assert "secret" not in str(raised.value)
        assert len(str(raised.value)) < 64


def _temporary_consumers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    pyproject = tmp_path / "pyproject.toml"
    host = tmp_path / "pythonEnvironmentModel.ts"
    pyproject.write_text(
        authority.PYPROJECT_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    host.write_text(
        authority.HOST_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    monkeypatch.setattr(authority, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(authority, "HOST_PATH", host)
    return pyproject, host


def test_synchronize_repairs_both_consumers_without_partial_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    assert authority.synchronize(write=False) == (pyproject, host)
    assert authority.synchronize(write=True) == (pyproject, host)
    assert authority.synchronize(write=False) == ()
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_atomic_rewrite_rolls_back_the_first_consumer_when_the_second_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path: path.read_bytes() for path in (pyproject, host)}
    real_replace = authority.os.replace
    failed = False

    def fail_second(source: os.PathLike[str], destination: os.PathLike[str]) -> None:
        nonlocal failed
        if Path(destination) == host and not failed:
            failed = True
            raise OSError("secret-path-must-not-escape")
        real_replace(source, destination)

    monkeypatch.setattr(authority.os, "replace", fail_second)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$"):
        authority.synchronize(write=True)
    assert {path: path.read_bytes() for path in (pyproject, host)} == originals
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_atomic_rewrite_detects_drift_without_overwriting_the_racing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    original_pyproject = pyproject.read_bytes()
    original_host = host.read_bytes()
    racing_host = original_host + b"// concurrent owner\n"
    real_replace = authority.os.replace
    drifted = False

    def replace_then_drift(source: os.PathLike[str], destination: os.PathLike[str]) -> None:
        nonlocal drifted
        real_replace(source, destination)
        if Path(destination) == pyproject and not drifted:
            drifted = True
            host.write_bytes(racing_host)

    monkeypatch.setattr(authority.os, "replace", replace_then_drift)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == original_pyproject
    assert host.read_bytes() == racing_host
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_concurrent_generator_writer_fails_closed_with_a_stable_code() -> None:
    with authority._authority_write_lock():
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                str(authority.ROOT / "scripts" / "python_runtime_dependency_authority.py"),
                "--write",
            ],
            check=False,
            capture_output=True,
            timeout=10,
        )
    assert result.returncode == 2
    assert result.stdout == b""
    assert result.stderr == b"consumer_write_busy\n"


def test_atomic_rewrite_checks_staged_temporary_identity(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path: path.read_bytes() for path in (pyproject, host)}
    real_same_snapshot = authority._same_snapshot

    def reject_staged(snapshot: authority.ConsumerSnapshot) -> bool:
        if snapshot.path.parent == tmp_path and ".openwrangler-" in snapshot.path.name:
            return False
        return real_same_snapshot(snapshot)

    monkeypatch.setattr(authority, "_same_snapshot", reject_staged)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$"):
        authority.synchronize(write=True)
    assert {path: path.read_bytes() for path in (pyproject, host)} == originals
    retained = list(tmp_path.glob(".*.openwrangler-*"))
    assert len(retained) == 4


def test_rollback_does_not_overwrite_a_concurrently_changed_committed_consumer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    original_host = host.read_bytes()
    concurrent_pyproject = b"concurrent owner bytes\n"
    real_replace = authority.os.replace
    failed = False

    def race_then_fail(source: os.PathLike[str], destination: os.PathLike[str]) -> None:
        nonlocal failed
        if Path(destination) == host and not failed:
            failed = True
            pyproject.write_bytes(concurrent_pyproject)
            raise OSError("secret-path-must-not-escape")
        real_replace(source, destination)

    monkeypatch.setattr(authority.os, "replace", race_then_fail)
    with pytest.raises(authority.AuthorityError, match="^consumer_rollback_failed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == concurrent_pyproject
    assert host.read_bytes() == original_host
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_consumer_reads_reject_links_invalid_utf8_and_oversized_input(tmp_path: Path) -> None:
    regular = tmp_path / "regular"
    regular.write_text("content", encoding="utf-8")
    hardlink = tmp_path / "hardlink"
    os.link(regular, hardlink)
    symlink = tmp_path / "symlink"
    symlink.symlink_to(regular)
    invalid = tmp_path / "invalid"
    invalid.write_bytes(b"\xff")
    oversized = tmp_path / "oversized"
    oversized.write_bytes(b"x" * (authority.MAX_CONSUMER_BYTES + 1))

    for path in (regular, hardlink, symlink):
        with pytest.raises(authority.AuthorityError, match="^consumer_unsafe$"):
            authority._consumer_snapshot(path)
    with pytest.raises(authority.AuthorityError, match="^consumer_invalid_utf8$"):
        authority._consumer_snapshot(invalid)
    with pytest.raises(authority.AuthorityError, match="^consumer_too_large$"):
        authority._consumer_snapshot(oversized)
