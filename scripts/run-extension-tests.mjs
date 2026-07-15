import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostedPython = process.env.pythonLocation
  ? process.platform === "win32"
    ? resolve(process.env.pythonLocation, "python.exe")
    : resolve(process.env.pythonLocation, "bin", "python")
  : undefined;
const localPython =
  process.platform === "win32"
    ? resolve(root, ".venv", "Scripts", "python.exe")
    : resolve(root, ".venv", "bin", "python");
process.env.DATA_EXPLORER_TEST_PYTHON ??=
  hostedPython && existsSync(hostedPython)
    ? hostedPython
    : existsSync(localPython)
      ? localPython
      : process.platform === "win32"
        ? "python"
        : "python3";
const profile = mkdtempSync(join(tmpdir(), "data-explorer-extension-host-"));
const requestedVersion = process.env.VSCODE_TEST_VERSION;
const installedExecutable = "/usr/share/code/code";
const vscodeExecutablePath = requestedVersion
  ? await downloadAndUnzipVSCode(requestedVersion)
  : existsSync(installedExecutable)
    ? installedExecutable
    : await downloadAndUnzipVSCode("stable");

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "dist-test", "test", "extensionHost", "index.js"),
    launchArgs: [
      root,
      "--user-data-dir",
      resolve(profile, "user-data"),
      "--extensions-dir",
      resolve(profile, "extensions"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      ...(process.platform === "linux" ? ["--no-sandbox"] : [])
    ]
  });
} finally {
  rmSync(profile, { recursive: true, force: true });
}
