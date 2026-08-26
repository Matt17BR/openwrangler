from __future__ import annotations

import copy
import importlib
import importlib.metadata
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import Version
from scripts import python_runtime_dependency_authority as authority

from openwrangler_runtime import dependency_guard
from openwrangler_runtime.session import SessionManager

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised by the Python 3.10 cohort
    from pip._vendor import tomli as tomllib

ROOT = Path(__file__).parents[2]


def _authority_json() -> dict[str, Any]:
    return json.loads(authority.AUTHORITY_PATH.read_text(encoding="utf-8"))


def _write_authority(path: Path, value: Any) -> Path:
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


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
    expected_runtime = [
        install_spec
        for dependency in dependencies
        if dependency.pyproject_group == "runtime"
        for install_spec in dependency.pyproject_install_specs
    ]
    expected_development = [
        install_spec
        for dependency in dependencies
        if dependency.pyproject_group == "dev"
        for install_spec in dependency.pyproject_install_specs
    ]
    assert metadata["project"]["dependencies"] == expected_runtime
    for install_spec in expected_development:
        assert metadata["project"]["optional-dependencies"]["dev"].count(install_spec) == 1

    host = authority.HOST_PATH.read_text(encoding="utf-8")
    assert f"{authority.HOST_START}\n{authority._render_host(dependencies)}\n{authority.HOST_END}" in host
    workflow = authority.WORKFLOW_PATH.read_text(encoding="utf-8")
    assert (
        f"{authority.WORKFLOW_START}\n{authority._render_workflow(dependencies)}\n{authority.WORKFLOW_END}" in workflow
    )


def test_authority_rejects_bad_ranges_qualification_and_duplicate_names(
    tmp_path: Path,
) -> None:
    baseline = _authority_json()
    invalid: list[tuple[dict[str, Any], str]] = []

    reversed_range = copy.deepcopy(baseline)
    reversed_range["dependencies"][0]["minimumVersion"] = "2"
    invalid.append((reversed_range, "invalid_authority_range"))

    unbounded = copy.deepcopy(baseline)
    unbounded["dependencies"][0]["maximumVersionExclusive"] = None
    invalid.append((unbounded, "unbounded_authority_range"))

    unqualified_minimum = copy.deepcopy(baseline)
    unqualified_minimum["dependencies"][0]["minimumVersion"] = "1.35.1"
    invalid.append((unqualified_minimum, "invalid_authority_qualification"))

    unsupported_python = copy.deepcopy(baseline)
    unsupported_python["dependencies"][0]["qualification"]["qualifiedCases"][0]["pythonVersion"] = "3.15"
    invalid.append((unsupported_python, "invalid_authority_qualification"))

    prerelease = copy.deepcopy(baseline)
    prerelease["dependencies"][0]["qualification"]["qualifiedCases"][0]["version"] = "1.35.2rc1"
    invalid.append((prerelease, "invalid_authority_qualification"))

    duplicate = copy.deepcopy(baseline)
    alias = copy.deepcopy(duplicate["dependencies"][0])
    alias["id"] = "polars_alias"
    alias["importModule"] = "polars_alias"
    alias["distribution"] = "PoLaRs"
    duplicate["dependencies"].append(alias)
    invalid.append((duplicate, "duplicate_authority_dependency"))

    bad_compatibility = copy.deepcopy(baseline)
    ipython = next(entry for entry in bad_compatibility["dependencies"] if entry["id"] == "ipython")
    ipython["pythonCompatibility"]["qualifiedCase"]["version"] = "8.39.1"
    invalid.append((bad_compatibility, "invalid_authority_compatibility"))

    for index, (value, code) in enumerate(invalid):
        with pytest.raises(authority.AuthorityError, match=f"^{code}$"):
            authority.load_authority(_write_authority(tmp_path / f"invalid-{index}.json", value))


def test_authority_input_is_small_valid_unique_json(tmp_path: Path) -> None:
    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(
        '{"schemaVersion":1,"schemaVersion":1,"dependencies":[]}',
        encoding="utf-8",
    )
    with pytest.raises(authority.AuthorityError, match="^duplicate_authority_key$"):
        authority.load_authority(duplicate)

    malformed = tmp_path / "malformed.json"
    malformed.write_text("[" * 20_000 + "0" + "]" * 20_000, encoding="utf-8")
    with pytest.raises(authority.AuthorityError):
        authority.load_authority(malformed)

    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b" " * (authority.MAX_AUTHORITY_BYTES + 1))
    with pytest.raises(authority.AuthorityError, match="^authority_too_large$"):
        authority.load_authority(oversized)


