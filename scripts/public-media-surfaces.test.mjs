import assert from "node:assert/strict";
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
import {
  PUBLIC_MEDIA_ASSETS,
  PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH,
  PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES,
  PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES,
  PUBLIC_MEDIA_SERIES_PATH,
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
  immutableProductReference,
  parsePublicMediaVerifierArguments,
  PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS,
  PUBLIC_MEDIA_FETCH_TIMEOUT_MS,
  PUBLIC_MEDIA_FIRST_REQUIRED_VERSION,
  PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  PUBLIC_SURFACE_CONTENT,
  publicMediaVerificationRequired,
  publicSurfaceDefinitions,
  REPRESENTATIVE_PUBLIC_IMAGES
} from "./public-media-surface-contract.mjs";
import {
  assertBoundedRelativeMediaPath,
  assertPngContract,
  inspectLocalPublicMediaInventory,
  resolveVerifiedSourceRoot,
  RetryablePublicMediaObservationError,
  runFreshPublicMediaContextAttempt,
  runPublicMediaPropagation,
  verifyLocalPublicMedia
} from "./verify-public-media-surfaces.mjs";

const sourceSha = "a".repeat(40);
const version = "1.2.1";
const productPrefix = `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/docs/images/readme/v1.2/`;
const root = resolve(import.meta.dirname, "..");

test("public media inventory declares one exact bounded series", () => {
  assert.equal(PUBLIC_MEDIA_SERIES_PATH, "docs/images/readme/v1.2/");
  assert.equal(PUBLIC_MEDIA_ASSETS.length, 45);
  assert.equal(PUBLIC_README_IMAGE_COUNT, 18);
  assert.equal(PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES, 64);
  assert.equal(PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH, 4);
  assert.equal(PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES, 240);
  assert.equal(new Set(PUBLIC_MEDIA_ASSETS.map((asset) => asset.relativePath)).size, PUBLIC_MEDIA_ASSETS.length);
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    assert.match(asset.relativePath, /^(?:[a-z0-9.-]+\/)*[a-z0-9.-]+\.png$/u);
    assert.ok(Number.isSafeInteger(asset.logicalWidth) && asset.logicalWidth > 0);
    assert.ok(Number.isSafeInteger(asset.logicalHeight) && asset.logicalHeight > 0);
    assert.ok(Object.isFrozen(asset));
  }
});

test("the complete checked-in public media inventory satisfies the release-surface contract", () => {
  const result = verifyLocalPublicMedia(
    resolve(root, "docs", "images", "readme", "v1.2"),
    readFileSync(resolve(root, "README.md"), "utf8"),
    readFileSync(resolve(root, "docs", "media-gallery.md"), "utf8")
  );
  assert.equal(result.displayed.length, PUBLIC_README_IMAGE_COUNT);
  assert.match(result.mediaSourceSha, /^[0-9a-f]{40}$/u);
});

test("public surface verification requires one exact source commit and semantic version", () => {
  assert.deepEqual(parsePublicMediaVerifierArguments(["--source-sha", sourceSha, "--version", version]), {
    sourceSha,
    version,
    sourceRoot: undefined,
    waitForPropagation: false
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
      waitForPropagation: true
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
    ["--source-sha", sourceSha, "--version", version, "--source-root", "../release-source"],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "release-source/.."],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "/release-source"],
    ["--source-sha", sourceSha, "--version", version, "--source-root", "--wait-for-propagation"],
    ["--source-sha", sourceSha, "--version", version, "--unexpected", "value"]
  ]) {
    assert.throws(() => parsePublicMediaVerifierArguments(arguments_));
  }
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

