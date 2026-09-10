from __future__ import annotations

import queue
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, cast

from pip._vendor import packaging


def _stop_guard_process(process: subprocess.Popen[bytes], timeout: float) -> None:
    try:
        if process.stdin is not None:
            stdin = process.stdin
            try:
                stdin.close()
            except BrokenPipeError:
                pass
            finally:
                if stdin.closed:
                    process.stdin = None
    finally:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout)


def _join_guard_reader(process: subprocess.Popen[bytes], timeout: float) -> None:
    reader = getattr(process, "_dependency_guard_frame_reader", None)
    if reader is not None:
        reader.join(timeout=timeout)
        if reader.is_alive():
            raise AssertionError("The dependency guard frame reader did not settle.")
        delattr(process, "_dependency_guard_frame_reader")


def cleanup_guard_processes(processes: list[subprocess.Popen[bytes]], timeout: float) -> None:
    errors: list[BaseException] = []
    for process in processes:
        try:
            _stop_guard_process(process, timeout)
        except BaseException as error:
            errors.append(error)
        finally:
            # A failed kill/wait is reported without closing a pipe that may
            # still be held by a reader. Keep the handles owned on failure.
            try:
                _join_guard_reader(process, timeout)
                if process.poll() is not None:
                    for stream in (process.stdout, process.stderr):
                        if stream is not None:
                            try:
                                stream.close()
                            except BaseException as error:
                                errors.append(error)
            except BaseException as error:
                errors.append(error)
    if errors:
        raise errors[0]
    processes.clear()


def read_guard_line(process: subprocess.Popen[bytes], timeout: float, process_timeout: float) -> bytes:
    assert process.stdout is not None
    stdout = process.stdout
    results: queue.Queue[bytes | BaseException] = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            results.put(stdout.readline())
        except BaseException as error:
            results.put(error)

    reader = threading.Thread(target=read, daemon=True)
    assert not hasattr(process, "_dependency_guard_frame_reader")
    cast(Any, process)._dependency_guard_frame_reader = reader
    try:
        reader.start()
    except BaseException:
        delattr(process, "_dependency_guard_frame_reader")
        raise
    failure: BaseException
    try:
        result = results.get(timeout=timeout)
    except queue.Empty:
        failure = AssertionError("The dependency guard did not emit a frame before the timeout.")
    except BaseException as error:
        failure = error
    else:
        _join_guard_reader(process, process_timeout)
        if isinstance(result, BaseException):
            raise result
        return result
    cleanup_error: BaseException | None = None
    try:
        _stop_guard_process(process, process_timeout)
    except BaseException as error:
        cleanup_error = error
    try:
        _join_guard_reader(process, process_timeout)
    except BaseException as error:
        raise failure from error
    if cleanup_error is not None:
        raise failure from cleanup_error
    raise failure


def create_fake_pip_package(site_packages: Path) -> Path:
    package = site_packages / "pip"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    vendor = package / "_vendor"
    vendor.mkdir()
    (vendor / "__init__.py").write_text("", encoding="utf-8")
    shutil.copytree(Path(packaging.__file__).parent, vendor / "packaging")
    return package
