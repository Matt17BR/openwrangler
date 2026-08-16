import { TextDecoder } from "node:util";

export const DEPENDENCY_GUARD_MAX_FRAME_BYTES = 65_536;

export type DependencyGuardMode = "install" | "status" | "validate";

export class DependencyGuardProtocolError extends Error {
  constructor(
    readonly mode: DependencyGuardMode,
    message: string
  ) {
    super(`Open Wrangler dependency guard ${mode} protocol failed: ${message}`);
    this.name = "DependencyGuardProtocolError";
  }
}

export interface DependencyGuardFrameStorageState {
  readonly bufferedBytes: number;
  readonly capacity: number;
  readonly retainedSegments: 0 | 1;
}

export class BoundedDependencyGuardFrameReader {
  private storage: Buffer | undefined;
  private byteLength = 0;
  private frameReceived = false;
  private failed = false;
  private disposed = false;

  constructor(
    private readonly mode: DependencyGuardMode,
    private readonly onFrame: (frame: Record<string, unknown>) => void,
    private readonly onFailure: (error: Error) => void
  ) {}

  get storageState(): DependencyGuardFrameStorageState {
    return {
      bufferedBytes: this.byteLength,
      capacity: this.storage?.length ?? 0,
      retainedSegments: this.storage ? 1 : 0
    };
  }

  accept(chunk: unknown): void {
    if (this.failed || this.disposed) return;
    const bytes = dependencyGuardOutputBytes(chunk);
    if (!bytes) {
      this.fail("the helper output stream emitted an unsupported chunk type");
      return;
    }
    if (bytes.length === 0) return;
    if (this.frameReceived) {
      this.fail("the helper emitted bytes after its single result frame");
      return;
    }

    const newline = bytes.indexOf(0x0a);
    if (newline === -1) {
      if (this.byteLength + bytes.length >= DEPENDENCY_GUARD_MAX_FRAME_BYTES) {
        this.fail(`the helper frame exceeded ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes including LF`);
        return;
      }
      this.append(bytes);
      return;
    }
    if (newline !== bytes.length - 1) {
      this.fail("the helper emitted more than one frame or trailing bytes");
      return;
    }
    if (this.byteLength + bytes.length > DEPENDENCY_GUARD_MAX_FRAME_BYTES) {
      this.fail(`the helper frame exceeded ${DEPENDENCY_GUARD_MAX_FRAME_BYTES} bytes including LF`);
      return;
    }

    this.append(bytes);
    this.frameReceived = true;
    try {
      const decoded = decodeDependencyGuardFrame(this.storage!.subarray(0, this.byteLength), this.mode);
      this.releaseStorage();
      this.onFrame(decoded);
    } catch (error) {
      this.fail(asError(error).message, error instanceof DependencyGuardProtocolError ? error : undefined);
    }
  }

  end(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseStorage();
  }

  private append(bytes: Buffer): void {
    const required = this.byteLength + bytes.length;
    if (!this.storage || this.storage.length < required) {
      const previous = this.storage;
      let capacity = this.storage?.length ?? 256;
      while (capacity < required) capacity = Math.min(capacity * 2, DEPENDENCY_GUARD_MAX_FRAME_BYTES);
      const grown = Buffer.allocUnsafe(capacity);
      if (previous && this.byteLength > 0) previous.copy(grown, 0, 0, this.byteLength);
      previous?.fill(0);
      this.storage = grown;
    }
    bytes.copy(this.storage, this.byteLength);
    this.byteLength = required;
  }

  private fail(message: string, existing?: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.releaseStorage();
    this.onFailure(existing ?? new DependencyGuardProtocolError(this.mode, message));
  }

  private releaseStorage(): void {
    this.storage?.fill(0);
    this.storage = undefined;
    this.byteLength = 0;
  }
}

function decodeDependencyGuardFrame(frame: Buffer, mode: DependencyGuardMode): Record<string, unknown> {
  if (frame.length === 0 || frame[frame.length - 1] !== 0x0a) {
    throw new DependencyGuardProtocolError(mode, "the helper frame was not LF terminated");
  }
  if (frame.length > 1 && frame[frame.length - 2] === 0x0d) {
    throw new DependencyGuardProtocolError(mode, "the helper frame used CRLF instead of LF");
  }
  const payload = frame.subarray(0, -1);
  if (payload.length === 0 || payload.includes(0x00)) {
    throw new DependencyGuardProtocolError(mode, "the helper frame was empty or contained NUL");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    throw new DependencyGuardProtocolError(mode, "the helper frame was not valid UTF-8");
  }
  if (hasDuplicateTopLevelJsonKeys(text)) {
    throw new DependencyGuardProtocolError(mode, "the helper frame contained duplicate object keys");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    throw new DependencyGuardProtocolError(mode, "the helper frame was not valid JSON");
  }
  if (!isRecord(decoded)) {
    throw new DependencyGuardProtocolError(mode, "the helper frame was not a JSON object");
  }
  return decoded;
}

function hasDuplicateTopLevelJsonKeys(text: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  let expectsKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index = endOfJsonString(text, index);
      if (index < 0) return false;
      if (depth === 1 && expectsKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return false;
        }
        if (typeof key === "string") {
          if (keys.has(key)) return true;
          keys.add(key);
        }
        expectsKey = false;
      }
      continue;
    }
    if (character === "{") {
      depth += 1;
      if (depth === 1) expectsKey = true;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      continue;
    }
    if (character === "," && depth === 1) expectsKey = true;
  }
  return false;
}

function endOfJsonString(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index;
  }
  return -1;
}

function dependencyGuardOutputBytes(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
