import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import {
  PUBLIC_MEDIA_MAX_FILE_BYTES,
  PUBLIC_MEDIA_MAX_TOTAL_BYTES,
  PUBLIC_MEDIA_PIXEL_RATIO,
  publicMediaPhysicalLength
} from "./public-media-contract.mjs";
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
  assertExpectedSurfaceContent,
  assertExpectedSurfaceVersion,
  assertRepresentativeImageSource,
  assertRenderedProductImage,
  assertSourcePackageVersion,
  expectedRepresentativeReferences,
  extractDeclaredPublicMediaPaths,
  extractImmutableProductReferences,
  extractImmutableReadmeMediaSourceSha,
  parsePublicMediaVerifierArguments,
  PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS,
  PUBLIC_MEDIA_FETCH_TIMEOUT_MS,
  PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  PUBLIC_MEDIA_RESPONSIVE_WIDTHS,
  publicMediaVerificationRequired,
  publicSurfaceDefinitions
} from "./public-media-surface-contract.mjs";

const automationRoot = resolve(import.meta.dirname, "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const FULL_SOURCE_SHA = /^[0-9a-f]{40}$/u;
const PUBLIC_MEDIA_GIT_TIMEOUT_MS = 30_000;

export class RetryablePublicMediaObservationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RetryablePublicMediaObservationError";
  }
}

async function main() {
  await runPublicMediaVerification(parsePublicMediaVerifierArguments(process.argv.slice(2)));
}

export async function runPublicMediaVerification(options, overrides = {}) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Public-media verification requires parsed command options.");
  }
  const { sourceSha, version, sourceRoot, waitForPropagation, prepublish } = options;
  const resolveSourceRoot = overrides.resolveSourceRoot ?? resolveVerifiedSourceRoot;
  const readSource = overrides.readSource ?? ((root, path) => readFileSync(resolve(root, path), "utf8"));
  const verifyLocal = overrides.verifyLocal ?? verifyLocalPublicMedia;
  const verifyAncestry = overrides.verifyAncestry ?? verifyImmutableMediaAncestry;
  const verifySource = overrides.verifySource ?? verifyExactSource;
  const verifyBytes = overrides.verifyBytes ?? verifyImmutablePublicBytes;
  const verifyRendered = overrides.verifyRendered ?? verifyRenderedSurfaces;
  const report = overrides.report ?? ((message) => console.log(message));
  for (const dependency of [
    resolveSourceRoot,
    readSource,
    verifyLocal,
    verifyAncestry,
    verifySource,
    verifyBytes,
    verifyRendered,
    report
  ]) {
    if (typeof dependency !== "function") {
      throw new TypeError("Public-media verification dependencies must be functions.");
    }
  }
  if (!publicMediaVerificationRequired(version)) {
    report(`Public README media verification starts with v1.2.1; historical ${version} recovery is unchanged.`);
    return "historical";
  }
  const root = resolveSourceRoot(sourceRoot);
  const productImageRoot = resolve(root, ...PUBLIC_MEDIA_SERIES_PATH.split("/").filter(Boolean));
  const readme = readSource(root, "README.md");
  const gallery = readSource(root, "docs/media-gallery.md");
  const references = verifyLocal(productImageRoot, readme, gallery);
  verifyAncestry(root, sourceSha, references.mediaSourceSha);
  await verifySource(root, sourceSha, version, readme);
  await verifyBytes(references);
  if (prepublish) {
    report("Prepublication public-media verification completed without browser or registry access.");
    return "prepublish";
  }
  await verifyRendered(sourceSha, version, readme, references, waitForPropagation);
  return "rendered";
}

export function resolveVerifiedSourceRoot(sourceRoot, checkoutRoot = automationRoot) {
  const checkoutMetadata = lstatSync(checkoutRoot);
  if (!checkoutMetadata.isDirectory() || checkoutMetadata.isSymbolicLink()) {
    throw new Error("The automation checkout must identify one real directory.");
  }
  const canonicalAutomationRoot = realpathSync.native(checkoutRoot);
  if (sourceRoot === undefined) return canonicalAutomationRoot;
  const candidate = resolve(checkoutRoot, sourceRoot);
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("--source-root must identify one real directory below the automation checkout.");
  }
  const canonicalCandidate = realpathSync.native(candidate);
  if (!canonicalCandidate.startsWith(`${canonicalAutomationRoot}${sep}`)) {
    throw new Error("--source-root must remain below the automation checkout after canonicalization.");
  }
  return canonicalCandidate;
}

