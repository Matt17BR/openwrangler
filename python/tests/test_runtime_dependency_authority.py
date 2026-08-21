from __future__ import annotations

import copy
import importlib
import importlib.metadata
import json
import os
import stat
import struct
import subprocess
import sys
import types
import zipfile
from pathlib import Path
from typing import Any

import pytest
import tomllib
from pip._vendor.packaging.specifiers import SpecifierSet
from pip._vendor.packaging.utils import canonicalize_name
from pip._vendor.packaging.version import Version
from scripts import python_runtime_dependency_authority as authority

from openwrangler_runtime import dependency_guard
from openwrangler_runtime.session import SessionManager

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
        (_inside_prerelease(minimum), False),
        (_inside_development_release(minimum), False),
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
            assert (
                specifier.contains(
                    Version(version),
                    prereleases=specifier.prereleases is True,
                )
                is supported
            )
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
        {
            **descriptor,
            "installSpec": f"{distribution}>={minimum}rc1,<{maximum}",
            "minimumVersion": f"{minimum}rc1",
        },
        {
            **descriptor,
            "installSpec": f"{distribution}>={minimum},<{maximum}.dev1",
            "maximumVersionExclusive": f"{maximum}.dev1",
        },
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

    prerelease_qualification = copy.deepcopy(baseline)
    prerelease_qualification["dependencies"][0]["qualification"]["qualifiedVersions"][-1] = "1.43.3rc1"
    malformed.append((prerelease_qualification, "invalid_authority_qualification"))

    development_qualification = copy.deepcopy(baseline)
    development_qualification["dependencies"][0]["qualification"]["qualifiedVersions"][-1] = "1.43.3.dev1"
    malformed.append((development_qualification, "invalid_authority_qualification"))

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
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_json$"):
        authority.load_authority(recursive)

    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b" " * (authority.MAX_AUTHORITY_BYTES + 1))
    with pytest.raises(authority.AuthorityError, match="^authority_too_large$"):
        authority.load_authority(oversized)


@pytest.mark.parametrize("failure", [RecursionError, MemoryError, ValueError])
def test_parser_resource_failures_are_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException]
) -> None:
    path = _write_authority(tmp_path / "authority.json", _authority_json())

    def raise_failure(*_args: Any, **_kwargs: Any) -> Any:
        raise failure

    monkeypatch.setattr(authority.json, "loads", raise_failure)
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_json$"):
        authority.load_authority(path)


def test_json_structure_text_and_number_budgets_precede_full_decode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    candidates = (
        b"[" + b",".join(b"0" for _ in range(authority.MAX_AUTHORITY_JSON_NODES + 1)) + b"]",
        b'"' + b"x" * (authority.MAX_AUTHORITY_JSON_STRING_BYTES + 1) + b'"',
        b"["
        + b",".join(b'"' + b"x" * 1_024 + b'"' for _ in range(authority.MAX_AUTHORITY_JSON_TEXT_BYTES // 1_024 + 1))
        + b"]",
        b'{"schemaVersion":' + b"9" * (authority.MAX_AUTHORITY_JSON_NUMBER_BYTES + 1) + b',"dependencies":[]}',
    )

    def unexpected_decode(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("json.loads must not receive over-budget input")

    monkeypatch.setattr(authority.json, "loads", unexpected_decode)
    for index, raw in enumerate(candidates):
        candidate = tmp_path / f"hostile-{index}.json"
        candidate.write_bytes(raw)
        with pytest.raises(authority.AuthorityError, match="^invalid_authority_json$"):
            authority.load_authority(candidate)


def test_deep_valid_json_has_a_stable_bounded_failure_taxonomy(
    tmp_path: Path,
) -> None:
    near_limit = tmp_path / "near-limit.json"
    near_limit.write_bytes(b"[" * authority.MAX_AUTHORITY_JSON_DEPTH + b"0" + b"]" * authority.MAX_AUTHORITY_JSON_DEPTH)
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_shape$"):
        authority.load_authority(near_limit)

    over_limit = tmp_path / "over-limit.json"
    over_limit.write_bytes(
        b"[" * (authority.MAX_AUTHORITY_JSON_DEPTH + 1) + b"0" + b"]" * (authority.MAX_AUTHORITY_JSON_DEPTH + 1)
    )
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_json$"):
        authority.load_authority(over_limit)


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
        ("1!2.4.dev1", False),
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


@pytest.mark.parametrize("version", ["1.0rc1", "1.0.dev1"])
def test_exact_prerelease_and_development_versions_are_rejected(tmp_path: Path, version: str) -> None:
    value = _authority_json()
    entry = copy.deepcopy(value["dependencies"][0])
    entry.update(
        {
            "id": "example",
            "importModule": "example",
            "distribution": "example",
            "exactVersion": version,
            "minimumVersion": None,
            "maximumVersionExclusive": None,
            "pyprojectGroup": "runtime",
            "qualification": {
                "cohortKind": "exact",
                "minimumStatus": "qualified",
                "qualifiedVersions": [version],
            },
        }
    )
    value["dependencies"] = [entry]
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_version$"):
        authority.load_authority(_write_authority(tmp_path / "explicit.json", value))


@pytest.mark.parametrize(
    ("field", "version"),
    [
        ("minimumVersion", "1.35.2rc1"),
        ("maximumVersionExclusive", "2.dev1"),
    ],
)
def test_prerelease_and_development_range_bounds_are_rejected(
    tmp_path: Path,
    field: str,
    version: str,
) -> None:
    value = _authority_json()
    value["dependencies"][0][field] = version
    with pytest.raises(authority.AuthorityError, match="^invalid_authority_version$"):
        authority.load_authority(_write_authority(tmp_path / "prerelease-bound.json", value))


def _write_probe_workbook(path: Path) -> Path:
    members = {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',  # noqa: E501
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',  # noqa: E501
        "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',  # noqa: E501
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',  # noqa: E501
        "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2"><v>7</v></c></row></sheetData></worksheet>',  # noqa: E501
    }
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, contents in members.items():
            archive.writestr(name, contents)
    return path


def _probe_xls_bytes() -> bytes:
    free_sector = 0xFFFFFFFF
    end_of_chain = 0xFFFFFFFE
    fat_sector = 0xFFFFFFFD
    no_stream = 0xFFFFFFFF

    def record(identifier: int, data: bytes) -> bytes:
        return struct.pack("<HH", identifier, len(data)) + data

    globals_bof = record(
        0x0809,
        struct.pack("<HHHHII", 0x0600, 0x0005, 0x0DBB, 0x07CC, 0x41, 0x06),
    )
    sheet_name = b"Probe"
    boundsheet_size = 8 + len(sheet_name)
    worksheet_offset = len(globals_bof) + 4 + boundsheet_size + 4
    boundsheet = record(
        0x0085,
        struct.pack("<IBBBB", worksheet_offset, 0, 0, len(sheet_name), 0) + sheet_name,
    )
    worksheet = b"".join(
        (
            record(
                0x0809,
                struct.pack("<HHHHII", 0x0600, 0x0010, 0x0DBB, 0x07CC, 0x41, 0x06),
            ),
            record(0x0200, struct.pack("<IIHHH", 0, 2, 0, 1, 0)),
            record(0x0203, struct.pack("<HHHd", 0, 0, 0, 5.0)),
            record(0x0203, struct.pack("<HHHd", 1, 0, 0, 7.0)),
            record(0x000A, b""),
        )
    )
    workbook = globals_bof + boundsheet + record(0x000A, b"") + worksheet
    workbook = workbook.ljust(4096, b"\x00")

    def directory_entry(
        name: str,
        object_type: int,
        child: int,
        start_sector: int,
        stream_size: int,
    ) -> bytes:
        encoded_name = name.encode("utf-16le") + b"\x00\x00"
        return struct.pack(
            "<64sHBBIII16sIQQIQ",
            encoded_name.ljust(64, b"\x00"),
            len(encoded_name),
            object_type,
            1,
            no_stream,
            no_stream,
            child,
            b"\x00" * 16,
            0,
            0,
            0,
            start_sector,
            stream_size,
        )

    directory = b"".join(
        (
            directory_entry("Root Entry", 5, 1, end_of_chain, 0),
            directory_entry("Workbook", 2, no_stream, 1, len(workbook)),
            b"\x00" * 128,
            b"\x00" * 128,
        )
    )
    fat = [free_sector] * 128
    fat[0] = end_of_chain
    for sector in range(1, 8):
        fat[sector] = sector + 1
    fat[8] = end_of_chain
    fat[9] = fat_sector
    header = struct.pack(
        "<8s16sHHHHH6sIIIIIIIII",
        bytes.fromhex("D0CF11E0A1B11AE1"),
        b"\x00" * 16,
        0x003E,
        0x0003,
        0xFFFE,
        9,
        6,
        b"\x00" * 6,
        0,
        1,
        0,
        0,
        4096,
        end_of_chain,
        0,
        end_of_chain,
        0,
    ) + struct.pack("<109I", 9, *([free_sector] * 108))
    result = header + directory + workbook + struct.pack("<128I", *fat)
    assert len(result) == 5632
    return result


def _write_probe_xls(path: Path) -> Path:
    path.write_bytes(_probe_xls_bytes())
    return path


def _import_qualified_module(dependency: authority.Dependency, version: str) -> Any:
    distribution = importlib.metadata.distribution(dependency.distribution)
    if Version(distribution.version) != Version(version):
        raise AssertionError("qualified_distribution_version_mismatch")
    files = distribution.files
    if files is None:
        raise AssertionError("qualified_distribution_files_missing")
    module = importlib.import_module(dependency.import_module)
    if not dependency_guard._distribution_owns_module(distribution, module):
        raise AssertionError("qualified_module_not_distribution_owned")
    root_module = dependency.import_module.partition(".")[0]
    owners = importlib.metadata.packages_distributions().get(root_module, ())
    if canonicalize_name(dependency.distribution) not in {canonicalize_name(owner) for owner in owners}:
        raise AssertionError("qualified_module_distribution_mapping_mismatch")
    return module


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
                        "column": {"id": column["id"], "name": column["name"]},
                        "newName": "qualified_value",
                    },
                },
                0,
                10,
            )
            assert any(item["name"] == "qualified_value" for item in preview["metadata"]["schema"])
            namespace: dict[str, Any] = {}
            exec(compile(preview["code"], f"<qualified-{backend}>", "exec"), namespace)
            pandas_module = importlib.import_module("pandas")
            if backend == "pandas":
                native = pandas_module.DataFrame({"value": [1, 2], "label": ["a", "b"]})
            elif backend == "polars":
                polars_module = importlib.import_module("polars")
                native = polars_module.DataFrame({"value": [1, 2], "label": ["a", "b"]})
            else:
                duckdb_module = importlib.import_module("duckdb")
                native = duckdb_module.sql("SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS source(value, label)")
            generated = namespace["clean_data"](native)
            assert list(generated.columns) == ["qualified_value", "label"]
            applied = manager.apply_draft(session_id, 1, 0, 10)
            assert applied["revision"] == 2
            assert applied["page"]["totalRows"] == 2
        finally:
            manager.close_session(session_id, 0)