def test_version_fields_share_the_runtime_guard_boundary(tmp_path: Path) -> None:
    contract = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))
    assert contract["maximumVersionLength"] == authority.VERSION_FIELD_MAX_LENGTH
    assert contract["maximumVersionLength"] == dependency_guard.VERSION_FIELD_MAX_LENGTH

    for length, accepted in ((64, True), (65, False)):
        version = "1+" + "a" * (length - 2)
        value = _authority_json()
        entry = copy.deepcopy(value["dependencies"][0])
        entry.update(
            {
                "id": "version_boundary",
                "importModule": "version_boundary",
                "distribution": "version-boundary",
                "exactVersion": version,
                "minimumVersion": None,
                "maximumVersionExclusive": None,
                "qualification": {
                    "cohortKind": "exact",
                    "minimumStatus": "qualified",
                    "qualifiedCases": [{"pythonVersion": "3.12", "version": version}],
                },
            }
        )
        value["dependencies"] = [entry]
        path = _write_authority(tmp_path / f"version-{length}.json", value)
        descriptor = {
            "importModule": "version_boundary",
            "distribution": "version-boundary",
            "installSpec": f"version-boundary=={version}",
            "exactVersion": version,
            "minimumVersion": None,
            "maximumVersionExclusive": None,
        }
        if accepted:
            dependency = authority.load_authority(path)[0]
            assert dependency_guard._normalize_dependency(descriptor, code="invalid_request") == descriptor
            assert dependency.install_spec in authority._render_pyproject((dependency,), "runtime")
        else:
            with pytest.raises(authority.AuthorityError, match="^invalid_authority_text$"):
                authority.load_authority(path)
            with pytest.raises(dependency_guard.GuardError, match="^invalid_request$"):
                dependency_guard._normalize_dependency(descriptor, code="invalid_request")


def test_python_310_uses_the_qualified_ipython_branch() -> None:
    metadata = tomllib.loads(authority.PYPROJECT_PATH.read_text(encoding="utf-8"))
    assert SpecifierSet(metadata["project"]["requires-python"]).contains(Version("3.10"))
    dependency = next(item for item in authority.load_authority() if item.identifier == "ipython")
    branch = dependency.python_compatibility
    assert branch is not None
    assert branch.python_maximum_version_exclusive == "3.11"
    assert branch.qualified_version == "8.39.0"

    requirements = tuple(Requirement(spec) for spec in dependency.pyproject_install_specs)
    selected_310 = tuple(
        requirement
        for requirement in requirements
        if requirement.marker is not None and requirement.marker.evaluate({"python_version": "3.10"})
    )
    selected_311 = tuple(
        requirement
        for requirement in requirements
        if requirement.marker is not None and requirement.marker.evaluate({"python_version": "3.11"})
    )
    assert len(selected_310) == len(selected_311) == 1
    assert selected_310[0].specifier.contains(Version("8.39.0"))
    assert selected_311[0].specifier.contains(Version("9.15.0"))
    assert not selected_310[0].specifier.contains(Version("9.15.0"))
    assert not selected_311[0].specifier.contains(Version("8.39.0"))


def test_every_descriptor_uses_the_runtime_guard_pep440_rules() -> None:
    for dependency in authority.load_authority():
        descriptor = _guard_descriptor(dependency)
        assert dependency_guard._normalize_dependency(descriptor, code="invalid_request") == descriptor
        if dependency.exact_version is not None:
            supported = (dependency.exact_version,)
            unsupported = ("0",)
        else:
            assert dependency.minimum_version is not None
            assert dependency.maximum_version_exclusive is not None
            supported = (
                dependency.minimum_version,
                dependency.qualified_versions[-1],
            )
            unsupported = (
                f"{dependency.minimum_version}rc1",
                dependency.maximum_version_exclusive,
            )
        for version in supported:
            assert dependency_guard._dependency_version_supported(descriptor, version)
        for version in unsupported:
            assert not dependency_guard._dependency_version_supported(descriptor, version)


