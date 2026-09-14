// Temporary hosted discovery. Reuse existing editor acquisition, environment and cleanup owners.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values: args } = parseArgs({ options: Object.fromEntries(["repo", "artifact", "python", "out"].map((name) => [name, { type: "string" }])) });
for (const name of ["repo", "artifact", "python", "out"]) assert(args[name], `Missing --${name}`);
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "Linux", "Hosted Linux only");
const repo = realpathSync(args.repo), artifact = realpathSync(args.artifact), python = resolve(args.python), out = resolve(args.out);
assert(!existsSync(out), "Do not replace an earlier discovery");
mkdirSync(out, { recursive: true, mode: 0o700 });
const load = (file) => import(pathToFileURL(join(repo, "scripts", file)).href);
const owner = await load("editor-acceptance.mjs"), roots = await load("packaged-editor-orchestration.mjs");
const acquisition = await load("remote-workspace-acquisition.mjs");
const { withPinnedCanonicalReleaseAssets } = await load("canonical-release-assets.mjs");
const { verifyPinnedCanonicalReleaseArtifact } = await load("verify-canonical-release-artifact.mjs");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const sourceCommit = "b1ccf7d67c979741adfeab2ecc6a28aa8665089f";
await withPinnedCanonicalReleaseAssets(artifact, (pinned) => verifyPinnedCanonicalReleaseArtifact({
  directory: artifact, pinned, expectedCommit: sourceCommit, sourceCommit,
  sourcePackageJson: execFileSync("git", ["show", `${sourceCommit}:package.json`], { cwd: repo, encoding: "utf8", timeout: 10000 }), releaseTag: "v2.4.0"
}));
assert.equal(sha(join(artifact, "openwrangler.vsix")), "9188fb7ccb836c8d4bc62372adb46d81c2e82aa998404b066fc31f1b51b5bc48");
const report = {
  purpose: "single-dw-polars-control-discovery", productResult: "not a paired measurement",
  owTarget: { version: "2.4.0", sourceCommit, sha256: sha(join(artifact, "openwrangler.vsix")), executed: false },
  toolingCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 10000 }).trim(),
  tooling: Object.fromEntries(["launch.mjs", "driver.cjs"].map((file) => [file, sha(join(import.meta.dirname, file))])),
  image: { os: process.env.ImageOS ?? null, version: process.env.ImageVersion ?? null },
  caps: { uiPhaseMs: 120000, uiInactivityMs: 60000, productSelectorMs: 15000, clickMs: 5000, attempts: 1 }
};
const runRoot = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "ow-dw-discovery-"));
const rootReceipt = roots.createEditorAcceptancePrivateRootReceipt(runRoot);
const environment = { ...process.env, OPEN_WRANGLER_EDITOR_DISPLAY: "headless" };
owner.configureEditorAcceptanceTempRoot(runRoot, environment);
let display, mayBeLive = false, phasePassed = false;
try {
  const client = await acquisition.acquirePinnedVSCodeClient(runRoot, { inspectionPython: python });
  report.editor = { version: acquisition.PINNED_VSCODE_VERSION, commit: acquisition.PINNED_VSCODE_COMMIT, archiveSha256: client.target.decodedSha256 };
  const workspace = join(runRoot, "workspace"), userData = join(runRoot, "user"), extensions = join(runRoot, "extensions"), harness = join(runRoot, "harness");
  for (const directory of [workspace, userData, extensions]) mkdirSync(directory);
  const cli = (extra) => owner.runBoundedEditorCliCommand({
    editor: client.editor, args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--no-sandbox", ...extra],
    environment: owner.createEditorAcceptanceEnvironment(environment), label: "Public discovery extension setup"
  }, { timeoutMs: 180000, maxOutputBytes: 32768 });
  // The official Marketplace CLI obtains the current stable DW release; installation is opaque.
  for (const id of ["ms-python.python@2026.4.0", "ms-toolsai.jupyter@2025.9.1", "ms-toolsai.datawrangler"])
    await cli(["--install-extension", id, "--force"]);
  const versions = async () => (await cli(["--list-extensions", "--show-versions"])).stdout.trim().split(/\r?\n/).filter((line) => /^[\w.-]+@[\w.+-]+$/.test(line)).sort();
  report.extensions = await versions();
  assert(report.extensions.includes("ms-python.python@2026.4.0"));
  assert(report.extensions.includes("ms-toolsai.jupyter@2025.9.1"));
  assert.equal(report.extensions.filter((s) => /^ms-toolsai\.datawrangler@\d+\.\d+\.\d+$/.test(s)).length, 1);
  owner.writeEditorAcceptanceHarness(harness);
  owner.writeEditorSettings(userData, {
    "python.defaultInterpreterPath": python,
    "dataWrangler.startInEditModeForNotebookEntrypoints": true,
    "openWrangler.notebookStartMode": "editing",
    "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false, "workbench.startupEditor": "none", "window.zoomLevel": 0,
    "window.newWindowDimensions": "fullscreen", "window.dialogStyle": "custom", "files.simpleDialog.enable": true
  });
  const fixture = [
    "import polars as pl, hashlib, json, sys, importlib.metadata",
    "comparison_frame = pl.DataFrame({'id': range(100000), 'text': ['North', 'SOUTH', 'East', 'WEST'] * 25000})",
    "comparison_digest = hashlib.sha256(comparison_frame.write_csv().encode()).hexdigest()",
    "print('DISCOVERY_READY:' + json.dumps({'shape': comparison_frame.shape, 'digest': comparison_digest, 'python': sys.version.split()[0], 'packages': {name: importlib.metadata.version(name) for name in ['polars', 'pandas', 'numpy', 'pyarrow', 'ipykernel']}}))"
  ].join("\n");
  const check = "assert hashlib.sha256(comparison_frame.write_csv().encode()).hexdigest() == comparison_digest\nprint('DISCOVERY_UNCHANGED:' + json.dumps({'shape': comparison_frame.shape, 'digest': comparison_digest}))";
  json(join(workspace, "comparison.ipynb"), {
    nbformat: 4, nbformat_minor: 5,
    metadata: { kernelspec: { display_name: "Python 3.12 (Public comparison)", language: "python", name: "public-comparison" } },
    cells: [fixture, check].map((source, i) => ({ id: `discovery-${i}`, cell_type: "code", metadata: {}, source, outputs: [], execution_count: null }))
  });
  json(join(workspace, "request.json"), { repo, out });
  const jupyterEnvironment = Object.fromEntries(["dataDir", "runtimeDir", "configDir", "path"].map((name) => {
    const directory = join(runRoot, name); mkdirSync(directory); return [name, directory];
  }));
  const kernel = join(jupyterEnvironment.dataDir, "kernels", "public-comparison");
  mkdirSync(kernel, { recursive: true });
  json(join(kernel, "kernel.json"), { argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"], display_name: "Python 3.12 (Public comparison)", language: "python" });
  display = await owner.startIsolatedEditorDisplay({ environment });
  await owner.runEditorAcceptancePhase({
    editor: client.editor, workspace, userData, extensions, developmentPaths: [harness], testModule: join(import.meta.dirname, "driver.cjs"), python,
    phase: "public-comparison", requiresWorkbenchCdp: true, resultPath: join(runRoot, "acceptance.json"), editorProductVersion: acquisition.PINNED_VSCODE_VERSION, jupyterEnvironment
  }, {
    environment, phaseTimeoutMs: 120000, inactivityTimeoutMs: 60000,
    spawnProcess: (exe, argv, options, ownership) => {
      const env = { ...options.env }; delete env.OPEN_WRANGLER_EXTENSION_TESTS;
      return owner.spawnOwnedEditorProcess(exe, argv, { ...options, env }, ownership);
    }
  });
  assert.deepEqual(await versions(), report.extensions, "Extension versions changed");
  phasePassed = true;
} catch (error) {
  mayBeLive = owner.editorProcessTreeMayBeLive(error);
  report.failure = { name: error.name, kind: error.kind ?? null, message: owner.sanitizeEditorAcceptanceDiagnostic(new Error(error.message), [repo, out, runRoot, python]).slice(0, 1000) };
} finally {
  try { await display?.stop({ preservePrivateFiles: mayBeLive }); }
  catch { mayBeLive = true; report.displayCleanupFailed = true; }
  report.cleanupVerified = false;
  if (!mayBeLive) {
    try { roots.removeEditorAcceptancePrivateRoot(rootReceipt, { processTreeVerifiedStopped: true }); report.cleanupVerified = true; }
    catch { report.rootCleanupFailed = true; }
  }
  report.phasePassed = phasePassed;
  json(join(out, "launcher.json"), report);
}
if (!phasePassed || !report.cleanupVerified) process.exitCode = 1;