def _exercise_dependency(dependency: authority.Dependency, module: Any, tmp_path: Path) -> None:
    workbook_path = _write_probe_workbook(tmp_path / "qualified.xlsx")
    legacy_workbook_path = _write_probe_xls(tmp_path / "qualified.xls")
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
        memory_path = "/openwrangler-authority-probe"
        filesystem.pipe(memory_path, b"qualified")
        assert filesystem.cat(memory_path) == b"qualified"
        filesystem.rm(memory_path)
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
        loaded = module.load_workbook(workbook_path, read_only=True)
        try:
            assert loaded.active["A2"].value == 7
        finally:
            loaded.close()
        return
    if dependency.identifier == "xlrd":
        workbook = module.open_workbook(legacy_workbook_path)
        assert workbook.sheet_names() == ["Probe"]
        sheet = workbook.sheet_by_index(0)
        assert (sheet.nrows, sheet.ncols) == (2, 1)
        assert sheet.cell_value(1, 0) == 7.0
        manager = SessionManager()
        opened = manager.open_session(
            {
                "kind": "file",
                "label": legacy_workbook_path.name,
                "path": str(legacy_workbook_path),
            },
            backend="pandas",
            page_size=10,
        )
        session_id = opened["metadata"]["sessionId"]
        try:
            assert opened["page"]["totalRows"] == 1
        finally:
            manager.close_session(session_id, 0)
        return
    if dependency.identifier == "ipython":
        transformer = module.core.inputtransformer2.TransformerManager()
        assert transformer.transform_cell("value = 1") == "value = 1\n"
        return
    assert dependency.identifier == "fastexcel"
    fast_workbook = module.read_excel(workbook_path)
    fast_sheet = fast_workbook.load_sheet(0)
    assert (fast_sheet.height, fast_sheet.width) == (1, 1)


def test_installed_dependencies_exercise_the_probe_contract(tmp_path: Path) -> None:
    for dependency in authority.load_authority():
        module = pytest.importorskip(dependency.import_module)
        _exercise_dependency(dependency, module, tmp_path)


def test_generated_cohort_job_maps_every_exact_qualification_once() -> None:
    dependencies = authority.load_authority()
    expected = tuple(
        (dependency.identifier, version, f"{dependency.distribution}=={version}")
        for dependency in dependencies
        for version in dependency.qualified_versions
    )
    rendered = authority._render_workflow(dependencies)
    assert rendered.count("          - id: ") == len(expected)
    assert 'python -m pip install -e "python[dev]" "${{ matrix.requirement }}"' in rendered
    assert "PYTHONPATH:" not in rendered
    for identifier, version, requirement in expected:
        row = (
            f"          - id: {json.dumps(identifier)}\n"
            f"            version: {json.dumps(version)}\n"
            f"            requirement: {json.dumps(requirement)}"
        )
        assert rendered.count(row) == 1
    assert {version for identifier, version, _requirement in expected if identifier == "pandas"} == {"2.3.3", "3.0.5"}
    assert all(
        not Version(version).is_prerelease and not Version(version).is_devrelease
        for _identifier, version, _requirement in expected
    )
    workflow = authority.WORKFLOW_PATH.read_text(encoding="utf-8")
    assert f"{authority.WORKFLOW_START}\n{rendered}\n{authority.WORKFLOW_END}" in workflow


def test_exact_qualified_dependency_probe(tmp_path: Path) -> None:
    identifier = os.environ.get("OPENWRANGLER_QUALIFIED_DEPENDENCY_ID")
    version = os.environ.get("OPENWRANGLER_QUALIFIED_DEPENDENCY_VERSION")
    if identifier is None and version is None:
        pytest.skip("workflow-only exact-version qualification probe")
    assert identifier is not None and version is not None
    matches = tuple(dependency for dependency in authority.load_authority() if dependency.identifier == identifier)
    assert len(matches) == 1
    dependency = matches[0]
    assert version in dependency.qualified_versions
    assert not Version(version).is_prerelease
    assert not Version(version).is_devrelease
    module = _import_qualified_module(dependency, version)
    _exercise_dependency(dependency, module, tmp_path)
    _exercise_openwrangler_runtime(tmp_path)


