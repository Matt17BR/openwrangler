from __future__ import annotations

import importlib.util
import os
import stat
import sys
from pathlib import Path
from types import ModuleType


def load_remote_jupyter_server() -> ModuleType:
    script = Path(__file__).resolve().parents[2] / "scripts" / "remote-jupyter" / "server.py"
    specification = importlib.util.spec_from_file_location("openwrangler_remote_jupyter_server", script)
    assert specification is not None
    assert specification.loader is not None
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    try:
        specification.loader.exec_module(module)
    finally:
        sys.modules.pop(specification.name, None)
    return module


def test_prepare_jupyter_environment_uses_private_writable_directories(
    tmp_path: Path,
    monkeypatch,
) -> None:
    server = load_remote_jupyter_server()
    expected_names = {
        "JUPYTER_CONFIG_DIR": "jupyter-config",
        "JUPYTER_DATA_DIR": "jupyter-data",
        "JUPYTER_RUNTIME_DIR": "jupyter-runtime",
        "IPYTHONDIR": "ipython",
    }
    for variable in expected_names:
        monkeypatch.setenv(variable, "/untrusted/path")

    directories = server.prepare_jupyter_environment(tmp_path)

    assert directories.work == tmp_path / "work"
    assert directories.config == tmp_path / "jupyter-config"
    assert directories.data == tmp_path / "jupyter-data"
    assert directories.runtime == tmp_path / "jupyter-runtime"
    assert directories.ipython == tmp_path / "ipython"
    for directory in [
        directories.work,
        directories.config,
        directories.data,
        directories.runtime,
        directories.ipython,
    ]:
        assert directory.is_dir()
        if os.name == "posix":
            assert stat.S_IMODE(directory.stat().st_mode) == stat.S_IRWXU
    for variable, name in expected_names.items():
        assert os.environ[variable] == str(tmp_path / name)
