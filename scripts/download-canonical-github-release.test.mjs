import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANONICAL_RELEASE_FILES,
  downloadCanonicalGithubRelease,
  githubReleasePollingOptions,
  GithubReleasePendingError,
  PREVIEW_RELEASE_FILES
} from "./download-canonical-github-release.mjs";

const releaseTag = "v1.0.2";
const payloads = new Map([
  ["openwrangler.vsix", Buffer.from("canonical-vsix")],
  ["openwrangler.vsix.provenance.json", Buffer.from('{"protocol":"fixture"}\n')],
  ["openwrangler.vsix.sha256", Buffer.from(`${"a".repeat(64)}  openwrangler.vsix\n`)]
]);

function release(overrides = {}) {
  return {
    tag_name: releaseTag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/Matt17BR/openwrangler/releases/tag/${releaseTag}`,
    assets: CANONICAL_RELEASE_FILES.map((name) => ({
      name,
      state: "uploaded",
      size: payloads.get(name).length,
      browser_download_url: `https://github.com/Matt17BR/openwrangler/releases/download/${releaseTag}/${name}`
    })),
    ...overrides
  };
}

function response(bytes, init = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return new Response(body, {
    status: 200,
    ...init,
    headers: {
      "content-length": String(body.length),
      ...(init.headers ?? {})
    }
  });
}

function successfulFetch(metadata = release()) {
  return async (url) => {
    if (url.startsWith("https://api.github.com/")) {
      return response(JSON.stringify(metadata));
    }
    const name = decodeURIComponent(new URL(url).pathname.split("/").at(-1));
    return response(payloads.get(name));
  };
}

test("downloads exactly the three canonical public GitHub release assets", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-release-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const output = join(parent, "canonical-release");
  const receipt = await downloadCanonicalGithubRelease({
    attempts: 1,
    fetchImpl: successfulFetch(),
    outputDirectory: output,
    prerelease: false,
    releaseTag
  });
  assert.deepEqual(receipt, {
    directory: output,
    files: CANONICAL_RELEASE_FILES
  });
  assert.deepEqual(readdirSync(output).sort(), [...CANONICAL_RELEASE_FILES].sort());
  for (const [name, bytes] of payloads) {
    assert.deepEqual(readFileSync(join(output, name)), bytes);
  }
});

test("downloads the exact provenance-bound canonical pre-release triple", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-preview-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const output = join(parent, "preview-release");
  const preview = release({
    prerelease: true,
    assets: release().assets.filter((asset) => PREVIEW_RELEASE_FILES.includes(asset.name))
  });
  const receipt = await downloadCanonicalGithubRelease({
    attempts: 1,
    fetchImpl: successfulFetch(preview),
    outputDirectory: output,
    prerelease: true,
    releaseTag
  });
  assert.deepEqual(receipt.files, PREVIEW_RELEASE_FILES);
  assert.deepEqual(readdirSync(output).sort(), [...PREVIEW_RELEASE_FILES].sort());
});

test("rejects a historical two-file preview release without provenance", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-preview-two-file-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const preview = release({
    prerelease: true,
    assets: release().assets.filter((asset) => asset.name !== "openwrangler.vsix.provenance.json")
  });
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 1,
      fetchImpl: successfulFetch(preview),
      outputDirectory: join(parent, "preview-release"),
      prerelease: true,
      releaseTag
    }),
    (error) => error instanceof GithubReleasePendingError && /complete canonical asset set/u.test(error.message)
  );
  assert.deepEqual(readdirSync(parent), []);
});

test("retries an anonymous API 403 and still requires complete release metadata before downloading", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-forbidden-retry-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const requests = [];
  let metadataCalls = 0;
  let sleeps = 0;
  const output = join(parent, "canonical-release");
  const success = successfulFetch();
  await downloadCanonicalGithubRelease({
    attempts: 2,
    delayMs: 1,
    fetchImpl: async (...args) => {
      requests.push(args[0]);
      if (args[0].startsWith("https://api.github.com/") && metadataCalls++ === 0) {
        return response("", { status: 403 });
      }
      return success(...args);
    },
    outputDirectory: output,
    prerelease: false,
    releaseTag,
    sleep: async () => {
      sleeps += 1;
    }
  });
  assert.equal(sleeps, 1);
  assert.equal(metadataCalls, 2);
  assert.equal(
    requests.slice(0, 2).every((url) => url.startsWith("https://api.github.com/")),
    true
  );
  assert.deepEqual(readdirSync(output).sort(), [...CANONICAL_RELEASE_FILES].sort());
});

test("an exhausted API 403 remains a pending-class failure without downloading assets", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-forbidden-exhausted-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  let calls = 0;
  let sleeps = 0;
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 3,
      delayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return response("", { status: 403 });
      },
      outputDirectory: join(parent, "canonical-release"),
      prerelease: false,
      releaseTag,
      sleep: async () => {
        sleeps += 1;
      }
    }),
    (error) => error instanceof GithubReleasePendingError && /\(403\)/u.test(error.message)
  );
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
  assert.deepEqual(readdirSync(parent), []);
});

