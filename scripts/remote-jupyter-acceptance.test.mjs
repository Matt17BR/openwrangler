import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import {
  REAL_REMOTE_JUPYTER_ENV,
  REMOTE_JUPYTER_BASE_IMAGE,
  REMOTE_R_JUPYTER_BASE_IMAGE,
  REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE,
  REMOTE_JUPYTER_SETUP_HEARTBEAT_MS,
  REMOTE_JUPYTER_SETUP_INACTIVITY_TIMEOUT_MS,
  REMOTE_JUPYTER_SETUP_TIMEOUT_MS,
  assertRemoteJupyterPrivateDirectory,
  createRemoteJupyterDockerEnvironment,
  remoteJupyterAcceptanceEnabled,
  remoteJupyterFixtureDefinition,
  remoteJupyterHostnameForRun,
  remoteJupyterOwnershipMayBeLive,
  runBoundedDockerCommand,
  runRemoteJupyterAcceptanceLifecycle,
  startRemoteJupyterAcceptanceFixture
} from "./remote-jupyter-acceptance.mjs";
import {
  createEditorAcceptancePrivatePathIdentityLatch,
  createEditorAcceptancePrivatePathSafetyPolicy,
  removeEditorAcceptancePrivateRoot
} from "./packaged-editor-orchestration.mjs";

const OWNER_ID = "12345678-1234-4123-8123-123456789abc";
const RUN_ID = "abcdef12-3456-4789-8abc-def012345678";
const HOSTNAME = "owr-abcdef123456";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const BASE_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const BASE_OWNER_ID = "23456789-2345-4234-9234-23456789abcd";
const CONTAINER_ID = "b".repeat(64);
const TOKEN = `owr_${"A".repeat(39)}`;
const ENGINE_ID = "OWDOCKER:ENGINE:12345678";
const SCRIPT_DIRECTORY = resolve(import.meta.dirname);
const PRIVATE_DIRECTORY = mkdtempSync(join(tmpdir(), "openwrangler-remote-jupyter-test-"));
chmodSync(PRIVATE_DIRECTORY, 0o700);
after(() => rmSync(PRIVATE_DIRECTORY, { recursive: true, force: true }));
const linuxTest = process.platform === "linux" ? test : test.skip;
const BOUNDED_RUNNER_ENVIRONMENT = Object.freeze(
  Object.fromEntries(
    [
      ["PATH", process.env.PATH],
      ["SYSTEMROOT", process.env.SystemRoot ?? process.env.SYSTEMROOT]
    ].filter((entry) => typeof entry[1] === "string")
  )
);

function createFakeChild(pid = 12345) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = () => true;
  return child;
}

function enabledEnvironment() {
  return Object.freeze({ [REAL_REMOTE_JUPYTER_ENV]: "1", PATH: "/test/bin" });
}

