import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertSealedEditorAcceptanceArtifact,
  captureEditorAcceptanceEvidenceReceipt,
  createEditorAcceptanceArtifactParent,
  sealEditorAcceptanceEvidence
} from "./editor-acceptance-artifact.mjs";
import {
  createEditorAcceptanceEnvironment,
  downloadEditorWithRetry,
  resolvePackagedVscodeAcquisitionPlan,
  waitForEditorAcceptanceObservation
} from "./editor-acceptance.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("R checkpoint timing logs only changed fixed labels without changing phase or inactivity deadlines", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-progress-timing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [];
  context.mock.method(console, "log", (line) => lines.push(line));
  for (const scenario of [
    { phase: "jupyter-r", phaseTimeoutMs: 80, timeout: "phase", elapsedMs: 80 },
    { phase: "jupyter-r", phaseTimeoutMs: 200, timeout: "inactivity", elapsedMs: 90 },
    { phase: "jupyter-allow", phaseTimeoutMs: 80, timeout: "phase", elapsedMs: 80 }
  ]) {
    lines.length = 0;
    let clock = 1_000;
    const initial = "jupyter-r:editing:text-length-preview-discard";
    const observed = await waitForEditorAcceptanceObservation({
      resultPath: join(directory, "absent-result.json"),
      progressPath: join(directory, "unused-progress.json"),
      exit: new Promise(() => {}),
      isRunning: () => true,
      now: () => clock,
      wait: async (interval) => {
        clock += interval;
      },
      phase: scenario.phase,
      phaseStartedAt: 900,
      phaseTimeoutMs: scenario.phaseTimeoutMs,
      inactivityTimeoutMs: 35,
      pollIntervalMs: 10,
      initialProgressCheckpoint: initial,
      progressReader: () => {
        if (clock >= 1_050) return "jupyter-r:coverage:platform-lifecycle:document:start";
        if (clock >= 1_040) return "1:2:0:1740000000000:1740000000000";
        if (clock >= 1_030) return "jupyter-r:editing:private-value-must-not-be-logged";
        if (clock >= 1_010) return "jupyter-r:editing:text-length-preview-apply-inspect-undo";
        return initial;
      }
    });
    assert.deepEqual(observed, { kind: "timeout", timeout: scenario.timeout, elapsedMs: scenario.elapsedMs });
    assert.deepEqual(
      lines,
      scenario.phase === "jupyter-r"
        ? [
            "R editor checkpoint observed at 110 ms: jupyter-r:editing:text-length-preview-apply-inspect-undo",
            "R editor checkpoint observed at 150 ms: jupyter-r:coverage:platform-lifecycle:document:start"
          ]
        : []
    );
  }

  for (const profile of ["comprehensive", "platform-lifecycle"]) {
    lines.length = 0;
    let clock = 1_000;
    const collapseCheckpoints = ["collapse_frame", "collapse_tibble", "collapse_table"].flatMap((frame) =>
      ["start", "notebook-shown", "selection-submitted", "complete"].map(
        (stage) => `jupyter-r:coverage:${profile}:native-frame:${frame}:view-open:${stage}`
      )
    );
    const checkpoints = [
      "jupyter-r:editing:text-length-preview-discard",
      ...collapseCheckpoints,
      `jupyter-r:coverage:${profile}:native-frame:private-fixture:view-open:start`,
      `jupyter-r:coverage:${profile}:native-frame:collapse_frame_private:view-open:start`,
      `jupyter-r:coverage:${profile}:native-frame:collapse_frame:view-open:complete:private-value`,
      `jupyter-r:coverage:${profile}:native-frame:collapse_frame:view-page:complete`,
      `jupyter-r:coverage:${profile}:native-frame:collapse_frame:view-cleanup:complete`,
      "jupyter-r:coverage:representative:native-frame:collapse_frame:view-open:start"
    ];
    const observed = await waitForEditorAcceptanceObservation({
      resultPath: join(directory, "absent-result.json"),
      progressPath: join(directory, "unused-progress.json"),
      exit: new Promise(() => {}),
      isRunning: () => true,
      now: () => clock,
      wait: async (interval) => {
        clock += interval;
      },
      phase: "jupyter-r",
      phaseStartedAt: 900,
      phaseTimeoutMs: 500,
      inactivityTimeoutMs: 35,
      pollIntervalMs: 10,
      initialProgressCheckpoint: checkpoints[0],
      progressReader: () => checkpoints[Math.min(Math.floor((clock - 1_000) / 20), checkpoints.length - 1)]
    });
    assert.deepEqual(observed, { kind: "timeout", timeout: "inactivity", elapsedMs: 400 });
    assert.deepEqual(
      lines,
      collapseCheckpoints.map(
        (checkpoint, index) => `R editor checkpoint observed at ${120 + index * 20} ms: ${checkpoint}`
      )
    );
  }
});

