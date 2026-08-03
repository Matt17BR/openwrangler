import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CheckoutLifecycleError,
  bootstrapCheckoutManager,
  classifyQuarantineObservation,
  createCheckoutManager,
  normalizeWorktreeRegistryPath,
  requireSynchronousLifecycleResult,
  validateLegacyIndexStages
} from "./checkout-lifecycle.mjs";
import {
  repositoryPythonEnvironment,
  repositoryPythonNoBytecodeEnvironment
} from "./repository-python-environment.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "checkout-lifecycle.mjs");

test("repository Python child environments disable bytecode without case-variant overrides", () => {
  assert.deepEqual(
    repositoryPythonNoBytecodeEnvironment({
      PYTHONDONTWRITEBYTECODE: "0",
      pythondontwritebytecode: "0",
      PYTHONPATH: "/inherited/python",
      KEEP_ME: "yes"
    }),
    {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: "/inherited/python",
      KEEP_ME: "yes"
    }
  );
  assert.deepEqual(
    repositoryPythonEnvironment("/private/python", {
      PYTHONDONTWRITEBYTECODE: "0",
      pythondontwritebytecode: "0",
      PYTHONPATH: "/inherited/python",
      pythonpath: "/case-variant/python",
      KEEP_ME: "yes"
    }),
    {
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: "/private/python",
      KEEP_ME: "yes"
    }
  );
});

test("the synchronous lifecycle lock guard rejects Promises and thenables", () => {
  const value = { status: "complete" };
  assert.equal(requireSynchronousLifecycleResult(value), value);
  lifecycleError(() => requireSynchronousLifecycleResult(Promise.resolve(value)), "async-lifecycle-operation");
  lifecycleError(() => requireSynchronousLifecycleResult({ then() {} }), "async-lifecycle-operation");
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function gitInput(cwd, input, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function addUnreachableObjectGraph(checkout) {
  const blob = gitInput(checkout, "unreachable payload\n", "hash-object", "-w", "--stdin");
  const tree = gitInput(checkout, `100644 blob ${blob}\torphan.txt\n`, "mktree");
  const commit = git(checkout, "commit-tree", tree, "-m", "Unreachable commit");
  git(checkout, "tag", "-a", "orphan-tag", commit, "-m", "Unreachable tag");
  const tag = git(checkout, "rev-parse", "refs/tags/orphan-tag");
  git(checkout, "tag", "-d", "orphan-tag");
  return Object.freeze({ blob, tree, commit, tag });
}

function allObjectManifest(checkout) {
  return git(checkout, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)", "--batch-all-objects");
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
      input: options.stdinFd === undefined ? options.input : undefined,
      maxBuffer: 4 * 1024 * 1024,
      stdio: [
        options.stdinFd === undefined ? (options.input === undefined ? "ignore" : "pipe") : options.stdinFd,
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
    if (command === "git") behavior.afterGit?.({ args: [...args], options, result: normalized });
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

function legacyCandidate(fixture, slug, options = {}) {
  const parent = join(fixture.repository, "tmp", "codex-checkpoints");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const checkout = join(parent, slug);
  git(fixture.root, "clone", "-q", fixture.repository, checkout);
  git(checkout, "config", "user.name", "Checkout Test");
  git(checkout, "config", "user.email", "checkout@example.invalid");
  mkdirSync(join(checkout, "node_modules", "example"), { recursive: true });
  writeFileSync(join(checkout, "node_modules", "example", "index.js"), "generated dependency\n");
  writeFileSync(join(checkout, "fixture.ignored"), "generated artifact\n");
  options.configure?.(checkout);
  return checkout;
}

function adoptedLegacyCandidate(fixture, slug, options = {}) {
  bootstrapCheckoutManager({
    repositoryPath: fixture.repository,
    tokenFactory: () => (options.bootstrapToken ?? "a").repeat(32)
  });
  const checkout = legacyCandidate(fixture, slug, options);
  const managed = defaultManager(fixture, { tokenFactory: () => (options.adoptionToken ?? "b").repeat(32) });
  managed.legacyAdopt({
    slug,
    ownerTask: options.ownerTask ?? `/root/${slug}`,
    generatedRoots: ["node_modules"],
    generatedFiles: ["fixture.ignored"]
  });
  return Object.freeze({ checkout, managed });
}

function fileSnapshot(path) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assert.equal(before.isFile(), true);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    return Object.freeze({
      device: before.dev.toString(),
      inode: before.ino.toString(),
      size: before.size.toString(),
      mode: before.mode.toString(),
      mtimeNs: before.mtimeNs.toString(),
      ctimeNs: before.ctimeNs.toString(),
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  } finally {
    closeSync(descriptor);
  }
}

test("bootstrap publishes one self-contained bare manager and routes source and child commands to it", () => {
  withRepository((fixture) => {
    const behavior = {};
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      run: fixtureRun(behavior),
      tokenFactory: () => "1".repeat(32)
    });
    assert.equal(git(published.repositoryPath, "rev-parse", "--is-bare-repository"), "true");
    assert.equal(git(published.repositoryPath, "rev-parse", "--is-shallow-repository"), "false");
    assert.equal(
      git(published.repositoryPath, "config", "--get-all", "remote.origin.fetch"),
      "+refs/heads/*:refs/remotes/origin/*"
    );
    assert.equal(existsSync(join(published.repositoryPath, "objects", "info", "alternates")), false);
    assert.equal(existsSync(join(published.repositoryPath, "shallow")), false);
    writeFileSync(join(fixture.repository, "README.md"), "source advanced after bootstrap\n");
    git(fixture.repository, "add", "README.md");
    git(fixture.repository, "commit", "-q", "-m", "Advance source after bootstrap");
    const advancedHead = git(fixture.repository, "rev-parse", "HEAD");
    const fromSource = createCheckoutManager({ repositoryPath: fixture.repository, run: fixtureRun(behavior) });
    assert.equal(fromSource.paths.root, published.statePath);
    const first = create(fixture, "bare-source", { manager: fromSource });
    assert.equal(git(first.checkoutPath, "rev-parse", "HEAD"), advancedHead);
    chmodSync(git(first.checkoutPath, "rev-parse", "--git-path", "index"), 0o664);
    assert.equal(defaultManager(fixture).status("bare-source")[0].state, "active");

    const fromChild = createCheckoutManager({ repositoryPath: first.checkoutPath, run: fixtureRun(behavior) });
    assert.equal(fromChild.paths.root, published.statePath);
    const second = fromChild.create({
      slug: "bare-child",
      branch: "agent/bare-child",
      ownerTask: "/root/bare-child"
    });
    assert.equal(existsSync(join(second.checkoutPath, "README.md")), true);
    assert.deepEqual(
      createCheckoutManager({ repositoryPath: second.checkoutPath, run: fixtureRun(behavior) })
        .status()
        .map((item) => item.slug),
      ["bare-child", "bare-source"]
    );
    assert.equal(behavior.networkCommands.length, 1);
    assert.equal(behavior.networkCommands[0].includes(fixture.repository), true);
    assert.equal(
      behavior.networkCommands[0].some((item) => /^https?:|^ssh:|^[^/]+@[^:]+:/u.test(item)),
      false
    );
  });
});

test("legacy audit is read-only and accounts for every declared ignored leaf", () => {
  withRepository((fixture) => {
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "1".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-audit");
    const indexPath = join(checkout, ".git", "index");
    const indexBefore = fileSnapshot(indexPath);
    const readmeBefore = fileSnapshot(join(checkout, "README.md"));
    const evidence = defaultManager(fixture).legacyAudit({
      slug: "legacy-audit",
      generatedRoots: ["node_modules"],
      generatedFiles: ["fixture.ignored"]
    });

    assert.equal(evidence.state, "adopted-review-required");
    assert.equal(evidence.source.checkout, checkout);
    assert.equal(evidence.git.head, git(checkout, "rev-parse", "HEAD"));
    assert.deepEqual(Object.keys(evidence.git.fsck).sort(), ["mode", "stderrSha256", "stdoutSha256"]);
    assert.equal(evidence.git.fsck.mode, "strict-full-no-dangling");
    assert.equal(evidence.git.ignoredCount, 2);
    assert.deepEqual(evidence.generated.allowlist, [
      { kind: "file", path: "fixture.ignored" },
      { kind: "directory", path: "node_modules" }
    ]);
    assert.equal(evidence.generated.inventory.entryCount, 4);
    assert.equal(evidence.authorizesMove, false);
    assert.equal(evidence.authorizesCleanup, false);
    assert.deepEqual(fileSnapshot(indexPath), indexBefore);
    assert.deepEqual(fileSnapshot(join(checkout, "README.md")), readmeBefore);
    assert.equal(existsSync(join(published.statePath, "legacy-adoptions")), false);
  });
});

test("legacy adoption records two identical audits in an append-only review journal", () => {
  withRepository((fixture) => {
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "2".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-adopt");
    const managed = defaultManager(fixture, { tokenFactory: () => "3".repeat(32) });
    const child = managed.create({
      slug: "legacy-status-child",
      branch: "agent/legacy-status-child",
      ownerTask: "/root/legacy-status-child"
    });
    const result = managed.legacyAdopt({
      slug: "legacy-adopt",
      ownerTask: "/root/legacy-adopt",
      generatedRoots: ["node_modules"],
      generatedFiles: ["fixture.ignored"]
    });

    assert.equal(result.status, "adopted-review-required");
    assert.equal(result.evidence.source.checkout, checkout);
    assert.equal(result.evidence.source.bootstrapPublication.path, published.receiptPath);
    assert.match(result.evidence.source.bootstrapPublication.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.authorizesMove, false);
    assert.equal(result.authorizesCleanup, false);
    const attempt = join(managed.paths.legacyAdoptionAttempts, "legacy-adopt.00000001");
    const completion = lstatSync(join(attempt, "complete.json"), { bigint: true });
    const entry = lstatSync(join(managed.paths.legacyAdoptionEntries, "legacy-adopt.json"), { bigint: true });
    assert.equal(completion.nlink, 2n);
    assert.equal(completion.dev, entry.dev);
    assert.equal(completion.ino, entry.ino);
    assert.deepEqual(managed.legacyStatus("legacy-adopt"), [
      {
        slug: "legacy-adopt",
        state: "adopted-review-required",
        generation: 1,
        ownerTask: "/root/legacy-adopt",
        checkout,
        head: result.evidence.git.head,
        generatedInventorySha256: result.evidence.generated.inventory.sha256,
        attempts: [{ generation: 1, state: "published-review-required" }],
        authorizesMove: false,
        authorizesCleanup: false
      }
    ]);
    assert.deepEqual(
      createCheckoutManager({ repositoryPath: child.checkoutPath }).legacyStatus("legacy-adopt"),
      managed.legacyStatus("legacy-adopt")
    );
    lifecycleError(
      () =>
        managed.legacyAdopt({
          slug: "legacy-adopt",
          ownerTask: "/root/legacy-adopt",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-adoption-exists"
    );
  });
});

test("legacy recovery archive preserves every reachable and unreachable Git object without changing the source", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "1".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-all-objects");
    const unreachable = addUnreachableObjectGraph(checkout);
    const behavior = {};
    const managed = defaultManager(fixture, {
      run: fixtureRun(behavior),
      tokenFactory: () => "2".repeat(32)
    });
    managed.legacyAdopt({
      slug: "legacy-all-objects",
      ownerTask: "/root/legacy-all-objects",
      generatedRoots: ["node_modules"],
      generatedFiles: ["fixture.ignored"]
    });
    const sourceManifest = allObjectManifest(checkout);
    const indexBefore = fileSnapshot(join(checkout, ".git", "index"));
    const configBefore = fileSnapshot(join(checkout, ".git", "config"));
    const readmeBefore = fileSnapshot(join(checkout, "README.md"));
    const result = managed.legacyArchive({
      slug: "legacy-all-objects",
      ownerTask: "/root/legacy-all-objects"
    });

    assert.equal(result.status, "archived-review-required");
    assert.equal(result.authorizesMove, false);
    assert.equal(result.authorizesCleanup, false);
    assert.equal(result.objectCount, sourceManifest.split("\n").length);
    for (const [type, oid] of Object.entries(unreachable)) {
      assert.equal(git(result.recoveryPath, "cat-file", "-t", oid), type);
    }
    assert.equal(allObjectManifest(result.recoveryPath), sourceManifest);
    assert.equal(allObjectManifest(checkout), sourceManifest);
    assert.deepEqual(fileSnapshot(join(checkout, ".git", "index")), indexBefore);
    assert.deepEqual(fileSnapshot(join(checkout, ".git", "config")), configBefore);
    assert.deepEqual(fileSnapshot(join(checkout, "README.md")), readmeBefore);
    assert.deepEqual(behavior.networkCommands ?? [], []);
    const status = managed.legacyStatus("legacy-all-objects")[0];
    assert.equal(status.archive.state, "archived-review-required");
    assert.equal(status.archive.objectCount, result.objectCount);
    assert.equal(status.archive.packSha256, result.packSha256);
    assert.equal(status.archive.authorizesMove, false);
    assert.equal(status.archive.authorizesCleanup, false);
    assert.equal(
      behavior.gitCalls.some(
        ({ args }) => args.includes("fsck") && args.includes("--strict") && args.includes("--full")
      ),
      true
    );
    assert.equal(
      behavior.gitCalls.some(({ args }) => args.includes("cat-file") && args.includes("--batch-all-objects")),
      true
    );
  });
});

test("legacy status rejects changed, corrupt, or rebound recovery repositories", () => {
  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-status-extra-object");
    const archived = managed.legacyArchive({
      slug: "legacy-status-extra-object",
      ownerTask: "/root/legacy-status-extra-object"
    });
    gitInput(archived.recoveryPath, "late recovery object\n", "hash-object", "-w", "--stdin");
    lifecycleError(() => managed.legacyStatus("legacy-status-extra-object"), "legacy-archive-changed");
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-status-corrupt-shadow");
    const archived = managed.legacyArchive({
      slug: "legacy-status-corrupt-shadow",
      ownerTask: "/root/legacy-status-corrupt-shadow"
    });
    const oid = git(archived.recoveryPath, "rev-parse", "HEAD^{tree}");
    const directory = join(archived.recoveryPath, "objects", oid.slice(0, 2));
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, oid.slice(2)), "corrupt shadow\n", { flag: "wx", mode: 0o600 });
    lifecycleError(() => managed.legacyStatus("legacy-status-corrupt-shadow"), "legacy-archive-changed");
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-status-rebound-recovery");
    const archived = managed.legacyArchive({
      slug: "legacy-status-rebound-recovery",
      ownerTask: "/root/legacy-status-rebound-recovery"
    });
    const retained = join(fixture.root, "retained-recovery.git");
    renameSync(archived.recoveryPath, retained);
    mkdirSync(archived.recoveryPath, { mode: 0o700 });
    lifecycleError(() => managed.legacyStatus("legacy-status-rebound-recovery"), "registry-changed");
    assert.equal(existsSync(join(retained, "objects", "pack")), true);
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-status-manifest-proof");
    managed.legacyArchive({
      slug: "legacy-status-manifest-proof",
      ownerTask: "/root/legacy-status-manifest-proof"
    });
    const checking = defaultManager(fixture, {
      hooks: {
        beforeLegacyStatusRecoveryManifestParse(path) {
          const contents = readFileSync(path, "utf8");
          writeFileSync(
            path,
            contents.replace(/ (\d+)\n/u, (_match, size) => ` ${BigInt(size) + 1n}\n`)
          );
        }
      }
    });
    lifecycleError(() => checking.legacyStatus("legacy-status-manifest-proof"), "legacy-checkout-changed");
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-status-late-info-file");
    managed.legacyArchive({
      slug: "legacy-status-late-info-file",
      ownerTask: "/root/legacy-status-late-info-file"
    });
    let plantedPath;
    const checking = defaultManager(fixture, {
      hooks: {
        beforeLegacyStatusRecoveryFsck(_attempt, receipt) {
          plantedPath = join(receipt.recovery.repository.path, "objects", "info", "unknown");
          writeFileSync(plantedPath, "valuable unknown file\n", { flag: "wx", mode: 0o600 });
        }
      }
    });
    lifecycleError(() => checking.legacyStatus("legacy-status-late-info-file"), "legacy-archive-changed");
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable unknown file\n");
  });

  for (const location of ["root", "logs"]) {
    withRepository((fixture) => {
      const slug = `legacy-status-late-${location}-file`;
      const { managed } = adoptedLegacyCandidate(fixture, slug);
      managed.legacyArchive({ slug, ownerTask: `/root/${slug}` });
      let plantedPath;
      const checking = defaultManager(fixture, {
        hooks: {
          beforeLegacyStatusRecoveryFsck(_attempt, receipt) {
            const parent =
              location === "root" ? receipt.recovery.repository.path : join(receipt.recovery.repository.path, "logs");
            assert.equal(existsSync(parent), true);
            plantedPath = join(parent, "unknown");
            writeFileSync(plantedPath, `valuable ${location} file\n`, { flag: "wx", mode: 0o600 });
          }
        }
      });
      lifecycleError(() => checking.legacyStatus(slug), "legacy-archive-changed");
      assert.equal(readFileSync(plantedPath, "utf8"), `valuable ${location} file\n`);
    });
  }
});