function readyResponse(overrides = {}) {
  return new Response(JSON.stringify({ connections: 0, kernels: 0, ...overrides }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function kernelspecResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      default: "openwrangler-remote-acceptance",
      kernelspecs: {
        "openwrangler-remote-acceptance": {
          name: "openwrangler-remote-acceptance",
          spec: {
            argv: [
              "/usr/local/bin/python",
              "-Xfrozen_modules=off",
              "-m",
              "ipykernel_launcher",
              "-f",
              "{connection_file}"
            ],
            display_name: "Open Wrangler Remote Acceptance",
            language: "python",
            metadata: { debugger: false }
          },
          resources: {}
        }
      },
      ...overrides
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

function rKernelspecResponse(overrides = {}) {
  return new Response(
    JSON.stringify({
      default: "openwrangler-r-remote-acceptance",
      kernelspecs: {
        "openwrangler-r-remote-acceptance": {
          name: "openwrangler-r-remote-acceptance",
          spec: {
            argv: ["/usr/local/lib/R/bin/R", "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"],
            display_name: "R (Open Wrangler Remote)",
            language: "R"
          },
          resources: {}
        }
      },
      ...overrides
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

function createFakeDocker({ alterResult } = {}) {
  const commands = [];
  const state = {
    images: new Map(),
    containerPresent: false,
    engineId: ENGINE_ID,
    versionReport: "28.3.0",
    engineVersion: "28.3.0",
    identityOperatingSystem: "linux",
    identityArchitecture: "x86_64",
    ownerId: undefined,
    imageTag: undefined,
    containerImageId: undefined,
    containerName: undefined,
    hostname: undefined,
    runId: undefined,
    injectedToken: undefined,
    injectedBuffer: undefined
  };
  Object.defineProperty(state, "imagePresent", {
    enumerable: true,
    get: () => state.images.size > 0,
    set: (present) => {
      if (!present) state.images.clear();
    }
  });

  const runCommand = async (input, options) => {
    const snapshot = {
      executable: input.executable,
      args: [...input.args],
      environment: input.environment,
      label: input.label,
      stdin: input.stdin ? Buffer.from(input.stdin) : undefined,
      options
    };
    commands.push(snapshot);
    const [command, operation] = input.args;
    let result;

    if (command === "version") {
      const format = input.args.at(-1);
      if (format === "{{.Server.Version}}") {
        result = success(`${state.versionReport}\n`);
      } else {
        assert.fail(`Unexpected fake Docker version format: ${format}`);
      }
    } else if (command === "context" && operation === "show") {
      result = success("default\n");
    } else if (command === "info") {
      result = success(
        `${state.engineId}\t${state.identityOperatingSystem}\t${state.identityArchitecture}\t${state.engineVersion}\n`
      );
    } else if (command === "container" && operation === "ls") {
      const filter = input.args.at(-1);
      const matches =
        state.containerPresent &&
        (filter === `id=${CONTAINER_ID}` ||
          filter === `name=^/${state.containerName}$` ||
          filter === `label=io.openwrangler.remote-jupyter.owner=${state.ownerId}`);
      result = success(matches ? `${CONTAINER_ID}\n` : "");
    } else if (command === "image" && operation === "ls") {
      const filter = input.args.at(-1);
      const ownerId = filter.startsWith("label=io.openwrangler.remote-jupyter.owner=")
        ? filter.slice("label=io.openwrangler.remote-jupyter.owner=".length)
        : undefined;
      const matches = [...state.images.values()].filter((image) => image.ownerId === ownerId);
      result = success(matches.map((image) => image.imageId).join("\n") + (matches.length ? "\n" : ""));
    } else if (command === "build") {
      state.ownerId = valueAfter(input.args, "--label").split("=").at(-1);
      state.imageTag = valueAfter(input.args, "--tag");
      const dockerfile = valueAfter(input.args, "--file");
      const imageId = dockerfile.endsWith("Dockerfile.r.base") ? BASE_IMAGE_ID : IMAGE_ID;
      state.images.set(state.ownerId, { imageId, imageTag: state.imageTag, ownerId: state.ownerId });
      result = success(`${imageId}\n`);
    } else if (command === "image" && operation === "inspect") {
      const reference = input.args.at(-1);
      const image = [...state.images.values()].find(
        (candidate) => candidate.imageId === reference || candidate.imageTag === reference
      );
      result = image ? success(`${image.imageId}\t${image.ownerId}\n`) : { exitCode: 1, stdout: "", stderr: "missing" };
    } else if (command === "run") {
      state.containerName = valueAfter(input.args, "--name");
      state.hostname = input.args.find((value) => value.startsWith("--hostname="))?.slice("--hostname=".length);
      state.runId = input.args
        .find((value) => value.startsWith("--env=OPEN_WRANGLER_REMOTE_RUN_ID="))
        ?.slice("--env=OPEN_WRANGLER_REMOTE_RUN_ID=".length);
      state.ownerId = valueAfter(input.args, "--label").split("=").at(-1);
      state.containerImageId = input.args.at(-1);
      state.containerPresent = true;
      result = success(`${CONTAINER_ID}\n`);
    } else if (command === "container" && operation === "inspect") {
      result = success(containerInspection(state));
    } else if (command === "exec") {
      state.injectedToken = input.stdin?.toString("ascii");
      state.injectedBuffer = input.stdin;
      result = success("");
    } else if (command === "port") {
      result = success("127.0.0.1:49153\n");
    } else if (command === "container" && operation === "rm") {
      state.containerPresent = false;
      result = success(`${CONTAINER_ID}\n`);
    } else if (command === "image" && operation === "rm") {
      const imageId = input.args.at(-1);
      for (const [ownerId, image] of state.images) {
        if (image.imageId === imageId) state.images.delete(ownerId);
      }
      result = success(`Deleted: ${imageId}\n`);
    } else {
      assert.fail(`Unexpected fake Docker command: ${input.args.join(" ")}`);
    }

    return alterResult ? ((await alterResult({ input, snapshot, result, state })) ?? result) : result;
  };
  return { commands, runCommand, state };
}

function success(stdout) {
  return { exitCode: 0, stdout, stderr: "" };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `Expected ${flag} in ${args.join(" ")}`);
  return args[index + 1];
}

function argumentCount(args, value) {
  return args.filter((candidate) => candidate === value).length;
}

function cleanupMutations(commands) {
  return commands
    .filter(({ args }) => (args[0] === "container" && args[1] === "rm") || (args[0] === "image" && args[1] === "rm"))
    .map(({ args }) => args.slice(0, 4));
}

function containerInspection(state, overrides = {}) {
  const values = {
    id: CONTAINER_ID,
    name: `/${state.containerName}`,
    image: state.containerImageId ?? IMAGE_ID,
    owner: state.ownerId,
    user: "65532:65532",
    hostname: state.hostname,
    environment: JSON.stringify(["PIP_DISABLE_PIP_VERSION_CHECK=1", `OPEN_WRANGLER_REMOTE_RUN_ID=${state.runId}`]),
    running: "true",
    readOnly: "true",
    restart: "no",
    pids: "256",
    memory: "1073741824",
    memorySwap: "1073741824",
    nanoCpus: "2000000000",
    capDrop: JSON.stringify(["ALL"]),
    securityOptions: JSON.stringify(["no-new-privileges=true"]),
    binds: "null",
    tmpfs: JSON.stringify({
      "/tmp": "rw,noexec,nosuid,nodev,size=536870912,mode=1777",
      "/run/openwrangler": "rw,noexec,nosuid,nodev,size=65536,mode=0700,uid=65532,gid=65532"
    }),
    networkMode: "bridge",
    ...overrides
  };
  return `${[
    values.id,
    values.name,
    values.image,
    values.owner,
    values.user,
    values.hostname,
    values.environment,
    values.running,
    values.readOnly,
    values.restart,
    values.pids,
    values.memory,
    values.memorySwap,
    values.nanoCpus,
    values.capDrop,
    values.securityOptions,
    values.binds,
    values.tmpfs,
    values.networkMode
  ].join("\t")}\n`;
}

async function startWithFake(fake, overrides = {}) {
  const fixtureKind = overrides.fixtureKind ?? "python";
  const generatedOwnerIds = fixtureKind === "r" ? [BASE_OWNER_ID, OWNER_ID] : [OWNER_ID];
  let ownerIndex = 0;
  return await startRemoteJupyterAcceptanceFixture(
    { token: TOKEN, runId: RUN_ID },
    {
      environment: enabledEnvironment(),
      dockerPrivateDirectory: PRIVATE_DIRECTORY,
      runCommand: fake.runCommand,
      randomUUIDImpl: () => generatedOwnerIds[ownerIndex++],
      fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? kernelspecResponse() : readyResponse()),
      ...overrides
    }
  );
}

test("remote-Jupyter acceptance is disabled by default and requires literal opt-in", async () => {
  assert.equal(remoteJupyterAcceptanceEnabled({}), false);
  assert.equal(remoteJupyterAcceptanceEnabled({ [REAL_REMOTE_JUPYTER_ENV]: "" }), false);
  assert.equal(remoteJupyterAcceptanceEnabled({ [REAL_REMOTE_JUPYTER_ENV]: "0" }), false);
  assert.equal(remoteJupyterAcceptanceEnabled({ [REAL_REMOTE_JUPYTER_ENV]: "1" }), true);
  assert.throws(() => remoteJupyterAcceptanceEnabled({ [REAL_REMOTE_JUPYTER_ENV]: "true" }), /literal value 1|=1/u);

  let called = false;
  const result = await startRemoteJupyterAcceptanceFixture(undefined, {
    environment: {},
    runCommand: async () => {
      called = true;
    }
  });
  assert.equal(result, undefined);
  assert.equal(called, false);
});

test("remote fixtures accept only the two fixed language definitions", async () => {
  assert.deepEqual(remoteJupyterFixtureDefinition("python"), {
    dockerfile: "Dockerfile",
    imageName: "openwrangler-remote-jupyter",
    kernelName: "openwrangler-remote-acceptance",
    kernelLabel: "Open Wrangler Remote Acceptance",
    language: "python"
  });
  assert.deepEqual(remoteJupyterFixtureDefinition("r"), {
    baseDockerfile: "Dockerfile.r.base",
    baseImageName: "openwrangler-remote-r-jupyter-base",
    dockerfile: "Dockerfile.r",
    imageName: "openwrangler-remote-r-jupyter",
    kernelName: "openwrangler-r-remote-acceptance",
    kernelLabel: "R (Open Wrangler Remote)",
    language: "R"
  });
  for (const fixtureKind of [undefined, null, "", "R", "python/../Dockerfile.r", { language: "r" }]) {
    assert.throws(() => remoteJupyterFixtureDefinition(fixtureKind), /exactly "python" or "r"/u);
  }

  const fake = createFakeDocker();
  await assert.rejects(startWithFake(fake, { fixtureKind: "R" }), /exactly "python" or "r"/u);
  assert.equal(fake.commands.length, 0);
});

linuxTest("the R fixture selects its fixed Dockerfile and exact IRkernel", async () => {
  const fake = createFakeDocker();
  const fixture = await startWithFake(fake, {
    fixtureKind: "r",
    fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
  });
  const builds = fake.commands.filter(({ args }) => args[0] === "build");
  assert.equal(builds.length, 2);
  assert.equal(
    builds[0].args[builds[0].args.indexOf("--file") + 1],
    resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile.r.base")
  );
  assert.match(builds[0].args[builds[0].args.indexOf("--tag") + 1], /^openwrangler-remote-r-jupyter-base:/u);
  assert.equal(
    builds[1].args[builds[1].args.indexOf("--file") + 1],
    resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile.r")
  );
  assert.match(builds[1].args[builds[1].args.indexOf("--tag") + 1], /^openwrangler-remote-r-jupyter:/u);
  assert.equal(argumentCount(builds[0].args, "--build-arg"), 0);
  assert.equal(argumentCount(builds[1].args, "--build-arg"), 1);
  assert.equal(
    valueAfter(builds[1].args, "--build-arg"),
    `OPEN_WRANGLER_REMOTE_R_BASE_IMAGE=${valueAfter(builds[0].args, "--tag")}`
  );
  for (const build of builds) {
    for (const flag of ["--quiet", "--no-cache", "--pull=false", "--file", "--label", "--tag"]) {
      assert.equal(argumentCount(build.args, flag), 1, `expected one ${flag} in ${build.args.join(" ")}`);
    }
    assert.equal(build.stdin, undefined);
    assert.equal(
      build.args.some((value) => value.includes(TOKEN)),
      false
    );
    assert.equal(build.label.includes(TOKEN), false);
    assert.equal(
      Object.values(build.environment).some((value) => value.includes?.(TOKEN)),
      false
    );
  }
  assert.notEqual(valueAfter(builds[0].args, "--label"), valueAfter(builds[1].args, "--label"));
  assert.equal(fake.commands.find(({ args }) => args[0] === "run")?.args.at(-1), IMAGE_ID);
  const cleanupStart = fake.commands.length;
  await fixture.cleanup();
  assert.deepEqual(cleanupMutations(fake.commands.slice(cleanupStart)), [
    ["container", "rm", "--force", CONTAINER_ID],
    ["image", "rm", IMAGE_ID],
    ["image", "rm", BASE_IMAGE_ID]
  ]);
  const cleanedCommandCount = fake.commands.length;
  await fixture.cleanup();
  assert.equal(fake.commands.length, cleanedCommandCount);
});

linuxTest("language fixtures reject the other kernelspec", async () => {
  for (const [fixtureKind, response] of [
    ["r", kernelspecResponse()],
    ["python", rKernelspecResponse()]
  ]) {
    const fake = createFakeDocker();
    let clock = 0;
    await assert.rejects(
      startWithFake(fake, {
        fixtureKind,
        readyTimeoutMs: 200,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? response.clone() : readyResponse())
      }),
      /fixed deadline/u
    );
    assert.equal(fake.state.containerPresent, false);
    assert.equal(fake.state.imagePresent, false);
  }
});

test("remote-Jupyter lifecycle cleans exactly once after a successful phase", async () => {
  let cleanupCalls = 0;
  let uncertaintyCalls = 0;
  const cleanupCheckpoints = [];
  const result = await runRemoteJupyterAcceptanceLifecycle(
    {
      cleanup: async () => {
        cleanupCalls += 1;
      }
    },
    async () => "phase-result",
    {
      phaseProcessTreeMayBeLive: () => false,
      onOwnershipUncertain: () => {
        uncertaintyCalls += 1;
      },
      onCleanupCheckpoint: (checkpoint, context) => cleanupCheckpoints.push({ checkpoint, context })
    }
  );

  assert.equal(result, "phase-result");
  assert.equal(cleanupCalls, 1);
  assert.equal(uncertaintyCalls, 0);
  assert.deepEqual(cleanupCheckpoints, [
    { checkpoint: "start", context: { phaseFailed: false } },
    { checkpoint: "complete", context: { phaseFailed: false } }
  ]);
});

test("remote-Jupyter lifecycle cleans after an ordinary phase failure and preserves that failure", async () => {
  const phaseError = new Error("ordinary phase failure");
  let cleanupCalls = 0;
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          cleanupCalls += 1;
        }
      },
      async () => {
        throw phaseError;
      },
      {
        phaseProcessTreeMayBeLive: () => false,
        onOwnershipUncertain: () => assert.fail("ordinary failure must not latch ownership uncertainty")
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, phaseError);
  assert.equal(cleanupCalls, 1);
});

test("remote-Jupyter lifecycle skips cleanup immediately when editor ownership is uncertain", async () => {
  const phaseError = new Error("editor process tree may be live");
  let cleanupCalls = 0;
  const latched = [];
  const cleanupCheckpoints = [];
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          cleanupCalls += 1;
        }
      },
      async () => {
        throw phaseError;
      },
      {
        phaseProcessTreeMayBeLive: (error) => error === phaseError,
        onOwnershipUncertain: (error) => latched.push(error),
        onCleanupCheckpoint: (checkpoint) => cleanupCheckpoints.push(checkpoint)
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, phaseError);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(latched, [phaseError]);
  assert.deepEqual(cleanupCheckpoints, []);
});

test("remote-Jupyter lifecycle never touches cleanup state after the phase latches private-path identity loss", async () => {
  const reports = [];
  const latch = createEditorAcceptancePrivatePathIdentityLatch({
    reporter: (message) => reports.push(message)
  });
  const policy = createEditorAcceptancePrivatePathSafetyPolicy({
    identityLatch: latch,
    processTreeMayBeLive: () => false
  });
  let identityLoss;
  try {
    removeEditorAcceptancePrivateRoot(undefined, { privatePathsVerified: false });
  } catch (error) {
    identityLoss = error;
  }
  let cleanupCalls = 0;
  let processInspectorCalls = 0;
  const cleanupCheckpoints = [];
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          cleanupCalls += 1;
        }
      },
      async () => {
        assert.equal(
          latch.latch(identityLoss, {
            scope: "editor-profile",
            editor: "cursor",
            cleanupOfPhase: "jupyter-remote"
          }),
          true
        );
        throw identityLoss;
      },
      {
        phaseProcessTreeMayBeLive: (error) =>
          policy.failureOwnershipMayBeUnsafe(error, () => {
            processInspectorCalls += 1;
            return false;
          }),
        onOwnershipUncertain: () => latch.reportWithheld(),
        onCleanupCheckpoint: (checkpoint) => cleanupCheckpoints.push(checkpoint)
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, identityLoss);
  assert.equal(cleanupCalls, 0);
  assert.equal(processInspectorCalls, 0);
  assert.deepEqual(cleanupCheckpoints, []);
  assert.equal(reports.length, 1);
});

test("remote-Jupyter lifecycle latches remote cleanup uncertainty", async () => {
  const cleanupError = new Error("remote cleanup ownership is uncertain");
  cleanupError.code = REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE;
  const latched = [];
  const cleanupCheckpoints = [];
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          throw cleanupError;
        }
      },
      async () => undefined,
      {
        phaseProcessTreeMayBeLive: () => false,
        onOwnershipUncertain: (error) => latched.push(error),
        onCleanupCheckpoint: (checkpoint) => cleanupCheckpoints.push(checkpoint)
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, cleanupError);
  assert.deepEqual(latched, [cleanupError]);
  assert.deepEqual(cleanupCheckpoints, ["start"]);
});

