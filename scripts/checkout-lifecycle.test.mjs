import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CheckoutLifecycleError, createCheckoutManager, normalizeWorktreeRegistryPath } from "./checkout-lifecycle.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "checkout-lifecycle.mjs");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function fixtureRun(behavior = {}) {
  return (command, args, options = {}) => {
    if (command === "git") {
      (behavior.gitCalls ??= []).push({ args: [...args], env: options.env });
    }
    if (command === "git" && ["fetch", "pull", "push", "ls-remote"].some((item) => args.includes(item))) {
      (behavior.networkCommands ??= []).push([...args]);
    }
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      input: options.input,
      maxBuffer: 4 * 1024 * 1024,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        options.stdoutFd === undefined ? "pipe" : options.stdoutFd,
        "pipe"
      ]
    });
    const normalized = Object.freeze({
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    });
    if (!options.allowFailure) {
      assert.equal(normalized.status, 0, `${command} ${args.join(" ")} failed: ${normalized.stderr}`);
    }
    if (command === "git" && args.includes("worktree") && args.includes("list") && behavior.worktreeTransform) {
      return Object.freeze({ ...normalized, stdout: behavior.worktreeTransform(normalized.stdout) });
    }
    return normalized;
  };
}

function withRepository(callback) {
  const root = mkdtempSync(join(tmpdir(), "ow-checkout-v2-"));
  chmodSync(root, 0o700);
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  const managerRoot = join(root, "manager");
  mkdirSync(repository, { mode: 0o700 });
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.name", "Checkout Test");
  git(repository, "config", "user.email", "checkout@example.invalid");
  writeFileSync(join(repository, "README.md"), "fixture\n");
  writeFileSync(join(repository, ".gitignore"), "node_modules/\n*.ignored\ntmp/\n");
  git(repository, "add", ".");
  git(repository, "commit", "-q", "-m", "Create fixture");
  git(root, "init", "-q", "--bare", remote);
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-q", "-u", "origin", "main");
  try {
    callback({ root, repository, managerRoot });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function manager(fixture, options = {}) {
  return createCheckoutManager({ repositoryPath: fixture.repository, managerRoot: fixture.managerRoot, ...options });
}

function defaultManager(fixture, options = {}) {
  return createCheckoutManager({ repositoryPath: fixture.repository, ...options });
}

function create(fixture, slug, options = {}) {
  return (options.manager ?? manager(fixture)).create({
    slug,
    branch: `agent/${slug}`,
    ownerTask: options.ownerTask ?? `/root/${slug}`,
    generatedRoots: options.generatedRoots ?? []
  });
}

function entry(fixture, slug, root = fixture.managerRoot) {
  return entryHistory(fixture, slug, root).at(-1);
}

function entryPaths(fixture, slug, root = fixture.managerRoot) {
  return readdirSync(join(root, "entries"))
    .filter((name) => name.startsWith(`${slug}.`) && name.endsWith(".json"))
    .sort((left, right) => Number(left.split(".").at(-2)) - Number(right.split(".").at(-2)))
    .map((name) => join(root, "entries", name));
}

function entryHistory(fixture, slug, root = fixture.managerRoot) {
  return entryPaths(fixture, slug, root).map((path) => JSON.parse(readFileSync(path, "utf8")));
}

function registryBytes(fixture) {
  return Object.fromEntries(
    readdirSync(join(fixture.managerRoot, "entries"))
      .sort()
      .map((name) => [name, readFileSync(join(fixture.managerRoot, "entries", name)).toString("base64")])
  );
}

function managerTreeBytes(fixture) {
  const snapshot = {};
  const walk = (directory, prefix = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const relativePath = prefix === "" ? item.name : `${prefix}/${item.name}`;
      const path = join(directory, item.name);
      if (item.isDirectory()) {
        snapshot[`${relativePath}/`] = null;
        walk(path, relativePath);
      } else if (item.isFile()) snapshot[relativePath] = readFileSync(path).toString("base64");
      else snapshot[relativePath] = "non-regular";
    }
  };
  walk(fixture.managerRoot);
  return snapshot;
}

function lifecycleError(callback, code) {
  assert.throws(callback, (error) => error instanceof CheckoutLifecycleError && error.code === code);
}

test("audit is byte-stable and status explicitly reconciles an interrupted create", () => {
  withRepository((fixture) => {
    const interrupted = manager(fixture, { hooks: { afterGitBeforeActive: () => assert.fail("shutdown") } });
    assert.throws(
      () => interrupted.create({ slug: "durable", branch: "agent/durable", ownerTask: "/root/durable" }),
      /shutdown/u
    );
    const beforeAudit = managerTreeBytes(fixture);
    const incompleteAudit = manager(fixture).audit("durable");
    assert.equal(incompleteAudit.state, "creating");
    assert(incompleteAudit.issues.includes("creation-incomplete"));
    assert.deepEqual(managerTreeBytes(fixture), beforeAudit);
    assert.equal(entryHistory(fixture, "durable").length, 1);
    const status = manager(fixture).status("durable")[0];
    const audit = manager(fixture).audit("durable");
    const record = entry(fixture, "durable");
    assert.deepEqual(
      { state: status.state, owner: status.ownerTask, registered: status.registered },
      { state: "active", owner: "/root/durable", registered: true }
    );
    assert.equal(audit.receiptMatches, true);
    assert.equal(audit.candidateForReviewedCleanup, true);
    assert.match(record.checkout.directory.inode, /^\d+$/u);
    assert.match(record.checkout.gitAdmin.gitdir.identity.inode, /^\d+$/u);
    assert.equal("pid" in record, false);
    assert.equal(record.generation, 2);
  });
});

test("audit does not create a missing manager root", () => {
  withRepository((fixture) => {
    const managed = manager(fixture);
    assert.equal(existsSync(fixture.managerRoot), false);
    lifecycleError(() => managed.audit("missing"), "checkout-not-found");
    assert.equal(existsSync(fixture.managerRoot), false);
  });
});

test("the real child-process mutex serializes commands and handoff invalidates the old revision", () => {
  withRepository((fixture) => {
    const managed = defaultManager(fixture);
    const checkout = create(fixture, "mutex", { manager: managed });
    let child;
    defaultManager(fixture, {
      hooks: {
        afterOperationLockAcquired() {
          child = spawnSync(process.execPath, [SCRIPT, "status", "mutex"], {
            cwd: checkout.checkoutPath,
            encoding: "utf8"
          });
        }
      }
    }).status("mutex");
    assert.equal(child.status, 1);
    assert.match(child.stderr, /manager-busy/u);
    const nextGeneration =
      Math.max(
        ...readdirSync(managed.paths.locks)
          .map((name) => Number(name.split(".")[0]))
          .filter(Number.isFinite)
      ) + 1;
    writeFileSync(
      join(managed.paths.locks, `${nextGeneration}.claim.json`),
      `${JSON.stringify({
        protocol: "openwrangler-checkout-operation-lock-v2",
        generation: nextGeneration,
        pid: 2_000_000_000,
        token: "a".repeat(32)
      })}\n`,
      { flag: "wx", mode: 0o600 }
    );
    assert.equal(defaultManager(fixture, { isProcessAlive: () => false }).status("mutex")[0].state, "active");
    const handoff = managed.handoff({
      slug: "mutex",
      ownerTask: "/root/mutex",
      nextOwnerTask: "/root/next",
      expectedRevision: 1
    });
    assert.equal(handoff.revision, 2);
    lifecycleError(
      () =>
        managed.handoff({
          slug: "mutex",
          ownerTask: "/root/mutex",
          nextOwnerTask: "/root/other",
          expectedRevision: 1
        }),
      "ownership-changed"
    );
  });
});

test("finish durably requests review and retains a file created at the former deletion boundary", () => {
  withRepository((fixture) => {
    let checkout;
    const managed = manager(fixture, {
      hooks: {
        beforeCleanupPendingWrite() {
          writeFileSync(join(checkout.checkoutPath, "valuable.txt"), "do not delete\n");
        }
      }
    });
    checkout = create(fixture, "racy-file", { manager: managed });
    const result = managed.finish({ slug: "racy-file", ownerTask: "/root/racy-file", expectedRevision: 1 });
    assert.equal(result.status, "cleanup-review-required");
    assert.equal(readFileSync(join(checkout.checkoutPath, "valuable.txt"), "utf8"), "do not delete\n");
    assert.deepEqual(
      {
        state: manager(fixture).status("racy-file")[0].state,
        review: manager(fixture).status("racy-file")[0].cleanupReviewRequired
      },
      { state: "cleanup-pending", review: true }
    );
    assert(result.audit.issues.includes("tracked-or-user-work-present"));
  });
});

test("retirement planning appends exact clean evidence without touching the checkout", () => {
  withRepository((fixture) => {
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    const checkout = create(fixture, "retirement-ready", { manager: managed });
    managed.finish({ slug: "retirement-ready", ownerTask: "/root/retirement-ready", expectedRevision: 1 });
    const cleanup = entry(fixture, "retirement-ready");
    const entryBytes = registryBytes(fixture);
    const checkoutBytes = readFileSync(join(checkout.checkoutPath, "README.md"));
    const gitFileBytes = readFileSync(join(checkout.checkoutPath, ".git"));
    const backlinkBytes = readFileSync(join(cleanup.checkout.gitAdmin.path, "gitdir"));
    behavior.gitCalls = [];

    const result = managed.planRetirement({
      slug: "retirement-ready",
      ownerTask: "/root/retirement-ready",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    assert.equal(result.status, "retirement-evidence-recorded");
    assert.equal(result.generation, cleanup.generation);
    assert.equal(result.checkoutState, "cleanup-pending");
    assert.equal(result.authorizesCleanup, false);
    assert.deepEqual(
      entryHistory(fixture, "retirement-ready").map((record) => record.state),
      ["creating", "active", "cleanup-pending"]
    );
    assert.deepEqual(registryBytes(fixture), entryBytes);
    const evidencePath = join(managed.paths.retirements, `retirement-ready.${cleanup.generation}.json`);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.deepEqual(evidence.source.cleanupRequest, cleanup.cleanupRequest);
    assert.deepEqual(
      {
        generation: evidence.source.generation,
        ownerTask: evidence.source.ownerTask,
        revision: evidence.source.revision
      },
      { generation: cleanup.generation, ownerTask: cleanup.ownerTask, revision: cleanup.revision }
    );
    assert.deepEqual(evidence.checkout, cleanup.checkout);
    assert.equal(evidence.git.head, git(checkout.checkoutPath, "rev-parse", "HEAD"));
    assert.equal("recovery" in evidence, false);
    assert.equal(evidence.authorizesCleanup, false);
    assert.equal(evidence.deferredChecks.recovery, "not-checked-recheck-required");
    assert.equal(evidence.deferredChecks.processUse, "not-checked-recheck-required");
    assert.equal(evidence.deferredChecks.mounts, "not-checked-recheck-required");
    assert.deepEqual(behavior.networkCommands ?? [], []);
    assert(behavior.gitCalls.length > 0);
    assert(
      behavior.gitCalls.every((call) => call.env?.GIT_NO_LAZY_FETCH === "1"),
      "every Git evidence command must disable partial-clone lazy fetching"
    );
    assert(
      behavior.gitCalls
        .filter((call) => call.args.includes("--work-tree"))
        .every(
          (call) =>
            call.args.includes("core.fsmonitor=false") &&
            call.args.some((argument) => argument.startsWith("core.hooksPath="))
        ),
      "checkout evidence commands must disable filesystem monitors and hooks"
    );
    assert.deepEqual(readFileSync(join(checkout.checkoutPath, "README.md")), checkoutBytes);
    assert.deepEqual(readFileSync(join(checkout.checkoutPath, ".git")), gitFileBytes);
    assert.deepEqual(readFileSync(join(cleanup.checkout.gitAdmin.path, "gitdir")), backlinkBytes);
    assert.equal(git(checkout.checkoutPath, "status", "--porcelain"), "");
  });
});

test("retirement archive preserves every ref in a verified self-contained bundle", () => {
  withRepository((fixture) => {
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    const checkout = create(fixture, "archive-ready", { manager: managed });
    const creationHead = git(checkout.checkoutPath, "rev-parse", "HEAD");
    writeFileSync(join(checkout.checkoutPath, "after-create.txt"), "committed after checkout creation\n");
    git(checkout.checkoutPath, "add", "after-create.txt");
    git(checkout.checkoutPath, "commit", "-q", "-m", "Commit after managed checkout creation");
    managed.finish({ slug: "archive-ready", ownerTask: "/root/archive-ready", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-ready");
    managed.planRetirement({
      slug: "archive-ready",
      ownerTask: "/root/archive-ready",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    const localHead = git(checkout.checkoutPath, "rev-parse", "HEAD");
    assert.notEqual(localHead, creationHead);
    const localBlob = git(checkout.checkoutPath, "hash-object", "README.md");
    git(fixture.repository, "update-ref", "refs/recovery/local-only", localHead);
    git(fixture.repository, "update-ref", "refs/recovery/blob-only", localBlob);
    git(fixture.repository, "tag", "archive-fixture", localHead);
    const beforeEntries = registryBytes(fixture);
    const planPath = join(managed.paths.retirements, `archive-ready.${cleanup.generation}.json`);
    const planBytes = readFileSync(planPath);
    const checkoutBytes = readFileSync(join(checkout.checkoutPath, "README.md"));
    behavior.gitCalls = [];

    const result = managed.archiveRetirement({
      slug: "archive-ready",
      ownerTask: "/root/archive-ready",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    assert.equal(result.status, "recovery-archive-recorded");
    assert.equal(result.attempt, 1);
    assert.equal(result.authorizesCleanup, false);
    assert.deepEqual(registryBytes(fixture), beforeEntries);
    assert.deepEqual(readFileSync(planPath), planBytes);
    assert.deepEqual(readFileSync(join(checkout.checkoutPath, "README.md")), checkoutBytes);
    const attempt = join(managed.paths.archives, `archive-ready.${cleanup.generation}.1`);
    assert.deepEqual(readdirSync(attempt).sort(), [
      "archive.bundle",
      "complete.json",
      "receipt.json",
      "verification-template",
      "verification.git"
    ]);
    const receipt = JSON.parse(readFileSync(join(attempt, "receipt.json"), "utf8"));
    const completion = JSON.parse(readFileSync(join(attempt, "complete.json"), "utf8"));
    assert.equal(receipt.authorizesCleanup, false);
    assert.equal(receipt.deferredChecks.recovery, "bundle-unbundled-and-fsck-verified");
    assert.equal(receipt.deferredChecks.processUse, "not-checked-recheck-required");
    assert.equal(receipt.git.head, localHead);
    assert.equal(receipt.verification.recovery.objectFormat, receipt.git.objectFormat);
    assert.deepEqual(completion.verification.repository, receipt.archive.verification.repository);
    assert.equal(completion.authorizesCleanup, false);
    const heads = git(fixture.repository, "bundle", "list-heads", result.archivePath);
    assert.match(heads, new RegExp(`${localHead} refs/recovery/local-only`, "u"));
    assert.match(heads, new RegExp(`${localBlob} refs/recovery/blob-only`, "u"));
    assert.match(heads, new RegExp(`${localHead} refs/tags/archive-fixture`, "u"));
    git(fixture.repository, "bundle", "verify", "-q", result.archivePath);
    const recovered = join(fixture.root, "recovered.git");
    git(fixture.root, "init", "-q", "--bare", recovered);
    git(fixture.root, `--git-dir=${recovered}`, "bundle", "unbundle", result.archivePath);
    git(fixture.root, `--git-dir=${recovered}`, "fsck", "--full", "--strict");
    assert.equal(git(fixture.root, `--git-dir=${recovered}`, "rev-parse", `${localHead}^{tree}`), receipt.git.headTree);
    assert.ok(BigInt(receipt.storage.availableBytes) >= BigInt(receipt.storage.requiredBytes));
    const bundleCall = behavior.gitCalls.find((call) => call.args.includes("bundle") && call.args.includes("create"));
    assert.ok(bundleCall);
    for (const setting of [
      "pack.threads=1",
      "pack.window=4",
      "pack.depth=10",
      "pack.windowMemory=32m",
      "pack.deltaCacheSize=16m",
      "core.bigFileThreshold=16m"
    ]) {
      assert.ok(bundleCall.args.includes(setting), `bundle creation must set ${setting}`);
    }
    assert.deepEqual(behavior.networkCommands ?? [], []);
    assert.equal(
      behavior.gitCalls.some((call) => {
        if (["fetch", "pull", "push", "ls-remote"].some((command) => call.args.includes(command))) return true;
        if (call.args.includes("update-ref") || call.args.includes("pack-refs")) {
          const gitDirectoryArgument = call.args.indexOf("--git-dir");
          return (
            gitDirectoryArgument === -1 || call.args[gitDirectoryArgument + 1] !== join(attempt, "verification.git")
          );
        }
        return (
          call.args.includes("worktree") && ["add", "move", "remove", "prune"].some((verb) => call.args.includes(verb))
        );
      }),
      false
    );
  });
});

test("retirement archive preserves a unique linked-worktree ORIG_HEAD as a bundle root", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    const checkout = create(fixture, "archive-orig-head", { manager: managed });
    managed.finish({ slug: "archive-orig-head", ownerTask: "/root/archive-orig-head", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-orig-head");
    managed.planRetirement({
      slug: "archive-orig-head",
      ownerTask: "/root/archive-orig-head",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    const tree = git(checkout.checkoutPath, "rev-parse", "HEAD^{tree}");
    const dangling = git(checkout.checkoutPath, "commit-tree", tree, "-m", "ORIG_HEAD-only recovery commit");
    git(checkout.checkoutPath, "update-ref", "ORIG_HEAD", dangling);

    const result = managed.archiveRetirement({
      slug: "archive-orig-head",
      ownerTask: "/root/archive-orig-head",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    const pseudoref = `worktrees/${basename(cleanup.checkout.gitAdmin.path)}/ORIG_HEAD`;
    const heads = git(fixture.repository, "bundle", "list-heads", result.archivePath);
    assert.match(heads, new RegExp(`${dangling} ${pseudoref}`, "u"));
    const receipt = JSON.parse(readFileSync(join(dirname(result.archivePath), "receipt.json"), "utf8"));
    assert.ok(receipt.git.pseudorefs.count >= 1);
    assert.equal(
      git(fixture.root, `--git-dir=${receipt.archive.verification.repository.path}`, "cat-file", "-t", dangling),
      "commit"
    );
  });
});

test("retirement archive rejects a commit reachable only from the target HEAD reflog", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    const checkout = create(fixture, "archive-reflog-only", { manager: managed });
    managed.finish({ slug: "archive-reflog-only", ownerTask: "/root/archive-reflog-only", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-reflog-only");
    managed.planRetirement({
      slug: "archive-reflog-only",
      ownerTask: "/root/archive-reflog-only",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    const current = git(checkout.checkoutPath, "rev-parse", "HEAD");
    const tree = git(checkout.checkoutPath, "rev-parse", "HEAD^{tree}");
    const dangling = git(checkout.checkoutPath, "commit-tree", tree, "-m", "HEAD-reflog-only recovery commit");
    const reflogPath = join(cleanup.checkout.gitAdmin.path, "logs", "HEAD");
    writeFileSync(
      reflogPath,
      `${readFileSync(reflogPath, "utf8")}${current} ${dangling} Checkout Test <checkout@example.invalid> 0 +0000\torphan\n`
    );

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-reflog-only",
          ownerTask: "/root/archive-reflog-only",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive rejects target-worktree operation metadata", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    const checkout = create(fixture, "archive-operation-state", { manager: managed });
    managed.finish({
      slug: "archive-operation-state",
      ownerTask: "/root/archive-operation-state",
      expectedRevision: 1
    });
    const cleanup = entry(fixture, "archive-operation-state");
    managed.planRetirement({
      slug: "archive-operation-state",
      ownerTask: "/root/archive-operation-state",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    writeFileSync(
      join(cleanup.checkout.gitAdmin.path, "MERGE_HEAD"),
      `${git(checkout.checkoutPath, "rev-parse", "HEAD")}\n`
    );

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-operation-state",
          ownerTask: "/root/archive-operation-state",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive packs more than 4096 recovery roots before retaining verification state", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    create(fixture, "archive-many-roots", { manager: managed });
    managed.finish({ slug: "archive-many-roots", ownerTask: "/root/archive-many-roots", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-many-roots");
    managed.planRetirement({
      slug: "archive-many-roots",
      ownerTask: "/root/archive-many-roots",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    let input = "";
    for (let index = 0; index < 4100; index += 1) {
      const ref = `refs/recovery/many/${String(index).padStart(4, "0")}`;
      const message = `root-${index}`;
      input += `commit ${ref}\nauthor Checkout Test <checkout@example.invalid> 0 +0000\ncommitter Checkout Test <checkout@example.invalid> 0 +0000\ndata ${Buffer.byteLength(message, "utf8")}\n${message}\n`;
    }
    input += "done\n";
    const imported = spawnSync("git", ["fast-import", "--quiet"], {
      cwd: fixture.repository,
      encoding: "utf8",
      input,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(imported.status, 0, imported.stderr);

    const result = managed.archiveRetirement({
      slug: "archive-many-roots",
      ownerTask: "/root/archive-many-roots",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    const receipt = JSON.parse(readFileSync(join(dirname(result.archivePath), "receipt.json"), "utf8"));
    assert.ok(receipt.verification.recovery.rootRefs.count > 4096);
    assert.ok(receipt.archive.verification.repository.fileCount < 4096);
    assert.equal(
      existsSync(join(receipt.archive.verification.repository.path, "packed-refs")),
      true,
      "verification roots must be packed before the bounded retained-state manifest is captured"
    );
  });
});

test("retirement archive keeps an interrupted attempt and retries in a new directory", () => {
  withRepository((fixture) => {
    const interrupted = manager(fixture, {
      run: fixtureRun(),
      hooks: { beforeArchiveReceiptWrite: () => assert.fail("simulated shutdown") }
    });
    create(fixture, "archive-retry", { manager: interrupted });
    interrupted.finish({ slug: "archive-retry", ownerTask: "/root/archive-retry", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-retry");
    interrupted.planRetirement({
      slug: "archive-retry",
      ownerTask: "/root/archive-retry",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    assert.throws(
      () =>
        interrupted.archiveRetirement({
          slug: "archive-retry",
          ownerTask: "/root/archive-retry",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      /simulated shutdown/u
    );
    const firstAttempt = join(interrupted.paths.archives, `archive-retry.${cleanup.generation}.1`);
    const retainedBundle = readFileSync(join(firstAttempt, "archive.bundle"));
    assert.deepEqual(readdirSync(firstAttempt).sort(), ["archive.bundle", "verification-template", "verification.git"]);

    const result = manager(fixture, { run: fixtureRun() }).archiveRetirement({
      slug: "archive-retry",
      ownerTask: "/root/archive-retry",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    assert.equal(result.attempt, 2);
    assert.deepEqual(readFileSync(join(firstAttempt, "archive.bundle")), retainedBundle);
    assert.deepEqual(readdirSync(firstAttempt).sort(), ["archive.bundle", "verification-template", "verification.git"]);
    assert.deepEqual(readdirSync(join(interrupted.paths.archives, `archive-retry.${cleanup.generation}.2`)).sort(), [
      "archive.bundle",
      "complete.json",
      "receipt.json",
      "verification-template",
      "verification.git"
    ]);
  });
});

test("retirement archive refuses ref changes before completion and retains its receipt", () => {
  withRepository((fixture) => {
    let changed = false;
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveCompletionWrite() {
          changed = true;
          git(fixture.repository, "update-ref", "refs/recovery/late", "HEAD");
        }
      }
    });
    create(fixture, "archive-ref-race", { manager: managed });
    managed.finish({ slug: "archive-ref-race", ownerTask: "/root/archive-ref-race", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-ref-race");
    managed.planRetirement({
      slug: "archive-ref-race",
      ownerTask: "/root/archive-ref-race",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-ref-race",
          ownerTask: "/root/archive-ref-race",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "checkout-changed"
    );

    assert.equal(changed, true);
    const attempt = join(managed.paths.archives, `archive-ref-race.${cleanup.generation}.1`);
    assert.deepEqual(readdirSync(attempt).sort(), [
      "archive.bundle",
      "receipt.json",
      "verification-template",
      "verification.git"
    ]);
    assert.equal(JSON.parse(readFileSync(join(attempt, "receipt.json"), "utf8")).authorizesCleanup, false);
  });
});

test("retirement archive rejects a changed bundle and never publishes completion", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveHeaderParse(_entry, _attempt, bundle) {
          writeFileSync(bundle.path, "not a bundle\n");
        }
      }
    });
    create(fixture, "archive-corrupt", { manager: managed });
    managed.finish({ slug: "archive-corrupt", ownerTask: "/root/archive-corrupt", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-corrupt");
    managed.planRetirement({
      slug: "archive-corrupt",
      ownerTask: "/root/archive-corrupt",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-corrupt",
          ownerTask: "/root/archive-corrupt",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "invalid-archive"
    );

    const attempt = join(managed.paths.archives, `archive-corrupt.${cleanup.generation}.1`);
    assert.equal(readFileSync(join(attempt, "archive.bundle"), "utf8"), "not a bundle\n");
    assert.deepEqual(readdirSync(attempt), ["archive.bundle"]);
  });
});

test("retirement archive rejects a truncated pack even when bundle verify accepts its header", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveRecoveryProof(_entry, _attempt, bundle) {
          const bytes = readFileSync(bundle.path);
          const headerEnd = bytes.indexOf("\n\nPACK");
          assert.ok(headerEnd > 0);
          assert.ok(bytes.length > headerEnd + 200);
          writeFileSync(bundle.path, bytes.subarray(0, bytes.length - 100));
          git(fixture.repository, "bundle", "verify", "-q", bundle.path);
        }
      }
    });
    create(fixture, "archive-pack-corrupt", { manager: managed });
    managed.finish({ slug: "archive-pack-corrupt", ownerTask: "/root/archive-pack-corrupt", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-pack-corrupt");
    managed.planRetirement({
      slug: "archive-pack-corrupt",
      ownerTask: "/root/archive-pack-corrupt",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-pack-corrupt",
          ownerTask: "/root/archive-pack-corrupt",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-command-failed"
    );

    const attempt = join(managed.paths.archives, `archive-pack-corrupt.${cleanup.generation}.1`);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
    assert.equal(existsSync(join(attempt, "receipt.json")), false);
    assert.deepEqual(readdirSync(attempt).sort(), ["archive.bundle", "verification-template", "verification.git"]);
  });
});

test("retirement archive rejects a prerequisite-free pack with a missing internal parent", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveRecoveryProof(_entry, _attempt, bundle) {
          const bytes = readFileSync(bundle.path);
          const headerEnd = bytes.indexOf("\n\nPACK");
          assert.ok(headerEnd > 0);
          const header = bytes.subarray(0, headerEnd + 2);
          const advertisedObjectIds = header
            .toString("utf8")
            .split("\n")
            .filter((line) => /^[0-9a-f]+ /u.test(line))
            .map((line) => line.slice(0, line.indexOf(" ")));
          const packedObjectIds = new Set(advertisedObjectIds);
          for (const oid of advertisedObjectIds) {
            assert.equal(git(fixture.repository, "cat-file", "-t", oid), "commit");
            const tree = git(fixture.repository, "show", "-s", "--format=%T", oid);
            packedObjectIds.add(tree);
            for (const nested of git(fixture.repository, "ls-tree", "-r", "-t", "--format=%(objectname)", tree)
              .split("\n")
              .filter(Boolean)) {
              packedObjectIds.add(nested);
            }
          }
          const pack = spawnSync("git", ["pack-objects", "--stdout"], {
            cwd: fixture.repository,
            input: `${[...packedObjectIds].join("\n")}\n`,
            maxBuffer: 4 * 1024 * 1024
          });
          assert.equal(pack.status, 0, pack.stderr.toString("utf8"));
          writeFileSync(bundle.path, Buffer.concat([header, pack.stdout]));
          git(fixture.repository, "bundle", "verify", "-q", bundle.path);
        }
      }
    });
    const checkout = create(fixture, "archive-missing-parent", { manager: managed });
    for (const index of [1, 2]) {
      writeFileSync(join(checkout.checkoutPath, `commit-${index}.txt`), `commit ${index}\n`);
      git(checkout.checkoutPath, "add", `commit-${index}.txt`);
      git(checkout.checkoutPath, "commit", "-q", "-m", `Commit ${index}`);
    }
    managed.finish({
      slug: "archive-missing-parent",
      ownerTask: "/root/archive-missing-parent",
      expectedRevision: 1
    });
    const cleanup = entry(fixture, "archive-missing-parent");
    managed.planRetirement({
      slug: "archive-missing-parent",
      ownerTask: "/root/archive-missing-parent",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-missing-parent",
          ownerTask: "/root/archive-missing-parent",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-command-failed"
    );

    const attempt = join(managed.paths.archives, `archive-missing-parent.${cleanup.generation}.1`);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
    assert.equal(existsSync(join(attempt, "receipt.json")), false);
    assert.deepEqual(readdirSync(attempt).sort(), ["archive.bundle", "verification-template", "verification.git"]);
  });
});

test("retirement archive rejects a valid bundle with prerequisites", () => {
  withRepository((fixture) => {
    writeFileSync(join(fixture.repository, "second.txt"), "second commit\n");
    git(fixture.repository, "add", "second.txt");
    git(fixture.repository, "commit", "-q", "-m", "Add second commit");
    const replacement = join(fixture.root, "incremental.bundle");
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveHeaderParse(_entry, _attempt, bundle) {
          git(fixture.repository, "bundle", "create", replacement, "HEAD^..HEAD");
          writeFileSync(bundle.path, readFileSync(replacement));
        }
      }
    });
    create(fixture, "archive-prerequisite", { manager: managed });
    managed.finish({ slug: "archive-prerequisite", ownerTask: "/root/archive-prerequisite", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-prerequisite");
    managed.planRetirement({
      slug: "archive-prerequisite",
      ownerTask: "/root/archive-prerequisite",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-prerequisite",
          ownerTask: "/root/archive-prerequisite",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-self-contained"
    );
    const attempt = join(managed.paths.archives, `archive-prerequisite.${cleanup.generation}.1`);
    assert.deepEqual(readFileSync(join(attempt, "archive.bundle")), readFileSync(replacement));
    assert.deepEqual(readdirSync(attempt), ["archive.bundle"]);
  });
});

test("retirement archive rejects a shallow repository before creating an attempt", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    create(fixture, "archive-shallow", { manager: managed });
    managed.finish({ slug: "archive-shallow", ownerTask: "/root/archive-shallow", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-shallow");
    managed.planRetirement({
      slug: "archive-shallow",
      ownerTask: "/root/archive-shallow",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    writeFileSync(join(fixture.repository, ".git", "shallow"), `${git(fixture.repository, "rev-parse", "HEAD")}\n`);

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-shallow",
          ownerTask: "/root/archive-shallow",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive rejects grafts before creating an attempt", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    create(fixture, "archive-grafts", { manager: managed });
    managed.finish({ slug: "archive-grafts", ownerTask: "/root/archive-grafts", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-grafts");
    managed.planRetirement({
      slug: "archive-grafts",
      ownerTask: "/root/archive-grafts",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    writeFileSync(
      join(fixture.repository, ".git", "info", "grafts"),
      `${git(fixture.repository, "rev-parse", "HEAD")}\n`
    );

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-grafts",
          ownerTask: "/root/archive-grafts",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive rejects a dangling target-worktree private ref", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    const checkout = create(fixture, "archive-private-ref", { manager: managed });
    managed.finish({ slug: "archive-private-ref", ownerTask: "/root/archive-private-ref", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-private-ref");
    managed.planRetirement({
      slug: "archive-private-ref",
      ownerTask: "/root/archive-private-ref",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    const tree = git(checkout.checkoutPath, "rev-parse", "HEAD^{tree}");
    const dangling = git(checkout.checkoutPath, "commit-tree", tree, "-m", "Private worktree recovery commit");
    git(checkout.checkoutPath, "update-ref", "refs/worktree/recovery", dangling);
    assert.match(git(checkout.checkoutPath, "for-each-ref", "--format=%(refname)", "refs/worktree/"), /recovery/u);

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-private-ref",
          ownerTask: "/root/archive-private-ref",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive inspects private refs in every other registered worktree", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    const checkout = create(fixture, "archive-other-private-ref", { manager: managed });
    managed.finish({
      slug: "archive-other-private-ref",
      ownerTask: "/root/archive-other-private-ref",
      expectedRevision: 1
    });
    const cleanup = entry(fixture, "archive-other-private-ref");
    managed.planRetirement({
      slug: "archive-other-private-ref",
      ownerTask: "/root/archive-other-private-ref",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });
    const tree = git(checkout.checkoutPath, "rev-parse", "HEAD^{tree}");
    const dangling = git(checkout.checkoutPath, "commit-tree", tree, "-m", "Other worktree recovery commit");
    git(fixture.repository, "update-ref", "refs/bisect/recovery", dangling);
    assert.match(git(fixture.repository, "for-each-ref", "--format=%(refname)", "refs/bisect/"), /recovery/u);

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-other-private-ref",
          ownerTask: "/root/archive-other-private-ref",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-not-eligible"
    );
    assert.equal(existsSync(managed.paths.archives), false);
  });
});

test("retirement archive rejects partial-clone configuration and promisor pack markers", () => {
  for (const kind of ["config", "pack"]) {
    withRepository((fixture) => {
      const managed = manager(fixture, { run: fixtureRun() });
      create(fixture, `archive-promisor-${kind}`, { manager: managed });
      if (kind === "config") git(fixture.repository, "config", "extensions.partialClone", "origin");
      managed.finish({
        slug: `archive-promisor-${kind}`,
        ownerTask: `/root/archive-promisor-${kind}`,
        expectedRevision: 1
      });
      const cleanup = entry(fixture, `archive-promisor-${kind}`);
      managed.planRetirement({
        slug: `archive-promisor-${kind}`,
        ownerTask: `/root/archive-promisor-${kind}`,
        expectedRevision: 1,
        expectedGeneration: cleanup.generation
      });
      if (kind === "pack") {
        const packDirectory = join(fixture.repository, ".git", "objects", "pack");
        mkdirSync(packDirectory, { recursive: true });
        writeFileSync(join(packDirectory, "synthetic.promisor"), "");
      }

      lifecycleError(
        () =>
          managed.archiveRetirement({
            slug: `archive-promisor-${kind}`,
            ownerTask: `/root/archive-promisor-${kind}`,
            expectedRevision: 1,
            expectedGeneration: cleanup.generation
          }),
        "archive-not-eligible"
      );
      assert.equal(existsSync(managed.paths.archives), false);
    });
  }
});

test("retirement archive never overwrites a planted receipt", () => {
  withRepository((fixture) => {
    let plantedPath;
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeArchiveReceiptWrite(_entry, attempt) {
          plantedPath = join(attempt.path, "receipt.json");
          writeFileSync(plantedPath, "valuable planted receipt\n", { flag: "wx", mode: 0o600 });
        }
      }
    });
    create(fixture, "archive-collision", { manager: managed });
    managed.finish({ slug: "archive-collision", ownerTask: "/root/archive-collision", expectedRevision: 1 });
    const cleanup = entry(fixture, "archive-collision");
    managed.planRetirement({
      slug: "archive-collision",
      ownerTask: "/root/archive-collision",
      expectedRevision: 1,
      expectedGeneration: cleanup.generation
    });

    lifecycleError(
      () =>
        managed.archiveRetirement({
          slug: "archive-collision",
          ownerTask: "/root/archive-collision",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "archive-changed"
    );
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable planted receipt\n");
  });
});

test("retirement planning cannot use inherited Git routing to hide dirty work", () => {
  withRepository((fixture) => {
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    const checkout = create(fixture, "git-env-routing", { manager: managed });
    managed.finish({ slug: "git-env-routing", ownerTask: "/root/git-env-routing", expectedRevision: 1 });
    writeFileSync(join(checkout.checkoutPath, "README.md"), "valuable dirty work\n");
    const injected = {
      GIT_DIR: join(fixture.repository, ".git"),
      GIT_INDEX_FILE: join(fixture.repository, ".git", "index"),
      GIT_WORK_TREE: fixture.repository,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "false"
    };
    const previous = Object.fromEntries(Object.keys(injected).map((name) => [name, process.env[name]]));
    Object.assign(process.env, injected);
    behavior.gitCalls = [];
    try {
      lifecycleError(
        () =>
          managed.planRetirement({
            slug: "git-env-routing",
            ownerTask: "/root/git-env-routing",
            expectedRevision: 1,
            expectedGeneration: entry(fixture, "git-env-routing").generation
          }),
        "retirement-not-eligible"
      );
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert(behavior.gitCalls.length > 0);
    assert(
      behavior.gitCalls.every((call) =>
        Object.keys(call.env ?? {}).every(
          (name) => !name.toUpperCase().startsWith("GIT_") || !Object.hasOwn(injected, name)
        )
      )
    );
    assert.equal(readFileSync(join(checkout.checkoutPath, "README.md"), "utf8"), "valuable dirty work\n");
  });
});

test("retirement planning ignores replacement refs that hide staged work", () => {
  withRepository((fixture) => {
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    const checkout = create(fixture, "replace-object", { manager: managed });
    managed.finish({ slug: "replace-object", ownerTask: "/root/replace-object", expectedRevision: 1 });
    const originalHead = git(checkout.checkoutPath, "rev-parse", "HEAD");
    writeFileSync(join(checkout.checkoutPath, "README.md"), "staged work hidden by a replacement ref\n");
    git(checkout.checkoutPath, "add", "README.md");
    const stagedTree = git(checkout.checkoutPath, "write-tree");
    const replacementCommit = git(
      checkout.checkoutPath,
      "commit-tree",
      stagedTree,
      "-p",
      originalHead,
      "-m",
      "Replacement fixture"
    );
    git(checkout.checkoutPath, "replace", originalHead, replacementCommit);
    assert.equal(git(checkout.checkoutPath, "status", "--porcelain"), "");
    behavior.gitCalls = [];

    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "replace-object",
          ownerTask: "/root/replace-object",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "replace-object").generation
        }),
      "retirement-not-eligible"
    );

    assert(behavior.gitCalls.length > 0);
    assert(behavior.gitCalls.every((call) => call.env?.GIT_NO_REPLACE_OBJECTS === "1"));
    assert.equal(
      readFileSync(join(checkout.checkoutPath, "README.md"), "utf8"),
      "staged work hidden by a replacement ref\n"
    );
  });
});

test("retirement planning disables a configured filesystem-monitor hook", () => {
  withRepository((fixture) => {
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    create(fixture, "fsmonitor-hook", { manager: managed });
    managed.finish({ slug: "fsmonitor-hook", ownerTask: "/root/fsmonitor-hook", expectedRevision: 1 });
    const marker = join(fixture.root, "fsmonitor-ran");
    const hook = join(fixture.root, process.platform === "win32" ? "fsmonitor.cmd" : "fsmonitor.sh");
    const hookBody =
      process.platform === "win32"
        ? `@echo off\r\necho invoked>"${marker}"\r\nexit /b 1\r\n`
        : `#!/bin/sh\nprintf invoked > '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`;
    writeFileSync(hook, hookBody, { mode: 0o700 });
    chmodSync(hook, 0o700);
    git(fixture.repository, "config", "core.fsmonitor", hook);
    behavior.gitCalls = [];

    const result = managed.planRetirement({
      slug: "fsmonitor-hook",
      ownerTask: "/root/fsmonitor-hook",
      expectedRevision: 1,
      expectedGeneration: entry(fixture, "fsmonitor-hook").generation
    });

    assert.equal(result.status, "retirement-evidence-recorded");
    assert.equal(existsSync(marker), false);
    assert(
      behavior.gitCalls
        .filter((call) => call.args.includes("--work-tree"))
        .every((call) => call.args.includes("core.fsmonitor=false"))
    );
  });
});

test("retirement planning rejects external content filters before they can run", () => {
  withRepository((fixture) => {
    writeFileSync(join(fixture.repository, ".gitattributes"), "README.md filter=marker\n");
    git(fixture.repository, "add", ".gitattributes");
    git(fixture.repository, "commit", "-q", "-m", "Add filter fixture");
    const behavior = {};
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    create(fixture, "content-filter", { manager: managed });
    managed.finish({ slug: "content-filter", ownerTask: "/root/content-filter", expectedRevision: 1 });
    const marker = join(fixture.root, "content-filter-ran");
    const filter = join(fixture.root, process.platform === "win32" ? "content-filter.cmd" : "content-filter.sh");
    const filterBody =
      process.platform === "win32"
        ? `@echo off\r\necho invoked>"${marker}"\r\nmore\r\n`
        : `#!/bin/sh\nprintf invoked > '${marker.replaceAll("'", "'\\''")}'\ncat\n`;
    writeFileSync(filter, filterBody, { mode: 0o700 });
    chmodSync(filter, 0o700);
    git(fixture.repository, "config", "filter.marker.clean", filter);
    git(fixture.repository, "config", "filter.marker.required", "true");
    behavior.gitCalls = [];

    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "content-filter",
          ownerTask: "/root/content-filter",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "content-filter").generation
        }),
      "retirement-not-eligible"
    );

    assert.equal(existsSync(marker), false);
    assert(
      behavior.gitCalls.some(
        (call) => call.args.includes("config") && call.args.includes("--name-only") && call.args.includes("--list")
      )
    );
    assert.equal(
      behavior.gitCalls.some((call) => call.args.includes("status") || call.args.includes("diff-files")),
      false
    );
  });
});

test("retirement planning rejects a clean checkout containing a tracked gitlink", () => {
  withRepository((fixture) => {
    const head = git(fixture.repository, "rev-parse", "HEAD");
    git(fixture.repository, "update-index", "--add", "--cacheinfo", `160000,${head},nested`);
    git(fixture.repository, "commit", "-q", "-m", "Add gitlink fixture");
    const managed = manager(fixture, { run: fixtureRun() });
    create(fixture, "gitlink-checkout", { manager: managed });
    managed.finish({ slug: "gitlink-checkout", ownerTask: "/root/gitlink-checkout", expectedRevision: 1 });
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "gitlink-checkout",
          ownerTask: "/root/gitlink-checkout",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "gitlink-checkout").generation
        }),
      "retirement-not-eligible"
    );
  });
});

test("worktree registry paths accept Git for Windows separators without accepting dot segments", () => {
  assert.equal(normalizeWorktreeRegistryPath("C:/repo/checkout", "win32"), "C:\\repo\\checkout");
  assert.equal(
    normalizeWorktreeRegistryPath("//server/share/repo/checkout", "win32"),
    "\\\\server\\share\\repo\\checkout"
  );
  assert.equal(normalizeWorktreeRegistryPath("/repo/checkout", "linux"), "/repo/checkout");
  lifecycleError(() => normalizeWorktreeRegistryPath("C:/repo/../checkout", "win32"), "invalid-worktree-registry");
  lifecycleError(() => normalizeWorktreeRegistryPath("/repo/../checkout", "linux"), "invalid-worktree-registry");
});

test("retirement planning rejects stale ownership, state, and generation", () => {
  withRepository((fixture) => {
    const managed = manager(fixture);
    const checkout = create(fixture, "retirement-guards", { manager: managed });
    const activeGeneration = entry(fixture, "retirement-guards").generation;
    const beforeActive = entryHistory(fixture, "retirement-guards").length;
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "retirement-guards",
          ownerTask: "/root/retirement-guards",
          expectedRevision: 1,
          expectedGeneration: activeGeneration
        }),
      "checkout-not-cleanup-pending"
    );
    assert.equal(entryHistory(fixture, "retirement-guards").length, beforeActive);

    managed.finish({ slug: "retirement-guards", ownerTask: "/root/retirement-guards", expectedRevision: 1 });
    const cleanupGeneration = entry(fixture, "retirement-guards").generation;
    for (const [ownerTask, revision, generation, code] of [
      ["/root/other", 1, cleanupGeneration, "ownership-changed"],
      ["/root/retirement-guards", 2, cleanupGeneration, "ownership-changed"],
      ["/root/retirement-guards", 1, cleanupGeneration - 1, "registry-changed"]
    ]) {
      lifecycleError(
        () =>
          managed.planRetirement({
            slug: "retirement-guards",
            ownerTask,
            expectedRevision: revision,
            expectedGeneration: generation
          }),
        code
      );
    }
    assert.equal(entry(fixture, "retirement-guards").state, "cleanup-pending");
    assert.equal(existsSync(checkout.checkoutPath), true);
  });
});

for (const [name, prepare] of [
  ["untracked work", (path) => writeFileSync(join(path, "valuable.txt"), "valuable\n")],
  [
    "staged work",
    (path) => {
      writeFileSync(join(path, "README.md"), "staged valuable change\n");
      git(path, "add", "README.md");
    }
  ],
  [
    "assume-unchanged work",
    (path) => {
      git(path, "update-index", "--assume-unchanged", "README.md");
      writeFileSync(join(path, "README.md"), "hidden valuable change\n");
    }
  ],
  [
    "skip-worktree work",
    (path) => {
      git(path, "update-index", "--skip-worktree", "README.md");
      writeFileSync(join(path, "README.md"), "hidden valuable change\n");
    }
  ]
]) {
  test(`retirement planning rejects ${name}`, () => {
    withRepository((fixture) => {
      const slug = `plan-${name.replaceAll(" ", "-")}`;
      const managed = manager(fixture, { run: fixtureRun() });
      const checkout = create(fixture, slug, { manager: managed });
      managed.finish({ slug, ownerTask: `/root/${slug}`, expectedRevision: 1 });
      const cleanupGeneration = entry(fixture, slug).generation;
      prepare(checkout.checkoutPath);
      lifecycleError(
        () =>
          managed.planRetirement({
            slug,
            ownerTask: `/root/${slug}`,
            expectedRevision: 1,
            expectedGeneration: cleanupGeneration
          }),
        "retirement-not-eligible"
      );
      assert.equal(entry(fixture, slug).state, "cleanup-pending");
      assert.equal(existsSync(checkout.checkoutPath), true);
    });
  });
}

test("retirement planning rejects a checkout rebound between its two evidence reads", () => {
  withRepository((fixture) => {
    let checkout;
    const retained = join(fixture.root, "retained-retirement-checkout");
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeRetirementEvidenceWrite() {
          renameSync(checkout.checkoutPath, retained);
          mkdirSync(checkout.checkoutPath);
          writeFileSync(join(checkout.checkoutPath, "replacement.txt"), "replacement\n");
        }
      }
    });
    checkout = create(fixture, "plan-rebind", { manager: managed });
    managed.finish({ slug: "plan-rebind", ownerTask: "/root/plan-rebind", expectedRevision: 1 });
    const cleanupGeneration = entry(fixture, "plan-rebind").generation;
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "plan-rebind",
          ownerTask: "/root/plan-rebind",
          expectedRevision: 1,
          expectedGeneration: cleanupGeneration
        }),
      "registry-changed"
    );
    assert.equal(readFileSync(join(retained, "README.md"), "utf8"), "fixture\n");
    assert.equal(readFileSync(join(checkout.checkoutPath, "replacement.txt"), "utf8"), "replacement\n");
    assert.equal(entry(fixture, "plan-rebind").state, "cleanup-pending");
  });
});

test("retirement planning rejects nested and malformed worktree registry records", () => {
  withRepository((fixture) => {
    let checkout;
    let injectNested = false;
    const behavior = {
      worktreeTransform(output) {
        if (!injectNested) return output;
        const head = git(checkout.checkoutPath, "rev-parse", "HEAD");
        return `${output}worktree ${join(checkout.checkoutPath, "nested")}\0HEAD ${head}\0branch refs/heads/nested\0\0`;
      }
    };
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    checkout = create(fixture, "nested-registry", { manager: managed });
    managed.finish({ slug: "nested-registry", ownerTask: "/root/nested-registry", expectedRevision: 1 });
    injectNested = true;
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "nested-registry",
          ownerTask: "/root/nested-registry",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "nested-registry").generation
        }),
      "retirement-not-eligible"
    );
  });
  withRepository((fixture) => {
    let corrupt = false;
    const behavior = { worktreeTransform: (output) => (corrupt ? output.slice(0, -1) : output) };
    const managed = manager(fixture, { run: fixtureRun(behavior) });
    create(fixture, "malformed-registry", { manager: managed });
    managed.finish({ slug: "malformed-registry", ownerTask: "/root/malformed-registry", expectedRevision: 1 });
    corrupt = true;
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "malformed-registry",
          ownerTask: "/root/malformed-registry",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "malformed-registry").generation
        }),
      "invalid-worktree-registry"
    );
  });
});

