from __future__ import annotations

import ctypes
import os
import sys
from pathlib import Path

import pytest

from openwrangler_runtime.export_target import (
    ExportTarget,
    ExportTargetError,
    ExportWriterPath,
    _add_cleanup_note,
    _regular_file_identity,
)
from openwrangler_runtime.windows_file_handle import (
    FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_LIST_DIRECTORY,
    FILE_READ_DATA,
    FILE_SHARE_READ,
    FILE_SHARE_WRITE,
    GENERIC_READ,
    GENERIC_WRITE,
    OPEN_EXISTING,
    WindowsFileHandleCleanupError,
    WindowsFileHandleValidationError,
    WindowsPinnedExportTarget,
)
from openwrangler_runtime.windows_file_handle import (
    _raise_with_cleanup as _raise_with_windows_cleanup,
)

TARGET_IDENTITY = (29, (7 << 32) | 11)
PARENT_IDENTITY = (29, (5 << 32) | 3)


class FakeKernel32:
    def __init__(self) -> None:
        self.next_handle = 100
        self.create_calls: list[tuple[object, ...]] = []
        self.close_calls: list[int] = []
        self.handles: dict[int, tuple[bool, tuple[int, int], int]] = {}
        self.target_identity: tuple[int, int] = TARGET_IDENTITY
        self.parent_identity: tuple[int, int] = PARENT_IDENTITY
        self.target_attributes = 0
        self.parent_attributes = FILE_ATTRIBUTE_DIRECTORY
        self.target_links = 1
        self.file_type = 1
        self.failed_closes: set[int] = set()

    def CreateFileW(self, *args: object) -> int:
        self.create_calls.append(args)
        assert isinstance(args[5], int)
        flags = args[5]
        directory = bool(flags & FILE_FLAG_BACKUP_SEMANTICS)
        identity = self.parent_identity if directory else self.target_identity
        attributes = self.parent_attributes if directory else self.target_attributes
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = (directory, identity, attributes)
        return handle

    def GetFileType(self, handle: int) -> int:
        assert handle in self.handles
        return self.file_type

    def GetFileInformationByHandle(self, handle: int, information_pointer: object) -> bool:
        directory, identity, attributes = self.handles[handle]
        information = information_pointer._obj  # type: ignore[attr-defined]
        information.file_attributes = attributes
        information.number_of_links = 1 if directory else self.target_links
        information.volume_serial_number = identity[0]
        information.file_index_high = identity[1] >> 32
        information.file_index_low = identity[1] & 0xFFFFFFFF
        return True

    def CloseHandle(self, handle: int) -> bool:
        self.close_calls.append(handle)
        return handle not in self.failed_closes


def open_fake_pin(kernel32: FakeKernel32, path: Path | None = None) -> WindowsPinnedExportTarget:
    return WindowsPinnedExportTarget.open(
        path or Path("C:/reserved/.cleaned.csv.host.tmp"),
        TARGET_IDENTITY,
        kernel32=kernel32,
        get_osfhandle=lambda descriptor: descriptor,
        open_osfhandle=lambda handle, _flags: handle,
    )


def test_windows_pins_parent_then_target_with_minimal_read_no_delete_sharing() -> None:
    kernel32 = FakeKernel32()

    pinned = open_fake_pin(kernel32)

    assert len(kernel32.create_calls) == 4
    for index, call in enumerate(kernel32.create_calls):
        _path, desired_access, sharing, security_pointer, creation, flags, template = call
        assert desired_access == (FILE_LIST_DIRECTORY if index % 2 == 0 else FILE_READ_DATA)
        assert sharing == FILE_SHARE_READ | FILE_SHARE_WRITE
        assert creation == OPEN_EXISTING
        assert flags == (
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT
            if index % 2 == 0
            else FILE_FLAG_OPEN_REPARSE_POINT
        )
        assert template is None
        security = security_pointer._obj  # type: ignore[attr-defined]
        assert security.length == ctypes.sizeof(type(security))
        assert security.security_descriptor is None
        assert security.inherit_handle == 0

    assert kernel32.close_calls == [102, 103]
    pinned.close()
    assert kernel32.close_calls == [102, 103, 101, 100]
    pinned.close()
    assert kernel32.close_calls == [102, 103, 101, 100]


