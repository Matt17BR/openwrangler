from __future__ import annotations

import os
import re
import stat
import time
from dataclasses import dataclass
from pathlib import Path

TOKEN_PATH = Path("/run/openwrangler/token")
TOKEN_LIMIT = 43
TOKEN_PATTERN = re.compile(r"owr_[A-Za-z0-9_-]{39}")
TOKEN_WAIT_SECONDS = 300


@dataclass(frozen=True)
class JupyterDirectories:
    work: Path
    config: Path
    data: Path
    runtime: Path
    ipython: Path


def read_token() -> str:
    deadline = time.monotonic() + TOKEN_WAIT_SECONDS
    while True:
        try:
            flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(TOKEN_PATH, flags)
            break
        except FileNotFoundError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Remote Jupyter authentication input was not provided in time.")
            time.sleep(0.05)

    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or stat.S_IMODE(metadata.st_mode) != stat.S_IRUSR
            or metadata.st_uid != os.getuid()
            or metadata.st_gid != os.getgid()
            or metadata.st_size != TOKEN_LIMIT
        ):
            raise RuntimeError("Remote Jupyter authentication input has unsafe metadata.")
        raw_token = os.read(descriptor, TOKEN_LIMIT + 1)
        if len(raw_token) != metadata.st_size:
            raise RuntimeError("Remote Jupyter authentication input changed while it was read.")
    finally:
        os.close(descriptor)

    TOKEN_PATH.unlink()
    try:
        token = raw_token.decode("ascii")
    except UnicodeDecodeError as error:
        raise RuntimeError("Remote Jupyter authentication input is invalid.") from error
    if not TOKEN_PATTERN.fullmatch(token):
        raise RuntimeError("Remote Jupyter authentication input is invalid.")
    return token


def prepare_jupyter_environment(base_directory: Path = Path("/tmp")) -> JupyterDirectories:
    directories = JupyterDirectories(
        work=base_directory / "work",
        config=base_directory / "jupyter-config",
        data=base_directory / "jupyter-data",
        runtime=base_directory / "jupyter-runtime",
        ipython=base_directory / "ipython",
    )
    for directory in (
        directories.work,
        directories.config,
        directories.data,
        directories.runtime,
        directories.ipython,
    ):
        directory.mkdir(mode=0o700)
        directory.chmod(0o700)
    os.environ["JUPYTER_CONFIG_DIR"] = str(directories.config)
    os.environ["JUPYTER_DATA_DIR"] = str(directories.data)
    os.environ["JUPYTER_RUNTIME_DIR"] = str(directories.runtime)
    os.environ["IPYTHONDIR"] = str(directories.ipython)
    return directories


def main() -> None:
    token = read_token()
    directories = prepare_jupyter_environment()

    from IPython.paths import get_ipython_dir
    from jupyter_server.serverapp import ServerApp
    from traitlets.config import Config

    config = Config()
    config.IdentityProvider.token = token
    config.ServerApp.allow_remote_access = True
    config.ServerApp.allow_root = False
    config.ServerApp.browser = ""
    config.ServerApp.ip = "0.0.0.0"
    config.ServerApp.log_level = "WARN"
    config.ServerApp.open_browser = False
    config.ServerApp.password = ""
    config.ServerApp.port = 8888
    config.ServerApp.port_retries = 0
    config.ServerApp.root_dir = str(directories.work)
    config.ServerApp.terminals_enabled = False

    application = ServerApp(config=config)
    if (
        Path(application.config_dir) != directories.config
        or Path(application.data_dir) != directories.data
        or Path(application.runtime_dir) != directories.runtime
        or Path(get_ipython_dir()) != directories.ipython
    ):
        raise RuntimeError("Remote Jupyter path isolation could not be established.")
    application.initialize([])
    application.start()


if __name__ == "__main__":
    main()
