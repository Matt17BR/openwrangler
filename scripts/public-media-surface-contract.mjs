import { PUBLIC_MEDIA_PIXEL_RATIO } from "./public-media-contract.mjs";
import {
  PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES,
  PUBLIC_MEDIA_ROOT_PATH,
  PUBLIC_MEDIA_SERIES_PATH,
  PUBLIC_README_FULL_SIZE_LINKS,
  PUBLIC_README_IMAGE_COUNT
} from "./public-media-inventory.mjs";

const FULL_SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SAFE_SOURCE_ROOT = /^(?!\.\.?(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

const REPOSITORY_PATH = "/Matt17BR/openwrangler/";

export const PUBLIC_MEDIA_PROPAGATION_ATTEMPTS = 40;
export const PUBLIC_MEDIA_PROPAGATION_DELAY_MS = 30_000;
export const PUBLIC_MEDIA_PROPAGATION_TIMEOUT_MS = 30 * 60_000;
export const PUBLIC_MEDIA_RENDER_ATTEMPT_TIMEOUT_MS = 3 * 60_000;
export const PUBLIC_MEDIA_FETCH_TIMEOUT_MS = 60_000;
export const PUBLIC_MEDIA_CONTEXT_CLEANUP_TIMEOUT_MS = 10_000;
export const PUBLIC_MEDIA_FIRST_REQUIRED_VERSION = "1.2.1";
export const PUBLIC_MEDIA_FIRST_PREPUBLICATION_VERSION = "1.99.4";
export const PUBLIC_MEDIA_MAX_DISPLAY_WIDTH = 960;
export const PUBLIC_MEDIA_RESPONSIVE_WIDTHS = Object.freeze([760, 1_400]);

export const PUBLIC_SURFACE_CONTENT = [
  "Open source dataframe workbench for VS Code and Cursor: Pandas and Polars editing, experimental DuckDB file editing and relation viewing, stable PySpark 4.2.x notebook viewing, and preview native R.",
  "Open files",
  "The active filter matches 14,287 rows."
];

export const REPRESENTATIVE_PUBLIC_IMAGES = [
  "Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views",
  "Revenue column profile with Counts and % controls and a focused 20,174 to 21,357 bin tooltip showing 398 rows (0.4%)",
  "PySpark dataframe grid beside the revenue profile, with Source Order, Viewing Only, and PySpark badges",
  "An R Group and aggregate draft for regional orders with cleaning history, Apply and Discard controls, and generated R"
];

export function parsePublicMediaVerifierArguments(arguments_) {
  const values = new Map();
  let waitForPropagation = false;
  let prepublish = false;
  for (let index = 0; index < arguments_.length;) {
    const name = arguments_[index];
    if (name === "--wait-for-propagation") {
      if (waitForPropagation) throw new Error("--wait-for-propagation may be supplied only once.");
      waitForPropagation = true;
      index += 1;
      continue;
    }
    if (name === "--prepublish") {
      if (prepublish) throw new Error("--prepublish may be supplied only once.");
      prepublish = true;
      index += 1;
      continue;
    }
    const value = arguments_[index + 1];
    if (
      (name !== "--source-sha" && name !== "--version" && name !== "--source-root") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw usageError();
    }
    if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
    values.set(name, value);
    index += 2;
  }

  const sourceSha = values.get("--source-sha");
  const version = values.get("--version");
  const sourceRoot = values.get("--source-root");
  if (sourceSha === undefined || version === undefined) throw usageError();
  if (!FULL_SOURCE_SHA.test(sourceSha)) {
    throw new Error("--source-sha must be one exact lowercase 40-hex source commit.");
  }
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error("--version must be one exact semantic version without a leading v.");
  }
  if (
    sourceRoot !== undefined &&
    (!SAFE_SOURCE_ROOT.test(sourceRoot) || sourceRoot.split("/").some((part) => part === "." || part === ".."))
  ) {
    throw new Error("--source-root must be one bounded relative path below the automation checkout.");
  }
  if (prepublish && waitForPropagation) {
    throw new Error("--prepublish cannot be combined with --wait-for-propagation.");
  }
  return { sourceSha, version, sourceRoot, waitForPropagation, prepublish };
}

export function publicMediaVerificationRequired(version) {
  return versionAtLeast(version, PUBLIC_MEDIA_FIRST_REQUIRED_VERSION);
}

export function publicMediaPrepublicationRequired(version) {
  return versionAtLeast(version, PUBLIC_MEDIA_FIRST_PREPUBLICATION_VERSION);
}

function versionAtLeast(version, minimum) {
  if (!SEMANTIC_VERSION.test(version)) throw new TypeError("A public-media release version must be semantic.");
  const actual = version.split(/[+-]/u, 1)[0].split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

export function publicSurfaceDefinitions(sourceSha) {
  if (!FULL_SOURCE_SHA.test(sourceSha)) throw new TypeError("A public surface requires one exact source commit.");
  return [
    {
      name: "GitHub",
      url: `https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/README.md`,
      versionKind: "source"
    },
    {
      name: "Visual Studio Marketplace",
      url: "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler",
      versionKind: "marketplace"
    },
    {
      name: "Open VSX",
      url: "https://open-vsx.org/extension/Matt17BR/openwrangler",
      versionKind: "open-vsx"
    }
  ];
}

export function assertExactSourceReadmeUrl(actualUrl, sourceSha) {
  const expected = `https://github.com/Matt17BR/openwrangler/blob/${sourceSha}/README.md`;
  if (actualUrl !== expected) {
    throw new Error(`GitHub did not retain the exact source README URL: expected ${expected}, received ${actualUrl}.`);
  }
}

export function assertExpectedSurfaceContent(surfaceName, text) {
  for (const expected of PUBLIC_SURFACE_CONTENT) {
    if (!text.includes(expected)) {
      throw new Error(`${surfaceName} does not render the expected README content: ${JSON.stringify(expected)}.`);
    }
  }
}

export function assertExpectedSurfaceVersion(surfaceName, actualVersion, expectedVersion) {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      `${surfaceName} renders version ${JSON.stringify(actualVersion)} instead of ${JSON.stringify(expectedVersion)}.`
    );
  }
}