@pytest.mark.parametrize(
    ("parent_attributes", "target_attributes", "links"),
    [
        (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY, 0, 1),
        (FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, 1),
        (FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_DIRECTORY, 1),
        (FILE_ATTRIBUTE_DIRECTORY, 0, 2),
    ],
)
def test_windows_pins_reject_reparse_wrong_type_and_hardlinked_targets(
    parent_attributes: int,
    target_attributes: int,
    links: int,
) -> None:
    kernel32 = FakeKernel32()
    kernel32.parent_attributes = parent_attributes
    kernel32.target_attributes = target_attributes
    kernel32.target_links = links

    with pytest.raises(WindowsFileHandleValidationError):
        open_fake_pin(kernel32)

    assert len(kernel32.close_calls) == len(set(kernel32.close_calls))


def test_windows_pins_reject_non_disk_handles() -> None:
    kernel32 = FakeKernel32()
    kernel32.file_type = 0

    with pytest.raises(WindowsFileHandleValidationError, match="disk filesystem"):
        open_fake_pin(kernel32)

    assert kernel32.close_calls == [100]


def test_windows_pin_detects_named_target_and_parent_identity_drift() -> None:
    kernel32 = FakeKernel32()
    pinned = open_fake_pin(kernel32)

    kernel32.target_identity = (29, TARGET_IDENTITY[1] + 1)
    with pytest.raises(WindowsFileHandleValidationError, match="target path"):
        pinned.assert_unchanged()

    kernel32.target_identity = TARGET_IDENTITY
    kernel32.parent_identity = (29, PARENT_IDENTITY[1] + 1)
    with pytest.raises(WindowsFileHandleValidationError, match="parent path"):
        pinned.assert_unchanged()

    pinned.close()


def test_windows_pin_detects_retained_target_identity_drift() -> None:
    kernel32 = FakeKernel32()
    pinned = open_fake_pin(kernel32)
    directory, _identity, attributes = kernel32.handles[pinned.target_handle]
    kernel32.handles[pinned.target_handle] = (directory, (29, TARGET_IDENTITY[1] + 1), attributes)

    with pytest.raises(WindowsFileHandleValidationError, match="target identity"):
        pinned.assert_unchanged()

    pinned.close()


def test_windows_pin_syncs_identity_matched_descriptor_while_raw_pins_remain(tmp_path) -> None:
    path = tmp_path / "host-reserved.csv"
    path.touch()
    kernel32 = FakeKernel32()
    descriptor_handles: dict[int, int] = {}

    def open_osfhandle(handle: int, _flags: int) -> int:
        descriptor = os.open(path, os.O_RDWR)
        descriptor_handles[descriptor] = handle
        return descriptor

    pinned = WindowsPinnedExportTarget.open(
        path,
        TARGET_IDENTITY,
        kernel32=kernel32,
        get_osfhandle=descriptor_handles.__getitem__,
        open_osfhandle=open_osfhandle,
    )
    retained_parent = pinned.parent_handle
    retained_target = pinned.target_handle

    pinned.sync()

    sync_call = kernel32.create_calls[-3]
    assert sync_call[1] == GENERIC_READ | GENERIC_WRITE
    assert sync_call[2] == FILE_SHARE_READ | FILE_SHARE_WRITE
    assert retained_target not in kernel32.close_calls
    assert retained_parent not in kernel32.close_calls
    pinned.close()
    assert kernel32.close_calls[-2:] == [retained_target, retained_parent]


