import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

export function buildKernelRuntimeBundle(
  files: Readonly<Record<string, string>>
): Readonly<{ bundleId: string; code: string }> {
  const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.some(([relativePath]) => relativePath === "openwrangler_runtime/__init__.py")) {
    throw new Error("The bundled kernel runtime is missing openwrangler_runtime/__init__.py.");
  }
  for (const [relativePath] of entries) {
    if (!/^openwrangler_runtime\/[A-Za-z0-9_/-]+\.py$/.test(relativePath) || relativePath.includes("..")) {
      throw new Error(`Unsafe bundled kernel runtime path: ${relativePath}`);
    }
  }
  const serialized = JSON.stringify(Object.fromEntries(entries));
  const payload = Buffer.from(serialized, "utf8").toString("base64");
  const bundleId = createHash("sha256").update(serialized).digest("hex");
  const code = `
def __ow_bootstrap_runtime(register_formatters):
    import base64
    import importlib
    import json
    import os
    import pathlib
    import stat
    import sys
    import tempfile
    import types

    if os.name == "nt":
        minimum = {(3, 10): (3, 10, 15), (3, 11): (3, 11, 10), (3, 12): (3, 12, 4)}
        if sys.implementation.name != "cpython" or sys.version_info[:3] < minimum.get(sys.version_info[:2], (3, 13, 0)):
            return "unsupported_python"

    expected_id = "${bundleId}"
    files = json.loads(base64.b64decode("${payload}").decode("utf-8"))
    module_files = {}
    for relative in files:
        name = relative[:-3].replace("/", ".")
        if name.endswith(".__init__"):
            name = name[:-9]
        module_files[name] = relative

    def loaded_modules():
        return {
            name: module for name, module in list(sys.modules.items())
            if type(name) is str and (name == "openwrangler_runtime" or name.startswith("openwrangler_runtime."))
        }

    def matches_modules(root, modules):
        for name, module in modules.items():
            relative = module_files.get(name)
            if relative is None or type(module) is not types.ModuleType:
                return False
            expected_file = root / relative
            if module.__dict__.get("__file__") != str(expected_file):
                return False
            if relative.endswith("/__init__.py"):
                if module.__dict__.get("__path__") != [str(expected_file.parent)]:
                    return False
        return True

    def safe_parent(parent):
        if os.name == "nt":
            local = os.environ.get("LOCALAPPDATA")
            if not local:
                return False
            expected = pathlib.Path(os.path.abspath(os.path.join(local, "Temp")))
            if not pathlib.Path(local).is_absolute():
                return False
            # The OS-maintained per-user profile must protect its ancestors.
            # A private child ACL cannot protect an arbitrary shared parent.
            for candidate in (parent, expected):
                if (
                    len(candidate.drive) != 2 or candidate.drive[1] != ":"
                    or candidate.drive[0] not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                ):
                    return False
                for component in [*reversed(candidate.parents), candidate]:
                    info = component.lstat()
                    if not stat.S_ISDIR(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                        return False
            return os.path.samefile(parent, expected)
        if os.name != "posix":
            return False
        for component in [*reversed(parent.parents), parent]:
            info = component.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid()):
                return False
            if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                return False
        return True

    def private_directory(root):
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode):
            return None
        if os.name == "posix":
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                return None
        elif os.name == "nt":
            if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                return None
        else:
            return None
        return (info.st_dev, info.st_ino)

    modules = loaded_modules()
    owner = modules.get("openwrangler_runtime")
    lifetime = None
    inserted_path = None
    verified = False
    if modules:
        if type(owner) is not types.ModuleType or "openwrangler_runtime.kernel_agent" not in modules:
            return "outdated"
        provenance = owner.__dict__.get("__openwrangler_bundle_provenance__")
        if (
            type(provenance) is not tuple or len(provenance) != 3
            or type(provenance[0]) is not str or provenance[0] != expected_id
            or type(provenance[1]) is not tempfile.TemporaryDirectory
            or type(provenance[2]) is not tuple or len(provenance[2]) != 2
            or any(type(value) is not int for value in provenance[2])
        ):
            return "outdated"
        lifetime = provenance[1]
        root = pathlib.Path(lifetime.name)
        try:
            if not safe_parent(root.parent) or private_directory(root) != provenance[2]:
                return "outdated"
        except OSError:
            return "outdated"
        if not matches_modules(root, modules):
            return "outdated"
        verified = True
    else:
        try:
            selected = pathlib.Path(tempfile.gettempdir())
            parent = pathlib.Path(os.path.abspath(selected)) if os.name == "nt" else selected.resolve(strict=True)
            if not safe_parent(parent):
                return "unsafe_temp"
        except OSError:
            return "unsafe_temp"
        lifetime = tempfile.TemporaryDirectory(prefix="openwrangler-runtime-", dir=str(parent))
        root = pathlib.Path(lifetime.name)

    try:
        if not verified:
            identity = private_directory(root)
            if identity is None:
                return "unsafe_temp"
            for relative, source in files.items():
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source, encoding="utf-8")
            inserted_path = str(root)
            sys.path.insert(0, inserted_path)
            importlib.import_module("openwrangler_runtime.kernel_agent")
            modules = loaded_modules()
            if not matches_modules(root, modules):
                return "outdated"
            owner = modules["openwrangler_runtime"]
            owner.__openwrangler_bundle_provenance__ = (expected_id, lifetime, identity)
            verified = True
        if register_formatters:
            notebook = importlib.import_module("openwrangler_runtime.notebook")
            notebook.register_formatters()
        if not matches_modules(root, loaded_modules()):
            return "outdated"
        try:
            if private_directory(root) != owner.__openwrangler_bundle_provenance__[2]:
                return "outdated"
        except OSError:
            return "outdated"
        return "ready"
    finally:
        if not verified and lifetime is not None:
            if inserted_path is not None:
                sys.path[:] = [entry for entry in sys.path if entry is not inserted_path]
            lifetime.cleanup()
`;
  return Object.freeze({ bundleId, code });
}

export function readRuntimeFiles(runtimeRoot: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        files[path.relative(runtimeRoot, absolute).split(path.sep).join("/")] = readFileSync(absolute, "utf8");
      }
    }
  };
  visit(path.join(runtimeRoot, "openwrangler_runtime"));
  return files;
}
