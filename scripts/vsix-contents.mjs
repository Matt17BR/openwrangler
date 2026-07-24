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
  return {
    forbidden: entries.filter((entry) => !allowedVsixEntryPatterns.some((pattern) => pattern.test(entry))),
    missing: requiredVsixEntries.filter((entry) => !entries.includes(entry))
  };
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
