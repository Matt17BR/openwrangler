import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  heavyCommandLeaseEndpoint,
  heavyCommandLeasePort,
  heavyCommandLinuxCleanupLeasePort,
  parseHeavyCommandArguments,
  terminateChildTree
} from "./run-heavy-local-command.mjs";
import {
  collectOwnedProcessRows,
  parseLinuxProcessStat,
  readLinuxProcessMemoryBytes,
  resolveHeavyMemoryPolicy,
  signalIdentityCheckedProcessRows
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
  assert.deepEqual(resolveHeavyMemoryPolicy(memoryPolicyFixture("darwin", 16)), {
    enabled: false,
    source: "unsupported-local-platform"
  });
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
    /externally enforced process container/u
  );
  assert.throws(
    () =>
      resolveHeavyMemoryPolicy({
        environment: { OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "2048" },
        platform: "darwin"
      }),
    /supported only on Linux/u
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

  const capturedRoot = new Map([
    [100, "100:1000"],
    [101, "101:1001"]
  ]);
  const reusedRoot = linuxRow(100, 1, 100, "9999");
  const reusedRootGroup = linuxRow(105, 100, 100, "1005");
  assert.deepEqual(
    collectOwnedProcessRows([reusedRoot, reusedRootGroup, unrelated], 100, capturedRoot, {
      processGroupVerified: true
    }).map((row) => row.pid),
    [],
    "a reused root PID must not acquire its unrelated replacement or process group"
  );
  assert.equal(capturedRoot.get(100), "100:1000", "the captured root identity must remain immutable");

  const lateSameGroup = linuxRow(104, 1, 100, "1004");
  const continuousGroup = new Map(captured);
  assert.deepEqual(
    collectOwnedProcessRows([sameGroup, lateSameGroup, unrelated], 100, continuousGroup, {
      processGroupVerified: true
    }).map((row) => row.pid),
    [101, 104],
    "a captured live member may witness continuity after the group leader exits"
  );
  assert.deepEqual(
    collectOwnedProcessRows([lateSameGroup, unrelated], 100, captured, { processGroupVerified: true }),
    [],
    "an unwitnessed process group must not be reacquired after the root exits"
  );
});

test("process signaling revalidates identities immediately and skips reused PIDs", () => {
  const root = linuxRow(100, 1, 100, "1000");
  const live = linuxRow(101, 100, 100, "1001");
  const reused = linuxRow(102, 100, 100, "1002");
  const wrapper = linuxRow(999, 1, 999, "9990");
  const currentIdentities = new Map([
    [101, live.identity],
    [102, "102:reused-after-selection"]
  ]);
  const events = [];

  signalIdentityCheckedProcessRows([root, live, reused, wrapper], "SIGTERM", {
    rootPid: root.pid,
    includeRoot: false,
    currentPid: wrapper.pid,
    identityStillMatches(row) {
      events.push(["identity", row.pid]);
      return currentIdentities.get(row.pid) === row.identity;
    },
    killProcess(pid, signal) {
      events.push(["signal", pid, signal]);
    }
  });

  assert.deepEqual(events, [
    ["identity", 101],
    ["signal", 101, "SIGTERM"],
    ["identity", 102]
  ]);
});