export function verifyLocalPublicMedia(productImageRoot, readme, gallery) {
  const expectedPaths = PUBLIC_MEDIA_ASSETS.map((asset) => asset.relativePath).sort();
  const declaredPaths = extractDeclaredPublicMediaPaths(readme, gallery);
  if (JSON.stringify(declaredPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("README and gallery media references differ from the canonical public-media inventory.");
  }
  const declaredMediaSourceSha = extractImmutableReadmeMediaSourceSha(readme);
  const inventory = inspectLocalPublicMediaInventory(productImageRoot);
  const actualPaths = inventory.files.map((file) => file.relativePath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("The public-media directory differs from the canonical declared inventory.");
  }

  const assetByPath = new Map(PUBLIC_MEDIA_ASSETS.map((asset) => [asset.relativePath, asset]));
  const localBytes = new Map();
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    const file = inventory.byRelativePath.get(asset.relativePath);
    if (file === undefined) throw new Error(`${asset.relativePath} is absent from the preflighted inventory.`);
    const bytes = readPreflightedFile(file);
    assertPngContract(bytes, asset);
    localBytes.set(asset.relativePath, bytes);
  }

  const references = extractImmutableProductReferences(readme);
  if (references.length !== PUBLIC_README_IMAGE_COUNT) {
    throw new Error(`README must expose exactly ${PUBLIC_README_IMAGE_COUNT} immutable public product images.`);
  }
  const seenAlts = new Set();
  const seenPaths = new Set();
  const mediaSourceShas = new Set();
  const displayed = [];
  for (const reference of references) {
    const asset = assetByPath.get(reference.relativePath);
    if (asset === undefined) {
      throw new Error(`${reference.relativePath} is absent from the declared public-media inventory.`);
    }
    const naturalWidth = publicMediaPhysicalLength(asset.logicalWidth);
    const naturalHeight = publicMediaPhysicalLength(asset.logicalHeight);
    if (naturalWidth < reference.displayWidth * PUBLIC_MEDIA_PIXEL_RATIO) {
      throw new Error(`${reference.relativePath} does not supply two source pixels per declared CSS pixel.`);
    }
    if (seenAlts.has(reference.alt) || seenPaths.has(reference.relativePath)) {
      throw new Error("README public product images require unique alt text and source paths.");
    }
    seenAlts.add(reference.alt);
    seenPaths.add(reference.relativePath);
    mediaSourceShas.add(reference.sourceSha);
    displayed.push({ ...reference, naturalWidth, naturalHeight });
  }
  if (mediaSourceShas.size !== 1) {
    throw new Error("README public product images must share one immutable reviewed media commit.");
  }
  const mediaSourceSha = [...mediaSourceShas][0];
  if (declaredMediaSourceSha !== mediaSourceSha) {
    throw new Error("README image sources and full-size product-media links must share one reviewed commit.");
  }
  console.log(
    `Verified ${PUBLIC_MEDIA_ASSETS.length} declared sRGB PNGs and width-only README presentations within the media budgets.`
  );
  return { displayed, localBytes, mediaSourceSha };
}

export function verifyImmutableMediaAncestry(root, sourceSha, mediaSourceSha, runGit = runBoundedGit) {
  if (
    typeof root !== "string" ||
    !FULL_SOURCE_SHA.test(sourceSha) ||
    !FULL_SOURCE_SHA.test(mediaSourceSha) ||
    typeof runGit !== "function"
  ) {
    throw new TypeError("Public-media ancestry requires one repository and two exact lowercase commit IDs.");
  }
  for (const [label, sha] of [
    ["release source", sourceSha],
    ["README media source", mediaSourceSha]
  ]) {
    const result = runGit(root, ["rev-parse", "--verify", `${sha}^{commit}`]);
    if (result?.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim() !== sha) {
      throw new Error(`The selected checkout does not contain the exact ${label} commit.`);
    }
  }
  const ancestry = runGit(root, ["merge-base", "--is-ancestor", mediaSourceSha, sourceSha]);
  if (ancestry?.status === 1) {
    throw new Error("The immutable README media commit must be an ancestor of the exact release source.");
  }
  if (ancestry?.status !== 0) {
    throw new Error("The immutable README media ancestry could not be verified in the selected checkout.");
  }
  console.log(`Verified immutable README media ancestry ${mediaSourceSha}..${sourceSha}.`);
}

