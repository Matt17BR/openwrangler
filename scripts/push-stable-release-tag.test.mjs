import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pushStableReleaseTag } from "./push-stable-release-tag.mjs";
import { pushExactReleaseTag } from "./release-tag-publisher.mjs";

const repositoryName = "Matt17BR/openwrangler";
const releaseTag = "v1.2.3";
const token = "github_pat_release_test";

function encodeCredentialToken(value) {
  return [...value]
    .map((character) =>
      /[A-Za-z0-9._~-]/u.test(character) ? character : `%${character.codePointAt(0).toString(16).padStart(2, "0")}`
    )
    .join("");
}

function decodeQuotedHelperPath(helper) {
  const prefix = "credential.helper=store --file=";
  assert.equal(helper.startsWith(prefix), true);
  const quoted = helper.slice(prefix.length);
  assert.equal(quoted.startsWith("'"), true);
  assert.equal(quoted.endsWith("'"), true);
  return quoted.slice(1, -1).replaceAll("'\\''", "'");
}

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

function createRunner({
  expectedCommit,
  expectedReleaseTag = releaseTag,
  expectedToken = token,
  eraseCredential = false,
  initialRemote = "",
  mutateCredentialPath,
  postPushRemote,
  pushResult,
  rewriteCredentialWith
} = {}) {
  const calls = [];
  const credentialPaths = [];
  const credentialRewrites = [];
  let pushed = false;
  const runner = (options) => {
    calls.push({
      args: [...options.args],
      env: { ...options.env }
    });
    if (options.args[0] === "ls-remote") {
      return successfulResult(
        pushed ? (postPushRemote ?? `${expectedCommit}\trefs/tags/${expectedReleaseTag}\n`) : initialRemote
      );
    }
    if (options.args.includes("push")) {
      const helper = options.args.find((argument) => argument.startsWith("credential.helper=store --file="));
      assert.ok(helper);
      const credentialPath = decodeQuotedHelperPath(helper);
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
          `https://x-access-token:${encodeCredentialToken(expectedToken)}@github.com\n`
        );
        const afterRead = fstatSync(credentialDescriptor);
        assert.equal(afterRead.dev, beforeRead.dev);
        assert.equal(afterRead.ino, beforeRead.ino);
        assert.equal(afterRead.size, beforeRead.size);
      } finally {
        closeSync(credentialDescriptor);
      }
      if (rewriteCredentialWith !== undefined || eraseCredential) {
        const beforeRewrite = lstatSync(credentialPath);
        const action = eraseCredential ? "reject" : "approve";
        const credentialInput = [
          "protocol=https",
          "host=github.com",
          "username=x-access-token",
          ...(rewriteCredentialWith === undefined ? [] : [`password=${rewriteCredentialWith}`]),
          "",
          ""
        ].join("\n");
        execFileSync("git", ["-c", "credential.helper=", "-c", helper, "credential", action], {
          encoding: "utf8",
          input: credentialInput,
          windowsHide: true
        });
        const afterRewrite = lstatSync(credentialPath);
        credentialRewrites.push({
          action,
          after: { dev: afterRewrite.dev, ino: afterRewrite.ino, size: afterRewrite.size },
          before: { dev: beforeRewrite.dev, ino: beforeRewrite.ino }
        });
      }
      mutateCredentialPath?.(credentialPath);
      assert.equal(
        options.args.some((argument) => argument.includes(expectedToken)),
        false
      );
      assert.equal(
        Object.values(options.env).some((value) => value === expectedToken),
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
        `${expectedCommit}:refs/tags/${expectedReleaseTag}`
      ]);
      const result = pushResult ?? successfulResult("To https://github.com/Matt17BR/openwrangler.git\n");
      pushed = result.status === 0;
      return result;
    }
    return systemGitRunner(options);
  };
  return { calls, credentialPaths, credentialRewrites, runner };
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

test("keeps the exact-tag transaction independent from the wrapper's source branch policy", (context) => {
  const repository = createRepository(context);
  git(repository.root, ["update-ref", "refs/remotes/origin/synthetic-source", repository.head]);
  const fake = createRunner({ expectedCommit: repository.head });
  assert.deepEqual(
    pushExactReleaseTag({
      expectedCommit: repository.head,
      gitRunner: fake.runner,
      releaseTag,
      repository: repositoryName,
      root: repository.root,
      sourceRef: "refs/remotes/origin/synthetic-source",
      token
    }),
    { created: true, releaseTag, sourceCommit: repository.head }
  );
  assert.throws(
    () =>
      pushExactReleaseTag({
        expectedCommit: repository.head,
        gitRunner: fake.runner,
        releaseTag,
        repository: repositoryName,
        root: repository.root,
        sourceRef: "refs/remotes/origin/release/../main",
        token
      }),
    /canonical origin remote-tracking ref/u
  );
});

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

