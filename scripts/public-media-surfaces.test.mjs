import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PUBLIC_MEDIA_MAX_FILE_BYTES } from "./public-media-contract.mjs";
import { checkReleaseCutoverRepository } from "./release-cutovers.mjs";
import {
  PUBLIC_MEDIA_ASSETS,
  PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH,
  PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES,
  PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES,
  PUBLIC_MEDIA_SERIES_PATH,
  PUBLIC_README_FULL_SIZE_LINKS,
  PUBLIC_README_IMAGE_COUNT
} from "./public-media-inventory.mjs";
import {
  assertExactSourceReadmeUrl,
  assertDeclaredPublicMediaSeries,
  assertExpectedSurfaceContent,
  assertExpectedSurfaceVersion,
  assertRenderedProductImage,
  assertRepresentativeImageSource,
  assertSourcePackageVersion,
  expectedRepresentativeReferences,
  extractDeclaredPublicMediaPaths,
  extractImmutableProductReferences,
  extractImmutableReadmeMediaSourceSha,
  immutableProductReference,
  parsePublicMediaVerifierArguments,
  PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS,
  PUBLIC_MEDIA_FETCH_TIMEOUT_MS,
  PUBLIC_MEDIA_FIRST_PREPUBLICATION_VERSION,
  PUBLIC_MEDIA_FIRST_REQUIRED_VERSION,
  PUBLIC_MEDIA_MAX_DISPLAY_WIDTH,
  PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  PUBLIC_MEDIA_RESPONSIVE_WIDTHS,
  PUBLIC_SURFACE_CONTENT,
  publicMediaVerificationRequired,
  publicMediaPrepublicationRequired,
  publicSurfaceDefinitions,
  REPRESENTATIVE_PUBLIC_IMAGES
} from "./public-media-surface-contract.mjs";
import {
  assertBoundedRelativeMediaPath,
  assertPngContract,
  assertPublicMediaNavigationResponse,
  inspectLocalPublicMediaInventory,
  observeRenderedImageInPage,
  observeRegistryPropagation,
  resolveVerifiedSourceRoot,
  RetryablePublicMediaObservationError,
  runBoundedGit,
  runFreshPublicMediaContextAttempt,
  runPublicMediaVerification,
  runPublicMediaPropagation,
  verifyImmutablePublicBytes,
  verifyImmutableMediaAncestry,
  verifyExactSource,
  verifyLocalPublicMedia
} from "./verify-public-media-surfaces.mjs";

const sourceSha = "a".repeat(40);
const version = "1.2.1";
const reviewedMediaSha = "9fc096eabb1d0b5c0a66c3371a2a8ff8ce40de22";
const staleMediaSha = "5acf731e8b44e9ff82c4ac48fdc151210636da95";
const productPrefix = `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/docs/images/readme/v1.2/`;
const root = resolve(import.meta.dirname, "..");

const visibleStyle = { contentVisibility: "visible", display: "block", opacity: "1", visibility: "visible" };

function createFakeRenderedContainer({ isConnected = true, rectangle, style } = {}) {
  return {
    isConnected,
    parentElement: null,
    style: { ...visibleStyle, ...style },
    getBoundingClientRect: () => ({ ...(rectangle ?? { width: 960, height: 800, left: 0, right: 960 }) })
  };
}

function createFakeRenderedImage(overrides = {}) {
  const {
    container = createFakeRenderedContainer(),
    onScroll,
    rectangle = { width: 480, height: 270, left: 20, right: 500 },
    sourceUrl = `${productPrefix}image.png`,
    style,
    ...properties
  } = overrides;
  const scrollCalls = [];
  return {
    alt: "Exact public image",
    complete: true,
    currentSrc: sourceUrl,
    isConnected: true,
    naturalHeight: 540,
    naturalWidth: 960,
    ...properties,
    parentElement: container,
    scrollCalls,
    style: { ...visibleStyle, ...style },
    closest: () => container,
    getAttribute: () => sourceUrl,
    getBoundingClientRect: () => ({ ...(typeof rectangle === "function" ? rectangle() : rectangle) }),
    scrollIntoView: (options) => {
      scrollCalls.push(options);
      onScroll?.();
    }
  };
}

function createFakeRenderedImageEnvironment(imagesForFrame, { body, timeoutAfterFrames = 8 } = {}) {
  const documentBody = body ?? createFakeRenderedContainer();
  let activeImages = [];
  let timerCallback;
  let nextHandle = 1;
  const pendingFrames = new Set();
  const state = { frameCount: 0, timerClearCalls: 0 };
  const environment = {
    devicePixelRatio: 2,
    innerWidth: 1_400,
    document: {
      body: documentBody,
      querySelectorAll: () => activeImages
    },
    getComputedStyle: (element) => element.style,
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      pendingFrames.add(handle);
      queueMicrotask(() => {
        if (!pendingFrames.delete(handle)) return;
        if (state.frameCount >= timeoutAfterFrames) {
          const timeout = timerCallback;
          timerCallback = undefined;
          timeout?.();
          return;
        }
        activeImages = imagesForFrame(state.frameCount);
        state.frameCount += 1;
        callback(state.frameCount * 16);
      });
      return handle;
    },
    cancelAnimationFrame: (handle) => pendingFrames.delete(handle),
    setTimeout: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimeout: () => {
      timerCallback = undefined;
      state.timerClearCalls += 1;
    }
  };
  return { environment, state };
}

test("public media inventory declares one exact bounded series", () => {
  assert.equal(PUBLIC_MEDIA_SERIES_PATH, "docs/images/readme/v1.2/");
  assert.equal(PUBLIC_MEDIA_ASSETS.length, 48);
  assert.equal(PUBLIC_README_IMAGE_COUNT, 20);
  assert.equal(PUBLIC_README_FULL_SIZE_LINKS.length, PUBLIC_README_IMAGE_COUNT);
  assert.equal(
    new Set(PUBLIC_README_FULL_SIZE_LINKS.map(({ displayPath }) => displayPath)).size,
    PUBLIC_README_IMAGE_COUNT
  );
  assert.equal(PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES, 64);
  assert.equal(PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH, 4);
  assert.equal(PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES, 240);
  assert.equal(PUBLIC_MEDIA_MAX_DISPLAY_WIDTH, 960);
  assert.deepEqual(PUBLIC_MEDIA_RESPONSIVE_WIDTHS, [760, 1_400]);
  assert.equal(new Set(PUBLIC_MEDIA_ASSETS.map((asset) => asset.relativePath)).size, PUBLIC_MEDIA_ASSETS.length);
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    assert.match(asset.relativePath, /^(?:[a-z0-9.-]+\/)*[a-z0-9.-]+\.png$/u);
    assert.ok(Number.isSafeInteger(asset.logicalWidth) && asset.logicalWidth > 0);
    assert.ok(Number.isSafeInteger(asset.logicalHeight) && asset.logicalHeight > 0);
    assert.ok(Object.isFrozen(asset));
  }
});

