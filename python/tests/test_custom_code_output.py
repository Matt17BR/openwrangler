from __future__ import annotations

import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from io import StringIO
from typing import Any

import pytest

from openwrangler_runtime.custom_code_output import (
    MAX_CUSTOM_DIAGNOSTIC_BYTES,
    append_custom_code_output,
    capture_custom_code_output,
    custom_code_error_message,
)
from openwrangler_runtime.engines import DuckDBEngine, EngineError, PandasEngine, PolarsEngine


@contextmanager
def _editing_engine(name: str) -> Iterator[tuple[Any, Any]]:
    if name == "pandas":
        pd = pytest.importorskip("pandas")
        engine = PandasEngine()
        frame = pd.DataFrame({"value": [1, 2]})
    elif name == "polars":
        pl = pytest.importorskip("polars")
        engine = PolarsEngine()
        frame = pl.DataFrame({"value": [1, 2]})
    else:
        duckdb = pytest.importorskip("duckdb")
        engine = DuckDBEngine()
        frame = duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)")
    try:
        yield engine, frame
    finally:
        engine.close()


def _custom_step(code: str) -> dict[str, Any]:
    return {"id": "custom-output", "kind": "customCode", "params": {"code": code}}


def _install_string_streams(monkeypatch: pytest.MonkeyPatch) -> tuple[StringIO, StringIO]:
    process_stdout = StringIO()
    process_stderr = StringIO()
    monkeypatch.setattr(sys, "stdout", process_stdout)
    monkeypatch.setattr(sys, "stderr", process_stderr)
    monkeypatch.setattr(sys, "__stdout__", process_stdout)
    monkeypatch.setattr(sys, "__stderr__", process_stderr)
    return process_stdout, process_stderr


def test_custom_output_is_captured_without_reaching_process_streams(monkeypatch) -> None:
    process_stdout, process_stderr = _install_string_streams(monkeypatch)

    with capture_custom_code_output() as output:
        print("ordinary stdout")
        sys.stdout.write("no-newline stdout")
        print("ordinary stderr", file=sys.stderr)
        dunder_stdout = sys.__stdout__
        dunder_stderr = sys.__stderr__
        assert dunder_stdout is not None
        assert dunder_stderr is not None
        dunder_stdout.write("dunder stdout")
        dunder_stderr.write("dunder stderr")

    assert output.stdout == "ordinary stdout\nno-newline stdoutdunder stdout"
    assert output.stderr == "ordinary stderr\ndunder stderr"
    assert process_stdout.getvalue() == ""
    assert process_stderr.getvalue() == ""
    assert sys.stdout is process_stdout
    assert sys.stderr is process_stderr
    assert sys.__stdout__ is process_stdout
    assert sys.__stderr__ is process_stderr


def test_simultaneous_custom_steps_keep_output_request_scoped(monkeypatch) -> None:
    process_stdout, process_stderr = _install_string_streams(monkeypatch)
    barrier = threading.Barrier(3)
    results: dict[str, tuple[str, str]] = {}

    def run(label: str) -> None:
        with capture_custom_code_output() as output:
            barrier.wait()
            for index in range(200):
                sys.stdout.write(f"{label}-out-{index}\n")
                sys.stderr.write(f"{label}-err-{index}\n")
            barrier.wait()
        results[label] = (output.stdout, output.stderr)

    threads = [threading.Thread(target=run, args=(label,)) for label in ("alpha", "beta")]
    for thread in threads:
        thread.start()
    barrier.wait()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()

    assert "beta-" not in results["alpha"][0]
    assert "beta-" not in results["alpha"][1]
    assert "alpha-" not in results["beta"][0]
    assert "alpha-" not in results["beta"][1]
    assert results["alpha"][0].startswith("alpha-out-0\n")
    assert results["beta"][1].startswith("beta-err-0\n")
    assert process_stdout.getvalue() == ""
    assert process_stderr.getvalue() == ""


def test_large_no_newline_output_is_bounded_before_diagnostic_processing() -> None:
    with capture_custom_code_output() as output:
        assert sys.stdout.write("x" * (MAX_CUSTOM_DIAGNOSTIC_BYTES * 100)) == MAX_CUSTOM_DIAGNOSTIC_BYTES * 100
        assert sys.stderr.write("y" * (MAX_CUSTOM_DIAGNOSTIC_BYTES * 100)) == MAX_CUSTOM_DIAGNOSTIC_BYTES * 100

    assert output.stdout == ("x" * MAX_CUSTOM_DIAGNOSTIC_BYTES) + "\n<output truncated>"
    assert output.stderr == ("y" * MAX_CUSTOM_DIAGNOSTIC_BYTES) + "\n<output truncated>"
    diagnostic = append_custom_code_output("failure", output)
    assert len(diagnostic.encode("utf-8")) < (2 * MAX_CUSTOM_DIAGNOSTIC_BYTES) + 256