test("remote-Jupyter lifecycle skips cleanup when its pre-cleanup checkpoint loses ownership", async () => {
  let cleanupCalls = 0;
  const latched = [];
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          cleanupCalls += 1;
        }
      },
      async () => undefined,
      {
        phaseProcessTreeMayBeLive: () => false,
        onOwnershipUncertain: (error) => latched.push(error),
        onCleanupCheckpoint: () => {
          throw new Error("private checkpoint path changed");
        }
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(remoteJupyterOwnershipMayBeLive(caught));
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(latched, [caught]);
});

test("remote-Jupyter lifecycle aggregates ordinary phase and cleanup failures", async () => {
  const phaseError = new Error("phase failed");
  const cleanupError = new Error("cleanup failed");
  let cleanupCalls = 0;
  let caught;
  try {
    await runRemoteJupyterAcceptanceLifecycle(
      {
        cleanup: async () => {
          cleanupCalls += 1;
          throw cleanupError;
        }
      },
      async () => {
        throw phaseError;
      },
      {
        phaseProcessTreeMayBeLive: () => false,
        onOwnershipUncertain: () => assert.fail("ordinary failures must not latch ownership uncertainty")
      }
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors, [phaseError, cleanupError]);
  assert.match(caught.message, /acceptance and fixture cleanup both failed/u);
  assert.equal(cleanupCalls, 1);
});

linuxTest("remote-Jupyter validates its private token and ownership random source before Docker", async () => {
  for (const credentials of [
    undefined,
    {},
    { token: "short" },
    { token: `${`owr_${"a".repeat(38)}`}\n` },
    { token: "a".repeat(43) },
    { token: `owr_${"a".repeat(40)}` }
  ]) {
    let called = false;
    await assert.rejects(
      startRemoteJupyterAcceptanceFixture(credentials, {
        environment: enabledEnvironment(),
        runCommand: async () => {
          called = true;
        }
      }),
      /separately generated opaque authentication token/u
    );
    assert.equal(called, false);
  }

  await assert.rejects(
    startRemoteJupyterAcceptanceFixture(
      { token: TOKEN, runId: "not-a-run-id" },
      {
        environment: enabledEnvironment(),
        dockerPrivateDirectory: PRIVATE_DIRECTORY
      }
    ),
    /canonical public run identifier/u
  );

  let called = false;
  await assert.rejects(
    startRemoteJupyterAcceptanceFixture(
      { token: TOKEN, runId: RUN_ID },
      {
        environment: enabledEnvironment(),
        dockerPrivateDirectory: PRIVATE_DIRECTORY,
        randomUUIDImpl: () => "not-random",
        runCommand: async () => {
          called = true;
        }
      }
    ),
    /safe random ownership identifier/u
  );
  assert.equal(called, false);

  await assert.rejects(
    startRemoteJupyterAcceptanceFixture(
      { token: TOKEN, runId: RUN_ID },
      {
        environment: enabledEnvironment(),
        dockerPrivateDirectory: PRIVATE_DIRECTORY,
        fixtureKind: "r",
        randomUUIDImpl: () => OWNER_ID,
        runCommand: async () => {
          called = true;
        }
      }
    ),
    /distinct safe random ownership identifiers/u
  );
  assert.equal(called, false);
});

test("derives a fixed non-secret hostname and forwards only a minimal local-Docker environment", () => {
  assert.equal(remoteJupyterHostnameForRun(RUN_ID), HOSTNAME);
  assert.throws(() => remoteJupyterHostnameForRun("bad"), /canonical public run identifier/u);
  const dockerEnvironment = createRemoteJupyterDockerEnvironment(
    {
      PATH: "/test/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      HOME: "/real/home",
      DOCKER_CONFIG: "/real/home/.docker",
      HTTP_PROXY: "http://user:secret@example.test",
      HTTPS_PROXY: "http://user:secret@example.test",
      GITHUB_TOKEN: "secret",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      PYTHONPATH: "/tmp/inject",
      SSH_AUTH_SOCK: "/tmp/agent.sock"
    },
    PRIVATE_DIRECTORY,
    { platform: "linux" }
  );
  assert.deepEqual(dockerEnvironment, {
    PATH: "/test/bin",
    HOME: PRIVATE_DIRECTORY,
    DOCKER_CONFIG: PRIVATE_DIRECTORY,
    TMPDIR: PRIVATE_DIRECTORY,
    DOCKER_HOST: "unix:///run/user/1000/docker.sock"
  });
  assert.throws(
    () =>
      createRemoteJupyterDockerEnvironment(
        { PATH: "/test/bin", DOCKER_HOST: "tcp://remote.example.test:2376" },
        PRIVATE_DIRECTORY,
        { platform: "linux" }
      ),
    /local Unix socket/u
  );
  assert.throws(
    () => createRemoteJupyterDockerEnvironment({ PATH: "/test/bin" }, PRIVATE_DIRECTORY, { platform: "darwin" }),
    /only on a Linux host/u
  );
});

linuxTest("requires an owned mode-0700 real directory for Docker client state", () => {
  assert.doesNotThrow(() => assertRemoteJupyterPrivateDirectory(PRIVATE_DIRECTORY));
  const loose = mkdtempSync(join(tmpdir(), "openwrangler-remote-jupyter-loose-"));
  const link = `${loose}-link`;
  try {
    chmodSync(loose, 0o755);
    assert.throws(() => assertRemoteJupyterPrivateDirectory(loose), /mode-0700 real directory/u);
    symlinkSync(PRIVATE_DIRECTORY, link);
    assert.throws(() => assertRemoteJupyterPrivateDirectory(link), /mode-0700 real directory/u);
  } finally {
    rmSync(link, { force: true });
    rmSync(loose, { recursive: true, force: true });
  }
});

linuxTest("setup shares one aggregate budget and publishes changing attached-command checkpoints", async () => {
  let clock = 0;
  let setupActive = true;
  const commandBudgets = [];
  const checkpoints = [];
  const fake = createFakeDocker({
    alterResult({ input, snapshot, result }) {
      if (!setupActive) return result;
      commandBudgets.push({
        command: input.args[0],
        remainingAtDispatch: 1_000 - clock,
        timeoutMs: snapshot.options.timeoutMs
      });
      if (input.args[0] === "build") {
        clock += 50;
        snapshot.options.onProgress();
        clock += 50;
        snapshot.options.onProgress();
      } else {
        clock += 10;
      }
      return result;
    }
  });

  const fixture = await startWithFake(fake, {
    now: () => clock,
    setupTimeoutMs: 1_000,
    setupInactivityTimeoutMs: 300,
    setupHeartbeatMs: 100,
    onSetupCheckpoint: (checkpoint) => checkpoints.push(checkpoint)
  });
  setupActive = false;

  assert.ok(commandBudgets.length > 10);
  for (const command of commandBudgets) {
    assert.ok(command.timeoutMs > 0);
    assert.ok(command.timeoutMs <= command.remainingAtDispatch);
  }
  assert.equal(new Set(checkpoints).size, checkpoints.length);
  assert.match(checkpoints[0], /^setup:start:[0-9]+$/u);
  assert.ok(checkpoints.some((checkpoint) => /^setup:docker-[0-9]+:active:[0-9]+$/u.test(checkpoint)));
  assert.match(checkpoints.at(-1), /^setup:complete:[0-9]+$/u);

  await fixture.cleanup();
});

linuxTest("remote R base, runtime, and launch setup receive independent fixed budgets", async () => {
  let clock = 0;
  let setupActive = true;
  const buildBudgets = [];
  const firstCommandBudgetByStage = new Map();
  const checkpoints = [];
  let activeStage;
  const fake = createFakeDocker({
    alterResult({ input, snapshot, result }) {
      if (!setupActive) return result;
      if (!firstCommandBudgetByStage.has(activeStage)) {
        firstCommandBudgetByStage.set(activeStage, snapshot.options.timeoutMs);
      }
      if (input.args[0] === "build") {
        buildBudgets.push(snapshot.options.timeoutMs);
        clock += 700;
        snapshot.options.onProgress();
      }
      return result;
    }
  });

  const fixture = await startWithFake(fake, {
    fixtureKind: "r",
    now: () => clock,
    setupTimeoutMs: 1_000,
    setupInactivityTimeoutMs: 900,
    setupHeartbeatMs: 100,
    onSetupCheckpoint: (checkpoint, context) => {
      activeStage = context.stage;
      checkpoints.push({ checkpoint, context });
    },
    fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
  });
  setupActive = false;

  assert.deepEqual(buildBudgets, [1_000, 1_000]);
  assert.deepEqual(Object.fromEntries(firstCommandBudgetByStage), {
    "base-build": 1_000,
    "runtime-build": 1_000,
    setup: 1_000
  });
  assert.deepEqual(
    [...new Set(checkpoints.map(({ context }) => context.stage))],
    ["base-build", "runtime-build", "setup"]
  );
  for (const stage of ["base-build", "runtime-build", "setup"]) {
    const stageCheckpoints = checkpoints
      .filter(({ context }) => context.stage === stage)
      .map(({ checkpoint }) => checkpoint);
    assert.match(stageCheckpoints[0], new RegExp(`^${stage}:start:1$`, "u"));
    assert.match(stageCheckpoints.at(-1), new RegExp(`^${stage}:complete:[0-9]+$`, "u"));
    assert.ok(stageCheckpoints.some((checkpoint) => checkpoint.includes(":docker-")));
  }

  await fixture.cleanup();
});

linuxTest("remote R handoff drift latches uncertainty without subsequent Docker access", async (t) => {
  await t.test("engine identity", async () => {
    const fake = createFakeDocker();
    const checkpoints = [];
    let commandCountAtBoundary;
    let error;
    try {
      await startWithFake(fake, {
        fixtureKind: "r",
        onSetupCheckpoint: (checkpoint, { stage }) => {
          checkpoints.push({ checkpoint, stage });
          if (stage === "base-build" && checkpoint.startsWith("base-build:complete:")) {
            commandCountAtBoundary = fake.commands.length;
            fake.state.engineId = "OWDOCKER:ENGINE:87654321";
          }
        },
        fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(remoteJupyterOwnershipMayBeLive(error));
    assert.match(error.message, /base-to-runtime build ownership handoff/u);
    assert.equal(fake.commands.length, commandCountAtBoundary + 3);
    assert.equal(fake.commands.at(-1).args[0], "info");
    assert.equal(
      fake.commands.some(({ args }) => args[0] === "run"),
      false
    );
    assert.equal(
      fake.commands.some(({ args }) => args[0] === "image" && args[1] === "rm"),
      false
    );
    assert.equal(fake.state.images.size, 1);
  });

  await t.test("image tag identity", async () => {
    const fake = createFakeDocker();
    let commandCountAtBoundary;
    let error;
    try {
      await startWithFake(fake, {
        fixtureKind: "r",
        onSetupCheckpoint: (checkpoint, { stage }) => {
          if (stage === "base-build" && checkpoint.startsWith("base-build:complete:")) {
            commandCountAtBoundary = fake.commands.length;
            fake.state.images.get(BASE_OWNER_ID).imageTag = "openwrangler-remote-r-jupyter-base:rebound";
          }
        },
        fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(remoteJupyterOwnershipMayBeLive(error));
    assert.match(error.message, /base-to-runtime build ownership handoff/u);
    assert.equal(fake.commands.length, commandCountAtBoundary + 5);
    assert.equal(fake.commands.at(-1).args[0], "image");
    assert.equal(fake.commands.at(-1).args[1], "inspect");
    assert.equal(
      fake.commands.some(({ args }) => args[0] === "image" && args[1] === "rm"),
      false
    );
    assert.equal(fake.state.images.size, 1);
  });
});

linuxTest("remote R runtime-to-launch ownership drift fails closed before launch or cleanup", async (t) => {
  const driftCases = [
    ["engine", 3, (fake) => (fake.state.engineId = "OWDOCKER:ENGINE:87654321")],
    ["image identity", 6, (fake) => (fake.state.images.get(OWNER_ID).imageId = `sha256:${"d".repeat(64)}`)],
    ["image tag", 7, (fake) => (fake.state.images.get(OWNER_ID).imageTag = "openwrangler-remote-r-jupyter:rebound")],
    ["owner label", 6, (fake) => (fake.state.images.get(OWNER_ID).ownerId = BASE_OWNER_ID)]
  ];

  for (const [label, expectedDetectionCommands, applyDrift] of driftCases) {
    await t.test(label, async () => {
      const fake = createFakeDocker();
      let commandCountAtBoundary;
      let error;
      try {
        await startWithFake(fake, {
          fixtureKind: "r",
          onSetupCheckpoint: (checkpoint, { stage }) => {
            if (stage === "runtime-build" && checkpoint.startsWith("runtime-build:complete:")) {
              commandCountAtBoundary = fake.commands.length;
              applyDrift(fake);
            }
          },
          fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
        });
      } catch (caught) {
        error = caught;
      }

      assert.ok(remoteJupyterOwnershipMayBeLive(error));
      assert.match(error.message, /runtime-to-launch ownership handoff/u);
      assert.ok(Number.isSafeInteger(commandCountAtBoundary));
      const commandsAfterBoundary = fake.commands.slice(commandCountAtBoundary);
      assert.equal(commandsAfterBoundary.length, expectedDetectionCommands);
      assert.equal(
        commandsAfterBoundary.some(
          ({ args }) =>
            ["build", "run", "exec"].includes(args[0]) ||
            (args[0] === "container" && args[1] === "rm") ||
            (args[0] === "image" && args[1] === "rm")
        ),
        false
      );
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.images.size, 2);
    });
  }
});

linuxTest("remote R ready-fixture ownership drift leaves every live resource untouched", async (t) => {
  const driftCases = [
    ["engine", 3, (fake) => (fake.state.engineId = "OWDOCKER:ENGINE:87654321")],
    ["image identity", 6, (fake) => (fake.state.images.get(OWNER_ID).imageId = `sha256:${"d".repeat(64)}`)],
    ["image tag", 7, (fake) => (fake.state.images.get(OWNER_ID).imageTag = "openwrangler-remote-r-jupyter:rebound")],
    ["owner label", 6, (fake) => (fake.state.images.get(OWNER_ID).ownerId = BASE_OWNER_ID)]
  ];

  for (const [label, expectedDetectionCommands, applyDrift] of driftCases) {
    await t.test(label, async () => {
      const fake = createFakeDocker();
      let commandCountAtBoundary;
      let error;
      try {
        await startWithFake(fake, {
          fixtureKind: "r",
          onSetupCheckpoint: (checkpoint, { stage }) => {
            if (stage === "setup" && checkpoint.startsWith("setup:readiness-complete:")) {
              commandCountAtBoundary = fake.commands.length;
              applyDrift(fake);
            }
          },
          fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
        });
      } catch (caught) {
        error = caught;
      }

      assert.ok(remoteJupyterOwnershipMayBeLive(error));
      assert.match(error.message, /ready fixture ownership handoff/u);
      assert.ok(Number.isSafeInteger(commandCountAtBoundary));
      const commandsAfterBoundary = fake.commands.slice(commandCountAtBoundary);
      assert.equal(commandsAfterBoundary.length, expectedDetectionCommands);
      assert.equal(
        commandsAfterBoundary.some(
          ({ args }) =>
            ["build", "run", "exec"].includes(args[0]) ||
            (args[0] === "container" && args[1] === "rm") ||
            (args[0] === "image" && args[1] === "rm")
        ),
        false
      );
      assert.equal(fake.state.containerPresent, true);
      assert.equal(fake.state.images.size, 2);
      assert.deepEqual(cleanupMutations(fake.commands), []);
    });
  }
});

linuxTest("a pre-runtime failure cleans only the proven base image", async () => {
  const fake = createFakeDocker();
  const preexistingRuntimeImage = Object.freeze({
    imageId: `sha256:${"d".repeat(64)}`,
    imageTag: "unrelated:retained",
    ownerId: OWNER_ID
  });
  fake.state.images.set(OWNER_ID, preexistingRuntimeImage);

  let error;
  try {
    await startWithFake(fake, {
      fixtureKind: "r",
      fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof Error);
  assert.equal(remoteJupyterOwnershipMayBeLive(error), false);
  assert.equal(fake.state.images.get(OWNER_ID), preexistingRuntimeImage);
  assert.equal(fake.state.images.has(BASE_OWNER_ID), false);
  assert.equal(
    fake.commands.some(({ args }) => args[0] === "container"),
    false
  );
  assert.deepEqual(
    fake.commands.filter(({ args }) => args[0] === "image" && args[1] === "rm").map(({ args }) => args[2]),
    [BASE_IMAGE_ID]
  );
});

linuxTest("remote R build failures block later stages and preserve stage-specific cleanup ownership", async (t) => {
  const failureKinds = ["ordinary", "ownership-uncertain", "completion-unknown"];
  for (const failedBuild of [1, 2]) {
    for (const failureKind of failureKinds) {
      await t.test(`build ${failedBuild} ${failureKind}`, async () => {
        const cleanupCheckpoints = [];
        let buildOrdinal = 0;
        let commandCountAtFailure;
        const injectedError = new Error(`injected ${failureKind} build failure`);
        if (failureKind === "ownership-uncertain") {
          injectedError.code = REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE;
        } else if (failureKind === "completion-unknown") {
          injectedError.code = "REMOTE_JUPYTER_DOCKER_COMPLETION_UNKNOWN";
        }
        const fake = createFakeDocker({
          alterResult({ input, result }) {
            if (input.args[0] !== "build") return result;
            buildOrdinal += 1;
            if (buildOrdinal !== failedBuild) return result;
            commandCountAtFailure = fake.commands.length;
            if (failureKind === "ordinary") {
              return { exitCode: 1, stdout: "", stderr: "ordinary completed failure" };
            }
            throw injectedError;
          }
        });

        let error;
        try {
          await startWithFake(fake, {
            fixtureKind: "r",
            onCleanupCheckpoint: (checkpoint, context) => cleanupCheckpoints.push({ checkpoint, context }),
            fetchImpl: async (url) => (url.endsWith("/api/kernelspecs") ? rKernelspecResponse() : readyResponse())
          });
        } catch (caught) {
          error = caught;
        }

        assert.ok(error instanceof Error);
        assert.equal(
          fake.commands.filter(({ args }) => args[0] === "build").length,
          failedBuild,
          "a failed R build must block every later build"
        );
        assert.equal(
          fake.commands.some(({ args }) => args[0] === "run"),
          false,
          "a failed R build must block launch"
        );
        const originatingPhase = failedBuild === 1 ? "base-build" : "runtime-build";
        if (failureKind === "ownership-uncertain") {
          assert.equal(error, injectedError);
          assert.equal(fake.commands.length, commandCountAtFailure);
          assert.deepEqual(cleanupCheckpoints, []);
          assert.deepEqual(cleanupMutations(fake.commands), []);
          assert.equal(fake.state.images.size, failedBuild);
        } else {
          assert.deepEqual(
            cleanupCheckpoints,
            failureKind === "ordinary"
              ? [
                  { checkpoint: "start", context: { originatingPhase } },
                  { checkpoint: "complete", context: { originatingPhase } }
                ]
              : [{ checkpoint: "start", context: { originatingPhase } }]
          );
          assert.deepEqual(
            cleanupMutations(fake.commands),
            failedBuild === 1
              ? [["image", "rm", BASE_IMAGE_ID]]
              : [
                  ["image", "rm", IMAGE_ID],
                  ["image", "rm", BASE_IMAGE_ID]
                ]
          );
          assert.equal(fake.state.images.size, 0);
          assert.equal(remoteJupyterOwnershipMayBeLive(error), failureKind === "completion-unknown");
        }
      });
    }
  }
});

linuxTest(
  "setup aggregate expiry waits for the current command result and then uses explicit bounded cleanup",
  async () => {
    let clock = 0;
    const cleanupCheckpoints = [];
    const fake = createFakeDocker({
      alterResult({ input, result }) {
        if (input.args[0] === "version") clock = 300;
        return result;
      }
    });

    await assert.rejects(
      startWithFake(fake, {
        now: () => clock,
        setupTimeoutMs: 300,
        setupInactivityTimeoutMs: 200,
        setupHeartbeatMs: 100,
        onCleanupCheckpoint: (checkpoint, context) => cleanupCheckpoints.push({ checkpoint, context })
      }),
      /setup exceeded its fixed aggregate deadline/u
    );
    assert.deepEqual(
      fake.commands.map(({ args }) => args[0]),
      ["version"]
    );
    assert.deepEqual(cleanupCheckpoints, [
      { checkpoint: "start", context: { originatingPhase: "setup" } },
      { checkpoint: "complete", context: { originatingPhase: "setup" } }
    ]);
  }
);

linuxTest("setup checkpoint ownership loss prevents every subsequent Docker command", async () => {
  const startFake = createFakeDocker();
  await assert.rejects(
    startWithFake(startFake, {
      onSetupCheckpoint: () => {
        throw new Error("checkpoint path changed");
      }
    }),
    (error) => remoteJupyterOwnershipMayBeLive(error)
  );
  assert.equal(startFake.commands.length, 0);

  const activeFake = createFakeDocker({
    alterResult({ input, snapshot, result }) {
      if (input.args[0] === "build") snapshot.options.onProgress();
      return result;
    }
  });
  await assert.rejects(
    startWithFake(activeFake, {
      onSetupCheckpoint: (checkpoint) => {
        if (checkpoint.includes(":active:")) throw new Error("checkpoint path changed");
      }
    }),
    (error) => remoteJupyterOwnershipMayBeLive(error)
  );
  const buildIndex = activeFake.commands.findIndex(({ args }) => args[0] === "build");
  assert.notEqual(buildIndex, -1);
  assert.equal(activeFake.commands.length, buildIndex + 1);
  assert.equal(activeFake.state.imagePresent, true);
});

linuxTest(
  "readiness-active checkpoint ownership loss leaves the owned fixture untouched and emits no later command",
  async () => {
    const fake = createFakeDocker();
    let clock = 0;
    await assert.rejects(
      startWithFake(fake, {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        readyTimeoutMs: 500,
        setupInactivityTimeoutMs: 200,
        setupHeartbeatMs: 100,
        fetchImpl: async () => new Response("not ready", { status: 503 }),
        onSetupCheckpoint: (checkpoint) => {
          if (checkpoint.startsWith("setup:readiness-active:")) {
            throw new Error("checkpoint path changed");
          }
        }
      }),
      (error) => remoteJupyterOwnershipMayBeLive(error)
    );

    assert.equal(fake.commands.at(-1).args[0], "port");
    assert.equal(fake.state.containerPresent, true);
    assert.equal(fake.state.imagePresent, true);
    assert.equal(
      fake.commands.some(({ args }) => args[0] === "container" && args[1] === "rm"),
      false
    );
  }
);

linuxTest("pre-cleanup checkpoint ownership loss skips setup-failure Docker cleanup", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result }) {
      if (input.args[0] === "port") return success("0.0.0.0:49153\n");
      return result;
    }
  });
  await assert.rejects(
    startWithFake(fake, {
      onCleanupCheckpoint: (checkpoint) => {
        if (checkpoint === "start") throw new Error("cleanup checkpoint path changed");
      }
    }),
    (error) => remoteJupyterOwnershipMayBeLive(error)
  );

  assert.equal(fake.state.containerPresent, true);
  assert.equal(fake.state.imagePresent, true);
  assert.equal(
    fake.commands.some(({ args }) => args[0] === "container" && args[1] === "rm"),
    false
  );
});

linuxTest("starts one hardened loopback-only fixture and removes every owned resource", async () => {
  const fake = createFakeDocker();
  const requests = [];
  const fixture = await startWithFake(fake, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return url.endsWith("/api/kernelspecs") ? kernelspecResponse() : readyResponse();
    }
  });

  assert.deepEqual(Object.keys(fixture).sort(), ["baseUrl", "cleanup"]);
  assert.equal(fixture.baseUrl, "http://127.0.0.1:49153");
  assert.equal(fixture.baseUrl.includes(TOKEN), false);
  assert.equal(fake.state.injectedToken, TOKEN);
  assert.equal(fake.state.hostname, HOSTNAME);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:49153/api/status");
  assert.equal(requests[1].url, "http://127.0.0.1:49153/api/kernelspecs");
  assert.equal(requests[0].url.includes(TOKEN), false);
  assert.equal(requests[0].init.headers.authorization, `token ${TOKEN}`);

  const builds = fake.commands.filter(({ args }) => args[0] === "build");
  assert.equal(builds.length, 1);
  const [build] = builds;
  assert.equal(valueAfter(build.args, "--file"), resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile"));
  assert.equal(argumentCount(build.args, "--build-arg"), 0);
  assert.ok(build.args.includes("--quiet"));
  assert.ok(build.args.includes("--no-cache"));
  assert.equal(build.args.includes("--pull=true"), false);
  const buildIndex = fake.commands.indexOf(build);
  const containerNameProbeIndex = fake.commands.findIndex(
    ({ args }) => args[0] === "container" && args[1] === "ls" && args.at(-1).startsWith("name=^/ow-rj-")
  );
  assert.ok(containerNameProbeIndex >= 0 && containerNameProbeIndex < buildIndex);

  const launch = fake.commands.find(({ args }) => args[0] === "run");
  assert.ok(launch);
  assert.ok(launch.args.includes(`--hostname=${HOSTNAME}`));
  assert.ok(launch.args.includes(`--env=OPEN_WRANGLER_REMOTE_RUN_ID=${RUN_ID}`));
  for (const exact of [
    "--restart=no",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--pids-limit=256",
    "--memory=1073741824",
    "--memory-swap=1073741824",
    "--cpus=2",
    "--user=65532:65532",
    "--network=bridge",
    "--publish=127.0.0.1::8888/tcp"
  ]) {
    assert.ok(launch.args.includes(exact), `missing hardened Docker argument ${exact}`);
  }
  assert.equal(launch.args.includes("--mount"), false);
  assert.equal(launch.args.includes("--volume"), false);
  assert.equal(launch.args.includes("-v"), false);
  assert.equal(
    launch.args.some((value) => value.includes(TOKEN)),
    false
  );
  assert.equal(launch.args.at(-1), IMAGE_ID);

  const injection = fake.commands.find(({ args }) => args[0] === "exec");
  assert.deepEqual(injection.args.slice(0, 4), ["exec", "--interactive", "--user=65532:65532", CONTAINER_ID]);
  assert.deepEqual(injection.args.slice(-3), ["python", "-I", "/opt/openwrangler/inject-token.py"]);
  assert.equal(
    injection.args.some((value) => value.includes(TOKEN)),
    false
  );
  assert.equal(
    Object.values(injection.environment).some((value) => value.includes?.(TOKEN)),
    false
  );
  assert.equal(injection.stdin.toString("ascii"), TOKEN);
  assert.ok(fake.state.injectedBuffer.every((value) => value === 0));
  assert.equal(
    fake.commands.every(({ args }) => args.every((value) => !value.includes(TOKEN))),
    true
  );
  assert.deepEqual(Object.keys(injection.environment).sort(), ["DOCKER_CONFIG", "HOME", "PATH", "TMPDIR"]);

  await fixture.cleanup();
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
  assert.ok(
    fake.commands.some(
      ({ args }) => args[0] === "container" && args[1] === "rm" && args[2] === "--force" && args[3] === CONTAINER_ID
    )
  );
  assert.ok(fake.commands.some(({ args }) => args[0] === "image" && args[1] === "rm" && args[2] === IMAGE_ID));
  const commandCount = fake.commands.length;
  await fixture.cleanup();
  assert.equal(fake.commands.length, commandCount);
});

linuxTest("rejects a non-loopback publication and still removes the owned container and image", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result }) {
      if (input.args[0] === "port") return success("0.0.0.0:49153\n");
      return result;
    }
  });

  await assert.rejects(startWithFake(fake), /safe loopback port/u);
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest(
  "classifies weakened isolation without retaining inspected values and still cleans owned resources",
  async () => {
    const fake = createFakeDocker({
      alterResult({ input, result, state }) {
        if (input.args[0] === "container" && input.args[1] === "inspect") {
          return success(
            containerInspection(state, {
              readOnly: "untrusted-read-only-value",
              memorySwap: "-1"
            })
          );
        }
        return result;
      }
    });

    await assert.rejects(
      startWithFake(fake),
      (error) =>
        error instanceof Error &&
        /container isolation could not be proven \[read-only-rootfs,memory-swap-limit\]/u.test(error.message) &&
        !error.message.includes("untrusted-read-only-value") &&
        !error.message.includes("-1")
    );
    assert.equal(fake.state.containerPresent, false);
    assert.equal(fake.state.imagePresent, false);
  }
);