test("public media release cutovers match their manifest and generated recovery documentation", () => {
  assert.deepEqual(checkReleaseCutoverRepository(), { cutovers: 2, checkedPaths: 4 });
});

test("the complete checked-in public media inventory satisfies the release-surface contract", () => {
  const result = verifyLocalPublicMedia(
    resolve(root, "docs", "images", "readme", "v1.2"),
    readFileSync(resolve(root, "README.md"), "utf8"),
    readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8")
  );
  assert.equal(result.displayed.length, PUBLIC_README_IMAGE_COUNT);
  assert.equal(result.mediaSourceSha, reviewedMediaSha);
});

test("public surface verification requires one exact source commit and semantic version", () => {
  assert.deepEqual(parsePublicMediaVerifierArguments(["--source-sha", sourceSha, "--version", version]), {
    sourceSha,
    version,
    sourceRoot: undefined,
    waitForPropagation: false,
    prepublish: false
  });
  assert.deepEqual(
    parsePublicMediaVerifierArguments([
      "--wait-for-propagation",
      "--version",
      "1.99.0",
      "--source-root",
      "release-source",
      "--source-sha",
      sourceSha
    ]),
    {
      sourceSha,
      version: "1.99.0",
      sourceRoot: "release-source",
      waitForPropagation: true,
      prepublish: false
    }
  );
  assert.deepEqual(
    parsePublicMediaVerifierArguments(["--source-sha", sourceSha, "--version", "1.99.0", "--prepublish"]),
    {
      sourceSha,
      version: "1.99.0",
      sourceRoot: undefined,
      waitForPropagation: false,
      prepublish: true
    }
  );
  assert.equal(PUBLIC_MEDIA_PROPAGATION_ATTEMPTS, 40);
  assert.equal(PUBLIC_MEDIA_PROPAGATION_DELAY_MS, 30_000);
  assert.equal(PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS, 30 * 60_000);
  assert.equal(PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS, 3 * 60_000);
  assert.equal(PUBLIC_MEDIA_FETCH_TIMEOUT_MS, 60_000);
  assert.equal(PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS, 10_000);
  assert.equal(PUBLIC_MEDIA_FIRST_REQUIRED_VERSION, "1.2.1");
  for (const arguments_ of [
    [],
    ["--source-sha", sourceSha],
    ["--source-sha", sourceSha.slice(1), "--version", version],
    ["--source-sha", sourceSha.toUpperCase(), "--version", version],
    ["--source-sha", sourceSha, "--version", `v${version}`],
    ["--source-sha", sourceSha, "--version", "01.2.1"],
    ["--source-sha", sourceSha, "--version", version, "--version", version],
    ["--source-sha", sourceSha, "--version", version, "--wait-for-propagation", "--wait-for-propagation"],
    ["--source-sha", sourceSha, "--version", version, "--prepublish", "--prepublish"],
    ["--source-sha", sourceSha, "--version", version, "--prepublish", "--wait-for-propagation"],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "../release-source"],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "release-source/.."],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "/release-source"],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "--wait-for-propagation"],
    ["--source-sha", sourceSha, "--version", version, "--unexpected", "value"]
  ]) {
    assert.throws(() => parsePublicMediaVerifierArguments(arguments_));
  }
});

test("the CLI passes parsed arguments directly into executable media orchestration", () => {
  const source = readFileSync(resolve(root, "scripts", "verify-public-media-surfaces.mjs"), "utf8");
  const mainStart = source.indexOf("async function main() {");
  const mainEnd = source.indexOf("export async function runPublicMediaVerification", mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart);
  const main = source.slice(mainStart, mainEnd);
  assert.equal(
    main,
    "async function main() {\n  await runPublicMediaVerification(parsePublicMediaVerifierArguments(process.argv.slice(2)));\n}\n\n"
  );
});

