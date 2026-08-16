import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReleasedRDocumentFixtureUnchanged,
  readReleasedRDocumentProcessId,
  releasedRProcessRoots
} from "./extensionHost/releasedRDocumentProcess";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("released R document process boundary", () => {
  it("reads one bounded positive process identifier and rejects malformed markers", () => {
    const root = temporaryRoot("openwrangler-r-process-test-");
    const marker = join(root, "process-id");

    writeFileSync(marker, "12345\n");
    expect(readReleasedRDocumentProcessId(marker)).toBe(12_345);

    for (const value of ["", "0", "-1", "12.5", "not-a-pid", "9".repeat(33), "9007199254740992"]) {
      writeFileSync(marker, value);
      expect(() => readReleasedRDocumentProcessId(marker)).toThrow();
    }
  });

  it("discovers only sorted Open Wrangler R process roots", () => {
    const root = temporaryRoot("released-r-root-fixture-");
    const first = join(tmpdir(), `openwrangler-r-z-${basename(root)}`);
    const second = join(tmpdir(), `openwrangler-r-a-${basename(root)}`);
    const excluded = join(tmpdir(), `released-r-${basename(root)}`);
    for (const directory of [first, second, excluded]) {
      mkdirSync(directory);
      roots.push(directory);
    }

    const discovered = releasedRProcessRoots();
    expect(discovered).toContain(first);
    expect(discovered).toContain(second);
    expect(discovered).not.toContain(excluded);
    expect(discovered).toEqual([...discovered].sort());
  });

  it("accepts immutable fixture bytes and reports the changed fixture name", () => {
    const root = temporaryRoot("released-r-fixture-test-");
    const source = join(root, "orders.R");
    const helper = join(root, "helper.R");
    writeFileSync(source, "orders <- data.frame(value = 1)\n");
    writeFileSync(helper, "identity_helper <- identity\n");
    const fixture = {
      immutableFiles: [
        { path: source, bytes: Buffer.from("orders <- data.frame(value = 1)\n") },
        { path: helper, bytes: Buffer.from("identity_helper <- identity\n") }
      ]
    };

    expect(() => assertReleasedRDocumentFixtureUnchanged(fixture)).not.toThrow();
    writeFileSync(helper, "changed <- TRUE\n");
    expect(() => assertReleasedRDocumentFixtureUnchanged(fixture)).toThrow(/must not change helper\.R/u);
  });
});