test("legacy recovery archive restores a detached HEAD when the source has no refs", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "3".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-detached-no-refs");
    const head = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "--quiet", "--detach", head);
    git(checkout, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const refs = git(checkout, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean);
    for (const ref of refs) git(checkout, "update-ref", "-d", ref);
    assert.equal(git(checkout, "for-each-ref", "--format=%(refname)"), "");

    const managed = defaultManager(fixture, { tokenFactory: () => "4".repeat(32) });
    managed.legacyAdopt({
      slug: "legacy-detached-no-refs",
      ownerTask: "/root/legacy-detached-no-refs",
      generatedRoots: ["node_modules"],
      generatedFiles: ["fixture.ignored"]
    });
    const result = managed.legacyArchive({
      slug: "legacy-detached-no-refs",
      ownerTask: "/root/legacy-detached-no-refs"
    });

    assert.equal(git(result.recoveryPath, "rev-parse", "HEAD"), head);
    assert.equal(git(result.recoveryPath, "for-each-ref", "--format=%(refname)"), "");
    assert.equal(allObjectManifest(result.recoveryPath), allObjectManifest(checkout));
  });
});

test("legacy recovery archive retains an interrupted request and rejects planted partial-journal files", () => {
  withRepository((fixture) => {
    const { checkout } = adoptedLegacyCandidate(fixture, "legacy-archive-interrupted");
    const before = allObjectManifest(checkout);
    const interrupted = defaultManager(fixture, {
      tokenFactory: () => "c".repeat(32),
      hooks: {
        afterLegacyArchiveRequest() {
          throw new Error("simulated interruption");
        }
      }
    });
    assert.throws(
      () =>
        interrupted.legacyArchive({
          slug: "legacy-archive-interrupted",
          ownerTask: "/root/legacy-archive-interrupted"
        }),
      /simulated interruption/u
    );
    const status = defaultManager(fixture).legacyStatus("legacy-archive-interrupted")[0];
    assert.deepEqual(status.archive.attempts, [
      { adoptionGeneration: 1, attempt: 1, state: "requested-review-required" }
    ]);
    assert.equal(status.archive.authorizesMove, false);
    assert.equal(status.archive.authorizesCleanup, false);
    assert.equal(allObjectManifest(checkout), before);

    const planted = defaultManager(fixture, {
      tokenFactory: () => "d".repeat(32),
      hooks: {
        afterLegacyArchiveRequest(attempt) {
          writeFileSync(join(attempt.path, "planted.bin"), "valuable planted file\n", { flag: "wx", mode: 0o600 });
          throw new Error("stop after planting");
        }
      }
    });
    assert.throws(
      () =>
        planted.legacyArchive({
          slug: "legacy-archive-interrupted",
          ownerTask: "/root/legacy-archive-interrupted"
        }),
      /stop after planting/u
    );
    lifecycleError(() => defaultManager(fixture).legacyStatus("legacy-archive-interrupted"), "invalid-legacy-archive");
    const plantedPath = join(
      planted.paths.legacyArchiveAttempts,
      "legacy-archive-interrupted.00000001.2",
      "planted.bin"
    );
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable planted file\n");
  });
});