test("the injected propagation controller retries only typed registry observations", async () => {
  let terminalAttempts = 0;
  const terminalDelays = [];
  await assert.rejects(
    runPublicMediaPropagation({
      attempt: async () => {
        terminalAttempts += 1;
        throw new Error("deterministic contract failure");
      },
      attempts: 3,
      delayMilliseconds: 10,
      timeoutMilliseconds: 1_000,
      attemptTimeoutMilliseconds: 100,
      sleep: async (milliseconds) => terminalDelays.push(milliseconds),
      report: () => {}
    }),
    /deterministic contract failure/u
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

test("each propagation retry owns and closes one fresh injected browser context", async () => {
  const contexts = [];
  let clock = 0;
  const result = await runPublicMediaPropagation({
    attempts: 3,
    delayMilliseconds: 5,
    timeoutMilliseconds: 1_000,
    attemptTimeoutMilliseconds: 100,
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    report: () => {},
    attempt: ({ attemptNumber, attemptTimeoutMilliseconds }) =>
      runFreshPublicMediaContextAttempt({
        attemptTimeoutMilliseconds,
        cleanupTimeoutMilliseconds: 100,
        createContext: async () => {
          const context = {
            attemptNumber,
            closeCalls: 0,
            async close() {
              this.closeCalls += 1;
            }
          };
          contexts.push(context);
          return context;
        },
        verifyContext: async (context) => {
          if (context.attemptNumber < 3) {
            throw new RetryablePublicMediaObservationError(`stale attempt ${context.attemptNumber}`);
          }
          return "propagated";
        }
      })
  });
  assert.equal(result, "propagated");
  assert.equal(contexts.length, 3);
  assert.equal(new Set(contexts).size, 3);
  assert.deepEqual(
    contexts.map((context) => context.closeCalls),
    [1, 1, 1]
  );
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
    "A dataframe workbench for VS Code, Cursor, and other desktop VS Code forks.",
    "Open files",
    "The active filter matches 14,285 rows."
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
    (alt, index) =>
      `<img width="100" alt="${alt}" src="${productPrefix}gallery/representative-${index}.png" height="50">`
  ).join("\n");
  const references = extractImmutableProductReferences(readme);
  assert.equal(references.length, REPRESENTATIVE_PUBLIC_IMAGES.length);
  assert.deepEqual(
    references.map(({ logicalWidth, logicalHeight, sourceSha: referenceSha }) => ({
      logicalWidth,
      logicalHeight,
      sourceSha: referenceSha
    })),
    [
      { logicalWidth: 100, logicalHeight: 50, sourceSha },
      { logicalWidth: 100, logicalHeight: 50, sourceSha },
      { logicalWidth: 100, logicalHeight: 50, sourceSha }
    ]
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

test("every rendered README image keeps its exact immutable source, 2x natural dimensions, and DPR", () => {
  const expected = {
    alt: "Synthetic public image",
    url: `${productPrefix}gallery/example.png`,
    logicalWidth: 100,
    logicalHeight: 50
  };
  const rendered = {
    alt: expected.alt,
    sourceUrl: expected.url,
    currentUrl: expected.url,
    clientWidth: 96,
    clientHeight: 48,
    naturalWidth: 200,
    naturalHeight: 100,
    devicePixelRatio: 2
  };
  assert.doesNotThrow(() => assertRenderedProductImage("Synthetic", rendered, expected));
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, naturalWidth: 100 }, expected),
    /declared 200x100/u
  );
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, clientWidth: 101 }, expected),
    /would upscale/u
  );
  assert.throws(
    () => assertRenderedProductImage("Synthetic", { ...rendered, devicePixelRatio: 1 }, expected),
    /required DPR 2/u
  );
});

test("public media declarations reject undeclared series and enumerate link-only assets", () => {
  const current = [
    `<a href="https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/docs/images/readme/v1.2/gallery/full.png">`,
    `<img src="${productPrefix}gallery/detail.png" width="100" height="50" alt="Detail">`,
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
      extractImmutableProductReferences(
        `<img alt="Mutable" src="${exact.replace(sourceSha, "main")}" width="100" height="50">`
      ),
    /immutable raw source commit/u
  );
});
