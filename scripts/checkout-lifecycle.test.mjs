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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CheckoutLifecycleError, createCheckoutManager } from "./checkout-lifecycle.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "checkout-lifecycle.mjs");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
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

test("the real CLI audits and marks cleanup pending from inside its checkout without deleting it", () => {
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