test("legacy status enumerates but fails closed on archives detached from their adoption", () => {
  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-archive-only-complete");
    managed.legacyArchive({
      slug: "legacy-archive-only-complete",
      ownerTask: "/root/legacy-archive-only-complete"
    });
    renameSync(
      join(managed.paths.legacyAdoptionAttempts, "legacy-archive-only-complete.00000001"),
      join(fixture.root, "retained-legacy-adoption-attempt")
    );
    renameSync(
      join(managed.paths.legacyAdoptionEntries, "legacy-archive-only-complete.json"),
      join(fixture.root, "retained-legacy-adoption-entry.json")
    );
    lifecycleError(() => managed.legacyStatus("legacy-archive-only-complete"), "legacy-adoption-changed");
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-archive-only-request");
    const interrupted = defaultManager(fixture, {
      hooks: {
        afterLegacyArchiveRequest() {
          throw new Error("stop after archive request");
        }
      }
    });
    assert.throws(
      () =>
        interrupted.legacyArchive({
          slug: "legacy-archive-only-request",
          ownerTask: "/root/legacy-archive-only-request"
        }),
      /stop after archive request/u
    );
    renameSync(
      join(managed.paths.legacyAdoptionAttempts, "legacy-archive-only-request.00000001"),
      join(fixture.root, "retained-request-adoption-attempt")
    );
    renameSync(
      join(managed.paths.legacyAdoptionEntries, "legacy-archive-only-request.json"),
      join(fixture.root, "retained-request-adoption-entry.json")
    );
    lifecycleError(() => managed.legacyStatus(), "legacy-adoption-changed");
  });

  withRepository((fixture) => {
    const { managed } = adoptedLegacyCandidate(fixture, "legacy-archive-re-adopted");
    managed.legacyArchive({
      slug: "legacy-archive-re-adopted",
      ownerTask: "/root/legacy-archive-re-adopted"
    });
    renameSync(
      join(managed.paths.legacyAdoptionAttempts, "legacy-archive-re-adopted.00000001"),
      join(fixture.root, "retained-original-adoption-attempt")
    );
    renameSync(
      join(managed.paths.legacyAdoptionEntries, "legacy-archive-re-adopted.json"),
      join(fixture.root, "retained-original-adoption-entry.json")
    );
    const replacement = defaultManager(fixture, { tokenFactory: () => "e".repeat(32) });
    const adopted = replacement.legacyAdopt({
      slug: "legacy-archive-re-adopted",
      ownerTask: "/root/replacement-adoption",
      generatedRoots: ["node_modules"],
      generatedFiles: ["fixture.ignored"]
    });
    assert.equal(adopted.generation, 1);
    lifecycleError(() => replacement.legacyStatus("legacy-archive-re-adopted"), "legacy-adoption-changed");
  });
});

test("legacy recovery archive rejects exact source-object drift and corrupt loose objects", () => {
  withRepository((fixture) => {
    const { checkout } = adoptedLegacyCandidate(fixture, "legacy-archive-object-drift");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "c".repeat(32),
      hooks: {
        afterLegacyObjectManifest(_attempt, objects) {
          if (objects.manifestPath.endsWith("objects.manifest")) {
            gitInput(checkout, "late unreachable object\n", "hash-object", "-w", "--stdin");
          }
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-object-drift",
          ownerTask: "/root/legacy-archive-object-drift"
        }),
      "legacy-checkout-changed"
    );
    const attempt = join(managed.paths.legacyArchiveAttempts, "legacy-archive-object-drift.00000001.1");
    assert.equal(existsSync(join(attempt, "receipt.json")), false);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
  });

  withRepository((fixture) => {
    const { checkout } = adoptedLegacyCandidate(fixture, "legacy-archive-corrupt-object");
    const graph = addUnreachableObjectGraph(checkout);
    const managed = defaultManager(fixture, {
      tokenFactory: () => "d".repeat(32),
      hooks: {
        afterLegacyObjectManifest() {
          const path = join(checkout, ".git", "objects", graph.blob.slice(0, 2), graph.blob.slice(2));
          chmodSync(path, 0o600);
          writeFileSync(path, "corrupt\n");
        }
      }
    });
    assert.throws(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-corrupt-object",
          ownerTask: "/root/legacy-archive-corrupt-object"
        }),
      (error) => error instanceof CheckoutLifecycleError
    );
    const attempt = join(managed.paths.legacyArchiveAttempts, "legacy-archive-corrupt-object.00000001.1");
    assert.equal(existsSync(join(attempt, "complete.json")), false);
  });
});

test("legacy recovery archive rechecks objects after metadata capture and after publication", () => {
  for (const phase of ["metadata", "published"]) {
    for (const mutation of ["add", "corrupt"]) {
      withRepository((fixture) => {
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "6".repeat(32)
        });
        const slug = `legacy-${phase}-${mutation}`;
        const checkout = legacyCandidate(fixture, slug);
        const protectedOid = gitInput(checkout, "protected loose object\n", "hash-object", "-w", "--stdin");
        let changed = false;
        const mutate = () => {
          if (changed) return;
          changed = true;
          if (mutation === "add") {
            gitInput(checkout, `${phase} late object\n`, "hash-object", "-w", "--stdin");
            return;
          }
          const path = join(checkout, ".git", "objects", protectedOid.slice(0, 2), protectedOid.slice(2));
          chmodSync(path, 0o600);
          writeFileSync(path, `${phase} corrupt object\n`);
        };
        const managed = defaultManager(fixture, {
          tokenFactory: () => "7".repeat(32),
          hooks:
            phase === "metadata" ? { afterLegacySourceMetadataCapture: mutate } : { afterLegacyArchivePublish: mutate }
        });
        managed.legacyAdopt({
          slug,
          ownerTask: `/root/${slug}`,
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        });
        assert.throws(
          () => managed.legacyArchive({ slug, ownerTask: `/root/${slug}` }),
          (error) => error instanceof CheckoutLifecycleError
        );
        assert.equal(changed, true);
        const attempt = join(managed.paths.legacyArchiveAttempts, `${slug}.00000001.1`);
        if (phase === "metadata") {
          assert.equal(existsSync(join(attempt, "receipt.json")), false);
          assert.equal(existsSync(join(managed.paths.legacyArchiveEntries, `${slug}.json`)), false);
        } else {
          assert.equal(existsSync(join(attempt, "complete.json")), true);
          assert.equal(existsSync(join(managed.paths.legacyArchiveEntries, `${slug}.json`)), true);
        }
      });
    }
  }
});

test("legacy recovery archive rejects pack and index substitution before completion", () => {
  for (const artifact of ["pack", "index"]) {
    withRepository((fixture) => {
      adoptedLegacyCandidate(fixture, `legacy-archive-${artifact}-swap`);
      const managed = defaultManager(fixture, {
        tokenFactory: () => "c".repeat(32),
        hooks: {
          beforeLegacyArchivePublish(_attempt, receipt) {
            writeFileSync(receipt.objects[artifact].path, `substituted ${artifact}\n`);
          }
        }
      });
      assert.throws(
        () =>
          managed.legacyArchive({
            slug: `legacy-archive-${artifact}-swap`,
            ownerTask: `/root/legacy-archive-${artifact}-swap`
          }),
        (error) => error instanceof CheckoutLifecycleError
      );
      const attempt = join(managed.paths.legacyArchiveAttempts, `legacy-archive-${artifact}-swap.00000001.1`);
      assert.equal(existsSync(join(attempt, "receipt.json")), true);
      assert.equal(existsSync(join(attempt, "complete.json")), false);
      assert.equal(existsSync(join(managed.paths.legacyArchiveEntries, `legacy-archive-${artifact}-swap.json`)), false);
    });
  }
});