def test_qualified_module_binding_rejects_local_source_shadowing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
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
        with pytest.raises(AssertionError, match="^qualified_module_not_distribution_owned$"):
            _import_qualified_module(dependency, observed_version)
    finally:
        for name in tuple(sys.modules):
            if name == "fsspec" or name.startswith("fsspec."):
                sys.modules.pop(name, None)
        sys.modules.update(saved_modules)


def test_distribution_module_ownership_rejects_ambiguous_import_identities(
    tmp_path: Path,
) -> None:
    regular = tmp_path / "owned_module.py"
    regular.write_text("VALUE = 1\n", encoding="utf-8")

    def module_for(path: Path) -> Any:
        specification = types.SimpleNamespace(origin=str(path), loader=object())
        return types.SimpleNamespace(__file__=str(path), __spec__=specification)

    def distribution_for(path: Path, callback: Any | None = None) -> Any:
        def locate_file(_item: Any) -> Path:
            if callback is not None:
                callback()
            return path

        return types.SimpleNamespace(files=(path.name,), locate_file=locate_file)

    regular_module = module_for(regular)
    assert dependency_guard._distribution_owns_module(distribution_for(regular), regular_module)

    if os.name != "nt":
        symlink = tmp_path / "symlink_module.py"
        symlink.symlink_to(regular)
        assert not dependency_guard._distribution_owns_module(distribution_for(symlink), module_for(symlink))

        real_package = tmp_path / "real_package"
        real_package.mkdir()
        package_module = real_package / "__init__.py"
        package_module.write_text("VALUE = 5\n", encoding="utf-8")
        linked_package = tmp_path / "linked_package"
        linked_package.symlink_to(real_package, target_is_directory=True)
        linked_module = linked_package / "__init__.py"
        assert not dependency_guard._distribution_owns_module(
            distribution_for(linked_module), module_for(linked_module)
        )

    hardlink_source = tmp_path / "hardlink_source.py"
    hardlink_source.write_text("VALUE = 2\n", encoding="utf-8")
    hardlink = tmp_path / "hardlink_module.py"
    os.link(hardlink_source, hardlink)
    assert not dependency_guard._distribution_owns_module(distribution_for(hardlink), module_for(hardlink))

    namespace_module = types.SimpleNamespace(
        __file__=None,
        __spec__=types.SimpleNamespace(origin=None, loader=None),
    )
    assert not dependency_guard._distribution_owns_module(
        types.SimpleNamespace(files=("namespace/data.txt",)),
        namespace_module,
    )

    archive = tmp_path / "modules.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("archived_module.py", "VALUE = 3\n")
    archived_origin = Path(f"{archive}/archived_module.py")
    assert not dependency_guard._distribution_owns_module(
        distribution_for(archived_origin), module_for(archived_origin)
    )

    changed = module_for(regular)
    alternate = tmp_path / "alternate_module.py"
    alternate.write_text("VALUE = 4\n", encoding="utf-8")

    def change_import_path() -> None:
        changed.__file__ = str(alternate)

    assert not dependency_guard._distribution_owns_module(distribution_for(regular, change_import_path), changed)


