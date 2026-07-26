from __future__ import annotations

import os
from pathlib import Path
import re
import stat
import time

from jupyter_server.serverapp import ServerApp
from traitlets.config import Config


TOKEN_PATH = Path("/run/openwrangler/token")
TOKEN_LIMIT = 43
TOKEN_PATTERN = re.compile(r"owr_[A-Za-z0-9_-]{39}")
TOKEN_WAIT_SECONDS = 300


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


def main() -> None:
    token = read_token()
    work_directory = Path("/tmp/work")
    runtime_directory = Path("/tmp/jupyter-runtime")
    config_directory = Path("/tmp/jupyter-config")
    for directory in (work_directory, runtime_directory, config_directory):
        directory.mkdir(mode=0o700)

    config = Config()
    config.IdentityProvider.token = token
    config.ServerApp.allow_remote_access = True
    config.ServerApp.allow_root = False
    config.ServerApp.browser = ""
    config.ServerApp.config_dir = str(config_directory)
    config.ServerApp.ip = "0.0.0.0"
    config.ServerApp.log_level = "WARN"
    config.ServerApp.open_browser = False
    config.ServerApp.password = ""
    config.ServerApp.port = 8888
    config.ServerApp.port_retries = 0
    config.ServerApp.root_dir = str(work_directory)
    config.ServerApp.runtime_dir = str(runtime_directory)
    config.ServerApp.terminals_enabled = False

    application = ServerApp(config=config)
    application.initialize([])
    application.start()


if __name__ == "__main__":
    main()
