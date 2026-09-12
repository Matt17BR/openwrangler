// Temporary hosted public-UI comparison. No package build or competitor package reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values: args } = parseArgs({
  options: Object.fromEntries(
    ["repo", "artifact", "python", "out", "mode", "freeze"].map((name) => [name, { type: "string" }])
  )
});
for (const key of ["repo", "artifact", "python", "out", "mode"]) assert(args[key], `Missing --${key}`);
assert(process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "Linux", "Hosted Linux only");
assert.equal(args.mode, "pilot", "Temporary entry diagnostic rejects study");
assert(args.mode !== "study" || args.freeze, "Study requires a reviewed passing pilot freeze");
// Keep the venv launcher path: resolving its Python symlink would select the base environment.
const repo = realpathSync(args.repo),
  python = resolve(args.python),
  artifact = realpathSync(args.artifact);
realpathSync(python);
const out = resolve(args.out),
  sources = import.meta.dirname;
assert(!existsSync(out), "Output must be new; never overwrite prior evidence");
mkdirSync(out, { recursive: true, mode: 0o700 });
const load = (name) => import(pathToFileURL(join(repo, "scripts", name)).href);
const owner = await load("editor-acceptance.mjs");
const roots = await load("packaged-editor-orchestration.mjs");
const acquisition = await load("remote-workspace-acquisition.mjs");
const provenance = await load("installed-performance-system.mjs");
const { withPinnedCanonicalReleaseAssets } = await load("canonical-release-assets.mjs");
const { verifyPinnedCanonicalReleaseArtifact } = await load("verify-canonical-release-artifact.mjs");
const { readBoundedRegularFile } = await load("bounded-file-read.mjs");
const { parseStrictJson } = await load("strict-json.mjs");
const privatePaths = [repo, out];
const failure = (error, stage) => ({
  stage,
  name: error.name,
  message: owner.sanitizeEditorAcceptanceDiagnostic(new Error(error.message), privatePaths).slice(0, 1000)
});
const validMeasurements = (m, id) => {
  assert.equal(m.id, id);
  assert.equal(m.status, "passed");
  assert.equal(m.samples.length, 2);
  assert.equal(m.setup.kernelIdentityVerified, true);
  assert.match(m.setup.sourceDigest, /^[a-f0-9]{64}$/u);
  for (const [i, s] of m.samples.entries()) {
    assert.equal(s.name, ["fresh-session-first-open", "same-session-reopen"][i]);
    assert.equal(s.status, "passed");
    assert.equal(s.completedProfiles, 20);
    assert.equal(s.profileObservations.length, 20);
    assert.equal(s.kernelContinuityVerified, true);
    assert.equal(s.entryRoute, id.endsWith("-ow") ? "inline-open" : "notebook-view-data");
    assert.equal(typeof s.toolbarOverflowUsed, "boolean");
    assert(Number.isFinite(s.metrics.entryMs) && s.metrics.entryMs >= s.metrics.pickerMs);
    assert(Number.isFinite(s.metrics.pickerMs) && s.metrics.pickerMs >= 0);
    if (s.entryRoute === "inline-open") assert(s.metrics.pickerMs === 0 && !s.toolbarOverflowUsed);
    assert.equal(s.actions.length, 2);
    assert(s.fullShapeVerified && s.laterRowVerified && s.renderedResultVerified);
    for (const value of [s.preEntryConsentMs, s.afterEntryConsentMs]) assert(Number.isFinite(value) && value >= 0);
    assert(s.metrics.usableGridMs >= s.metrics.firstRowMs);
    for (const n of [
      s.metrics.firstRowMs,
      s.metrics.usableGridMs,
      s.metrics.allProfilesMs,
      s.metrics.laterRowMs,
      s.metrics.editingModeMs,
      ...s.actions.flatMap((a) => [a.previewMs, a.applyMs])
    ])
      assert(Number.isFinite(n) && n >= 0);
    assert.deepEqual(
      s.actions.map((a) => a.title),
      ["Fill missing values", "Lowercase"]
    );
    assert(s.oracle.completeFrameEqual && s.oracle.sourceUnchanged && s.oracle.inputUnchanged);
    assert.equal(s.oracle.invocations, 1);
    assert(["script", "function"].includes(s.oracle.route));
    assert.match(s.oracle.codeSha256, /^[a-f0-9]{64}$/u);
    assert.match(s.oracle.resultDigest, /^[a-f0-9]{64}$/u);
  }
};
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600
  });