@pytest.mark.parametrize("fsync_fails", [False, True])
def test_windows_pin_sync_close_causality(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fsync_fails: bool,
) -> None:
    kernel32 = FakeKernel32()
    pinned = open_fake_pin(kernel32, tmp_path / "host-reserved.csv")
    monkeypatch.setattr("openwrangler_runtime.windows_file_handle._open_regular_file_descriptor", lambda *_args: 73)
    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.descriptor_identity",
        lambda *_args, **_kwargs: TARGET_IDENTITY,
    )

    def fsync(_descriptor: int) -> None:
        if fsync_fails:
            raise RuntimeError("fsync failed")

    monkeypatch.setattr("openwrangler_runtime.windows_file_handle.os.fsync", fsync)
    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.os.close",
        lambda _descriptor: (_ for _ in ()).throw(OSError("descriptor cleanup failed")),
    )

    expected = RuntimeError if fsync_fails else OSError
    message = "fsync failed" if fsync_fails else "descriptor cleanup failed"
    with pytest.raises(expected, match=message) as raised:
        pinned.sync()

    if fsync_fails:
        assert isinstance(raised.value.__cause__, OSError)
        assert str(raised.value.__cause__) == "descriptor cleanup failed"
    pinned.close()


def test_windows_pin_closes_target_then_parent_once_and_reports_all_cleanup_errors() -> None:
    kernel32 = FakeKernel32()
    pinned = open_fake_pin(kernel32)
    kernel32.failed_closes = {pinned.target_handle, pinned.parent_handle}

    with pytest.raises(WindowsFileHandleCleanupError) as raised:
        pinned.close()

    assert len(raised.value.errors) == 2
    assert kernel32.close_calls[-2:] == [101, 100]
    pinned.close()
    assert kernel32.close_calls[-2:] == [101, 100]


def test_windows_pin_validation_failure_remains_primary_when_both_raw_closes_fail() -> None:
    kernel32 = FakeKernel32()
    kernel32.target_attributes = FILE_ATTRIBUTE_REPARSE_POINT
    kernel32.failed_closes = {100, 101}

    with pytest.raises(WindowsFileHandleValidationError) as raised:
        open_fake_pin(kernel32)

    assert isinstance(raised.value.__cause__, WindowsFileHandleCleanupError)
    assert len(raised.value.__cause__.errors) == 2
    assert kernel32.close_calls == [101, 100]


def test_windows_writer_failure_remains_primary_when_pin_cleanup_also_fails(tmp_path, monkeypatch) -> None:
    target_path = tmp_path / "host-reserved.csv"
    target_path.touch()
    identity = _regular_file_identity(target_path)
    target = ExportTarget(target_path, *identity)

    class FailedCleanupPin:
        def assert_unchanged(self) -> None:
            return

        def sync(self) -> None:
            return

        def close(self) -> None:
            raise OSError("pin cleanup failed")

    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.WindowsPinnedExportTarget.open",
        lambda *_args, **_kwargs: FailedCleanupPin(),
    )
    monkeypatch.setattr(ExportTarget, "assert_unchanged", lambda _self: None)

    with pytest.raises(RuntimeError, match="engine failed") as raised, target._pinned_windows_writer_path():
        raise RuntimeError("engine failed")

    assert isinstance(raised.value.__cause__, OSError)
    assert str(raised.value.__cause__) == "pin cleanup failed"


def test_windows_pin_cleanup_failure_surfaces_after_success(tmp_path, monkeypatch) -> None:
    target_path = tmp_path / "host-reserved.csv"
    target_path.touch()
    identity = _regular_file_identity(target_path)
    target = ExportTarget(target_path, *identity)

    class FailedCleanupPin:
        def assert_unchanged(self) -> None:
            return

        def sync(self) -> None:
            return

        def close(self) -> None:
            raise OSError("pin cleanup failed")

    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.WindowsPinnedExportTarget.open",
        lambda *_args, **_kwargs: FailedCleanupPin(),
    )
    monkeypatch.setattr(ExportTarget, "assert_unchanged", lambda _self: None)

    with pytest.raises(OSError, match="pin cleanup failed"), target._pinned_windows_writer_path():
        pass


