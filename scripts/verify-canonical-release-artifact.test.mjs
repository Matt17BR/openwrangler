import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import { CANONICAL_RELEASE_ARTIFACT_PROTOCOL } from "./run-installed-performance.mjs";
import { publishVerifiedGitHubStableRelease } from "./publish-github-stable-release.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";

const expectedCommit = "a".repeat(40);
const vendoredJsYaml = readFileSync(new URL("../node_modules/js-yaml/dist/js-yaml.cjs.js", import.meta.url));
const sourceManifest = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR",
  version: "1.0.0",
  preview: false
});

function vsixManifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="openwrangler" Publisher="Matt17BR" Version="1.0.0" />
    <Properties></Properties>
  </Metadata>
</PackageManifest>`;
}

function releaseEntries({ includeRFrameContract = true } = {}) {
  const entries = new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    ["extension.vsixmanifest", vsixManifest()],
    ["extension/package.json", JSON.stringify(sourceManifest)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", "# Open Wrangler\n"],
    ["extension/changelog.md", "# Changelog\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Third-party notices\n"],
    ["extension/dist/extension/activate.js", 'const policy = `font-src ${webview.cspSource};`; require("vscode");'],
    ["extension/dist/extension/vendor/js-yaml.js", vendoredJsYaml],
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
    ["extension/r/openwrangler_runtime/interactive_agent.R", "openwrangler_r_interactive_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/kernel_agent.R", "openwrangler_kernel_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/kernel_exports.R", "openwrangler_kernel_exports <- list()\n"],
    ["extension/r/openwrangler_runtime/process_agent.R", 'quit(save = "no")\n'],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/dependency_integrity.py", "pass\n"],
    ["extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n']
  ]);
  if (!includeRFrameContract) {
    entries.delete("extension/r/openwrangler_runtime/frame_contract.R");
    entries.delete("extension/dist/extension/vendor/js-yaml.js");
  }
  return entries;
}

function createVsix(options) {
  const zip = new ZipFile();
  for (const [name, value] of releaseEntries(options)) {
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

async function createFixture(context, options) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "openwrangler-canonical-consumer-")));
  context.after(() => rmSync(directory, { force: true, recursive: true }));
  const vsix = await createVsix(options);
  const digest = createHash("sha256").update(vsix).digest("hex");
  const checksumPath = join(directory, "openwrangler.vsix.sha256");
  const provenancePath = join(directory, "openwrangler.vsix.provenance.json");
  writeFileSync(join(directory, "openwrangler.vsix"), vsix);
  writeFileSync(checksumPath, `${digest}  openwrangler.vsix\n`);
  writeFileSync(
    provenancePath,
    `${JSON.stringify(
      {
        protocol: CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
        extensionId: "Matt17BR.openwrangler",
        extensionVersion: "1.0.0",
        preview: false,
        releaseTag: "v1.0.0",
        sourceCommit: expectedCommit,
        vsixSha256: digest,
        vsixBytes: vsix.length
      },
      null,
      2
    )}\n`
  );
  return { checksumPath, digest, directory, provenancePath, vsix };
}

test("canonical consumer binds source, stable provenance, checksum, identity, version, digest, and size", async (context) => {
  const fixture = await createFixture(context);
  const receipt = await verifyCanonicalReleaseArtifact({
    directory: fixture.directory,
    expectedCommit,
    releaseTag: "v1.0.0",
    sourceCommit: expectedCommit,
    sourcePackageJson: JSON.stringify(sourceManifest)
  });
  assert.deepEqual(receipt, {
    candidateBytes: fixture.vsix.length,
    candidatePath: join(fixture.directory, "openwrangler.vsix"),
    candidateSha256: fixture.digest,
    extensionId: "Matt17BR.openwrangler",
    releaseTag: "v1.0.0",
    sourceCommit: expectedCommit,
    version: "1.0.0"
  });
});

test("canonical consumer accepts a historical v1 package without the later R runtime", async (context) => {
  const fixture = await createFixture(context, { includeRFrameContract: false });
  const options = {
    directory: fixture.directory,
    expectedCommit,
    releaseTag: "v1.0.0",
    sourceCommit: expectedCommit,
    sourcePackageJson: JSON.stringify(sourceManifest)
  };

  await assert.rejects(
    verifyCanonicalReleaseArtifact(options),
    /Missing: extension\/dist\/extension\/vendor\/js-yaml\.js, extension\/r\/openwrangler_runtime/u
  );
  const receipt = await verifyCanonicalReleaseArtifact({
    ...options,
    requireRFrameContract: false,
    requireVendoredJsYaml: false
  });
  assert.equal(receipt.candidateSha256, fixture.digest);
});

test("canonical consumer rejects evidence-only provenance and unexpected inventory", async (context) => {
  const fixture = await createFixture(context);
  writeFileSync(
    fixture.provenancePath,
    `${JSON.stringify({
      protocol: "openwrangler-performance-evidence-artifact-v1",
      artifactRole: "installed-performance-evidence-only",
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "1.0.0",
      preview: false,
      releaseTag: "v1.0.0",
      sourceCommit: expectedCommit,
      vsixSha256: fixture.digest,
      vsixBytes: fixture.vsix.length
    })}\n`
  );
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: fixture.directory,
      expectedCommit,
      releaseTag: "v1.0.0",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exactly the canonical artifact fields/u
  );
  writeFileSync(join(fixture.directory, "unexpected.txt"), "untrusted\n");
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: fixture.directory,
      expectedCommit,
      releaseTag: "v1.0.0",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exactly the canonical three files/u
  );
});

test("canonical consumer rejects event, tag, checksum, and provenance drift", async (context) => {
  const eventFixture = await createFixture(context);
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: eventFixture.directory,
      expectedCommit,
      releaseTag: "v1.0.0",
      sourceCommit: "b".repeat(40),
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exact event commit/u
  );

  const tagFixture = await createFixture(context);
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: tagFixture.directory,
      expectedCommit,
      releaseTag: "v1.0.1",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /exactly match/u
  );

  const checksumFixture = await createFixture(context);
  writeFileSync(checksumFixture.checksumPath, `${"0".repeat(64)}  openwrangler.vsix\n`);
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: checksumFixture.directory,
      expectedCommit,
      releaseTag: "v1.0.0",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /one exact stable artifact/u
  );

  const provenanceFixture = await createFixture(context);
  const provenance = JSON.parse(readFileSync(provenanceFixture.provenancePath, "utf8"));
  provenance.sourceCommit = "b".repeat(40);
  writeFileSync(provenanceFixture.provenancePath, `${JSON.stringify(provenance)}\n`);
  await assert.rejects(
    verifyCanonicalReleaseArtifact({
      directory: provenanceFixture.directory,
      expectedCommit,
      releaseTag: "v1.0.0",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest)
    }),
    /one exact stable artifact/u
  );
});

test("stable publication rejects a sidecar replacement before creating a GitHub draft", async (context) => {
  const fixture = await createFixture(context);
  const requests = [];
  let replaced = false;
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    const method = options.method ?? "GET";
    requests.push({ method, url });
    if (url.endsWith("/git/ref/tags/v1.0.0")) {
      return new Response(
        JSON.stringify({ object: { sha: expectedCommit, type: "commit" }, ref: "refs/tags/v1.0.0" }),
        { status: 200 }
      );
    }
    if (url.endsWith("/releases/tags/v1.0.0")) {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (url.includes("/releases?")) {
      if (!replaced) {
        replaced = true;
        unlinkSync(fixture.checksumPath);
        writeFileSync(fixture.checksumPath, `${fixture.digest}  openwrangler.vsix\n`);
      }
      return new Response("[]", { status: 200 });
    }
    throw new Error(`Unexpected mutation request: ${method} ${url}`);
  };

  await assert.rejects(
    publishVerifiedGitHubStableRelease({
      directory: fixture.directory,
      expectImmutable: false,
      expectedCommit,
      fetchImpl,
      releaseTag: "v1.0.0",
      releaseNotes: "Reviewed stable release notes.\n",
      repository: "Matt17BR/openwrangler",
      sourceCommit: expectedCommit,
      sourcePackageJson: JSON.stringify(sourceManifest),
      token: "test-token"
    }),
    /changed while the canonical release set was pinned/u
  );
  assert.equal(
    requests.some(({ method }) => method !== "GET"),
    false
  );
});