test("the executable CLI entrypoint rejects missing release identity", () => {
  const result = spawnSync(process.execPath, [resolve(root, "scripts", "verify-public-media-surfaces.mjs")], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.match(
    result.stderr,
    /Usage: npm run verify:public-media-surfaces -- --source-sha <40-hex-commit> --version <semantic-version>/u
  );
});

test("prepublication and rendered modes execute their exact ordered verification boundaries", async () => {
  for (const [prepublish, expectedResult, expectedCalls] of [
    [
      true,
      "prepublish",
      ["root", "read:README.md", "read:docs/media-gallery.md", "local", "ancestry", "source", "bytes", "report"]
    ],
    [
      false,
      "rendered",
      ["root", "read:README.md", "read:docs/media-gallery.md", "local", "ancestry", "source", "bytes", "rendered"]
    ]
  ]) {
    const calls = [];
    const references = { mediaSourceSha: reviewedMediaSha };
    const result = await runPublicMediaVerification(
      { prepublish, sourceRoot: undefined, sourceSha, version, waitForPropagation: true },
      {
        resolveSourceRoot: (value) => {
          assert.equal(value, undefined);
          calls.push("root");
          return "/verified-source";
        },
        readSource: (verifiedRoot, path) => {
          assert.equal(verifiedRoot, "/verified-source");
          calls.push(`read:${path}`);
          return path;
        },
        verifyLocal: (imageRoot, readme, gallery) => {
          assert.equal(imageRoot, `/verified-source/${PUBLIC_MEDIA_SERIES_PATH.slice(0, -1)}`);
          assert.equal(readme, "README.md");
          assert.equal(gallery, "docs/media-gallery.md");
          calls.push("local");
          return references;
        },
        verifyAncestry: (verifiedRoot, exactSource, mediaSource) => {
          assert.deepEqual([verifiedRoot, exactSource, mediaSource], ["/verified-source", sourceSha, reviewedMediaSha]);
          calls.push("ancestry");
        },
        verifySource: async (verifiedRoot, exactSource, exactVersion, readme) => {
          assert.deepEqual(
            [verifiedRoot, exactSource, exactVersion, readme],
            ["/verified-source", sourceSha, version, "README.md"]
          );
          calls.push("source");
        },
        verifyBytes: async (actualReferences) => {
          assert.equal(actualReferences, references);
          calls.push("bytes");
        },
        verifyRendered: async (exactSource, exactVersion, readme, actualReferences, wait) => {
          assert.deepEqual(
            [exactSource, exactVersion, readme, actualReferences, wait],
            [sourceSha, version, "README.md", references, true]
          );
          calls.push("rendered");
        },
        report: () => calls.push("report")
      }
    );
    assert.equal(result, expectedResult);
    assert.deepEqual(calls, expectedCalls);
  }
});

test("media orchestration propagates every verification-boundary failure unchanged", async () => {
  const options = { prepublish: false, sourceRoot: undefined, sourceSha, version, waitForPropagation: false };
  const baseOverrides = {
    resolveSourceRoot: () => "/verified-source",
    readSource: () => "source",
    verifyLocal: () => ({ mediaSourceSha: reviewedMediaSha }),
    verifyAncestry: () => {},
    verifySource: async () => {},
    verifyBytes: async () => {},
    verifyRendered: async () => {},
    report: () => {}
  };
  for (const [boundary, asynchronous] of [
    ["resolveSourceRoot", false],
    ["readSource", false],
    ["verifyLocal", false],
    ["verifyAncestry", false],
    ["verifySource", true],
    ["verifyBytes", true],
    ["verifyRendered", true]
  ]) {
    const expected = new Error(`authoritative ${boundary} failure`);
    const reject = asynchronous
      ? async () => {
          throw expected;
        }
      : () => {
          throw expected;
        };
    await assert.rejects(
      runPublicMediaVerification(options, { ...baseOverrides, [boundary]: reject }),
      (error) => error === expected,
      `${boundary} must remain authoritative`
    );
  }
});

test("prepublication immutable-byte verification rejects a stale README media commit", async () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.ok(readme.includes(reviewedMediaSha));
  assert.doesNotMatch(readme, new RegExp(staleMediaSha, "u"));
  const staleReadme = readme.replaceAll(reviewedMediaSha, staleMediaSha);
  const references = verifyLocalPublicMedia(
    resolve(root, "docs", "images", "readme", "v1.2"),
    staleReadme,
    readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8")
  );
  assert.equal(references.mediaSourceSha, staleMediaSha);

  const mismatchPath = "gallery/by-example-preview-detail.png";
  const requestedPaths = [];
  await assert.rejects(
    verifyImmutablePublicBytes(references, async (source) => {
      const prefix = `/${PUBLIC_MEDIA_SERIES_PATH}`;
      const pathStart = new URL(source).pathname.indexOf(prefix);
      assert.ok(pathStart >= 0);
      assert.ok(source.includes(`/${staleMediaSha}/`));
      const relativePath = new URL(source).pathname.slice(pathStart + prefix.length);
      requestedPaths.push(relativePath);
      const local = references.localBytes.get(relativePath);
      assert.ok(local);
      const remote = Buffer.from(local);
      if (relativePath === mismatchPath) remote[remote.length - 1] ^= 1;
      return new Response(remote, {
        status: 200,
        headers: { "content-length": String(remote.length) }
      });
    }),
    new RegExp(`${mismatchPath.replaceAll(".", "\\.")} differs from its immutable remote bytes`, "u")
  );
  assert.deepEqual(
    requestedPaths,
    PUBLIC_MEDIA_ASSETS.slice(0, 5).map((asset) => asset.relativePath)
  );
  references.localBytes.clear();
});

test("immutable-byte verification fetches every declared asset with bounded request options", async () => {
  const localBytes = new Map(
    PUBLIC_MEDIA_ASSETS.map(({ relativePath }) => [relativePath, Buffer.from(`exact:${relativePath}`, "utf8")])
  );
  const references = { localBytes, mediaSourceSha: reviewedMediaSha };
  const requests = [];
  await verifyImmutablePublicBytes(references, async (source, options) => {
    const relativePath = new URL(source).pathname.split(`/${PUBLIC_MEDIA_SERIES_PATH}`)[1];
    const local = localBytes.get(relativePath);
    assert.ok(local);
    assert.equal(options.redirect, "follow");
    assert.equal(options.headers["user-agent"], "Open-Wrangler-public-media-verifier");
    assert.ok(options.signal instanceof AbortSignal);
    requests.push(source);
    return new Response(local, { headers: { "content-length": String(local.length) } });
  });
  assert.deepEqual(
    requests,
    PUBLIC_MEDIA_ASSETS.map(
      ({ relativePath }) =>
        `https://raw.githubusercontent.com/Matt17BR/openwrangler/${reviewedMediaSha}/${PUBLIC_MEDIA_SERIES_PATH}${relativePath}`
    )
  );
  assert.equal(localBytes.size, 0);

  const finalAsset = PUBLIC_MEDIA_ASSETS.at(-1);
  assert.ok(finalAsset);
  const finalLocalBytes = new Map(
    PUBLIC_MEDIA_ASSETS.map(({ relativePath }) => [relativePath, Buffer.from(`final:${relativePath}`, "utf8")])
  );
  await assert.rejects(
    verifyImmutablePublicBytes({ localBytes: finalLocalBytes, mediaSourceSha: reviewedMediaSha }, async (source) => {
      const relativePath = new URL(source).pathname.split(`/${PUBLIC_MEDIA_SERIES_PATH}`)[1];
      const local = finalLocalBytes.get(relativePath);
      assert.ok(local);
      const remote = Buffer.from(local);
      if (relativePath === finalAsset.relativePath) remote[0] ^= 1;
      return new Response(remote, { headers: { "content-length": String(remote.length) } });
    }),
    new RegExp(`${finalAsset.relativePath.replaceAll(".", "\\.")} differs from its immutable remote bytes`, "u")
  );
  await assert.rejects(
    verifyImmutablePublicBytes(
      {
        localBytes: new Map(
          PUBLIC_MEDIA_ASSETS.map(({ relativePath }) => [relativePath, Buffer.from(`fetch:${relativePath}`, "utf8")])
        ),
        mediaSourceSha: reviewedMediaSha
      },
      async (source) => {
        if (source.endsWith(`/${finalAsset.relativePath}`)) return new Response("unavailable", { status: 503 });
        const relativePath = new URL(source).pathname.split(`/${PUBLIC_MEDIA_SERIES_PATH}`)[1];
        const local = Buffer.from(`fetch:${relativePath}`, "utf8");
        return new Response(local, { headers: { "content-length": String(local.length) } });
      }
    ),
    /Could not fetch immutable public media: HTTP 503/u
  );

  await assert.rejects(
    verifyImmutablePublicBytes(
      {
        localBytes: new Map(PUBLIC_MEDIA_ASSETS.map(({ relativePath }) => [relativePath, Buffer.from(relativePath)])),
        mediaSourceSha: reviewedMediaSha
      },
      async () =>
        new Response("x", {
          headers: { "content-length": String(PUBLIC_MEDIA_MAX_FILE_BYTES + 1) }
        })
    ),
    /exceeds the public-media file budget/u
  );
  await assert.rejects(
    verifyImmutablePublicBytes(
      {
        localBytes: new Map(PUBLIC_MEDIA_ASSETS.map(({ relativePath }) => [relativePath, Buffer.from(relativePath)])),
        mediaSourceSha: reviewedMediaSha
      },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(PUBLIC_MEDIA_MAX_FILE_BYTES));
              controller.enqueue(Buffer.from("overflow"));
              controller.close();
            }
          })
        )
    ),
    /exceeds the public-media file budget/u
  );
});

