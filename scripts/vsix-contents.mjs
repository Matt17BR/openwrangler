import { SaxesParser } from "saxes";

export const allowedVsixEntryPatterns = [
  /^\[Content_Types\]\.xml$/u,
  /^extension\.vsixmanifest$/u,
  /^extension\/$/u,
  /^extension\/(package\.json|LICENSE\.txt|README\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md)$/iu,
  /^extension\/dist\/$/u,
  /^extension\/dist\/(extension|shared)\/$/u,
  /^extension\/dist\/(extension|shared)\/.+\.js$/u,
  /^extension\/media\/$/u,
  /^extension\/media\/(activity-icon\.svg|codicon\.ttf|icon(-128)?\.png|icon\.svg|codePreview\.js|notebookRenderer\.js|protocolValidation\.js|webview\.(css|js))$/u,
  /^extension\/python\/$/u,
  /^extension\/python\/openwrangler_runtime\/$/u,
  /^extension\/python\/openwrangler_runtime\/[^/]+\.py$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/[^/]+\.py$/u
];

export const requiredVsixEntries = [
  "extension/package.json",
  "extension/dist/extension/activate.js",
  "extension/dist/extension/webviewPanel.js",
  "extension/media/webview.js",
  "extension/media/webview.css",
  "extension/media/codicon.ttf",
  "extension/media/protocolValidation.js",
  "extension/media/icon.png",
  "extension/python/openwrangler_runtime/server.py",
  "extension/python/openwrangler_runtime/version.py"
];

const windowsReservedBasename = /^(?:aux|com[1-9¹²³]|con|lpt[1-9¹²³]|nul|prn)$/iu;
const windowsInvalidCharacters = new Set('<>:"|?*');
const vsixManifestNamespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";

function portableVsixEntryIdentity(entry) {
  if (
    typeof entry !== "string" ||
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry !== entry.normalize("NFC")
  ) {
    return undefined;
  }

  const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  if (path.length === 0) {
    return undefined;
  }

  const segments = path.split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.trim() !== segment ||
      segment.endsWith(".") ||
      Buffer.byteLength(segment, "utf8") > 255
    ) {
      return undefined;
    }

    for (const character of segment) {
      const codePoint = character.codePointAt(0);
      if (
        codePoint === undefined ||
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        windowsInvalidCharacters.has(character)
      ) {
        return undefined;
      }
    }

    const basename = segment.split(".", 1)[0];
    if (basename !== undefined && windowsReservedBasename.test(basename)) {
      return undefined;
    }
  }

  return path.toUpperCase().toLowerCase().normalize("NFC");
}

export function inspectVsixEntries(entries) {
  const seen = new Map();
  const duplicates = [];
  const inspectedEntries = entries.map((entry) => ({
    entry,
    identity: portableVsixEntryIdentity(entry),
    isDirectory: typeof entry === "string" && entry.endsWith("/")
  }));

  for (const { entry, identity, isDirectory } of inspectedEntries) {
    if (identity === undefined) {
      continue;
    }

    const segments = identity.split("/");
    const hasFileAncestor = segments
      .slice(0, -1)
      .some((_, index) => seen.get(segments.slice(0, index + 1).join("/")) === false);
    const shadowsExistingDescendant =
      !isDirectory && [...seen.keys()].some((seenIdentity) => seenIdentity.startsWith(`${identity}/`));
    if ((seen.has(identity) || hasFileAncestor || shadowsExistingDescendant) && !duplicates.includes(entry)) {
      duplicates.push(entry);
    }
    seen.set(identity, isDirectory);
  }

  return {
    forbidden: inspectedEntries
      .filter(
        ({ entry, identity }) =>
          identity === undefined || !allowedVsixEntryPatterns.some((pattern) => pattern.test(entry))
      )
      .map(({ entry }) => entry),
    missing: requiredVsixEntries.filter((entry) => !entries.includes(entry)),
    duplicates
  };
}

