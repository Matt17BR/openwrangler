from __future__ import annotations

import os
import pickle
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import BinaryIO

import pandas as pd
import pytest

from openwrangler_runtime import trusted_pickle_to_parquet as conversion

HELPER = Path(conversion.__file__).resolve()


def source_fingerprint(path: Path) -> conversion.SourceFingerprint:
    return conversion._confirmed_source_path_fingerprint(path)


def file_identity(path: Path) -> tuple[int, int]:
    return conversion._regular_file_identity(path)


def descriptor_identity(descriptor: int) -> tuple[int, int]:
    details = os.fstat(descriptor)
    return (
        conversion._windows_file_identity(descriptor) if sys.platform == "win32" else (details.st_dev, details.st_ino)
    )


def cli_arguments(
    source: Path,
    destination: Path,
    *,
    expected_source_fingerprint: conversion.SourceFingerprint | None = None,
    expected_destination_identity: tuple[int, int] | None = None,
) -> list[str]:
    destination_identity = expected_destination_identity or file_identity(destination)
    fingerprint = expected_source_fingerprint or source_fingerprint(source)
    return [
        str(source),
        str(destination),
        *(str(value) for value in destination_identity),
        *(str(value) for value in fingerprint),
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows file identities are Windows-specific.")
def test_windows_source_fingerprint_matches_node_lstat(tmp_path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is unavailable")
    for name, contents in [("trusted.pkl", b"fixture"), ("reserved.tmp", b"")]:
        path = tmp_path / name
        path.write_bytes(contents)

        result = subprocess.run(
            [
                node,
                "-e",
                "const fs=require('node:fs'); "
                "const s=fs.lstatSync(process.argv[1], {bigint:true}); "
                "process.stdout.write([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join('\\n'))",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )

        node_fingerprint = conversion.SourceFingerprint(*(int(value, 10) for value in result.stdout.splitlines()))
        assert source_fingerprint(path) == node_fingerprint
        assert file_identity(path) == node_fingerprint[:2]


def windows_process_is_running(process_id: int) -> bool:
    if sys.platform != "win32":
        raise RuntimeError("Windows process inspection is available only on Windows.")

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    process_handle = kernel32.OpenProcess(0x1000, False, process_id)
    if not process_handle:
        return False
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(process_handle, ctypes.byref(exit_code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return exit_code.value == 259
    finally:
        kernel32.CloseHandle(process_handle)


def terminate_windows_process(process_id: int) -> None:
    if sys.platform != "win32":
        raise RuntimeError("Windows process termination is available only on Windows.")

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    process_handle = kernel32.OpenProcess(0x0001, False, process_id)
    if not process_handle:
        return
    try:
        kernel32.TerminateProcess(process_handle, 1)
    finally:
        kernel32.CloseHandle(process_handle)


def test_converts_one_dataframe_with_pyarrow_and_preserves_the_source(tmp_path: Path) -> None:
    source = tmp_path / "trusted.pkl"
    destination = tmp_path / "reserved.tmp"
    frame = pd.DataFrame({"name": ["alpha", "beta"], "amount": [1, 2]})
    frame.to_pickle(source)
    destination.touch(mode=0o600)
    source_before = source.read_bytes()

    conversion.convert_trusted_pickle_to_parquet(
        source,
        destination,
        file_identity(destination),
        source_fingerprint(source),
    )

    pd.testing.assert_frame_equal(pd.read_parquet(destination, engine="pyarrow"), frame)
    assert source.read_bytes() == source_before
    assert sorted(path.name for path in tmp_path.iterdir()) == ["reserved.tmp", "trusted.pkl"]


def test_reads_the_pickle_exactly_once_and_requests_pyarrow(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "trusted.pickle"
    destination = tmp_path / "reserved.tmp"
    source.write_bytes(b"fixture")
    destination.touch(mode=0o600)
    frame = pd.DataFrame({"value": [1]})
    reads: list[tuple[bytes, tuple[int, int]]] = []
    writes: list[tuple[tuple[int, int], str | None, bool | None]] = []

    def read_pickle(input_file: BinaryIO) -> pd.DataFrame:
        reads.append((input_file.read(), descriptor_identity(input_file.fileno())))
        return frame

    def to_parquet(
        _frame: pd.DataFrame, output: BinaryIO, *, engine: str | None = None, index: bool | None = None
    ) -> None:
        writes.append((descriptor_identity(output.fileno()), engine, index))
        output.write(b"PAR1fixturePAR1")

    monkeypatch.setattr(pd, "read_pickle", read_pickle)
    monkeypatch.setattr(pd.DataFrame, "to_parquet", to_parquet)

    expected_source_fingerprint = source_fingerprint(source)
    conversion.convert_trusted_pickle_to_parquet(
        source,
        destination,
        file_identity(destination),
        expected_source_fingerprint,
    )

    assert reads == [(b"fixture", expected_source_fingerprint[:2])]
    assert writes == [(file_identity(destination), "pyarrow", False)]


def test_rejects_a_non_dataframe_without_touching_the_reserved_destination(tmp_path: Path) -> None:
    source = tmp_path / "trusted.pkl"
    destination = tmp_path / "reserved.tmp"
    pd.Series(["private-row-value"]).to_pickle(source)
    destination.write_bytes(b"reserved")
    source_before = source.read_bytes()

    with pytest.raises(conversion.NonDataFramePickleError):
        conversion.convert_trusted_pickle_to_parquet(
            source,
            destination,
            file_identity(destination),
            source_fingerprint(source),
        )

    assert source.read_bytes() == source_before
    assert destination.read_bytes() == b"reserved"


def test_cli_reports_a_fixed_non_dataframe_error_without_values(tmp_path: Path) -> None:
    source = tmp_path / "trusted-secret-name.pkl"
    destination = tmp_path / "reserved.tmp"
    pd.Series(["private-row-value"]).to_pickle(source)
    destination.touch(mode=0o600)

    result = subprocess.run(
        [sys.executable, "-I", "-B", "-S", str(HELPER), *cli_arguments(source, destination)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == conversion.EXIT_NON_DATAFRAME
    assert result.stdout == ""
    assert result.stderr == f"{conversion.NON_DATAFRAME_MESSAGE}\n"
    assert "private-row-value" not in result.stderr
    assert source.name not in result.stderr


def test_cli_reports_a_fixed_conversion_error_without_exception_details(tmp_path: Path) -> None:
    source = tmp_path / "trusted-secret-name.pkl"
    destination = tmp_path / "reserved.tmp"
    source.write_bytes(b"not a pickle")
    destination.touch(mode=0o600)

    result = subprocess.run(
        [sys.executable, "-I", "-B", "-S", str(HELPER), *cli_arguments(source, destination)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == conversion.EXIT_CONVERSION_FAILED
    assert result.stdout == ""
    assert result.stderr == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert source.name not in result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects are Windows-specific.")
def test_real_helper_job_kills_a_spawned_pickle_descendant(tmp_path: Path) -> None:
    source = tmp_path / "trusted.pkl"
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    child_marker = tmp_path / "child.pid"
    child_code = (
        "import os, pathlib, sys, time; "
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='ascii'); "
        "time.sleep(120)"
    )
    launcher_code = "\n".join(
        [
            "import os, pathlib, subprocess, sys, time",
            "marker = pathlib.Path(sys.argv[1])",
            f"subprocess.Popen([sys.executable, '-c', {child_code!r}, str(marker)])",
            "deadline = time.monotonic() + 10",
            "while not marker.exists() and time.monotonic() < deadline:",
            "    time.sleep(0.02)",
            "os._exit(0 if marker.exists() else 3)",
        ]
    )

    class SpawnDescendantDuringUnpickle:
        def __reduce__(self) -> tuple[object, tuple[list[str]]]:
            return subprocess.run, ([sys.executable, "-c", launcher_code, str(child_marker)],)

    with source.open("wb") as output:
        pickle.dump(SpawnDescendantDuringUnpickle(), output)

    result = subprocess.run(
        [sys.executable, "-I", "-B", "-S", str(HELPER), *cli_arguments(source, destination)],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == conversion.EXIT_NON_DATAFRAME
    assert result.stdout == ""
    assert result.stderr == f"{conversion.NON_DATAFRAME_MESSAGE}\n"
    assert destination.read_bytes() == b"reserved"
    assert child_marker.is_file()
    child_process_id = int(child_marker.read_text(encoding="ascii"))
    deadline = time.monotonic() + 10
    try:
        while windows_process_is_running(child_process_id) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not windows_process_is_running(child_process_id)
    finally:
        if windows_process_is_running(child_process_id):
            terminate_windows_process(child_process_id)


def test_rejects_a_stale_host_fingerprint_before_unpickling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "trusted-secret-name.pkl"
    source.write_bytes(b"host-approved-payload")
    stale_fingerprint = source_fingerprint(source)
    source.write_bytes(b"private-replacement-with-a-different-size")
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    read_calls = 0

    def read_pickle(_input_file: BinaryIO) -> pd.DataFrame:
        nonlocal read_calls
        read_calls += 1
        return pd.DataFrame()

    monkeypatch.setattr(pd, "read_pickle", read_pickle)

    result = conversion.main(
        cli_arguments(
            source,
            destination,
            expected_source_fingerprint=stale_fingerprint,
        )
    )
    output = capsys.readouterr()

    assert result == conversion.EXIT_CONVERSION_FAILED
    assert output.out == ""
    assert output.err == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert source.name not in output.err
    assert "private-replacement" not in output.err
    assert destination.read_bytes() == b"reserved"
    assert read_calls == 0


def test_rejects_a_replaced_reserved_destination_before_unpickling(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "trusted.pkl"
    source.write_bytes(b"fixture")
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    expected_destination_identity = file_identity(destination)
    original_reservation = tmp_path / "original-reservation.tmp"
    destination.rename(original_reservation)
    destination.write_bytes(b"replacement")
    read_calls = 0

    def read_pickle(_input_file: BinaryIO) -> pd.DataFrame:
        nonlocal read_calls
        read_calls += 1
        return pd.DataFrame()

    monkeypatch.setattr(pd, "read_pickle", read_pickle)

    result = conversion.main(
        cli_arguments(
            source,
            destination,
            expected_destination_identity=expected_destination_identity,
        )
    )
    output = capsys.readouterr()

    assert result == conversion.EXIT_CONVERSION_FAILED
    assert output.out == ""
    assert output.err == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert destination.read_bytes() == b"replacement"
    assert original_reservation.read_bytes() == b"reserved"
    assert read_calls == 0


def test_rejects_same_size_rewrite_with_restored_mtime_before_unpickling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    source = tmp_path / "trusted-secret-name.pkl"
    source.write_bytes(b"approved-payload")
    stale_fingerprint = source_fingerprint(source)
    original_times = source.stat()
    for _ in range(100):
        source.write_bytes(b"modified-payload")
        os.utime(source, ns=(original_times.st_atime_ns, stale_fingerprint.modified_time_ns))
        if source_fingerprint(source).changed_time_ns != stale_fingerprint.changed_time_ns:
            break
        time.sleep(0.001)
    current_fingerprint = source_fingerprint(source)
    assert current_fingerprint.size == stale_fingerprint.size
    assert current_fingerprint.modified_time_ns == stale_fingerprint.modified_time_ns
    assert current_fingerprint.changed_time_ns != stale_fingerprint.changed_time_ns
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    read_calls = 0

    def read_pickle(_input_file: BinaryIO) -> pd.DataFrame:
        nonlocal read_calls
        read_calls += 1
        return pd.DataFrame()

    monkeypatch.setattr(pd, "read_pickle", read_pickle)

    result = conversion.main(
        cli_arguments(
            source,
            destination,
            expected_source_fingerprint=stale_fingerprint,
        )
    )
    output = capsys.readouterr()

    assert result == conversion.EXIT_CONVERSION_FAILED
    assert output.out == ""
    assert output.err == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert destination.read_bytes() == b"reserved"
    assert read_calls == 0


def test_invalid_invocation_has_a_fixed_nonzero_result(capsys: pytest.CaptureFixture[str]) -> None:
    assert conversion.main([]) == conversion.EXIT_INVALID_INVOCATION
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == f"{conversion.INVALID_INVOCATION_MESSAGE}\n"

    assert conversion.main(["source", "destination", "destination-dev", "1", "source-dev", "2", "3", "4", "5"]) == (
        conversion.EXIT_INVALID_INVOCATION
    )
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == f"{conversion.INVALID_INVOCATION_MESSAGE}\n"


@pytest.mark.skipif(sys.platform == "win32", reason="Creating Windows symlinks requires host-specific privileges.")
def test_rejects_symlinks_before_loading_the_pickle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source_target = tmp_path / "source-target.pkl"
    source_target.write_bytes(b"fixture")
    source = tmp_path / "trusted.pkl"
    source.symlink_to(source_target)
    destination = tmp_path / "reserved.tmp"
    destination.touch(mode=0o600)
    read_calls = 0

    def read_pickle(_input_file: BinaryIO) -> pd.DataFrame:
        nonlocal read_calls
        read_calls += 1
        return pd.DataFrame()

    monkeypatch.setattr(pd, "read_pickle", read_pickle)

    with pytest.raises(ValueError, match="regular files only"):
        conversion.convert_trusted_pickle_to_parquet(
            source,
            destination,
            file_identity(destination),
            source_fingerprint(source_target),
        )

    assert read_calls == 0


@pytest.mark.skipif(sys.platform == "win32", reason="Replacing an open file is a POSIX-specific race fixture.")
@pytest.mark.parametrize("replacement_kind", ["symlink", "regular"])
def test_destination_path_replacement_during_unpickle_never_redirects_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replacement_kind: str
) -> None:
    source = tmp_path / "trusted.pkl"
    source.write_bytes(b"fixture")
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    redirect_target = tmp_path / "redirect-target.parquet"
    redirect_target.write_bytes(b"untouched")

    expected_source_fingerprint = source_fingerprint(source)

    def read_pickle(_input_file: BinaryIO) -> pd.DataFrame:
        destination.unlink()
        if replacement_kind == "symlink":
            destination.symlink_to(redirect_target)
        else:
            destination.write_bytes(b"replacement")
        return pd.DataFrame({"value": [1]})

    monkeypatch.setattr(pd, "read_pickle", read_pickle)

    with pytest.raises((RuntimeError, ValueError)):
        conversion.convert_trusted_pickle_to_parquet(
            source,
            destination,
            file_identity(destination),
            expected_source_fingerprint,
        )

    assert redirect_target.read_bytes() == b"untouched"
    if replacement_kind == "regular":
        assert destination.read_bytes() == b"replacement"
    assert source.read_bytes() == b"fixture"


@pytest.mark.skipif(sys.platform == "win32", reason="Replacing an open file is a POSIX-specific race fixture.")
@pytest.mark.parametrize("replacement_kind", ["symlink", "regular"])
def test_source_path_replacement_during_unpickle_fails_without_writing_or_leaking(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    replacement_kind: str,
) -> None:
    approved_payload = b"approved-source-payload"
    private_payload = b"private-replacement-payload"
    source = tmp_path / "trusted-secret-name.pkl"
    source.write_bytes(approved_payload)
    expected_source_fingerprint = source_fingerprint(source)
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    replacement_target = tmp_path / "private-replacement-target.pkl"
    replacement_target.write_bytes(private_payload)
    writes = 0

    def read_pickle(input_file: BinaryIO) -> pd.DataFrame:
        assert input_file.read() == approved_payload
        source.unlink()
        if replacement_kind == "symlink":
            source.symlink_to(replacement_target)
        else:
            source.write_bytes(private_payload)
        return pd.DataFrame({"value": [1]})

    def to_parquet(_frame: pd.DataFrame, _output: BinaryIO, **_kwargs: object) -> None:
        nonlocal writes
        writes += 1

    monkeypatch.setattr(pd, "read_pickle", read_pickle)
    monkeypatch.setattr(pd.DataFrame, "to_parquet", to_parquet)

    result = conversion.main(
        cli_arguments(
            source,
            destination,
            expected_source_fingerprint=expected_source_fingerprint,
        )
    )
    output = capsys.readouterr()

    assert result == conversion.EXIT_CONVERSION_FAILED
    assert output.out == ""
    assert output.err == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert source.name not in output.err
    assert private_payload.decode() not in output.err
    assert destination.read_bytes() == b"reserved"
    assert replacement_target.read_bytes() == private_payload
    if replacement_kind == "regular":
        assert source.read_bytes() == private_payload
    assert writes == 0


@pytest.mark.skipif(sys.platform == "win32", reason="Rewriting an open file is platform-specific.")
def test_source_in_place_rewrite_during_unpickle_fails_without_writing_or_leaking(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    approved_payload = b"approved-source-payload"
    private_payload = b"private-in-place-rewrite-with-a-different-size"
    source = tmp_path / "trusted-secret-name.pkl"
    source.write_bytes(approved_payload)
    expected_source_fingerprint = source_fingerprint(source)
    destination = tmp_path / "reserved.tmp"
    destination.write_bytes(b"reserved")
    writes = 0

    def read_pickle(input_file: BinaryIO) -> pd.DataFrame:
        assert input_file.read() == approved_payload
        source.write_bytes(private_payload)
        return pd.DataFrame({"value": [1]})

    def to_parquet(_frame: pd.DataFrame, _output: BinaryIO, **_kwargs: object) -> None:
        nonlocal writes
        writes += 1

    monkeypatch.setattr(pd, "read_pickle", read_pickle)
    monkeypatch.setattr(pd.DataFrame, "to_parquet", to_parquet)

    result = conversion.main(
        cli_arguments(
            source,
            destination,
            expected_source_fingerprint=expected_source_fingerprint,
        )
    )
    output = capsys.readouterr()

    assert result == conversion.EXIT_CONVERSION_FAILED
    assert output.out == ""
    assert output.err == f"{conversion.CONVERSION_FAILED_MESSAGE}\n"
    assert source.name not in output.err
    assert private_payload.decode() not in output.err
    assert source.read_bytes() == private_payload
    assert destination.read_bytes() == b"reserved"
    assert writes == 0


def test_fsyncs_the_exact_reserved_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "trusted.pkl"
    destination = tmp_path / "reserved.tmp"
    pd.DataFrame({"value": [1]}).to_pickle(source)
    destination.touch(mode=0o600)
    original_fsync = conversion.os.fsync
    fsync_calls: list[int] = []

    def fsync(descriptor: int) -> None:
        fsync_calls.append(descriptor)
        original_fsync(descriptor)

    monkeypatch.setattr(conversion.os, "fsync", fsync)

    conversion.convert_trusted_pickle_to_parquet(
        source,
        destination,
        file_identity(destination),
        source_fingerprint(source),
    )

    assert len(fsync_calls) == 1