test("exact-source verification fetches and binds both README and package bytes", async (t) => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "ow-media-source-"));
  t.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ version }), "utf8");
  const localReadme = "# Exact reviewed README\n";
  const expectedUrls = [
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/README.md`,
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/package.json`
  ];
  const requested = [];
  await verifyExactSource(sourceRoot, sourceSha, version, localReadme, async (source) => {
    requested.push(source);
    return Buffer.from(source.endsWith("README.md") ? localReadme : JSON.stringify({ version }));
  });
  assert.deepEqual(requested, expectedUrls);
  await assert.rejects(
    verifyExactSource(sourceRoot, sourceSha, version, localReadme, async (source) =>
      Buffer.from(source.endsWith("README.md") ? "# stale\n" : JSON.stringify({ version }))
    ),
    /README does not byte-match/u
  );
  await assert.rejects(
    verifyExactSource(sourceRoot, sourceSha, version, localReadme, async (source) =>
      Buffer.from(source.endsWith("README.md") ? localReadme : JSON.stringify({ version: "1.2.2" }))
    ),
    /instead of/u
  );
  writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ version: "1.2.2" }), "utf8");
  await assert.rejects(
    verifyExactSource(sourceRoot, sourceSha, version, localReadme, async (source) =>
      Buffer.from(source.endsWith("README.md") ? localReadme : JSON.stringify({ version }))
    ),
    /instead of/u
  );
});

test("prepublication verification rejects stale or mutable full-size README media links", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.equal(extractImmutableReadmeMediaSourceSha(readme), reviewedMediaSha);
  const reviewedHref = `https://github.com/Matt17BR/openwrangler/blob/${reviewedMediaSha}/docs/images/readme/v1.2/explore.png`;
  assert.ok(readme.includes(reviewedHref));
  for (const replacement of [
    reviewedHref.replace(reviewedMediaSha, staleMediaSha),
    reviewedHref.replace(reviewedMediaSha, "main"),
    "https://example.invalid/explore.png",
    reviewedHref.replace("explore.png", "filter-result.png")
  ]) {
    const candidate = readme.replace(reviewedHref, replacement);
    assert.throws(
      () =>
        verifyLocalPublicMedia(
          resolve(root, "docs", "images", "readme", "v1.2"),
          candidate,
          readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8")
        ),
      /immutable reviewed source commit|share one immutable reviewed source commit|immutable full-size asset|wrong full-size/u
    );
  }
  assert.throws(
    () => extractImmutableReadmeMediaSourceSha(readme.replace(`<a href="${reviewedHref}">`, "")),
    /must have one immutable full-size/u
  );
});