export function assertSourcePackageVersion(packageSource, expectedVersion) {
  let packageJson;
  try {
    packageJson = JSON.parse(packageSource);
  } catch {
    throw new Error("The exact source commit returned malformed package metadata.");
  }
  assertExpectedSurfaceVersion("GitHub source package", packageJson.version, expectedVersion);
}

export function extractImmutableProductReferences(readme) {
  assertDeclaredPublicMediaSeries(readme);
  const references = [];
  for (const match of readme.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    const source = htmlAttribute(tag, "src");
    if (source === undefined) continue;
    const reference = immutableProductReference(source);
    if (reference === undefined) {
      if (repositoryProductMediaPath(source)?.startsWith(PUBLIC_MEDIA_SERIES_PATH)) {
        throw new Error("README public product images must use one immutable raw source commit.");
      }
      continue;
    }
    const alt = htmlAttribute(tag, "alt");
    if (alt === undefined || alt.trim() === "") {
      throw new Error("README public product media requires a non-empty alt attribute.");
    }
    if (htmlAttribute(tag, "height") !== undefined) {
      throw new Error("README public product media must let the PNG aspect ratio determine its height.");
    }
    references.push({
      ...reference,
      alt,
      displayWidth: displayWidth(tag)
    });
    if (references.length > PUBLIC_README_IMAGE_COUNT) {
      throw new Error(`README may declare at most ${PUBLIC_README_IMAGE_COUNT} public product images.`);
    }
  }
  return references;
}