export function runBoundedGit(root, arguments_, spawn = spawnSync) {
  if (typeof spawn !== "function") throw new TypeError("Public-media Git verification requires one spawn function.");
  return spawn("git", ["-C", root, ...arguments_], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PUBLIC_MEDIA_GIT_TIMEOUT_MS,
    windowsHide: true
  });
}

export async function verifyExactSource(root, sourceSha, version, localReadme, fetchSource = fetchBounded) {
  if (typeof fetchSource !== "function") {
    throw new TypeError("Exact public-media source verification requires one bounded fetch function.");
  }
  const localPackage = readFileSync(resolve(root, "package.json"), "utf8");
  assertSourcePackageVersion(localPackage, version);

  const remoteReadme = await fetchSource(
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/README.md`
  );
  if (!remoteReadme.equals(Buffer.from(localReadme))) {
    throw new Error("The exact source commit README does not byte-match the reviewed local README.");
  }
  const remotePackage = await fetchSource(
    `https://raw.githubusercontent.com/Matt17BR/openwrangler/${sourceSha}/package.json`
  );
  assertSourcePackageVersion(remotePackage.toString("utf8"), version);
  console.log(`Verified exact source ${sourceSha} at version ${version}.`);
}

export async function verifyImmutablePublicBytes(references, fetchMedia = fetch) {
  for (const asset of PUBLIC_MEDIA_ASSETS) {
    const local = references.localBytes.get(asset.relativePath);
    if (local === undefined) throw new Error(`${asset.relativePath} is absent from the verified local byte set.`);
    const source =
      `https://raw.githubusercontent.com/Matt17BR/openwrangler/${references.mediaSourceSha}/` +
      `${PUBLIC_MEDIA_SERIES_PATH}${asset.relativePath}`;
    const response = await fetchMedia(source, {
      headers: { "user-agent": "Open-Wrangler-public-media-verifier" },
      redirect: "follow",
      signal: AbortSignal.timeout(PUBLIC_MEDIA_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Could not fetch immutable public media: HTTP ${response.status}.`);
    const remote = await readBoundedResponse(response, source);
    if (!remote.equals(local)) {
      throw new Error(
        `${asset.relativePath} differs from its immutable remote bytes ` +
          `(${sha256(local)} locally, ${sha256(remote)} remotely).`
      );
    }
  }
  references.localBytes.clear();
  console.log(`Verified all ${PUBLIC_MEDIA_ASSETS.length} immutable public PNG payloads byte-for-byte.`);
}

async function verifyRenderedSurfaces(sourceSha, version, readme, references, waitForPropagation) {
  const representatives = expectedRepresentativeReferences(readme).map((representative) => {
    const displayed = references.displayed.find(
      (image) =>
        image.alt === representative.alt &&
        image.url === representative.url &&
        image.displayWidth === representative.displayWidth
    );
    if (displayed === undefined) {
      throw new Error("Rendered public-media verification omitted one required representative image.");
    }
    return displayed;
  });
  const surfaces = publicSurfaceDefinitions(sourceSha);
  const sourceSurfaces = surfaces.filter((surface) => surface.versionKind === "source");
  const registrySurfaces = surfaces.filter((surface) => surface.versionKind !== "source");
  if (sourceSurfaces.length !== 1 || registrySurfaces.length !== surfaces.length - 1) {
    throw new Error("Public-media rendering requires one exact source surface followed by registry surfaces.");
  }
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  const verifySurfaces = (selectedSurfaces, attemptTimeoutMilliseconds) =>
    runFreshPublicMediaContextAttempt({
      attemptTimeoutMilliseconds,
      createContext: async () => {
        const context = await browser.newContext({
          viewport: { width: Math.max(...PUBLIC_MEDIA_RESPONSIVE_WIDTHS), height: 1_000 },
          deviceScaleFactor: PUBLIC_MEDIA_PIXEL_RATIO
        });
        context.setDefaultTimeout(30_000);
        context.setDefaultNavigationTimeout(60_000);
        return context;
      },
      verifyContext: (context) =>
        verifyRenderedSurfacesInContext(
          context,
          sourceSha,
          version,
          references.displayed,
          representatives,
          selectedSurfaces
        )
    });
  try {
    if (waitForPropagation) {
      await runPublicMediaPropagation({
        verifySourceOnce: ({ attemptTimeoutMilliseconds }) =>
          verifySurfaces(sourceSurfaces, attemptTimeoutMilliseconds),
        attempt: ({ attemptTimeoutMilliseconds }) => verifySurfaces(registrySurfaces, attemptTimeoutMilliseconds)
      });
    } else {
      await runPublicMediaPropagation({
        attempts: 1,
        attempt: ({ attemptTimeoutMilliseconds }) => verifySurfaces(surfaces, attemptTimeoutMilliseconds)
      });
    }
  } finally {
    await browser.close();
  }
}

export async function runPublicMediaPropagation({
  attempt,
  verifySourceOnce,
  attempts = PUBLIC_MEDIA_PROPAGATION_ATTEMPTS,
  delayMilliseconds = PUBLIC_MEDIA_PROPAGATION_DELAY_MS,
  timeoutMilliseconds = PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS,
  attemptTimeoutMilliseconds = PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS,
  now = Date.now,
  sleep = delay,
  report = (message) => console.log(message)
}) {
  if (
    typeof attempt !== "function" ||
    (verifySourceOnce !== undefined && typeof verifySourceOnce !== "function") ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    typeof report !== "function"
  ) {
    throw new TypeError("Public-media propagation requires injected attempt, clock, delay, and report functions.");
  }
  for (const value of [attempts, delayMilliseconds, timeoutMilliseconds, attemptTimeoutMilliseconds]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Public-media propagation bounds must be positive safe integers.");
    }
  }
  const startedAt = now();
  const deadline = startedAt + timeoutMilliseconds;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline)) {
    throw new TypeError("The public-media propagation clock must return a bounded integer timestamp.");
  }
  if (verifySourceOnce !== undefined) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Public README media exceeded its bounded propagation deadline.");
    await verifySourceOnce({ attemptTimeoutMilliseconds: Math.min(remaining, attemptTimeoutMilliseconds) });
  }
  for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Public README media exceeded its bounded propagation deadline.");
    try {
      return await attempt({
        attemptNumber,
        attemptTimeoutMilliseconds: Math.min(remaining, attemptTimeoutMilliseconds)
      });
    } catch (error) {
      if (!(error instanceof RetryablePublicMediaObservationError)) throw error;
      if (attemptNumber === attempts) throw error;
      report(`Public README media has not propagated (attempt ${attemptNumber}/${attempts}): ${boundedError(error)}`);
      const boundedDelay = Math.min(delayMilliseconds, Math.max(0, deadline - now()));
      if (boundedDelay <= 0) throw new Error("Public README media exceeded its bounded propagation deadline.");
      await sleep(boundedDelay);
    }
  }
  throw new Error("Public README media exhausted its bounded propagation attempts.");
}

export async function runFreshPublicMediaContextAttempt({
  createContext,
  verifyContext,
  attemptTimeoutMilliseconds,
  cleanupTimeoutMilliseconds = PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS
}) {
  if (typeof createContext !== "function" || typeof verifyContext !== "function") {
    throw new TypeError("A public-media render attempt requires injected context creation and verification.");
  }
  for (const value of [attemptTimeoutMilliseconds, cleanupTimeoutMilliseconds]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("Public-media render and cleanup bounds must be positive safe integers.");
    }
  }
  let context;
  let expired = false;
  const work = (async () => {
    const created = await createContext();
    context = created;
    if (expired) {
      await closeContextBounded(created, cleanupTimeoutMilliseconds).catch(() => {});
      throw new Error("A public-media browser context completed after its attempt deadline.");
    }
    return verifyContext(created);
  })();
  let timeout;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("One public README media render attempt exceeded its bounded deadline.")),
          attemptTimeoutMilliseconds
        );
      })
    ]);
  } finally {
    expired = true;
    clearTimeout(timeout);
    void work.catch(() => {});
    if (context !== undefined) await closeContextBounded(context, cleanupTimeoutMilliseconds);
  }
}

async function verifyRenderedSurfacesInContext(
  context,
  sourceSha,
  version,
  displayedImages,
  representativeImages,
  surfaces
) {
  const page = await context.newPage();
  for (const surface of surfaces) {
    await page.setViewportSize({ width: Math.max(...PUBLIC_MEDIA_RESPONSIVE_WIDTHS), height: 1_000 });
    const navigationResponse = await page.goto(surface.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assertPublicMediaNavigationResponse(surface, navigationResponse);
    if (surface.versionKind === "source") {
      assertExactSourceReadmeUrl(page.url(), sourceSha);
    } else if (surface.versionKind === "marketplace") {
      const renderedVersion = page.locator('td[role="definition"][aria-labelledby="version"]');
      await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
      const renderedVersionText = (await renderedVersion.innerText()).trim();
      assertObservedRegistryState(surface, "still exposes stale version metadata", () =>
        assertExpectedSurfaceVersion(surface.name, renderedVersionText, version)
      );
    } else {
      const renderedVersion = page.locator('select[aria-label="Version"]');
      await renderedVersion.waitFor({ state: "attached", timeout: 30_000 });
      const renderedVersionText = await renderedVersion.inputValue();
      assertObservedRegistryState(surface, "still exposes stale version metadata", () =>
        assertExpectedSurfaceVersion(surface.name, renderedVersionText, version)
      );
    }
    const bodyText = await page.locator("body").innerText();
    assertObservedRegistryState(surface, "still exposes stale README content", () =>
      assertExpectedSurfaceContent(surface.name, bodyText)
    );

    for (const expected of displayedImages) {
      const dimensions = await measureRenderedImage(page, surface, expected);
      assertObservedRegistryState(surface, "still exposes stale README image sources", () =>
        assertRepresentativeImageSource(surface.name, dimensions, expected.url)
      );
      assertRenderedProductImage(surface.name, dimensions, expected);
    }
    for (const width of PUBLIC_MEDIA_RESPONSIVE_WIDTHS) {
      await page.setViewportSize({ width, height: 1_000 });
      for (const expected of representativeImages) {
        const dimensions = await measureRenderedImage(page, surface, expected);
        assertRenderedProductImage(`${surface.name} at ${width}px`, dimensions, expected);
      }
    }
    console.log(
      `Verified version, content, immutable sources, and ${displayedImages.length} DPR ${PUBLIC_MEDIA_PIXEL_RATIO} ` +
        `README images on ${surface.name}, including responsive checks at ${PUBLIC_MEDIA_RESPONSIVE_WIDTHS.join("/")}px.`
    );
  }
}

export function observeRenderedImageInPage(options, environment = globalThis) {
  const { alt, timeoutMilliseconds } = options ?? {};
  if (
    typeof alt !== "string" ||
    alt.length === 0 ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1
  ) {
    throw new TypeError("Rendered-image observation requires exact alt text and one positive timeout.");
  }
  const document_ = environment.document;
  return new Promise((resolve, reject) => {
    let frame;
    let timer;
    let done = false;
    let candidate;
    let scrolled;
    let priorContainer;
    let priorProof;
    let failure = { kind: "terminal", reason: "the exact-alt image did not reach a stable rendered state" };
    let terminalReason;
    let sawCandidate = false;
    let sawProof = false;

    const cleanup = () => {
      if (frame !== undefined) environment.cancelAnimationFrame(frame);
      if (timer !== undefined) environment.clearTimeout(timer);
      frame = timer = undefined;
    };
    const settle = (callback, value) => {
      if (done) return;
      done = true;
      cleanup();
      callback(value);
    };
    const invalidate = (reason, kind, nextCandidate) => {
      if (candidate !== nextCandidate) scrolled = undefined;
      candidate = nextCandidate;
      priorContainer = priorProof = undefined;
      if (kind === "terminal") terminalReason ??= reason;
      failure = { kind: terminalReason === undefined ? kind : "terminal", reason: terminalReason ?? reason };
    };
    const visible = (element) => {
      const style = environment.getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        style.contentVisibility !== "hidden" &&
        (!Number.isFinite(opacity) || opacity > 0)
      );
    };
    const schedule = () => {
      frame = environment.requestAnimationFrame(sample);
    };
    const sample = () => {
      frame = undefined;
      try {
        const matches = [...document_.querySelectorAll("img")].filter((element) => element.alt === alt);
        if (matches.length !== 1) {
          invalidate(
            `expected exactly one exact-alt image but observed ${matches.length}`,
            matches.length === 0 && !sawCandidate ? "registry-stale" : "terminal",
            undefined
          );
          schedule();
          return;
        }
        const image = matches[0];
        if (image !== candidate) {
          if (sawCandidate) {
            invalidate("the exact-alt image was replaced before two stable post-scroll frames", "terminal", image);
          } else {
            candidate = image;
            scrolled = priorContainer = priorProof = undefined;
            failure = { kind: "terminal", reason: "the exact-alt image did not reach a stable rendered state" };
          }
        }
        sawCandidate = true;
        if (!image.isConnected) {
          invalidate("the exact-alt image was disconnected", "terminal", undefined);
          schedule();
          return;
        }
        if (scrolled !== image) {
          image.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
          scrolled = image;
          priorContainer = priorProof = undefined;
          schedule();
          return;
        }

        let container = image.closest("td");
        for (
          let ancestor = image.parentElement;
          container === null && ancestor !== null;
          ancestor = ancestor.parentElement
        ) {
          const display = environment.getComputedStyle(ancestor).display;
          if (["block", "flex", "grid", "table-cell"].includes(display)) container = ancestor;
        }
        container ??= document_.body;
        if (!container.isConnected) {
          invalidate("the rendered image container was disconnected", "terminal", image);
          schedule();
          return;
        }
        if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          invalidate("the exact-alt image remained incomplete", sawProof ? "terminal" : "registry-stale", image);
          schedule();
          return;
        }
        if (!visible(image) || !visible(container)) {
          invalidate("the exact-alt image or its container remained CSS-hidden", "terminal", image);
          schedule();
          return;
        }
        const bounds = image.getBoundingClientRect();
        const containerBounds = container.getBoundingClientRect();
        if (
          [bounds, containerBounds].some(({ width, height, left, right }) =>
            [width, height, left, right].some((value) => !Number.isFinite(value))
          ) ||
          [
            bounds.width,
            bounds.height,
            containerBounds.width,
            containerBounds.height,
            image.naturalWidth,
            image.naturalHeight,
            environment.innerWidth,
            environment.devicePixelRatio
          ].some((value) => !Number.isFinite(value) || value <= 0)
        ) {
          invalidate("the exact-alt image or its container retained invalid geometry", "terminal", image);
          schedule();
          return;
        }
        const proof = {
          alt: image.alt,
          sourceUrl: image.getAttribute("src"),
          currentUrl: image.currentSrc,
          clientWidth: bounds.width,
          clientHeight: bounds.height,
          clientLeft: bounds.left,
          clientRight: bounds.right,
          viewportWidth: environment.innerWidth,
          containerWidth: containerBounds.width,
          containerLeft: containerBounds.left,
          containerRight: containerBounds.right,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          devicePixelRatio: environment.devicePixelRatio
        };
        sawProof = true;
        if (
          priorContainer === container &&
          Object.keys(proof).every((key) => Object.is(priorProof?.[key], proof[key]))
        ) {
          settle(resolve, { ready: true, value: proof });
          return;
        }
        priorContainer = container;
        priorProof = proof;
        failure = {
          kind: "terminal",
          reason: "the exact-alt image geometry did not stabilize across two post-scroll frames"
        };
        schedule();
      } catch (error) {
        settle(reject, error);
      }
    };

    timer = environment.setTimeout(() => settle(resolve, { ready: false, ...failure }), timeoutMilliseconds);
    try {
      schedule();
    } catch (error) {
      settle(reject, error);
    }
  });
}

export function assertPublicMediaNavigationResponse(surface, navigationResponse) {
  if (navigationResponse === null) {
    throw new Error(`${surface.name} navigation completed without an HTTP response.`);
  }
  if (!navigationResponse.ok()) {
    observeRegistryPropagation(surface, "is unavailable", {
      ready: false,
      kind: "registry-unavailable",
      reason: `navigation returned HTTP ${navigationResponse.status()}`
    });
  }
}

async function measureRenderedImage(page, surface, expected) {
  const observation = await page.evaluate(observeRenderedImageInPage, {
    alt: expected.alt,
    timeoutMilliseconds: 30_000
  });
  return observeRegistryPropagation(surface, "has not rendered one stable complete README image", observation);
}

export function assertPngContract(bytes, asset) {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${asset.relativePath} is not a PNG file.`);
  }
  let offset = PNG_SIGNATURE.length;
  let index = 0;
  let idatBytes = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawSrgb = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`${asset.relativePath} contains a malformed PNG chunk sequence.`);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new Error(`${asset.relativePath} contains an invalid PNG chunk type.`);
    const expectedCrc = bytes.readUInt32BE(end - 4);
    const actualCrc = crc32(bytes.subarray(offset + 4, end - 4));
    if (actualCrc !== expectedCrc) throw new Error(`${asset.relativePath} contains an invalid ${type} chunk CRC.`);
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error(`${asset.relativePath} must start with one standard PNG IHDR chunk.`);
      }
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (
        width !== publicMediaPhysicalLength(asset.logicalWidth) ||
        height !== publicMediaPhysicalLength(asset.logicalHeight)
      ) {
        throw new Error(`${asset.relativePath} differs from its declared exact 2x physical dimensions.`);
      }
      if (
        bytes[offset + 16] !== 8 ||
        (bytes[offset + 17] !== 2 && bytes[offset + 17] !== 6) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      ) {
        throw new Error(`${asset.relativePath} must use the reviewed non-interlaced 8-bit RGB or RGBA PNG format.`);
      }
    } else if (type === "IHDR") {
      throw new Error(`${asset.relativePath} contains more than one PNG IHDR chunk.`);
    }
    if (type === "sRGB") {
      if (sawSrgb || sawIdat || length !== 1 || bytes[offset + 8] !== 0) {
        throw new Error(`${asset.relativePath} must declare one standard perceptual sRGB chunk.`);
      }
      sawSrgb = true;
    }
    if (type === "IDAT") {
      if (endedIdat) throw new Error(`${asset.relativePath} contains non-consecutive PNG IDAT chunks.`);
      sawIdat = true;
      idatBytes += length;
    } else if (sawIdat && type !== "IEND") {
      endedIdat = true;
    }
    offset = end;
    index += 1;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) {
        throw new Error(`${asset.relativePath} contains a malformed PNG terminator.`);
      }
      if (!sawSrgb) throw new Error(`${asset.relativePath} must declare the standard sRGB color space.`);
      if (!sawIdat || idatBytes === 0) throw new Error(`${asset.relativePath} must contain PNG image data.`);
      let decoded;
      try {
        decoded = PNG.sync.read(bytes, { checkCRC: true });
      } catch {
        throw new Error(`${asset.relativePath} could not be decoded as the declared PNG image.`);
      }
      if (
        decoded.width !== publicMediaPhysicalLength(asset.logicalWidth) ||
        decoded.height !== publicMediaPhysicalLength(asset.logicalHeight)
      ) {
        throw new Error(`${asset.relativePath} decoded to unexpected physical dimensions.`);
      }
      return;
    }
  }
  throw new Error(`${asset.relativePath} contains a malformed PNG chunk sequence.`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectLocalPublicMediaInventory(root) {
  const rootMetadata = lstatSync(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The public-media root must be one real directory.");
  }
  const directories = [{ absolutePath: root, depth: 0 }];
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  while (directories.length > 0) {
    const directory = directories.shift();
    const handle = opendirSync(directory.absolutePath);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entryCount += 1;
        if (entryCount > PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES) {
          throw new Error("The public-media inventory exceeds its bounded entry count.");
        }
        const absolutePath = resolve(directory.absolutePath, entry.name);
        const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
        assertBoundedRelativeMediaPath(relativePath);
        const metadata = lstatSync(absolutePath);
        if (metadata.isSymbolicLink()) throw new Error("Public-media inventory may not contain symbolic links.");
        if (metadata.isDirectory()) {
          const depth = directory.depth + 1;
          if (depth > PUBLIC_MEDIA_MAX_DIRECTORY_DEPTH) {
            throw new Error("The public-media inventory exceeds its bounded directory depth.");
          }
          directories.push({ absolutePath, depth });
        } else if (metadata.isFile() && entry.name.endsWith(".png")) {
          if (metadata.size > PUBLIC_MEDIA_MAX_FILE_BYTES) {
            throw new Error(`${relativePath} exceeds the public-media file budget.`);
          }
          totalBytes += metadata.size;
          if (totalBytes > PUBLIC_MEDIA_MAX_TOTAL_BYTES) {
            throw new Error("The complete public-media inventory exceeds its bounded size budget.");
          }
          files.push({
            absolutePath,
            relativePath,
            size: metadata.size,
            device: metadata.dev,
            inode: metadata.ino
          });
        } else {
          throw new Error("Public-media inventory may contain only regular PNG files and directories.");
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  files.sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    return 0;
  });
  return {
    files,
    byRelativePath: new Map(files.map((file) => [file.relativePath, file])),
    totalBytes
  };
}

export function assertBoundedRelativeMediaPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    Buffer.byteLength(relativePath, "utf8") > PUBLIC_MEDIA_MAX_RELATIVE_PATH_BYTES
  ) {
    throw new Error("The public-media inventory contains an overlong or malformed relative path.");
  }
}

