import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PythonBridge } from "../extension/pythonBridge";
import {
  BoundedPythonStdoutLineFramer,
  PYTHON_STDOUT_MAX_FRAME_BYTES,
  PythonStdoutLineFramingError
} from "../extension/pythonStdoutLineFramer";

function createHarness(): {
  readonly framer: BoundedPythonStdoutLineFramer;
  readonly lines: string[];
  readonly failures: PythonStdoutLineFramingError[];
} {
  const lines: string[] = [];
  const failures: PythonStdoutLineFramingError[] = [];
  return {
    framer: new BoundedPythonStdoutLineFramer({
      onLine: (line) => lines.push(line),
      onFailure: (error) => failures.push(error)
    }),
    lines,
    failures
  };
}

class FramingChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function createBridgeFramingHarness() {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  const first = new FramingChildProcess();
  const second = new FramingChildProcess();
  const spawnProcess = vi
    .fn<() => ChildProcessWithoutNullStreams>()
    .mockReturnValueOnce(first as unknown as ChildProcessWithoutNullStreams)
    .mockReturnValueOnce(second as unknown as ChildProcessWithoutNullStreams);
  const handleLine = vi.fn();
  const runtime = {
    process: undefined as ChildProcessWithoutNullStreams | undefined,
    processSelection: undefined as unknown,
    processStart: undefined,
    processStartSelection: undefined,
    processStop: undefined,
    runtimeExitError: undefined,
    runtimeEpoch: 0,
    stderrBuffer: ""
  };
  const selection = { key: "test-scope" };
  const environment = { executable: "/env/python", version: "3.12.4", source: "configuration" };
  let rejectPending: ((error: Error) => void) | undefined;
  const pending = new Promise<never>((_resolve, reject) => {
    rejectPending = reject;
  });
  const restartRuntime = vi.fn((_runtime: unknown, reason: string) => {
    runtime.process = undefined;
    runtime.processSelection = undefined;
    runtime.runtimeEpoch += 1;
    rejectPending?.(new Error(reason));
  });
  const internals = bridge as unknown as {
    startProcessRetained(
      owner: typeof runtime,
      epoch: number,
      processSelection: { selection: typeof selection; environment: typeof environment }
    ): Promise<ChildProcessWithoutNullStreams>;
  };
  Object.assign(bridge as object, {
    context: { extensionPath: "/extension" },
    disposed: false,
    generation: 0,
    output: { append: vi.fn(), appendLine: vi.fn() },
    spawnProcess,
    runtimeTransport: { handleLine },
    assertDependencyEnvironmentAvailable: vi.fn(),
    isCurrentEnvironmentSelection: vi.fn(() => true),
    restartRuntime,
    handleProcessFailure: vi.fn()
  });

  return {
    first,
    second,
    handleLine,
    pending,
    restartRuntime,
    runtime,
    spawnProcess,
    start: (epoch: number) => internals.startProcessRetained(runtime, epoch, { selection, environment }),
    cleanup: () => {
      runtime.process = undefined;
      for (const process of [first, second]) {
        process.stdout.end();
        process.stderr.end();
        process.stdin.end();
      }
    }
  };
}

