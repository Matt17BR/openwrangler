import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertSealedEditorAcceptanceArtifact,
  captureEditorAcceptanceEvidenceReceipt,
  createEditorAcceptanceArtifactParent,
  sealEditorAcceptanceEvidence
} from "./editor-acceptance-artifact.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("sealed failure evidence is re-redacted and identity-pinned through handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-sealed-evidence-"));
  try {
    const evidenceRoot = join(directory, "staging");
    const target = join(evidenceRoot, "vscode-stable-verify-attempt-1");
    const credential = "artifact-credential-must-not-survive";
    const privateMaterial = "artifact-private-material-must-not-survive";
    await mkdir(join(target, "logs"), { recursive: true, mode: 0o700 });
    await writeFile(join(target, "failure.json"), JSON.stringify({ message: `Authorization: Bearer ${credential}` }));
    await writeFile(
      join(target, "logs", "001-renderer.log"),
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${privateMaterial}\n`
    );

    const sourceReceipt = captureEditorAcceptanceEvidenceReceipt({ evidenceRoot, target });
    const artifactParent = createEditorAcceptanceArtifactParent(join(directory, "artifact-base"));
    const artifactReceipt = sealEditorAcceptanceEvidence({
      evidenceRoot,
      artifactParent,
      receipts: [sourceReceipt]
    });
    const artifactPath = assertSealedEditorAcceptanceArtifact(artifactReceipt);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes(credential), false);
    assert.equal(serialized.includes(privateMaterial), false);
    assert.match(serialized, /<redacted>/u);
    assert.match(serialized, /<sealed-source-omitted-sensitive-content>/u);

    await writeFile(artifactPath, "{}\n");
    assert.throws(() => assertSealedEditorAcceptanceArtifact(artifactReceipt), /pinned identity|changed/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged-editor CI uploads only the exact revalidated emitted artifact path", async () => {
  const runner = await readFile(join(repositoryRoot, "scripts", "run-packaged-editor-tests.mjs"), "utf8");
  assert.match(
    runner,
    /if \(process\.env\.GITHUB_OUTPUT\) \{\s*assertSealedEditorAcceptanceArtifact\(artifactReceipt\);\s*appendFileSync\(\s*process\.env\.GITHUB_OUTPUT,\s*`evidence_ready=true\\nevidence_path=\$\{artifactPath\}\\nevidence_sha256=\$\{artifactReceipt\.sha256\}\\nevidence_size=\$\{String\(artifactReceipt\.snapshot\.size\)\}\\n`,\s*"utf8"\s*\);/u
  );

  const workflow = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const steps = topLevelWorkflowSteps(workflow);
  const producerIndex = steps.findIndex((step) => /\bid:\s*packaged_editor\s*$/mu.test(step));
  assert.notEqual(producerIndex, -1);
  const upload = steps[producerIndex + 1];
  assert.match(upload, /uses:\s*actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(upload, /steps\.packaged_editor\.outputs\.evidence_ready\s*==\s*'true'/u);
  assert.match(upload, /path:\s*\$\{\{\s*steps\.packaged_editor\.outputs\.evidence_path\s*\}\}\s*$/mu);
  assert.match(upload, /if-no-files-found:\s*error\s*$/mu);
  assert.match(upload, /retention-days:\s*7\s*$/mu);
  assert.doesNotMatch(upload, /\n\s*path:\s*\|/u);
});

function topLevelWorkflowSteps(source) {
  const lines = source.split(/\r?\n/u);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s{6}- (?:id:|name:|uses:|run:|if:)/u.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n"));
}