def test_windows_validation_and_pin_cleanup_failures_both_remain_visible(tmp_path, monkeypatch) -> None:
    target_path = tmp_path / "host-reserved.csv"
    target_path.touch()
    identity = _regular_file_identity(target_path)
    target = ExportTarget(target_path, *identity)

    class FailedValidationAndCleanupPin:
        def assert_unchanged(self) -> None:
            raise WindowsFileHandleValidationError("named target identity changed")

        def sync(self) -> None:
            return

        def close(self) -> None:
            raise OSError("pin cleanup failed")

    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.WindowsPinnedExportTarget.open",
        lambda *_args, **_kwargs: FailedValidationAndCleanupPin(),
    )
    monkeypatch.setattr(ExportTarget, "assert_unchanged", lambda _self: None)

    with (
        pytest.raises(ExportTargetError, match="temporary export file changed") as raised,
        target._pinned_windows_writer_path(),
    ):
        pass

    assert isinstance(raised.value.__cause__, WindowsFileHandleValidationError)
    assert str(raised.value.__cause__) == "named target identity changed"
    assert raised.value.__notes__ == ["Windows export target pin cleanup also failed: OSError: pin cleanup failed"]


class DefensivePython310StyleError(RuntimeError):
    def __setattr__(self, name: str, value: object) -> None:
        if name == "__notes__":
            raise AttributeError("ordinary note attributes are disabled")
        super().__setattr__(name, value)


def test_cleanup_notes_remain_available_without_base_exception_add_note() -> None:
    export_error = DefensivePython310StyleError("export failed")
    BaseException.__setattr__(export_error, "add_note", None)
    BaseException.__setattr__(export_error, "__notes__", ["prior cleanup evidence"])
    _add_cleanup_note(export_error, OSError("writer cleanup failed"), "Export writer cleanup")
    _add_cleanup_note(export_error, OSError("x" * 700), "Export pin cleanup")
    assert export_error.__notes__ == [
        "prior cleanup evidence",
        "Export writer cleanup also failed: OSError: writer cleanup failed",
        "Export pin cleanup also failed: OSError: " + "x" * 471,
    ]
    assert len(export_error.__notes__[-1]) == 512

    windows_error = RuntimeError("Windows validation failed")
    BaseException.__setattr__(windows_error, "add_note", None)
    windows_error.__cause__ = OSError("descriptor cleanup failed")
    with pytest.raises(RuntimeError) as raised:
        _raise_with_windows_cleanup(windows_error, OSError("pin cleanup failed"), "Windows pin cleanup")
    assert raised.value is windows_error
    assert raised.value.__notes__ == ["Windows pin cleanup also failed: OSError: pin cleanup failed"]


def test_binary_writer_truncates_and_keeps_the_reserved_identity(tmp_path) -> None:
    path = tmp_path / "host-reserved.parquet"
    path.write_bytes(b"stale")
    identity = _regular_file_identity(path)
    writer_path = ExportWriterPath(path, *identity)

    with writer_path.open_binary_writer() as writer:
        writer.write(b"native-stream")

    assert path.read_bytes() == b"native-stream"
    assert _regular_file_identity(path) == identity


class FailedCloseWriter:
    def flush(self) -> None:
        return

    def close(self) -> None:
        raise OSError("writer cleanup failed")


def install_failed_close_writer(monkeypatch: pytest.MonkeyPatch) -> FailedCloseWriter:
    writer = FailedCloseWriter()
    monkeypatch.setattr("openwrangler_runtime.export_target._open_regular_file", lambda _path: 73)
    monkeypatch.setattr("openwrangler_runtime.export_target._descriptor_identity", lambda _descriptor: (5, 7))
    monkeypatch.setattr("openwrangler_runtime.export_target.os.ftruncate", lambda _descriptor, _size: None)
    monkeypatch.setattr("openwrangler_runtime.export_target.os.fdopen", lambda *_args, **_kwargs: writer)
    return writer


