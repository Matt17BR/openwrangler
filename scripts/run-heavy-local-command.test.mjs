import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { heavyCommandLeasePort, parseHeavyCommandArguments } from "./run-heavy-local-command.mjs";

const guard = fileURLToPath(new URL("./run-heavy-local-command.mjs", import.meta.url));

function cleanLeaseEnvironment(scope) {
  const environment = { ...process.env, OPEN_WRANGLER_HEAVY_LEASE_SCOPE: scope };
  delete environment.OPEN_WRANGLER_HEAVY_LEASE_TOKEN;
  delete environment.OPEN_WRANGLER_HEAVY_LEASE_PORT;
  return environment;
}

function captureChild(arguments_, environment) {
  const child = spawn(process.execPath, [guard, ...arguments_], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-32 * 1024);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32 * 1024);
  });
  return { child, output: () => ({ stdout, stderr }) };
}

test("heavy-command arguments and shared scope ports are deterministic", () => {
  assert.deepEqual(parseHeavyCommandArguments(["package", "--", "npm", "run", "package:run"]), {
    label: "package",
    command: ["npm", "run", "package:run"]
  });
  assert.throws(() => parseHeavyCommandArguments(["package", "npm"]), /Usage:/u);
  assert.equal(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("same-repository"));
  assert.notEqual(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("other-repository"));
});

test("public heavy scripts hold the shared lease across their complete transactions", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const scripts = manifest.scripts;
  const guarded = [
    "test",
    "test:scripts",
    "test:scripts:portable",
    "test:scripts:media",
    "test:extension-host",
    "test:packaged-editors",
    "test:remote-workspace",
    "test:coverage",
    "capture:screenshots",
    "compose:readme-media",
    "verify:readme-media",
    "test:visual",
    "test:accessibility",
    "test:webview-acceptance",
    "benchmark:runtime",
    "benchmark:installed",
    "package"
  ];
  for (const name of guarded) {
    assert.equal(
      scripts[name].startsWith(`node scripts/run-heavy-local-command.mjs ${name} -- `),
      true,
      `${name} must acquire the shared lease`
    );
  }
  assert.equal(scripts.prepackage, undefined);
  assert.equal(scripts.package, "node scripts/run-heavy-local-command.mjs package -- npm run package:run --");
  assert.equal(
    scripts["package:run"],
    "npm run clean && npm run build && npm run check && npm test && node scripts/package-current-channel.mjs"
  );
  assert.equal(
    scripts["test:packaged-editors"],
    "node scripts/run-heavy-local-command.mjs test:packaged-editors -- npm run test:packaged-editors:prepare --"
  );
});

test(
  "heavy commands reject overlap, release the lease, and permit nested npm-style commands",
  { timeout: 10_000 },
  async () => {
    const scope = `openwrangler-heavy-command-test-${process.pid}-${Date.now()}`;
    const environment = cleanLeaseEnvironment(scope);
    const holder = captureChild(
      [
        "holder",
        "--",
        "node",
        "--input-type=module",
        "--eval",
        "process.stdout.write('holder-ready\\n'); setTimeout(() => {}, 750);"
      ],
      environment
    );
    try {
      await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error("The heavy-command holder did not start.")), 3_000);
        holder.child.stdout.on("data", () => {
          if (!holder.output().stdout.includes("holder-ready")) return;
          clearTimeout(timer);
          resolveReady();
        });
      });

      const contender = captureChild(["contender", "--", "node", "--eval", "process.exit(0)"], environment);
      const [contenderCode, contenderSignal] = await once(contender.child, "close");
      assert.equal(contenderSignal, null);
      assert.equal(contenderCode, 1);
      assert.match(contender.output().stderr, /Another Open Wrangler memory-intensive command is already running/u);

      const [holderCode, holderSignal] = await once(holder.child, "close");
      assert.equal(holderSignal, null, holder.output().stderr);
      assert.equal(holderCode, 0, holder.output().stderr);

      const nested = captureChild(
        ["outer", "--", "node", guard, "inner", "--", "node", "--eval", "process.stdout.write('nested-ok')"],
        environment
      );
      const [nestedCode, nestedSignal] = await once(nested.child, "close");
      assert.equal(nestedSignal, null, nested.output().stderr);
      assert.equal(nestedCode, 0, nested.output().stderr);
      assert.equal(nested.output().stdout, "nested-ok");
    } finally {
      holder.child.kill("SIGKILL");
    }
  }
);

test("heavy commands preserve trailing arguments and terminate their child tree", { timeout: 10_000 }, async () => {
  const scope = `openwrangler-heavy-command-forward-test-${process.pid}-${Date.now()}`;
  const environment = cleanLeaseEnvironment(scope);
  const forwarded = captureChild(
    [
      "forward",
      "--",
      "node",
      "--input-type=module",
      "--eval",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "--",
      "--out",
      "artifact.vsix"
    ],
    environment
  );
  const [forwardedCode, forwardedSignal] = await once(forwarded.child, "close");
  assert.equal(forwardedSignal, null, forwarded.output().stderr);
  assert.equal(forwardedCode, 0, forwarded.output().stderr);
  assert.deepEqual(JSON.parse(forwarded.output().stdout), ["--out", "artifact.vsix"]);

  const longRunning = captureChild(
    [
      "signal",
      "--",
      "node",
      "--input-type=module",
      "--eval",
      "process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1_000);"
    ],
    environment
  );
  let childPid;
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("The guarded child did not start.")), 3_000);
      longRunning.child.stdout.on("data", () => {
        const parsed = Number.parseInt(longRunning.output().stdout.trim(), 10);
        if (!Number.isInteger(parsed)) return;
        childPid = parsed;
        clearTimeout(timer);
        resolveReady();
      });
    });
    longRunning.child.kill("SIGTERM");
    const [code, signal] = await once(longRunning.child, "close");
    assert.equal(signal, null, longRunning.output().stderr);
    assert.equal(code, 1, longRunning.output().stderr);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && processIsAlive(childPid)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(processIsAlive(childPid), false, `guarded child ${childPid} survived SIGTERM forwarding`);
  } finally {
    longRunning.child.kill("SIGKILL");
    if (childPid && processIsAlive(childPid)) process.kill(childPid, "SIGKILL");
  }
});

function processIsAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