def test_generation_markers_are_exact_ordered_lines() -> None:
    blocks = (
        ("# START ONE", "# END ONE", "new one"),
        ("# START TWO", "# END TWO", "new two"),
    )
    source = "before\n# START ONE\nold one\n# END ONE\nmiddle\n# START TWO\nold two\n# END TWO\nafter\n"
    assert authority._replace_blocks(source, blocks) == (
        "before\n# START ONE\nnew one\n# END ONE\nmiddle\n# START TWO\nnew two\n# END TWO\nafter\n"
    )
    malformed = (
        (source.replace("# START ONE", "prefix # START ONE"), "malformed_generation_marker"),
        (source.replace("# END ONE\n", ""), "missing_generation_marker"),
        (source + "# START ONE\n", "duplicate_generation_marker"),
        (
            "# END ONE\n# START ONE\n# START TWO\n# END TWO\n",
            "reversed_generation_marker",
        ),
        (
            "# START ONE\n# START TWO\n# END TWO\n# END ONE\n",
            "nested_generation_marker",
        ),
    )
    for candidate, code in malformed:
        with pytest.raises(authority.AuthorityError, match=f"^{code}$"):
            authority._replace_blocks(candidate, blocks)


def test_consumer_reads_normalize_windows_line_endings(tmp_path: Path) -> None:
    consumer = tmp_path / "consumer.txt"
    consumer.write_bytes(b"first\r\nsecond\r\n")
    assert authority._read_consumer(consumer) == "first\nsecond\n"

    consumer.write_bytes(b"first\rsecond\n")
    with pytest.raises(authority.AuthorityError, match="^consumer_unsafe$"):
        authority._read_consumer(consumer)


