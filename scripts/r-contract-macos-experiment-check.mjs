// Temporary hosted diagnostic. Native compilation is an explicit prerequisite; no injected signal owner.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRContractPhasesWithSignalForwarding } from "./run-r-contract-tests.mjs";

const entry = fileURLToPath(import.meta.url);
const root = process.env.OPEN_WRANGLER_EXPERIMENT_CASE_ROOT;
const kind = process.env.OPEN_WRANGLER_EXPERIMENT_CASE;
const write = (name, value) => {
  const path = join(root, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};
const event = (role, value) => appendFileSync(join(root, `${role}-events`), `${value}\n`);

export function fixture(role = "root") {
  assert.ok(root && kind);
  const owner = process.env.OPEN_WRANGLER_R_CONTRACT_OWNER;
  assert.ok(owner, "real runner phase marker required");
  for (const name of ["SIGINT", "SIGTERM"]) {
    process.on(name, () => {
      event(role, name);
      if (role !== "detached") process.exit(0);
    });
  }
  // A fixed fixture expiry makes failed experiments disposable; never a cleanup assertion.
  setTimeout(() => {
    event(role, "natural-expiry");
    process.exit(0);
  }, 4000);
  if (kind === "detached-ignore" && role === "root") {
    spawn(process.execPath, [entry, "fixture", "detached"], {
      env: process.env,
      detached: true,
      stdio: "inherit"
    }).unref();
  }
  if (role === "next") {
    setTimeout(() => process.exit(0), 100);
    write(`${role}-ready.json`, { pid: process.pid, parentPid: process.ppid, owner });
    return;
  }
  const gate = setInterval(() => {
    if (!existsSync(join(root, "go"))) return;
    clearInterval(gate);
    if (kind === "ordinary") process.exit(0);
    else if (kind === "output") process.stdout.write("x".repeat(500));
    else if (kind === "closed-reader") process.stdout.write("owned fixture output\n");
  }, 10);
  write(`${role}-ready.json`, { pid: process.pid, parentPid: process.ppid, owner });
}

function flags(error) {
  const pending = [error];
  const seen = new Set();
  const result = { interrupted: false, timeout: false, outputFailure: false, unsettled: false, preflight: false };
  for (let index = 0; index < pending.length; index++) {
    assert.ok(pending.length <= 16, "bounded error chain");
    const item = pending[index];
    if (!item || seen.has(item)) continue;
    seen.add(item);
    const message = String(item.message ?? "");
    result.interrupted ||= message.includes("INTERRUPTED");
    result.timeout ||= message.includes("TIMEOUT");
    result.outputFailure ||= /stdout\/stderr bound|sink failed|destination|EPIPE/u.test(message);
    result.unsettled ||= item.processTreeUnsettled === true;
    result.preflight ||= message.includes("helper digest changed");
    if (item instanceof AggregateError) pending.push(...item.errors);
    if (item.cause) pending.push(item.cause);
  }
  return result;
}

async function consumer() {
  const started = performance.now();
  const observations = [];
  let firstClosed = false;
  let failure;
  const phase = {
    id: "owned",
    label: "owned synthetic phase",
    command: process.execPath,
    args: [entry, "fixture", "root"],
    environment: process.env,
    timeoutMs: kind === "deadline" ? 300 : 6000
  };
  try {
    await runRContractPhasesWithSignalForwarding([phase, { ...phase, id: "next", args: [entry, "fixture", "next"] }], {
      ...(kind === "output" ? { maximumOutputBytes: 100 } : {}),
      // Passive native-owner observation, forwarding every launch argument unchanged.
      spawnProcess: (...args) => {
        if (observations.length) assert.ok(firstClosed, "next phase began before first child close");
        const child = spawn(...args);
        const observation = { pid: child.pid, closed: false, code: null, signal: null };
        observations.push(observation);
        child.once("close", (code, signal) => {
          observation.closed = true;
          observation.code = code;
          observation.signal = signal;
          if (observations[0] === observation) firstClosed = true;
        });
        return child;
      }
    });
  } catch (error) {
    failure = flags(error);
  }
  const usage = process.resourceUsage();
  write("consumer-result.json", {
    kind,
    failed: failure !== undefined,
    failure: failure ?? null,
    observations,
    ownerWallMs: performance.now() - started,
    nodeCpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
    nodeMaxRssKiB: usage.maxRSS
  });
  process.exitCode = failure ? 1 : 0;
}

async function prepareAndObserve() {
  const { prepareJupyterAcceptanceREnvironment, rAcceptancePackageRecordMatches } =
    await import("./jupyter-acceptance-environment.mjs");
  const { runBoundedEditorCommand, sanitizeEditorAcceptanceDiagnostic } = await import("./editor-acceptance.mjs");
  const { createEditorAcceptancePrivateRootReceipt, removeEditorAcceptancePrivateRoot } =
    await import("./packaged-editor-orchestration.mjs");
  const parent = realpathSync(process.env.OPEN_WRANGLER_EXPERIMENT_MACOS_ROOT);
  const reportPath = join(parent, "r-preparation.json");
  const report = {
    phase: "prepare",
    passed: false,
    privateRootRemoved: false,
    compilerTreeQualified: false,
    realRInterruptionQualified: false
  };
  const started = performance.now();
  let receipt;
  let privateRoot;
  try {
    assert.equal(process.platform, "darwin");
    const python = process.env.OPEN_WRANGLER_TEST_PYTHON;
    assert.ok(typeof python === "string" && isAbsolute(python), "explicit hosted Python required");
    const rscript = process.env.OPEN_WRANGLER_TEST_RSCRIPT;
    assert.ok(typeof rscript === "string" && isAbsolute(rscript), "explicit hosted Rscript required");
    privateRoot = mkdtempSync(join(parent, "real-r-input-"));
    receipt = createEditorAcceptancePrivateRootReceipt(privateRoot, { containedBy: parent });
    const prepared = await prepareJupyterAcceptanceREnvironment(join(privateRoot, "r"), rscript, {
      containedBy: privateRoot,
      purpose: "source-contracts"
    });
    const environment = prepared.dependencyProbe.input.environment;
    report.phase = "runtime-identity";
    const runtime = await runBoundedEditorCommand(
      {
        executable: prepared.dependencyProbe.input.executable,
        args: ["--vanilla", "-e", 'cat(as.character(getRversion()), R.version$platform, sep = "\\n")'],
        environment,
        label: "R source experiment identity"
      },
      prepared.dependencyProbe.options
    );
    const identity = runtime.stdout.trim().split("\n");
    assert.equal(identity.length, 2);
    assert.equal(identity[0], "4.5.2");
    assert.match(identity[1], /^[A-Za-z0-9_.-]{1,80}$/u);
    report.runtime = { version: identity[0], platform: identity[1] };
    report.selectedExecutables = { r: prepared.rExecutable, rscript: prepared.dependencyProbe.input.executable };
    report.phase = "dependencies";
    await runBoundedEditorCommand(prepared.dependencyInstall.input, prepared.dependencyInstall.options);
    const probe = await runBoundedEditorCommand(prepared.dependencyProbe.input, prepared.dependencyProbe.options);
    assert.ok(
      rAcceptancePackageRecordMatches(probe.stdout, prepared.packageRecord),
      "exact private R package probe required"
    );
    report.packages = prepared.packageVersions;
    report.privatePackageProbeMatched = true;
    report.preparationMs = performance.now() - started;
    report.phase = "consumers";
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    const output = join(parent, "result.json");
    const experimentEnvironment = Object.fromEntries(
      [
        "OPEN_WRANGLER_EXPERIMENT_MACOS_ROOT",
        "OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER",
        "OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER_SHA256",
        "OPEN_WRANGLER_EXPERIMENT_MACOS_SOURCE_SHA256",
        "GITHUB_SHA"
      ].map((key) => [key, process.env[key]])
    );
    // The controller bounds each consumer. This outer bound is failure-only and cannot qualify descendant cleanup.
    const result = spawnSync(
      python,
      [
        "-B",
        fileURLToPath(new URL("./r-contract-macos-experiment-check.py", import.meta.url)),
        "--node",
        process.execPath,
        "--output",
        output
      ],
      {
        env: {
          ...environment,
          ...experimentEnvironment,
          R: prepared.rExecutable,
          RSCRIPT: prepared.dependencyProbe.input.executable
        },
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 420_000,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    report.controllerExitCode = result.status;
    report.controllerInterrupted = typeof result.signal === "string";
    if (result.status !== 0 || result.error) {
      // Only the controlled Python diagnostic, never child R output, is exposed here.
      report.controllerDiagnostic = sanitizeEditorAcceptanceDiagnostic(
        result.error ?? new Error(result.stderr || "Controller failed without stderr."),
        [parent, privateRoot]
      ).slice(0, 512);
    }
    if (result.error) throw result.error;
    assert.equal(result.status, 0, "controller failed; original bounded result retained");
    assert.ok(lstatSync(output).isFile() && lstatSync(output).size <= 65536, "bounded controller receipt required");
    const observed = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(observed.passed, true);
    assert.equal(observed.consumerPrivateRootRemoved, true);
    report.phase = "cleanup";
    removeEditorAcceptancePrivateRoot(receipt, { processTreeVerifiedStopped: true, privatePathsVerified: true });
    report.privateRootRemoved = true;
    report.passed = true;
    report.phase = "complete";
  } catch (error) {
    report.failure = {
      name: error.name,
      message: sanitizeEditorAcceptanceDiagnostic(error, [parent, privateRoot].filter(Boolean)).slice(0, 512)
    };
    process.exitCode = 1;
  } finally {
    report.wholePreparationAndConsumersMs = performance.now() - started;
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}

if (process.argv[2] === "fixture") fixture(process.argv[3]);
else if (process.argv[2] === "consumer") await consumer();
else if (process.argv[2] === "prepare-and-observe") await prepareAndObserve();