export function extractImmutableReadmeMediaSourceSha(readme) {
  const sourceShas = new Set();
  let referenceCount = 0;
  for (const match of readme.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    const value = match[1] ?? match[2] ?? "";
    const assetPath = repositoryProductMediaPath(value);
    if (assetPath !== "assets/icon.png" && !assetPath?.startsWith(PUBLIC_MEDIA_SERIES_PATH)) continue;
    const reference = immutableRepositoryProductMediaReference(value);
    if (reference === undefined) {
      throw new Error("README product-media links must use one immutable reviewed source commit.");
    }
    sourceShas.add(reference.sourceSha);
    referenceCount += 1;
    if (referenceCount > PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES) {
      throw new Error("README product-media links exceed their bounded reference count.");
    }
  }
  const fullSizeByDisplayPath = new Map(
    PUBLIC_README_FULL_SIZE_LINKS.map(({ displayPath, fullSizePath }) => [displayPath, fullSizePath])
  );
  const linkedImageUrls = new Set();
  for (const match of readme.matchAll(/<a\b([^>]*)>\s*(<img\b[^>]*>)\s*<\/a>/giu)) {
    const imageSource = htmlAttribute(match[2], "src");
    const imageReference = imageSource === undefined ? undefined : immutableProductReference(imageSource);
    if (imageReference === undefined) continue;
    const target = immutableRepositoryProductMediaReference(htmlAttribute(match[1], "href") ?? "");
    if (target === undefined || target.sourceSha !== imageReference.sourceSha) {
      throw new Error("Every README product image must link to one immutable full-size asset at its reviewed commit.");
    }
    const expectedFullSize = fullSizeByDisplayPath.get(imageReference.relativePath);
    if (expectedFullSize === undefined) {
      throw new Error("A README product image is absent from the canonical full-size link contract.");
    }
    const expectedFullSizePath = `${PUBLIC_MEDIA_SERIES_PATH}${expectedFullSize}`;
    if (target.assetPath !== expectedFullSizePath) {
      throw new Error("A README product image links to the wrong full-size public-media asset.");
    }
    linkedImageUrls.add(imageReference.url);
  }
  const displayed = extractImmutableProductReferences(readme);
  if (displayed.some((reference) => !linkedImageUrls.has(reference.url))) {
    throw new Error("Every README product image must have one immutable full-size public-media link.");
  }
  if (referenceCount === 0 || sourceShas.size !== 1) {
    throw new Error("README product-media links must share one immutable reviewed source commit.");
  }
  return [...sourceShas][0];
}

export function extractDeclaredPublicMediaPaths(...documents) {
  const paths = new Set();
  for (const document of documents) {
    assertDeclaredPublicMediaSeries(document);
    for (const match of document.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
      const assetPath = repositoryProductMediaPath(match[1] ?? match[2] ?? "");
      if (assetPath?.startsWith(PUBLIC_MEDIA_SERIES_PATH) && assetPath.endsWith(".png")) {
        paths.add(validatedRelativePath(assetPath.slice(PUBLIC_MEDIA_SERIES_PATH.length)));
        if (paths.size > PUBLIC_MEDIA_MAX_INVENTORY_ENTRIES) {
          throw new Error("Public product-media declarations exceed their bounded inventory count.");
        }
      }
    }
  }
  return [...paths].sort();
}

