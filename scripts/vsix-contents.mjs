import { SaxesParser } from "saxes";
import ts from "typescript";

export const allowedVsixEntryPatterns = [
  /^\[Content_Types\]\.xml$/u,
  /^extension\.vsixmanifest$/u,
  /^extension\/$/u,
  /^extension\/(package\.json|LICENSE\.txt|README\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md)$/iu,
  /^extension\/dist\/$/u,
  /^extension\/dist\/(extension|shared)\/$/u,
  /^extension\/dist\/(extension|shared)\/.+\.js$/u,
  /^extension\/media\/$/u,
  /^extension\/media\/(action-icon-(?:dark|light)\.svg|activity-icon\.svg|codicon\.ttf|icon(?:-(?:128|256))?\.png|icon\.svg|codePreview\.js|notebookRenderer\.js|webview\.(css|js))$/u,
  /^extension\/python\/$/u,
  /^extension\/python\/openwrangler_runtime\/$/u,
  /^extension\/python\/openwrangler_runtime\/[^/]+\.py$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/$/u,
  /^extension\/python\/openwrangler_runtime\/engines\/[^/]+\.py$/u,
  /^extension\/r\/$/u,
  /^extension\/r\/openwrangler_runtime\/$/u,
  /^extension\/r\/openwrangler_runtime\/[^/]+\.R$/u
];

export const requiredVsixEntries = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/LICENSE.txt",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/THIRD_PARTY_NOTICES.md",
  "extension/dist/extension/activate.js",
  "extension/dist/extension/webviewPanel.js",
  "extension/media/webview.js",
  "extension/media/webview.css",
  "extension/media/codicon.ttf",
  "extension/media/codePreview.js",
  "extension/media/notebookRenderer.js",
  "extension/media/action-icon-dark.svg",
  "extension/media/action-icon-light.svg",
  "extension/media/activity-icon.svg",
  "extension/media/icon.png",
  "extension/media/icon-128.png",
  "extension/python/openwrangler_runtime/dependency_guard.py",
  "extension/python/openwrangler_runtime/server.py",
  "extension/python/openwrangler_runtime/version.py",
  "extension/r/openwrangler_runtime/frame_contract.R"
];

const windowsReservedBasename = /^(?:aux|com[1-9¹²³]|con|lpt[1-9¹²³]|nul|prn)$/iu;
const windowsInvalidCharacters = new Set('<>:"|?*');
const vsixManifestNamespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";

class VsixManifestStructureError extends Error {}

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

export function inspectNotebookRendererBundle(bundle) {
  if (typeof bundle !== "string" || bundle.trim().length === 0) {
    return ["The notebook renderer bundle must be non-empty JavaScript."];
  }

  const sourceFile = ts.createSourceFile("notebookRenderer.js", bundle, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    return ["The notebook renderer bundle must contain valid JavaScript."];
  }

  const problems = [];
  let hasDependencyImport = false;
  let exportsActivate = false;

  const hasExportModifier = (node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const hasDefaultModifier = (node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      hasDependencyImport = true;
    }

    if (ts.isExportDeclaration(statement)) {
      hasDependencyImport ||= statement.moduleSpecifier !== undefined;
      exportsActivate ||=
        statement.moduleSpecifier === undefined &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some((element) => element.name.text === "activate");
    } else if (
      hasExportModifier(statement) &&
      !hasDefaultModifier(statement) &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === "activate"
    ) {
      exportsActivate = true;
    } else if (hasExportModifier(statement) && ts.isVariableStatement(statement)) {
      exportsActivate ||= statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "activate"
      );
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      hasDependencyImport = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (hasDependencyImport) {
    problems.push("The notebook renderer entrypoint must be one self-contained module without imports.");
  }
  if (!exportsActivate) {
    problems.push("The notebook renderer entrypoint must export activate.");
  }
  return problems;
}

function parsePreReleaseProperties(vsixManifest) {
  if (typeof vsixManifest !== "string") {
    throw new TypeError("VSIX manifest must be a string.");
  }

  const properties = [];
  const elementPath = [];
  const parser = new SaxesParser({ xmlns: true });
  let rootIsCanonical = false;
  let metadataElements = 0;
  let canonicalMetadataElements = 0;
  let propertiesElements = 0;
  let canonicalPropertiesElements = 0;
  let hasWrongNamespaceProperty = false;

  parser.on("doctype", () => {
    throw new Error("DOCTYPE declarations are not permitted in a VSIX manifest.");
  });
  parser.on("opentag", (tag) => {
    elementPath.push({ name: tag.name, uri: tag.uri });
    const expectedNames = ["PackageManifest", "Metadata", "Properties", "Property"];
    const hasCanonicalPrefix = (length) =>
      elementPath.length >= length &&
      elementPath
        .slice(0, length)
        .every((element, index) => element.name === expectedNames[index] && element.uri === vsixManifestNamespace);

    if (elementPath.length === 1) {
      rootIsCanonical = hasCanonicalPrefix(1);
    } else if (elementPath.length === 2 && elementPath[0]?.name === "PackageManifest" && tag.name === "Metadata") {
      metadataElements += 1;
      if (hasCanonicalPrefix(2)) {
        canonicalMetadataElements += 1;
      }
    } else if (elementPath.length === 3 && hasCanonicalPrefix(2) && tag.name === "Properties") {
      propertiesElements += 1;
      if (hasCanonicalPrefix(3)) {
        canonicalPropertiesElements += 1;
      }
    } else if (elementPath.length === 4 && hasCanonicalPrefix(3) && tag.name === "Property") {
      hasWrongNamespaceProperty ||= tag.uri !== vsixManifestNamespace;
    }

    if (elementPath.length !== 4 || !hasCanonicalPrefix(4)) {
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

  if (
    !rootIsCanonical ||
    metadataElements !== 1 ||
    canonicalMetadataElements !== 1 ||
    propertiesElements !== 1 ||
    canonicalPropertiesElements !== 1 ||
    hasWrongNamespaceProperty
  ) {
    throw new VsixManifestStructureError();
  }

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
  } catch (error) {
    problems.push(
      error instanceof VsixManifestStructureError
        ? "VSIX manifest must contain one canonical PackageManifest > Metadata > Properties chain."
        : "VSIX manifest must contain well-formed XML without a DOCTYPE declaration."
    );
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

export function inspectPackagedReadmeSource(sourceReadme, packagedReadme) {
  if (typeof sourceReadme !== "string" || typeof packagedReadme !== "string") {
    return ["README source parity requires source and packaged text."];
  }
  return sourceReadme === packagedReadme
    ? []
    : ["Packaged README must exactly match README.md; VSCE must not rewrite release-facing content."];
}
