from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_performance_harness_smoke(tmp_path: Path) -> None:
    python_root = Path(__file__).parents[1]
    report = tmp_path / "report.json"
    result = subprocess.run(
        [
            sys.executable,
            str(python_root / "benchmarks" / "runtime_performance.py"),
            "--smoke",
            "--fixture-dir",
            str(tmp_path / "fixtures"),
            "--json-out",
            str(report),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    payload = json.loads(report.read_text(encoding="utf-8"))
    assert payload["smoke"] is True
    assert payload["csv"]["shape"] == {"rows": 2_000, "columns": 8}
    assert payload["parquet"]["shape"] == {"rows": 5_000, "columns": 8}
    assert payload["csv"]["retainedSessions"] == 0
    assert payload["parquet"]["retainedSessions"] == 0
    assert '"firstGridMs"' in result.stdout
