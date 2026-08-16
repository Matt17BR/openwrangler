import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { NotebookDocument } from "vscode";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata } from "../shared/protocol";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { createReleasedRTextOperations } from "./extensionHost/releasedRTextOperations";

const workbench = {} as Page;
const notebook = {} as NotebookDocument;
const schema = [
  { id: "c:row", name: "row", position: 0 },
  { id: "c:value", name: "value", position: 1 },
  { id: "c:label", name: "label", position: 2 },
  { id: "c:group", name: "group", position: 3 }
] as SessionMetadata["schema"];

function fakeTesting(kind: "stripText" | "splitText") {
  const requests: OpenWranglerRequest[] = [];
  const testing = {
    activeSession: () => ({ sessionId: "session-r", metadata: { revision: 7, schema } }),
    request: async (request: OpenWranglerRequest) => {
      requests.push(request);
      if (request.kind === "previewStep") {
        return {
          kind: "stepPreview",
          revision: 8,
          page: { rows: [{ values: [{ display: "0001" }] }] },
          code:
            kind === "splitText"
              ? "orders_frame$label_number <- .ow_text_delimiter(orders_frame$label, '-')"
              : "orders_frame$label <- .ow_text_strip_characters(orders_frame$label, 'row-')"
        } as OpenWranglerResponse;
      }
      return { kind: "planUpdated", revision: 9 } as OpenWranglerResponse;
    }
  } as unknown as TestApi;
  return { requests, testing };
}

function responseTesting(responses: OpenWranglerResponse[]) {
  const request = vi.fn(async () => responses.shift()!);
  const testing = {
    activeSession: () => ({ sessionId: "session-r", metadata: { revision: 7, schema } }),
    request
  } as unknown as TestApi;
  return { request, testing };
}

function stripPreview(overrides: Record<string, unknown> = {}): OpenWranglerResponse {
  return {
    kind: "stepPreview",
    revision: 8,
    page: { rows: [{ values: [{ display: "0001" }] }] },
    code: "orders_frame$label <- .ow_text_strip_characters(orders_frame$label, 'row-')",
    ...overrides
  } as OpenWranglerResponse;
}

describe("released R text operations", () => {
  it.each([
    [
      "stripText",
      {
        id: "released-r-strip-label",
        kind: "stripText",
        params: { column: { id: "c:label", name: "label" }, characters: "row-" }
      },
      2
    ],
    [
      "splitText",
      {
        id: "released-r-split-label",
        kind: "splitText",
        params: { column: { id: "c:label", name: "label" }, delimiter: "-", index: 1, newColumn: "label_number" }
      },
      4
    ]
  ] as const)("owns the exact %s preview and discard requests", async (kind, step, columnOffset) => {
    const exerciseReleasedREditingJourney = vi.fn(async () => undefined);
    const owner = createReleasedRTextOperations({ exerciseReleasedREditingJourney });
    const { requests, testing } = fakeTesting(kind);

    await owner.previewAndDiscardReleasedRTextTool(testing, "session-r", schema[2]!, kind);

    expect(requests).toEqual([
      {
        kind: "previewStep",
        sessionId: "session-r",
        revision: 7,
        step,
        offset: 0,
        limit: 1,
        columnOffset,
        columnLimit: 1
      },
      {
        kind: "discardDraft",
        sessionId: "session-r",
        revision: 8,
        offset: 0,
        limit: 1,
        columnOffset: 0,
        columnLimit: 1
      }
    ]);
  });

  it("fails before request dispatch without one active session", async () => {
    const request = vi.fn(
      async () =>
        ({
          kind: "error",
          code: "runtime_error",
          message: "unexpected dispatch",
          recoverable: false
        }) as OpenWranglerResponse
    );
    const owner = createReleasedRTextOperations({ exerciseReleasedREditingJourney: vi.fn(async () => undefined) });
    const testing = { activeSession: () => undefined, request } as unknown as TestApi;

    await expect(
      owner.previewAndDiscardReleasedRTextTool(testing, "session-r", schema[2]!, "stripText")
    ).rejects.toThrow(/requires one active session/u);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-preview response", [{ kind: "error", message: "preview failed" }], /must preview/u],
    ["the wrong preview value", [stripPreview({ page: { rows: [{ values: [{ display: "0002" }] }] } })], /0001/u],
    [
      "foreign generated code",
      [stripPreview({ code: ".ow_text_strip_characters(orders_frame$label, 'row-'); pandas.DataFrame()" })],
      /not match/u
    ],
    ["a non-discard response", [stripPreview(), { kind: "error", message: "discard failed" }], /must discard cleanly/u]
  ] as const)("fails closed for %s", async (_label, responseValues, expected) => {
    const owner = createReleasedRTextOperations({ exerciseReleasedREditingJourney: vi.fn(async () => undefined) });
    const { testing } = responseTesting([...responseValues] as OpenWranglerResponse[]);

    await expect(
      owner.previewAndDiscardReleasedRTextTool(testing, "session-r", schema[2]!, "stripText")
    ).rejects.toThrow(expected);
  });

  it("routes the value-operations journey through the exact editing catalog", async () => {
    const exerciseReleasedREditingJourney = vi.fn(async () => undefined);
    const owner = createReleasedRTextOperations({ exerciseReleasedREditingJourney });
    const testing = {} as TestApi;

    await owner.exerciseReleasedRValueOperationsJourney(
      testing,
      workbench,
      "session-r",
      notebook,
      "/workspace/orders.ipynb",
      "/workspace/evidence",
      "jupyter-r",
      "/workspace/evidence/value.png"
    );

    expect(exerciseReleasedREditingJourney).toHaveBeenCalledExactlyOnceWith(
      testing,
      workbench,
      "session-r",
      notebook,
      "/workspace/orders.ipynb",
      "/workspace/evidence",
      "jupyter-r",
      "/workspace/evidence/value.png",
      "value-operations"
    );
  });
});