test("legacy recovery archive never uses an overwrite-capable index output or overwrites a planted recovered index", () => {
  withRepository((fixture) => {
    adoptedLegacyCandidate(fixture, "legacy-archive-planted-index");
    let plantedPath;
    const behavior = {};
    const managed = defaultManager(fixture, {
      run: fixtureRun(behavior),
      tokenFactory: () => "e".repeat(32),
      hooks: {
        beforeLegacyRecoveryIndexPack(attempt, packDirectory) {
          const pack = readFileSync(join(attempt.path, "objects.pack"));
          const packId = pack.subarray(-20).toString("hex");
          plantedPath = join(packDirectory, `pack-${packId}.idx`);
          writeFileSync(plantedPath, "valuable planted index\n", { flag: "wx", mode: 0o600 });
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-planted-index",
          ownerTask: "/root/legacy-archive-planted-index"
        }),
      "legacy-archive-changed"
    );
    assert.equal(readFileSync(plantedPath, "utf8"), "valuable planted index\n");
    assert.equal(
      behavior.gitCalls.some(({ args }) => args.includes("-o")),
      false
    );
    assert.equal(
      existsSync(join(managed.paths.legacyArchiveAttempts, "legacy-archive-planted-index.00000001.1", "index-output")),
      false
    );
  });
});

test("legacy recovery archive binds a reflog descriptor before a raced pathname size can be used", () => {
  withRepository((fixture) => {
    adoptedLegacyCandidate(fixture, "legacy-archive-reflog-race");
    let retained;
    let replacement;
    const managed = defaultManager(fixture, {
      tokenFactory: () => "8".repeat(32),
      hooks: {
        afterLegacyReflogOpen(record, sourcePath) {
          if (record.path !== "HEAD" || retained !== undefined) return;
          retained = join(fixture.root, "retained-archived-head-reflog");
          replacement = sourcePath;
          renameSync(sourcePath, retained);
          const descriptor = openSync(sourcePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
          try {
            ftruncateSync(descriptor, 128 * 1024 * 1024);
          } finally {
            closeSync(descriptor);
          }
        }
      }
    });
    assert.throws(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-reflog-race",
          ownerTask: "/root/legacy-archive-reflog-race"
        }),
      (error) => error instanceof CheckoutLifecycleError
    );
    assert.notEqual(retained, undefined);
    assert.notEqual(replacement, undefined);
    assert.equal(lstatSync(replacement, { bigint: true }).size, 128n * 1024n * 1024n);
    assert.match(readFileSync(retained, "utf8"), /clone:/u);
  });
});

test("legacy recovery archive rejects malformed recovery state and conservative free-space failures", () => {
  withRepository((fixture) => {
    const { checkout } = adoptedLegacyCandidate(fixture, "legacy-archive-bad-reflog");
    writeFileSync(join(checkout, ".git", "logs", "unsupported"), "not a recovery reflog\n");
    const managed = defaultManager(fixture, { tokenFactory: () => "c".repeat(32) });
    lifecycleError(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-bad-reflog",
          ownerTask: "/root/legacy-archive-bad-reflog"
        }),
      "legacy-archive-not-eligible"
    );
  });

  withRepository((fixture) => {
    const { checkout } = adoptedLegacyCandidate(fixture, "legacy-archive-bad-ref");
    const badRef = join(checkout, ".git", "refs", "heads", "bad..name");
    writeFileSync(badRef, `${git(checkout, "rev-parse", "HEAD")}\n`, { flag: "wx", mode: 0o600 });
    const managed = defaultManager(fixture, { tokenFactory: () => "e".repeat(32) });
    assert.throws(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-bad-ref",
          ownerTask: "/root/legacy-archive-bad-ref"
        }),
      (error) => error instanceof CheckoutLifecycleError
    );
    assert.equal(existsSync(join(managed.paths.legacyArchiveEntries, "legacy-archive-bad-ref.json")), false);
  });

  withRepository((fixture) => {
    adoptedLegacyCandidate(fixture, "legacy-archive-no-space");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "d".repeat(32),
      statfs: () => ({ bsize: 1n, bavail: 0n })
    });
    lifecycleError(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-no-space",
          ownerTask: "/root/legacy-archive-no-space"
        }),
      "archive-space-insufficient"
    );
    const attempt = join(managed.paths.legacyArchiveAttempts, "legacy-archive-no-space.00000001.1");
    assert.equal(existsSync(join(attempt, "objects.manifest")), true);
    assert.equal(existsSync(join(attempt, "objects.pack")), false);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
  });
});

test("legacy recovery archive rejects empty and mismatched exact manifests", () => {
  withRepository((fixture) => {
    adoptedLegacyCandidate(fixture, "legacy-archive-empty-manifest");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "c".repeat(32),
      hooks: {
        beforeLegacyObjectManifestParse(stem, path) {
          if (stem === "objects") writeFileSync(path, "");
        }
      }
    });
    assert.throws(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-empty-manifest",
          ownerTask: "/root/legacy-archive-empty-manifest"
        }),
      (error) => error instanceof CheckoutLifecycleError
    );
    const attempt = join(managed.paths.legacyArchiveAttempts, "legacy-archive-empty-manifest.00000001.1");
    assert.equal(existsSync(join(attempt, "objects.pack")), false);
  });

  withRepository((fixture) => {
    adoptedLegacyCandidate(fixture, "legacy-archive-recovery-mismatch");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "d".repeat(32),
      hooks: {
        beforeLegacyObjectManifestParse(stem, path) {
          if (stem !== "recovered") return;
          const contents = readFileSync(path, "utf8");
          const changed = contents.replace(/ (\d+)\n/u, (_match, size) => ` ${BigInt(size) + 1n}\n`);
          writeFileSync(path, changed);
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyArchive({
          slug: "legacy-archive-recovery-mismatch",
          ownerTask: "/root/legacy-archive-recovery-mismatch"
        }),
      "legacy-checkout-changed"
    );
    const attempt = join(managed.paths.legacyArchiveAttempts, "legacy-archive-recovery-mismatch.00000001.1");
    assert.equal(existsSync(join(attempt, "receipt.json")), false);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
  });
});

test("legacy adoption retains an interrupted request when the candidate changes between audits", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "4".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-changing");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "5".repeat(32),
      hooks: {
        afterFirstLegacyAudit() {
          writeFileSync(join(checkout, "node_modules", "late.js"), "appeared after first audit\n");
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyAdopt({
          slug: "legacy-changing",
          ownerTask: "/root/legacy-changing",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-checkout-changed"
    );
    const attempt = join(managed.paths.legacyAdoptionAttempts, "legacy-changing.00000001");
    assert.equal(existsSync(join(attempt, "request.json")), true);
    assert.equal(existsSync(join(attempt, "complete.json")), false);
    assert.equal(existsSync(join(managed.paths.legacyAdoptionEntries, "legacy-changing.json")), false);
    assert.deepEqual(managed.legacyStatus("legacy-changing")[0].attempts, [
      { generation: 1, state: "requested-review-required" }
    ]);
  });
});

test("legacy adoption repeats the full audit after the final publication hook", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "a".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-publish-race");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "b".repeat(32),
      hooks: {
        beforeLegacyAdoptionPublish() {
          writeFileSync(join(checkout, "node_modules", "publication-race.js"), "late generated file\n");
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyAdopt({
          slug: "legacy-publish-race",
          ownerTask: "/root/legacy-publish-race",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-checkout-changed"
    );
    const attempt = join(managed.paths.legacyAdoptionAttempts, "legacy-publish-race.00000001");
    assert.equal(existsSync(join(attempt, "complete.json")), true);
    assert.equal(existsSync(join(managed.paths.legacyAdoptionEntries, "legacy-publish-race.json")), false);
    assert.deepEqual(managed.legacyStatus("legacy-publish-race")[0].attempts, [
      { generation: 1, state: "completed-unpublished-review-required" }
    ]);
  });
});

test("legacy adoption detects a candidate identity change after hard-link publication", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "c".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-post-publish-race");
    const retained = join(fixture.root, "retained-legacy-post-publish-race");
    const managed = defaultManager(fixture, {
      tokenFactory: () => "d".repeat(32),
      hooks: {
        afterLegacyAdoptionPublish() {
          renameSync(checkout, retained);
          mkdirSync(checkout, { mode: 0o700 });
        }
      }
    });
    lifecycleError(
      () =>
        managed.legacyAdopt({
          slug: "legacy-post-publish-race",
          ownerTask: "/root/legacy-post-publish-race",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "registry-changed"
    );
    assert.equal(existsSync(join(retained, "README.md")), true);
    assert.equal(existsSync(join(managed.paths.legacyAdoptionEntries, "legacy-post-publish-race.json")), true);
  });
});

test("legacy adoption preflights persistent JSON size before writing a record", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "e".repeat(32)
    });
    legacyCandidate(fixture, "legacy-record-cap");
    const generatedRoots = Array.from(
      { length: 64 },
      (_, index) => `generated-${String(index).padStart(2, "0")}-${"x".repeat(1005)}`
    );
    const managed = defaultManager(fixture, { tokenFactory: () => "f".repeat(32) });
    lifecycleError(
      () =>
        managed.legacyAdopt({
          slug: "legacy-record-cap",
          ownerTask: "/root/legacy-record-cap",
          generatedRoots
        }),
      "legacy-adoption-record-too-large"
    );
    const attempt = join(managed.paths.legacyAdoptionAttempts, "legacy-record-cap.00000001");
    assert.deepEqual(readdirSync(attempt), []);
    assert.deepEqual(managed.legacyStatus("legacy-record-cap")[0].attempts, [
      { generation: 1, state: "allocated-review-required" }
    ]);
  });
});

test("legacy audit rejects undeclared ignored content, untracked work, and tracked generated roots", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "6".repeat(32)
    });
    const undeclared = legacyCandidate(fixture, "legacy-undeclared", {
      configure(checkout) {
        writeFileSync(join(checkout, "extra.ignored"), "not declared\n");
      }
    });
    const untracked = legacyCandidate(fixture, "legacy-untracked", {
      configure(checkout) {
        writeFileSync(join(checkout, "untracked.txt"), "not ignored\n");
      }
    });
    const tracked = legacyCandidate(fixture, "legacy-tracked", {
      configure(checkout) {
        writeFileSync(join(checkout, "node_modules", "tracked.js"), "tracked despite ignore\n");
        git(checkout, "add", "-f", "node_modules/tracked.js");
        git(checkout, "commit", "-q", "-m", "Track generated-looking content");
      }
    });
    const managed = defaultManager(fixture);
    for (const [slug, checkout] of [
      ["legacy-undeclared", undeclared],
      ["legacy-untracked", untracked],
      ["legacy-tracked", tracked]
    ]) {
      assert.equal(existsSync(checkout), true);
      lifecycleError(
        () =>
          managed.legacyAudit({
            slug,
            generatedRoots: ["node_modules"],
            generatedFiles: ["fixture.ignored"]
          }),
        "legacy-audit-not-eligible"
      );
    }
  });
});

