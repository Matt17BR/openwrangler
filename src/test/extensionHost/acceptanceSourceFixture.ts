import * as assert from "node:assert/strict";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";

const EXACT_BYTE_ASSERTION_CONTEXT_LIMIT = 240;

export function assertExactBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  const context = boundedExactByteAssertionContext(message);
  if (actual.byteLength !== expected.byteLength) {
    assert.fail(
      `${context} Byte length differs; expected ${expected.byteLength} bytes, received ${actual.byteLength} bytes.`
    );
  }
  if (Buffer.compare(actual, expected) === 0) return;

  let offset = 0;
  while (offset < actual.byteLength && actual[offset] === expected[offset]) offset += 1;
  assert.fail(
    `${context} First differing byte is at offset ${offset}; expected ${expected[offset]}, received ${actual[offset]}.`
  );
}

function boundedExactByteAssertionContext(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim() || "Byte sequences must match.";
  return normalized.length <= EXACT_BYTE_ASSERTION_CONTEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, EXACT_BYTE_ASSERTION_CONTEXT_LIMIT - 1)}…`;
}

export function exerciseBoundedExactByteAssertionContract(): void {
  const expected = Buffer.alloc(2 * 1024 * 1024);
  const actual = Buffer.from(expected);
  actual[actual.length - 1] = 1;

  let diagnostic = "";
  try {
    assertExactBytes(actual, expected, "Synthetic large source preservation mismatch.");
  } catch (error) {
    diagnostic = String(error);
  }
  assert.ok(diagnostic, "The synthetic byte mismatch must fail.");
  assert.ok(diagnostic.length < 512, "Exact-byte mismatch diagnostics must remain bounded.");
  assert.match(diagnostic, /offset 2097151; expected 0, received 1/u);
  assert.doesNotMatch(diagnostic, /<Buffer|actual:|expected:/u);
}

export function ensureDeterministicDelimitedFixturePath(
  fixturePath: string,
  expected: string,
  description: string
): void {
  try {
    writeFileSync(fixturePath, expected, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    const descriptor = openSync(fixturePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      assert.equal(opened.isFile(), true, `An existing ${description} fixture must remain a regular file.`);
      assert.equal(opened.nlink, 1n, `An existing ${description} fixture must not be hard linked.`);
      assertExactBytes(
        readFileSync(descriptor),
        Buffer.from(expected, "utf8"),
        `An existing ${description} fixture must retain the exact deterministic source bytes.`
      );
      const completed = fstatSync(descriptor, { bigint: true });
      assert.equal(completed.dev, opened.dev, `The ${description} fixture device changed while it was read.`);
      assert.equal(completed.ino, opened.ino, `The ${description} fixture identity changed while it was read.`);
      assert.equal(completed.size, opened.size, `The ${description} fixture size changed while it was read.`);
      assert.equal(
        completed.mtimeNs,
        opened.mtimeNs,
        `The ${description} fixture modification time changed while it was read.`
      );
    } finally {
      closeSync(descriptor);
    }
  }
}
