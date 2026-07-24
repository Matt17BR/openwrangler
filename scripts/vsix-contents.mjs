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

export function inspectVsixEntries(entries) {
  const seen = new Set();
  const duplicates = [];

  for (const entry of entries) {
    if (seen.has(entry) && !duplicates.includes(entry)) {
      duplicates.push(entry);
    }
    seen.add(entry);
  }

  return {
    forbidden: entries.filter((entry) => !allowedVsixEntryPatterns.some((pattern) => pattern.test(entry))),
    missing: requiredVsixEntries.filter((entry) => !entries.includes(entry)),
    duplicates
  };
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

  const xmlWithoutComments = vsixManifest.replace(/<!--[\s\S]*?-->/gu, "");
  const properties = [...xmlWithoutComments.matchAll(/<Property\b[^>]*>/giu)]
    .map((match) => match[0])
    .filter((property) => /\bId\s*=\s*(["'])Microsoft\.VisualStudio\.Code\.PreRelease\1/u.test(property));

  if (manifest.preview === true) {
    if (properties.length !== 1) {
      problems.push("Preview packages must contain exactly one Microsoft.VisualStudio.Code.PreRelease property.");
    } else if (!/\bValue\s*=\s*(["'])true\1/u.test(properties[0])) {
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
