from __future__ import annotations

import importlib
import json
import os
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


@pytest.fixture
def probe_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, object]:
    root = tmp_path / "selected-environment"
    root.mkdir()
    executable = root / "python"
    executable.write_bytes(b"unexecuted fixture image")
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setattr(sys, "prefix", str(root))
    return dependency_guard._actual_environment()


@pytest.mark.parametrize("existing_journal", [False, True])
def test_probe_preserves_partial_result_order_without_touching_installation_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    probe_environment: dict[str, object],
    existing_journal: bool,
) -> None:
    dependency = exact_dependency()
    _install_owned_distribution(tmp_path, monkeypatch, dependency, "2026.7.0")
    journal = Path(str(probe_environment["packageRoot"])) / dependency_guard.JOURNAL_NAME
    retained = journal / "retained-state"
    if existing_journal:
        journal.mkdir()
        retained.write_bytes(b"unchanged recovery state")
    missing = {**dependency, "importModule": "ow_missing", "distribution": "ow-missing"}
    last = {**missing, "importModule": "ow_missing_last", "distribution": "ow-missing-last"}
    frames: list[dict[str, object]] = []
    monkeypatch.setattr(dependency_guard, "_emit", frames.append)
    monkeypatch.setattr(dependency_guard, "_run_pip", lambda *_args: pytest.fail("Discovery attempted installation"))
    request = dependency_guard._normalize_request(
        "probe",
        {
            "protocol": dependency_guard.PROTOCOL,
            "kind": "probe",
            "environment": probe_environment,
            "dependencies": [missing, dependency, last],
        },
    )
    assert dependency_guard._run_probe(request) == 0
    assert frames == [{"protocol": dependency_guard.PROTOCOL, "kind": "probe", "supported": [False, True, False]}]
    assert journal.exists() is existing_journal
    if existing_journal:
        assert list(journal.iterdir()) == [retained]
        assert retained.read_bytes() == b"unchanged recovery state"


@pytest.mark.parametrize("replacement_time", ["before", "during-import"])
def test_probe_refuses_a_changed_environment_before_publishing_availability(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    probe_environment: dict[str, object],
    replacement_time: str,
) -> None:
    dependency = exact_dependency()
    metadata = _install_owned_distribution(tmp_path, monkeypatch, dependency, "2026.7.0")
    executable = Path(str(probe_environment["executable"]))
    module = metadata.parent.parent / f"{dependency['importModule']}.py"
    if replacement_time == "before":
        executable.write_bytes(b"changed fixture image")
    else:
        module.write_text(
            f"from pathlib import Path\nPath({str(executable)!r}).write_bytes(b'changed fixture image')\n",
            encoding="utf-8",
        )
    frames: list[dict[str, object]] = []
    monkeypatch.setattr(dependency_guard, "_emit", frames.append)
    with pytest.raises(dependency_guard.GuardError, match="environment_changed"):
        request = dependency_guard._normalize_request(
            "probe",
            {
                "protocol": dependency_guard.PROTOCOL,
                "kind": "probe",
                "environment": probe_environment,
                "dependencies": [dependency],
            },
        )
        dependency_guard._run_probe(request)
    assert executable.read_bytes() == b"changed fixture image"
    assert frames == []
    assert not (Path(str(probe_environment["packageRoot"])) / dependency_guard.JOURNAL_NAME).exists()


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


@pytest.mark.parametrize("hard_linked", [False, True], ids=["copy", "hardlink"])
def test_exact_dependency_validation_uses_pep440_equality(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    hard_linked: bool,
) -> None:
    dependency = exact_dependency()
    metadata = _install_owned_distribution(tmp_path, monkeypatch, dependency, "2026.7.0")
    if hard_linked:
        module_path = metadata.parent.parent / f"{dependency['importModule']}.py"
        (tmp_path / "cached-module.py").hardlink_to(module_path)
        assert module_path.stat().st_nlink == 2
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


@pytest.mark.skipif(os.name == "nt", reason="POSIX module identity reads use descriptor-relative open")
def test_dependency_validation_rejects_link_change_during_module_identity_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dependency = exact_dependency()
    metadata = _install_owned_distribution(tmp_path, monkeypatch, dependency, "2026.7.0")
    module_path = metadata.parent.parent / f"{dependency['importModule']}.py"
    (tmp_path / "cached-module.py").hardlink_to(module_path)
    original_open = os.open
    changed = False

    def open_with_link_change(path: str, flags: int, *, dir_fd: int | None = None) -> int:
        nonlocal changed
        descriptor = original_open(path, flags, dir_fd=dir_fd)
        if path == module_path.name and not changed:
            (tmp_path / "new-alias.py").hardlink_to(module_path)
            changed = True
        return descriptor

    monkeypatch.setattr(os, "open", open_with_link_change)
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([dependency])
    assert changed
    assert module_path.stat().st_nlink == 3