test("retirement planning rejects source receipt changes", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeRetirementEvidenceWrite(record) {
          const sourcePath = entryPaths(fixture, record.slug).at(-1);
          writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")} `);
        }
      }
    });
    create(fixture, "source-change", { manager: managed });
    managed.finish({ slug: "source-change", ownerTask: "/root/source-change", expectedRevision: 1 });
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "source-change",
          ownerTask: "/root/source-change",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "source-change").generation
        }),
      "checkout-changed"
    );
    assert.equal(readdirSync(join(fixture.managerRoot, "retirements")).length, 0);
  });
});

test("retirement planning rejects a rebound journal before evidence publication", () => {
  withRepository((fixture) => {
    const retained = join(fixture.root, "retained-retirement-journal");
    let rebound = false;
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeRetirementEvidencePublish() {
          renameSync(join(fixture.managerRoot, "retirements"), retained);
          mkdirSync(join(fixture.managerRoot, "retirements"), { mode: 0o700 });
          rebound = true;
        }
      }
    });
    create(fixture, "journal-rebind", { manager: managed });
    managed.finish({ slug: "journal-rebind", ownerTask: "/root/journal-rebind", expectedRevision: 1 });
    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "journal-rebind",
          ownerTask: "/root/journal-rebind",
          expectedRevision: 1,
          expectedGeneration: entry(fixture, "journal-rebind").generation
        }),
      "registry-changed"
    );
    assert.equal(rebound, true);
    assert.deepEqual(readdirSync(retained), []);
    assert.deepEqual(readdirSync(join(fixture.managerRoot, "retirements")), []);
  });
});