test("memory accounting accepts only the same live process identity", () => {
  const row = linuxRow(101, 100, 100, "1001");
  const metric = { kind: "pss", label: "proportional set size (PSS)" };
  const failure = (code) => Object.assign(new Error(code), { code });

  assert.throws(
    () =>
      readLinuxProcessMemoryBytes(row, metric, {
        readFile: () => {
          throw failure("ENOENT");
        },
        readProcessRow: () => row
      }),
    /Memory accounting failed for live Open Wrangler child PID 101/u
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => {
        throw failure("ENOENT");
      },
      readProcessRow: () => {
        throw failure("ESRCH");
      }
    }),
    0
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => "Pss is unavailable while the process exits",
      readProcessRow: () => ({ ...row, state: "Z" })
    }),
    0
  );
  assert.throws(
    () =>
      readLinuxProcessMemoryBytes(row, metric, {
        readFile: () => {
          throw failure("EACCES");
        },
        readProcessRow: () => row
      }),
    /Memory accounting failed for live Open Wrangler child PID 101/u
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => "Pss: 4 kB",
      readProcessRow: () => linuxRow(row.pid, row.ppid, row.pgid, "9999")
    }),
    0
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => "Pss is malformed",
      readProcessRow: () => linuxRow(row.pid, row.ppid, row.pgid, "9999")
    }),
    0
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => "Pss: 4 kB",
      readProcessRow: () => ({ ...row, state: "X" })
    }),
    0
  );
  assert.equal(
    readLinuxProcessMemoryBytes(row, metric, {
      readFile: () => "Pss: 4 kB",
      readProcessRow: () => row
    }),
    4 * 1024
  );
  assert.throws(
    () =>
      readLinuxProcessMemoryBytes(row, metric, {
        readFile: () => "Pss: 4 kB",
        readProcessRow: () => {
          throw failure("EACCES");
        }
      }),
    /Memory identity verification failed for Open Wrangler child PID 101/u
  );
});

function linuxRow(pid, ppid, pgid, start) {
  const fields = ["S", ppid, pgid, pgid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, start];
  return parseLinuxProcessStat(`${pid} (node worker ${pid}) ${fields.join(" ")}`);
}

