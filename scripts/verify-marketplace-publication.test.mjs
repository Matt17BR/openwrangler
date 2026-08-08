import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
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
  engines: { vscode: "^1.106.0" },
  extensionKind: ["workspace"]
});
const defaultIconUrl =
  "https://matt17br.gallerycdn.vsassets.io/extensions/matt17br/openwrangler/1.0.2/build/Microsoft.VisualStudio.Services.Icons.Default";
const smallIconUrl =
  "https://matt17br.gallerycdn.vsassets.io/extensions/matt17br/openwrangler/1.0.2/build/Microsoft.VisualStudio.Services.Icons.Small";
const vsixAssetUrl =
  "https://matt17br.gallerycdn.vsassets.io/extensions/matt17br/openwrangler/1.0.2/build/Microsoft.VisualStudio.Services.VSIXPackage";

function png(width, height, red = 0) {
  const image = new PNG({ height, width });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = red;
    image.data[offset + 1] = 92;
    image.data[offset + 2] = 180;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

const galleryIcon = png(512, 512, 33);
const smallGalleryIcon = png(72, 72, 33);

function releaseEntries(
  readme = "# Open Wrangler\n",
  manifest = packageJson,
  preReleaseProperty = "",
  { includeRFrameContract = true } = {}
) {
  const entries = new Map([
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
    ["extension/media/action-icon-dark.svg", "<svg></svg>"],
    ["extension/media/action-icon-light.svg", "<svg></svg>"],
    ["extension/media/activity-icon.svg", "<svg></svg>"],
    ["extension/media/icon.png", galleryIcon],
    ["extension/media/icon-128.png", png(128, 128, 33)],
    ["extension/r/openwrangler_runtime/frame_contract.R", "openwrangler_frame_contract <- function(frame) frame\n"],
    ["extension/r/openwrangler_runtime/interactive_agent.R", "openwrangler_r_interactive_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/kernel_agent.R", "openwrangler_kernel_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/process_agent.R", 'quit(save = "no")\n'],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", `__version__ = "${version}"\n`]
  ]);
  if (!includeRFrameContract) {
    entries.delete("extension/r/openwrangler_runtime/frame_contract.R");
  }
  return entries;
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
                    assetType: "Microsoft.VisualStudio.Services.Icons.Default",
                    source: defaultIconUrl
                  },
                  {
                    assetType: "Microsoft.VisualStudio.Services.Icons.Small",
                    source: smallIconUrl
                  },
                  {
                    assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
                    source: vsixAssetUrl
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

function fetchFixture(galleryBody, publicVsix, { defaultIcon = galleryIcon, smallIcon = smallGalleryIcon } = {}) {
  return async (url, options) => {
    if (url.includes("/extensionquery?")) {
      return new Response(JSON.stringify(galleryBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === defaultIconUrl) {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(defaultIcon, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }
    if (url === smallIconUrl) {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(smallIcon, {
        status: 200,
        headers: { "content-type": "image/png" }
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

test("verifies historical v1 Marketplace packages without the later R runtime", async (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-marketplace-historical-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const entries = releaseEntries("# Open Wrangler\n", packageJson, "", { includeRFrameContract: false });
  const candidate = await createVsix(entries);
  const publicVsix = await createVsix(entries, true);
  const candidatePath = join(root, "openwrangler.vsix");
  const candidateSha256 = createHash("sha256").update(candidate).digest("hex");
  writeFileSync(candidatePath, candidate, { flag: "wx", mode: 0o600 });

  const receipt = await verifyMarketplacePublication({
    attempts: 1,
    candidatePath,
    candidateSha256,
    fetchImpl: fetchFixture(gallery(candidateSha256), publicVsix),
    prerelease: false,
    requireRFrameContract: false,
    version
  });
  assert.equal(receipt.candidateSha256, candidateSha256);
});

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

test("rejects a Marketplace default icon that differs from the canonical VSIX", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 1,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery(candidate.candidateSha256), candidate.candidate, {
        defaultIcon: png(512, 512, 99)
      }),
      prerelease: false,
      version
    }),
    /default gallery icon that differs/u
  );
});

test("rejects a malformed Marketplace small icon derivative", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 1,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery(candidate.candidateSha256), candidate.candidate, {
        smallIcon: png(64, 64, 33)
      }),
      prerelease: false,
      version
    }),
    /expected 72 by 72 pixel derivative/u
  );
});

test("rejects an unrelated Marketplace small icon with the expected dimensions", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 1,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery(candidate.candidateSha256), candidate.candidate, {
        smallIcon: png(72, 72, 199)
      }),
      prerelease: false,
      version
    }),
    /does not visually match/u
  );
});

test("retries a bounded transient Marketplace icon transport failure", async (context) => {
  const candidate = await fixture(context);
  const success = fetchFixture(gallery(candidate.candidateSha256), candidate.candidate);
  let defaultIconRequests = 0;
  let sleeps = 0;
  const receipt = await verifyMarketplacePublication({
    attempts: 2,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    fetchImpl: async (url, options) => {
      if (url === defaultIconUrl && defaultIconRequests++ === 0) {
        throw new TypeError("temporary transport failure");
      }
      return success(url, options);
    },
    prerelease: false,
    sleep: async () => {
      sleeps += 1;
    },
    version
  });
  assert.equal(receipt.version, version);
  assert.equal(defaultIconRequests, 2);
  assert.equal(sleeps, 1);
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

test("accepts only the reviewed Marketplace polling-attempt bound", async (context) => {
  const candidate = await fixture(context);
  await assert.rejects(
    verifyMarketplacePublication({
      attempts: 41,
      candidatePath: candidate.candidatePath,
      candidateSha256: candidate.candidateSha256,
      fetchImpl: fetchFixture(gallery(candidate.candidateSha256), candidate.candidate),
      prerelease: false,
      version
    }),
    /integer from 1 through 40/u
  );
  const result = await verifyMarketplacePublication({
    attempts: 40,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    fetchImpl: fetchFixture(gallery(candidate.candidateSha256), candidate.candidate),
    prerelease: false,
    version
  });
  assert.equal(result.version, version);
});