test("sealed failure evidence is re-redacted and identity-pinned through handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-evidence-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-stable-verify-attempt-1");
    const credential = "artifact-credential-must-not-survive";
    const privateMaterial = "artifact-private-material-must-not-survive";
    await mkdir(join(target, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), JSON.stringify({ message: `Authorization: Bearer ${credential}` }));
    await writeFile(
      join(target, "logs", "001-renderer.log"),
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${privateMaterial}\n`
    );

    const sourceReceipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    const artifactReceipt = sealEditorAcceptanceEvidence({
      evidenceRoot,
      artifactParent,
      receipts: [sourceReceipt]
    });
    const artifactPath = assertSealedEditorAcceptanceArtifact(artifactReceipt);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes(credential), false);
    assert.equal(serialized.includes(privateMaterial), false);
    assert.match(serialized, /<redacted>/u);
    assert.match(serialized, /<sealed-source-omitted-sensitive-content>/u);

    await writeFile(artifactPath, "{}\n");
    assert.throws(() => assertSealedEditorAcceptanceArtifact(artifactReceipt), /pinned identity|changed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged VS Code acquisition honors explicit versions and otherwise reuses or downloads stable", async () => {
  const configuredExecutable = "/opt/openwrangler/code";
  const configuredCli = "/opt/openwrangler/code-cli";
  const defaultExecutable = "/usr/share/code/code";
  const defaultCli = "/usr/share/code/bin/code";
  const existingPaths = new Set([configuredExecutable, configuredCli, defaultExecutable, defaultCli]);
  const pathExists = (candidate) => existingPaths.has(candidate);

  for (const version of ["1.106.0", "stable"]) {
    assert.deepEqual(
      resolvePackagedVscodeAcquisitionPlan(
        {
          VSCODE_TEST_VERSION: version,
          OPEN_WRANGLER_VSCODE_EXECUTABLE: configuredExecutable,
          OPEN_WRANGLER_VSCODE_CLI: configuredCli
        },
        pathExists
      ),
      { kind: "download", version }
    );
  }

  assert.deepEqual(
    resolvePackagedVscodeAcquisitionPlan(
      {
        OPEN_WRANGLER_VSCODE_EXECUTABLE: configuredExecutable,
        OPEN_WRANGLER_VSCODE_CLI: configuredCli
      },
      pathExists
    ),
    {
      kind: "existing",
      editor: {
        name: "VS Code",
        key: "vscode",
        executable: configuredExecutable,
        cli: configuredCli,
        sharedDataDir: true
      }
    }
  );
  assert.deepEqual(resolvePackagedVscodeAcquisitionPlan({}, pathExists), {
    kind: "existing",
    editor: {
      name: "VS Code",
      key: "vscode",
      executable: defaultExecutable,
      cli: defaultCli,
      sharedDataDir: true
    }
  });
  assert.deepEqual(
    resolvePackagedVscodeAcquisitionPlan({}, () => false),
    { kind: "download", version: "stable" }
  );

  assert.throws(() => resolvePackagedVscodeAcquisitionPlan(null, pathExists), /environment object/u);
  assert.throws(() => resolvePackagedVscodeAcquisitionPlan({}, undefined), /path-existence function/u);
  const malformedPlan = resolvePackagedVscodeAcquisitionPlan({ VSCODE_TEST_VERSION: "../moving" }, pathExists);
  await assert.rejects(() => downloadEditorWithRetry(malformedPlan.version), /download version/u);
});

for (const failure of [false, true]) {
  test(`isolated editor downloader releases rejected sockets after ${failure ? "failure" : "success"}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "openwrangler-download-socket-"));
    let responseClosed;
    const closed = new Promise((resolveClosed) => {
      responseClosed = resolveClosed;
    });
    const server = createServer((_request, response) => {
      response.on("close", responseClosed);
      response.writeHead(503, { "content-length": "2" });
      response.write("x");
    });
    context.after(async () => {
      server.closeAllConnections();
      await new Promise((resolveClosed) => server.close(resolveClosed));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListening);
    });
    const completed = promisify(execFile)(
      process.execPath,
      [
        "--import",
        join(repositoryRoot, "scripts", "test-fixtures", "editor-download-sockets.mjs"),
        join(repositoryRoot, "scripts", "download-editor.mjs"),
        "1.106.0"
      ],
      {
        cwd: directory,
        env: {
          ...createEditorAcceptanceEnvironment(),
          HOME: directory,
          USERPROFILE: directory,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          EDITOR_DOWNLOAD_TEST_PORT: String(server.address().port),
          EDITOR_DOWNLOAD_TEST_DIRECTORY: directory,
          EDITOR_DOWNLOAD_TEST_FAILURE: String(failure)
        },
        timeout: 2_000,
        maxBuffer: 32 * 1024,
        windowsHide: true
      }
    );
    const { stdout, stderr } = await completed;
    assert.equal(completed.child.killed, false);
    assert.equal(completed.child.signalCode, null);
    assert.equal(stderr, "");
    assert.equal(
      stdout,
      `${JSON.stringify(
        failure
          ? { protocol: 1, ok: false, error: "Synthetic download failure" }
          : { protocol: 1, ok: true, executablePath: join(directory, "code") }
      )}\n`
    );
    assert.equal(await readFile(join(directory, "completed"), "utf8"), "complete\n");
    await closed;
  });
}

