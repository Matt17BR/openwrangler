import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pushStableReleaseTag } from "./push-stable-release-tag.mjs";

const repositoryName = "Matt17BR/openwrangler";
const releaseTag = "v1.2.3";
const token = "github_pat_release_test";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    windowsHide: true
  }).trim();
}

function createRepository(context) {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-push-tag-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "release-test@openwrangler.invalid"]);
  git(root, ["config", "user.name", "Open Wrangler Release Test"]);
  writeFileSync(join(root, "package.json"), '{"name":"openwrangler","version":"1.2.3"}\n', "utf8");
  writeFileSync(join(root, "tracked.txt"), "release\n", "utf8");
  git(root, ["add", "package.json", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "release"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", head]);
  return { head, root };
}

function successfulResult(stdout = "", stderr = "") {
  return { error: undefined, signal: null, status: 0, stderr, stdout };
}

function systemGitRunner(options) {
  return spawnSync("git", options.args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    windowsHide: true
  });
}

function createRunner({ expectedCommit, initialRemote = "", postPushRemote } = {}) {
  const calls = [];
  const credentialPaths = [];
  let pushed = false;
  const runner = (options) => {
    calls.push({
      args: [...options.args],
      env: { ...options.env }
    });
    if (options.args[0] === "ls-remote") {
      return successfulResult(
        pushed ? (postPushRemote ?? `${expectedCommit}\trefs/tags/${releaseTag}\n`) : initialRemote
      );
    }
    if (options.args.includes("push")) {
      const helper = options.args.find((argument) => argument.startsWith("credential.helper=store --file="));
      assert.ok(helper);
      const credentialPath = helper.slice("credential.helper=store --file=".length);
      credentialPaths.push(credentialPath);
      const credentialDescriptor = openSync(credentialPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const beforeRead = fstatSync(credentialDescriptor);
        assert.equal(beforeRead.isFile(), true);
        assert.equal(beforeRead.nlink, 1);
        if (process.platform !== "win32") {
          assert.equal(beforeRead.mode & 0o777, 0o600);
        }
        assert.equal(
          readFileSync(credentialDescriptor, "utf8"),
          `https://x-access-token:${encodeURIComponent(token)}@github.com\n`
        );
        const afterRead = fstatSync(credentialDescriptor);
        assert.equal(afterRead.dev, beforeRead.dev);
        assert.equal(afterRead.ino, beforeRead.ino);
        assert.equal(afterRead.size, beforeRead.size);
      } finally {
        closeSync(credentialDescriptor);
      }
      assert.equal(
        options.args.some((argument) => argument.includes(token)),
        false
      );
      assert.equal(
        Object.values(options.env).some((value) => value === token),
        false
      );
      assert.deepEqual(options.args, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        helper,
        "push",
        "--atomic",
        "--porcelain",
        "https://github.com/Matt17BR/openwrangler.git",
        `${expectedCommit}:refs/tags/${releaseTag}`
      ]);
      pushed = true;
      return successfulResult("To https://github.com/Matt17BR/openwrangler.git\n");
    }
    return systemGitRunner(options);
  };
  return { calls, credentialPaths, runner };
}

function publish(repository, runner, overrides = {}) {
  return pushStableReleaseTag({
    expectedCommit: repository.head,
    gitRunner: runner,
    releaseTag,
    repository: repositoryName,
    root: repository.root,
    token,
    ...overrides
  });
}

test("atomically pushes one exact lightweight tag without exposing the token and cleans its credential", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({ expectedCommit: repository.head });
  const result = publish(repository, fake.runner);
  assert.deepEqual(result, {
    created: true,
    releaseTag,
    sourceCommit: repository.head
  });
  const pushCalls = fake.calls.filter((call) => call.args.includes("push"));
  assert.equal(pushCalls.length, 1);
  assert.equal(
    pushCalls[0].args.some((argument) => /(?:--force|--delete|\*)/u.test(argument)),
    false
  );
  assert.equal(fake.credentialPaths.length, 1);
  assert.equal(existsSync(fake.credentialPaths[0]), false);
  assert.equal(fake.calls.filter((call) => call.args[0] === "ls-remote").length, 2);
});

