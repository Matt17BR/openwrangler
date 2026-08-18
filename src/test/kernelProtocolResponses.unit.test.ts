import { afterEach, describe, expect, it } from "vitest";
import { kernelOutputsToText, parseKernelResponse } from "../extension/notebooks/kernelBridge";
import { initializedResponse, resetKernelBridgeTestState } from "./kernelBridge.testFixtures";

afterEach(resetKernelBridgeTestState);

describe("kernel protocol responses", () => {
  const marker = "requestmarker";
  const requestId = "request-id";

  function marked(response: unknown): string {
    return [`__OPEN_WRANGLER_START_${marker}__`, JSON.stringify(response), `__OPEN_WRANGLER_END_${marker}__`].join(
      "\n"
    );
  }

  it("returns a logical runtime error without treating it as a transport failure", () => {
    const response = {
      kind: "error" as const,
      code: "engine_error",
      message: "Unknown session: missing-session",
      recoverable: true,
      viewRequestId: "view-unknown-session"
    };

    expect(parseKernelResponse(marked({ protocolVersion: 2, requestId, response }), marker, requestId)).toEqual(
      response
    );
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

    const text = await kernelOutputsToText(outputs());
    expect(text).toContain(`__OPEN_WRANGLER_START_${marker}__`);
    expect(text).toContain(`__OPEN_WRANGLER_END_${marker}__`);
    expect(parseKernelResponse(text, marker, requestId)).toEqual(initializedResponse);
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