test("prepublication media ancestry rejects a byte-valid commit on a divergent branch", (t) => {
  const repository = mkdtempSync(join(tmpdir(), "ow-media-ancestry-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Open Wrangler media test");
  git("config", "user.email", "media-test@example.invalid");
  writeFileSync(join(repository, "history.txt"), "base\n");
  git("add", "history.txt");
  git("commit", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(repository, "history.txt"), "base\nrelease\n");
  git("commit", "-am", "release");
  const releaseSha = git("rev-parse", "HEAD");
  git("checkout", "-b", "diverged-media", baseSha);
  writeFileSync(join(repository, "history.txt"), "base\ndiverged media\n");
  git("commit", "-am", "diverged media");
  const divergedMediaSha = git("rev-parse", "HEAD");
  git("checkout", "main");

  assert.doesNotThrow(() => verifyImmutableMediaAncestry(repository, releaseSha, baseSha));
  assert.throws(
    () => verifyImmutableMediaAncestry(repository, releaseSha, divergedMediaSha),
    /must be an ancestor of the exact release source/u
  );
  assert.throws(
    () => verifyImmutableMediaAncestry(repository, releaseSha, "f".repeat(40)),
    /does not contain the exact README media source commit/u
  );
});

test("media ancestry launches Git with fixed time and output bounds", () => {
  const invocations = [];
  const result = runBoundedGit(
    "/verified-source",
    ["merge-base", "--is-ancestor", sourceSha, reviewedMediaSha],
    (executable, arguments_, options) => {
      invocations.push({ executable, arguments_, options });
      return { status: 0, stdout: "" };
    }
  );
  assert.deepEqual(result, { status: 0, stdout: "" });
  assert.deepEqual(invocations, [
    {
      executable: "git",
      arguments_: ["-C", "/verified-source", "merge-base", "--is-ancestor", sourceSha, reviewedMediaSha],
      options: {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true
      }
    }
  ]);
});

test("public media verification starts at v1.2.1 without changing historical recovery", () => {
  for (const historical of ["0.9.0", "1.1.1", "1.2.0", "1.2.0-preview.1"]) {
    assert.equal(publicMediaVerificationRequired(historical), false);
  }
  for (const protectedVersion of ["1.2.1", "1.2.2", "1.99.0", "2.0.0-preview.1"]) {
    assert.equal(publicMediaVerificationRequired(protectedVersion), true);
  }
  assert.throws(() => publicMediaVerificationRequired("v1.2.1"), /must be semantic/u);
});

test("prepublication recovery uses the exact release-source contract starting with v1.99.4", () => {
  assert.equal(PUBLIC_MEDIA_FIRST_PREPUBLICATION_VERSION, "1.99.4");
  for (const historical of ["1.2.1", "1.2.2", "1.99.0", "1.99.1", "1.99.2", "1.99.3"]) {
    assert.equal(publicMediaPrepublicationRequired(historical), false);
  }
  for (const protectedVersion of ["1.99.4", "1.99.4-preview.1", "1.100.0", "2.0.0"]) {
    assert.equal(publicMediaPrepublicationRequired(protectedVersion), true);
  }
  assert.throws(() => publicMediaPrepublicationRequired("v1.99.4"), /must be semantic/u);
});

test("the injected propagation controller retries only typed registry observations", async () => {
  const terminalError = new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
  let terminalAttempts = 0;
  const terminalDelays = [];
  await assert.rejects(
    runPublicMediaPropagation({
      attempt: async () => {
        terminalAttempts += 1;
        throw terminalError;
      },
      attempts: 3,
      delayMilliseconds: 10,
      timeoutMilliseconds: 1_000,
      attemptTimeoutMilliseconds: 100,
      sleep: async (milliseconds) => terminalDelays.push(milliseconds),
      report: () => {}
    }),
    (error) => error === terminalError
  );
  assert.equal(terminalAttempts, 1);
  assert.deepEqual(terminalDelays, []);

  let retryAttempts = 0;
  let clock = 0;
  const retryDelays = [];
  await assert.rejects(
    runPublicMediaPropagation({
      attempt: async () => {
        retryAttempts += 1;
        throw new RetryablePublicMediaObservationError("registry still stale");
      },
      attempts: 3,
      delayMilliseconds: 10,
      timeoutMilliseconds: 1_000,
      attemptTimeoutMilliseconds: 100,
      now: () => clock,
      sleep: async (milliseconds) => {
        retryDelays.push(milliseconds);
        clock += milliseconds;
      },
      report: () => {}
    }),
    /registry still stale/u
  );
  assert.equal(retryAttempts, 3);
  assert.deepEqual(retryDelays, [10, 10]);
});

test("the exact source runs once before registry-only retries under one global deadline", async () => {
  let clock = 0;
  let sourceCalls = 0;
  const contexts = [];
  const result = await runPublicMediaPropagation({
    attempts: 3,
    delayMilliseconds: 5,
    timeoutMilliseconds: 100,
    attemptTimeoutMilliseconds: 100,
    now: () => clock,
    sleep: async (milliseconds) => (clock += milliseconds),
    report: () => {},
    verifySourceOnce: async ({ attemptTimeoutMilliseconds }) => {
      sourceCalls += 1;
      assert.equal(attemptTimeoutMilliseconds, 100);
      clock += 73;
    },
    attempt: ({ attemptNumber, attemptTimeoutMilliseconds }) =>
      runFreshPublicMediaContextAttempt({
        attemptTimeoutMilliseconds,
        cleanupTimeoutMilliseconds: 100,
        createContext: async () => {
          const context = {
            attemptNumber,
            attemptTimeoutMilliseconds,
            closeCalls: 0,
            async close() {
              this.closeCalls += 1;
            }
          };
          contexts.push(context);
          return context;
        },
        verifyContext: async (context) => {
          if (context.attemptNumber < 3) throw new RetryablePublicMediaObservationError("registry stale");
          return "propagated";
        }
      })
  });
  assert.equal(result, "propagated");
  assert.equal(sourceCalls, 1);
  assert.deepEqual(
    contexts.map(({ closeCalls }) => closeCalls),
    [1, 1, 1]
  );
  assert.equal(new Set(contexts).size, 3);
  assert.deepEqual(
    contexts.map(({ attemptTimeoutMilliseconds }) => attemptTimeoutMilliseconds),
    [27, 22, 17]
  );
  assert.equal(clock, 83);
});

test("a typed source failure is authoritative and never enters registry propagation", async () => {
  const sourceFailure = new RetryablePublicMediaObservationError("source is not a registry observation");
  await assert.rejects(
    runPublicMediaPropagation({
      verifySourceOnce: async () => Promise.reject(sourceFailure),
      attempt: async () => assert.fail("a source failure must bypass registry attempts")
    }),
    (error) => error === sourceFailure
  );
});

test("only explicit stale or unavailable registry observations become retryable", () => {
  const sourceSurface = { name: "GitHub", versionKind: "source" };
  const registrySurface = { name: "Visual Studio Marketplace", versionKind: "marketplace" };
  const stale = new Error("renders version 1.99.5 instead of 1.99.6");
  assert.equal(observeRegistryPropagation(registrySurface, "is current", { ready: true, value: "current" }), "current");
  assert.throws(
    () =>
      observeRegistryPropagation(registrySurface, "still exposes stale version metadata", {
        ready: false,
        kind: "registry-stale",
        reason: stale.message,
        cause: stale
      }),
    (error) =>
      error instanceof RetryablePublicMediaObservationError &&
      error.cause === stale &&
      /Visual Studio Marketplace still exposes stale version metadata/u.test(error.message)
  );
  assert.throws(
    () =>
      observeRegistryPropagation(sourceSurface, "failed its render contract", {
        ready: false,
        kind: "registry-stale",
        reason: stale.message,
        cause: stale
      }),
    (error) => error === stale
  );
  assert.throws(
    () =>
      observeRegistryPropagation(registrySurface, "failed", {
        ready: false,
        kind: "terminal",
        reason: "DOM harness failure"
      }),
    (error) => error instanceof Error && !(error instanceof RetryablePublicMediaObservationError)
  );
  assert.throws(
    () => assertPublicMediaNavigationResponse(registrySurface, null),
    (error) => error instanceof Error && !(error instanceof RetryablePublicMediaObservationError)
  );
  const unavailableResponse = { ok: () => false, status: () => 503 };
  assert.throws(
    () => assertPublicMediaNavigationResponse(registrySurface, unavailableResponse),
    (error) => error instanceof RetryablePublicMediaObservationError && /HTTP 503/u.test(error.message)
  );
  assert.throws(
    () => assertPublicMediaNavigationResponse(sourceSurface, unavailableResponse),
    (error) =>
      error instanceof Error &&
      !(error instanceof RetryablePublicMediaObservationError) &&
      /HTTP 503/u.test(error.message)
  );
});

test("returning to an earlier image identity scrolls its new candidacy again", async () => {
  const container = createFakeRenderedContainer();
  const first = createFakeRenderedImage({ container, sourceUrl: `${productPrefix}first.png` });
  const second = createFakeRenderedImage({ container, sourceUrl: `${productPrefix}second.png` });
  const harness = createFakeRenderedImageEnvironment(
    (frame) => {
      if (frame === 0 || frame >= 2) return [first];
      return [second];
    },
    { body: container, timeoutAfterFrames: 8 }
  );
  const observation = await observeRenderedImageInPage(
    { alt: first.alt, timeoutMilliseconds: 30_000 },
    harness.environment
  );
  assert.equal(observation.ready, true);
  assert.deepEqual(
    [observation.value.sourceUrl, observation.value.clientWidth, observation.value.containerWidth],
    [`${productPrefix}first.png`, 480, 960]
  );
  const scroll = { behavior: "instant", block: "center", inline: "nearest" };
  assert.deepEqual(first.scrollCalls, [scroll, scroll]);
  assert.deepEqual(second.scrollCalls, [scroll]);
  assert.equal(harness.state.frameCount, 5);
  assert.equal(harness.state.timerClearCalls, 1);
});

test("in-page observation classifies only initial absence or incompleteness as propagation", async () => {
  const scene = (imagesForFrame) => () => {
    const body = createFakeRenderedContainer();
    return { body, imagesForFrame: (frame) => imagesForFrame(frame, body) };
  };
  const one =
    (imageOptions = {}, frames = (_frame, image) => [image]) =>
    () => {
      const body = createFakeRenderedContainer();
      const image = createFakeRenderedImage({ container: body, ...imageOptions });
      return { body, imagesForFrame: (frame) => frames(frame, image) };
    };
  let movingLeft = 0;
  const cases = [
    ["missing", scene(() => []), "registry-stale", /observed 0/u],
    ["incomplete", one({ complete: false, naturalHeight: 0, naturalWidth: 0 }), "registry-stale", /incomplete/u],
    [
      "duplicate",
      scene((_frame, body) => [
        createFakeRenderedImage({ container: body }),
        createFakeRenderedImage({ container: body })
      ]),
      "terminal",
      /exactly one/u
    ],
    ["hidden", one({ style: { display: "none" } }), "terminal", /CSS-hidden/u],
    ["invalid", one({ rectangle: { width: 0, height: 0, left: 20, right: 20 } }), "terminal", /invalid geometry/u],
    ["disconnected", one({ isConnected: false }), "terminal", /disconnected/u],
    ["vanished", one({}, (frame, image) => (frame === 0 ? [image] : [])), "terminal", /observed 0/u],
    [
      "regressed",
      one({}, (frame, image) => {
        if (frame >= 2) image.complete = false;
        return [image];
      }),
      "terminal",
      /incomplete/u
    ],
    [
      "unstable",
      one({ rectangle: () => ({ width: 480, height: 270, left: movingLeft++, right: movingLeft + 480 }) }),
      "terminal",
      /did not stabilize/u
    ],
    ["churn", scene((_frame, body) => [createFakeRenderedImage({ container: body })]), "terminal", /replaced/u]
  ];
  const registry = { name: "Visual Studio Marketplace", versionKind: "marketplace" };
  for (const [label, createScene, expectedKind, expectedReason] of cases) {
    const { body, imagesForFrame } = createScene();
    const harness = createFakeRenderedImageEnvironment(imagesForFrame, { body, timeoutAfterFrames: 5 });
    const observation = await observeRenderedImageInPage(
      { alt: "Exact public image", timeoutMilliseconds: 30_000 },
      harness.environment
    );
    assert.equal(observation.kind, expectedKind, label);
    assert.match(observation.reason, expectedReason, label);
    assert.equal(harness.state.timerClearCalls, 1, label);
    assert.throws(
      () => observeRegistryPropagation(registry, "failed render", observation),
      (error) => error instanceof RetryablePublicMediaObservationError === (expectedKind !== "terminal"),
      label
    );
  }
});

test("scroll and initial animation-frame exceptions clean up and never retry", async () => {
  for (const mode of ["scroll", "initial-frame"]) {
    const failure = new Error(`${mode} failed`);
    const body = createFakeRenderedContainer();
    const image = createFakeRenderedImage({
      container: body,
      onScroll:
        mode === "scroll"
          ? () => {
              throw failure;
            }
          : undefined
    });
    const harness = createFakeRenderedImageEnvironment(() => [image], { body, timeoutAfterFrames: 4 });
    if (mode === "initial-frame")
      harness.environment.requestAnimationFrame = () => {
        throw failure;
      };
    let attempts = 0;
    const delays = [];
    await assert.rejects(
      runPublicMediaPropagation({
        attempts: 3,
        delayMilliseconds: 5,
        timeoutMilliseconds: 100,
        attemptTimeoutMilliseconds: 50,
        now: () => 0,
        sleep: async (milliseconds) => delays.push(milliseconds),
        report: () => {},
        attempt: async () => {
          attempts += 1;
          return observeRenderedImageInPage(
            { alt: "Exact public image", timeoutMilliseconds: 30_000 },
            harness.environment
          );
        }
      }),
      (error) => error === failure,
      mode
    );
    assert.equal(attempts, 1, mode);
    assert.deepEqual(delays, [], mode);
    assert.equal(harness.state.timerClearCalls, 1, mode);
  }
});

test("source-root verification rejects symlinks and resolves only real contained directories", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "ow-media-source-root-"));
  const outside = mkdtempSync(join(tmpdir(), "ow-media-outside-root-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const releaseSource = join(checkout, "release-source");
  mkdirSync(releaseSource);
  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(releaseSource, join(checkout, "linked-source"), directoryLinkType);
  mkdirSync(join(outside, "child"));
  symlinkSync(outside, join(checkout, "escaping-parent"), directoryLinkType);
  assert.equal(resolveVerifiedSourceRoot("release-source", checkout), realpathSync.native(releaseSource));
  assert.throws(
    () => resolveVerifiedSourceRoot("linked-source", checkout),
    /one real directory below the automation checkout/u
  );
  assert.throws(
    () => resolveVerifiedSourceRoot("escaping-parent/child", checkout),
    /remain below the automation checkout after canonicalization/u
  );
});