function captureNode(script, arguments_, environment) {
  const child = spawn(process.execPath, [script, ...arguments_], {
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

function captureChild(arguments_, environment) {
  return captureNode(guard, arguments_, environment);
}

test("heavy-command arguments and shared scope endpoints are deterministic", () => {
  assert.deepEqual(parseHeavyCommandArguments(["package", "--", "npm", "run", "package:run"]), {
    label: "package",
    command: ["npm", "run", "package:run"]
  });
  assert.throws(() => parseHeavyCommandArguments(["package", "npm"]), /Usage:/u);
  assert.equal(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("same-repository"));
  assert.notEqual(heavyCommandLeasePort("same-repository"), heavyCommandLeasePort("other-repository"));
  assert.equal(
    heavyCommandLinuxCleanupLeasePort("same-repository"),
    heavyCommandLinuxCleanupLeasePort("same-repository")
  );
  assert.notEqual(
    heavyCommandLinuxCleanupLeasePort("same-repository"),
    heavyCommandLinuxCleanupLeasePort("other-repository")
  );
  assert.equal(heavyCommandLinuxCleanupLeasePort("same-repository") >= 35_000, true);
  assert.equal(heavyCommandLinuxCleanupLeasePort("same-repository") < 45_000, true);
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
    "comparison:diagnostic",
    "comparison:feasibility:smoke",
    "comparison:prepare",
    "comparison:preregister",
    "comparison:study",
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
  const publicComparisonScripts = Object.keys(scripts)
    .filter((name) => name.startsWith("comparison:"))
    .sort();
  assert.deepEqual(publicComparisonScripts, [
    "comparison:diagnostic",
    "comparison:feasibility:smoke",
    "comparison:prepare",
    "comparison:preregister",
    "comparison:study"
  ]);
  assert.equal(
    scripts["comparison:feasibility:smoke"],
    "node scripts/run-heavy-local-command.mjs comparison:feasibility:smoke -- node scripts/run-data-wrangler-comparison.mjs"
  );
});

test("public comparison workflows reject contention and accept one inherited lease", { timeout: 15_000 }, async () => {
  const scope = `openwrangler-comparison-command-test-${process.pid}-${Date.now()}`;
  const environment = cleanLeaseEnvironment(scope);
  const holder = captureChild(
    [
      "comparison-holder",
      "--",
      "node",
      "--input-type=module",
      "--eval",
      "process.stdout.write('holder-ready\\n'); setTimeout(() => {}, 3000);"
    ],
    environment
  );
  const commands = [
    {
      name: "feasibility smoke",
      script: guard,
      arguments: ["comparison:feasibility:smoke", "--", "node", "scripts/run-data-wrangler-comparison.mjs"],
      nestedError: /Comparison runner requires --candidate/u
    },
    {
      name: "prepare",
      script: guard,
      arguments: ["comparison:prepare", "--", "node", "scripts/run-data-wrangler-comparison-preparation.mjs"],
      nestedError: /Usage: npm run comparison:prepare/u
    },
    {
      name: "diagnostic",
      script: guard,
      arguments: ["comparison:diagnostic", "--", "node", "scripts/run-data-wrangler-comparison-diagnostic.mjs"],
      nestedError: /Usage: node scripts\/run-data-wrangler-comparison-diagnostic/u
    },
    {
      name: "preregistration generator",
      script: guard,
      arguments: [
        "comparison:preregister",
        "--",
        "node",
        "scripts/generate-data-wrangler-comparison-preregistration.mjs"
      ],
      nestedError: /Usage: npm run comparison:preregister/u
    },
    {
      name: "study run-next",
      script: guard,
      arguments: [
        "comparison:study",
        "--",
        "node",
        "scripts/run-data-wrangler-comparison-study-entry.mjs",
        "run-next",
        "--manifest",
        "missing-manifest.json",
        "--fragments",
        "missing-fragments",
        "--intents",
        "missing-intents",
        "--preparation",
        "missing-preparation.json"
      ],
      nestedError: /ENOENT|must be one bounded/u
    }
  ];
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("The comparison lease holder did not start.")), 3_000);
      holder.child.stdout.on("data", () => {
        if (!holder.output().stdout.includes("holder-ready")) return;
        clearTimeout(timer);
        resolveReady();
      });
    });

    for (const command of commands) {
      const contender = captureNode(command.script, command.arguments, environment);
      const [code, signal] = await once(contender.child, "close");
      assert.equal(signal, null, `${command.name}: ${contender.output().stderr}`);
      assert.equal(code, 1, `${command.name}: ${contender.output().stderr}`);
      assert.match(contender.output().stderr, /Another Open Wrangler memory-intensive command is already running/u);
    }
  } finally {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      holder.child.kill("SIGKILL");
      await once(holder.child, "close");
    }
  }

  for (const command of commands) {
    const nested = captureChild(["outer", "--", "node", command.script, ...command.arguments], environment);
    const [code, signal] = await once(nested.child, "close");
    assert.equal(signal, null, `${command.name}: ${nested.output().stderr}`);
    assert.equal(code, 1, `${command.name}: ${nested.output().stderr}`);
    assert.doesNotMatch(nested.output().stderr, /Another Open Wrangler memory-intensive command is already running/u);
    assert.match(nested.output().stderr, command.nestedError);
  }
});