function readPreflightedFile(file) {
  const descriptor = openSync(file.absolutePath, fileSystemConstants.O_RDONLY | (fileSystemConstants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.dev !== file.device ||
      metadata.ino !== file.inode ||
      metadata.size !== file.size ||
      metadata.size > PUBLIC_MEDIA_MAX_FILE_BYTES
    ) {
      throw new Error(`${file.relativePath} changed after public-media inventory preflight.`);
    }
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${file.relativePath} changed while its bytes were read.`);
      offset += count;
    }
    const trailing = Buffer.allocUnsafe(1);
    if (readSync(descriptor, trailing, 0, 1, offset) !== 0) {
      throw new Error(`${file.relativePath} grew while its bytes were read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function observeRegistryPropagation(surface, description, observation) {
  if (
    typeof surface?.name !== "string" ||
    !["source", "marketplace", "open-vsx"].includes(surface?.versionKind) ||
    typeof description !== "string" ||
    description.length === 0
  ) {
    throw new TypeError("Registry propagation requires one surface, description, and semantic observation.");
  }
  if (observation?.ready === true) return observation.value;
  if (
    observation?.ready !== false ||
    !["registry-stale", "registry-unavailable", "terminal"].includes(observation?.kind) ||
    typeof observation?.reason !== "string" ||
    observation.reason.length === 0
  ) {
    throw new TypeError(
      "A semantic propagation observation must be explicitly ready or carry one classified failure reason."
    );
  }
  const cause = Object.hasOwn(observation, "cause")
    ? observation.cause
    : new Error(`${surface.name} ${description}: ${boundedError(observation.reason)}`);
  if (surface.versionKind === "source" || observation.kind === "terminal") throw cause;
  throw new RetryablePublicMediaObservationError(
    `${surface.name} ${description}: ${boundedError(observation.cause ?? observation.reason)}`,
    { cause }
  );
}

function assertObservedRegistryState(surface, description, assertion) {
  try {
    return assertion();
  } catch (error) {
    return observeRegistryPropagation(surface, description, {
      ready: false,
      kind: "registry-stale",
      reason: boundedError(error),
      cause: error
    });
  }
}

async function closeContextBounded(context, timeoutMilliseconds) {
  let timeout;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Public-media browser-context cleanup exceeded its bounded deadline.")),
          timeoutMilliseconds
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function boundedError(error) {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").trim();
  return text.length <= 320 ? text : `${text.slice(0, 317)}...`;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBoundedResponse(response, source) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > PUBLIC_MEDIA_MAX_FILE_BYTES)
  ) {
    throw new Error(`${source} exceeds the public-media file budget.`);
  }
  if (!response.body) throw new Error(`${source} returned no response body.`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > PUBLIC_MEDIA_MAX_FILE_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error(`${source} exceeds the public-media file budget.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function fetchBounded(source) {
  const response = await fetch(source, {
    headers: { "user-agent": "Open-Wrangler-public-media-verifier" },
    redirect: "follow",
    signal: AbortSignal.timeout(PUBLIC_MEDIA_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Could not fetch ${source}: HTTP ${response.status}.`);
  return readBoundedResponse(response, source);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