test("local inventory preflight bounds size, count, depth, and path before PNG decoding", async (t) => {
  await t.test("individual size is rejected before malformed PNG bytes are decoded", (subtest) => {
    const directory = mkdtempSync(join(tmpdir(), "ow-media-file-size-"));
    subtest.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "a.png"), "not a PNG");
    writeFileSync(join(directory, "b.png"), "");
    truncateSync(join(directory, "b.png"), 2 * 1024 * 1024 + 1);
    assert.throws(() => inspectLocalPublicMediaInventory(directory), /file budget/u);
  });
  await t.test("aggregate size is pre-statted before any file read", (subtest) => {
    const directory = mkdtempSync(join(tmpdir(), "ow-media-total-size-"));
    subtest.after(() => rmSync(directory, { recursive: true, force: true }));
    for (let index = 0; index < 17; index += 1) {
      const path = join(directory, `${index}.png`);
      writeFileSync(path, "");
      truncateSync(path, 2 * 1024 * 1024);
    }
    assert.throws(() => inspectLocalPublicMediaInventory(directory), /bounded size budget/u);
  });
  await t.test("entry count is bounded during traversal", (subtest) => {
    const directory = mkdtempSync(join(tmpdir(), "ow-media-entry-count-"));
    subtest.after(() => rmSync(directory, { recursive: true, force: true }));
    for (let index = 0; index <= PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES; index += 1) {
      mkdirSync(join(directory, `d-${index}`));
    }
    assert.throws(() => inspectLocalPublicMediaInventory(directory), /bounded entry count/u);
  });
  await t.test("directory depth and relative path length are bounded", (subtest) => {
    const directory = mkdtempSync(join(tmpdir(), "ow-media-shape-"));
    subtest.after(() => rmSync(directory, { recursive: true, force: true }));
    let nested = directory;
    for (let depth = 0; depth <= PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH; depth += 1) {
      nested = join(nested, `d${depth}`);
      mkdirSync(nested);
    }
    assert.throws(() => inspectLocalPublicMediaInventory(directory), /bounded directory depth/u);
    assert.doesNotThrow(() => assertBoundedRelativeMediaPath("x".repeat(PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES)));
    assert.throws(
      () => assertBoundedRelativeMediaPath("x".repeat(PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES + 1)),
      /overlong or malformed relative path/u
    );
  });
});