test("Windows termination always requests taskkill even after the root reports exit", async () => {
  const events = [];
  await terminateChildTree({ pid: 1731, exitCode: 0, signalCode: null }, undefined, "SIGTERM", {
    platform: "win32",
    taskkill: async (pid) => events.push(["taskkill", pid]),
    waitForChild: async () => {
      events.push(["wait", 1731]);
      return true;
    }
  });
  assert.deepEqual(events, [
    ["taskkill", 1731],
    ["wait", 1731]
  ]);
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
      OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "32"
    };
    const guarded = captureChild(
      [
        "memory-test",
        "--",
        "node",
        "--eval",
        "const {spawn}=require('node:child_process');" +
          "const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
          "process.stdout.write(String(child.pid)+'\\n');child.unref();" +
          "const allocation=Buffer.alloc(48*1024*1024,1);setInterval(()=>allocation[0],1000);"
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
      assert.match(guarded.output().stderr, /memory guard: 32 MiB proportional set size \(PSS\) cap/u);
      assert.match(guarded.output().stderr, /stopped "memory-test"/u);
      assert.match(guarded.output().stderr, /above the 32 MiB local cap/u);
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
    const guarded = captureChild(
      [
        "memory-success",
        "--",
        "node",
        "--eval",
        "if(process.env.OPEN_WRANGLER_HEAVY_CLEANUP_LEASE_TOKEN)process.exit(23);setTimeout(()=>{},150)"
      ],
      environment
    );
    const [code, signal] = await once(guarded.child, "close");
    assert.equal(signal, null, guarded.output().stderr);
    assert.equal(code, 0, guarded.output().stderr);
    assert.match(guarded.output().stderr, /memory guard: 64 MiB proportional set size \(PSS\) cap/u);
    assert.match(guarded.output().stderr, /"memory-success" peak .* \(cap 64 MiB\)/u);
  }
);

test(
  "the Linux watchdog subreaper captures a detached descendant before the first periodic sample",
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
          "const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});" +
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
      assert.equal(processIsAlive(descendantPid), false, `detached child ${descendantPid} survived cleanup`);
    } finally {
      guarded.child.kill("SIGKILL");
      if (descendantPid && processIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  }
);

test(
  "the Linux cleanup lease survives an accept fault and SIGKILLed wrapper until its process tree is reaped",
  { timeout: 15_000, skip: process.platform !== "linux" },
  async () => {
    const scope = `openwrangler-heavy-parent-death-${process.pid}-${Date.now()}`;
    const environment = {
      ...cleanLeaseEnvironment(scope),
      OPEN_WRANGLER_HEAVY_MEMORY_LIMIT_MB: "512",
      OPEN_WRANGLER_EXTENSION_TESTS: "1",
      OPEN_WRANGLER_HEAVY_TEST_CLEANUP_ACCEPT_FAILURE: "always"
    };
    const guarded = captureChild(
      [
        "parent-death",
        "--",
        "node",
        "--eval",
        "const {spawn}=require('node:child_process');" +
          "if(process.env.OPEN_WRANGLER_HEAVY_TEST_CLEANUP_ACCEPT_FAILURE)process.exit(24);" +
          "process.on('SIGTERM',()=>{});" +
          "const child=spawn(process.execPath,['--eval',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"]," +
          "{detached:true,stdio:'ignore'});" +
          "child.unref();" +
          "process.stdout.write(JSON.stringify({target:process.pid,descendant:child.pid})+'\\n');" +
          "setInterval(()=>{},1000);"
      ],
      environment
    );
    const ownedIdentities = new Map();
    const cleanupChildren = [];
    let cleanupFailure;
    let supervisorPid;
    let targetPid;
    let descendantPid;
    try {
      const ids = await waitForJsonLine(guarded, 3_000);
      targetPid = ids.target;
      descendantPid = ids.descendant;
      assert.equal(Number.isSafeInteger(targetPid) && targetPid > 0, true, guarded.output().stdout);
      assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true, guarded.output().stdout);

      const supervisorChildren = readLinuxDirectChildren(guarded.child.pid);
      assert.equal(supervisorChildren.length, 1, `wrapper children: ${supervisorChildren.join(",")}`);
      [supervisorPid] = supervisorChildren;
      for (const pid of [supervisorPid, targetPid, descendantPid]) {
        ownedIdentities.set(pid, readLinuxProcessIdentity(pid));
        assert.equal(linuxProcessIsRunning(pid, ownedIdentities.get(pid)), true, `owned PID ${pid} was not running`);
      }

      const wrapperExit = once(guarded.child, "exit");
      assert.equal(guarded.child.kill("SIGKILL"), true);
      const [wrapperCode, wrapperSignal] = await wrapperExit;
      assert.equal(wrapperCode, null);
      assert.equal(wrapperSignal, "SIGKILL");
      assert.equal(
        linuxProcessIsRunning(supervisorPid, ownedIdentities.get(supervisorPid)),
        true,
        "the supervisor did not retain the cleanup lease after parent death"
      );
      assert.equal(
        linuxProcessIsRunning(targetPid, ownedIdentities.get(targetPid)),
        true,
        "the SIGTERM-resistant target disappeared before the cleanup-lease assertion"
      );
      assert.equal(
        linuxProcessIsRunning(descendantPid, ownedIdentities.get(descendantPid)),
        true,
        "the detached descendant disappeared before the cleanup-lease assertion"
      );
      assert.doesNotMatch(guarded.output().stderr, /cleanup-token service failed/u);

      let cleanupLeaseRefusal;
      const refusalDeadline = Date.now() + 600;
      while (Date.now() < refusalDeadline && linuxProcessIsRunning(targetPid, ownedIdentities.get(targetPid))) {
        const contender = captureChild(["must-wait", "--", "node", "--eval", "process.exit(0)"], environment);
        cleanupChildren.push(contender);
        const [contenderCode, contenderSignal] = await once(contender.child, "close");
        assert.equal(contenderSignal, null, contender.output().stderr);
        if (contenderCode === 0) {
          assert.fail(
            `a same-scope command overlapped the live orphaned tree (${targetPid}, ${descendantPid}): ${contender.output().stderr}`
          );
        }
        if (/cleanup lease is occupied but could not be verified/u.test(contender.output().stderr)) {
          cleanupLeaseRefusal = contender.output().stderr;
          break;
        }
        assert.match(contender.output().stderr, /memory-intensive command is already running/u);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      assert.match(cleanupLeaseRefusal ?? "", /cleanup lease is occupied but could not be verified/u);
      for (const [pid, identity] of ownedIdentities) {
        assert.equal(linuxProcessIsRunning(pid, identity), true, `owned PID ${pid} ended before overlap was refused`);
      }
      assert.doesNotMatch(guarded.output().stderr, /cleanup-token service failed/u);

      await waitForLinuxProcessesToStop(ownedIdentities, 5_000);
      for (const [pid, identity] of ownedIdentities) {
        assert.equal(linuxProcessIsRunning(pid, identity), false, `owned PID ${pid} survived parent-death cleanup`);
      }
      await waitForCapturedText(guarded, /cleanup-token service failed; its owned tree was drained/u, 1_000);

      const recovery = captureChild(
        ["recovery", "--", "node", "--eval", "process.stdout.write('recovered')"],
        environment
      );
      cleanupChildren.push(recovery);
      const [recoveryCode, recoverySignal] = await once(recovery.child, "close");
      assert.equal(recoverySignal, null, recovery.output().stderr);
      assert.equal(recoveryCode, 0, recovery.output().stderr);
      assert.equal(recovery.output().stdout, "recovered");
      for (const [pid, identity] of ownedIdentities) {
        assert.equal(linuxProcessIsRunning(pid, identity), false, `old PID ${pid} revived during recovery`);
      }
    } finally {
      guarded.child.kill("SIGKILL");
      for (const child of cleanupChildren) child.child.kill("SIGKILL");
      for (const pid of [descendantPid, targetPid, supervisorPid]) {
        if (!pid || !linuxProcessIsRunning(pid, ownedIdentities.get(pid))) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") cleanupFailure ??= error;
        }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
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

async function waitForJsonLine(captured, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const line = captured.output().stdout.split("\n", 1)[0];
    if (line) return JSON.parse(line);
    if (captured.child.exitCode !== null || captured.child.signalCode !== null) {
      throw new Error(`The guarded command exited before publishing process IDs: ${captured.output().stderr}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("The guarded command did not publish its process IDs before the deadline.");
}

async function waitForCapturedText(captured, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (pattern.test(captured.output().stderr)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.match(captured.output().stderr, pattern);
}

function readLinuxDirectChildren(pid) {
  const contents = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
  if (!contents) return [];
  return contents.split(/\s+/u).map((value) => Number.parseInt(value, 10));
}

function readLinuxProcessIdentity(pid) {
  return parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8")).identity;
}

function linuxProcessIsRunning(pid, expectedIdentity) {
  if (!Number.isSafeInteger(pid) || !expectedIdentity) return false;
  try {
    const row = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return row.identity === expectedIdentity && row.state !== "Z" && row.state !== "X";
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForLinuxProcessesToStop(ownedIdentities, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if ([...ownedIdentities].every(([pid, identity]) => !linuxProcessIsRunning(pid, identity))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}
