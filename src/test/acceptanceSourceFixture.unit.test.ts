import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactBytes,
  ensureDeterministicDelimitedFixturePath,
  exerciseBoundedExactByteAssertionContract
} from "./extensionHost/acceptanceSourceFixture";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixturePath(name = "fixture.csv"): string {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-source-fixture-"));
  roots.push(root);
  return join(root, name);
}

describe("acceptance source fixture boundary", () => {
  it("accepts exact bytes and reports a bounded first-difference diagnostic", () => {
    expect(() => assertExactBytes(Buffer.from([1, 2]), Buffer.from([1, 2]), "exact")).not.toThrow();
    expect(() => assertExactBytes(Buffer.from([1, 3]), Buffer.from([1, 2]), "  changed   source  ")).toThrow(
      /changed source First differing byte is at offset 1; expected 2, received 3/u
    );
    expect(() => assertExactBytes(Buffer.from([1]), Buffer.from([1, 2]), "length")).toThrow(
      /length Byte length differs; expected 2 bytes, received 1 bytes/u
    );

    exerciseBoundedExactByteAssertionContract();
  });

  it("creates one deterministic source and accepts its unchanged replay", () => {
    const fixture = fixturePath();

    ensureDeterministicDelimitedFixturePath(fixture, "name,value\nalpha,1\n", "test");
    ensureDeterministicDelimitedFixturePath(fixture, "name,value\nalpha,1\n", "test");

    expect(readFileSync(fixture, "utf8")).toBe("name,value\nalpha,1\n");
  });

  it("rejects changed bytes and hard-linked existing fixtures", () => {
    const changed = fixturePath("changed.csv");
    writeFileSync(changed, "changed\n");
    expect(() => ensureDeterministicDelimitedFixturePath(changed, "expected\n", "changed")).toThrow(
      /exact deterministic source bytes/u
    );

    const linked = fixturePath("linked.csv");
    writeFileSync(linked, "expected\n");
    linkSync(linked, join(linked, "..", "linked-copy.csv"));
    expect(() => ensureDeterministicDelimitedFixturePath(linked, "expected\n", "linked")).toThrow(
      /must not be hard linked/u
    );
  });
});