test("legacy audit rejects local includes before an external clean filter can start", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "1".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-filter-include");
    writeFileSync(join(checkout, ".gitattributes"), "README.md filter=sentinel\n");
    git(checkout, "add", ".gitattributes");
    git(checkout, "commit", "-q", "-m", "Add filter attributes");
    const sentinel = join(fixture.root, "filter-started");
    const filterScript = join(fixture.root, "filter-sentinel.cjs");
    const includedConfig = join(fixture.root, "included-filter.config");
    writeFileSync(filterScript, "require('node:fs').writeFileSync(process.argv[2], 'started\\n');\n");
    git(
      fixture.root,
      "config",
      "--file",
      includedConfig,
      "filter.sentinel.clean",
      `"${process.execPath}" "${filterScript}" "${sentinel}"`
    );
    git(checkout, "config", "--local", "include.path", includedConfig);
    const behavior = {};
    lifecycleError(
      () =>
        defaultManager(fixture, { run: fixtureRun(behavior) }).legacyAudit({
          slug: "legacy-filter-include",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
    assert.equal(existsSync(sentinel), false);
    assert.equal(
      behavior.gitCalls.some(({ args }) => args.includes("diff-files") || args.includes("status")),
      false
    );
  });
});

test("legacy audit pins configuration before a raced clean filter can start", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "1".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-filter-race");
    writeFileSync(join(checkout, ".gitattributes"), "README.md filter=sentinel\n");
    git(checkout, "add", ".gitattributes");
    git(checkout, "commit", "-q", "-m", "Add filter attributes");
    const sentinel = join(fixture.root, "raced-filter-started");
    const filterScript = join(fixture.root, "raced-filter-sentinel.cjs");
    writeFileSync(filterScript, "require('node:fs').writeFileSync(process.argv[2], 'started\\n');\n");
    let configCaptures = 0;
    const behavior = {
      afterGit({ args }) {
        if (!args.includes("config") || !args.includes("--local") || !args.includes("--list")) return;
        configCaptures += 1;
        if (configCaptures !== 2) return;
        git(
          checkout,
          "config",
          "--local",
          "filter.sentinel.clean",
          `"${process.execPath}" "${filterScript}" "${sentinel}"`
        );
        writeFileSync(join(checkout, "README.md"), "changed after pinned configuration\n");
      }
    };
    const managed = defaultManager(fixture, { run: fixtureRun(behavior) });
    lifecycleError(
      () =>
        managed.legacyAudit({
          slug: "legacy-filter-race",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
    assert.equal(configCaptures, 2);
    assert.equal(existsSync(sentinel), false);
    assert.equal(
      readdirSync(managed.paths.root).some((name) => name.startsWith(".legacy-audit-")),
      false
    );
  });
});

test("legacy audit rejects external Git administration before starting Git", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "2".repeat(32)
    });
    const cases = [
      ["objects", "directory"],
      ["refs", "directory"],
      ["logs", "directory"],
      ["index", "file"],
      ["config", "file"]
    ];
    for (const [name, kind] of cases) {
      const slug = `legacy-external-${name}`;
      const checkout = legacyCandidate(fixture, slug);
      const source = join(checkout, ".git", name);
      const external = join(fixture.root, `${slug}-${name}`);
      renameSync(source, external);
      symlinkSync(external, source, kind === "directory" ? "dir" : "file");
      const behavior = {};
      const managed = defaultManager(fixture, { run: fixtureRun(behavior) });
      behavior.gitCalls.length = 0;
      lifecycleError(
        () =>
          managed.legacyAudit({
            slug,
            generatedRoots: ["node_modules"],
            generatedFiles: ["fixture.ignored"]
          }),
        "legacy-audit-not-eligible"
      );
      assert.deepEqual(behavior.gitCalls, []);
      assert.equal(
        readdirSync(managed.paths.root).some((entry) => entry.startsWith(".legacy-audit-")),
        false
      );
    }
  });
});

test("legacy audit rejects external attributes, excludes, and worktree-local configuration", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "2".repeat(32)
    });
    const cases = [
      ["legacy-attributes-config", "core.attributesFile", join(fixture.root, "attributes")],
      ["legacy-excludes-config", "core.excludesFile", join(fixture.root, "excludes")],
      ["legacy-split-config", "core.splitIndex", "true"]
    ];
    for (const [slug, key, value] of cases) {
      const checkout = legacyCandidate(fixture, slug);
      git(checkout, "config", "--local", key, value);
      lifecycleError(
        () =>
          defaultManager(fixture).legacyAudit({
            slug,
            generatedRoots: ["node_modules"],
            generatedFiles: ["fixture.ignored"]
          }),
        "legacy-audit-not-eligible"
      );
    }
    const conditionalInclude = legacyCandidate(fixture, "legacy-conditional-include");
    git(
      conditionalInclude,
      "config",
      "--local",
      `includeIf.gitdir:${conditionalInclude}/.path`,
      join(fixture.root, "conditional.config")
    );
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-conditional-include",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
    const worktree = legacyCandidate(fixture, "legacy-worktree-config");
    git(worktree, "config", "--local", "extensions.worktreeConfig", "true");
    git(worktree, "config", "--worktree", "openwrangler.test", "true");
    assert.equal(existsSync(join(worktree, ".git", "config.worktree")), true);
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-worktree-config",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
  });
});

test("legacy audit rejects split-index files and a retained split-index extension", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "3".repeat(32)
    });
    const fileCheckout = legacyCandidate(fixture, "legacy-split-file");
    writeFileSync(join(fileCheckout, ".git", `sharedindex.${"a".repeat(40)}`), "unexpected shared index\n");
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-split-file",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );

    const extensionCheckout = legacyCandidate(fixture, "legacy-split-extension");
    git(extensionCheckout, "update-index", "--split-index");
    const sharedIndex = git(extensionCheckout, "rev-parse", "--path-format=absolute", "--shared-index-path");
    assert.notEqual(sharedIndex, "");
    rmSync(sharedIndex);
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-split-extension",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
  });
});

test("legacy audit rejects operation metadata, private refs, and directory index entries", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "4".repeat(32)
    });
    for (const [index, namespace] of ["refs/worktree/", "refs/bisect/", "refs/rewritten/"].entries()) {
      const slug = `legacy-private-ref-${index}`;
      const checkout = legacyCandidate(fixture, slug);
      git(checkout, "update-ref", `${namespace}guard`, "HEAD");
      lifecycleError(
        () =>
          defaultManager(fixture).legacyAudit({
            slug,
            generatedRoots: ["node_modules"],
            generatedFiles: ["fixture.ignored"]
          }),
        "legacy-audit-not-eligible"
      );
    }

    const bisect = legacyCandidate(fixture, "legacy-bisect-state");
    writeFileSync(join(bisect, ".git", "BISECT_START"), "main\n");
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-bisect-state",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );

    lifecycleError(
      () => validateLegacyIndexStages(`040000 ${"a".repeat(40)} 0\tvirtual-directory\0`),
      "legacy-audit-not-eligible"
    );
  });
});

test("legacy audit runs strict full fsck and rejects an unreachable corrupt object", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "5".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-corrupt-object");
    const objectDirectory = join(checkout, ".git", "objects", "aa");
    mkdirSync(objectDirectory, { mode: 0o700 });
    writeFileSync(join(objectDirectory, "a".repeat(38)), "not a valid loose Git object\n");
    lifecycleError(
      () =>
        defaultManager(fixture).legacyAudit({
          slug: "legacy-corrupt-object",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-audit-not-eligible"
    );
  });
});

test("legacy audit derives its path from the bootstrap receipt and rejects unsafe allowlists", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "7".repeat(32)
    });
    legacyCandidate(fixture, "legacy-derived");
    const managed = defaultManager(fixture);
    lifecycleError(
      () =>
        managed.legacyAudit({
          slug: "legacy-derived",
          generatedRoots: ["../node_modules"],
          generatedFiles: []
        }),
      "invalid-legacy-generated-path"
    );
    lifecycleError(
      () =>
        managed.legacyAudit({
          slug: "legacy-derived",
          generatedRoots: ["A/b", "a"],
          generatedFiles: []
        }),
      "invalid-legacy-generated-path"
    );
    for (const unsafe of [".GIT/config", "cache.", "cache ", "cache:stream"]) {
      lifecycleError(
        () =>
          managed.legacyAudit({
            slug: "legacy-derived",
            generatedRoots: [unsafe]
          }),
        "invalid-legacy-generated-path"
      );
    }
    lifecycleError(
      () =>
        managed.legacyAudit({
          slug: "legacy-derived",
          generatedRoots: ["Node_Modules"],
          generatedFiles: ["node_modules/example/index.js"]
        }),
      "invalid-legacy-generated-path"
    );
    lifecycleError(
      () =>
        managed.legacyAudit({
          slug: "legacy-derived",
          generatedRoots: ["node_modules", "node_modules/example"],
          generatedFiles: ["fixture.ignored"]
        }),
      "invalid-legacy-generated-path"
    );
    const unbootstrapped = manager(fixture);
    create(fixture, "manager-initializer", { manager: unbootstrapped });
    lifecycleError(
      () =>
        unbootstrapped.legacyAudit({
          slug: "legacy-derived",
          generatedRoots: ["node_modules"],
          generatedFiles: ["fixture.ignored"]
        }),
      "legacy-bootstrap-required"
    );
  });
});