linuxTest("accepts only Docker's true no-new-privileges inspection forms", async (t) => {
  for (const securityOptions of [["no-new-privileges"], ["no-new-privileges=true"], ["no-new-privileges:true"]]) {
    await t.test(`accepts ${securityOptions[0]}`, async () => {
      const fake = createFakeDocker({
        alterResult({ input, result, state }) {
          if (input.args[0] === "container" && input.args[1] === "inspect") {
            return success(
              containerInspection(state, {
                securityOptions: JSON.stringify(securityOptions)
              })
            );
          }
          return result;
        }
      });

      const fixture = await startWithFake(fake);
      await fixture.cleanup();
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.imagePresent, false);
    });
  }

  for (const securityOptions of [
    [],
    ["no-new-privileges=false"],
    ["no-new-privileges:1"],
    ["apparmor=unconfined"],
    ["no-new-privileges=true", "seccomp=unconfined"]
  ]) {
    await t.test(`rejects ${JSON.stringify(securityOptions)}`, async () => {
      const fake = createFakeDocker({
        alterResult({ input, result, state }) {
          if (input.args[0] === "container" && input.args[1] === "inspect") {
            return success(
              containerInspection(state, {
                securityOptions: JSON.stringify(securityOptions)
              })
            );
          }
          return result;
        }
      });

      await assert.rejects(startWithFake(fake), /\[no-new-privileges\]/u);
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.imagePresent, false);
    });
  }
});

