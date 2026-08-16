import * as assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertExactBytes } from "./acceptanceSourceFixture";
import type { ReleasedRDocumentFixture, ReleasedRLiterateDocumentFixture } from "./releasedDocumentFixtures";

export function readReleasedRDocumentProcessId(processIdPath: string): number {
  const bytes = readFileSync(processIdPath);
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 32, "The plain R process ID marker must stay bounded.");
  const text = bytes.toString("utf8").trim();
  assert.match(text, /^[1-9][0-9]*$/u);
  const processId = Number(text);
  assert.ok(Number.isSafeInteger(processId) && processId > 0);
  return processId;
}

export function releasedRProcessRoots(): string[] {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^openwrangler-r-/u.test(entry.name))
    .map((entry) => path.join(tmpdir(), entry.name))
    .sort();
}

export function assertReleasedRDocumentFixtureUnchanged(
  fixture: Pick<ReleasedRDocumentFixture | ReleasedRLiterateDocumentFixture, "immutableFiles">
): void {
  for (const file of fixture.immutableFiles) {
    assertExactBytes(
      readFileSync(file.path),
      file.bytes,
      `Plain R acceptance must not change ${path.basename(file.path)}.`
    );
  }
}