test("retirement planning rejects a rebound Git common-directory link", () => {
  withRepository((fixture) => {
    let commondirPath;
    let retainedCommondir;
    const otherRepository = join(fixture.root, "other-repository");
    mkdirSync(otherRepository, { mode: 0o700 });
    git(otherRepository, "init", "-q", "-b", "main");
    const managed = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        beforeRetirementEvidenceWrite() {
          renameSync(commondirPath, retainedCommondir);
          writeFileSync(commondirPath, `${join(otherRepository, ".git")}\n`);
        }
      }
    });
    create(fixture, "commondir-rebind", { manager: managed });
    managed.finish({ slug: "commondir-rebind", ownerTask: "/root/commondir-rebind", expectedRevision: 1 });
    const cleanup = entry(fixture, "commondir-rebind");
    commondirPath = join(cleanup.checkout.gitAdmin.path, "commondir");
    retainedCommondir = join(cleanup.checkout.gitAdmin.path, "commondir.retained");
    const originalBytes = readFileSync(commondirPath);

    lifecycleError(
      () =>
        managed.planRetirement({
          slug: "commondir-rebind",
          ownerTask: "/root/commondir-rebind",
          expectedRevision: 1,
          expectedGeneration: cleanup.generation
        }),
      "retirement-not-eligible"
    );

    assert.deepEqual(readFileSync(retainedCommondir), originalBytes);
    assert.equal(readFileSync(commondirPath, "utf8"), `${join(otherRepository, ".git")}\n`);
    assert.deepEqual(readdirSync(join(fixture.managerRoot, "retirements")), []);
  });
});

