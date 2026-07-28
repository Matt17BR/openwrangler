import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import {
  MARKETPLACE_VSIX_SHA256_PROPERTY,
  MarketplacePublicationPendingError,
  verifyMarketplacePublication
} from "./verify-marketplace-publication.mjs";

const version = "1.0.2";
const packageJson = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  description: "An open-source dataframe wrangler.",
  publisher: "Matt17BR",
  version,
  preview: false,
  engines: { vscode: "^1.105.0" },
  extensionKind: ["workspace"]
});

function releaseEntries(readme = "# Open Wrangler\n", manifest = packageJson, preReleaseProperty = "") {
  return new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    [
      "extension.vsixmanifest",
      `<?xml version="1.0" encoding="utf-8"?><PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="openwrangler" Publisher="Matt17BR" Version="${version}" /><Properties>${preReleaseProperty}</Properties></Metadata></PackageManifest>`
    ],
    ["extension/package.json", JSON.stringify(manifest)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", readme],
    ["extension/changelog.md", "# Changelog\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Third-party notices\n"],
    ["extension/dist/extension/activate.js", "export {};"],
    ["extension/dist/extension/webviewPanel.js", "export {};"],
    ["extension/media/webview.js", "export {};"],
    ["extension/media/webview.css", "@font-face{src:url('./codicon.ttf')}"],
    ["extension/media/codicon.ttf", "font"],
    ["extension/media/codePreview.js", "export {};"],
    ["extension/media/notebookRenderer.js", "export function activate() {}"],
    ["extension/media/activity-icon.svg", "<svg></svg>"],
    ["extension/media/icon.png", "icon"],
    ["extension/media/icon-128.png", "icon"],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", `__version__ = "${version}"\n`]
  ]);
}

function createVsix(entries, reverse = false) {
  const zip = new ZipFile();
  const values = [...entries];
  for (const [name, value] of reverse ? values.reverse() : values) {
    zip.addBuffer(Buffer.from(value), name);
  }
  return new Promise((resolveBytes, rejectBytes) => {
    const chunks = [];
    let length = 0;
    zip.outputStream.on("data", (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
    });
    zip.outputStream.once("error", rejectBytes);
    zip.outputStream.once("end", () => resolveBytes(Buffer.concat(chunks, length)));
    zip.end();
  });
}

function gallery(candidateSha256, overrides = {}, extraProperties = []) {
  return {
    results: [
      {
        extensions: [
          {
            publisher: { publisherName: "matt17br" },
            extensionName: "openwrangler",
            displayName: packageJson.displayName,
            shortDescription: packageJson.description,
            flags: "validated, public",
            versions: [
              {
                version,
                flags: "validated",
                files: [
                  {
                    assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
                    source:
                      "https://matt17br.gallerycdn.vsassets.io/extensions/matt17br/openwrangler/1.0.2/build/Microsoft.VisualStudio.Services.VSIXPackage"
                  }
                ],
                properties: [
                  { key: MARKETPLACE_VSIX_SHA256_PROPERTY, value: candidateSha256 },
                  { key: "Microsoft.VisualStudio.Code.Engine", value: packageJson.engines.vscode },
                  { key: "Microsoft.VisualStudio.Code.ExtensionKind", value: "workspace" },
                  ...extraProperties
                ],
                ...overrides
              }
            ]
          }
        ]
      }
    ]
  };
}

function fetchFixture(galleryBody, publicVsix) {
  return async (url) => {
    if (url.includes("/extensionquery?")) {
      return new Response(JSON.stringify(galleryBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(publicVsix, {
      status: 200,
      headers: { "content-type": "application/vsix" }
    });
  };
}

async function fixture(context, manifest = packageJson, preReleaseProperty = "") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-marketplace-public-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = await createVsix(releaseEntries("# Open Wrangler\n", manifest, preReleaseProperty));
  const candidatePath = join(root, "openwrangler.vsix");
  writeFileSync(candidatePath, candidate, { flag: "wx", mode: 0o600 });
  return {
    candidate,
    candidatePath,
    candidateSha256: createHash("sha256").update(candidate).digest("hex")
  };
}

test("verifies upload SHA metadata and exact public VSIX semantics across ZIP reserialization", async (context) => {
  const candidate = await fixture(context);
  const publicVsix = await createVsix(releaseEntries(), true);
  assert.notEqual(createHash("sha256").update(publicVsix).digest("hex"), candidate.candidateSha256);
  const receipt = await verifyMarketplacePublication({
    attempts: 1,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    fetchImpl: fetchFixture(gallery(candidate.candidateSha256), publicVsix),
    prerelease: false,
    version
  });
  assert.deepEqual(receipt, {
    candidateSha256: candidate.candidateSha256,
    extensionId: "Matt17BR.openwrangler",
    version
  });
});

test("verifies an exact Marketplace pre-release flag in package, VSIX, and gallery metadata", async (context) => {
  const preReleaseProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
  const previewManifest = Object.freeze({ ...packageJson, preview: true });
  const candidate = await fixture(context, previewManifest, preReleaseProperty);
  const publicVsix = await createVsix(releaseEntries("# Open Wrangler\n", previewManifest, preReleaseProperty), true);
  await verifyMarketplacePublication({
    attempts: 1,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    fetchImpl: fetchFixture(
      gallery(candidate.candidateSha256, {}, [{ key: "Microsoft.VisualStudio.Code.PreRelease", value: "true" }]),
      publicVsix
    ),
    prerelease: true,
    version
  });
});

test("polls a genuinely pending public version and then verifies it", async (context) => {
  const candidate = await fixture(context);
  let queries = 0;
  let sleeps = 0;
  const success = fetchFixture(gallery(candidate.candidateSha256), candidate.candidate);
  await verifyMarketplacePublication({
    attempts: 2,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    fetchImpl: async (url, options) => {
      if (url.includes("/extensionquery?") && queries++ === 0) {
        return new Response(JSON.stringify({ results: [{ extensions: [] }] }), { status: 200 });
      }
      return success(url, options);
    },
    prerelease: false,
    sleep: async () => {
      sleeps += 1;
    },
    version
  });
  assert.equal(sleeps, 1);
});

test("rejects an existing conflicting upload hash without retrying", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 2,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery("b".repeat(64)), candidate.candidate),
      prerelease: false,
      sleep: async () => assert.fail("a conflicting public version must not be retried"),
      version
    }),
    /different VSIX bytes/u
  );
});

test("rejects public payload drift even when Marketplace reports the canonical upload hash", async (context) => {
  const candidate = await fixture(context);
  const changed = await createVsix(releaseEntries("# Replaced payload\n"), true);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 1,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery(candidate.candidateSha256), changed),
      prerelease: false,
      version
    }),
    /entries or payload bytes differ/u
  );
});

test("reports an exhausted non-public Marketplace version as pending", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 1,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture({ results: [{ extensions: [] }] }, candidate.candidate),
      prerelease: false,
      version
    }),
    MarketplacePublicationPendingError
  );
});