linuxTest("ownership mismatch fails closed without deleting an unproven container", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result, state }) {
      if (input.args[0] === "container" && input.args[1] === "inspect") {
        return success(containerInspection(state, { owner: "someone-else" }));
      }
      return result;
    }
  });

  await assert.rejects(startWithFake(fake), /disappearance could not be proven/u);
  assert.equal(fake.state.containerPresent, true);
  assert.equal(
    fake.commands.some(({ args }) => args[0] === "container" && args[1] === "rm"),
    false
  );
});

linuxTest("readiness is bounded, credential-safe, and cleanup runs after timeout", async () => {
  const fake = createFakeDocker();
  let clock = 0;
  let requests = 0;
  await assert.rejects(
    startWithFake(fake, {
      readyTimeoutMs: 200,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: async (url, init) => {
        requests += 1;
        assert.equal(url.includes(TOKEN), false);
        assert.equal(init.headers.authorization, `token ${TOKEN}`);
        return new Response("not ready", { status: 503 });
      }
    }),
    /fixed deadline/u
  );
  assert.ok(requests >= 2);
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("readiness rejects a server without the exact released-kernel contract", async () => {
  const fake = createFakeDocker();
  let clock = 0;
  let kernelspecRequests = 0;
  await assert.rejects(
    startWithFake(fake, {
      readyTimeoutMs: 200,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: async (url) => {
        if (url.endsWith("/api/kernelspecs")) {
          kernelspecRequests += 1;
          return kernelspecResponse({
            kernelspecs: {
              "openwrangler-remote-acceptance": {
                name: "openwrangler-remote-acceptance",
                spec: {
                  argv: ["/usr/local/bin/python", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                  display_name: "wrong display name",
                  language: "python"
                }
              }
            }
          });
        }
        return readyResponse();
      }
    }),
    /fixed deadline/u
  );
  assert.ok(kernelspecRequests >= 2);
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("Docker output containing authentication material is rejected without echoing it", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result }) {
      if (input.args[0] === "exec") return success(`${TOKEN}\n`);
      return result;
    }
  });
  let error;
  try {
    await startWithFake(fake);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes(TOKEN), false);
  assert.match(error.message, /forbidden authentication material/u);
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("an unproven built-image label latches uncertainty without cleanup access", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result }) {
      if (input.args[0] === "image" && input.args[1] === "inspect") {
        return success(`${IMAGE_ID}\tsomeone-else\n`);
      }
      return result;
    }
  });

  let error;
  try {
    await startWithFake(fake);
  } catch (caught) {
    error = caught;
  }
  assert.ok(remoteJupyterOwnershipMayBeLive(error));
  assert.match(error.message, /runtime image ownership could not be established/u);
  assert.equal(fake.commands.at(-1).args[0], "image");
  assert.equal(fake.commands.at(-1).args[1], "inspect");
  assert.equal(
    fake.commands.some(({ args }) => args[0] === "image" && args[1] === "rm"),
    false
  );
  assert.equal(fake.state.imagePresent, true);
});

