#!/usr/bin/env python3
"""Install the exact remote-Jupyter R archive closure from its canonical lock."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

LOCK_PROTOCOL = "openwrangler-remote-r-package-lock-v1"
LOCK_MAX_BYTES = 512 * 1024
ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
AGGREGATE_MAX_BYTES = 128 * 1024 * 1024
PACKAGE_MAX_COUNT = 128
DEPENDENCY_MAX_COUNT = 64
COMMAND_LOG_MAX_BYTES = 1024 * 1024
COMMAND_TIMEOUT_SECONDS = 300
COMMAND_TERMINATION_GRACE_SECONDS = 2
COMMAND_READ_CHUNK_BYTES = 64 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9.]{0,63}$")
PACKAGE_VERSION = re.compile(r"^[0-9][0-9A-Za-z.+-]{0,63}$")
ARCHIVE_URL = re.compile(
    r"^https://rspm-sync\.rstudio\.com/v4/1/packages/[0-9a-f]{64}\.tar\.gz$"
)
SOURCE_URL = re.compile(
    r"^https://p3m\.dev/cran/__linux__/noble/2026-(?:03-10|06-01)/src/contrib/"
    r"[A-Za-z][A-Za-z0-9.]{0,63}_[0-9][0-9A-Za-z.+-]{0,63}\.tar\.gz$"
)


class ContractError(RuntimeError):
    """Raised when the package lock or installation receipt is not exact."""


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise ContractError("archive download attempted an unapproved redirect")


def fail(message: str) -> None:
    raise ContractError(f"Remote R package installation failed: {message}")


def exact_object(value: Any, keys: tuple[str, ...], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or tuple(value) != keys:
        fail(f"{label} has noncanonical fields")
    return value


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key {key}")
        result[key] = value
    return result


def canonical_lock_text(lock: dict[str, Any]) -> str:
    lines = json.dumps(lock, indent=2, ensure_ascii=False, separators=(",", ": ")).splitlines()
    canonical: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.endswith('"dependencies": ['):
            canonical.append(line)
            index += 1
            continue
        indent = line[: line.index('"dependencies"')]
        values: list[str] = []
        cursor = index + 1
        while cursor < len(lines) and lines[cursor] != f"{indent}],":
            value = re.fullmatch(r'\s+"([^"\\]+)"[,]?', lines[cursor])
            if value is None:
                fail("dependencies could not be serialized canonically")
            values.append(value.group(1))
            cursor += 1
        if cursor >= len(lines):
            fail("dependencies could not be serialized canonically")
        inline = f'{indent}"dependencies": {json.dumps(values, ensure_ascii=False)},'
        if len(inline) <= 120:
            canonical.append(inline)
            index = cursor + 1
        else:
            canonical.append(line)
            index += 1
    return "\n".join(canonical) + "\n"


def read_lock(path: Path, expected_digest: str) -> tuple[dict[str, Any], str, bytes]:
    if not SHA256.fullmatch(expected_digest):
        fail("expected lock digest is not lowercase SHA-256")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size <= 0
            or before.st_size > LOCK_MAX_BYTES
        ):
            fail("lock must be one bounded unaliased regular file")
        identity = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_nlink,
            before.st_uid,
            before.st_gid,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        content = os.read(descriptor, before.st_size + 1)
        after = os.fstat(descriptor)
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_nlink,
            after.st_uid,
            after.st_gid,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if len(content) != before.st_size or identity != after_identity:
            fail("lock identity or contents changed while reading")
    finally:
        os.close(descriptor)
    digest = hashlib.sha256(content).hexdigest()
    if digest != expected_digest:
        fail("lock digest does not match the build argument")
    if not content.endswith(b"\n") or b"\r" in content or b"\0" in content:
        fail("lock is not canonical LF-terminated UTF-8")
    try:
        text = content.decode("utf-8")
        lock = json.loads(text, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError("Remote R package installation failed: lock is not strict UTF-8 JSON") from error
    if text != canonical_lock_text(lock):
        fail("lock JSON is not canonical")
    validate_lock(lock)
    return lock, digest, content


def validate_lock(lock: Any) -> None:
    exact_object(lock, ("protocol", "target", "repositories", "roots", "packages"), "lock")
    if lock["protocol"] != LOCK_PROTOCOL:
        fail("lock protocol is unsupported")
    target = exact_object(
        lock["target"], ("rVersion", "os", "distribution", "codename", "architecture"), "target"
    )
    if target != {
        "rVersion": "4.5.2",
        "os": "linux",
        "distribution": "ubuntu",
        "codename": "noble",
        "architecture": "x86_64",
    }:
        fail("lock target is not exact R 4.5.2 on Ubuntu noble x86_64")
    repositories = lock["repositories"]
    expected_repositories = (
        ("primary", "2026-03-10", "https://p3m.dev/cran/__linux__/noble/2026-03-10/src/contrib"),
        ("supplemental", "2026-06-01", "https://p3m.dev/cran/__linux__/noble/2026-06-01/src/contrib"),
    )
    if not isinstance(repositories, list) or len(repositories) != len(expected_repositories):
        fail("repository inventory is incomplete")
    repository_urls: dict[str, str] = {}
    for index, expected in enumerate(expected_repositories):
        repository = exact_object(repositories[index], ("id", "snapshotDate", "url"), f"repository {index}")
        if (repository["id"], repository["snapshotDate"], repository["url"]) != expected:
            fail("repository inventory drifted")
        repository_urls[repository["id"]] = repository["url"]
    roots = exact_object(lock["roots"], ("runtime", "fixtures"), "roots")
    expected_roots = {
        "runtime": (
            ("IRkernel", "primary"),
            ("jsonlite", "primary"),
            ("rlang", "primary"),
            ("tibble", "primary"),
            ("data.table", "primary"),
            ("nanoparquet", "supplemental"),
        ),
        "fixtures": (("collapse", "supplemental"),),
    }
    for category, expected in expected_roots.items():
        entries = roots[category]
        if not isinstance(entries, list) or len(entries) != len(expected):
            fail(f"{category} root inventory is incomplete")
        for index, root_expected in enumerate(expected):
            root = exact_object(entries[index], ("name", "repository"), f"{category} root {index}")
            if (root["name"], root["repository"]) != root_expected:
                fail(f"{category} root inventory drifted")
    packages = lock["packages"]
    if not isinstance(packages, list) or not packages or len(packages) > PACKAGE_MAX_COUNT:
        fail("package inventory is outside its fixed bound")
    by_name: dict[str, dict[str, Any]] = {}
    aggregate = 0
    package_keys = (
        "name",
        "version",
        "category",
        "direct",
        "repository",
        "sourceUrl",
        "url",
        "bytes",
        "sha256",
        "dependencies",
        "installOrder",
    )
    for index, value in enumerate(packages):
        package = exact_object(value, package_keys, f"package {index}")
        name = package["name"]
        version = package["version"]
        if not isinstance(name, str) or not PACKAGE_NAME.fullmatch(name) or name in by_name:
            fail("package name is unsafe or duplicated")
        if not isinstance(version, str) or not PACKAGE_VERSION.fullmatch(version):
            fail(f"package {name} version is unsafe")
        repository = package["repository"]
        if repository not in repository_urls:
            fail(f"package {name} repository is unknown")
        source_url = f"{repository_urls[repository]}/{name}_{version}.tar.gz"
        if package["sourceUrl"] != source_url or not SOURCE_URL.fullmatch(source_url):
            fail(f"package {name} source URL is not derived from its pin")
        url = package["url"]
        if url != source_url and (not isinstance(url, str) or not ARCHIVE_URL.fullmatch(url)):
            fail(f"package {name} archive URL is not admitted")
        archive_bytes = package["bytes"]
        if (
            not isinstance(archive_bytes, int)
            or isinstance(archive_bytes, bool)
            or archive_bytes <= 0
            or archive_bytes > ARCHIVE_MAX_BYTES
            or not isinstance(package["sha256"], str)
            or not SHA256.fullmatch(package["sha256"])
        ):
            fail(f"package {name} archive identity is invalid")
        aggregate += archive_bytes
        if aggregate > AGGREGATE_MAX_BYTES:
            fail("aggregate archive bytes exceed the fixed bound")
        dependencies = package["dependencies"]
        if (
            not isinstance(dependencies, list)
            or len(dependencies) > DEPENDENCY_MAX_COUNT
            or any(
                not isinstance(dependency, str) or not PACKAGE_NAME.fullmatch(dependency)
                for dependency in dependencies
            )
            or dependencies != sorted(set(dependencies))
        ):
            fail(f"package {name} dependencies are invalid")
        if package["installOrder"] != index + 1:
            fail("install order is not exact and contiguous")
        if package["category"] not in ("runtime", "fixture") or not isinstance(package["direct"], bool):
            fail(f"package {name} category metadata is invalid")
        by_name[name] = package
    for package in packages:
        for dependency in package["dependencies"]:
            if dependency not in by_name or by_name[dependency]["installOrder"] >= package["installOrder"]:
                fail(f"package {package['name']} dependency order is incomplete")
    runtime_roots = tuple(name for name, _ in expected_roots["runtime"])
    fixture_roots = tuple(name for name, _ in expected_roots["fixtures"])
    runtime_reachable = reachability(runtime_roots, by_name)
    all_reachable = runtime_reachable | reachability(fixture_roots, by_name)
    if len(all_reachable) != len(packages):
        fail("package inventory contains unreachable entries")
    for package in packages:
        expected_category = "runtime" if package["name"] in runtime_reachable else "fixture"
        if package["category"] != expected_category or package["direct"] != (package["name"] in runtime_roots):
            fail(f"package {package['name']} category classification is invalid")
    expected_package_repositories: dict[str, str] = {}

    def claim_repository(name: str, repository: str) -> None:
        if name in expected_package_repositories:
            return
        expected_package_repositories[name] = repository
        for dependency in by_name[name]["dependencies"]:
            claim_repository(dependency, repository)

    for category in ("runtime", "fixtures"):
        for root in roots[category]:
            claim_repository(root["name"], root["repository"])
    for package in packages:
        if package["repository"] != expected_package_repositories[package["name"]]:
            fail(f"package {package['name']} crossed its canonical repository ownership")
    expected_root_versions = {
        "IRkernel": "1.3.2",
        "jsonlite": "2.0.0",
        "rlang": "1.1.7",
        "tibble": "3.3.1",
        "data.table": "1.18.2.1",
        "collapse": "2.1.7",
        "nanoparquet": "0.5.1",
    }
    for name, version in expected_root_versions.items():
        if by_name[name]["version"] != version:
            fail(f"root {name} version drifted")


def reachability(roots: tuple[str, ...], packages: dict[str, dict[str, Any]]) -> set[str]:
    reached: set[str] = set()
    pending = list(roots)
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        package = packages.get(name)
        if package is None:
            fail(f"root or dependency {name} is missing")
        reached.add(name)
        pending.extend(package["dependencies"])
    return reached


def isolated_environment(root: Path, library: Path) -> dict[str, str]:
    return {
        "HOME": str(root),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "R_ENVIRON_USER": "/dev/null",
        "R_PROFILE_USER": "/dev/null",
        "R_LIBS": str(library),
        "R_LIBS_SITE": str(library),
        "R_LIBS_USER": str(library),
    }


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def terminate_owned_process_group(process: subprocess.Popen[bytes]) -> None:
    process_group = process.pid
    for termination_signal in (signal.SIGTERM, signal.SIGKILL):
        if process_group_exists(process_group):
            try:
                os.killpg(process_group, termination_signal)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + COMMAND_TERMINATION_GRACE_SECONDS
        while time.monotonic() < deadline:
            process.poll()
            if not process_group_exists(process_group):
                break
            time.sleep(0.01)
        if not process_group_exists(process_group):
            break
    try:
        process.wait(timeout=COMMAND_TERMINATION_GRACE_SECONDS)
    except subprocess.TimeoutExpired as error:
        raise ContractError(
            "Remote R package installation failed: isolated R command could not be reaped"
        ) from error
    if process_group_exists(process_group):
        raise ContractError(
            "Remote R package installation failed: isolated R command descendants did not settle"
        )


def bounded_command(arguments: list[str], environment: dict[str, str], log_path: Path) -> bytes:
    descriptor = os.open(log_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC, 0o600)
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    stdout = bytearray()
    total = 0
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as log:
            process = subprocess.Popen(
                arguments,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=environment,
                start_new_session=True,
            )
            if process.stdout is None or process.stderr is None:
                fail("isolated R command pipes were not created")
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    fail("isolated R command exceeded its deadline")
                for key, _ in selector.select(timeout=min(0.05, remaining)):
                    chunk = os.read(key.fileobj.fileno(), COMMAND_READ_CHUNK_BYTES)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    available = COMMAND_LOG_MAX_BYTES - total
                    if available > 0:
                        retained = chunk[:available]
                        log.write(retained)
                        if key.data == "stdout":
                            stdout.extend(retained)
                        total += len(retained)
                    if len(chunk) > available:
                        fail("isolated R command output exceeded its bounded log")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail("isolated R command exceeded its deadline")
            return_code = process.wait(timeout=remaining)
            if process_group_exists(process.pid):
                terminate_owned_process_group(process)
                fail("isolated R command left a live descendant")
            log.flush()
            os.fsync(log.fileno())
            if return_code != 0:
                fail("isolated R command failed")
            return bytes(stdout)
    except (OSError, subprocess.TimeoutExpired) as error:
        primary: BaseException = ContractError(
            "Remote R package installation failed: isolated R command did not settle"
        )
        if process is not None:
            try:
                terminate_owned_process_group(process)
            except ContractError as settlement_error:
                raise settlement_error from error
        raise primary from error
    except BaseException as error:
        if process is not None:
            try:
                terminate_owned_process_group(process)
            except ContractError as settlement_error:
                raise settlement_error from error
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None:
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        log_path.unlink(missing_ok=True)


def verify_archive(package: dict[str, Any], archive: Path) -> None:
    descriptor = os.open(
        archive,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size != package["bytes"]
        ):
            fail(f"package {package['name']} archive verification failed")
        identity = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_nlink,
            before.st_uid,
            before.st_gid,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        digest = hashlib.sha256()
        total = 0
        while total <= package["bytes"]:
            chunk = os.read(descriptor, min(64 * 1024, package["bytes"] + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > package["bytes"]:
                fail(f"package {package['name']} archive verification failed")
            digest.update(chunk)
        after = os.fstat(descriptor)
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_nlink,
            after.st_uid,
            after.st_gid,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if total != package["bytes"] or identity != after_identity or digest.hexdigest() != package["sha256"]:
            fail(f"package {package['name']} archive verification failed")
    finally:
        os.close(descriptor)


def install_verified_archive(
    package: dict[str, Any],
    archive: Path,
    arguments: list[str],
    environment: dict[str, str],
    log_path: Path,
) -> bytes:
    verify_archive(package, archive)
    return bounded_command(arguments, environment, log_path)


def download_archive(package: dict[str, Any], destination: Path) -> None:
    opener = urllib.request.build_opener(NoRedirectHandler())
    request = urllib.request.Request(package["url"], headers={"Accept": "application/octet-stream"}, method="GET")
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_CLOEXEC, 0o600)
    digest = hashlib.sha256()
    total = 0
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            try:
                with opener.open(request, timeout=30) as response:
                    if response.status != 200 or response.geturl() != package["url"]:
                        fail(f"package {package['name']} download identity changed")
                    declared = response.headers.get("Content-Length")
                    if declared is None or not declared.isdecimal() or int(declared) != package["bytes"]:
                        fail(f"package {package['name']} declared size changed")
                    while total <= package["bytes"]:
                        chunk = response.read(min(64 * 1024, package["bytes"] + 1 - total))
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > package["bytes"]:
                            fail(f"package {package['name']} exceeded its expected-plus-one bound")
                        digest.update(chunk)
                        output.write(chunk)
            except (urllib.error.URLError, TimeoutError) as error:
                raise ContractError(
                    f"Remote R package installation failed: package {package['name']} download failed"
                ) from error
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    metadata = destination.stat(follow_symlinks=False)
    if (
        total != package["bytes"]
        or metadata.st_size != package["bytes"]
        or metadata.st_nlink != 1
        or not stat.S_ISREG(metadata.st_mode)
        or digest.hexdigest() != package["sha256"]
    ):
        destination.unlink(missing_ok=True)
        fail(f"package {package['name']} archive verification failed")
    verify_archive(package, destination)


def install(lock: dict[str, Any], digest: str, library: Path, prefix: Path) -> None:
    if platform.system() != "Linux" or platform.machine().lower() not in ("x86_64", "amd64"):
        fail("installation host does not match the locked Linux x86_64 target")
    library.mkdir(mode=0o755, parents=False, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="ow-r-lock-", dir="/tmp") as temporary:
        root = Path(temporary)
        root.chmod(0o700)
        environment = isolated_environment(root, library)
        for package in lock["packages"]:
            archive = root / f"{package['installOrder']:03d}.tar.gz"
            download_archive(package, archive)
            try:
                install_verified_archive(
                    package,
                    archive,
                    [
                        "/usr/bin/unshare",
                        "--user",
                        "--map-root-user",
                        "--net",
                        "--",
                        "/usr/local/bin/R",
                        "CMD",
                        "INSTALL",
                        "--no-multiarch",
                        f"--library={library}",
                        str(archive),
                    ],
                    environment,
                    root / "install.log",
                )
            finally:
                archive.unlink(missing_ok=True)
        expected = "|".join(f"{package['name']}={package['version']}" for package in lock["packages"])
        expression = (
            'stopifnot(as.character(getRversion()) == "4.5.2"); '
            f'p <- installed.packages(lib.loc={json.dumps(str(library))}, noCache=TRUE); '
            'cat(paste(sort(paste(rownames(p), p[,"Version"], sep="=")), collapse="|"))'
        )
        receipt_path = root / "closure.txt"
        actual_bytes = bounded_command(
            [
                "/usr/bin/unshare",
                "--user",
                "--map-root-user",
                "--net",
                "--",
                "/usr/local/bin/Rscript",
                "--vanilla",
                "-e",
                expression,
            ],
            environment,
            receipt_path,
        )
        actual = actual_bytes.decode("utf-8")
        if actual != "|".join(sorted(expected.split("|"))):
            fail("installed package closure contains a missing, substituted, or unexpected version")
        bounded_command(
            [
                "/usr/bin/unshare",
                "--user",
                "--map-root-user",
                "--net",
                "--",
                "/usr/local/bin/Rscript",
                "--vanilla",
                "-e",
                (
                    'IRkernel::installspec(user=FALSE, prefix='
                    f'{json.dumps(str(prefix))}, name="openwrangler-r-remote-acceptance", '
                    'displayname="R (Open Wrangler Remote)")'
                ),
            ],
            environment,
            root / "kernelspec.log",
        )
    kernelspec = prefix / "share/jupyter/kernels/openwrangler-r-remote-acceptance/kernel.json"
    specification = json.loads(kernelspec.read_text("utf-8"), object_pairs_hook=reject_duplicates)
    if (
        specification.get("argv")
        != ["/usr/local/lib/R/bin/R", "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"]
        or specification.get("display_name") != "R (Open Wrangler Remote)"
        or specification.get("language") != "R"
    ):
        fail("installed kernelspec is not exact")
    receipt = Path("/opt/openwrangler/r-package-lock-receipt.json")
    receipt.write_text(
        json.dumps(
            {
                "protocol": LOCK_PROTOCOL,
                "sha256": digest,
                "packages": [{"name": package["name"], "version": package["version"]} for package in lock["packages"]],
            },
            indent=2,
            separators=(",", ": "),
        )
        + "\n",
        encoding="utf-8",
    )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--expected-lock-sha256", required=True)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--kernelspec-prefix", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    arguments = parser.parse_args()
    if arguments.validate_only:
        if arguments.library is not None or arguments.kernelspec_prefix is not None:
            parser.error("--validate-only accepts no installation destinations")
    elif arguments.library is None or arguments.kernelspec_prefix is None:
        parser.error("installation requires --library and --kernelspec-prefix")
    return arguments


def main() -> None:
    arguments = parse_arguments()
    lock, digest, _ = read_lock(arguments.manifest, arguments.expected_lock_sha256)
    if not arguments.validate_only:
        install(lock, digest, arguments.library, arguments.kernelspec_prefix)
    print(f"validated remote R package lock {digest} ({len(lock['packages'])} packages)")


if __name__ == "__main__":
    main()