test("PNG verification rejects corrupted chunk CRCs before decode", () => {
  const asset = PUBLIC_MEDIA_ASSETS[0];
  const bytes = Buffer.from(readFileSync(resolve(root, "docs", "images", "readme", "v1.2", asset.relativePath)));
  const idatTypeOffset = bytes.indexOf(Buffer.from("IDAT"));
  assert.ok(idatTypeOffset > 0);
  bytes[idatTypeOffset + 4] ^= 1;
  assert.throws(() => assertPngContract(bytes, asset), /invalid IDAT chunk CRC/u);
});

test("GitHub verification is pinned to the caller-supplied README commit", () => {
  const [github] = publicSurfaceDefinitions(sourceSha);
  assert.equal(github.url, `https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/README.md`);
  assert.doesNotMatch(github.url, /\/blob\/(?:main|release\/1\.x)\//u);
  assert.doesNotThrow(() => assertExactSourceReadmeUrl(github.url, sourceSha));
  assert.throws(
    () => assertExactSourceReadmeUrl("https://github.com/Matt17BR/openwrangler/blob/main/README.md", sourceSha),
    /exact source README URL/u
  );
});

test("surface content and versions fail closed on stale publication", () => {
  assert.deepEqual(PUBLIC_SURFACE_CONTENT, [
    "Open source dataframe workbench for VS Code and Cursor: Pandas and Polars editing, experimental DuckDB file editing and relation viewing, local PySpark 4.2 notebook viewing, and preview native R.",
    "Open files",
    "The active filter matches 14,287 rows."
  ]);
  const content = PUBLIC_SURFACE_CONTENT.join("\n");
  assert.doesNotThrow(() => assertExpectedSurfaceContent("Synthetic", content));
  assert.throws(
    () => assertExpectedSurfaceContent("Synthetic", content.replace(PUBLIC_SURFACE_CONTENT[1], "Open data")),
    /expected README content/u
  );
  assert.doesNotThrow(() => assertExpectedSurfaceVersion("Synthetic", version, version));
  assert.throws(() => assertExpectedSurfaceVersion("Synthetic", "1.2.0", version), /instead of/u);
  assert.doesNotThrow(() => assertSourcePackageVersion(JSON.stringify({ version }), version));
  assert.throws(() => assertSourcePackageVersion(JSON.stringify({ version: "1.2.0" }), version), /instead of/u);
  assert.throws(() => assertSourcePackageVersion("{", version), /malformed package metadata/u);
});

test("representative media remains bound to each immutable README URL", () => {
  const readme = REPRESENTATIVE_PUBLIC_IMAGES.map(
    (alt, index) => `<img width="100" alt="${alt}" src="${productPrefix}gallery/representative-${index}.png">`
  ).join("\n");
  const references = extractImmutableProductReferences(readme);
  assert.equal(references.length, REPRESENTATIVE_PUBLIC_IMAGES.length);
  assert.deepEqual(
    references.map(({ displayWidth, sourceSha: referenceSha }) => ({
      displayWidth,
      sourceSha: referenceSha
    })),
    REPRESENTATIVE_PUBLIC_IMAGES.map(() => ({ displayWidth: 100, sourceSha }))
  );
  assert.deepEqual(expectedRepresentativeReferences(readme), references);

  const expected = references[0];
  assert.doesNotThrow(() =>
    assertRepresentativeImageSource(
      "Synthetic",
      { alt: expected.alt, sourceUrl: expected.url, currentUrl: expected.url },
      expected.url
    )
  );
  assert.throws(
    () =>
      assertRepresentativeImageSource(
        "Synthetic",
        { alt: expected.alt, sourceUrl: expected.url, currentUrl: `${expected.url}?proxy=stale` },
        expected.url
      ),
    /expected immutable image URL/u
  );
  assert.throws(
    () => expectedRepresentativeReferences(readme.replace(REPRESENTATIVE_PUBLIC_IMAGES[1], "Wrong alt")),
    /exactly one immutable public image/u
  );
});

test("representative media contract matches the checked-in README", () => {
  const references = expectedRepresentativeReferences(readFileSync(resolve(root, "README.md"), "utf8"));
  assert.deepEqual(
    references.map(({ alt }) => alt),
    REPRESENTATIVE_PUBLIC_IMAGES
  );
  assert.equal(new Set(references.map(({ sourceSha: referenceSha }) => referenceSha)).size, 1);
});

test("rendered README images keep their source, cap, density, aspect ratio, and container", () => {
  const expected = {
    alt: "Synthetic public image",
    url: `${productPrefix}gallery/example.png`,
    displayWidth: 100,
    naturalWidth: 300,
    naturalHeight: 150
  };
  const rendered = {
    alt: expected.alt,
    sourceUrl: expected.url,
    currentUrl: expected.url,
    clientWidth: 96,
    clientHeight: 48,
    clientLeft: 12,
    clientRight: 108,
    viewportWidth: 120,
    containerWidth: 100,
    containerLeft: 10,
    containerRight: 110,
    naturalWidth: 300,
    naturalHeight: 150,
    devicePixelRatio: 2
  };
  assert.doesNotThrow(() => assertRenderedProductImage("Synthetic", rendered, expected));
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, naturalWidth: 100 }, expected),
    /reviewed 300x150/u
  );
  assert.throws(
    () =>
      assertRenderedProductImage(
        "Synthetic",
        { ...rendered, clientWidth: 102, clientHeight: 51, clientRight: 114 },
        expected
      ),
    /upscale or overflow/u
  );
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, clientHeight: 50 }, expected),
    /distorts/u
  );
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, containerWidth: 90, containerRight: 100 }, expected),
    /upscale or overflow/u
  );
  assert.throws(
    () =>
      assertRenderedProductImage(
        "Synthetic",
        { ...rendered, clientLeft: 26, clientRight: 122, containerLeft: 20, containerRight: 126 },
        expected
      ),
    /upscale or overflow/u
  );
  const twoTimesExpected = { ...expected, displayWidth: 150, naturalWidth: 200, naturalHeight: 100 };
  assert.throws(
    () =>
      assertRenderedProductImage(
        "Synthetic",
        {
          ...rendered,
          clientWidth: 101,
          clientHeight: 50.5,
          clientRight: 113,
          viewportWidth: 150,
          containerWidth: 150,
          containerRight: 160,
          naturalWidth: 200,
          naturalHeight: 100
        },
        twoTimesExpected
      ),
    /upscale or overflow/u
  );
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, devicePixelRatio: 1 }, expected),
    /required DPR 2/u
  );
});