test(
  "scrubs Git credential-store's exact atomic approval rewrite for printable token punctuation",
  { skip: process.platform === "win32" },
  (context) => {
    const repository = createRepository(context);
    const punctuationToken = "github_pat_release!()*:/%test";
    assert.equal(encodeCredentialToken(punctuationToken), "github_pat_release%21%28%29%2a%3a%2f%25test");
    const fake = createRunner({
      expectedCommit: repository.head,
      expectedToken: punctuationToken,
      rewriteCredentialWith: punctuationToken
    });
    assert.deepEqual(publish(repository, fake.runner, { token: punctuationToken }), {
      created: true,
      releaseTag,
      sourceCommit: repository.head
    });
    assert.equal(fake.credentialPaths.length, 1);
    assert.equal(existsSync(fake.credentialPaths[0]), false);
    assert.equal(existsSync(dirname(fake.credentialPaths[0])), false);
    assert.equal(fake.credentialRewrites.length, 1);
    assert.equal(fake.credentialRewrites[0].after.dev, fake.credentialRewrites[0].before.dev);
    assert.notEqual(fake.credentialRewrites[0].after.ino, fake.credentialRewrites[0].before.ino);
    assert.equal(fake.credentialRewrites[0].action, "approve");
    assert.equal(fake.credentialRewrites[0].after.size > 0, true);
  }
);

test(
  "fails closed without scrubbing an unexpected credential-path replacement",
  { skip: process.platform === "win32" },
  (context) => {
    const repository = createRepository(context);
    const fake = createRunner({
      expectedCommit: repository.head,
      rewriteCredentialWith: "x".repeat(token.length)
    });
    try {
      assert.throws(
        () => publish(repository, fake.runner),
        (error) =>
          error instanceof AggregateError &&
          error.errors.some((cleanupError) => /not the exact helper rewrite/u.test(cleanupError.message))
      );
      assert.equal(fake.credentialPaths.length, 1);
      assert.equal(existsSync(fake.credentialPaths[0]), true);
    } finally {
      if (fake.credentialPaths[0] !== undefined) {
        rmSync(dirname(fake.credentialPaths[0]), { force: true, recursive: true });
      }
    }
  }
);

test(
  "fails closed without following a credential-path symlink replacement",
  { skip: process.platform === "win32" },
  (context) => {
    const repository = createRepository(context);
    const outsidePath = join(repository.root, "outside-credential.txt");
    const outsideValue = "outside data must remain unchanged\n";
    writeFileSync(outsidePath, outsideValue, "utf8");
    const fake = createRunner({
      expectedCommit: repository.head,
      mutateCredentialPath: (credentialPath) => {
        unlinkSync(credentialPath);
        symlinkSync(outsidePath, credentialPath);
      }
    });
    try {
      assert.throws(
        () => publish(repository, fake.runner),
        (error) =>
          error instanceof AggregateError &&
          error.errors.some((cleanupError) => /credential path changed/u.test(cleanupError.message))
      );
      assert.equal(readFileSync(outsidePath, "utf8"), outsideValue);
    } finally {
      if (fake.credentialPaths[0] !== undefined) {
        rmSync(dirname(fake.credentialPaths[0]), { force: true, recursive: true });
      }
    }
  }
);

test(
  "fails closed without truncating a hard-linked original credential",
  { skip: process.platform === "win32" },
  (context) => {
    const repository = createRepository(context);
    const outsidePath = join(repository.root, "outside-hardlink");
    const expectedCredential = `https://x-access-token:${encodeCredentialToken(token)}@github.com\n`;
    const fake = createRunner({
      expectedCommit: repository.head,
      mutateCredentialPath: (credentialPath) => {
        linkSync(credentialPath, outsidePath);
      }
    });
    try {
      assert.throws(
        () => publish(repository, fake.runner),
        (error) =>
          error instanceof AggregateError &&
          error.errors.some((cleanupError) => /original private Git credential changed/u.test(cleanupError.message))
      );
      assert.equal(readFileSync(outsidePath, "utf8"), expectedCredential);
      assert.equal(lstatSync(outsidePath).nlink, 2);
    } finally {
      if (fake.credentialPaths[0] !== undefined) {
        rmSync(dirname(fake.credentialPaths[0]), { force: true, recursive: true });
      }
    }
  }
);

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

