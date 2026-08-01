const FULL_SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const REPOSITORY_PATH = "/Matt17BR/openwrangler/";
const PRODUCT_MEDIA_PATH = "docs/images/readme/v1.2/";

export const PUBLIC_SURFACE_CONTENT = [
  "Explore, profile, clean, and export dataframes in an open-source workbench",
  "Why Open Wrangler"
];

export const REPRESENTATIVE_PUBLIC_IMAGES = [
  "Open Wrangler in VS Code with its dataframe grid, column profiles, and native Activity Bar views",
  "A numeric histogram with an easy-to-target bin and exact interval and row count"
];

export function parsePublicMediaVerifierArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if ((name !== "--source-sha" && name !== "--version") || value === undefined) {
      throw usageError();
    }
    if (values.has(name)) throw new Error(`${name} may be supplied only once.`);
    values.set(name, value);
  }

  const sourceSha = values.get("--source-sha");
  const version = values.get("--version");
  if (sourceSha === undefined || version === undefined) throw usageError();
  if (!FULL_SOURCE_SHA.test(sourceSha)) {
    throw new Error("--source-sha must be one exact lowercase 40-hex source commit.");
  }
  if (!SEMANTIC_VERSION.test(version)) {
    throw new Error("--version must be one exact semantic version without a leading v.");
  }
  return { sourceSha, version };
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
  const references = [];
  for (const match of readme.matchAll(/<img\b[^>]*>/giu)) {
    const tag = match[0];
    const source = htmlAttribute(tag, "src");
    if (source === undefined) continue;
    const reference = immutableProductReference(source);
    if (reference === undefined) continue;
    const alt = htmlAttribute(tag, "alt");
    if (alt === undefined || alt.trim() === "") {
      throw new Error("README public product media requires a non-empty alt attribute.");
    }
    references.push({ ...reference, alt });
  }
  return references;
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

export function immutableProductReference(source) {
  let url;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com") return undefined;
  if (!url.pathname.startsWith(REPOSITORY_PATH)) return undefined;
  const remainder = url.pathname.slice(REPOSITORY_PATH.length);
  const separator = remainder.indexOf("/");
  if (separator < 0 || !FULL_SOURCE_SHA.test(remainder.slice(0, separator))) return undefined;
  const assetPath = remainder.slice(separator + 1);
  if (!assetPath.startsWith(PRODUCT_MEDIA_PATH) || !assetPath.endsWith(".png")) return undefined;
  const relativePath = assetPath.slice(PRODUCT_MEDIA_PATH.length);
  if (!relativePath || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("README contains a malformed public-media path.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("README public-media URLs must not contain a query or fragment.");
  }
  return { url: url.href, relativePath };
}

function htmlAttribute(tag, name) {
  const expression = new RegExp(`\\b${name}="([^"]*)"`, "iu");
  return expression.exec(tag)?.[1];
}

function usageError() {
  return new Error(
    "Usage: npm run verify:public-media-surfaces -- --source-sha <40-hex-commit> --version <semantic-version>"
  );
}