test("accepts an exact existing lightweight tag idempotently without opening a credential", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({
    expectedCommit: repository.head,
    initialRemote: `${repository.head}\trefs/tags/${releaseTag}\n`
  });
  assert.deepEqual(publish(repository, fake.runner), {
    created: false,
    releaseTag,
    sourceCommit: repository.head
  });
  assert.equal(
    fake.calls.some((call) => call.args.includes("push")),
    false
  );
  assert.deepEqual(fake.credentialPaths, []);
});

test("rejects conflicting, annotated, ambiguous, and unverifiable remote tags without pushing", (context) => {
  const repository = createRepository(context);
  const cases = [
    `${"b".repeat(40)}\trefs/tags/${releaseTag}\n`,
    `${"b".repeat(40)}\trefs/tags/${releaseTag}\n${repository.head}\trefs/tags/${releaseTag}^{}\n`,
    `${repository.head}\trefs/tags/${releaseTag}\n${repository.head}\trefs/tags/${releaseTag}\n`,
    `${repository.head}\trefs/tags/v9.9.9\n`
  ];
  for (const initialRemote of cases) {
    const fake = createRunner({ expectedCommit: repository.head, initialRemote });
    assert.throws(() => publish(repository, fake.runner), /remote RELEASE_TAG|annotated tag|unexpected reference/u);
    assert.equal(
      fake.calls.some((call) => call.args.includes("push")),
      false
    );
  }
});

test("fails closed when the post-push public tag is absent or conflicting and still cleans credentials", (context) => {
  const repository = createRepository(context);
  for (const postPushRemote of ["", `${"c".repeat(40)}\trefs/tags/${releaseTag}\n`]) {
    const fake = createRunner({ expectedCommit: repository.head, postPushRemote });
    assert.throws(() => publish(repository, fake.runner), /not visible|does not resolve exactly/u);
    assert.equal(fake.calls.filter((call) => call.args.includes("push")).length, 1);
    assert.equal(fake.credentialPaths.length, 1);
    assert.equal(existsSync(fake.credentialPaths[0]), false);
  }
});

test("scrubs and removes the private credential after a failed Git push", (context) => {
  const repository = createRepository(context);
  let credentialPath;
  const runner = (options) => {
    if (options.args[0] === "ls-remote") return successfulResult();
    if (options.args.includes("push")) {
      const helper = options.args.find((argument) => argument.startsWith("credential.helper=store --file="));
      credentialPath = helper.slice("credential.helper=store --file=".length);
      return { error: undefined, signal: null, status: 1, stderr: "rejected\n", stdout: "" };
    }
    return systemGitRunner(options);
  };
  assert.throws(() => publish(repository, runner), /atomically push/u);
  assert.equal(existsSync(credentialPath), false);
});

test("requires exact repository, version, source, origin/main, token, and clean tracked state", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({ expectedCommit: repository.head });

  assert.throws(() => publish(repository, fake.runner, { repository: "someone/openwrangler" }), /restricted/u);
  assert.throws(() => publish(repository, fake.runner, { releaseTag: "v1.2.4" }), /package\.json version/u);
  assert.throws(() => publish(repository, fake.runner, { expectedCommit: "a".repeat(40) }), /run at EXPECTED_SHA/u);
  assert.throws(() => publish(repository, fake.runner, { token: "line\nbreak" }), /printable-ASCII/u);

  const otherCommit = git(repository.root, [
    "commit-tree",
    `${repository.head}^{tree}`,
    "-p",
    repository.head,
    "-m",
    "other"
  ]);
  git(repository.root, ["update-ref", "refs/remotes/origin/main", otherCommit]);
  assert.throws(() => publish(repository, fake.runner), /checked-out origin\/main/u);
  git(repository.root, ["update-ref", "refs/remotes/origin/main", repository.head]);

  writeFileSync(join(repository.root, "tracked.txt"), "dirty\n", "utf8");
  assert.throws(() => publish(repository, fake.runner), /clean tracked worktree/u);
});

test("strictly rejects duplicate or non-stable package versions before remote access", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({ expectedCommit: repository.head });
  writeFileSync(
    join(repository.root, "package.json"),
    '{"name":"openwrangler","version":"1.2.3","version":"1.2.3"}\n',
    "utf8"
  );
  assert.throws(() => publish(repository, fake.runner), /duplicate keys/u);
  assert.equal(
    fake.calls.some((call) => call.args[0] === "ls-remote"),
    false
  );
});
