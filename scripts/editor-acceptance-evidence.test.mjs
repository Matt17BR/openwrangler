import assert from "node:assert/strict";
import fs from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  redactEditorAcceptanceJson,
  redactEditorAcceptanceText,
  retainEditorAcceptanceEvidence
} from "./editor-acceptance-evidence.mjs";

test("failure evidence redacts credentials and rejects private-key containers", () => {
  const secret = "diagnostic-secret-that-must-not-survive";
  const redacted = redactEditorAcceptanceText(
    `Authorization: Bearer ${secret}\nhttps://user:${secret}@example.invalid/private`
  );
  assert.equal(typeof redacted, "string");
  assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /Authorization: <redacted>/u);

  const structured = redactEditorAcceptanceJson(JSON.stringify({ password: secret, message: "safe" }));
  assert.deepEqual(JSON.parse(structured), { "<redacted-key>": "<redacted>", message: "safe" });
  assert.equal(redactEditorAcceptanceText(`-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n`), undefined);
});

test("failure evidence rejects hard links, symbolic links, and path swaps", async (context) => {
  if (process.platform === "win32") {
    context.skip("The deterministic open-file replacement requires POSIX rename semantics.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-safety-"));
  const originalReadSync = fs.readSync;
  try {
    const hardLinkFixture = await createEvidenceFixture(join(directory, "hard-link"));
    const hardLinkSecret = "HARD-LINK-SECRET-MUST-NOT-SURVIVE";
    await writeFile(hardLinkFixture.options.resultPath, `${hardLinkSecret}\n`);
    await link(hardLinkFixture.options.resultPath, join(directory, "outside-result-link"));
    const hardLinkTarget = retainEditorAcceptanceEvidence(hardLinkFixture.options);
    assert.equal(
      (await failureMetadata(hardLinkTarget)).skippedFiles.some((entry) => entry.reason === "multiple-links"),
      true
    );
    assert.equal((await readEvidenceTree(hardLinkTarget)).includes(hardLinkSecret), false);

    const symbolicLinkFixture = await createEvidenceFixture(join(directory, "symbolic-link"));
    const symbolicLinkSecret = "SYMBOLIC-LINK-SECRET-MUST-NOT-SURVIVE";
    const containedTarget = join(symbolicLinkFixture.options.profile, "contained-result.json");
    await writeFile(containedTarget, JSON.stringify({ value: symbolicLinkSecret }));
    await rm(symbolicLinkFixture.options.resultPath);
    await symlink(containedTarget, symbolicLinkFixture.options.resultPath);
    const symbolicLinkTarget = retainEditorAcceptanceEvidence(symbolicLinkFixture.options);
    assert.equal(
      (await failureMetadata(symbolicLinkTarget)).skippedFiles.some((entry) =>
        ["not-regular", "path-race"].includes(entry.reason)
      ),
      true
    );
    assert.equal((await readEvidenceTree(symbolicLinkTarget)).includes(symbolicLinkSecret), false);

    const swapFixture = await createEvidenceFixture(join(directory, "path-swap"));
    const source = swapFixture.options.resultPath;
    const backup = `${source}.original`;
    const replacement = `${source}.replacement`;
    const replacementSecret = "PATH-SWAP-SECRET-MUST-NOT-SURVIVE";
    await writeFile(replacement, JSON.stringify({ value: replacementSecret }));
    const sourceIdentity = await stat(source, { bigint: true });
    let swapped = false;
    fs.readSync = (...args) => {
      const opened = fs.fstatSync(args[0], { bigint: true });
      if (!swapped && opened.dev === sourceIdentity.dev && opened.ino === sourceIdentity.ino) {
        fs.renameSync(source, backup);
        fs.renameSync(replacement, source);
        swapped = true;
      }
      return originalReadSync(...args);
    };
    syncBuiltinESMExports();
    const swapTarget = retainEditorAcceptanceEvidence(swapFixture.options);
    assert.equal(swapped, true);
    assert.equal(
      (await failureMetadata(swapTarget)).skippedFiles.some((entry) => entry.reason === "path-race"),
      true
    );
    assert.equal((await readEvidenceTree(swapTarget)).includes(replacementSecret), false);
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createEvidenceFixture(root) {
  const temporaryRoot = join(root, "editor-temp");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "verify-result.json");
  const logRoot = join(profile, "user-data", "logs");
  await mkdir(logRoot, { recursive: true });
  await writeFile(resultPath, "{}\n");
  return {
    options: {
      evidenceRoot: join(root, "evidence"),
      temporaryRoot,
      profile,
      editor: { key: "vscode", name: "VS Code", version: "stable" },
      phase: "verify",
      error: new Error("failed"),
      hostHome: join(root, "host-home"),
      resultPath,
      logRoot
    }
  };
}

async function failureMetadata(target) {
  return JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
}

async function readEvidenceTree(root) {
  const parts = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) parts.push(await readFile(path, "utf8"));
    }
  }
  return parts.join("\n");
}