test("retries one rejected metadata request before a response and then downloads the exact release", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-metadata-transport-retry-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const output = join(parent, "canonical-release");
  const secret = "https://signed.invalid/metadata?token=must-not-survive";
  const success = successfulFetch();
  let metadataCalls = 0;
  let sleeps = 0;

  await downloadCanonicalGithubRelease({
    attempts: 2,
    delayMs: 1,
    fetchImpl: (...args) => {
      if (args[0].startsWith("https://api.github.com/") && metadataCalls++ === 0) {
        return Promise.reject(new Error(secret));
      }
      return success(...args);
    },
    outputDirectory: output,
    prerelease: false,
    releaseTag,
    sleep: async () => {
      sleeps += 1;
      assert.deepEqual(readdirSync(parent), []);
    }
  });

  assert.equal(metadataCalls, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(readdirSync(output).sort(), [...CANONICAL_RELEASE_FILES].sort());
});

test("restarts the anonymous read transaction after an asset request rejects before a response", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-asset-transport-retry-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const output = join(parent, "canonical-release");
  const requests = [];
  const success = successfulFetch();
  let rejectProvenance = true;
  let sleeps = 0;

  await downloadCanonicalGithubRelease({
    attempts: 2,
    delayMs: 1,
    fetchImpl: (...args) => {
      const url = args[0];
      requests.push(url);
      if (url.endsWith("/openwrangler.vsix.provenance.json") && rejectProvenance) {
        rejectProvenance = false;
        return Promise.reject(new Error("https://signed.invalid/asset?credential=must-not-survive"));
      }
      return success(...args);
    },
    outputDirectory: output,
    prerelease: false,
    releaseTag,
    sleep: async () => {
      sleeps += 1;
      assert.deepEqual(readdirSync(parent), []);
    }
  });

  assert.equal(sleeps, 1);
  assert.equal(requests.filter((url) => url.startsWith("https://api.github.com/")).length, 2);
  assert.equal(requests.filter((url) => url.endsWith("/openwrangler.vsix")).length, 2);
  assert.equal(requests.filter((url) => url.endsWith("/openwrangler.vsix.provenance.json")).length, 2);
  assert.equal(requests.filter((url) => url.endsWith("/openwrangler.vsix.sha256")).length, 1);
  assert.deepEqual(readdirSync(output).sort(), [...CANONICAL_RELEASE_FILES].sort());
});

test("exhausts rejected pre-response requests with a fixed redacted failure and no output", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-transport-exhausted-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const secret = "https://signed.invalid/release?credential=must-not-survive";
  let calls = 0;
  let sleeps = 0;

  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 3,
      delayMs: 1,
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(new Error(secret));
      },
      outputDirectory: join(parent, "canonical-release"),
      prerelease: false,
      releaseTag,
      sleep: async () => {
        sleeps += 1;
        assert.deepEqual(readdirSync(parent), []);
      }
    }),
    (error) => {
      assert.equal(error instanceof GithubReleasePendingError, true);
      assert.equal(error.message, "GitHub release transport failed before a response was received.");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(String(error.stack).includes(secret), false);
      return true;
    }
  );

  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
  assert.deepEqual(readdirSync(parent), []);
});

test("does not retry a direct synchronous metadata or asset fetch failure", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-sync-fetch-failure-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const success = successfulFetch();

  for (const stage of ["metadata", "asset"]) {
    const sentinel = new Error(`direct synchronous ${stage} fetch failure`);
    let metadataCalls = 0;
    let assetCalls = 0;
    await assert.rejects(
      downloadCanonicalGithubRelease({
        attempts: 3,
        fetchImpl: (...args) => {
          if (args[0].startsWith("https://api.github.com/")) {
            metadataCalls += 1;
            if (stage === "metadata") {
              throw sentinel;
            }
            return success(...args);
          }
          assetCalls += 1;
          throw sentinel;
        },
        outputDirectory: join(parent, `canonical-release-${stage}`),
        prerelease: false,
        releaseTag,
        sleep: async () => assert.fail("a synchronous fetch failure must not be retried")
      }),
      (error) => error === sentinel
    );
    assert.equal(metadataCalls, 1);
    assert.equal(assetCalls, stage === "asset" ? 1 : 0);
  }

  assert.deepEqual(readdirSync(parent), []);
});

test("does not retry metadata or asset body failure after an HTTP response is acquired", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-response-body-failure-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  const success = successfulFetch();

  for (const stage of ["metadata", "asset"]) {
    const sentinel = new Error(`accepted ${stage} response body failed`);
    let metadataCalls = 0;
    let assetCalls = 0;
    const failingResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(sentinel);
          }
        }),
        { status: 200 }
      );
    await assert.rejects(
      downloadCanonicalGithubRelease({
        attempts: 3,
        fetchImpl: (...args) => {
          if (args[0].startsWith("https://api.github.com/")) {
            metadataCalls += 1;
            return stage === "metadata" ? failingResponse() : success(...args);
          }
          assetCalls += 1;
          return failingResponse();
        },
        outputDirectory: join(parent, `canonical-release-${stage}`),
        prerelease: false,
        releaseTag,
        sleep: async () => assert.fail("an acquired response-body failure must not be retried")
      }),
      (error) => error === sentinel
    );
    assert.equal(metadataCalls, 1);
    assert.equal(assetCalls, stage === "asset" ? 1 : 0);
  }

  assert.deepEqual(readdirSync(parent), []);
});