export function assertDeclaredPublicMediaSeries(document) {
  for (const match of document.matchAll(/(?:docs\/)?images\/readme\/[A-Za-z0-9._-]+\//gu)) {
    const assetPath = match[0].startsWith("docs/") ? match[0] : `docs/${match[0]}`;
    if (assetPath !== PUBLIC_MEDIA_SERIES_PATH) {
      throw new Error(
        `Public product media must use the declared ${PUBLIC_MEDIA_SERIES_PATH} series; received ${assetPath}.`
      );
    }
  }
  for (const match of document.matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    const assetPath = repositoryProductMediaPath(match[1] ?? match[2] ?? "");
    if (assetPath?.startsWith(PUBLIC_MEDIA_ROOT_PATH) && !assetPath.startsWith(PUBLIC_MEDIA_SERIES_PATH)) {
      throw new Error(
        `Public product media must use the declared ${PUBLIC_MEDIA_SERIES_PATH} series; received ${assetPath}.`
      );
    }
  }
}

export function expectedRepresentativeReferences(readme) {
  const references = extractImmutableProductReferences(readme);
  return REPRESENTATIVE_PUBLIC_IMAGES.map((alt) => {
    const matches = references.filter((reference) => reference.alt === alt);
    if (matches.length !== 1) {
      throw new Error(`README must expose exactly one immutable public image with alt ${JSON.stringify(alt)}.`);
    }
    return matches[0];
  });
}

export function assertRepresentativeImageSource(surfaceName, image, expectedUrl) {
  if (image.sourceUrl !== expectedUrl || image.currentUrl !== expectedUrl) {
    throw new Error(
      `${surfaceName} does not render the expected immutable image URL for ${JSON.stringify(image.alt)}: ` +
        `expected ${expectedUrl}, src ${JSON.stringify(image.sourceUrl)}, currentSrc ${JSON.stringify(image.currentUrl)}.`
    );
  }
}

export function assertRenderedProductImage(surfaceName, image, expected) {
  assertRepresentativeImageSource(surfaceName, image, expected.url);
  if (image.devicePixelRatio !== PUBLIC_MEDIA_PIXEL_RATIO) {
    throw new Error(`${surfaceName} did not run at the required DPR ${PUBLIC_MEDIA_PIXEL_RATIO}.`);
  }
  if (image.naturalWidth !== expected.naturalWidth || image.naturalHeight !== expected.naturalHeight) {
    throw new Error(
      `${surfaceName} renders ${JSON.stringify(expected.alt)} at ${image.naturalWidth}x${image.naturalHeight} natural ` +
        `pixels instead of the reviewed ${expected.naturalWidth}x${expected.naturalHeight}.`
    );
  }
  const minimumWidth = Math.ceil(image.clientWidth * PUBLIC_MEDIA_PIXEL_RATIO);
  const minimumHeight = Math.ceil(image.clientHeight * PUBLIC_MEDIA_PIXEL_RATIO);
  if (
    image.clientWidth <= 0 ||
    image.clientHeight <= 0 ||
    image.viewportWidth <= 0 ||
    image.containerWidth <= 0 ||
    image.clientWidth > expected.displayWidth + 1 ||
    image.clientWidth > image.containerWidth + 1 ||
    image.clientLeft < -1 ||
    image.clientRight > image.viewportWidth + 1 ||
    image.clientLeft < image.containerLeft - 1 ||
    image.clientRight > image.containerRight + 1 ||
    image.naturalWidth < minimumWidth ||
    image.naturalHeight < minimumHeight
  ) {
    throw new Error(
      `${surfaceName} would upscale or overflow ${JSON.stringify(expected.alt)} at DPR ${PUBLIC_MEDIA_PIXEL_RATIO}: ` +
        `${image.naturalWidth}x${image.naturalHeight} natural for ` +
        `${image.clientWidth}x${image.clientHeight} CSS pixels in a ${image.containerWidth}px container and ` +
        `${image.viewportWidth}px viewport ` +
        `(declared cap ${expected.displayWidth}px).`
    );
  }
  const expectedClientHeight = (image.clientWidth * image.naturalHeight) / image.naturalWidth;
  if (Math.abs(image.clientHeight - expectedClientHeight) > 1) {
    throw new Error(
      `${surfaceName} distorts ${JSON.stringify(expected.alt)}: rendered ${image.clientWidth}x${image.clientHeight} ` +
        `CSS pixels, expected height ${expectedClientHeight.toFixed(2)} from its natural aspect ratio.`
    );
  }
}

export function immutableProductReference(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raw.githubusercontent.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    return undefined;
  }
  if (!url.pathname.startsWith(REPOSITORY_PATH)) return undefined;
  const remainder = url.pathname.slice(REPOSITORY_PATH.length);
  const separator = remainder.indexOf("/");
  if (separator < 0) return undefined;
  const sourceSha = remainder.slice(0, separator);
  const assetPath = remainder.slice(separator + 1);
  if (assetPath.startsWith(PUBLIC_MEDIA_ROOT_PATH) && !assetPath.startsWith(PUBLIC_MEDIA_SERIES_PATH)) {
    throw new Error(
      `Public product media must use the declared ${PUBLIC_MEDIA_SERIES_PATH} series; received ${assetPath}.`
    );
  }
  if (!FULL_SOURCE_SHA.test(sourceSha)) return undefined;
  if (!assetPath.startsWith(PUBLIC_MEDIA_SERIES_PATH) || !assetPath.endsWith(".png")) return undefined;
  const relativePath = validatedRelativePath(assetPath.slice(PUBLIC_MEDIA_SERIES_PATH.length));
  if (url.search !== "" || url.hash !== "") {
    throw new Error("README public-media URLs must not contain a query or fragment.");
  }
  return { url: url.href, relativePath, sourceSha };
}