linuxTest("cleanup refuses mutation when the Docker engine identity changes and latches uncertainty", async () => {
  const fake = createFakeDocker();
  const fixture = await startWithFake(fake);
  fake.state.engineId = "OWDOCKER:ENGINE:87654321";

  let uncertainty;
  try {
    await fixture.cleanup();
  } catch (error) {
    uncertainty = error;
  }
  assert.ok(remoteJupyterOwnershipMayBeLive(uncertainty));
  assert.equal(uncertainty.code, REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE);
  assert.match(uncertainty.message, /disappearance could not be proven/u);
  assert.equal(fake.state.containerPresent, true);
  assert.equal(
    fake.commands.some(({ args }) => args[0] === "container" && args[1] === "rm"),
    false
  );
  const commandCount = fake.commands.length;
  await assert.rejects(fixture.cleanup(), /ownership-uncertain/u);
  assert.equal(fake.commands.length, commandCount);
});

linuxTest("cleanup fails when disappearance cannot be attested", async () => {
  const fake = createFakeDocker({
    alterResult({ input, result, state }) {
      if (
        input.args[0] === "container" &&
        input.args[1] === "ls" &&
        input.args.at(-1) === `id=${CONTAINER_ID}` &&
        !state.containerPresent
      ) {
        return success(`${CONTAINER_ID}\n`);
      }
      return result;
    }
  });
  let clock = 0;
  const fixture = await startWithFake(fake, {
    cleanupTimeoutMs: 200,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    }
  });

  await assert.rejects(fixture.cleanup(), /disappearance could not be proven/u);
  assert.equal(fake.state.imagePresent, true);
  assert.equal(clock, 200);
});

linuxTest("cleanup gives every Docker command only the shared remaining deadline", async () => {
  let clock = 0;
  let cleanupActive = false;
  const fake = createFakeDocker({
    alterResult({ result }) {
      if (cleanupActive) clock += 40;
      return result;
    }
  });
  const fixture = await startWithFake(fake, {
    cleanupTimeoutMs: 200,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    }
  });
  const cleanupStart = fake.commands.length;
  cleanupActive = true;
  await assert.rejects(fixture.cleanup(), /disappearance could not be proven/u);
  const cleanupCommands = fake.commands.slice(cleanupStart);
  assert.ok(cleanupCommands.length > 1);
  assert.ok(cleanupCommands.length <= 5);
  assert.deepEqual(
    cleanupCommands.map(({ options }) => options.timeoutMs),
    cleanupCommands.map((_command, index) => 200 - index * 40)
  );
  assert.equal(clock, 200);
});

linuxTest("Docker availability failure happens before any mutating command", async () => {
  const commands = [];
  await assert.rejects(
    startRemoteJupyterAcceptanceFixture(
      { token: TOKEN, runId: RUN_ID },
      {
        environment: enabledEnvironment(),
        dockerPrivateDirectory: PRIVATE_DIRECTORY,
        randomUUIDImpl: () => OWNER_ID,
        runCommand: async (input) => {
          commands.push([...input.args]);
          return { exitCode: 127, stdout: "", stderr: TOKEN };
        }
      }
    ),
    (error) => error instanceof Error && !error.message.includes(TOKEN)
  );
  assert.deepEqual(
    commands.map((args) => args[0]),
    ["version"]
  );
});