test("representative README images remain responsive near 760px and 1400px", () => {
  const expected = {
    alt: "Responsive public image",
    url: `${productPrefix}gallery/responsive.png`,
    displayWidth: 960,
    naturalWidth: 2_880,
    naturalHeight: 1_740
  };
  for (const { containerWidth, clientWidth } of [
    { containerWidth: 760, clientWidth: 760 },
    { containerWidth: 1_400, clientWidth: 960 }
  ]) {
    assert.doesNotThrow(() =>
      assertRenderedProductImage(
        `Synthetic at ${containerWidth}px`,
        {
          alt: expected.alt,
          sourceUrl: expected.url,
          currentUrl: expected.url,
          clientWidth,
          clientHeight: (clientWidth * expected.naturalHeight) / expected.naturalWidth,
          clientLeft: 0,
          clientRight: clientWidth,
          viewportWidth: containerWidth,
          containerWidth,
          containerLeft: 0,
          containerRight: containerWidth,
          naturalWidth: expected.naturalWidth,
          naturalHeight: expected.naturalHeight,
          devicePixelRatio: 2
        },
        expected
      )
    );
  }
});

test("public media declarations reject undeclared series and enumerate link-only assets", () => {
  const current = [
    `<a href="https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/docs/images/readme/v1.2/gallery/full.png">`,
    `<img src="${productPrefix}gallery/detail.png" width="100" alt="Detail">`,
    "</a>"
  ].join("");
  const gallery =
    '<a href="images/readme/v1.2/gallery/other-full.png"><img src="images/readme/v1.2/gallery/other.png"></a>';
  assert.doesNotThrow(() => assertDeclaredPublicMediaSeries(current));
  assert.deepEqual(extractDeclaredPublicMediaPaths(current, gallery), [
    "gallery/detail.png",
    "gallery/full.png",
    "gallery/other-full.png",
    "gallery/other.png"
  ]);
  for (const undeclared of [current.replaceAll("v1.2", "v1.3"), gallery.replaceAll("v1.2", "v1.3")]) {
    assert.throws(() => assertDeclaredPublicMediaSeries(undeclared), /must use the declared/u);
  }
  assert.throws(
    () => assertDeclaredPublicMediaSeries("![Future](docs/images/readme/v1.3/gallery/future.png)"),
    /must use the declared/u
  );
  const excessiveDeclarations = Array.from(
    { length: PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES + 1 },
    (_, index) => `<img src="images/readme/v1.2/gallery/${index}.png">`
  ).join("\n");
  assert.throws(() => extractDeclaredPublicMediaPaths(excessiveDeclarations), /bounded inventory count/u);
});

test("immutable product references reject mutable or decorated media URLs", () => {
  const exact = `${productPrefix}gallery/example.png`;
  assert.deepEqual(immutableProductReference(exact), {
    url: exact,
    relativePath: "gallery/example.png",
    sourceSha
  });
  assert.equal(
    immutableProductReference(
      "https://raw.githubusercontent.com/Matt17BR/openwrangler/main/docs/images/readme/v1.2/gallery/example.png"
    ),
    undefined
  );
  assert.throws(() => immutableProductReference(`${exact}?raw=1`), /query or fragment/u);
  assert.throws(() => immutableProductReference(exact.replace("/v1.2/", "/v1.3/")), /must use the declared/u);
  assert.throws(
    () =>
      extractImmutableProductReferences(`<img alt="Mutable" src="${exact.replace(sourceSha, "main")}" width="100">`),
    /immutable raw source commit/u
  );
});

test("public README image declarations are width-only and bounded", () => {
  const exact = `${productPrefix}gallery/example.png`;
  assert.deepEqual(extractImmutableProductReferences(`<img alt="Example" src="${exact}" width="960">`), [
    {
      alt: "Example",
      displayWidth: 960,
      relativePath: "gallery/example.png",
      sourceSha,
      url: exact
    }
  ]);
  for (const declaration of [
    `<img alt="Example" src="${exact}">`,
    `<img alt="Example" src="${exact}" width="0">`,
    `<img alt="Example" src="${exact}" width="961">`,
    `<img alt="Example" src="${exact}" width="100" height="50">`
  ]) {
    assert.throws(() => extractImmutableProductReferences(declaration));
  }
});
