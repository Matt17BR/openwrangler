from __future__ import annotations

import shutil
from pathlib import Path

from pip._vendor import packaging


def create_fake_pip_package(site_packages: Path) -> Path:
    package = site_packages / "pip"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    vendor = package / "_vendor"
    vendor.mkdir()
    (vendor / "__init__.py").write_text("", encoding="utf-8")
    shutil.copytree(Path(packaging.__file__).parent, vendor / "packaging")
    return package
