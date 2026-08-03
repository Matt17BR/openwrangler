import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  heavyCommandLeaseEndpoint,
  heavyCommandLeasePort,
  parseHeavyCommandArguments
} from "./run-heavy-local-command.mjs";
import {
  collectOwnedProcessRows,
  parseLinuxProcessStat,
  parseMacProcessRows,
  resolveHeavyMemoryPolicy
} from "./heavy-process-memory.mjs";

const guard = fileURLToPath(new URL("./run-heavy-local-command.mjs", import.meta.url));

function cleanLeaseEnvironment(scope) {
  const environment = {
    ...process.env,
    OPEN_WRANGLER_HEAVY_LEASE_SCOPE: scope,
    OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "off"
  };
  delete environment.OPEN_WRANGLER_HEAVY_LEASE_TOKEN;
  delete environment.OPEN_WRANGLER_HEAVY_LEASE_ADDRESS;
  return environment;
}

test("local memory policy is conservative, configurable, and never silently asserted on unsupported systems", () => {
  assert.deepEqual(resolveHeavyMemoryPolicy(memoryPolicyFixture("linux", 64)), {
    enabled: true,
    bytes: 8192 * 1024 ** 2,
    mebibytes: 8192,
    source: "local-default"
  });
  assert.equal(resolveHeavyMemoryPolicy(memoryPolicyFixture("darwin", 16)).mebibytes, 4096);
  assert.equal(resolveHeavyMemoryPolicy(memoryPolicyFixture("linux", 2)).mebibytes, 512);
  assert.equal(
    resolveHeavyMemoryPolicy({
      environment: {},
      platform: "linux",
      totalMemoryBytes: 64 * 1024 ** 3,
      constrainedMemoryBytes: 8 * 1024 ** 3,
      availableMemoryBytes: 12 * 1024 ** 3
    }).mebibytes,
    2048
  );
  assert.equal(
    resolveHeavyMemoryPolicy({
      environment: {},
      platform: "linux",
      totalMemoryBytes: 64 * 1024 ** 3,
      constrainedMemoryBytes: Number.MAX_VALUE,
      availableMemoryBytes: 4 * 1024 ** 3
    }).mebibytes,
    1024
  );
  assert.deepEqual(resolveHeavyMemoryPolicy({ environment: { CI: "true" }, platform: "linux" }), {
    enabled: false,
    source: "continuous-integration"
  });
  assert.deepEqual(
    resolveHeavyMemoryPolicy({
      environment: { CI: "true", OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "3072" },
      platform: "linux"
    }),
    { enabled: true, bytes: 3072 * 1024 ** 2, mebibytes: 3072, source: "explicit" }
  );
  assert.deepEqual(
    resolveHeavyMemoryPolicy({ environment: { OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "off" }, platform: "win32" }),
    { enabled: false, source: "explicit-off" }
  );
  assert.deepEqual(resolveHeavyMemoryPolicy({ environment: {}, platform: "win32" }), {
    enabled: false,
    source: "unsupported-local-platform"
  });
  assert.throws(
    () =>
      resolveHeavyMemoryPolicy({
        environment: { OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "2048" },
        platform: "win32"
      }),
    /Job Object or container limit/u
  );
  for (const value of ["0", "1.5", "-1", "yes", "131073"]) {
    assert.throws(
      () =>
        resolveHeavyMemoryPolicy({
          environment: { OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: value },
          platform: "linux"
        }),
      /OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB/u
    );
  }
});

function memoryPolicyFixture(platform, gibibytes) {
  return {
    environment: {},
    platform,
    totalMemoryBytes: gibibytes * 1024 ** 3,
    constrainedMemoryBytes: Number.MAX_VALUE,
    availableMemoryBytes: Number.MAX_VALUE
  };
}

test("process snapshots retain identities and include new process groups below the owned root", () => {
  const root = linuxRow(100, 1, 100, "1000");
  const sameGroup = linuxRow(101, 1, 100, "1001");
  const descendant = linuxRow(102, 100, 102, "1002");
  const grandchild = linuxRow(103, 102, 103, "1003");
  const unrelated = linuxRow(200, 1, 200, "2000");
  const captured = new Map([[300, "300:1111"]]);
  const reused = linuxRow(300, 1, 300, "2222");
  const selected = collectOwnedProcessRows(
    [unrelated, grandchild, reused, descendant, sameGroup, root],
    100,
    captured,
    { processGroupVerified: true }
  );
  assert.deepEqual(
    selected.map((row) => row.pid),
    [100, 101, 102, 103]
  );
  assert.equal(captured.get(103), "103:1003");
  assert.equal(captured.get(300), "300:1111", "a reused PID must not inherit ownership");

  const lateSameGroup = linuxRow(104, 1, 100, "1004");
  assert.deepEqual(
    collectOwnedProcessRows([lateSameGroup, unrelated], 100, captured, { processGroupVerified: true }).map(
      (row) => row.pid
    ),
    [104],
    "verified process-group ownership must survive the root's exit"
  );

  assert.deepEqual(parseMacProcessRows(" 9 1 9 2048 Mon Aug  3 10:20:30 2026\n"), [
    {
      pid: 9,
      ppid: 1,
      pgid: 9,
      identity: "9:Mon Aug  3 10:20:30 2026",
      memoryBytes: 2 * 1024 ** 2
    }
  ]);
  assert.throws(() => parseMacProcessRows("not a process row"), /malformed row/u);
});