linuxTest("Docker availability accepts the hosted Linux x86_64 report without an optional platform label", async () => {
  const fake = createFakeDocker();

  const fixture = await startWithFake(fake);
  await fixture.cleanup();

  const versionProbe = fake.commands.find(({ args }) => args[0] === "version");
  assert.deepEqual(versionProbe?.args, ["version", "--format", "{{.Server.Version}}"]);
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("Docker availability treats a bounded vendor version as an opaque engine identity", async () => {
  const fake = createFakeDocker();
  fake.state.versionReport = fake.state.engineVersion = "28.0.4+azure-1~ubuntu.24.04~noble";

  const fixture = await startWithFake(fake);
  await fixture.cleanup();

  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("Docker availability rejects malformed, control-bearing, and oversized server versions", async (t) => {
  const invalidVersions = [
    ["malformed", "28.0.4 vendor"],
    ["control-bearing", "28.0.4\u001b[31m"],
    ["oversized", "v".repeat(129)]
  ];

  for (const [label, engineVersion] of invalidVersions) {
    await t.test(label, async () => {
      const fake = createFakeDocker();
      fake.state.versionReport = engineVersion;

      await assert.rejects(startWithFake(fake), /requires a bounded Linux Docker Engine/u);
      assert.deepEqual(
        fake.commands.map(({ args }) => args[0]),
        ["version"]
      );
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.imagePresent, false);
    });
  }
});

linuxTest("Docker identity accepts the canonical amd64 architecture spelling", async () => {
  const fake = createFakeDocker();
  fake.state.identityArchitecture = "amd64";

  const fixture = await startWithFake(fake);
  await fixture.cleanup();

  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("Docker identity rejects a version mismatch before mutation", async () => {
  const fake = createFakeDocker();
  fake.state.engineVersion = "28.3.1";

  await assert.rejects(startWithFake(fake), /engine identity is malformed or inconsistent/u);
  assert.equal(
    fake.commands.some(({ args }) => ["build", "run"].includes(args[0])),
    false
  );
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});

linuxTest("Docker availability still rejects non-Linux and non-x86-64 engines before mutation", async (t) => {
  const invalidEngines = [
    ["operating system", { identityOperatingSystem: "windows" }],
    ["architecture", { identityArchitecture: "arm64" }]
  ];

  for (const [label, state] of invalidEngines) {
    await t.test(label, async () => {
      const fake = createFakeDocker();
      Object.assign(fake.state, state);

      await assert.rejects(startWithFake(fake), /engine identity is malformed or inconsistent/u);
      assert.equal(
        fake.commands.some(({ args }) => ["build", "run"].includes(args[0])),
        false
      );
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.imagePresent, false);
    });
  }
});

linuxTest("an unverified Docker CLI tree prevents every subsequent Docker or cleanup command", async () => {
  const commands = [];
  const uncertainty = new Error("Docker CLI process tree remains live");
  uncertainty.code = REMOTE_JUPYTER_OWNERSHIP_UNCERTAIN_CODE;
  await assert.rejects(
    startRemoteJupyterAcceptanceFixture(
      { token: TOKEN, runId: RUN_ID },
      {
        environment: enabledEnvironment(),
        dockerPrivateDirectory: PRIVATE_DIRECTORY,
        randomUUIDImpl: () => OWNER_ID,
        runCommand: async (input) => {
          commands.push([...input.args]);
          throw uncertainty;
        }
      }
    ),
    (error) => error === uncertainty && remoteJupyterOwnershipMayBeLive(error)
  );
  assert.deepEqual(
    commands.map((args) => args[0]),
    ["version"]
  );
});

linuxTest(
  "timed-out build or launch completion is reported as potentially live even after safe discovery cleanup",
  async () => {
    for (const failedCommand of ["build", "run"]) {
      const fake = createFakeDocker({
        alterResult({ input, result, state }) {
          if (input.args[0] === failedCommand) {
            if (failedCommand === "build") state.imagePresent = false;
            const error = new Error(`untrusted failure containing ${TOKEN}`);
            error.code = "REMOTE_JUPYTER_DOCKER_COMPLETION_UNKNOWN";
            throw error;
          }
          return result;
        }
      });
      let error;
      try {
        await startWithFake(fake);
      } catch (caught) {
        error = caught;
      }
      assert.ok(remoteJupyterOwnershipMayBeLive(error), `${failedCommand} failure was not latched`);
      assert.equal(error.message.includes(TOKEN), false);
      assert.equal(fake.state.containerPresent, false);
      assert.equal(fake.state.imagePresent, false);
    }
  }
);

linuxTest("completed build and launch failures retain diagnostics after owned cleanup", async () => {
  for (const failedCommand of ["build", "run"]) {
    const fake = createFakeDocker({
      alterResult({ input, result }) {
        if (input.args[0] === failedCommand) {
          return { exitCode: 1, stdout: "", stderr: "ordinary completed failure" };
        }
        return result;
      }
    });
    let error;
    try {
      await startWithFake(fake);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(remoteJupyterOwnershipMayBeLive(error), false);
    assert.equal(fake.state.containerPresent, false);
    assert.equal(fake.state.imagePresent, false);
  }
});

test("the container definition pins its base and direct wheels and never receives a secret in metadata", async () => {
  const dockerfile = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile"), "utf8");
  const requirementsInput = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "requirements.in"), "utf8");
  const requirements = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "requirements.txt"), "utf8");
  const server = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "server.py"), "utf8");
  const injector = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "inject-token.py"), "utf8");
  const runner = await readFile(resolve(SCRIPT_DIRECTORY, "run-packaged-editor-tests.mjs"), "utf8");
  const workflow = await readFile(
    resolve(SCRIPT_DIRECTORY, "..", ".github", "workflows", "released-jupyter.yml"),
    "utf8"
  );

  assert.ok(dockerfile.startsWith(`FROM ${REMOTE_JUPYTER_BASE_IMAGE}\n`));
  assert.match(dockerfile, /--only-binary=:all:/u);
  assert.match(dockerfile, /--require-hashes/u);
  assert.match(dockerfile, /--name openwrangler-remote-acceptance/u);
  assert.match(dockerfile, /--display-name "Open Wrangler Remote Acceptance"/u);
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["python", "-I", "\/opt\/openwrangler\/server\.py"\]$/mu);
  assert.equal(/OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(dockerfile), false);
  for (const line of requirementsInput.trim().split("\n")) {
    assert.match(line, /^[a-z][a-z0-9-]*==[0-9]+(?:\.[0-9]+)+(?:[-+._a-z0-9]*)?$/u);
  }
  assert.deepEqual(
    requirementsInput
      .trim()
      .split("\n")
      .map((line) => line.split("==")[0]),
    ["duckdb", "ipykernel", "jupyter-server", "pandas", "polars"]
  );
  const lockedEntries = [
    ...requirements.matchAll(/^([a-z][a-z0-9-]*)==[^\s\\]+ \\\n((?: {4}--hash=sha256:[0-9a-f]{64}(?: \\\n|$))+)/gmu)
  ];
  assert.ok(lockedEntries.length > 50);
  assert.equal(requirements.replaceAll(/--hash=sha256:[0-9a-f]{64}/gu, "").includes("--hash="), false);
  for (const dependency of [
    "duckdb",
    "ipykernel",
    "ipython",
    "jupyter-server",
    "pandas",
    "polars",
    "polars-runtime-32"
  ]) {
    assert.ok(
      lockedEntries.some((entry) => entry[1] === dependency),
      `missing locked ${dependency}`
    );
  }
  assert.match(server, /config\.IdentityProvider\.token = token/u);
  assert.match(server, /TOKEN_PATH\.unlink\(\)/u);
  assert.match(server, /^TOKEN_WAIT_SECONDS = 300$/mu);
  assert.equal(/sys\.argv/u.test(server), false);
  assert.equal(/^from (?:IPython|jupyter_server|traitlets)/mu.test(server), false);
  assert.match(server, /if find_spec\("IPython"\) is not None:/u);
  assert.equal(/config\.ServerApp\.(?:config_dir|runtime_dir)/u.test(server), false);
  const pathVariables = ["JUPYTER_CONFIG_DIR", "JUPYTER_DATA_DIR", "JUPYTER_RUNTIME_DIR", "IPYTHONDIR"];
  assert.deepEqual(
    [...server.matchAll(/os\.environ\["([A-Z_]+)"\] =/gu)].map((match) => match[1]),
    pathVariables
  );
  assert.equal(server.match(/os\.environ\[/gu)?.length, pathVariables.length);
  assert.equal(/OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(server), false);
  const tokenRead = server.indexOf("    token = read_token()");
  const pathSetup = server.indexOf("    directories = prepare_jupyter_environment()");
  const jupyterImport = server.indexOf("    from jupyter_server.serverapp import ServerApp");
  assert.ok(tokenRead >= 0 && tokenRead < pathSetup && pathSetup < jupyterImport);
  assert.match(server, /Remote Jupyter path isolation could not be established\./u);
  assert.match(injector, /sys\.stdin\.buffer\.read\(TOKEN_LIMIT \+ 1\)/u);
  assert.match(injector, /os\.O_EXCL/u);
  assert.match(injector, /renameat2/u);
  assert.match(injector, /RENAME_NOREPLACE/u);
  assert.match(injector, /TOKEN_PENDING_PATH/u);
  assert.match(injector, /os\.fsync\(directory_descriptor\)/u);
  assert.equal(/print\(|sys\.stdout/u.test(injector), false);
  assert.match(workflow, /OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1"/u);
  assert.equal(/OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(workflow), false);
  for (const phase of ["jupyter-remote-setup", "jupyter-remote", "jupyter-remote-cleanup"]) {
    assert.match(runner, new RegExp(`"${phase}": resolve\\(\\s*profile,\\s*"${phase}-result\\.json"\\s*\\)`, "u"));
  }
  assert.equal(REMOTE_JUPYTER_SETUP_TIMEOUT_MS, 300_000);
  assert.equal(REMOTE_JUPYTER_SETUP_INACTIVITY_TIMEOUT_MS, 180_000);
  assert.equal(REMOTE_JUPYTER_SETUP_HEARTBEAT_MS, 60_000);
});

test("the R container definition pins R, package snapshots, and its exact kernelspec", async () => {
  const baseDockerfile = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile.r.base"), "utf8");
  const dockerfile = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "Dockerfile.r"), "utf8");
  const dockerignore = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", ".dockerignore"), "utf8");
  const requirementsInput = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "requirements.r.in"), "utf8");
  const requirements = await readFile(resolve(SCRIPT_DIRECTORY, "remote-jupyter", "requirements.r.txt"), "utf8");
  const runner = await readFile(resolve(SCRIPT_DIRECTORY, "run-packaged-editor-tests.mjs"), "utf8");

  assert.ok(baseDockerfile.startsWith(`FROM ${REMOTE_R_JUPYTER_BASE_IMAGE}\n`));
  assert.match(baseDockerfile, /^ARG UBUNTU_SNAPSHOT=20260311T000000Z$/mu);
  assert.match(baseDockerfile, /https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\$\{UBUNTU_SNAPSHOT\}/u);
  assert.ok(
    dockerfile.startsWith("ARG OPEN_WRANGLER_REMOTE_R_BASE_IMAGE\nFROM ${OPEN_WRANGLER_REMOTE_R_BASE_IMAGE}\n")
  );
  assert.match(dockerfile, /^ARG R_REPOSITORY=https:\/\/p3m\.dev\/cran\/__linux__\/noble\/2026-03-10$/mu);
  assert.match(dockerfile, /^ARG R_SUPPLEMENTAL_REPOSITORY=https:\/\/p3m\.dev\/cran\/__linux__\/noble\/2026-06-01$/mu);
  for (const [name, version] of [
    ["IRKERNEL_VERSION", "1.3.2"],
    ["JSONLITE_VERSION", "2.0.0"],
    ["RLANG_VERSION", "1.1.7"],
    ["TIBBLE_VERSION", "3.3.1"],
    ["DATA_TABLE_VERSION", "1.18.2.1"],
    ["COLLAPSE_VERSION", "2.1.7"],
    ["NANOPARQUET_VERSION", "0.5.1"]
  ]) {
    assert.match(dockerfile, new RegExp(`^ARG ${name}=${version.replaceAll(".", "\\.")}$`, "mu"));
  }
  assert.match(baseDockerfile, /--only-binary=:all:/u);
  assert.match(baseDockerfile, /--require-hashes/u);
  assert.match(baseDockerfile, /--requirement \/opt\/openwrangler\/requirements\.r\.txt/u);
  assert.match(baseDockerfile, /python -I -m pip check/u);
  for (const forbidden of [
    /install\.packages/u,
    /IRkernel::installspec/u,
    /COPY inject-token\.py server\.py/u,
    /^ENTRYPOINT /mu
  ]) {
    assert.doesNotMatch(baseDockerfile, forbidden);
  }
  for (const forbidden of [/apt-get/u, /python3 -m venv/u, /python -I -m pip install/u, /COPY requirements\.r\.txt/u]) {
    assert.doesNotMatch(dockerfile, forbidden);
  }
  assert.match(dockerfile, /supplemental_repository <- Sys\.getenv\("R_SUPPLEMENTAL_REPOSITORY"\)/u);
  assert.match(dockerfile, /collapse = Sys\.getenv\("COLLAPSE_VERSION"\)/u);
  assert.match(dockerfile, /nanoparquet = Sys\.getenv\("NANOPARQUET_VERSION"\)/u);
  assert.match(dockerfile, /install\.packages\(c\("collapse", "nanoparquet"\), repos = supplemental_repository/u);
  assert.match(dockerfile, /as\.character\(getRversion\(\)\) == "4\.5\.2"/u);
  assert.match(dockerfile, /identical\(actual, expected\)/u);
  assert.match(dockerfile, /name = "openwrangler-r-remote-acceptance"/u);
  assert.match(dockerfile, /displayname = "R \(Open Wrangler Remote\)"/u);
  assert.match(dockerfile, /^USER 65532:65532$/mu);
  assert.match(dockerfile, /^ENTRYPOINT \["python", "-I", "\/opt\/openwrangler\/server\.py"\]$/mu);
  assert.equal(/OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(dockerfile), false);
  assert.equal(/OPEN_WRANGLER_REMOTE_TOKEN|JUPYTER_TOKEN/u.test(baseDockerfile), false);
  assert.equal(requirementsInput, "jupyter-server==2.20.0\n");
  for (const dependency of ["duckdb", "ipykernel", "ipython", "pandas", "polars", "polars-runtime-32"]) {
    assert.doesNotMatch(requirements, new RegExp(`^${dependency}==`, "mu"));
  }
  assert.ok((requirements.match(/^[a-z][a-z0-9-]*==/gmu) ?? []).length > 40);
  assert.match(dockerignore, /^!Dockerfile\.r$/mu);
  assert.match(dockerignore, /^!Dockerfile\.r\.base$/mu);
  assert.match(dockerignore, /^!requirements\.r\.in$/mu);
  assert.match(dockerignore, /^!requirements\.r\.txt$/mu);
  for (const phase of [
    "jupyter-r-remote-base-build",
    "jupyter-r-remote-runtime-build",
    "jupyter-r-remote-setup",
    "jupyter-r-remote",
    "jupyter-r-remote-cleanup"
  ]) {
    assert.match(runner, new RegExp(`"${phase}": resolve\\(\\s*profile,\\s*"${phase}-result\\.json"\\s*\\)`, "u"));
  }
});