test("retirement evidence leaves the v2 entry history readable and unchanged", () => {
  withRepository((fixture) => {
    const managed = manager(fixture, { run: fixtureRun() });
    create(fixture, "v2-compatible", { manager: managed });
    managed.finish({ slug: "v2-compatible", ownerTask: "/root/v2-compatible", expectedRevision: 1 });
    const before = registryBytes(fixture);
    const generation = entry(fixture, "v2-compatible").generation;
    managed.planRetirement({
      slug: "v2-compatible",
      ownerTask: "/root/v2-compatible",
      expectedRevision: 1,
      expectedGeneration: generation
    });
    assert.deepEqual(registryBytes(fixture), before);
    assert.equal(manager(fixture).status("v2-compatible")[0].state, "cleanup-pending");
    assert.equal(
      entryHistory(fixture, "v2-compatible").every((record) => record.protocol.endsWith("-v2")),
      true
    );
  });
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`audit catches ${flag} and finish retains the hidden edit`, () => {
    withRepository((fixture) => {
      const slug = flag.slice(2).replaceAll("-", "");
      const checkout = create(fixture, slug);
      git(checkout.checkoutPath, "update-index", flag, "README.md");
      writeFileSync(join(checkout.checkoutPath, "README.md"), `${flag} valuable edit\n`);
      const audit = manager(fixture).audit(slug);
      assert.equal(audit.unsafeIndexFlags, 1);
      assert.equal(audit.trackedWorktreeClean, false);
      assert(audit.issues.includes("assume-unchanged-or-skip-worktree"));
      manager(fixture).finish({ slug, ownerTask: `/root/${slug}`, expectedRevision: 1 });
      assert.equal(readFileSync(join(checkout.checkoutPath, "README.md"), "utf8"), `${flag} valuable edit\n`);
    });
  });
}