const sourceCommit = "b1ccf7d67c979741adfeab2ecc6a28aa8665089f";
const sourcePackageJson = execFileSync("git", ["show", `${sourceCommit}:package.json`], {
  cwd: repo,
  encoding: "utf8",
  timeout: 10_000,
  maxBuffer: 1024 * 1024
});
await withPinnedCanonicalReleaseAssets(artifact, (pinned) =>
  verifyPinnedCanonicalReleaseArtifact({
    directory: artifact,
    pinned,
    expectedCommit: sourceCommit,
    sourceCommit,
    sourcePackageJson,
    releaseTag: "v2.4.0"
  })
);
assert.equal(
  sha(join(artifact, "openwrangler.vsix")),
  "9188fb7ccb836c8d4bc62372adb46d81c2e82aa998404b066fc31f1b51b5bc48"
);
const report = {
  purpose: "public-entry-diagnostic",
  mode: args.mode,
  artifact: {
    sourceCommit,
    version: "2.4.0",
    sha256: sha(join(artifact, "openwrangler.vsix"))
  },
  toolingCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10_000
  }).trim(),
  sourceHashes: Object.fromEntries(["launcher.mjs", "driver.cjs", "fixture.py"].map((f) => [f, sha(join(sources, f))])),
  image: {
    os: process.env.ImageOS ?? null,
    version: process.env.ImageVersion ?? null
  },
  platform: provenance.readInstalledPlatformProvenance({
    editorDisplayMode: "xvfb"
  }),
  sessions: []
};
const runRoot = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "ow-public-comparison-"));
const rootReceipt = roots.createEditorAcceptancePrivateRootReceipt(runRoot);
privatePaths.push(runRoot);
let interruptedSignal;
const signalListeners = ["SIGINT", "SIGTERM"].map((signal) => {
  const listener = () => {
    interruptedSignal = signal;
  };
  process.on(signal, listener);
  return [signal, listener];
});
const requireUninterrupted = () => {
  if (interruptedSignal) throw new Error(`Experiment interrupted by ${interruptedSignal}; no next phase`);
};
let mayBeLive = false,
  client;