function parsePreReleaseProperties(vsixManifest) {
  if (typeof vsixManifest !== "string") {
    throw new TypeError("VSIX manifest must be a string.");
  }

  const properties = [];
  const elementPath = [];
  const parser = new SaxesParser({ xmlns: true });

  parser.on("doctype", () => {
    throw new Error("DOCTYPE declarations are not permitted in a VSIX manifest.");
  });
  parser.on("opentag", (tag) => {
    elementPath.push({ name: tag.name, uri: tag.uri });
    const expectedNames = ["PackageManifest", "Metadata", "Properties", "Property"];
    if (
      elementPath.length !== 4 ||
      !elementPath.every(
        (element, index) => element.name === expectedNames[index] && element.uri === vsixManifestNamespace
      )
    ) {
      return;
    }

    const attributes = Object.values(tag.attributes);
    const id = attributes.find(
      (attribute) =>
        typeof attribute === "object" &&
        attribute.name === "Id" &&
        attribute.prefix === "" &&
        attribute.local === "Id" &&
        attribute.uri === ""
    );
    if (id?.value !== "Microsoft.VisualStudio.Code.PreRelease") {
      return;
    }

    const value = attributes.find(
      (attribute) =>
        typeof attribute === "object" &&
        attribute.name === "Value" &&
        attribute.prefix === "" &&
        attribute.local === "Value" &&
        attribute.uri === ""
    );
    properties.push(value?.value);
  });
  parser.on("closetag", () => {
    elementPath.pop();
  });
  parser.write(vsixManifest).close();

  return properties;
}

export function inspectVsixPreReleaseMetadata(packageJson, vsixManifest) {
  let manifest;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    return ["Packaged package.json must contain valid JSON."];
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return ["Packaged package.json must contain a JSON object."];
  }

  const problems = [];
  if (manifest.preview !== undefined && typeof manifest.preview !== "boolean") {
    problems.push("Packaged package.json preview must be a boolean when present.");
  }

  let properties;
  try {
    properties = parsePreReleaseProperties(vsixManifest);
  } catch {
    problems.push("VSIX manifest must contain well-formed XML without a DOCTYPE declaration.");
    return problems;
  }

  if (manifest.preview === true) {
    if (properties.length !== 1) {
      problems.push("Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property.");
    } else if (properties[0] !== "true") {
      problems.push('Microsoft.VisualStudio.Code.PreRelease must have Value="true".');
    }
  } else if (properties.length > 0) {
    problems.push("Stable packages must not contain Microsoft.VisualStudio.Code.PreRelease.");
  }

  return problems;
}

function isAbsoluteHttpsUrl(value) {
  if (!/^https:\/\//u.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function inspectReadmeSourceSrcsets(readme) {
  const problems = [];
  const sourceTags = [...readme.matchAll(/<source(?=\s|\/?>)[^>]*>/giu)].map((match) => match[0]);

  for (const [sourceIndex, sourceTag] of sourceTags.entries()) {
    const label = `README source ${sourceIndex + 1}`;
    const srcsetNames = [...sourceTag.matchAll(/\ssrcset(?=\s|=|\/?>)/giu)];
    if (srcsetNames.length === 0) {
      problems.push(`${label} is missing srcset.`);
      continue;
    }
    if (srcsetNames.length !== 1) {
      problems.push(`${label} must contain exactly one srcset attribute.`);
      continue;
    }

    const quotedSrcsets = [...sourceTag.matchAll(/\ssrcset\s*=\s*(["'])(.*?)\1(?=\s|\/?>)/gisu)];
    if (quotedSrcsets.length !== 1) {
      problems.push(`${label} srcset must be quoted.`);
      continue;
    }

    const srcset = quotedSrcsets[0]?.[2]?.trim() ?? "";
    const candidates = srcset.split(",").map((candidate) => candidate.trim());
    if (candidates.length === 0 || candidates.some((candidate) => candidate.length === 0)) {
      problems.push(`${label} srcset must contain only non-empty candidates.`);
      continue;
    }

    for (const [candidateIndex, candidate] of candidates.entries()) {
      const [candidateUrl] = candidate.split(/\s+/u);
      if (!candidateUrl || !isAbsoluteHttpsUrl(candidateUrl)) {
        problems.push(`${label} srcset candidate ${candidateIndex + 1} must use an absolute HTTPS URL.`);
      }
    }
  }

  return problems;
}