@pytest.mark.parametrize("close_fails", [False, True])
def test_binary_writer_rejects_identity_mismatch_before_truncate_or_fdopen(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    close_fails: bool,
) -> None:
    descriptor_closes: list[int] = []
    monkeypatch.setattr("openwrangler_runtime.export_target._open_regular_file", lambda _path: 73)
    monkeypatch.setattr("openwrangler_runtime.export_target._descriptor_identity", lambda _descriptor: (5, 8))
    monkeypatch.setattr(
        "openwrangler_runtime.export_target.os.ftruncate",
        lambda *_args: pytest.fail("identity must be checked before truncation"),
    )
    monkeypatch.setattr(
        "openwrangler_runtime.export_target.os.fdopen",
        lambda *_args, **_kwargs: pytest.fail("identity must be checked before fdopen"),
    )

    def close_descriptor(descriptor: int) -> None:
        descriptor_closes.append(descriptor)
        if close_fails:
            raise OSError("descriptor cleanup failed")

    monkeypatch.setattr("openwrangler_runtime.export_target.os.close", close_descriptor)
    writer_path = ExportWriterPath(tmp_path / "host-reserved.csv", 5, 7)

    with (
        pytest.raises(ExportTargetError, match="temporary export file changed") as raised,
        writer_path.open_binary_writer(),
    ):
        pytest.fail("an identity-mismatched writer must not be yielded")

    assert descriptor_closes == [73]
    if close_fails:
        assert isinstance(raised.value.__cause__, OSError)
        assert str(raised.value.__cause__) == "descriptor cleanup failed"


def test_binary_writer_cleanup_failure_surfaces_after_success(tmp_path, monkeypatch) -> None:
    install_failed_close_writer(monkeypatch)
    writer_path = ExportWriterPath(tmp_path / "host-reserved.csv", 5, 7)

    with pytest.raises(OSError, match="writer cleanup failed"), writer_path.open_binary_writer():
        pass


def test_binary_writer_failure_remains_primary_when_cleanup_also_fails(tmp_path, monkeypatch) -> None:
    install_failed_close_writer(monkeypatch)
    writer_path = ExportWriterPath(tmp_path / "host-reserved.csv", 5, 7)

    with pytest.raises(RuntimeError, match="engine failed") as raised, writer_path.open_binary_writer():
        raise RuntimeError("engine failed")

    assert isinstance(raised.value.__cause__, OSError)
    assert str(raised.value.__cause__) == "writer cleanup failed"