test("allows exact-tag recovery after main advances but rejects a fresh tag before push", (context) => {
  const repository = createRepository(context);
  const advancedMain = git(repository.root, [
    "commit-tree",
    `${repository.head}^{tree}`,
    "-p",
    repository.head,
    "-m",
    "advanced main"
  ]);
  git(repository.root, ["update-ref", "refs/remotes/origin/main", advancedMain]);

  const existing = createRunner({
    expectedCommit: repository.head,
    initialRemote: `${repository.head}\trefs/tags/${releaseTag}\n`
  });
  assert.deepEqual(publish(repository, existing.runner), {
    created: false,
    releaseTag,
    sourceCommit: repository.head
  });
  assert.equal(
    existing.calls.some((call) => call.args.includes("push")),
    false
  );
  assert.deepEqual(existing.credentialPaths, []);

  const absent = createRunner({ expectedCommit: repository.head });
  assert.throws(() => publish(repository, absent.runner), /equal the configured source ref/u);
  assert.equal(
    absent.calls.some((call) => call.args.includes("push")),
    false
  );
  assert.deepEqual(absent.credentialPaths, []);
});

test("publishes a generated direct child and recovers its exact existing tag", (context) => {
  const repository = createRepository(context);
  const parent = repository.head;
  const child = git(repository.root, ["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "generated release"]);
  git(repository.root, ["checkout", "--quiet", "--detach", child]);
  const publishGenerated = (runner) =>
    pushExactReleaseTag({
      expectedCommit: child,
      expectedParentCommit: parent,
      gitRunner: runner,
      releaseTag,
      repository: repositoryName,
      root: repository.root,
      sourceRef: "refs/remotes/origin/main",
      sourceRelation: "direct-child",
      token
    });
  const fresh = createRunner({ expectedCommit: child });
  assert.deepEqual(publishGenerated(fresh.runner), { created: true, releaseTag, sourceCommit: child });
  const existing = createRunner({
    expectedCommit: child,
    initialRemote: `${child}\trefs/tags/${releaseTag}\n`
  });
  assert.equal(publishGenerated(existing.runner).created, false);
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
      credentialPath = decodeQuotedHelperPath(helper);
      return { error: undefined, signal: null, status: 1, stderr: "rejected\n", stdout: "" };
    }
    return systemGitRunner(options);
  };
  assert.throws(() => publish(repository, runner), /atomically push/u);
  assert.equal(existsSync(credentialPath), false);
});

test("cleans Git credential-store's exact erase rewrite after a rejected push", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({
    eraseCredential: true,
    expectedCommit: repository.head,
    pushResult: { error: undefined, signal: null, status: 1, stderr: "rejected\n", stdout: "" }
  });
  assert.throws(
    () => publish(repository, fake.runner),
    (error) => !(error instanceof AggregateError) && /atomically push/u.test(error.message)
  );
  assert.equal(fake.credentialPaths.length, 1);
  assert.equal(existsSync(fake.credentialPaths[0]), false);
  assert.equal(existsSync(dirname(fake.credentialPaths[0])), false);
  assert.equal(fake.credentialRewrites.length, 1);
  assert.equal(fake.credentialRewrites[0].action, "reject");
  assert.equal(fake.credentialRewrites[0].after.dev, fake.credentialRewrites[0].before.dev);
  assert.notEqual(fake.credentialRewrites[0].after.ino, fake.credentialRewrites[0].before.ino);
  assert.equal(fake.credentialRewrites[0].after.size, 0);
});

test("requires exact repository, version, protected source branch, token, and clean tracked state", (context) => {
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
  assert.throws(() => publish(repository, fake.runner), /equal the configured source ref/u);
  git(repository.root, ["update-ref", "refs/remotes/origin/main", repository.head]);

  writeFileSync(join(repository.root, "tracked.txt"), "dirty\n", "utf8");
  assert.throws(() => publish(repository, fake.runner), /clean tracked worktree/u);
});

test("uses main for current v1 and later stable tags", (context) => {
  const repository = createRepository(context);
  const fake = createRunner({ expectedCommit: repository.head });
  assert.deepEqual(publish(repository, fake.runner), {
    created: true,
    releaseTag,
    sourceCommit: repository.head
  });

  writeFileSync(join(repository.root, "package.json"), '{"name":"openwrangler","version":"2.0.0"}\n', "utf8");
  git(repository.root, ["add", "package.json"]);
  git(repository.root, ["commit", "--quiet", "-m", "v2"]);
  const v2Head = git(repository.root, ["rev-parse", "HEAD"]);
  git(repository.root, ["update-ref", "refs/remotes/origin/main", v2Head]);
  const v2Runner = createRunner({ expectedCommit: v2Head, expectedReleaseTag: "v2.0.0" });
  assert.deepEqual(
    pushStableReleaseTag({
      expectedCommit: v2Head,
      gitRunner: v2Runner.runner,
      releaseTag: "v2.0.0",
      repository: repositoryName,
      root: repository.root,
      token
    }),
    { created: true, releaseTag: "v2.0.0", sourceCommit: v2Head }
  );
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