try {
  report.storage = provenance.readInstalledStorageProvenance(runRoot);
  requireUninterrupted();
  client = await acquisition.acquirePinnedVSCodeClient(runRoot, {
    inspectionPython: python
  });
  report.editor = {
    version: acquisition.PINNED_VSCODE_VERSION,
    commit: acquisition.PINNED_VSCODE_COMMIT,
    archiveSha256: client.target.decodedSha256
  };
  const runtimeIdentity = JSON.parse(
    execFileSync(python, [join(sources, "fixture.py"), "--versions"], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024
    })
  );
  assert.equal(resolve(runtimeIdentity.executable), python);
  assert.notEqual(runtimeIdentity.prefix, runtimeIdentity.basePrefix, "Locked venv required");
  report.runtime = {
    python: runtimeIdentity.python,
    packages: runtimeIdentity.packages
  };
  assert.equal(report.runtime.python, "3.12.14");
  for (const [name, version] of Object.entries({
    pandas: "2.3.3",
    numpy: "2.5.1",
    ipykernel: "6.30.1",
    pyarrow: "25.0.1"
  }))
    assert(
      report.runtime.packages.some(([n, v]) => n === name && v === version),
      `Wrong ${name}`
    );
  const prepared = new Map();
  for (const product of ["ow", "dw"]) {
    const base = join(runRoot, `install-${product}`);
    mkdirSync(base, { mode: 0o700 });
    const env = { ...process.env, OPEN_WRANGLER_EDITOR_DISPLAY: "headless" };
    owner.configureEditorAcceptanceTempRoot(base, env);
    const extensions = join(base, "extensions"),
      userData = join(base, "user");
    mkdirSync(extensions);
    mkdirSync(userData);
    const cli = async (extra) => {
      requireUninterrupted();
      return owner.runBoundedEditorCliCommand(
        {
          editor: client.editor,
          args: ["--user-data-dir", userData, "--extensions-dir", extensions, "--no-sandbox", ...extra],
          environment: owner.createEditorAcceptanceEnvironment(env),
          label: `Public comparison ${product} installation`
        },
        { timeoutMs: 180_000, maxOutputBytes: 32 * 1024 }
      );
    };
    try {
      for (const id of [
        "ms-python.python@2026.4.0",
        "ms-toolsai.jupyter@2025.9.1",
        product === "ow" ? join(artifact, "openwrangler.vsix") : "ms-toolsai.datawrangler@1.24.2"
      ])
        await cli(["--install-extension", id, "--force"]);
      const readVersions = async () =>
        (await cli(["--list-extensions", "--show-versions"])).stdout
          .trim()
          .split(/\r?\n/u)
          .filter((line) => /^[\w.-]+@[\w.+-]+$/u.test(line))
          .sort();
      const versions = await readVersions();
      for (const expected of [
        "ms-python.python@2026.4.0",
        "ms-toolsai.jupyter@2025.9.1",
        product === "ow" ? "matt17br.openwrangler@2.4.0" : "ms-toolsai.datawrangler@1.24.2"
      ])
        assert(
          versions.some((v) => v.toLowerCase() === expected),
          `Missing ${expected}`
        );
      prepared.set(product, { extensions, versions, readVersions });
    } catch (error) {
      mayBeLive ||= owner.editorProcessTreeMayBeLive(error);
      prepared.set(product, {
        setupFailure: failure(error, `install-${product}`)
      });
      if (mayBeLive || interruptedSignal || error.kind === "interrupted") throw error;
    }
  }
  report.extensions = Object.fromEntries([...prepared].map(([p, v]) => [p, v.versions ?? null]));
  if (prepared.get("ow").versions && prepared.get("dw").versions) {
    const common = (v) => v.filter((s) => !/^(matt17br.openwrangler|ms-toolsai.datawrangler)@/iu.test(s));
    assert.deepEqual(
      common(prepared.get("ow").versions),
      common(prepared.get("dw").versions),
      "Common extension drift"
    );
  }
  const freeze = {
    toolingCommit: report.toolingCommit,
    sourceHashes: report.sourceHashes,
    artifact: report.artifact,
    editor: report.editor,
    runtime: report.runtime,
    extensions: report.extensions
  };
  if (args.mode === "study")
    assert.deepEqual(JSON.parse(readFileSync(args.freeze, "utf8")), freeze, "Pilot freeze drift");
  const pairs = args.mode === "pilot" ? 1 : 4;
  for (const rows of [100_000, 1_000_000])
    for (let pair = 0; pair < pairs; pair++) {
      for (const product of ["dw"]) {
        requireUninterrupted();
        const id = `${rows}-${pair}-${product}`,
          session = { id, rows, pair, product, status: "pending" };
        report.sessions.push(session);
        if (prepared.get(product).setupFailure) {
          Object.assign(session, {
            status: "setup-failed",
            failure: prepared.get(product).setupFailure
          });
          json(join(out, `${id}.json`), session);
          continue;
        }
        const base = join(runRoot, id);
        mkdirSync(base, { mode: 0o700 });
        const receipt = roots.createEditorAcceptancePrivateRootReceipt(base, {
          containedBy: runRoot
        });
        const env = { ...process.env, OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb" };
        owner.configureEditorAcceptanceTempRoot(base, env);
        const workspace = join(base, "workspace"),
          userData = join(base, "user"),
          harness = join(base, "harness");
        mkdirSync(workspace);
        mkdirSync(userData);
        copyFileSync(join(sources, "fixture.py"), join(workspace, "fixture.py"));
        execFileSync(python, [join(workspace, "fixture.py"), String(rows), workspace], { timeout: 30_000 });
        json(join(workspace, "request.json"), {
          product,
          mode: args.mode,
          rows,
          repo,
          python,
          runtimeIdentity,
          id
        });
        owner.writeEditorAcceptanceHarness(harness);
        owner.writeEditorSettings(userData, {
          "python.defaultInterpreterPath": python,
          "openWrangler.pythonPath": python,
          "openWrangler.notebookPreviewProvider": "openWrangler",
          "telemetry.telemetryLevel": "off",
          "update.mode": "none",
          "extensions.autoUpdate": false,
          "extensions.autoCheckUpdates": false,
          "workbench.startupEditor": "none",
          "window.zoomLevel": 0,
          "window.dialogStyle": "custom",
          "files.simpleDialog.enable": true
        });
        const jupyterEnvironment = Object.fromEntries(
          ["dataDir", "runtimeDir", "configDir", "path"].map((k) => {
            const p = join(base, k);
            mkdirSync(p);
            return [k, p];
          })
        );
        const kernel = join(jupyterEnvironment.dataDir, "kernels", "public-comparison");
        mkdirSync(kernel, { recursive: true });
        json(join(kernel, "kernel.json"), {
          argv: [python, "-I", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
          display_name: "Python 3.12 (Public comparison)",
          language: "python"
        });
        let display,
          interruption,
          settled = true;
        try {
          display = await owner.startIsolatedEditorDisplay({
            environment: env
          });
          requireUninterrupted();
          await owner.runEditorAcceptancePhase(
            {
              editor: client.editor,
              workspace,
              userData,
              extensions: prepared.get(product).extensions,
              developmentPaths: [harness],
              testModule: join(sources, "driver.cjs"),
              python,
              phase: "public-comparison",
              requiresWorkbenchCdp: true,
              resultPath: join(base, "acceptance.json"),
              editorProductVersion: acquisition.PINNED_VSCODE_VERSION,
              jupyterEnvironment
            },
            {
              environment: env,
              spawnProcess: (exe, argv, options, ownership) => {
                const cleanEnv = { ...options.env };
                delete cleanEnv.OPEN_WRANGLER_EXTENSION_TESTS;
                return owner.spawnOwnedEditorProcess(exe, argv, { ...options, env: cleanEnv }, ownership);
              }
            }
          );
          session.status = "passed";
        } catch (error) {
          if (error.kind === "interrupted") interruption = error;
          settled = !owner.editorProcessTreeMayBeLive(error);
          mayBeLive ||= !settled;
          Object.assign(session, {
            status: "failed",
            failure: failure(error, id)
          });
        } finally {
          try {
            const result = join(workspace, "measurements.json");
            session.measurements = parseStrictJson(
              readBoundedRegularFile(result, 128 * 1024, {
                containedBy: workspace,
                label: "Public UI receipt"
              }).toString("utf8"),
              { maxBytes: 128 * 1024 }
            );
            if (session.status === "passed") validMeasurements(session.measurements, id);
          } catch (error) {
            session.status = "failed";
            session.receiptFailure = failure(error, `${id}:receipt`);
          } finally {
            try {
              await display?.stop({ preservePrivateFiles: !settled });
            } catch (error) {
              mayBeLive = true;
              session.status = "cleanup-failed";
              session.cleanupFailure = failure(error, id);
            }
            if (!mayBeLive)
              roots.removeEditorAcceptancePrivateRoot(receipt, {
                processTreeVerifiedStopped: settled
              });
          }
        }
        json(join(out, `${id}.json`), session);
        if (interruption) throw interruption;
        if (args.mode === "study" && session.status !== "passed")
          throw new Error("Study contract failed; no next session");
        requireUninterrupted();
        if (mayBeLive) throw new Error("Owned cleanup unverified; no next phase");
      }
    }
  for (const value of prepared.values())
    if (value.readVersions)
      assert.deepEqual(
        await value.readVersions(),
        value.versions,
        "Installed extension versions changed during collection"
      );
  assert.deepEqual(
    JSON.parse(
      execFileSync(python, [join(sources, "fixture.py"), "--versions"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024
      })
    ),
    runtimeIdentity,
    "Python dependencies changed during collection"
  );
  report.dependenciesUnchanged = true;
  let pairedSourceDigestsEqual = true;
  for (const rows of [100_000, 1_000_000]) {
    const sessions = report.sessions.filter((s) => s.rows === rows);
    const digests = sessions
      .filter(
        (s) =>
          s.measurements?.id === s.id &&
          s.measurements.setup?.kernelIdentityVerified === true &&
          /^[a-f0-9]{64}$/u.test(s.measurements.setup.sourceDigest)
      )
      .map((s) => s.measurements.setup.sourceDigest);
    assert(new Set(digests).size <= 1, "Paired source digest mismatch");
    if (sessions.length !== pairs * 2 || digests.length !== sessions.length || new Set(digests).size !== 1)
      pairedSourceDigestsEqual = false;
  }
  report.pairedSourceDigestsEqual = pairedSourceDigestsEqual;
  if (pairedSourceDigestsEqual && report.sessions.every((s) => s.status === "passed"))
    json(join(out, "pilot-freeze.json"), freeze);
} catch (error) {
  report.failure = failure(error, "launcher");
  mayBeLive ||= owner.editorProcessTreeMayBeLive(error);
} finally {
  for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
  if (interruptedSignal) report.interrupted = interruptedSignal;
  report.cleanupVerified = !mayBeLive;
  if (!mayBeLive) {
    try {
      roots.removeEditorAcceptancePrivateRoot(rootReceipt);
    } catch (error) {
      report.cleanupVerified = false;
      report.cleanupFailure = failure(error, "root-cleanup");
    }
  }
  json(join(out, "report.json"), report);
}
if (
  !report.cleanupVerified ||
  report.failure ||
  report.sessions.length !== (args.mode === "pilot" ? 4 : 16) ||
  report.sessions.some((s) => s.status !== "passed")
)
  process.exitCode = 1;
