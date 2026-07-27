from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path

from fixture_contract import fixture_manifest


def _write_manifest_atomic(destination: Path, manifest: dict[str, object]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create deterministic, redistributable fixtures for installed-editor performance acceptance."
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--manifest-out", type=Path, required=True)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()

    manifest = fixture_manifest(args.output_dir, args.smoke)
    _write_manifest_atomic(args.manifest_out, manifest)
    print(json.dumps(manifest, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
