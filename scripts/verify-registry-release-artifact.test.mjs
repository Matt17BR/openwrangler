import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import { publishVerifiedGitHubPreviewRelease } from "./publish-github-preview-release.mjs";
import { CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL } from "./run-installed-performance.mjs";
import { verifyPreviewReleaseArtifactFromCheckout } from "./verify-preview-release-artifact.mjs";
import {
  verifyRegistryReleaseArtifact,
  verifyRegistryReleaseArtifactFromCheckout
} from "./verify-registry-release-artifact.mjs";

const expectedCommit = "a".repeat(40);
const releaseTag = "v0.3.0";
const sourceManifest = Object.freeze({
  name: "openwrangler",
  publisher: "Matt17BR",
  version: "0.3.0",
  preview: true
});
const previewProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';

function createVsix(packageJson = sourceManifest, property = previewProperty) {
  const zip = new ZipFile();
  for (const [name, value] of [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    [
      "extension.vsixmanifest",
      `<?xml version="1.0" encoding="utf-8"?><PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Id="openwrangler" Publisher="Matt17BR" Version="0.3.0" /><Properties>${property}</Properties></Metadata></PackageManifest>`
    ],
    ["extension/package.json", JSON.stringify(packageJson)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", "# Open Wrangler\n"],
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
    ["extension/media/icon.png", "icon"],
    ["extension/media/icon-128.png", "icon"],
    ["extension/r/openwrangler_runtime/frame_contract.R", "openwrangler_frame_contract <- function(frame) frame\n"],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "0.3.0"\n']
  ]) {
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

async function fixture(
  context,
  packageJson = sourceManifest,
  property = previewProperty,
  sourceCommit = expectedCommit,
  provenanceOverrides = {}
) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-registry-preview-")));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const vsix = await createVsix(packageJson, property);
  const digest = createHash("sha256").update(vsix).digest("hex");
  writeFileSync(join(directory, "openwrangler.vsix"), vsix);
  writeFileSync(join(directory, "openwrangler.vsix.sha256"), `${digest}  openwrangler.vsix\n`);
  writeFileSync(
    join(directory, "openwrangler.vsix.provenance.json"),
    `${JSON.stringify(
      {
        protocol: CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
        extensionId: "Matt17BR.openwrangler",
        extensionVersion: "0.3.0",
        preview: true,
        releaseTag,
        sourceCommit,
        vsixSha256: digest,
        vsixBytes: vsix.length,
        ...provenanceOverrides
      },
      null,
      2
    )}\n`
  );
  return { digest, directory, vsix };
}

test("preview registry consumer binds checksum, tag source, package identity, and VSIX pre-release metadata", async (context) => {
  const release = await fixture(context);
  assert.deepEqual(
    await verifyRegistryReleaseArtifact({
      directory: release.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    {
      candidateBytes: release.vsix.length,
      candidatePath: join(release.directory, "openwrangler.vsix"),
      candidateSha256: release.digest,
      extensionId: "Matt17BR.openwrangler",
      prerelease: true,
      releaseTag,
      sourceCommit: expectedCommit,
      version: "0.3.0"
    }
  );
});

test("preview registry consumer rejects stable flags, source drift, extra files, and checksum drift", async (context) => {
  const stableFlag = await fixture(context, { ...sourceManifest, preview: false });
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: stableFlag.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /invalid|does not match/u
  );

  const sourceDrift = await fixture(context);
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: sourceDrift.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify({ ...sourceManifest, version: "0.3.1" })
    }),
    /selected release source is invalid/u
  );

  const packagedManifestDrift = await fixture(context, {
    ...sourceManifest,
    description: "different packaged metadata"
  });
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: packagedManifestDrift.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /does not match/u
  );

  const extra = await fixture(context);
  writeFileSync(join(extra.directory, "unexpected.txt"), "x");
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: extra.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exactly its VSIX, checksum, and provenance/u
  );

  const checksum = await fixture(context);
  writeFileSync(join(checksum.directory, "openwrangler.vsix.sha256"), `${"b".repeat(64)}  openwrangler.vsix\n`);
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: checksum.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /checksum/u
  );

  const provenanceConflict = await fixture(context, sourceManifest, previewProperty, expectedCommit, {
    sourceCommit: "b".repeat(40)
  });
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: provenanceConflict.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /do not describe one exact preview artifact/u
  );

  const malformedProvenance = await fixture(context);
  writeFileSync(join(malformedProvenance.directory, "openwrangler.vsix.provenance.json"), "{\n");
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: malformedProvenance.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /JSON|provenance/u
  );

  const historicalTwoFilePreview = await fixture(context);
  unlinkSync(join(historicalTwoFilePreview.directory, "openwrangler.vsix.provenance.json"));
  await assert.rejects(
    verifyRegistryReleaseArtifact({
      directory: historicalTwoFilePreview.directory,
      expectedCommit,
      prerelease: true,
      releaseTag,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exactly its VSIX, checksum, and provenance/u
  );
});