def test_operation_and_all_nested_cleanup_failures_remain_visible(tmp_path, monkeypatch) -> None:
    target_path = tmp_path / "host-reserved.csv"
    target_path.touch()
    target = ExportTarget(target_path, 5, 7)
    install_failed_close_writer(monkeypatch)

    class FailedRawPinCleanup:
        def assert_unchanged(self) -> None:
            return

        def sync(self) -> None:
            return

        def close(self) -> None:
            raise WindowsFileHandleCleanupError(
                [OSError("target pin cleanup failed"), OSError("parent pin cleanup failed")]
            )

    monkeypatch.setattr(
        "openwrangler_runtime.windows_file_handle.WindowsPinnedExportTarget.open",
        lambda *_args, **_kwargs: FailedRawPinCleanup(),
    )
    monkeypatch.setattr(ExportTarget, "assert_unchanged", lambda _self: None)

    with (
        pytest.raises(RuntimeError, match="engine failed") as raised,
        target._pinned_windows_writer_path(),
        ExportWriterPath(target_path, 5, 7).open_binary_writer(),
    ):
        raise RuntimeError("engine failed")

    assert isinstance(raised.value.__cause__, OSError)
    assert str(raised.value.__cause__) == "writer cleanup failed"
    assert raised.value.__notes__ == [
        "Windows export target pin cleanup also failed: WindowsFileHandleCleanupError "
        "(OSError: target pin cleanup failed; OSError: parent pin cleanup failed)"
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="requires real Windows sharing semantics")
def test_windows_pin_blocks_target_and_parent_path_substitution(tmp_path) -> None:
    parent = tmp_path / "export-parent"
    parent.mkdir()
    target = parent / "host-reserved.csv"
    target.write_bytes(b"reserved")
    identity = _regular_file_identity(target)
    pinned = WindowsPinnedExportTarget.open(target, identity)

    try:
        with pytest.raises(OSError) as rename_error:
            target.rename(parent / "displaced.csv")
        assert_windows_sharing_violation(rename_error.value)
        with pytest.raises(OSError) as unlink_error:
            target.unlink()
        assert_windows_sharing_violation(unlink_error.value)
        replacement = parent / "foreign.csv"
        replacement.write_bytes(b"foreign")
        with pytest.raises(OSError) as replace_error:
            os.replace(replacement, target)
        assert_windows_sharing_violation(replace_error.value)

        symlink_source = parent / "symlink-source.csv"
        symlink_source.write_bytes(b"symlink source")
        symlink_replacement = parent / "replacement-link.csv"
        try:
            symlink_replacement.symlink_to(symlink_source)
        except OSError as symlink_error:
            assert getattr(symlink_error, "winerror", None) == 1314
        else:
            with pytest.raises(OSError) as symlink_replace_error:
                os.replace(symlink_replacement, target)
            assert_windows_sharing_violation(symlink_replace_error.value)
            assert symlink_replacement.is_symlink()
            assert symlink_source.read_bytes() == b"symlink source"

        with pytest.raises(OSError) as parent_rename_error:
            parent.rename(tmp_path / "displaced-parent")
        assert_windows_sharing_violation(parent_rename_error.value)
        assert target.read_bytes() == b"reserved"
        assert replacement.read_bytes() == b"foreign"
        assert _regular_file_identity(target) == identity
        pinned.assert_unchanged()
    finally:
        pinned.close()

    released_target = parent / "released-target.csv"
    target.rename(released_target)
    released_target.rename(target)
    released_parent = tmp_path / "released-parent"
    parent.rename(released_parent)
    assert (released_parent / target.name).read_bytes() == b"reserved"


@pytest.mark.skipif(sys.platform != "win32", reason="requires real Windows hard-link semantics")
def test_windows_pin_rejects_a_hardlink_added_during_native_write(tmp_path) -> None:
    target = tmp_path / "host-reserved.csv"
    target.touch()
    identity = _regular_file_identity(target)
    pinned = WindowsPinnedExportTarget.open(target, identity)
    alias = tmp_path / "target-alias.csv"
    hardlink_blocked = False

    try:
        try:
            alias.hardlink_to(target)
        except OSError as hardlink_error:
            assert_windows_sharing_violation(hardlink_error)
            hardlink_blocked = True
            assert not alias.exists()
            pinned.assert_unchanged()
        else:
            assert alias.read_bytes() == b""
            with pytest.raises(WindowsFileHandleValidationError, match="not singly linked"):
                pinned.assert_unchanged()
    finally:
        pinned.close()

    if hardlink_blocked:
        alias.hardlink_to(target)
        assert alias.read_bytes() == target.read_bytes()
        assert alias.samefile(target)


def test_posix_writer_target_detects_replacement_after_native_write(tmp_path) -> None:
    if sys.platform == "win32":
        pytest.skip("Windows prevents the replacement while its path pins are open")
    target_path = tmp_path / "host-reserved.csv"
    target_path.touch()
    identity = _regular_file_identity(target_path)
    target = ExportTarget(target_path, *identity)
    displaced = tmp_path / "displaced.csv"

    with (
        pytest.raises(ExportTargetError, match="temporary export file changed"),
        target.pinned_writer_path() as writer_path,
    ):
        Path(writer_path).rename(displaced)
        Path(writer_path).write_bytes(b"foreign replacement")
        displaced.write_bytes(b"cleaned export")

    assert target.path.read_bytes() == b"foreign replacement"
    assert displaced.read_bytes() == b"cleaned export"


def assert_windows_sharing_violation(error: OSError) -> None:
    assert getattr(error, "winerror", None) == 32
