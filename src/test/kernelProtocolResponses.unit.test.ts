import { afterEach, describe, expect, it } from "vitest";
import {
  kernelOutputsToFramedText,
  kernelOutputsToText,
  parseKernelResponse
} from "../extension/notebooks/kernelBridge";
import { PYTHON_STDOUT_MAX_FRAME_BYTES } from "../extension/pythonStdoutLineFramer";
import { deferred, initializedResponse, resetKernelBridgeTestState } from "./kernelBridge.testFixtures";

afterEach(resetKernelBridgeTestState);

describe("kernel protocol responses", () => {
  const marker = "requestmarker";
  const requestId = "request-id";

  function marked(response: unknown): string {
    return [`__OPEN_WRANGLER_START_${marker}__`, JSON.stringify(response), `__OPEN_WRANGLER_END_${marker}__`].join(
      "\n"
    );
  }

  async function* textOutputs(...chunks: string[]) {
    for (const text of chunks) yield { items: [], text };
  }

  it("returns a logical runtime error without treating it as a transport failure", async () => {
    const response = {
      kind: "error" as const,
      code: "engine_error",
      message: "Unknown session: missing-session",
      recoverable: true,
      viewRequestId: "view-unknown-session"
    };

    const retained = await kernelOutputsToFramedText(
      textOutputs("synthetic warning", marked({ protocolVersion: 2, requestId, response })),
      marker
    );
    expect(parseKernelResponse(retained, marker, requestId)).toEqual(response);
  });

  it("rejects malformed and stale response envelopes", () => {
    expect(() =>
      parseKernelResponse(marked({ requestId, response: { kind: "initialized" } }), marker, requestId)
    ).toThrow("invalid or stale protocol response");
    expect(() =>
      parseKernelResponse(
        marked({ protocolVersion: 2, requestId: "other-request", response: { kind: "initialized" } }),
        marker,
        requestId
      )
    ).toThrow("invalid or stale protocol response");
  });

  it("does not copy unframed output into a missing-marker diagnostic", () => {
    const privateOutput = "synthetic source output ".repeat(4_096);
    expect(() => parseKernelResponse(privateOutput, marker, requestId)).toThrow(
      /^Open Wrangler could not parse the kernel response\.$/u
    );
  });

  it("collects marker output from the stable Jupyter stdout MIME", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [{ mime: "application/x.notebook.stream.stderr", data: encoder.encode("kernel warning\n") }]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_START_${marker}__\n`)
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(
              `${JSON.stringify({ protocolVersion: 2, requestId, response: initializedResponse })}\n`
            )
          }
        ]
      };
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode(`__OPEN_WRANGLER_END_${marker}__\n`)
          }
        ]
      };
    }

    const text = await kernelOutputsToFramedText(outputs(), marker);
    expect(text).toContain(`__OPEN_WRANGLER_START_${marker}__`);
    expect(text).toContain(`__OPEN_WRANGLER_END_${marker}__`);
    expect(parseKernelResponse(text, marker, requestId)).toEqual(initializedResponse);
  });

  it("discards large preamble and trailing output while retaining the exact correlated response", async () => {
    const frame = marked({ protocolVersion: 2, requestId, response: initializedResponse });
    const noise = Buffer.from("N".repeat(64 * 1_024));
    let discardedChunks = 0;
    async function* outputs() {
      for (let side = 0; side < 2; side += 1) {
        for (let index = 0; index < 290; index += 1) {
          yield { items: [{ mime: "application/x.notebook.stream.stdout", data: noise }] };
          discardedChunks += 1;
        }
        if (side === 0) yield { items: [], text: frame };
      }
    }
    const retained = await kernelOutputsToFramedText(outputs(), marker);
    expect(discardedChunks).toBe(580);
    expect(retained).toBe(frame);
    expect(parseKernelResponse(retained, marker, requestId)).toEqual(initializedResponse);
  });

  it("recognizes every marker split and preserves split supplementary Unicode", async () => {
    const response = { kind: "error", code: "engine_error", message: "é😀__OPEN_WRANGLER_", recoverable: true };
    const frame = marked({ protocolVersion: 2, requestId, response });
    for (let split = 0; split <= frame.length; split += 1) {
      const retained = await kernelOutputsToFramedText(textOutputs(frame.slice(0, split), frame.slice(split)), marker);
      expect(parseKernelResponse(retained, marker, requestId)).toEqual(response);
    }
    const retained = await kernelOutputsToFramedText(textOutputs(...frame.split("")), marker);
    expect(parseKernelResponse(retained, marker, requestId)).toEqual(response);
  });

  it.each([0, 1])("accounts for UTF-8 and the response LF at the native ceiling plus %i byte", async (extra) => {
    const prefix = '{"value":"';
    const suffix = '"}\n';
    const fixedBytes = Buffer.byteLength(prefix + suffix);
    const characters = Math.floor((PYTHON_STDOUT_MAX_FRAME_BYTES - fixedBytes) / 4);
    const remainder = PYTHON_STDOUT_MAX_FRAME_BYTES - fixedBytes - characters * 4;
    const value = "😀".repeat(characters) + "x".repeat(remainder + extra);
    const body = prefix + value + suffix;
    expect(Buffer.byteLength(body)).toBe(PYTHON_STDOUT_MAX_FRAME_BYTES + extra);
    const frame = `__OPEN_WRANGLER_START_${marker}__\n${body}__OPEN_WRANGLER_END_${marker}__`;
    const split = frame.indexOf("😀") + 1;
    const result = kernelOutputsToFramedText(textOutputs(frame.slice(0, split), frame.slice(split)), marker);
    if (extra) await expect(result).rejects.toThrow("response exceeds the byte limit");
    else expect(await result).toBe(frame);
  });

  it.each(["missing", "duplicate", "misplaced", "decode", "oversize"] as const)(
    "waits for natural completion before reporting %s output",
    async (failure) => {
      const draining = deferred<void>();
      const release = deferred<void>();
      let completed = false;
      let settled = false;
      async function* outputs() {
        if (failure === "decode") {
          yield {
            items: [{ mime: "application/vnd.code.notebook.error", data: Buffer.from("synthetic private detail") }]
          };
        } else if (failure === "oversize") {
          yield { items: [], text: `__OPEN_WRANGLER_START_${marker}__\n` };
          const noise = "N".repeat(64 * 1_024);
          for (let index = 0; index < 273; index += 1) yield { items: [], text: noise };
        } else if (failure === "misplaced") {
          yield { items: [], text: `__OPEN_WRANGLER_END_${marker}__` };
        } else if (failure === "duplicate") {
          yield { items: [], text: marked({ protocolVersion: 2, requestId, response: initializedResponse }).repeat(2) };
        } else yield { items: [], text: "synthetic unframed output" };
        draining.resolve();
        await release.promise;
        // After refusal, decoding a later item must not end the iterator early.
        if (failure !== "missing")
          yield {
            items: [],
            get text(): string {
              throw new Error("synthetic late decoding failure");
            }
          };
        completed = true;
      }
      const result = kernelOutputsToFramedText(outputs(), marker);
      const observed = result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        await draining.promise;
        expect(settled).toBe(false);
      } finally {
        release.resolve();
      }
      const expected =
        failure === "missing"
          ? "could not parse the kernel response"
          : failure === "decode"
            ? "failed while reading its response"
            : failure === "oversize"
              ? "response exceeds the byte limit"
              : "duplicate or misplaced markers";
      await expect(result).rejects.toThrow(expected);
      await observed;
      expect(completed).toBe(true);
    }
  );

  it("keeps the first framing refusal when the underlying iterator subsequently fails", async () => {
    async function* outputs() {
      yield { items: [], text: `__OPEN_WRANGLER_END_${marker}__` };
      throw new Error("synthetic later transport failure");
    }
    await expect(kernelOutputsToFramedText(outputs(), marker)).rejects.toThrow("duplicate or misplaced markers");
  });

  it("preserves a natural transport failure and rejects stale or malformed frames after completion", async () => {
    async function* failed() {
      yield { items: [], text: "warning" };
      throw new Error("synthetic transport failure");
    }
    await expect(kernelOutputsToFramedText(failed(), marker)).rejects.toThrow("synthetic transport failure");
    for (const response of [{ protocolVersion: 2, requestId: "stale", response: initializedResponse }, {}]) {
      const frame = await kernelOutputsToFramedText(textOutputs(marked(response)), marker);
      expect(() => parseKernelResponse(frame, marker, requestId)).toThrow("invalid or stale protocol response");
    }
    const malformed = await kernelOutputsToFramedText(
      textOutputs(`__OPEN_WRANGLER_START_${marker}__\n{synthetic private payload}\n__OPEN_WRANGLER_END_${marker}__`),
      marker
    );
    expect(() => parseKernelResponse(malformed, marker, requestId)).toThrow(
      /^Open Wrangler kernel agent returned an invalid or stale protocol response\.$/u
    );
    const valid = marked({ protocolVersion: 2, requestId, response: initializedResponse });
    const retained = await kernelOutputsToFramedText(
      textOutputs(valid.replaceAll(marker, "previousmarker"), valid),
      marker
    );
    expect(parseKernelResponse(retained, marker, requestId)).toEqual(initializedResponse);
  });

  it("stops collecting kernel output at the caller's UTF-8 byte limit", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: encoder.encode("éé")
          }
        ]
      };
    }

    await expect(kernelOutputsToText(outputs(), 3)).rejects.toThrow("kernel output exceeds the byte limit");
  });

  it("surfaces stable Jupyter kernel error output instead of reporting a missing marker", async () => {
    const encoder = new TextEncoder();
    async function* outputs() {
      yield {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: encoder.encode(JSON.stringify({ name: "ModuleNotFoundError", message: "No module named 'polars'" }))
          }
        ]
      };
    }

    await expect(kernelOutputsToText(outputs())).rejects.toThrow(
      "Open Wrangler kernel execution failed (ModuleNotFoundError): No module named 'polars'"
    );
  });
});