def _temporary_consumers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    pyproject = tmp_path / "pyproject.toml"
    host = tmp_path / "pythonEnvironmentModel.ts"
    workflow = tmp_path / "cross-platform.yml"
    pyproject.write_text(
        authority.PYPROJECT_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    host.write_text(
        authority.HOST_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    workflow.write_text(
        authority.WORKFLOW_PATH.read_text(encoding="utf-8").replace('version: "1.35.2"', 'version: "0.1.0"', 1),
        encoding="utf-8",
    )
    monkeypatch.setattr(authority, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(authority, "HOST_PATH", host)
    monkeypatch.setattr(authority, "WORKFLOW_PATH", workflow)
    return pyproject, host, workflow


def test_write_repairs_each_generated_file_and_check_confirms_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    consumers = _temporary_consumers(tmp_path, monkeypatch)
    assert authority.synchronize(write=False) == consumers
    assert authority.synchronize(write=True) == consumers
    assert authority.synchronize(write=False) == ()
    assert list(tmp_path.glob(".*.tmp")) == []


def test_partial_write_remains_visible_to_the_next_check(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    consumers = _temporary_consumers(tmp_path, monkeypatch)
    real_write = authority._write_consumer
    calls = 0

    def stop_after_first(path: Path, text: str) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise authority.AuthorityError("consumer_write_failed")
        real_write(path, text)

    monkeypatch.setattr(authority, "_write_consumer", stop_after_first)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$"):
        authority.synchronize(write=True)
    assert authority.synchronize(write=False) == consumers[1:]


def _import_qualified_module(dependency: authority.Dependency, version: str) -> Any:
    distribution = importlib.metadata.distribution(dependency.distribution)
    if Version(distribution.version) != Version(version):
        raise AssertionError("qualified_distribution_version_mismatch")
    module = importlib.import_module(dependency.import_module)
    if not dependency_guard._distribution_owns_module(distribution, module):
        raise AssertionError("qualified_module_not_distribution_owned")
    root_module = dependency.import_module.partition(".")[0]
    owners = importlib.metadata.packages_distributions().get(root_module, ())
    canonical_owners = {canonicalize_name(owner) for owner in owners}
    if canonicalize_name(dependency.distribution) not in canonical_owners:
        raise AssertionError("qualified_module_distribution_mapping_mismatch")
    return module


def _write_probe_workbook(path: Path) -> Path:
    openpyxl = importlib.import_module("openpyxl")
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "Probe"
    worksheet.append(["value"])
    worksheet.append([7])
    workbook.save(path)
    workbook.close()
    return path


def _exercise_dependency(dependency: authority.Dependency, module: Any, tmp_path: Path) -> None:
    if dependency.identifier == "pandas":
        assert module.DataFrame({"value": [1, 2]})["value"].sum() == 3
        return
    if dependency.identifier == "polars":
        frame = module.DataFrame({"value": [1, 2]})
        assert frame.select(module.col("value").sum()).item() == 3
        return
    if dependency.identifier == "duckdb":
        connection = module.connect(":memory:")
        try:
            assert connection.execute("SELECT 1 + 2").fetchone() == (3,)
        finally:
            connection.close()
        return
    if dependency.identifier == "fsspec":
        filesystem = module.filesystem("memory")
        path = "/openwrangler-authority-probe"
        filesystem.pipe(path, b"qualified")
        assert filesystem.cat(path) == b"qualified"
        filesystem.rm(path)
        return
    if dependency.identifier == "pytz":
        from datetime import datetime

        localized = module.UTC.localize(datetime(2026, 1, 1))
        assert localized.utcoffset().total_seconds() == 0
        return
    if dependency.identifier == "pyarrow":
        table = module.table({"value": [1, 2]})
        assert table.column("value").to_pylist() == [1, 2]
        return
    if dependency.identifier == "openpyxl":
        path = _write_probe_workbook(tmp_path / "qualified-openpyxl.xlsx")
        workbook = module.load_workbook(path, read_only=True)
        try:
            assert workbook.active["A2"].value == 7
        finally:
            workbook.close()
        return
    if dependency.identifier == "xlrd":
        assert module.xldate_as_tuple(61.0, 0)[:3] == (1900, 3, 1)
        return
    if dependency.identifier == "ipython":
        transformer = module.core.inputtransformer2.TransformerManager()
        assert transformer.transform_cell("value = 1") == "value = 1\n"
        return
    assert dependency.identifier == "fastexcel"
    path = _write_probe_workbook(tmp_path / "qualified-fastexcel.xlsx")
    sheet = module.read_excel(path).load_sheet(0)
    assert (sheet.height, sheet.width) == (1, 1)


def _exercise_openwrangler_runtime(tmp_path: Path) -> None:
    source = tmp_path / "qualified-runtime.csv"
    source.write_text("value,label\n1,a\n2,b\n", encoding="utf-8")
    for backend in ("pandas", "polars", "duckdb"):
        manager = SessionManager()
        opened = manager.open_session(
            {"kind": "file", "label": source.name, "path": str(source)},
            backend=backend,
            page_size=10,
        )
        session_id = opened["metadata"]["sessionId"]
        try:
            column = next(item for item in opened["metadata"]["schema"] if item["name"] == "value")
            preview = manager.preview_step(
                session_id,
                0,
                {
                    "id": "qualified-rename",
                    "kind": "renameColumn",
                    "params": {
                        "column": {
                            "id": column["id"],
                            "name": column["name"],
                        },
                        "newName": "qualified_value",
                    },
                },
                0,
                10,
            )
            assert any(item["name"] == "qualified_value" for item in preview["metadata"]["schema"])
            namespace: dict[str, Any] = {}
            exec(
                compile(preview["code"], f"<qualified-{backend}>", "exec"),
                namespace,
            )
            pandas = importlib.import_module("pandas")
            if backend == "pandas":
                native = pandas.DataFrame({"value": [1, 2], "label": ["a", "b"]})
            elif backend == "polars":
                polars = importlib.import_module("polars")
                native = polars.DataFrame({"value": [1, 2], "label": ["a", "b"]})
            else:
                duckdb = importlib.import_module("duckdb")
                native = duckdb.sql("SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS source(value, label)")
            generated = namespace["clean_data"](native)
            assert list(generated.columns) == ["qualified_value", "label"]
            applied = manager.apply_draft(session_id, 1, 0, 10)
            assert applied["revision"] == 2
            assert applied["page"]["totalRows"] == 2
        finally:
            manager.close_session(session_id, 0)


def test_installed_dependencies_exercise_the_probe_contract(
    tmp_path: Path,
) -> None:
    current_python = Version(".".join(str(part) for part in sys.version_info[:2]))
    for dependency in authority.load_authority():
        module = pytest.importorskip(dependency.import_module)
        branch = dependency.python_compatibility
        if branch is not None and current_python < Version(branch.python_maximum_version_exclusive):
            assert Version(importlib.metadata.version(dependency.distribution)) == Version(branch.qualified_version)
        _exercise_dependency(dependency, module, tmp_path)


def test_generated_cohort_job_maps_each_qualification_once() -> None:
    dependencies = authority.load_authority()
    workflow = authority.WORKFLOW_PATH.read_text(encoding="utf-8")
    expected = tuple(
        (
            dependency.identifier,
            case.python_version,
            case.version,
            f"{dependency.distribution}=={case.version}",
        )
        for dependency in dependencies
        for case in dependency.executable_qualification_cases
    )
    rendered = authority._render_workflow(dependencies, workflow)
    repinned_workflow = re.sub(r"@[0-9a-f]{40}", f"@{'a' * 40}", workflow)
    repinned = authority._render_workflow(dependencies, repinned_workflow)
    assert f"actions/checkout@{'a' * 40}" in repinned
    assert f"actions/setup-python@{'a' * 40}" in repinned
    assert rendered.count("          - id: ") == len(expected)
    expected_install = 'python -m pip install -e "python[dev]" "' + "$" + '{{ matrix.requirement }}"'
    assert expected_install in rendered
    for identifier, python_version, version, requirement in expected:
        row = (
            f"          - id: {json.dumps(identifier)}\n"
            f"            python: {json.dumps(python_version)}\n"
            f"            version: {json.dumps(version)}\n"
            f"            requirement: {json.dumps(requirement)}"
        )
        assert rendered.count(row) == 1
    assert {
        (python_version, version) for identifier, python_version, version, _ in expected if identifier == "ipython"
    } == {
        ("3.10", "8.39.0"),
        ("3.12", "9.15.0"),
        ("3.12", "9.16.1"),
    }
def test_exact_qualified_dependency_probe(tmp_path: Path) -> None:
    identifier = os.environ.get("OPENWRANGLER_QUALIFIED_DEPENDENCY_ID")
    python_version = os.environ.get("OPENWRANGLER_QUALIFIED_PYTHON_VERSION")
    version = os.environ.get("OPENWRANGLER_QUALIFIED_DEPENDENCY_VERSION")
    if identifier is None and python_version is None and version is None:
        pytest.skip("workflow-only exact-version qualification probe")
    assert identifier is not None
    assert python_version is not None
    assert version is not None
    assert python_version == ".".join(str(part) for part in sys.version_info[:2])
    matches = tuple(dependency for dependency in authority.load_authority() if dependency.identifier == identifier)
    assert len(matches) == 1
    dependency = matches[0]
    assert (
        authority.QualificationCase(python_version=python_version, version=version)
        in dependency.executable_qualification_cases
    )
    module = _import_qualified_module(dependency, version)
    _exercise_dependency(dependency, module, tmp_path)
    _exercise_openwrangler_runtime(tmp_path)


def test_qualified_module_binding_rejects_local_shadowing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fsspec")
    dependency = next(item for item in authority.load_authority() if item.identifier == "fsspec")
    observed_version = importlib.metadata.version(dependency.distribution)
    shadow = tmp_path / "shadow"
    shadow.mkdir()
    (shadow / "fsspec.py").write_text("SHADOWED = True\n", encoding="utf-8")
    saved_modules = {
        name: module for name, module in tuple(sys.modules.items()) if name == "fsspec" or name.startswith("fsspec.")
    }
    for name in saved_modules:
        sys.modules.pop(name, None)
    monkeypatch.syspath_prepend(str(shadow))
    importlib.invalidate_caches()
    try:
        with pytest.raises(
            AssertionError,
            match="^qualified_module_not_distribution_owned$",
        ):
            _import_qualified_module(dependency, observed_version)
    finally:
        for name in tuple(sys.modules):
            if name == "fsspec" or name.startswith("fsspec."):
                sys.modules.pop(name, None)
        sys.modules.update(saved_modules)


def test_qualified_probe_exercises_all_runtime_engines(
    tmp_path: Path,
) -> None:
    _exercise_openwrangler_runtime(tmp_path)