describe("BoundedPythonStdoutLineFramer", () => {
  it("preserves split multibyte UTF-8 and readline-compatible line boundaries", () => {
    const harness = createHarness();
    const encoded = Buffer.from("alpha 🙂 omega\r\n\nthird\nfourth\r\n", "utf8");
    const scalar = encoded.indexOf(Buffer.from("🙂", "utf8"));

    harness.framer.accept(encoded.subarray(0, scalar + 1));
    harness.framer.accept(encoded.subarray(scalar + 1, scalar + 3));
    harness.framer.accept(encoded.subarray(scalar + 3));
    harness.framer.end();

    expect(harness.lines).toEqual(["alpha 🙂 omega", "", "third", "fourth"]);
    expect(harness.failures).toEqual([]);
  });

  it("accepts a frame delivered as many tiny chunks without retaining chunk metadata", () => {
    const harness = createHarness();
    const expected = `${"a".repeat(64 * 1_024)}🙂many-small-chunks`;
    const encoded = Buffer.from(`${expected}\n`, "utf8");
    for (let offset = 0; offset < encoded.length; offset += 1) {
      harness.framer.accept(encoded.subarray(offset, offset + 1));
    }
    harness.framer.end();

    expect(harness.lines).toEqual([expected]);
    expect(harness.failures).toEqual([]);
  });

  it("accepts an exact-cap frame with its LF included", () => {
    const harness = createHarness();
    const payload = Buffer.alloc(PYTHON_STDOUT_MAX_FRAME_BYTES - 1, 0x61);

    harness.framer.accept(payload);
    harness.framer.accept(Buffer.from("\n"));
    harness.framer.end();

    expect(harness.lines).toHaveLength(1);
    expect(Buffer.byteLength(harness.lines[0]!, "utf8") + 1).toBe(PYTHON_STDOUT_MAX_FRAME_BYTES);
    expect(harness.failures).toEqual([]);
  });

  it("rejects an over-cap no-newline frame before decoding and redacts its bytes", () => {
    const onLine = vi.fn();
    const onFailure = vi.fn();
    const framer = new BoundedPythonStdoutLineFramer({ onLine, onFailure });
    const secret = "credential=do-not-log";

    framer.accept(Buffer.alloc(PYTHON_STDOUT_MAX_FRAME_BYTES - 1, 0x61));
    framer.accept(Buffer.from(secret));
    framer.accept(Buffer.from("ignored\n"));
    framer.end();
    framer.streamError();

    expect(onLine).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
    const failure = onFailure.mock.calls[0]![0] as PythonStdoutLineFramingError;
    expect(failure).toMatchObject({ code: "frame_too_large" });
    expect(failure.message).toContain(`${PYTHON_STDOUT_MAX_FRAME_BYTES} bytes including LF`);
    expect(failure.message).not.toContain(secret);
    expect(Buffer.byteLength(failure.message, "utf8")).toBeLessThan(256);
  });

  it("makes invalid UTF-8 and unsupported chunks terminal exactly once", () => {
    const invalid = createHarness();
    invalid.framer.accept(Buffer.from([0x66, 0x80, 0x0a]));
    invalid.framer.accept(Buffer.from("valid\n"));
    invalid.framer.end();
    expect(invalid.lines).toEqual([]);
    expect(invalid.failures).toMatchObject([{ code: "invalid_utf8" }]);

    const unsupported = createHarness();
    unsupported.framer.accept("payload\n");
    unsupported.framer.accept(Buffer.from("valid\n"));
    unsupported.framer.streamError();
    expect(unsupported.lines).toEqual([]);
    expect(unsupported.failures).toMatchObject([{ code: "unsupported_chunk" }]);
  });

  it("distinguishes a clean EOF from one partial frame", () => {
    const clean = createHarness();
    clean.framer.accept(Buffer.from("complete\n"));
    clean.framer.end();
    clean.framer.accept(Buffer.from("ignored\n"));
    expect(clean.lines).toEqual(["complete"]);
    expect(clean.failures).toEqual([]);

    const partial = createHarness();
    partial.framer.accept(Buffer.from("secret-partial"));
    partial.framer.end();
    partial.framer.end();
    expect(partial.lines).toEqual([]);
    expect(partial.failures).toMatchObject([{ code: "partial_frame" }]);
    expect(partial.failures[0]!.message).not.toContain("secret-partial");
  });

  it("lets the owner reject pending work once and recover with a fresh framer", async () => {
    let rejectPending: ((error: Error) => void) | undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectPending = reject;
    });
    const restart = vi.fn((error: PythonStdoutLineFramingError) => rejectPending?.(error));
    const failed = new BoundedPythonStdoutLineFramer({ onLine: vi.fn(), onFailure: restart });

    failed.streamError();
    failed.streamError();
    await expect(pending).rejects.toMatchObject({ code: "stream_error" });
    expect(restart).toHaveBeenCalledOnce();

    const replacement = createHarness();
    replacement.framer.accept(new Uint8Array(Buffer.from('{"below":"cap"}\n')));
    replacement.framer.end();
    expect(replacement.lines).toEqual(['{"below":"cap"}']);
    expect(replacement.failures).toEqual([]);
  });

  it("routes a terminal frame failure through the bridge restart boundary before a replacement starts", async () => {
    const harness = createBridgeFramingHarness();
    const pendingRejection = expect(harness.pending).rejects.toThrow("including LF");

    await harness.start(0);
    harness.first.stdout.write(Buffer.alloc(PYTHON_STDOUT_MAX_FRAME_BYTES, 0x61));
    await pendingRejection;

    expect(harness.restartRuntime).toHaveBeenCalledOnce();
    expect(harness.handleLine).not.toHaveBeenCalled();
    await harness.start(1);
    harness.second.stdout.write(Buffer.from('{"kind":"below-cap"}\n'));
    expect(harness.handleLine).toHaveBeenCalledWith(harness.runtime, harness.second, '{"kind":"below-cap"}');
    expect(harness.spawnProcess).toHaveBeenCalledTimes(2);
    harness.cleanup();
  });

  it("restarts a still-current process whose stdout ends after a complete frame", async () => {
    const harness = createBridgeFramingHarness();
    const pendingRejection = expect(harness.pending).rejects.toThrow("stdout ended unexpectedly");

    await harness.start(0);
    harness.first.stdout.write(Buffer.from('{"kind":"complete"}\n'));
    harness.first.stdout.end();
    await pendingRejection;

    expect(harness.handleLine).toHaveBeenCalledWith(harness.runtime, harness.first, '{"kind":"complete"}');
    expect(harness.restartRuntime).toHaveBeenCalledOnce();
    expect(harness.runtime.process).toBeUndefined();
    harness.cleanup();
  });

  it("suppresses all callbacks after disposal", () => {
    const harness = createHarness();
    harness.framer.accept(Buffer.from("partial"));
    harness.framer.dispose();
    harness.framer.accept(Buffer.from("\nnext\n"));
    harness.framer.end();
    harness.framer.streamError();

    expect(harness.lines).toEqual([]);
    expect(harness.failures).toEqual([]);
  });
});