def test_qualified_probe_exercises_all_runtime_engines(tmp_path: Path) -> None:
    _exercise_openwrangler_runtime(tmp_path)


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
    workflow = tmp_path / "cross-platform.yml"
    pyproject.write_text(
        authority.PYPROJECT_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    host.write_text(
        authority.HOST_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    workflow.write_bytes(authority.WORKFLOW_PATH.read_bytes())
    monkeypatch.setattr(authority, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(authority, "HOST_PATH", host)
    monkeypatch.setattr(authority, "WORKFLOW_PATH", workflow)
    return pyproject, host


def test_synchronize_repairs_both_consumers_without_partial_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    assert authority.synchronize(write=False) == (pyproject, host)
    assert authority.synchronize(write=True) == (pyproject, host)
    assert authority.synchronize(write=False) == ()
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_transaction_revalidates_an_initially_current_consumer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    workflow = authority.WORKFLOW_PATH
    original_pyproject = pyproject.read_bytes()
    original_host = host.read_bytes()
    foreign_workflow = workflow.read_bytes() + b"# concurrent workflow owner\n"
    real_exchange = authority._exchange_paths
    drifted = False

    def exchange_then_drift(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal drifted
        displaced = real_exchange(target, replacement, *args, **kwargs)
        if target == pyproject and not drifted:
            drifted = True
            workflow.write_bytes(foreign_workflow)
        return displaced

    monkeypatch.setattr(authority, "_exchange_paths", exchange_then_drift)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == original_pyproject
    assert host.read_bytes() == original_host
    assert workflow.read_bytes() == foreign_workflow
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_atomic_rewrite_rolls_back_the_first_consumer_when_the_second_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path: path.read_bytes() for path in (pyproject, host)}
    real_exchange = authority._exchange_paths
    failed = False

    def fail_second(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal failed
        if target == host and not failed:
            failed = True
            raise authority.AuthorityError("consumer_write_failed")
        return real_exchange(target, replacement, *args, **kwargs)

    monkeypatch.setattr(authority, "_exchange_paths", fail_second)
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
    real_exchange = authority._exchange_paths
    drifted = False

    def exchange_then_drift(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal drifted
        displaced = real_exchange(target, replacement, *args, **kwargs)
        if target == pyproject and not drifted:
            drifted = True
            host.write_bytes(racing_host)
        return displaced

    monkeypatch.setattr(authority, "_exchange_paths", exchange_then_drift)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == original_pyproject
    assert host.read_bytes() == racing_host
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_exchange_restores_a_foreign_post_check_replacement(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    original_host = host.read_bytes()
    foreign_path = tmp_path / "foreign-owner"
    foreign_bytes = b"foreign owner exact bytes\n"
    real_replace = os.replace
    real_exchange = authority._exchange_paths
    raced = False
    foreign_identity: list[tuple[int, int]] = []

    def replace_then_exchange(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal raced
        if target == pyproject and not raced:
            foreign_path.write_bytes(foreign_bytes)
            metadata = foreign_path.stat()
            foreign_identity.append((metadata.st_dev, metadata.st_ino))
            real_replace(foreign_path, target)
            raced = True
        return real_exchange(target, replacement, *args, **kwargs)

    monkeypatch.setattr(authority, "_exchange_paths", replace_then_exchange)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == foreign_bytes
    assert foreign_identity
    assert host.read_bytes() == original_host
    assert not list(tmp_path.glob(".*.openwrangler-*"))
    metadata = pyproject.stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity[0]


def test_completed_consumer_writes_roll_back_on_final_authority_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path: path.read_bytes() for path in (pyproject, host)}
    authority_path = tmp_path / "authority.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    replacement = tmp_path / "replacement-authority.json"
    replacement.write_bytes(authority_path.read_bytes())
    replacement_metadata = replacement.stat()
    replacement_identity = (replacement_metadata.st_dev, replacement_metadata.st_ino)
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)
    real_assert = authority._assert_authority_receipt
    replaced = False

    def replace_after_completed_writes(receipt: authority.AuthorityLockReceipt) -> None:
        nonlocal replaced
        if not replaced and pyproject.read_bytes() != originals[pyproject] and host.read_bytes() != originals[host]:
            os.replace(replacement, authority_path)
            replaced = True
        real_assert(receipt)

    monkeypatch.setattr(authority, "_assert_authority_receipt", replace_after_completed_writes)
    with pytest.raises(authority.AuthorityError, match="^authority_changed$"):
        authority.synchronize(write=True)
    assert replaced
    assert {path: path.read_bytes() for path in (pyproject, host)} == originals
    metadata = authority_path.stat()
    assert (metadata.st_dev, metadata.st_ino) == replacement_identity
    assert not list(tmp_path.glob(".*.openwrangler-*"))


def test_locked_authority_descriptor_prevents_aba_publication(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    authority_path = tmp_path / "authority.json"
    authority_bytes = authority.AUTHORITY_PATH.read_bytes()
    authority_path.write_bytes(authority_bytes)
    alternate_authority = tmp_path / "authority-alternate.json"
    alternate_value = json.loads(authority_path.read_text(encoding="utf-8"))
    fsspec = next(dependency for dependency in alternate_value["dependencies"] if dependency["id"] == "fsspec")
    fsspec["exactVersion"] = "2026.8.0"
    fsspec["qualification"]["qualifiedVersions"] = ["2026.8.0"]
    alternate_authority.write_text(json.dumps(alternate_value, indent=2) + "\n", encoding="utf-8")
    alternate_dependencies = authority.load_authority(alternate_authority)
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)
    path_reparses = 0

    def aba_path_reparse(_path: Path | None = None) -> tuple[authority.Dependency, ...]:
        nonlocal path_reparses
        path_reparses += 1
        return alternate_dependencies

    # This models the vulnerable pathname returning B between two A receipts. A
    # locked write must read its retained A descriptor and never call this seam.
    monkeypatch.setattr(authority, "load_authority", aba_path_reparse)
    assert authority.synchronize(write=True) == (pyproject, host)
    assert path_reparses == 0
    assert b"fsspec==2026.7.0" in pyproject.read_bytes()
    assert b"fsspec==2026.8.0" not in pyproject.read_bytes()
    assert b"fsspec==2026.7.0" in host.read_bytes()
    assert b"fsspec==2026.8.0" not in host.read_bytes()
    assert authority_path.read_bytes() == authority_bytes


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


def test_authority_lock_rejects_symlinks_fifos_and_linked_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.json"
    source.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    symlink = tmp_path / "authority-symlink.json"
    symlink.symlink_to(source)
    linked_source = tmp_path / "linked-source.json"
    linked_source.write_bytes(source.read_bytes())
    hardlink = tmp_path / "authority-hardlink.json"
    os.link(linked_source, hardlink)
    unsafe = [symlink, hardlink]
    if hasattr(os, "mkfifo"):
        fifo = tmp_path / "authority-fifo.json"
        os.mkfifo(fifo)
        unsafe.append(fifo)

    for path in unsafe:
        monkeypatch.setattr(authority, "AUTHORITY_PATH", path)
        with (
            pytest.raises(authority.AuthorityError, match="^authority_unsafe$"),
            authority._authority_write_lock(),
        ):
            pytest.fail("unsafe authority path acquired a lock")


def test_authority_lock_detects_replacement_and_preserves_its_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    authority_path = tmp_path / "authority.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(authority_path.read_bytes())
    replacement_metadata = replacement.stat()
    replacement_identity = (replacement_metadata.st_dev, replacement_metadata.st_ino)
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)

    with (
        pytest.raises(authority.AuthorityError, match="^authority_changed$"),
        authority._authority_write_lock(),
    ):
        os.replace(replacement, authority_path)
        with pytest.raises(authority.AuthorityError, match="^consumer_write_busy$"), authority._authority_write_lock():
            pytest.fail("replacement authority bypassed the path-stable lock")

    metadata = authority_path.stat()
    assert (metadata.st_dev, metadata.st_ino) == replacement_identity


@pytest.mark.skipif(os.name == "nt", reason="POSIX namespace-lock behavior")
def test_authority_parent_replacement_cannot_bypass_the_namespace_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    namespace = tmp_path / "repository"
    parent = namespace / "python"
    parent.mkdir(parents=True)
    authority_path = parent / "runtime-dependencies.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    replacement_parent = namespace / "replacement-python"
    replacement_parent.mkdir()
    replacement_authority = replacement_parent / authority_path.name
    replacement_authority.write_bytes(authority_path.read_bytes())
    replacement_metadata = replacement_authority.stat()
    replacement_identity = (replacement_metadata.st_dev, replacement_metadata.st_ino)
    displaced_parent = namespace / "displaced-python"
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)

    with (
        pytest.raises(authority.AuthorityError, match="^authority_changed$"),
        authority._authority_write_lock(),
    ):
        os.replace(parent, displaced_parent)
        os.replace(replacement_parent, parent)
        with (
            pytest.raises(authority.AuthorityError, match="^consumer_write_busy$"),
            authority._authority_write_lock(),
        ):
            pytest.fail("a replacement parent bypassed the namespace lock")

    metadata = authority_path.stat()
    assert (metadata.st_dev, metadata.st_ino) == replacement_identity


@pytest.mark.skipif(os.name == "nt", reason="POSIX lock cleanup behavior")
def test_authority_lock_cleanup_preserves_primary_and_attempts_every_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    authority_path = tmp_path / "authority.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)
    import fcntl

    real_close = authority.os.close
    real_flock = fcntl.flock
    close_attempts: list[int] = []
    unlock_attempts: list[int] = []
    targets: set[int] = set()

    def close_then_fail(descriptor: int) -> None:
        close_attempts.append(descriptor)
        real_close(descriptor)
        if descriptor in targets:
            raise OSError("bounded-close-failure")

    def unlock_then_fail(descriptor: int, operation: int) -> None:
        real_flock(descriptor, operation)
        if descriptor in targets and operation == fcntl.LOCK_UN:
            unlock_attempts.append(descriptor)
            raise OSError("bounded-unlock-failure")

    with (
        pytest.raises(authority.AuthorityError, match="^consumer_changed$") as captured,
        authority._authority_write_lock() as receipt,
    ):
        targets.update(
            {
                receipt.authority_descriptor,
                receipt.parent_descriptor,
                receipt.namespace_descriptor,
            }
        )
        monkeypatch.setattr(authority.os, "close", close_then_fail)
        monkeypatch.setattr(fcntl, "flock", unlock_then_fail)
        raise authority.AuthorityError("consumer_changed")

    expected = (
        "authority_descriptor_close_failed",
        "parent_descriptor_close_failed",
        "namespace_unlock_failed",
        "namespace_descriptor_close_failed",
    )
    assert captured.value.cleanup_diagnostics == expected
    assert isinstance(captured.value.__cause__, authority.AuthorityError)
    assert str(captured.value.__cause__) == "authority_lock_cleanup_failed"
    assert captured.value.__cause__.cleanup_diagnostics == expected
    assert set(close_attempts) == targets
    assert unlock_attempts == [receipt.namespace_descriptor]


@pytest.mark.skipif(os.name == "nt", reason="POSIX lock cleanup behavior")
def test_authority_lock_aggregates_multiple_close_failures_without_a_primary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    authority_path = tmp_path / "authority.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)
    real_close = authority.os.close
    close_attempts: list[int] = []
    failing: set[int] = set()

    def close_with_two_failures(descriptor: int) -> None:
        close_attempts.append(descriptor)
        real_close(descriptor)
        if descriptor in failing:
            raise OSError("bounded-close-failure")

    with (
        pytest.raises(authority.AuthorityError, match="^authority_lock_cleanup_failed$") as captured,
        authority._authority_write_lock() as receipt,
    ):
        failing.update({receipt.authority_descriptor, receipt.parent_descriptor})
        monkeypatch.setattr(authority.os, "close", close_with_two_failures)

    assert captured.value.cleanup_diagnostics == (
        "authority_descriptor_close_failed",
        "parent_descriptor_close_failed",
    )
    assert close_attempts == [
        receipt.authority_descriptor,
        receipt.parent_descriptor,
        receipt.namespace_descriptor,
    ]


def test_windows_lock_cleanup_closes_pins_before_mutex_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[tuple[str, int]] = []

    class Kernel32:
        @staticmethod
        def ReleaseMutex(handle: Any) -> int:
            events.append(("release", int(handle.value)))
            return 1

        @staticmethod
        def CloseHandle(handle: Any) -> int:
            events.append(("handle-close", int(handle.value)))
            return 1

    monkeypatch.setattr(authority.os, "name", "nt")
    monkeypatch.setattr(
        authority.ctypes,
        "windll",
        types.SimpleNamespace(kernel32=Kernel32()),
        raising=False,
    )
    monkeypatch.setattr(authority.os, "close", lambda descriptor: events.append(("close", descriptor)))

    diagnostics = authority._cleanup_authority_lock_resources(
        mutex_handle=41,
        mutex_acquired=True,
        authority_descriptor=11,
        parent_descriptor=12,
        namespace_descriptor=13,
        namespace_acquired=False,
    )

    assert diagnostics == ()
    assert events == [
        ("close", 11),
        ("close", 12),
        ("close", 13),
        ("release", 41),
        ("handle-close", 41),
    ]


def test_authority_lock_detects_replacement_between_check_and_open(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    authority_path = tmp_path / "authority.json"
    authority_path.write_bytes(authority.AUTHORITY_PATH.read_bytes())
    replacement = tmp_path / "replacement.json"
    replacement.write_bytes(authority_path.read_bytes())
    replacement_metadata = replacement.stat()
    replacement_identity = (replacement_metadata.st_dev, replacement_metadata.st_ino)
    real_open = os.open
    raced = False

    def replace_before_open(
        path: os.PathLike[str] | str,
        flags: int,
        *,
        dir_fd: int | None = None,
    ) -> int:
        nonlocal raced
        if Path(path) in {authority_path, Path(authority_path.name)} and not raced:
            os.replace(replacement, authority_path)
            raced = True
        if dir_fd is None:
            return real_open(path, flags)
        return real_open(path, flags, dir_fd=dir_fd)

    monkeypatch.setattr(authority, "AUTHORITY_PATH", authority_path)
    monkeypatch.setattr(authority.os, "open", replace_before_open)
    with (
        pytest.raises(authority.AuthorityError, match="^authority_changed$"),
        authority._authority_write_lock(),
    ):
        pytest.fail("replaced authority path acquired a lock")
    metadata = authority_path.stat()
    assert (metadata.st_dev, metadata.st_ino) == replacement_identity


def test_stage_failure_preserves_primary_and_attaches_cleanup_fault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    real_fsync = authority.os.fsync
    real_close = authority.os.close
    staged_descriptors: set[int] = set()

    def fail_staged_fsync(descriptor: int) -> None:
        metadata = os.fstat(descriptor)
        if stat.S_ISREG(metadata.st_mode):
            staged_descriptors.add(descriptor)
            raise OSError("bounded-primary-write-failure")
        real_fsync(descriptor)

    def close_with_failure(descriptor: int) -> None:
        real_close(descriptor)
        if descriptor in staged_descriptors:
            raise RuntimeError("bounded-cleanup-close-failure")

    def remove_with_failure(*_args: Any, **_kwargs: Any) -> bool:
        raise RuntimeError("bounded-cleanup-remove-failure")

    monkeypatch.setattr(authority.os, "fsync", fail_staged_fsync)
    monkeypatch.setattr(authority.os, "close", close_with_failure)
    monkeypatch.setattr(authority, "_remove_owned", remove_with_failure)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$") as captured:
        authority._stage_sibling(target, b"generated", 0o644)

    assert captured.value.cleanup_diagnostics == (
        "staged_descriptor_close_failed",
        "staged_cleanup_failed",
    )
    assert isinstance(captured.value.__cause__, authority.AuthorityError)
    assert str(captured.value.__cause__) == "consumer_cleanup_failed"
    assert captured.value.__cause__.cleanup_diagnostics == (
        "staged_descriptor_close_failed",
        "staged_cleanup_failed",
    )
    failures = captured.value.__cause__.cleanup_failures
    assert len(failures) == 2
    assert isinstance(failures[0].__cause__, RuntimeError)
    assert str(failures[0].__cause__) == "bounded-cleanup-close-failure"
    assert isinstance(failures[1].__cause__, RuntimeError)
    assert str(failures[1].__cause__) == "bounded-cleanup-remove-failure"


def test_nested_cleanup_appends_without_replacing_existing_causes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    primary_root = ValueError("bounded-primary-root")
    primary = authority.AuthorityError("consumer_write_failed")
    primary.__cause__ = primary_root
    cleanup_root = RuntimeError("bounded-cleanup-root")
    cleanup_failure = authority.AuthorityError("nested-cleanup-failure")
    cleanup_failure.__cause__ = cleanup_root

    def fail_fsync(_descriptor: int) -> None:
        raise primary

    def fail_remove(*_args: Any, **_kwargs: Any) -> bool:
        raise cleanup_failure

    monkeypatch.setattr(authority.os, "fsync", fail_fsync)
    monkeypatch.setattr(authority, "_remove_owned", fail_remove)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$") as captured:
        authority._stage_sibling(target, b"generated", 0o644)

    assert captured.value is primary
    assert captured.value.__cause__ is primary_root
    aggregate = primary_root.__cause__
    assert isinstance(aggregate, authority.AuthorityError)
    assert str(aggregate) == "consumer_cleanup_failed"
    assert len(aggregate.cleanup_failures) == 1
    nested = aggregate.cleanup_failures[0]
    assert nested.__cause__ is cleanup_failure
    assert cleanup_failure.__cause__ is cleanup_root


def test_primary_transaction_failure_attaches_every_staged_cleanup_fault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path: path.read_bytes() for path in (pyproject, host)}

    def fail_after_staging(
        _snapshots: tuple[authority.ConsumerSnapshot, ...],
        _committed: dict[Path, authority.ConsumerSnapshot],
    ) -> None:
        raise authority.AuthorityError("consumer_changed")

    monkeypatch.setattr(authority, "_assert_consumer_states", fail_after_staging)
    monkeypatch.setattr(authority, "_remove_owned", lambda *_args, **_kwargs: False)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$") as captured:
        authority.synchronize(write=True)

    assert captured.value.cleanup_diagnostics == (
        "staged_cleanup_failed",
        "staged_cleanup_failed",
    )
    assert isinstance(captured.value.__cause__, authority.AuthorityError)
    assert str(captured.value.__cause__) == "consumer_cleanup_failed"
    assert captured.value.__cause__.cleanup_diagnostics == (
        "staged_cleanup_failed",
        "staged_cleanup_failed",
    )
    assert {path: path.read_bytes() for path in (pyproject, host)} == originals


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
    assert len(retained) == 0


def test_failed_stage_cleanup_preserves_a_foreign_temporary_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    created: list[Path] = []
    foreign_identity: list[tuple[int, int]] = []
    real_mkstemp = authority.tempfile.mkstemp

    def tracked_mkstemp(*args: Any, **kwargs: Any) -> tuple[int, str]:
        descriptor, name = real_mkstemp(*args, **kwargs)
        created.append(Path(name))
        return descriptor, name

    def replace_then_fail(_descriptor: int) -> None:
        temporary = created[0]
        temporary.unlink()
        temporary.write_bytes(b"foreign staged bytes\n")
        metadata = temporary.stat()
        foreign_identity.append((metadata.st_dev, metadata.st_ino))
        raise OSError("secret-path-must-not-escape")

    monkeypatch.setattr(authority.tempfile, "mkstemp", tracked_mkstemp)
    monkeypatch.setattr(authority.os, "fsync", replace_then_fail)
    with pytest.raises(authority.AuthorityError, match="^consumer_write_failed$") as captured:
        authority._stage_sibling(target, b"generated", 0o644)
    assert captured.value.cleanup_diagnostics == ("staged_cleanup_failed",)
    assert isinstance(captured.value.__cause__, authority.AuthorityError)
    assert str(captured.value.__cause__) == "consumer_cleanup_failed"
    assert created[0].read_bytes() == b"foreign staged bytes\n"
    metadata = created[0].stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity[0]


def test_staged_cleanup_preserves_a_foreign_path_identity(tmp_path: Path) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    foreign = tmp_path / "foreign"
    foreign.write_bytes(b"foreign cleanup bytes\n")
    foreign_metadata = foreign.stat()
    foreign_identity = (foreign_metadata.st_dev, foreign_metadata.st_ino)
    os.replace(foreign, staged.path)

    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert staged.path.read_bytes() == b"foreign cleanup bytes\n"
    metadata = staged.path.stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity


def test_staged_cleanup_atomically_claims_before_checking_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    foreign = tmp_path / "foreign"
    foreign.write_bytes(b"foreign cleanup race bytes\n")
    foreign_metadata = foreign.stat()
    foreign_identity = (foreign_metadata.st_dev, foreign_metadata.st_ino)
    real_rename = authority._rename_noreplace
    raced = False

    def replace_before_claim(first: Path, second: Path, *args: Any, **kwargs: Any) -> bool:
        nonlocal raced
        if first == staged.path and not raced:
            raced = True
            os.replace(foreign, staged.path)
        return real_rename(first, second, *args, **kwargs)

    monkeypatch.setattr(authority, "_rename_noreplace", replace_before_claim)
    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert staged.path.read_bytes() == b"foreign cleanup race bytes\n"
    metadata = staged.path.stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity


def test_staged_cleanup_preserves_same_inode_edit_with_restored_mtime(
    tmp_path: Path,
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    before = staged.path.stat()
    with staged.path.open("r+b") as stream:
        stream.write(b"changed!!")
        stream.flush()
        os.fsync(stream.fileno())
    os.utime(
        staged.path,
        ns=(before.st_atime_ns, before.st_mtime_ns),
        follow_symlinks=False,
    )
    changed = staged.path.stat()
    assert changed.st_ino == before.st_ino
    assert changed.st_size == before.st_size
    assert changed.st_mtime_ns == before.st_mtime_ns
    assert changed.st_ctime_ns != before.st_ctime_ns

    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert staged.path.read_bytes() == b"changed!!"
    assert not list(tmp_path.glob(".*.openwrangler-dispose-*"))


def test_final_unlink_identity_condition_preserves_a_foreign_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    foreign = tmp_path / "foreign"
    foreign.write_bytes(b"foreign replacement bytes\n")
    foreign_identity = (foreign.stat().st_dev, foreign.stat().st_ino)
    real_unlink = authority._consumer_unlink
    replaced = False

    def replace_before_identity_condition(
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        expected_identity: tuple[int, int],
    ) -> bool:
        nonlocal replaced
        if ".openwrangler-dispose-" in path.name and expected_identity is not None and not replaced:
            os.replace(foreign, path)
            replaced = True
        return real_unlink(path, parent_receipt, expected_identity)

    monkeypatch.setattr(authority, "_consumer_unlink", replace_before_identity_condition)
    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert replaced
    assert staged.path.read_bytes() == b"foreign replacement bytes\n"
    metadata = staged.path.stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity
    retained_source = list(tmp_path.glob(".*.openwrangler-source-*"))
    assert len(retained_source) == 1
    assert retained_source[0].read_bytes() == b"generated"


def test_atomic_unlink_claim_preserves_a_replacement_created_after_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    owned = tmp_path / "owned"
    owned.write_bytes(b"owned bytes")
    metadata = owned.stat()
    identity = (metadata.st_dev, metadata.st_ino)
    real_rename = authority._rename_noreplace
    replacement_identity: tuple[int, int] | None = None

    def replace_after_claim(
        first: Path,
        second: Path,
        *args: Any,
        **kwargs: Any,
    ) -> bool:
        nonlocal replacement_identity
        renamed = real_rename(first, second, *args, **kwargs)
        if first == owned and ".openwrangler-unlink-" in second.name and renamed:
            replacement = tmp_path / "replacement"
            replacement.write_bytes(b"foreign replacement")
            replacement_metadata = replacement.stat()
            replacement_identity = (
                replacement_metadata.st_dev,
                replacement_metadata.st_ino,
            )
            os.replace(replacement, owned)
        return renamed

    monkeypatch.setattr(authority, "_rename_noreplace", replace_after_claim)
    assert authority._consumer_unlink(owned, None, identity)
    assert owned.read_bytes() == b"foreign replacement"
    current = owned.stat()
    assert (current.st_dev, current.st_ino) == replacement_identity
    assert not list(tmp_path.glob(".*.openwrangler-unlink-*"))


@pytest.mark.parametrize(
    ("replacement_marker", "expected_prefix"),
    ((".openwrangler-source-", "source"), (".openwrangler-recovery-", "recovery")),
)
def test_paired_final_claims_preserve_a_foreign_replacement_and_exact_copy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    replacement_marker: str,
    expected_prefix: str,
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    foreign = tmp_path / f"foreign-{expected_prefix}"
    foreign.write_bytes(f"foreign {expected_prefix} bytes".encode())
    identity = (foreign.stat().st_dev, foreign.stat().st_ino)
    real_claim = authority._claim_consumer_for_unlink
    replaced_path: Path | None = None

    def replace_selected_leaf(
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        expected_identity: tuple[int, int],
    ) -> authority.ConsumerUnlinkClaim | None:
        nonlocal replaced_path
        if replacement_marker in path.name and "-stage-" not in path.name and replaced_path is None:
            os.replace(foreign, path)
            replaced_path = path
        return real_claim(path, parent_receipt, expected_identity)

    monkeypatch.setattr(authority, "_claim_consumer_for_unlink", replace_selected_leaf)
    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert replaced_path is not None
    assert replaced_path.read_bytes() == f"foreign {expected_prefix} bytes".encode()
    metadata = replaced_path.stat()
    assert (metadata.st_dev, metadata.st_ino) == identity
    retained = [
        path for path in tmp_path.glob(".*.openwrangler-*") if "-stage-" not in path.name and path != replaced_path
    ]
    assert any(path.read_bytes() == b"generated" for path in retained)


@pytest.mark.parametrize("failure", ("create", "partial_write", "fsync", "reopen", "verify"))
def test_recovery_failures_retain_the_exact_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    source = tmp_path / "retained-source"
    source.write_bytes(b"changed!!")
    source.chmod(0o644)
    descriptor = authority._open_cleanup_descriptor(source, None)
    snapshot = authority._descriptor_snapshot(descriptor, source, None, allowed_links=frozenset({1}))
    stage_descriptors: set[int] = set()
    real_open = authority._consumer_open
    real_write = authority.os.write
    real_fsync = authority.os.fsync
    real_cleanup_open = authority._open_cleanup_descriptor
    real_snapshot = authority._descriptor_snapshot

    def tracked_open(
        path: Path,
        flags: int,
        parent_receipt: authority.ConsumerParentReceipt | None,
        mode: int | None = None,
    ) -> int:
        if failure == "create" and ".openwrangler-recovery-stage-" in path.name:
            raise OSError("bounded-create-failure")
        opened = real_open(path, flags, parent_receipt, mode)
        if ".openwrangler-recovery-stage-" in path.name:
            stage_descriptors.add(opened)
        return opened

    partial_written = False

    def write_with_failure(opened: int, payload: bytes) -> int:
        nonlocal partial_written
        if failure == "partial_write" and opened in stage_descriptors:
            if not partial_written:
                partial_written = True
                return real_write(opened, payload[:3])
            raise OSError("bounded-write-failure")
        return real_write(opened, payload)

    def fsync_with_failure(opened: int) -> None:
        if failure == "fsync" and opened in stage_descriptors:
            raise OSError("bounded-fsync-failure")
        real_fsync(opened)

    def reopen_with_failure(
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        *,
        allowed_links: frozenset[int] = frozenset({1}),
    ) -> int:
        if failure == "reopen" and ".openwrangler-recovery-" in path.name and "-stage-" not in path.name:
            raise authority.AuthorityError("consumer_changed")
        return real_cleanup_open(path, parent_receipt, allowed_links=allowed_links)

    verified_once = False

    def verify_with_failure(
        opened: int,
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        *,
        allowed_links: frozenset[int] | None = None,
    ) -> authority.ConsumerSnapshot:
        nonlocal verified_once
        if (
            failure == "verify"
            and ".openwrangler-recovery-" in path.name
            and "-stage-" not in path.name
            and not verified_once
        ):
            verified_once = True
            raise authority.AuthorityError("consumer_changed")
        return real_snapshot(opened, path, parent_receipt, allowed_links=allowed_links)

    monkeypatch.setattr(authority, "_consumer_open", tracked_open)
    monkeypatch.setattr(authority.os, "write", write_with_failure)
    monkeypatch.setattr(authority.os, "fsync", fsync_with_failure)
    monkeypatch.setattr(authority, "_open_cleanup_descriptor", reopen_with_failure)
    monkeypatch.setattr(authority, "_descriptor_snapshot", verify_with_failure)
    try:
        with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
            authority._publish_recovery_receipt(tmp_path / "consumer", snapshot, None)
    finally:
        os.close(descriptor)

    assert source.read_bytes() == b"changed!!"
    assert stat.S_IMODE(source.stat().st_mode) == 0o644
    for artifact in tmp_path.glob(".*.openwrangler-recovery-*"):
        assert artifact.is_file()
        assert stat.S_IMODE(artifact.stat().st_mode) == 0o600
        assert b"changed!!".startswith(artifact.read_bytes())


def test_verified_recovery_is_fixed_private(
    tmp_path: Path,
) -> None:
    source = tmp_path / "retained-source"
    source.write_bytes(b"changed!!")
    source.chmod(0o644)
    descriptor = authority._open_cleanup_descriptor(source, None)
    try:
        snapshot = authority._descriptor_snapshot(descriptor, source, None, allowed_links=frozenset({1}))
        recovery = authority._publish_recovery_receipt(tmp_path / "consumer", snapshot, None)
    finally:
        os.close(descriptor)
    assert recovery.raw == b"changed!!"
    assert recovery.path.read_bytes() == b"changed!!"
    assert stat.S_IMODE(recovery.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(source.stat().st_mode) == 0o644


@pytest.mark.skipif(os.name == "nt", reason="POSIX nonblocking leaf opens")
def test_cleanup_descriptor_rejects_fifo_and_device_leaves(tmp_path: Path) -> None:
    fifo = tmp_path / "consumer-fifo"
    os.mkfifo(fifo)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority._open_cleanup_descriptor(fifo, None)

    regular = tmp_path / "regular"
    regular.write_bytes(b"owned")
    linked = tmp_path / "linked"
    os.link(regular, linked)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority._open_cleanup_descriptor(regular, None)

    symlink = tmp_path / "symlink"
    symlink.symlink_to(regular)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority._open_cleanup_descriptor(symlink, None)

    device = Path("/dev/null")
    if device.exists():
        with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
            authority._open_cleanup_descriptor(device, None)


def test_staged_cleanup_retains_a_same_inode_postcheck_unlink_race(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    real_unlink = authority._consumer_unlink
    raced = False
    raced_identity: tuple[int, int] | None = None

    def edit_through_retained_writer(
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        expected_identity: tuple[int, int],
    ) -> bool:
        nonlocal raced, raced_identity
        if ".openwrangler-dispose-" not in path.name or raced:
            return real_unlink(path, parent_receipt, expected_identity)
        writer = os.open(path, os.O_RDWR)
        try:
            before = os.fstat(writer)
            removed = real_unlink(path, parent_receipt, expected_identity)
            assert removed
            os.lseek(writer, 0, os.SEEK_SET)
            assert os.write(writer, b"changed!!") == len(b"changed!!")
            os.fsync(writer)
            changed = os.fstat(writer)
            raced = True
            raced_identity = (changed.st_dev, changed.st_ino)
            assert changed.st_ino == before.st_ino
            assert changed.st_size == before.st_size
            return removed
        finally:
            os.close(writer)

    monkeypatch.setattr(authority, "_consumer_unlink", edit_through_retained_writer)
    with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
        authority._remove_staged(iter((staged,)))

    assert raced
    assert raced_identity is not None
    assert not staged.path.exists()
    assert not [path for path in tmp_path.glob(".*.openwrangler-dispose-*") if ".openwrangler-source-" not in path.name]
    recovery = list(tmp_path.glob(".*.openwrangler-recovery-*"))
    assert len(recovery) == 1
    assert recovery[0].read_bytes() == b"changed!!"
    assert stat.S_IMODE(recovery[0].stat().st_mode) == 0o600
    source = list(tmp_path.glob(".*.openwrangler-source-*"))
    assert len(source) == 1
    assert source[0].read_bytes() == b"changed!!"


def test_windows_writer_proof_denies_write_sharing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source"
    source.write_bytes(b"owned")
    metadata = source.stat()
    shares: list[int] = []

    class CreateFile:
        argtypes: list[Any] = []
        restype: Any = None

        def __call__(
            self,
            _path: str,
            _access: int,
            share: int,
            *_args: Any,
        ) -> int:
            shares.append(share)
            return 41

    create_file = CreateFile()
    kernel32 = types.SimpleNamespace(
        CreateFileW=create_file,
        CloseHandle=lambda _handle: 1,
    )
    fake_msvcrt = types.SimpleNamespace(open_osfhandle=lambda _handle, _flags: os.open(source, os.O_RDONLY))
    monkeypatch.setattr(authority.os, "name", "nt")
    monkeypatch.setattr(
        authority.ctypes,
        "windll",
        types.SimpleNamespace(kernel32=kernel32),
        raising=False,
    )
    monkeypatch.setitem(sys.modules, "msvcrt", fake_msvcrt)

    descriptor = authority._open_windows_writer_proof(
        source,
        None,
        (metadata.st_dev, metadata.st_ino),
    )
    try:
        assert descriptor >= 0
        assert shares == [0x00000001 | 0x00000004]
        assert not shares[0] & 0x00000002
    finally:
        os.close(descriptor)


@pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="Linux file leases provide the no-writer proof",
)
def test_writer_quiescence_retains_both_copies_while_a_writer_is_open(
    tmp_path: Path,
) -> None:
    target = tmp_path / "consumer"
    target.write_text("original", encoding="utf-8")
    staged = authority._stage_sibling(target, b"generated", 0o644)
    writer = os.open(staged.path, os.O_RDWR)
    try:
        with pytest.raises(authority.AuthorityError, match="^consumer_cleanup_failed$"):
            authority._remove_staged(iter((staged,)))
        source = list(tmp_path.glob(".*.openwrangler-source-*"))
        recovery = [path for path in tmp_path.glob(".*.openwrangler-recovery-*") if "-stage-" not in path.name]
        assert len(source) == 1
        assert len(recovery) == 1
        assert source[0].read_bytes() == b"generated"
        assert recovery[0].read_bytes() == b"generated"
        os.lseek(writer, 0, os.SEEK_SET)
        assert os.write(writer, b"changed!!") == len(b"changed!!")
        os.fsync(writer)
        assert source[0].read_bytes() == b"changed!!"
        assert recovery[0].read_bytes() == b"generated"
    finally:
        os.close(writer)


def test_post_commit_cleanup_fault_has_an_explicit_committed_outcome(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    originals = {path.read_bytes() for path in (pyproject, host)}
    real_unlink = authority._consumer_unlink
    failed = False

    def fail_one_owned_unlink(
        path: Path,
        parent_receipt: authority.ConsumerParentReceipt | None,
        expected_identity: tuple[int, int],
    ) -> bool:
        nonlocal failed
        if ".openwrangler-dispose-" in path.name and not failed:
            failed = True
            raise OSError("bounded-test-unlink-failure")
        return real_unlink(path, parent_receipt, expected_identity)

    monkeypatch.setattr(authority, "_consumer_unlink", fail_one_owned_unlink)
    with pytest.raises(
        authority.CommittedWithCleanupFault,
        match="^consumer_committed_with_cleanup_fault$",
    ) as captured:
        authority.synchronize(write=True)

    assert failed
    assert captured.value.committed_paths == (pyproject, host)
    assert captured.value.cleanup_diagnostics == ("staged_cleanup_failed",)
    assert isinstance(captured.value.__cause__, authority.AuthorityError)
    assert str(captured.value.__cause__) == "consumer_cleanup_failed"
    assert authority.synchronize(write=False) == ()
    retained = list(tmp_path.glob(".*.openwrangler-dispose-*"))
    assert len(retained) == 2
    assert {path.read_bytes() for path in retained} <= originals
    assert len({(path.stat().st_dev, path.stat().st_ino) for path in retained}) == 1


def test_rollback_does_not_overwrite_a_concurrently_changed_committed_consumer(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    original_pyproject = pyproject.read_bytes()
    original_identity = (pyproject.stat().st_dev, pyproject.stat().st_ino)
    original_host = host.read_bytes()
    concurrent_pyproject = b"concurrent owner bytes\n"
    real_exchange = authority._exchange_paths
    failed = False

    def race_then_fail(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal failed
        if target == host and not failed:
            failed = True
            pyproject.write_bytes(concurrent_pyproject)
            raise authority.AuthorityError("consumer_write_failed")
        return real_exchange(target, replacement, *args, **kwargs)

    monkeypatch.setattr(authority, "_exchange_paths", race_then_fail)
    with pytest.raises(authority.AuthorityError, match="^consumer_rollback_failed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == concurrent_pyproject
    assert host.read_bytes() == original_host
    retained = list(tmp_path.glob(".*.openwrangler-*"))
    assert len(retained) == 1
    assert retained[0].read_bytes() == original_pyproject
    assert (retained[0].stat().st_dev, retained[0].stat().st_ino) == original_identity


def test_rollback_exchange_preserves_a_foreign_post_check_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pyproject, host = _temporary_consumers(tmp_path, monkeypatch)
    original_pyproject = pyproject.read_bytes()
    original_metadata = pyproject.stat()
    original_identity = (original_metadata.st_dev, original_metadata.st_ino)
    original_host = host.read_bytes()
    foreign_bytes = b"foreign rollback bytes\n"
    foreign_identity: list[tuple[int, int]] = []
    foreign_path = tmp_path / "foreign-rollback"
    real_exchange = authority._exchange_paths
    calls = 0

    def race_rollback_exchange(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal calls
        calls += 1
        if target == host and calls == 2:
            raise authority.AuthorityError("consumer_write_failed")
        if target == pyproject and calls == 3:
            foreign_path.write_bytes(foreign_bytes)
            metadata = foreign_path.stat()
            foreign_identity.append((metadata.st_dev, metadata.st_ino))
            os.replace(foreign_path, pyproject)
        return real_exchange(target, replacement, *args, **kwargs)

    monkeypatch.setattr(authority, "_exchange_paths", race_rollback_exchange)
    with pytest.raises(authority.AuthorityError, match="^consumer_rollback_failed$"):
        authority.synchronize(write=True)
    assert pyproject.read_bytes() == foreign_bytes
    metadata = pyproject.stat()
    assert (metadata.st_dev, metadata.st_ino) == foreign_identity[0]
    assert host.read_bytes() == original_host
    retained = list(tmp_path.glob(".*.openwrangler-*"))
    assert len(retained) == 1
    assert retained[0].read_bytes() == original_pyproject
    assert (retained[0].stat().st_dev, retained[0].stat().st_ino) == original_identity


@pytest.mark.skipif(os.name == "nt", reason="POSIX descriptor-relative namespace behavior")
def test_consumer_parent_replacement_preserves_the_foreign_namespace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parent = tmp_path / "consumers"
    parent.mkdir()
    pyproject = parent / "pyproject.toml"
    host = parent / "pythonEnvironmentModel.ts"
    workflow = parent / "cross-platform.yml"
    pyproject.write_text(
        authority.PYPROJECT_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    host.write_text(
        authority.HOST_PATH.read_text(encoding="utf-8").replace("polars>=1.35.2,<2", "polars>=0,<1", 1),
        encoding="utf-8",
    )
    workflow.write_bytes(authority.WORKFLOW_PATH.read_bytes())
    originals = {path.name: path.read_bytes() for path in (pyproject, host, workflow)}
    monkeypatch.setattr(authority, "PYPROJECT_PATH", pyproject)
    monkeypatch.setattr(authority, "HOST_PATH", host)
    monkeypatch.setattr(authority, "WORKFLOW_PATH", workflow)

    displaced = tmp_path / "displaced-consumers"
    foreign = {path.name: f"foreign {path.name}\n".encode() for path in (pyproject, host, workflow)}
    real_exchange = authority._exchange_paths
    swapped = False

    def exchange_then_swap_parent(target: Path, replacement: Path, *args: Any, **kwargs: Any) -> Path:
        nonlocal swapped
        result = real_exchange(target, replacement, *args, **kwargs)
        if not swapped:
            swapped = True
            os.replace(parent, displaced)
            parent.mkdir()
            for name, raw in foreign.items():
                (parent / name).write_bytes(raw)
        return result

    monkeypatch.setattr(authority, "_exchange_paths", exchange_then_swap_parent)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority.synchronize(write=True)

    assert swapped
    for name, raw in foreign.items():
        assert (parent / name).read_bytes() == raw
    for name, raw in originals.items():
        assert (displaced / name).read_bytes() == raw
    assert not list(parent.glob(".*.openwrangler-*"))
    assert not list(displaced.glob(".*.openwrangler-*"))


def test_consumer_snapshot_revalidates_the_named_path_after_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    consumer = tmp_path / "consumer"
    consumer.write_bytes(b"owned bytes\n")
    replacement = tmp_path / "replacement"
    replacement.write_bytes(b"foreign exact bytes\n")
    replacement_metadata = replacement.stat()
    replacement_identity = (replacement_metadata.st_dev, replacement_metadata.st_ino)
    real_read = authority.os.read
    raced = False

    def replace_after_read(descriptor: int, size: int) -> bytes:
        nonlocal raced
        chunk = real_read(descriptor, size)
        if not chunk and not raced:
            raced = True
            os.replace(replacement, consumer)
        return chunk

    monkeypatch.setattr(authority.os, "read", replace_after_read)
    with pytest.raises(authority.AuthorityError, match="^consumer_changed$"):
        authority._consumer_snapshot(consumer)
    metadata = consumer.stat()
    assert (metadata.st_dev, metadata.st_ino) == replacement_identity
    assert consumer.read_bytes() == b"foreign exact bytes\n"


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
