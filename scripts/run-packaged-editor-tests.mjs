import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vsix = resolve(root, process.argv[2] ?? "data-explorer.vsix");
if (!existsSync(vsix)) throw new Error(`Packaged extension not found: ${vsix}`);
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const expectedExtension = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`.toLowerCase();

const requested = process.env.DATA_EXPLORER_PACKAGED_EDITORS?.split(",").map((value) => value.trim());
const candidates = [
  {
    name: "VS Code",
    key: "vscode",
    executable: "/usr/share/code/code",
    cli: "/usr/share/code/bin/code"
  },
  {
    name: "Cursor",
    key: "cursor",
    executable: "/usr/share/cursor/cursor",
    cli: "/usr/share/cursor/bin/cursor"
  }
].filter(
  (editor) =>
    existsSync(editor.executable) && existsSync(editor.cli) && (!requested?.length || requested.includes(editor.key))
);
if (!candidates.some((editor) => editor.key === "vscode") && (!requested?.length || requested.includes("vscode"))) {
  const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION ?? "stable");
  candidates.unshift({ name: "VS Code", key: "vscode", executable, cli: executable });
}
if (!candidates.length) throw new Error("No supported VS Code or Cursor desktop executable was found.");

const localPython =
  process.platform === "win32"
    ? resolve(root, ".venv", "Scripts", "python.exe")
    : resolve(root, ".venv", "bin", "python");
process.env.DATA_EXPLORER_TEST_PYTHON ??= existsSync(localPython) ? localPython : "python";

for (const editor of candidates) {
  const profile = mkdtempSync(join(tmpdir(), `data-explorer-packaged-${editor.key}-`));
  const userData = resolve(profile, "user-data");
  const extensions = resolve(profile, "extensions");
  try {
    writeFileSync(
      resolve(profile, "package.json"),
      JSON.stringify({
        name: "data-explorer-packaged-test-harness",
        displayName: "Data Explorer packaged test harness",
        version: "0.0.0",
        publisher: "data-explorer-tests",
        engines: { vscode: "^1.105.0" },
        main: "./extension.js",
        activationEvents: ["*"]
      })
    );
    writeFileSync(resolve(profile, "extension.js"), "exports.activate = function () {};\n");
    const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
    execFileSync(
      editor.cli,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--install-extension",
        vsix,
        "--force",
        ...sandboxArgs
      ],
      { encoding: "utf8", stdio: "pipe" }
    );
    const installed = execFileSync(
      editor.cli,
      [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      { encoding: "utf8" }
    );
    if (!installed.toLowerCase().includes(expectedExtension)) {
      throw new Error(`${editor.name} did not report the installed Data Explorer package. Output: ${installed}`);
    }

    await runTests({
      vscodeExecutablePath: editor.executable,
      extensionDevelopmentPath: profile,
      extensionTestsPath: resolve(root, "dist-test", "test", "extensionHost", "index.js"),
      launchArgs: [
        root,
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        ...sandboxArgs
      ]
    });
    console.log(`${editor.name} packaged acceptance passed for ${basename(vsix)}.`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