def test_large_buffered_output_retains_only_its_bounded_prefix() -> None:
    payload = memoryview(bytearray(b"z" * (MAX_CUSTOM_DIAGNOSTIC_BYTES * 100)))

    with capture_custom_code_output() as output:
        assert sys.stdout.buffer.write(payload) == len(payload)

    assert output.stdout == ("z" * MAX_CUSTOM_DIAGNOSTIC_BYTES) + "\n<output truncated>"


def test_custom_failure_diagnostics_are_bounded_and_redacted() -> None:
    with capture_custom_code_output() as output:
        print("Authorization: Bearer stdout-secret")
        print("password=stderr-secret", file=sys.stderr)
        print("sk-proj-abcdefghijklmnop", file=sys.stderr)
        print("https://example.invalid/path?token=query-secret", file=sys.stderr)

    diagnostic = custom_code_error_message("Pandas", ValueError("token=exception-secret"), output)

    assert "stdout-secret" not in diagnostic
    assert "stderr-secret" not in diagnostic
    assert "exception-secret" not in diagnostic
    assert "abcdefghijklmnop" not in diagnostic
    assert "query-secret" not in diagnostic
    assert "<redacted>" in diagnostic
    diagnostic.encode("utf-8")


def test_unpaired_or_control_output_is_suppressed_before_diagnostic_encoding() -> None:
    with capture_custom_code_output() as output:
        sys.stderr.write("prefix\ud800suffix")

    diagnostic = append_custom_code_output("failure", output)
    assert "prefix" not in diagnostic
    assert "suffix" not in diagnostic
    assert "<redacted unsafe output>" in diagnostic
    diagnostic.encode("utf-8")


def test_private_key_marker_suppresses_the_complete_captured_channel() -> None:
    with capture_custom_code_output() as output:
        print("harmless prefix")
        print("-----BEGIN OPENSSH PRIVATE KEY-----")
        print("private-material")

    diagnostic = append_custom_code_output("failure", output)
    assert "harmless prefix" not in diagnostic
    assert "private-material" not in diagnostic
    assert "<redacted private-key output>" in diagnostic


def test_custom_stream_replacement_cannot_poison_a_follow_up_request(monkeypatch) -> None:
    process_stdout, process_stderr = _install_string_streams(monkeypatch)

    with capture_custom_code_output():
        sys.stdout = StringIO()
        sys.stderr = StringIO()

    with capture_custom_code_output() as output:
        print("follow-up stdout")
        print("follow-up stderr", file=sys.stderr)

    assert output.stdout == "follow-up stdout\n"
    assert output.stderr == "follow-up stderr\n"
    assert process_stdout.getvalue() == ""
    assert process_stderr.getvalue() == ""


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_live_engine_output_is_suppressed_but_generated_code_keeps_normal_stream_behavior(
    backend: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    process_stdout, process_stderr = _install_string_streams(monkeypatch)
    code = f"import sys\nprint('{backend}-live-stdout')\nsys.stderr.write('{backend}-live-stderr')\nresult = df"

    with _editing_engine(backend) as (engine, frame):
        transformed = engine.apply_transform(frame, _custom_step(code))
        assert transformed is not None
        assert process_stdout.getvalue() == ""
        assert process_stderr.getvalue() == ""

        generated_namespace = {"df": frame}
        exec(engine.compile_plan([_custom_step(code)]), generated_namespace, generated_namespace)
        generated = generated_namespace["clean_data"](frame)
        assert generated is not None

    assert process_stdout.getvalue() == f"{backend}-live-stdout\n"
    assert process_stderr.getvalue() == f"{backend}-live-stderr"


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_engine_failures_include_only_bounded_redacted_request_output(
    backend: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    process_stdout, process_stderr = _install_string_streams(monkeypatch)
    code = (
        "import sys\n"
        "print('Authorization: Bearer captured-stdout-secret')\n"
        "sys.stderr.write('password=captured-stderr-secret')\n"
        "sys.stdout.write('z' * 1000000)\n"
        "raise ValueError('token=exception-secret')"
    )

    with _editing_engine(backend) as (engine, frame), pytest.raises(EngineError) as raised:
        engine.apply_transform(frame, _custom_step(code))

    diagnostic = str(raised.value)
    assert "captured-stdout-secret" not in diagnostic
    assert "captured-stderr-secret" not in diagnostic
    assert "exception-secret" not in diagnostic
    assert "<redacted>" in diagnostic
    assert "<output truncated>" in diagnostic
    assert len(diagnostic.encode("utf-8")) < (2 * MAX_CUSTOM_DIAGNOSTIC_BYTES) + 512
    assert process_stdout.getvalue() == ""
    assert process_stderr.getvalue() == ""