@pytest.mark.skipif(os.name == "nt", reason="POSIX ancestor rechecks use descriptor-relative stat")
def test_module_identity_rechecks_leaf_after_ancestors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parent = tmp_path / "module-directory"
    parent.mkdir()
    module = parent / "module.py"
    module.write_bytes(b"VALUE = 1\n")
    original_stat = os.stat
    observations = 0

    def stat_with_late_write(path, *args, **kwargs):
        nonlocal observations
        observed = original_stat(path, *args, **kwargs)
        if path == parent.name and kwargs.get("dir_fd") is not None:
            observations += 1
            if observations == 2:
                module.write_bytes(b"VALUE = 222\n")
        return observed

    monkeypatch.setattr(os, "stat", stat_with_late_write)
    assert dependency_guard._regular_module_file_identity(str(module)) is None
    assert observations == 2
    assert module.read_bytes() == b"VALUE = 222\n"


@pytest.mark.parametrize("replace_ancestor", [False, True], ids=["sibling", "replaced-ancestor"])
def test_module_identity_distinguishes_directory_contents_from_replacement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    replace_ancestor: bool,
) -> None:
    parent = tmp_path / "module-directory"
    parent.mkdir()
    module = parent / "module.py"
    module.write_bytes(b"VALUE = 1\n")
    before = module.stat()
    directory_before = parent.stat()
    changed = False

    def mutate() -> None:
        nonlocal changed
        changed = True
        if replace_ancestor:
            parent.rename(tmp_path / "moved-directory")
            parent.mkdir()
            module.write_bytes(b"VALUE = 2\n")
        else:
            (parent / "sibling").mkdir()
            os.utime(parent, ns=(directory_before.st_atime_ns, directory_before.st_mtime_ns + 2_000_000_000))
            assert parent.stat().st_mtime_ns != directory_before.st_mtime_ns

    original_open = os.open

    def open_with_mutation(path: str, flags: int, *, dir_fd: int | None = None) -> int:
        descriptor = original_open(path, flags, dir_fd=dir_fd)
        if path == module.name and not changed:
            mutate()
        return descriptor

    def trace(frame, event, _arg):
        if (
            event == "line"
            and frame.f_code is dependency_guard._windows_regular_module_file_identity.__code__
            and frame.f_locals.get("is_file")
            and not changed
        ):
            mutate()
        return trace

    previous_trace = sys.gettrace()
    if os.name == "nt":
        sys.settrace(trace)
    else:
        monkeypatch.setattr(os, "open", open_with_mutation)
    try:
        observed = dependency_guard._regular_module_file_identity(str(module))
    finally:
        sys.settrace(previous_trace)
    assert changed
    if replace_ancestor:
        assert observed is None
        assert parent.stat().st_ino != directory_before.st_ino
    else:
        assert observed is not None
        assert dependency_guard._stat_entry_identity(module.stat()) == dependency_guard._stat_entry_identity(before)
        assert module.read_bytes() == b"VALUE = 1\n"


def test_dependency_validation_fails_closed_without_pep440_authority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    probe_environment: dict[str, object],
) -> None:
    dependency = json.loads((ROOT / "fixtures" / "dependency-version-contract.json").read_text(encoding="utf-8"))[
        "dependency"
    ]
    _install_owned_distribution(tmp_path, monkeypatch, dependency, "1.5.4")
    monkeypatch.setattr(dependency_guard, "_pep440_specifier", lambda _specifier: (_ for _ in ()).throw(ImportError()))
    with pytest.raises(dependency_guard.GuardError, match="validation_failed"):
        dependency_guard._validate_dependencies([dependency])
    frames: list[dict[str, object]] = []
    monkeypatch.setattr(dependency_guard, "_emit", frames.append)
    request = dependency_guard._normalize_request(
        "probe",
        {
            "protocol": dependency_guard.PROTOCOL,
            "kind": "probe",
            "environment": probe_environment,
            "dependencies": [dependency],
        },
    )
    assert dependency_guard._run_probe(request) == 0
    assert frames == [{"protocol": dependency_guard.PROTOCOL, "kind": "probe", "supported": [False]}]
    assert not (Path(str(probe_environment["packageRoot"])) / dependency_guard.JOURNAL_NAME).exists()