test("ordinary repositories ignore unrelated receipt files beside their Git directory", () => {
  withRepository((fixture) => {
    writeFileSync(join(fixture.repository, "receipt.json"), "not manager metadata\n");
    const checkout = create(fixture, "legacy-route", { manager: defaultManager(fixture) });
    assert.equal(
      checkout.checkoutPath,
      join(fixture.repository, "tmp", "agent-checkouts", "checkouts", "legacy-route")
    );
  });
});

test("legacy alternate-backed managers remain discoverable from their own child worktrees", () => {
  withRepository((fixture) => {
    const legacy = join(fixture.root, "legacy-shared");
    git(fixture.root, "clone", "-q", "--shared", fixture.repository, legacy);
    const legacyManager = createCheckoutManager({ repositoryPath: legacy });
    const checkout = legacyManager.create({
      slug: "legacy-shared",
      branch: "agent/legacy-shared",
      ownerTask: "/root/legacy-shared"
    });
    const fromChild = createCheckoutManager({ repositoryPath: checkout.checkoutPath });
    assert.equal(fromChild.paths.root, legacyManager.paths.root);
    assert.equal(fromChild.status("legacy-shared")[0].state, "active");
    assert.equal(existsSync(join(legacy, ".git", "objects", "info", "alternates")), true);
  });
});

test("routed bare-manager commands ignore inherited Git object and configuration redirects", () => {
  withRepository((fixture) => {
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "9".repeat(32)
    });
    const other = join(fixture.root, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    const hostileConfig = join(fixture.root, "hostile.gitconfig");
    writeFileSync(hostileConfig, "[core]\n\thooksPath = /not-used\n");
    const hostile = {
      GIT_DIR: join(other, ".git"),
      GIT_OBJECT_DIRECTORY: join(fixture.root, "missing-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, ".git", "objects"),
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_REPLACE_REF_BASE: "refs/replace-hostile/"
    };
    const previous = Object.fromEntries(Object.keys(hostile).map((name) => [name, process.env[name]]));
    Object.assign(process.env, hostile);
    try {
      const managed = defaultManager(fixture);
      const checkout = create(fixture, "hostile-git-env", { manager: managed });
      assert.equal(defaultManager(fixture).status("hostile-git-env")[0].state, "active");
      assert.equal(createCheckoutManager({ repositoryPath: checkout.checkoutPath }).paths.root, published.statePath);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

test("an interrupted bootstrap is retained, blocks lifecycle routing, and permits a new numbered attempt", () => {
  withRepository((fixture) => {
    assert.throws(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "2".repeat(32),
          hooks: { afterBootstrapClone: () => assert.fail("simulated shutdown") }
        }),
      /simulated shutdown/u
    );
    lifecycleError(() => defaultManager(fixture).status(), "manager-bootstrap-incomplete");
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "3".repeat(32)
    });
    const attempts = readdirSync(dirname(published.receiptPath)).sort();
    assert.deepEqual(attempts, [
      `00000001-${"2".repeat(32)}`,
      `00000002-${"3".repeat(32)}`,
      "current.json",
      "slot-00000001",
      "slot-00000002"
    ]);
    assert.equal(defaultManager(fixture).paths.root, published.statePath);
  });
});

test("concurrent bootstrap attempts retain the loser and leave one usable published manager", () => {
  withRepository((fixture) => {
    let winner;
    lifecycleError(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "a".repeat(32),
          hooks: {
            afterBootstrapAttemptsRead() {
              winner = bootstrapCheckoutManager({
                repositoryPath: fixture.repository,
                tokenFactory: () => "b".repeat(32)
              });
            }
          }
        }),
      "manager-bootstrap-changed"
    );

    assert.equal(defaultManager(fixture).paths.root, winner.statePath);
    const checkout = create(fixture, "concurrent-winner", { manager: defaultManager(fixture) });
    assert.equal(git(checkout.checkoutPath, "rev-parse", "HEAD"), git(fixture.repository, "rev-parse", "HEAD"));
    assert.equal(defaultManager(fixture).status("concurrent-winner")[0].state, "active");
    assert.deepEqual(readdirSync(dirname(winner.receiptPath)).sort(), [
      `00000001-${"b".repeat(32)}`,
      `00000002-${"a".repeat(32)}`,
      "current.json",
      "slot-00000001",
      "slot-00000002"
    ]);
  });
});

test("the eighth bootstrap slot is claimed atomically under a concurrent start", () => {
  withRepository((fixture) => {
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      assert.throws(
        () =>
          bootstrapCheckoutManager({
            repositoryPath: fixture.repository,
            tokenFactory: () => attempt.toString(16).repeat(32),
            hooks: { afterBootstrapClone: () => assert.fail(`retain attempt ${attempt}`) }
          }),
        new RegExp(`retain attempt ${attempt}`, "u")
      );
    }

    let winner;
    lifecycleError(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "a".repeat(32),
          hooks: {
            afterBootstrapAttemptsRead() {
              winner = bootstrapCheckoutManager({
                repositoryPath: fixture.repository,
                tokenFactory: () => "b".repeat(32)
              });
            }
          }
        }),
      "manager-bootstrap-attempts-exhausted"
    );

    assert.equal(defaultManager(fixture).paths.root, winner.statePath);
    const journal = readdirSync(dirname(winner.receiptPath));
    assert.equal(journal.filter((name) => /^slot-/u.test(name)).length, 8);
    assert.equal(journal.filter((name) => /^[0-9]{8}-/u.test(name)).length, 8);
    assert.equal(journal.length, 17);
    const checkout = create(fixture, "eighth-slot-winner", { manager: defaultManager(fixture) });
    assert.equal(defaultManager(fixture).status("eighth-slot-winner")[0].state, "active");
    assert.equal(git(checkout.checkoutPath, "rev-parse", "HEAD"), git(fixture.repository, "rev-parse", "HEAD"));
  });
});

test("atomic receipt publication never replaces a raced destination", () => {
  withRepository((fixture) => {
    let planted;
    lifecycleError(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "4".repeat(32),
          hooks: {
            beforeBootstrapPublish({ attemptPath }) {
              planted = join(dirname(attemptPath), "current.json");
              writeFileSync(planted, "", { flag: "wx", mode: 0o600 });
            }
          }
        }),
      "manager-bootstrap-changed"
    );
    assert.equal(readFileSync(planted, "utf8"), "");
    assert.equal(existsSync(join(dirname(planted), `00000001-${"4".repeat(32)}`, "receipt.json")), true);
  });
});

test("bootstrap rejects credential-bearing remotes without echoing the credential", () => {
  withRepository((fixture) => {
    git(fixture.repository, "remote", "set-url", "origin", "https://user:secret@example.invalid/repository.git");
    assert.throws(
      () => bootstrapCheckoutManager({ repositoryPath: fixture.repository }),
      (error) =>
        error instanceof CheckoutLifecycleError &&
        error.code === "unsafe-manager-remote" &&
        !error.message.includes("secret")
    );
  });
});

for (const corruption of ["alternates", "shallow", "partial", "promisor", "hardlink", "symlink"]) {
  test(`bootstrap rejects ${corruption} manager state before publication`, () => {
    withRepository((fixture) => {
      lifecycleError(
        () =>
          bootstrapCheckoutManager({
            repositoryPath: fixture.repository,
            tokenFactory: () => "5".repeat(32),
            hooks: {
              afterBootstrapClone({ repositoryPath, source }) {
                if (corruption === "alternates") {
                  writeFileSync(
                    join(repositoryPath, "objects", "info", "alternates"),
                    `${join(source.commonGitDirectory, "objects")}\n`
                  );
                } else if (corruption === "shallow") {
                  writeFileSync(join(repositoryPath, "shallow"), `${git(source.topLevel, "rev-parse", "HEAD")}\n`);
                } else if (corruption === "partial") {
                  git(repositoryPath, "config", "extensions.partialClone", "origin");
                } else if (corruption === "promisor") {
                  writeFileSync(join(repositoryPath, "objects", "pack", "fixture.promisor"), "promisor\n");
                } else if (corruption === "hardlink") {
                  linkSync(join(source.topLevel, "README.md"), join(repositoryPath, "objects", "hardlinked-object"));
                } else {
                  symlinkSync(join(source.topLevel, "README.md"), join(repositoryPath, "objects", "linked-object"));
                }
              }
            }
          }),
        "unsafe-manager-bootstrap"
      );
      const attempts = join(fixture.repository, "tmp", "agent-checkouts", "manager", "attempts");
      assert.equal(existsSync(join(attempts, "current.json")), false);
    });
  });
}

test("bootstrap reruns strict fsck after the final pre-publication hook", () => {
  withRepository((fixture) => {
    lifecycleError(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "8".repeat(32),
          hooks: {
            beforeBootstrapPublish({ repositoryPath }) {
              const pack = readdirSync(join(repositoryPath, "objects", "pack")).find((name) => name.endsWith(".pack"));
              assert.notEqual(pack, undefined);
              writeFileSync(join(repositoryPath, "objects", "pack", pack), "corrupt pack\n");
            }
          }
        }),
      "manager-bootstrap-command-failed"
    );
    assert.equal(
      existsSync(join(fixture.repository, "tmp", "agent-checkouts", "manager", "attempts", "current.json")),
      false
    );
  });
});