test("packaged-editor workflows upload only exact revalidated emitted artifact paths", async () => {
  const runner = await readFile(join(repositoryRoot, "scripts", "run-packaged-editor-tests.mjs"), "utf8");
  assert.match(
    runner,
    /if \(process\.env\.GITHUB_OUTPUT\) \{\s*assertSealedEditorAcceptanceArtifact\(artifactReceipt\);\s*appendFileSync\(\s*process\.env\.GITHUB_OUTPUT,\s*`evidence_ready=true\\nevidence_path=\$\{artifactPath\}\\nevidence_sha256=\$\{artifactReceipt\.sha256\}\\nevidence_size=\$\{String\(artifactReceipt\.snapshot\.size\)\}\\n`,\s*"utf8"\s*\);/u
  );

  const workflow = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const steps = topLevelWorkflowSteps(workflow);
  const producerIndex = steps.findIndex((step) => /\bid:\s*packaged_editor\s*$/mu.test(step));
  assert.notEqual(producerIndex, -1);
  const upload = steps[producerIndex + 1];
  assert.match(upload, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(upload, /steps\.packaged_editor\.outputs\.evidence_ready\s*==\s*'true'/u);
  assert.match(upload, /path:\s*\$\{\{\s*steps\.packaged_editor\.outputs\.evidence_path\s*\}\}\s*$/mu);
  assert.match(upload, /if-no-files-found:\s*error\s*$/mu);
  assert.match(upload, /retention-days:\s*7\s*$/mu);
  assert.doesNotMatch(upload, /\n\s*path:\s*\|/u);

  const releaseCandidateWorkflow = await readFile(
    join(repositoryRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8"
  );
  const releaseCandidateSteps = topLevelWorkflowSteps(releaseCandidateWorkflow);
  const cursorProducerIndex = releaseCandidateSteps.findIndex((step) =>
    /\bid:\s*cursor_platform_smoke\s*$/mu.test(step)
  );
  assert.notEqual(cursorProducerIndex, -1);
  const cursorProducer = releaseCandidateSteps[cursorProducerIndex];
  assert.match(cursorProducer, /OPEN_WRANGLER_PACKAGED_EDITORS:\s*cursor\s*$/mu);
  assert.match(cursorProducer, /OPEN_WRANGLER_PACKAGED_MODE:\s*platform-smoke\s*$/mu);

  const cursorUpload = releaseCandidateSteps[cursorProducerIndex + 1];
  assert.match(cursorUpload, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(cursorUpload, /!cancelled\(\)/u);
  assert.match(cursorUpload, /steps\.cursor_platform_smoke\.outcome\s*==\s*'failure'/u);
  assert.match(cursorUpload, /steps\.cursor_platform_smoke\.outputs\.evidence_ready\s*==\s*'true'/u);
  assert.match(cursorUpload, /path:\s*\$\{\{\s*steps\.cursor_platform_smoke\.outputs\.evidence_path\s*\}\}\s*$/mu);
  assert.match(cursorUpload, /if-no-files-found:\s*error\s*$/mu);
  assert.match(cursorUpload, /retention-days:\s*7\s*$/mu);
  assert.doesNotMatch(cursorUpload, /\n\s*path:\s*\|/u);
});

function topLevelWorkflowSteps(source) {
  const lines = source.split(/\r?\n/u);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{6}- (?:id:|name:|uses:|run:|if:)/u.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
}
