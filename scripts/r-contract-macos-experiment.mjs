// External adapter only. Ownership remains in the extracted current tracker.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function nativeAdapter(binary, owner) {
  const invoke = (args, allowRefusal = false) => {
    let output;
    try {
      output = execFileSync(binary, args, {
        encoding: "utf8",
        timeout: 250,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      if (!allowRefusal || error.status !== 3) {
        // Top-level failure category only; empty stderr must not hide a launch code.
        const reason =
          new Map([
            ["ETIMEDOUT", "helper-timeout"],
            ["ENOENT", "helper-missing"],
            ["EACCES", "helper-access"],
            ["ENOBUFS", "helper-output-bound"]
          ]).get(error.code) ??
          new Map([
            ["identity-before-unavailable", "identity-before-unavailable"],
            ["identity-after-unavailable", "identity-after-unavailable"],
            ["unique-identity-changed", "unique-identity-changed"],
            ["exec-version-changed", "exec-version-changed"],
            ["elapsed-bound", "elapsed-bound"],
            ["metadata-bound", "metadata-bound"],
            ["PID enumeration refused", "pid-enumeration"],
            ["allocation refused", "allocation"],
            ["observation bound exceeded", "observation-bound"],
            ["identity observation refused", "identity-observation"]
          ]).get(error.stderr?.toString().trim()) ??
          (Number.isInteger(error.status) || typeof error.signal === "string"
            ? "helper-unknown-exit"
            : "helper-unknown-launch");
        throw new Error(`Native ${args[0]} refused: ${reason}`, { cause: error });
      }
      output = error.stdout.toString();
    }
    const value = JSON.parse(output);
    return value;
  };
  const records = (value) => {
    assert.ok(Array.isArray(value.records) && value.records.length <= 4096);
    const pids = new Set();
    return value.records.map((record) => {
      assert.deepEqual(
        Object.keys(record).sort(),
        ["idVersion", "marker", "originalParentVersion", "parentPid", "parentUniqueId", "pid", "startIdentity"].sort()
      );
      assert.ok(Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 2147483647 && !pids.has(record.pid));
      pids.add(record.pid);
      assert.ok(Number.isInteger(record.parentPid) && record.parentPid >= 0 && record.parentPid <= 2147483647);
      for (const key of ["idVersion", "originalParentVersion"])
        assert.ok(Number.isInteger(record[key]) && record[key] >= 0 && record[key] <= 0xffffffff);
      for (const key of ["startIdentity", "parentUniqueId"])
        assert.ok(/^[0-9]{1,20}$/u.test(record[key]) && BigInt(record[key]) < 2n ** 64n);
      assert.notEqual(record.startIdentity, "0");
      assert.ok([-1, 0, 1].includes(record.marker));
      return Object.freeze({
        ...record,
        ownerMarked: record.marker === 1,
        state: "?",
        identityResolution: "macos-unique-id"
      });
    });
  };
  const readProcessIdentity = (pid) => records(invoke(["inspect", owner, String(pid)]))[0];
  const listProcessIdentities = () => records(invoke(["scan", owner]));
  const signalVerifiedProcesses = (targets, suppliedOwner, signal) => {
    assert.equal(suppliedOwner, owner);
    assert.ok(["SIGINT", "SIGTERM", "SIGKILL"].includes(signal) && targets.length <= 256);
    const admitted = [];
    for (const target of targets) {
      const current = readProcessIdentity(target.pid);
      if (!current || current.startIdentity !== target.startIdentity) continue;
      admitted.push(current);
    }
    if (!admitted.length) return;
    const result = invoke(
      [
        "signal",
        signal,
        ...admitted.flatMap((value) => [String(value.pid), value.startIdentity, String(value.idVersion)])
      ],
      true
    );
    assert.equal(result.results.length, admitted.length);
    for (let i = 0; i < admitted.length; i++) {
      assert.equal(result.results[i].pid, admitted[i].pid);
      assert.ok([0, 1, 2].includes(result.results[i].result));
      if (result.results[i].result === 2)
        throw new Error("Exact native signal refused while original identity may remain live");
    }
  };
  return { readProcessIdentity, listProcessIdentities, signalVerifiedProcesses, invoke };
}

// Experimental dependency only: never compile, install, cache, or select a fallback.
export function prepareExperimentalMacProcessOwner(environment = process.env) {
  assert.equal(process.platform, "darwin", "native experiment requires macOS");
  const binary = environment.OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER;
  const expected = environment.OPEN_WRANGLER_EXPERIMENT_MACOS_HELPER_SHA256;
  const expectedSource = environment.OPEN_WRANGLER_EXPERIMENT_MACOS_SOURCE_SHA256;
  assert.ok(
    typeof binary === "string" && isAbsolute(binary) && realpathSync(binary) === resolve(binary),
    "explicit canonical prebuilt helper required"
  );
  assert.ok(typeof expected === "string" && /^[a-f0-9]{64}$/u.test(expected), "explicit helper digest required");
  assert.ok(
    typeof expectedSource === "string" && /^[a-f0-9]{64}$/u.test(expectedSource),
    "explicit native-source digest required"
  );
  const parent = lstatSync(dirname(binary));
  const file = lstatSync(binary);
  assert.ok(
    parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0,
    "private helper directory required"
  );
  assert.ok(
    file.isFile() &&
      file.uid === process.getuid() &&
      (file.mode & 0o022) === 0 &&
      (file.mode & 0o100) !== 0 &&
      file.size > 0 &&
      file.size <= 2 * 1024 * 1024,
    "owned bounded executable required"
  );
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(readFileSync(binary)), expected, "prebuilt helper digest changed");
  assert.equal(
    digest(readFileSync(fileURLToPath(new URL("./r-contract-macos-experiment.c", import.meta.url)))),
    expectedSource,
    "native source digest changed"
  );
  assert.deepEqual(nativeAdapter(binary, "experimental-preflight").invoke(["preflight"]), {
    capability: "native-identity-signal",
    staleSelfRefusedLive: true
  });
  return (owner) => nativeAdapter(binary, owner);
}