test("finish retains every byte when a generated child or the checkout root is rebound", () => {
  withRepository((fixture) => {
    let checkout;
    const retained = join(fixture.root, "retained-child");
    const managed = manager(fixture, {
      hooks: {
        beforeCleanupPendingWrite() {
          const child = join(checkout.checkoutPath, "node_modules", "pkg");
          renameSync(child, retained);
          mkdirSync(child);
          for (let index = 0; index < 100; index += 1)
            writeFileSync(join(child, `${index}.txt`), `replacement ${index}\n`);
        }
      }
    });
    checkout = create(fixture, "child-rebind", { manager: managed, generatedRoots: ["node_modules"] });
    mkdirSync(join(checkout.checkoutPath, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(checkout.checkoutPath, "node_modules", "pkg", "original.txt"), "original\n");
    managed.finish({ slug: "child-rebind", ownerTask: "/root/child-rebind", expectedRevision: 1 });
    assert.equal(readFileSync(join(retained, "original.txt"), "utf8"), "original\n");
    assert.equal(
      readFileSync(join(checkout.checkoutPath, "node_modules", "pkg", "99.txt"), "utf8"),
      "replacement 99\n"
    );
  });

  withRepository((fixture) => {
    let checkout;
    const retained = join(fixture.root, "retained-root");
    const managed = manager(fixture, {
      hooks: {
        beforeCleanupPendingWrite() {
          renameSync(checkout.checkoutPath, retained);
          mkdirSync(checkout.checkoutPath);
          writeFileSync(join(checkout.checkoutPath, "replacement.txt"), "replacement\n");
        }
      }
    });
    checkout = create(fixture, "root-rebind", { manager: managed });
    managed.finish({ slug: "root-rebind", ownerTask: "/root/root-rebind", expectedRevision: 1 });
    assert.equal(readFileSync(join(retained, "README.md"), "utf8"), "fixture\n");
    assert.equal(readFileSync(join(checkout.checkoutPath, "replacement.txt"), "utf8"), "replacement\n");
  });
});

test("a partial Git admin directory is reported and retained byte-for-byte", () => {
  withRepository((fixture) => {
    const checkout = create(fixture, "partial-admin");
    const record = entry(fixture, "partial-admin");
    const backlink = join(record.checkout.gitAdmin.path, "gitdir");
    const retained = join(fixture.root, "gitdir.retained");
    renameSync(backlink, retained);
    const audit = manager(fixture).audit("partial-admin");
    assert.equal(audit.receiptMatches, false);
    assert(audit.issues.includes("filesystem-receipt-mismatch"));
    manager(fixture).finish({ slug: "partial-admin", ownerTask: "/root/partial-admin", expectedRevision: 1 });
    assert.equal(readFileSync(join(checkout.checkoutPath, "README.md"), "utf8"), "fixture\n");
    assert.match(readFileSync(retained, "utf8"), /partial-admin\/\.git/u);
  });
});

test("interrupted-create abandon retains late worktrees and persists review state even when initially absent", () => {
  withRepository((fixture) => {
    let outside;
    let attachLate = false;
    const interrupted = manager(fixture, {
      hooks: {
        afterRegistryBeforeGit: () => assert.fail("early stop"),
        beforeAbandonPendingWrite() {
          if (!attachLate) return;
          outside = join(fixture.root, "outside-worktree");
          git(fixture.repository, "worktree", "add", "-q", "-b", "agent/branch-used", outside, "HEAD");
          writeFileSync(join(outside, "valuable.txt"), "outside work\n");
        }
      }
    });
    assert.throws(
      () => interrupted.create({ slug: "branch-used", branch: "agent/branch-used", ownerTask: "/root/branch-used" }),
      /early stop/u
    );
    attachLate = true;
    const result = interrupted.abandon({
      slug: "branch-used",
      expectedOwnerTask: "/root/branch-used",
      expectedRevision: 1,
      expectedHead: "absent"
    });
    assert.equal(result.status, "abandoned-review-required");
    assert.equal(readFileSync(join(outside, "valuable.txt"), "utf8"), "outside work\n");
    assert.deepEqual(
      entryHistory(fixture, "branch-used").map((record) => record.state),
      ["creating", "abandoned-review-required"]
    );
  });

  withRepository((fixture) => {
    const interrupted = manager(fixture, { hooks: { afterRegistryBeforeGit: () => assert.fail("early stop") } });
    assert.throws(
      () => interrupted.create({ slug: "empty", branch: "agent/empty", ownerTask: "/root/empty" }),
      /early stop/u
    );
    const before = registryBytes(fixture);
    const result = interrupted.abandon({
      slug: "empty",
      expectedOwnerTask: "/root/empty",
      expectedRevision: 1,
      expectedHead: "absent"
    });
    assert.equal(result.status, "abandoned-review-required");
    assert.equal(Object.keys(before).length, 1);
    assert.deepEqual(
      entryHistory(fixture, "empty").map((record) => record.state),
      ["creating", "abandoned-review-required"]
    );
  });
});

test("finish never overwrites a concurrently planted next generation", () => {
  withRepository((fixture) => {
    let plant = false;
    let plantedPath;
    const managed = manager(fixture, {
      hooks: {
        beforeCleanupPendingWrite(record) {
          if (!plant) return;
          plantedPath = join(fixture.managerRoot, "entries", `${record.slug}.${record.generation + 1}.json`);
          writeFileSync(plantedPath, "valuable replacement entry\n", { flag: "wx", mode: 0o600 });
        }
      }
    });
    create(fixture, "entry-collision", { manager: managed });
    plant = true;
    lifecycleError(
      () =>
        managed.finish({
          slug: "entry-collision",
          ownerTask: "/root/entry-collision",
          expectedRevision: 1
        }),
      "registry-changed"
    );
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable replacement entry\n");
    assert.equal(entryPaths(fixture, "entry-collision").length, 3);
  });
});

test("finish retains both an entry rebound and its replacement", () => {
  withRepository((fixture) => {
    let rebind = false;
    let retained;
    let replacementPath;
    const managed = manager(fixture, {
      hooks: {
        beforeCleanupPendingWrite(record) {
          if (!rebind) return;
          replacementPath = entryPaths(fixture, record.slug).at(-1);
          retained = join(fixture.root, "retained-entry.json");
          const bytes = readFileSync(replacementPath);
          renameSync(replacementPath, retained);
          writeFileSync(replacementPath, bytes, { flag: "wx", mode: 0o600 });
        }
      }
    });
    create(fixture, "entry-rebind", { manager: managed });
    rebind = true;
    lifecycleError(
      () => managed.finish({ slug: "entry-rebind", ownerTask: "/root/entry-rebind", expectedRevision: 1 }),
      "registry-changed"
    );
    assert.deepEqual(readFileSync(replacementPath), readFileSync(retained));
    assert.equal(entryPaths(fixture, "entry-rebind").length, 2);
  });
});

test("lock release retains both the acquired lock and a rebound replacement", () => {
  withRepository((fixture) => {
    let rebind = false;
    let managed;
    const retained = join(fixture.root, "retained-operation.lock");
    managed = manager(fixture, {
      hooks: {
        afterOperationLockAcquired(lock) {
          if (!rebind) return;
          renameSync(lock.claimPath, retained);
          writeFileSync(
            lock.claimPath,
            `${JSON.stringify({
              protocol: "openwrangler-checkout-operation-lock-v2",
              generation: lock.claim.value.generation,
              pid: process.pid,
              token: "b".repeat(32)
            })}\n`,
            { flag: "wx", mode: 0o600 }
          );
        }
      }
    });
    create(fixture, "lock-rebind", { manager: managed });
    rebind = true;
    lifecycleError(() => managed.status("lock-rebind"), "lock-changed");
    assert.match(readFileSync(retained, "utf8"), /openwrangler-checkout-operation-lock-v2/u);
    const replacement = readdirSync(managed.paths.locks)
      .filter((name) => name.endsWith(".claim.json"))
      .map((name) => join(managed.paths.locks, name))
      .find((path) => readFileSync(path, "utf8").includes(`"token":"${"b".repeat(32)}"`));
    assert.notEqual(replacement, undefined);
    assert.match(readFileSync(replacement, "utf8"), new RegExp(`"token":"${"b".repeat(32)}"`, "u"));
  });
});

test("lock release never overwrites a planted destination", () => {
  withRepository((fixture) => {
    let plant = false;
    let plantedPath;
    const managed = manager(fixture, {
      hooks: {
        beforeOperationLockRelease(lock) {
          if (!plant) return;
          plantedPath = lock.releasePath;
          writeFileSync(plantedPath, "valuable planted release\n", { flag: "wx", mode: 0o600 });
        }
      }
    });
    create(fixture, "lock-release-collision", { manager: managed });
    plant = true;
    lifecycleError(() => managed.status("lock-release-collision"), "lock-changed");
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable planted release\n");
  });
});

test("the real CLI plans and archives a finished checkout without deleting it", () => {
  withRepository((fixture) => {
    const managed = defaultManager(fixture);
    const checkout = create(fixture, "self-cli", { manager: managed });
    const audit = spawnSync(process.execPath, [SCRIPT, "audit", "self-cli"], {
      cwd: checkout.checkoutPath,
      encoding: "utf8"
    });
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).receiptMatches, true);
    const finish = spawnSync(
      process.execPath,
      [SCRIPT, "finish", "self-cli", "--owner", "/root/self-cli", "--revision", "1"],
      { cwd: checkout.checkoutPath, encoding: "utf8" }
    );
    assert.equal(finish.status, 0, finish.stderr);
    assert.equal(JSON.parse(finish.stdout).status, "cleanup-review-required");
    const cleanup = entry(fixture, "self-cli", managed.paths.root);
    const plan = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "plan-retirement",
        "self-cli",
        "--owner",
        "/root/self-cli",
        "--revision",
        "1",
        "--generation",
        String(cleanup.generation)
      ],
      { cwd: checkout.checkoutPath, encoding: "utf8" }
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).status, "retirement-evidence-recorded");
    const archive = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "archive-retirement",
        "self-cli",
        "--owner",
        "/root/self-cli",
        "--revision",
        "1",
        "--generation",
        String(cleanup.generation)
      ],
      { cwd: checkout.checkoutPath, encoding: "utf8" }
    );
    assert.equal(archive.status, 0, archive.stderr);
    const archived = JSON.parse(archive.stdout);
    assert.equal(archived.status, "recovery-archive-recorded");
    assert.equal(existsSync(join(dirname(archived.archivePath), "complete.json")), true);
    assert.equal(readFileSync(join(checkout.checkoutPath, "README.md"), "utf8"), "fixture\n");
  });
});