test("remote R orchestration keeps five uniquely correlated phase identities and exact stage routing", async () => {
  const runner = await readFile(resolve(SCRIPT_DIRECTORY, "run-packaged-editor-tests.mjs"), "utf8");
  const phases = [
    "jupyter-r-remote-base-build",
    "jupyter-r-remote-runtime-build",
    "jupyter-r-remote-setup",
    "jupyter-r-remote",
    "jupyter-r-remote-cleanup"
  ];
  const resultPathsStart = runner.indexOf("const resultPaths = {");
  const runIdsStart = runner.indexOf("const runIds = {", resultPathsStart);
  const progressPathsStart = runner.indexOf("const progressPaths = Object.fromEntries(", runIdsStart);
  const userDataStart = runner.indexOf("const userDataByPhase = new Map([", progressPathsStart);
  const activePhaseStart = runner.indexOf('let activePhase = "setup";', userDataStart);
  assert.ok(
    resultPathsStart >= 0 &&
      runIdsStart > resultPathsStart &&
      progressPathsStart > runIdsStart &&
      userDataStart > progressPathsStart &&
      activePhaseStart > userDataStart
  );
  const resultPathsSource = runner.slice(resultPathsStart, runIdsStart);
  const runIdsSource = runner.slice(runIdsStart, progressPathsStart);
  const progressPathsSource = runner.slice(progressPathsStart, userDataStart);
  const userDataSource = runner.slice(userDataStart, activePhaseStart);

  for (const phase of phases) {
    assert.equal(
      (
        resultPathsSource.match(new RegExp(`"${phase}": resolve\\(\\s*profile,\\s*"${phase}-result\\.json"`, "gu")) ??
        []
      ).length,
      1,
      `${phase} must own one result path`
    );
    assert.equal(
      (runIdsSource.match(new RegExp(`"${phase}": randomUUID\\(\\)`, "gu")) ?? []).length,
      1,
      `${phase} must own one random run ID`
    );
    assert.equal(
      (userDataSource.match(new RegExp(`\\["${phase}", jupyterRemoteRUserData\\]`, "gu")) ?? []).length,
      1,
      `${phase} must own the fixed remote-R user-data root`
    );
  }
  assert.match(
    progressPathsSource,
    /Object\.entries\(resultPaths\)\.map\(\(\[phase, resultPath\]\) => \[\s*phase,\s*editorAcceptanceProgressPath\(resultPath, runIds\[phase\], phase\)\s*\]\)/u
  );

  const stageMapStart = runner.indexOf("const remoteSetupPhaseByStage = new Map([", activePhaseStart);
  const stageMapEnd = runner.indexOf("const remoteRunId =", stageMapStart);
  assert.ok(stageMapStart >= 0 && stageMapEnd > stageMapStart);
  const stageMapSource = runner.slice(stageMapStart, stageMapEnd);
  assert.deepEqual(
    [...stageMapSource.matchAll(/\["(base-build|runtime-build|setup)", ([^\]]+)\]/gu)].map((match) => [
      match[1],
      match[2]
    ]),
    [
      ["base-build", "remoteBaseBuildPhase ?? remoteSetupPhase"],
      ["runtime-build", "remoteRuntimeBuildPhase ?? remoteSetupPhase"],
      ["setup", "remoteSetupPhase"]
    ]
  );

  const checkpointRouterStart = runner.indexOf("onSetupCheckpoint:", stageMapEnd);
  const checkpointRouterEnd = runner.indexOf("onCleanupCheckpoint:", checkpointRouterStart);
  assert.ok(checkpointRouterStart >= 0 && checkpointRouterEnd > checkpointRouterStart);
  const checkpointRouter = runner.slice(checkpointRouterStart, checkpointRouterEnd);
  assert.match(checkpointRouter, /const checkpointPhase = remoteSetupPhaseByStage\.get\(stage\)/u);
  assert.match(checkpointRouter, /activePhase = checkpointPhase/u);
  assert.match(
    checkpointRouter,
    /publishRemoteProgress\(\s*progressPaths\[checkpointPhase\],\s*runIds\[checkpointPhase\],\s*checkpointPhase,/u
  );

  const cleanupRouterStart = checkpointRouterEnd;
  const cleanupRouterEnd = runner.indexOf("}\n                    );", cleanupRouterStart);
  assert.ok(cleanupRouterEnd > cleanupRouterStart);
  const cleanupRouter = runner.slice(cleanupRouterStart, cleanupRouterEnd);
  assert.match(cleanupRouter, /const cleanupOrigin = remoteSetupPhaseByStage\.get\(originatingPhase\)/u);
  assert.match(cleanupRouter, /publishRemoteCleanupCheckpoint\(checkpoint, cleanupOrigin\)/u);

  const remotePhaseStart = runner.indexOf("const runRemoteJupyterPhase = async (", activePhaseStart);
  const remotePhaseEnd = runner.indexOf(
    'if (jupyterExtensionInstallTarget && acceptanceMode === "r-jupyter")',
    remotePhaseStart
  );
  assert.ok(remotePhaseStart >= 0 && remotePhaseEnd > remotePhaseStart);
  const remotePhaseSource = runner.slice(remotePhaseStart, remotePhaseEnd);
  assert.match(
    remotePhaseSource,
    /publishRemoteProgress\(\s*progressPaths\[remoteCleanupPhase\],\s*remoteCleanupRunId,\s*remoteCleanupPhase,/u
  );
  assert.match(remotePhaseSource, /activePhase = remoteEditorPhase/u);
  assert.match(remotePhaseSource, /phase: remoteEditorPhase/u);
  assert.match(remotePhaseSource, /resultPath: resultPaths\[remoteEditorPhase\]/u);
  assert.match(remotePhaseSource, /runId: remoteRunId/u);
  assert.match(remotePhaseSource, /progressPath: progressPaths\[remoteEditorPhase\]/u);

  const invocationStart = runner.indexOf("if (remoteRJupyterEnabled) {", remotePhaseEnd);
  const invocationEnd = runner.indexOf("});", invocationStart);
  assert.ok(invocationStart >= 0 && invocationEnd > invocationStart);
  const invocationSource = runner.slice(invocationStart, invocationEnd);
  for (const [property, phase] of [
    ["baseBuild", phases[0]],
    ["runtimeBuild", phases[1]],
    ["setup", phases[2]],
    ["editor", phases[3]],
    ["cleanup", phases[4]]
  ]) {
    assert.match(invocationSource, new RegExp(`${property}: "${phase}"`, "u"));
  }
});

test("the private released-Jupyter profiles suppress unrelated extension recommendations", async () => {
  const runner = await readFile(resolve(SCRIPT_DIRECTORY, "run-packaged-editor-tests.mjs"), "utf8");
  assert.match(runner, /"extensions\.ignoreRecommendations": true/u);
});

test("the default bounded runner rejects oversized output without invoking Docker", async () => {
  await assert.rejects(
    runBoundedDockerCommand(
      {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(2048))'],
        environment: BOUNDED_RUNNER_ENVIRONMENT,
        label: "bounded test"
      },
      { timeoutMs: 5_000, maxOutputBytes: 128 }
    ),
    /fixed output bound/u
  );
});

test("the bounded runner treats ChildProcess error as data and settles only after correlated close", async () => {
  const child = createFakeChild();
  const killCalls = [];
  let spawnOptions;
  let rejectionObserved = false;
  const pending = runBoundedDockerCommand(
    {
      executable: process.execPath,
      args: ["-e", "void 0"],
      environment: BOUNDED_RUNNER_ENVIRONMENT,
      label: "late-error test"
    },
    {
      timeoutMs: 1_000,
      forceCloseTimeoutMs: 100,
      platform: "linux",
      spawnProcess: (_executable, _args, options) => {
        spawnOptions = options;
        return child;
      },
      killProcessGroup: (...args) => killCalls.push(args)
    }
  );
  pending.catch(() => {
    rejectionObserved = true;
  });

  child.emit("error", new Error("late child error"));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(rejectionObserved, false);
  assert.equal(spawnOptions.detached, true);
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0][0], child);
  assert.equal(killCalls[0][1], "SIGKILL");
  assert.equal(killCalls[0][2], "linux");

  child.emit("close", null, "SIGKILL");
  await assert.rejects(pending, /could not start or remain attached/u);
  assert.equal(rejectionObserved, true);
});

test("the bounded runner reports ownership uncertainty when forced process-tree close is not observed", async () => {
  const child = createFakeChild();
  await assert.rejects(
    runBoundedDockerCommand(
      {
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        environment: BOUNDED_RUNNER_ENVIRONMENT,
        label: "unclosed process test"
      },
      {
        timeoutMs: 30,
        forceCloseTimeoutMs: 10,
        platform: "linux",
        spawnProcess: () => child,
        killProcessGroup: () => {}
      }
    ),
    (error) =>
      remoteJupyterOwnershipMayBeLive(error) &&
      /process-tree shutdown could not be proven within its fixed deadline/u.test(error.message)
  );
});

test("an attached Docker heartbeat failure forces shutdown and waits for observed process-group close", async () => {
  const child = createFakeChild();
  const killCalls = [];
  let checkpoints = 0;
  let settled = false;
  const pending = runBoundedDockerCommand(
    {
      executable: process.execPath,
      args: ["version"],
      environment: BOUNDED_RUNNER_ENVIRONMENT,
      label: "checkpoint failure test"
    },
    {
      timeoutMs: 500,
      forceCloseTimeoutMs: 100,
      progressIntervalMs: 10,
      onProgress: () => {
        checkpoints += 1;
        throw new Error("checkpoint publication failed");
      },
      platform: "linux",
      spawnProcess: () => child,
      killProcessGroup: (...args) => killCalls.push(args)
    }
  );
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  await delay(30);
  assert.equal(checkpoints, 1);
  assert.equal(killCalls.length, 1);
  assert.equal(settled, false);
  child.emit("close", null, "SIGKILL");
  await assert.rejects(
    pending,
    (error) =>
      remoteJupyterOwnershipMayBeLive(error) && /could not preserve private-root ownership/u.test(error.message)
  );
  assert.equal(settled, true);
  await delay(20);
  assert.equal(checkpoints, 1);
});

linuxTest("the bounded runner owns and terminates a descendant process group", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openwrangler-docker-process-group-test-"));
  const heartbeatPath = join(directory, "heartbeat");
  const descendantSource =
    'const fs=require("node:fs");const p=process.argv[1];fs.appendFileSync(p,"x");' +
    'setInterval(()=>fs.appendFileSync(p,"x"),10);setTimeout(()=>process.exit(0),5000).unref();';
  const parentSource =
    'const {spawn}=require("node:child_process");const fs=require("node:fs");' +
    "spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});" +
    "const ready=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(ready);" +
    'process.stdout.write("x".repeat(2048));}},10);setTimeout(()=>process.exit(0),5000).unref();';
  try {
    await assert.rejects(
      runBoundedDockerCommand(
        {
          executable: process.execPath,
          args: ["-e", parentSource, descendantSource, heartbeatPath],
          environment: BOUNDED_RUNNER_ENVIRONMENT,
          label: "descendant process-group test"
        },
        { timeoutMs: 2_000, forceCloseTimeoutMs: 200, maxOutputBytes: 128 }
      ),
      /fixed output bound/u
    );
    await delay(50);
    const first = statSync(heartbeatPath);
    await delay(100);
    const second = statSync(heartbeatPath);
    assert.equal(second.size, first.size);
    assert.equal(second.mtimeMs, first.mtimeMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

linuxTest("a regressing injected clock fails closed without extending readiness", async () => {
  const fake = createFakeDocker();
  let clockCalls = 0;
  await assert.rejects(
    startWithFake(fake, {
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) return 100;
        if (clockCalls === 2) return 99;
        return 100 + clockCalls;
      }
    }),
    /monotonic time source regressed/u
  );
  assert.equal(fake.state.containerPresent, false);
  assert.equal(fake.state.imagePresent, false);
});
