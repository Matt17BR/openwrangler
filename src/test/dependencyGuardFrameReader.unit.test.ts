import { describe, expect, it, vi } from "vitest";
import {
  BoundedDependencyGuardFrameReader,
  DEPENDENCY_GUARD_MAX_FRAME_BYTES,
  DependencyGuardProtocolError,
  type DependencyGuardFrameStorageState
} from "../extension/dependencyGuardFrameReader";

const RELEASED_STORAGE: DependencyGuardFrameStorageState = {
  bufferedBytes: 0,
  capacity: 0,
  retainedSegments: 0
};

function recorder(): {
  readonly reader: BoundedDependencyGuardFrameReader;
  readonly frames: Array<Record<string, unknown>>;
  readonly failures: Error[];
  readonly callbackStorage: DependencyGuardFrameStorageState[];
} {
  const frames: Array<Record<string, unknown>> = [];
  const failures: Error[] = [];
  const callbackStorage: DependencyGuardFrameStorageState[] = [];
  const reader = new BoundedDependencyGuardFrameReader(
    "status",
    (frame) => {
      callbackStorage.push(reader.storageState);
      frames.push(frame);
    },
    (error) => {
      callbackStorage.push(reader.storageState);
      failures.push(error);
    }
  );
  return { reader, frames, failures, callbackStorage };
}

describe("bounded dependency guard frame reader", () => {
  it("accepts an exact-cap frame across more than 65k one-byte chunks with split UTF-8", () => {
    const prefix = Buffer.from('{"value":"', "utf8");
    const suffix = Buffer.from('é"}\n', "utf8");
    const padding = Buffer.alloc(DEPENDENCY_GUARD_MAX_FRAME_BYTES - prefix.length - suffix.length, 0x61);
    const frame = Buffer.concat([prefix, padding, suffix]);
    expect(frame).toHaveLength(DEPENDENCY_GUARD_MAX_FRAME_BYTES);
    expect(frame.includes(Buffer.from([0xc3, 0xa9]))).toBe(true);

    const recorded = recorder();
    for (let index = 0; index < frame.length - 1; index += 1) {
      recorded.reader.accept(frame.subarray(index, index + 1));
    }
    expect(recorded.reader.storageState).toEqual({
      bufferedBytes: DEPENDENCY_GUARD_MAX_FRAME_BYTES - 1,
      capacity: DEPENDENCY_GUARD_MAX_FRAME_BYTES,
      retainedSegments: 1
    });

    recorded.reader.accept(frame.subarray(-1));
    expect(recorded.failures).toEqual([]);
    expect(recorded.frames).toHaveLength(1);
    expect(recorded.frames[0]?.value).toMatch(/é$/u);
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE]);
    expect(recorded.reader.storageState).toEqual(RELEASED_STORAGE);
  });

  it.each([
    {
      name: "an unterminated frame that consumes the complete cap",
      first: Buffer.alloc(DEPENDENCY_GUARD_MAX_FRAME_BYTES, 0x61),
      second: undefined
    },
    {
      name: "a terminated frame one byte beyond the cap",
      first: Buffer.alloc(DEPENDENCY_GUARD_MAX_FRAME_BYTES - 1, 0x61),
      second: Buffer.from("a\n", "utf8")
    }
  ])("rejects $name and releases its accumulator", ({ first, second }) => {
    const recorded = recorder();
    recorded.reader.accept(first);
    if (second) recorded.reader.accept(second);

    expect(recorded.frames).toEqual([]);
    expect(recorded.failures).toHaveLength(1);
    expect(recorded.failures[0]).toBeInstanceOf(DependencyGuardProtocolError);
    expect(recorded.failures[0]?.message).toContain(`exceeded ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes`);
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE]);
    expect(recorded.reader.storageState).toEqual(RELEASED_STORAGE);
  });

  it("rejects trailing bytes without retaining or disclosing their payload", () => {
    const secret = "payload-sentinel-must-not-escape";
    const recorded = recorder();
    recorded.reader.accept(Buffer.from(`{}\n${secret}`, "utf8"));

    expect(recorded.frames).toEqual([]);
    expect(recorded.failures).toHaveLength(1);
    expect(recorded.failures[0]?.message).toContain("trailing bytes");
    expect(recorded.failures[0]?.message).not.toContain(secret);
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE]);
  });

  it("rejects a later byte after a released complete frame", () => {
    const recorded = recorder();
    recorded.reader.accept(Buffer.from("{}\n", "utf8"));
    recorded.reader.accept(Buffer.from("x", "utf8"));

    expect(recorded.frames).toEqual([{}]);
    expect(recorded.failures[0]?.message).toContain("bytes after its single result frame");
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE, RELEASED_STORAGE]);
  });

  it("rejects unsupported chunks without coercion and clears prior bytes", () => {
    const secret = "buffered-payload-sentinel";
    const unsupported = { toString: vi.fn(() => secret) };
    const recorded = recorder();
    recorded.reader.accept(Buffer.from(secret, "utf8"));
    recorded.reader.accept(unsupported);

    expect(unsupported.toString).not.toHaveBeenCalled();
    expect(recorded.failures[0]?.message).toContain("unsupported chunk type");
    expect(recorded.failures[0]?.message).not.toContain(secret);
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE]);
    expect(recorded.reader.storageState).toEqual(RELEASED_STORAGE);
  });

  it.each([
    {
      name: "CRLF termination",
      chunks: [Buffer.from("{}\r\n", "utf8")],
      diagnostic: "used CRLF instead of LF"
    },
    {
      name: "split invalid UTF-8",
      chunks: [Buffer.from('{"value":"', "utf8"), Buffer.from([0xc3]), Buffer.from([0x28]), Buffer.from('"}\n')],
      diagnostic: "was not valid UTF-8"
    },
    {
      name: "duplicate top-level keys",
      chunks: [Buffer.from('{"kind":"status","kind":"status"}\n', "utf8")],
      diagnostic: "duplicate object keys"
    }
  ])("preserves strict $name rejection", ({ chunks, diagnostic }) => {
    const recorded = recorder();
    for (const chunk of chunks) recorded.reader.accept(chunk);

    expect(recorded.frames).toEqual([]);
    expect(recorded.failures[0]?.message).toContain(diagnostic);
    expect(recorded.callbackStorage).toEqual([RELEASED_STORAGE]);
  });

  it("keeps malformed-frame diagnostics payload-free", () => {
    const secret = "malformed-payload-sentinel";
    const recorded = recorder();
    recorded.reader.accept(Buffer.from(`{${secret}}\n`, "utf8"));

    expect(recorded.failures[0]?.message).toContain("was not valid JSON");
    expect(recorded.failures[0]?.message).not.toContain(secret);
    expect(recorded.reader.storageState).toEqual(RELEASED_STORAGE);
  });

  it("releases partial storage on EOF and explicit disposal", () => {
    const eof = recorder();
    eof.reader.accept(Buffer.from('{"partial":', "utf8"));
    expect(eof.reader.storageState.retainedSegments).toBe(1);
    eof.reader.end();
    expect(eof.reader.storageState).toEqual(RELEASED_STORAGE);
    eof.reader.accept(Buffer.from("{}\n", "utf8"));
    expect(eof.frames).toEqual([]);
    expect(eof.failures).toEqual([]);

    const disposed = recorder();
    disposed.reader.accept(Buffer.from('{"partial":', "utf8"));
    disposed.reader.dispose();
    disposed.reader.dispose();
    expect(disposed.reader.storageState).toEqual(RELEASED_STORAGE);
  });
});