function htmlAttribute(tag, name) {
  const expression = new RegExp(`\\b${name}="([^"]*)"`, "iu");
  return expression.exec(tag)?.[1];
}

function displayWidth(tag) {
  const value = htmlAttribute(tag, "width");
  if (value === undefined || !/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("README public product media requires one positive integer width attribute.");
  }
  const width = Number(value);
  if (width > PUBLIC_MEDIA_MAX_DISPLAY_WIDTH) {
    throw new Error(
      `README public product media may render at most ${PUBLIC_MEDIA_MAX_DISPLAY_WIDTH} CSS pixels wide.`
    );
  }
  return width;
}

function repositoryProductMediaPath(value) {
  if (value.startsWith("images/readme/")) return `docs/${value}`;
  if (value.startsWith(PUBLIC_MEDIA_ROOT_PATH)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  let assetSegments;
  if (url.hostname === "raw.githubusercontent.com" && segments[0] === "Matt17BR" && segments[1] === "openwrangler") {
    assetSegments = segments.slice(3);
  } else if (
    url.hostname === "github.com" &&
    segments[0] === "Matt17BR" &&
    segments[1] === "openwrangler" &&
    (segments[2] === "blob" || segments[2] === "raw")
  ) {
    assetSegments = segments.slice(4);
  } else {
    return undefined;
  }
  const assetPath = assetSegments.join("/");
  if (assetPath.startsWith(PUBLIC_MEDIA_ROOT_PATH) && (url.search !== "" || url.hash !== "")) {
    throw new Error("Public product-media URLs must not contain a query or fragment.");
  }
  return assetPath;
}

function immutableRepositoryProductMediaReference(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  let sourceSha;
  let assetSegments;
  if (url.hostname === "raw.githubusercontent.com" && segments[0] === "Matt17BR" && segments[1] === "openwrangler") {
    sourceSha = segments[2];
    assetSegments = segments.slice(3);
  } else if (
    url.hostname === "github.com" &&
    segments[0] === "Matt17BR" &&
    segments[1] === "openwrangler" &&
    (segments[2] === "blob" || segments[2] === "raw")
  ) {
    sourceSha = segments[3];
    assetSegments = segments.slice(4);
  } else {
    return undefined;
  }
  const assetPath = assetSegments.join("/");
  if (
    !FULL_SOURCE_SHA.test(sourceSha) ||
    (assetPath !== "assets/icon.png" && !assetPath.startsWith(PUBLIC_MEDIA_SERIES_PATH))
  ) {
    return undefined;
  }
  return { assetPath, sourceSha };
}

function validatedRelativePath(relativePath) {
  if (!relativePath || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("README contains a malformed public-media path.");
  }
  return relativePath;
}

function usageError() {
  return new Error(
    "Usage: npm run verify:public-media-surfaces -- --source-sha <40-hex-commit> --version <semantic-version> " +
      "[--source-root <relative-path>] [--prepublish | --wait-for-propagation]"
  );
}
