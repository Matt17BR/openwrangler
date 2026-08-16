// This is the complete emitted frame (response envelope plus LF), not a page's
// payload budget. The legacy Python publisher may still fail this host ceiling
// until its serialization contract is aligned separately.
export const PYTHON_STDOUT_MAX_FRAME_BYTES = 17 * 1_024 * 1_024;

export type PythonStdoutLineFramingErrorCode =
  "frame_too_large" | "invalid_utf8" | "partial_frame" | "stream_error" | "unsupported_chunk";

export class PythonStdoutLineFramingError extends Error {
  constructor(
    readonly code: PythonStdoutLineFramingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PythonStdoutLineFramingError";
  }
}

export interface PythonStdoutLineFramerHooks {
  /** Receives only the decoded bytes before LF, with at most one terminal CR removed. */
  readonly onLine: (line: string) => void;
  /** Receives one bounded, payload-free terminal framing error. */
  readonly onFailure: (error: PythonStdoutLineFramingError) => void;
}

/**
 * Bounds and decodes the standalone Python process's raw LF-delimited stdout.
 * Protocol parsing, request correlation, and runtime recovery belong to callers.
 */
export class BoundedPythonStdoutLineFramer {
  private buffered = Buffer.alloc(0);
  private bufferedBytes = 0;
  private state: "active" | "disposed" | "ended" | "failed" = "active";

  constructor(private readonly hooks: PythonStdoutLineFramerHooks) {}

  accept(chunk: unknown): void {
    if (this.state !== "active") return;
    const bytes = stdoutBytes(chunk);
    if (!bytes) {
      this.fail("unsupported_chunk", "Open Wrangler Python runtime stdout emitted an unsupported chunk type.");
      return;
    }

    let offset = 0;
    while (offset < bytes.length && this.state === "active") {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline === -1) {
        const remainder = bytes.subarray(offset);
        // The cap includes the required LF, so a non-terminated frame may retain
        // at most max - 1 bytes.
        if (this.bufferedBytes + remainder.length >= PYTHON_STDOUT_MAX_FRAME_BYTES) {
          this.fail(
            "frame_too_large",
            `Open Wrangler Python runtime stdout frame exceeded ${PYTHON_STDOUT_MAX_FRAME_BYTES} bytes including LF.`
          );
          return;
        }
        if (remainder.length > 0) {
          this.append(remainder);
        }
        return;
      }

      const payload = bytes.subarray(offset, newline);
      const frameBytes = this.bufferedBytes + payload.length + 1;
      if (frameBytes > PYTHON_STDOUT_MAX_FRAME_BYTES) {
        this.fail(
          "frame_too_large",
          `Open Wrangler Python runtime stdout frame exceeded ${PYTHON_STDOUT_MAX_FRAME_BYTES} bytes including LF.`
        );
        return;
      }

      const buffered = this.bufferedBytes > 0 ? this.buffered.subarray(0, this.bufferedBytes) : undefined;
      this.buffered = Buffer.alloc(0);
      this.bufferedBytes = 0;

      let line: string;
      try {
        line = decodeFrame(buffered, payload);
      } catch {
        this.fail("invalid_utf8", "Open Wrangler Python runtime stdout frame was not valid UTF-8.");
        return;
      }
      this.hooks.onLine(line);
      offset = newline + 1;
    }
  }

  end(): void {
    if (this.state !== "active") return;
    if (this.bufferedBytes > 0) {
      this.fail("partial_frame", "Open Wrangler Python runtime stdout ended with a non-LF-terminated frame.");
      return;
    }
    this.state = "ended";
  }

  streamError(): void {
    if (this.state !== "active") return;
    this.fail("stream_error", "Open Wrangler Python runtime stdout stream failed.");
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.buffered = Buffer.alloc(0);
    this.bufferedBytes = 0;
  }

  private append(bytes: Buffer): void {
    const required = this.bufferedBytes + bytes.length;
    if (required > this.buffered.length) {
      let capacity = Math.max(8 * 1_024, this.buffered.length);
      while (capacity < required) {
        capacity = Math.min(PYTHON_STDOUT_MAX_FRAME_BYTES - 1, Math.max(required, capacity * 2));
      }
      const replacement = Buffer.allocUnsafe(capacity);
      this.buffered.copy(replacement, 0, 0, this.bufferedBytes);
      this.buffered = replacement;
    }
    bytes.copy(this.buffered, this.bufferedBytes);
    this.bufferedBytes = required;
  }

  private fail(code: PythonStdoutLineFramingErrorCode, message: string): void {
    if (this.state !== "active") return;
    this.state = "failed";
    this.buffered = Buffer.alloc(0);
    this.bufferedBytes = 0;
    this.hooks.onFailure(new PythonStdoutLineFramingError(code, message));
  }
}

function stdoutBytes(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return undefined;
}

function decodeFrame(buffered: Buffer | undefined, payload: Buffer): string {
  const head = buffered && payload.length > 0 ? buffered : undefined;
  let tail = payload.length > 0 ? payload : (buffered ?? payload);
  if (tail.length > 0 && tail[tail.length - 1] === 0x0d) tail = tail.subarray(0, -1);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return head ? decoder.decode(head, { stream: true }) + decoder.decode(tail) : decoder.decode(tail);
}