test("strict and bounded registry reads fail before status trusts malformed state", () => {
  withRepository((fixture) => {
    create(fixture, "strict");
    const path = entryPaths(fixture, "strict").at(-1);
    writeFileSync(path, `${JSON.stringify({ ...entry(fixture, "strict"), surprise: true })}\n`);
    lifecycleError(() => manager(fixture).status("strict"), "invalid-registry");
  });
  withRepository((fixture) => {
    create(fixture, "bounded");
    writeFileSync(entryPaths(fixture, "bounded").at(-1), "x".repeat(64 * 1024 + 1));
    lifecycleError(() => manager(fixture).status("bounded"), "unsafe-registry");
  });
  withRepository((fixture) => {
    create(fixture, "duplicate");
    const path = entryPaths(fixture, "duplicate").at(-1);
    const serialized = JSON.stringify(entry(fixture, "duplicate"));
    writeFileSync(path, `${serialized.replace('"state":"active"', '"state":"active","state":"creating"')}\n`);
    lifecycleError(() => manager(fixture).audit("duplicate"), "duplicate-json-key");
  });
  withRepository((fixture) => {
    create(fixture, "deep-json");
    writeFileSync(entryPaths(fixture, "deep-json").at(-1), `${"[".repeat(66)}0${"]".repeat(66)}\n`);
    lifecycleError(() => manager(fixture).audit("deep-json"), "invalid-registry");
  });
  withRepository((fixture) => {
    create(fixture, "wide-json");
    writeFileSync(entryPaths(fixture, "wide-json").at(-1), `[${"0,".repeat(4097)}0]\n`);
    lifecycleError(() => manager(fixture).audit("wide-json"), "invalid-registry");
  });
});