test("preview candidate verifier binds exact HEAD without requiring a tag", async (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-preview-candidate-head-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "tests@openwrangler.invalid");
  git("config", "user.name", "Open Wrangler tests");
  writeFileSync(join(root, "package.json"), `${JSON.stringify(sourceManifest)}\n`);
  git("add", "package.json");
  git("commit", "-m", "preview source");
  const candidateCommit = git("rev-parse", "HEAD");
  const release = await fixture(context, sourceManifest, previewProperty, candidateCommit);

  const receipt = await verifyPreviewReleaseArtifactFromCheckout({
    directory: release.directory,
    expectedCommit: candidateCommit,
    releaseTag,
    root
  });
  assert.equal(receipt.sourceCommit, candidateCommit);
  assert.equal(git("tag", "--list", releaseTag), "");

  const nestedRoot = join(root, "nested");
  mkdirSync(nestedRoot);
  await assert.rejects(
    verifyPreviewReleaseArtifactFromCheckout({
      directory: release.directory,
      expectedCommit: candidateCommit,
      releaseTag,
      root: nestedRoot
    }),
    /exact Git repository root/u
  );

  writeFileSync(join(root, "later.txt"), "later\n");
  git("add", "later.txt");
  git("commit", "-m", "move head");
  await assert.rejects(
    verifyPreviewReleaseArtifactFromCheckout({
      directory: release.directory,
      expectedCommit: candidateCommit,
      releaseTag,
      root
    }),
    /exact candidate commit/u
  );
});

test("preview publication rejects a provenance replacement before creating a GitHub draft", async (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-preview-publisher-head-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "tests@openwrangler.invalid");
  git("config", "user.name", "Open Wrangler tests");
  writeFileSync(join(root, "package.json"), `${JSON.stringify(sourceManifest)}\n`);
  git("add", "package.json");
  git("commit", "-m", "preview source");
  const candidateCommit = git("rev-parse", "HEAD");
  const release = await fixture(context, sourceManifest, previewProperty, candidateCommit);
  const provenancePath = join(release.directory, "openwrangler.vsix.provenance.json");
  const originalProvenance = readFileSync(provenancePath);
  const requests = [];
  let replaced = false;
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    requests.push({ method, url });
    if (url.endsWith(`/git/ref/tags/${encodeURIComponent(releaseTag)}`)) {
      return new Response(
        JSON.stringify({ object: { sha: candidateCommit, type: "commit" }, ref: `refs/tags/${releaseTag}` }),
        { status: 200 }
      );
    }
    if (url.endsWith(`/releases/tags/${encodeURIComponent(releaseTag)}`)) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (url.includes("/releases?")) {
      if (!replaced) {
        replaced = true;
        unlinkSync(provenancePath);
        writeFileSync(provenancePath, originalProvenance);
      }
      return new Response("[]", { status: 200 });
    }
    throw new Error(`Unexpected mutation request: ${method} ${url}`);
  };

  await assert.rejects(
    publishVerifiedGitHubPreviewRelease({
      directory: release.directory,
      expectImmutable: false,
      expectedCommit: candidateCommit,
      fetchImpl,
      releaseTag,
      releaseNotes: "Reviewed preview release notes.\n",
      repository: "Matt17BR/openwrangler",
      root,
      token: "test-token"
    }),
    /changed while the canonical release set was pinned/u
  );
  assert.equal(
    requests.some(({ method }) => method !== "GET"),
    false
  );
});

test("historical verification keeps current automation HEAD separate from the immutable release tag", async (context) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-registry-history-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...arguments_) =>
    execFileSync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
      windowsHide: true
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "tests@openwrangler.invalid");
  git("config", "user.name", "Open Wrangler tests");
  writeFileSync(join(root, "package.json"), `${JSON.stringify(sourceManifest)}\n`);
  git("add", "package.json");
  git("commit", "-m", "release source");
  const taggedCommit = git("rev-parse", "HEAD");
  const release = await fixture(context, sourceManifest, previewProperty, taggedCommit);
  git("tag", releaseTag);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "promotion.mjs"), "export {};\n");
  git("add", "scripts/promotion.mjs");
  git("commit", "-m", "add later automation");
  const automationCommit = git("rev-parse", "HEAD");

  const receipt = await verifyRegistryReleaseArtifactFromCheckout({
    automationCommit,
    directory: release.directory,
    expectedCommit: taggedCommit,
    prerelease: true,
    releaseTag,
    root
  });
  assert.equal(receipt.sourceCommit, taggedCommit);
  assert.notEqual(automationCommit, taggedCommit);

  await assert.rejects(
    verifyRegistryReleaseArtifactFromCheckout({
      automationCommit,
      directory: release.directory,
      expectedCommit: automationCommit,
      prerelease: true,
      releaseTag,
      root
    }),
    /no longer resolves/u
  );
});