test("non-pending API 4xx failures remain fatal and are not retried", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-fatal-4xx-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  for (const status of [400, 401, 402, 405, 409, 422]) {
    let calls = 0;
    await assert.rejects(
      downloadCanonicalGithubRelease({
        attempts: 2,
        fetchImpl: async () => {
          calls += 1;
          return response("", { status });
        },
        outputDirectory: join(parent, `status-${status}`),
        prerelease: false,
        releaseTag,
        sleep: async () => assert.fail("fatal API responses must not be retried")
      }),
      new RegExp(`lookup failed with HTTP ${status}`, "u")
    );
    assert.equal(calls, 1);
  }
});

test("polls only while a public release is genuinely pending", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-pending-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  let metadataCalls = 0;
  let sleeps = 0;
  const success = successfulFetch();
  const fetchImpl = async (...args) => {
    if (args[0].startsWith("https://api.github.com/") && metadataCalls++ === 0) {
      return response(JSON.stringify(release({ assets: release().assets.slice(0, 1) })));
    }
    return success(...args);
  };
  await downloadCanonicalGithubRelease({
    attempts: 2,
    delayMs: 1,
    fetchImpl,
    outputDirectory: join(parent, "canonical-release"),
    prerelease: false,
    releaseTag,
    sleep: async () => {
      sleeps += 1;
    }
  });
  assert.equal(sleeps, 1);
});

test("keeps release handoff polling bounded", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-bounded-poll-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));

  await downloadCanonicalGithubRelease({
    attempts: 60,
    fetchImpl: successfulFetch(),
    outputDirectory: join(parent, "canonical-release"),
    prerelease: false,
    releaseTag
  });

  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 61,
      fetchImpl: successfulFetch(),
      outputDirectory: join(parent, "too-many-attempts"),
      prerelease: false,
      releaseTag
    }),
    /integer from 1 through 60/u
  );
});

test("reads the complete Azure handoff polling deadline", () => {
  assert.deepEqual(
    githubReleasePollingOptions({
      OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: "30",
      OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS: "10000",
      OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: "330000"
    }),
    { attempts: 30, delayMs: 10_000, timeoutMs: 330_000 }
  );
});

test("aborts a stalled GitHub handoff at its overall deadline", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-timeout-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 1,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      outputDirectory: join(parent, "canonical-release"),
      prerelease: false,
      releaseTag,
      timeoutMs: 10
    }),
    /overall deadline/u
  );
  assert.deepEqual(readdirSync(parent), []);
});

test("rejects malformed release inventory, URLs, and byte drift without retrying", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-reject-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));

  const extra = release({
    assets: [...release().assets, { name: "extra.txt", state: "uploaded", size: 1, browser_download_url: "x" }]
  });
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 2,
      fetchImpl: successfulFetch(extra),
      outputDirectory: join(parent, "extra"),
      prerelease: false,
      releaseTag,
      sleep: async () => assert.fail("structural conflicts must not be retried")
    }),
    /unexpected asset/u
  );

  const wrongUrl = release();
  wrongUrl.assets[0].browser_download_url = "https://example.com/openwrangler.vsix";
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 1,
      fetchImpl: successfulFetch(wrongUrl),
      outputDirectory: join(parent, "wrong-url"),
      prerelease: false,
      releaseTag
    }),
    /canonical public download URL/u
  );

  const driftedFetch = successfulFetch();
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 1,
      fetchImpl: async (url, options) => {
        const result = await driftedFetch(url, options);
        if (url.endsWith("/openwrangler.vsix")) {
          return response("different-size-and-content");
        }
        return result;
      },
      outputDirectory: join(parent, "drift"),
      prerelease: false,
      releaseTag
    }),
    /declared size/u
  );
});

test("rejects a GitHub release whose public channel differs from the selected package channel", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-channel-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 2,
      fetchImpl: successfulFetch(),
      outputDirectory: join(parent, "canonical-release"),
      prerelease: true,
      releaseTag,
      sleep: async () => assert.fail("a conflicting public channel must not be retried")
    }),
    /requested channel/u
  );
});

test("exhausted pending release lookup remains a pending-class failure", async (context) => {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-github-absent-")));
  context.after(() => rmSync(parent, { force: true, recursive: true }));
  await assert.rejects(
    downloadCanonicalGithubRelease({
      attempts: 1,
      fetchImpl: async () => new Response("", { status: 404 }),
      outputDirectory: join(parent, "canonical-release"),
      prerelease: false,
      releaseTag
    }),
    GithubReleasePendingError
  );
});