test("bootstrap rejects source-ref drift and routed managers reject remote and state identity drift", () => {
  withRepository((fixture) => {
    lifecycleError(
      () =>
        bootstrapCheckoutManager({
          repositoryPath: fixture.repository,
          tokenFactory: () => "6".repeat(32),
          hooks: {
            beforeBootstrapPublish() {
              writeFileSync(join(fixture.repository, "README.md"), "new source commit\n");
              git(fixture.repository, "add", "README.md");
              git(fixture.repository, "commit", "-q", "-m", "Move source during bootstrap");
            }
          }
        }),
      "manager-bootstrap-drift"
    );
  });

  withRepository((fixture) => {
    const published = bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "7".repeat(32)
    });
    git(published.repositoryPath, "config", "remote.origin.url", "https://example.invalid/drift.git");
    lifecycleError(() => defaultManager(fixture).status(), "manager-bootstrap-drift");
    git(published.repositoryPath, "config", "remote.origin.url", fixture.remote);
    git(fixture.repository, "remote", "set-url", "origin", "https://example.invalid/source-drift.git");
    lifecycleError(() => defaultManager(fixture).status(), "manager-bootstrap-drift");
    git(fixture.repository, "remote", "set-url", "origin", fixture.remote);
    const retained = `${published.statePath}.retained`;
    renameSync(published.statePath, retained);
    mkdirSync(published.statePath, { mode: 0o700 });
    lifecycleError(() => defaultManager(fixture).status(), "manager-bootstrap-drift");
    assert.equal(existsSync(join(retained, "entries")), true);
  });
});

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

function fileReceipt(path) {
  const bytes = readFileSync(path);
  const metadata = lstatSync(path, { bigint: true });
  return {
    path,
    identity: { device: metadata.dev.toString(), inode: metadata.ino.toString() },
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function archiveForQuarantine(fixture, slug, options = {}) {
  const managed = options.manager ?? manager(fixture, { run: fixtureRun() });
  const checkout = create(fixture, slug, { manager: managed });
  managed.finish({ slug, ownerTask: `/root/${slug}`, expectedRevision: 1 });
  const cleanup = entry(fixture, slug);
  managed.planRetirement({
    slug,
    ownerTask: `/root/${slug}`,
    expectedRevision: 1,
    expectedGeneration: cleanup.generation
  });
  const archived = managed.archiveRetirement({
    slug,
    ownerTask: `/root/${slug}`,
    expectedRevision: 1,
    expectedGeneration: cleanup.generation
  });
  const attemptPath = dirname(archived.archivePath);
  const completionPath = join(attemptPath, "complete.json");
  const completion = JSON.parse(readFileSync(completionPath, "utf8"));
  return {
    managed,
    checkout,
    cleanup,
    attemptPath,
    anchor: {
      attempt: archived.attempt,
      directory: completion.directory,
      completion: fileReceipt(completionPath),
      receipt: completion.receipt,
      bundle: completion.bundle
    }
  };
}

function createQuarantineJournal(fixture, archived, operationId = "1".repeat(32)) {
  mkdirSync(archived.managed.paths.quarantines, { mode: 0o700 });
  const journalPath = join(
    archived.managed.paths.quarantines,
    `${archived.cleanup.slug}.${archived.cleanup.generation}`
  );
  mkdirSync(journalPath, { mode: 0o700 });
  return {
    journalPath,
    operationId,
    originalPath: archived.checkout.checkoutPath,
    quarantinePath: join(
      archived.managed.paths.quarantinedCheckouts,
      `${archived.cleanup.slug}.${archived.cleanup.generation}.${operationId}`
    )
  };
}

function createEmptyQuarantineHistory(managed, slug, generation) {
  mkdirSync(managed.paths.quarantines, { mode: 0o700 });
  const path = join(managed.paths.quarantines, `${slug}.${generation}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function appendQuarantineRecord(archived, journal, kind, observation = undefined, operationId = journal.operationId) {
  const names = readdirSync(journal.journalPath).sort();
  const sequence = names.length + 1;
  let previous = null;
  if (names.length > 0) {
    const priorPath = join(journal.journalPath, names.at(-1));
    const prior = JSON.parse(readFileSync(priorPath, "utf8"));
    previous = {
      sequence: prior.sequence,
      kind: prior.kind,
      operationId: prior.operationId,
      ...fileReceipt(priorPath)
    };
  }
  const value = {
    protocol: "openwrangler-checkout-quarantine-event-v1",
    kind,
    slug: archived.cleanup.slug,
    entryGeneration: archived.cleanup.generation,
    sequence,
    operationId,
    previous,
    anchor: archived.anchor,
    originalPath: journal.originalPath,
    quarantinePath: journal.quarantinePath,
    deferredChecks: {
      recovery: "completed-archive-revalidated",
      processUse: "not-checked-recheck-required",
      mounts: "not-checked-recheck-required"
    },
    authorizesCleanup: false,
    ...(observation === undefined ? {} : { observation, classification: classifyQuarantineObservation(observation) })
  };
  const path = join(journal.journalPath, `${String(sequence).padStart(8, "0")}.${kind}.${operationId}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  return { path, value };
}

function quarantineObservation(direction, root, links = {}) {
  return {
    direction,
    original: { present: root === "original", identityMatches: root === "original" },
    quarantine: { present: root === "quarantine", identityMatches: root === "quarantine" },
    worktreeRegistry: links.worktreeRegistry ?? root,
    checkoutGitFile: links.checkoutGitFile ?? root,
    adminBacklink: links.adminBacklink ?? root,
    repositoryStateMatches: links.repositoryStateMatches ?? true
  };
}

test("quarantine observation classification is direction-aware and fails closed", () => {
  for (const [direction, root, state, location] of [
    ["quarantine", "original", "pre", "original-coherent"],
    ["quarantine", "quarantine", "post", "quarantine-coherent"],
    ["restore", "quarantine", "pre", "quarantine-coherent"],
    ["restore", "original", "post", "original-coherent"]
  ]) {
    assert.deepEqual(classifyQuarantineObservation(quarantineObservation(direction, root)), {
      state,
      location,
      reason: "coherent",
      authorizesCleanup: false
    });
  }
  assert.equal(
    classifyQuarantineObservation(
      quarantineObservation("quarantine", "quarantine", {
        worktreeRegistry: "original",
        checkoutGitFile: "quarantine",
        adminBacklink: "original"
      })
    ).state,
    "partial"
  );
  assert.equal(
    classifyQuarantineObservation(
      quarantineObservation("restore", "original", {
        worktreeRegistry: "missing",
        checkoutGitFile: "original",
        adminBacklink: "quarantine"
      })
    ).reason,
    "restore-backlinks-incomplete"
  );
  for (const observation of [
    {
      ...quarantineObservation("quarantine", "original"),
      original: { present: true, identityMatches: true },
      quarantine: { present: true, identityMatches: true }
    },
    {
      ...quarantineObservation("quarantine", "original"),
      original: { present: false, identityMatches: false }
    },
    {
      ...quarantineObservation("quarantine", "original"),
      original: { present: true, identityMatches: false }
    },
    quarantineObservation("quarantine", "original", { repositoryStateMatches: false }),
    quarantineObservation("quarantine", "original", {
      worktreeRegistry: "other",
      checkoutGitFile: "other",
      adminBacklink: "other"
    }),
    quarantineObservation("quarantine", "original", {
      worktreeRegistry: "missing",
      checkoutGitFile: "missing",
      adminBacklink: "missing"
    }),
    quarantineObservation("quarantine", "original", { checkoutGitFile: "quarantine" })
  ]) {
    assert.equal(classifyQuarantineObservation(observation).state, "indeterminate");
  }
  lifecycleError(
    () => classifyQuarantineObservation({ ...quarantineObservation("quarantine", "original"), extra: true }),
    "invalid-quarantine-observation"
  );
  lifecycleError(
    () =>
      classifyQuarantineObservation({
        ...quarantineObservation("quarantine", "original"),
        original: { present: false, identityMatches: true }
      }),
    "invalid-quarantine-observation"
  );
});

test("quarantine journal status is read-only and every lifecycle mutation blocks", () => {
  withRepository((fixture) => {
    const archived = archiveForQuarantine(fixture, "quarantine-guard");
    const journal = createQuarantineJournal(fixture, archived);
    appendQuarantineRecord(archived, journal, "quarantine-intent");
    const entryCount = entryHistory(fixture, "quarantine-guard").length;
    const checkoutBytes = readFileSync(join(archived.checkout.checkoutPath, "README.md"));
    const status = archived.managed.quarantineStatus("quarantine-guard")[0];
    assert.equal(status.quarantine.state, "intent-pending");
    assert.equal(status.quarantine.authorizesCleanup, false);
    assert.equal(status.quarantine.archive.bundle.sha256, archived.anchor.bundle.sha256);
    assert.equal(archived.managed.status("quarantine-guard")[0].quarantine.state, "intent-pending");
    assert.equal(archived.managed.audit("quarantine-guard").quarantine.state, "intent-pending");

    const mutations = [
      () =>
        archived.managed.handoff({
          slug: "quarantine-guard",
          ownerTask: "/root/quarantine-guard",
          nextOwnerTask: "/root/next",
          expectedRevision: 1
        }),
      () =>
        archived.managed.finish({
          slug: "quarantine-guard",
          ownerTask: "/root/quarantine-guard",
          expectedRevision: 1
        }),
      () =>
        archived.managed.planRetirement({
          slug: "quarantine-guard",
          ownerTask: "/root/quarantine-guard",
          expectedRevision: 1,
          expectedGeneration: archived.cleanup.generation
        }),
      () =>
        archived.managed.archiveRetirement({
          slug: "quarantine-guard",
          ownerTask: "/root/quarantine-guard",
          expectedRevision: 1,
          expectedGeneration: archived.cleanup.generation
        }),
      () =>
        archived.managed.abandon({
          slug: "quarantine-guard",
          expectedOwnerTask: "/root/quarantine-guard",
          expectedHead: archived.cleanup.checkout.head,
          expectedRevision: 1
        }),
      () =>
        archived.managed.create({
          slug: "quarantine-guard",
          ownerTask: "/root/recreate",
          branch: "agent/recreate"
        })
    ];
    for (const mutation of mutations) lifecycleError(mutation, "quarantine-overlay-active");
    assert.equal(entryHistory(fixture, "quarantine-guard").length, entryCount);
    assert.deepEqual(readFileSync(join(archived.checkout.checkoutPath, "README.md")), checkoutBytes);
  });
});

test("historical quarantine journals block every lifecycle mutation for the slug", () => {
  withRepository((fixture) => {
    const managed = manager(fixture);
    const checkout = create(fixture, "historical-guard", { manager: managed });
    const current = entry(fixture, "historical-guard");
    assert(current.generation > 1);
    createEmptyQuarantineHistory(managed, "historical-guard", current.generation - 1);
    const beforeEntries = registryBytes(fixture);
    const checkoutBytes = readFileSync(join(checkout.checkoutPath, "README.md"));
    const mutations = [
      () =>
        managed.handoff({
          slug: "historical-guard",
          ownerTask: "/root/historical-guard",
          nextOwnerTask: "/root/next",
          expectedRevision: 1
        }),
      () => managed.finish({ slug: "historical-guard", ownerTask: "/root/historical-guard", expectedRevision: 1 }),
      () =>
        managed.planRetirement({
          slug: "historical-guard",
          ownerTask: "/root/historical-guard",
          expectedRevision: 1,
          expectedGeneration: current.generation
        }),
      () =>
        managed.archiveRetirement({
          slug: "historical-guard",
          ownerTask: "/root/historical-guard",
          expectedRevision: 1,
          expectedGeneration: current.generation
        }),
      () =>
        managed.abandon({
          slug: "historical-guard",
          expectedOwnerTask: "/root/historical-guard",
          expectedHead: current.checkout.head,
          expectedRevision: 1
        }),
      () => managed.create({ slug: "historical-guard", ownerTask: "/root/recreate", branch: "agent/recreate" })
    ];
    for (const mutation of mutations) lifecycleError(mutation, "quarantine-overlay-active");
    assert.deepEqual(registryBytes(fixture), beforeEntries);
    assert.deepEqual(readFileSync(join(checkout.checkoutPath, "README.md")), checkoutBytes);
  });
});

test("status cannot reconcile a creating entry that has quarantine history", () => {
  withRepository((fixture) => {
    const interrupted = manager(fixture, { hooks: { afterGitBeforeActive: () => assert.fail("shutdown") } });
    assert.throws(
      () =>
        interrupted.create({
          slug: "creating-quarantine",
          branch: "agent/creating-quarantine",
          ownerTask: "/root/creating-quarantine"
        }),
      /shutdown/u
    );
    const beforeEntries = registryBytes(fixture);
    const beforeLength = entryHistory(fixture, "creating-quarantine").length;
    createEmptyQuarantineHistory(interrupted, "creating-quarantine", 1);
    lifecycleError(() => manager(fixture).status("creating-quarantine"), "quarantine-overlay-active");
    assert.deepEqual(registryBytes(fixture), beforeEntries);
    assert.equal(entryHistory(fixture, "creating-quarantine").length, beforeLength);
    assert.equal(entry(fixture, "creating-quarantine").state, "creating");
  });
});

test("quarantine journal enforces its hash chain, transitions, and archive anchor", () => {
  withRepository((fixture) => {
    const archived = archiveForQuarantine(fixture, "quarantine-chain");
    const journal = createQuarantineJournal(fixture, archived);
    const intent = appendQuarantineRecord(archived, journal, "quarantine-intent");
    appendQuarantineRecord(archived, journal, "quarantine-result", quarantineObservation("quarantine", "quarantine"));
    assert.equal(archived.managed.quarantineStatus("quarantine-chain")[0].quarantine.state, "quarantined");
    const restoreId = "2".repeat(32);
    appendQuarantineRecord(archived, journal, "restore-intent", undefined, restoreId);
    assert.equal(archived.managed.quarantineStatus("quarantine-chain")[0].quarantine.state, "intent-pending");
    appendQuarantineRecord(
      archived,
      journal,
      "restore-result",
      quarantineObservation("restore", "original"),
      restoreId
    );
    assert.equal(archived.managed.quarantineStatus("quarantine-chain")[0].quarantine.state, "original");
    writeFileSync(intent.path, `${JSON.stringify(intent.value)} \n`);
    lifecycleError(() => archived.managed.quarantineStatus("quarantine-chain"), "invalid-quarantine-journal");
  });

  withRepository((fixture) => {
    const archived = archiveForQuarantine(fixture, "quarantine-race");
    const journal = createQuarantineJournal(fixture, archived);
    const intent = appendQuarantineRecord(archived, journal, "quarantine-intent");
    let mutate = true;
    const racing = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        afterQuarantineRecordsRead() {
          if (!mutate) return;
          mutate = false;
          writeFileSync(intent.path, `${JSON.stringify(intent.value)} \n`);
        }
      }
    });
    lifecycleError(() => racing.quarantineStatus("quarantine-race"), "registry-changed");
  });

  withRepository((fixture) => {
    const archived = archiveForQuarantine(fixture, "quarantine-anchor");
    const journal = createQuarantineJournal(fixture, archived);
    appendQuarantineRecord(archived, journal, "quarantine-intent");
    const completionPath = archived.anchor.completion.path;
    const completion = JSON.parse(readFileSync(completionPath, "utf8"));
    completion.authorizesCleanup = true;
    writeFileSync(completionPath, `${JSON.stringify(completion)}\n`);
    lifecycleError(() => archived.managed.quarantineStatus("quarantine-anchor"), "invalid-archive");
  });
});