function linuxRow(pid, ppid, pgid, start) {
  const fields = ["S", ppid, pgid, pgid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, start];
  return parseLinuxProcessStat(`${pid} (node worker ${pid}) ${fields.join(" ")}`);
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

test("heavy-command arguments and shared scope endpoints are deterministic", () => {
  assert.deepEqual(parseHeavyCommandArguments(["package", "--", "npm", "run", "package:run"]), {
    label: "package",
    command: ["npm", "run", "package:run"]
  });
  assert.throws(() => parseHeavyCommandArguments(["package", "npm"]), /Usage:/u);
  assert.equal(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("same-repository"));
  assert.notEqual(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("other-repository"));
  assert.deepEqual(heavyCommandLeaseEndpoint("same-repository", "linux"), {
    host: "127.0.0.1",
    port: heavyCommandLeasePort("same-repository")
  });
  assert.deepEqual(heavyCommandLeaseEndpoint("same-repository", "win32"), {
    path: "\\\\.\\pipe\\openwrangler-heavy-7080c913052f4fd872becdd1078e618a27c2868f8662124c8d3827255342af94"
  });
  assert.notDeepEqual(
    heavyCommandLeaseEndpoint("same-repository", "win32"),
    heavyCommandLeaseEndpoint("other-repository", "win32")
  );
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

test(
  "the Linux watchdog stops an over-budget process tree and reports the observed peak",
  { timeout: 10_000, skip: process.platform !== "linux" },
  async () => {
    const scope = `openwrangler-heavy-memory-test-${process.pid}-${Date.now()}`;
    const environment = {
      ...cleanLeaseEnvironment(scope),
      OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "8"
    };
    const guarded = captureChild(
      [
        "memory-test",
        "--",
        "node",
        "--eval",
        "const {spawn}=require('node:child_process');" +
          "const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
          "process.stdout.write(String(child.pid)+'\\n');child.unref();setInterval(()=>{},1000);"
      ],
      environment
    );
    let descendantPid;
    try {
      const [code, signal] = await once(guarded.child, "close");
      descendantPid = Number.parseInt(guarded.output().stdout.trim(), 10);
      assert.equal(signal, null, guarded.output().stderr);
      assert.equal(code, 1, guarded.output().stderr);
      assert.equal(Number.isSafeInteger(descendantPid), true, guarded.output().stdout);
      assert.match(guarded.output().stderr, /memory guard: 8 MiB proportional set size \(PSS\) cap/u);
      assert.match(guarded.output().stderr, /stopped "memory-test"/u);
      assert.match(guarded.output().stderr, /above the 8 MiB local cap/u);
      assert.match(guarded.output().stderr, /Peak observed:/u);
      assert.equal(processIsAlive(descendantPid), false, `captured descendant ${descendantPid} survived the limit`);
    } finally {
      guarded.child.kill("SIGKILL");
      if (descendantPid && processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  }
);

test(
  "the Linux watchdog reports a successful command's peak without changing its exit status",
  { timeout: 10_000, skip: process.platform !== "linux" },
  async () => {
    const scope = `openwrangler-heavy-memory-success-${process.pid}-${Date.now()}`;
    const environment = {
      ...cleanLeaseEnvironment(scope),
      OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "64"
    };
    const guarded = captureChild(["memory-success", "--", "node", "--eval", "setTimeout(() => {}, 150)"], environment);
    const [code, signal] = await once(guarded.child, "close");
    assert.equal(signal, null, guarded.output().stderr);
    assert.equal(code, 0, guarded.output().stderr);
    assert.match(guarded.output().stderr, /memory guard: 64 MiB proportional set size \(PSS\) cap/u);
    assert.match(guarded.output().stderr, /"memory-success" peak .* \(cap 64 MiB\)/u);
  }
);

test(
  "the Linux watchdog rescans a verified process group after the root exits",
  { timeout: 10_000, skip: process.platform !== "linux" },
  async () => {
    const scope = `openwrangler-heavy-memory-late-child-${process.pid}-${Date.now()}`;
    const environment = {
      ...cleanLeaseEnvironment(scope),
      OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "64"
    };
    const guarded = captureChild(
      [
        "late-child",
        "--",
        "node",
        "--eval",
        "const {spawn}=require('node:child_process');" +
          "const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
          "process.stdout.write(String(child.pid)+'\\n');child.unref();"
      ],
      environment
    );
    let descendantPid;
    try {
      const [code, signal] = await once(guarded.child, "close");
      descendantPid = Number.parseInt(guarded.output().stdout.trim(), 10);
      assert.equal(signal, null, guarded.output().stderr);
      assert.equal(code, 1, guarded.output().stderr);
      assert.equal(Number.isSafeInteger(descendantPid), true, guarded.output().stdout);
      assert.match(guarded.output().stderr, /surviving descendant after "late-child" exited/u);
      assert.equal(processIsAlive(descendantPid), false, `late same-group child ${descendantPid} survived cleanup`);
    } finally {
      guarded.child.kill("SIGKILL");
      if (descendantPid && processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
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