test("quarantine status revalidates its archive anchor after reading the journal", () => {
  withRepository((fixture) => {
    const archived = archiveForQuarantine(fixture, "quarantine-anchor-race");
    const journal = createQuarantineJournal(fixture, archived);
    appendQuarantineRecord(archived, journal, "quarantine-intent");
    const completionPath = archived.anchor.completion.path;
    let mutate = true;
    const racing = manager(fixture, {
      run: fixtureRun(),
      hooks: {
        afterQuarantineRecordsRead() {
          if (!mutate) return;
          mutate = false;
          const completion = JSON.parse(readFileSync(completionPath, "utf8"));
          completion.authorizesCleanup = true;
          writeFileSync(completionPath, `${JSON.stringify(completion)}\n`);
        }
      }
    });
    lifecycleError(() => racing.quarantineStatus("quarantine-anchor-race"), "invalid-archive");
  });
});

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
      const message = `root-${index}`;
      input += `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(message, "utf8")}\n${message}\n`;
    }
    input += "done\n";
    const marksPath = join(fixture.root, "many-root.marks");
    const imported = spawnSync("git", ["fast-import", "--quiet", `--export-marks=${marksPath}`], {
      cwd: fixture.repository,
      encoding: "utf8",
      input,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(imported.status, 0, imported.stderr);
    const objectIds = readFileSync(marksPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const match = /^:([1-9][0-9]*) ([0-9a-f]+)$/u.exec(line);
        assert.ok(match, `Malformed fast-import mark: ${line}`);
        return { mark: Number(match[1]), oid: match[2] };
      })
      .sort((left, right) => left.mark - right.mark);
    assert.equal(objectIds.length, 4100);
    const refsInput = objectIds
      .map(({ oid }, index) => `create refs/recovery/many/${String(index).padStart(4, "0")} ${oid}\n`)
      .join("");
    const refs = spawnSync("git", ["update-ref", "--stdin"], {
      cwd: fixture.repository,
      encoding: "utf8",
      input: refsInput,
      maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(refs.status, 0, refs.stderr);

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

test("the real CLI audits, adopts, and reports one legacy checkout without moving it", () => {
  withRepository((fixture) => {
    bootstrapCheckoutManager({
      repositoryPath: fixture.repository,
      tokenFactory: () => "8".repeat(32)
    });
    const checkout = legacyCandidate(fixture, "legacy-cli");
    const commonArgs = ["legacy-cli", "--generated-root", "node_modules", "--generated-file", "fixture.ignored"];
    const audit = spawnSync(process.execPath, [SCRIPT, "legacy-audit", ...commonArgs], {
      cwd: fixture.repository,
      encoding: "utf8"
    });
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).source.checkout, checkout);
    const adopt = spawnSync(process.execPath, [SCRIPT, "legacy-adopt", ...commonArgs, "--owner", "/root/legacy-cli"], {
      cwd: fixture.repository,
      encoding: "utf8"
    });
    assert.equal(adopt.status, 0, adopt.stderr);
    assert.equal(JSON.parse(adopt.stdout).status, "adopted-review-required");
    const archive = spawnSync(
      process.execPath,
      [SCRIPT, "legacy-archive", "legacy-cli", "--owner", "/root/legacy-cli"],
      { cwd: fixture.repository, encoding: "utf8" }
    );
    assert.equal(archive.status, 0, archive.stderr);
    const archived = JSON.parse(archive.stdout);
    assert.equal(archived.status, "archived-review-required");
    assert.equal(archived.authorizesMove, false);
    assert.equal(archived.authorizesCleanup, false);
    assert.equal(existsSync(join(archived.recoveryPath, "objects", "pack")), true);
    const status = spawnSync(process.execPath, [SCRIPT, "legacy-status", "legacy-cli"], {
      cwd: fixture.repository,
      encoding: "utf8"
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout)[0].state, "adopted-review-required");
    assert.equal(JSON.parse(status.stdout)[0].archive.state, "archived-review-required");
    for (const args of [
      ["legacy-status", "legacy-cli", "extra"],
      ["legacy-status", "legacy-cli", "--owner", "/root/irrelevant"],
      ["legacy-audit", "legacy-cli", "--revision", "1"],
      ["bootstrap", "unexpected"]
    ]) {
      const invalid = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: fixture.repository,
        encoding: "utf8"
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /^invalid-cli:/u);
      assert.equal(invalid.stdout, "");
    }
    assert.equal(existsSync(checkout), true);
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
