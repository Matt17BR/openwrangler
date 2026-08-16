import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { TextDocument } from "vscode";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { createReleasedRDocumentSession } from "./extensionHost/releasedRDocumentSession";

const workbench = {} as Page;
const document = { uri: { toString: () => "file:///workspace/orders.R" } } as unknown as Pick<TextDocument, "uri">;

function activeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-r-document",
    metadata: {
      backend: "r",
      rDataframeFlavor: "r.data.frame",
      mode: "editing",
      source: {
        kind: "documentVariable",
        variableName: "orders_frame",
        uri: "file:///workspace/orders.R"
      },
      capabilities: {
        notebookInsert: false,
        documentInsert: true
      },
      ...overrides
    }
  } as NonNullable<ReturnType<TestApi["activeSession"]>>;
}

function fixture() {
  let active: ReturnType<TestApi["activeSession"]> = activeSession();
  const diagnostics = vi.fn(() => ({ activeSessionId: active?.sessionId, sessionCount: Number(Boolean(active)) }));
  const testing = {
    activeSession: vi.fn(() => active),
    diagnostics
  } as unknown as Pick<TestApi, "activeSession" | "diagnostics">;
  const matchingTextDocumentCount = vi.fn(() => 1);
  const releasedJupyterSessionTabLabels = vi.fn(() => ["Open Wrangler: orders_frame"]);
  const visibleOpenWranglerPanelAlert = vi.fn<(workbench: Page) => Promise<string | undefined>>(async () => undefined);
  const boundedImportPromptDiagnostics = vi.fn<(workbench: Page) => Promise<unknown>>(async () => ({
    quickInputs: []
  }));
  const waitFor = vi.fn<
    (predicate: () => boolean, timeoutMs: number, expectation: string, diagnostics?: () => string) => Promise<void>
  >(async (predicate) => {
    if (!predicate()) throw new Error("predicate was not satisfied");
  });
  const waitForSession = createReleasedRDocumentSession({
    SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: 45_000,
    boundedImportPromptDiagnostics,
    matchingTextDocumentCount,
    releasedJupyterSessionTabLabels,
    visibleOpenWranglerPanelAlert,
    waitFor
  });
  return {
    boundedImportPromptDiagnostics,
    diagnostics,
    matchingTextDocumentCount,
    releasedJupyterSessionTabLabels,
    setActive(value: ReturnType<TestApi["activeSession"]>) {
      active = value;
    },
    testing,
    visibleOpenWranglerPanelAlert,
    waitFor,
    waitForSession
  };
}

describe("released R document session", () => {
  it("waits for the exact document variable and validates its editable R boundary", async () => {
    const test = fixture();
    test.waitFor.mockImplementationOnce(async (predicate, timeoutMs, expectation, diagnostics) => {
      expect(timeoutMs).toBe(45_000);
      expect(expectation).toBe("the exact document variable");

      test.setActive(activeSession({ source: { kind: "notebookVariable", variableName: "orders_frame" } }));
      expect(predicate()).toBe(false);
      test.setActive(
        activeSession({
          source: {
            kind: "documentVariable",
            variableName: "other_frame",
            uri: "file:///workspace/orders.R"
          }
        })
      );
      expect(predicate()).toBe(false);
      test.setActive(
        activeSession({
          source: {
            kind: "documentVariable",
            variableName: "orders_frame",
            uri: "file:///workspace/other.R"
          }
        })
      );
      expect(predicate()).toBe(false);
      test.setActive(activeSession());
      expect(predicate()).toBe(true);
      expect(JSON.parse(diagnostics?.() ?? "{}")).toEqual({
        activeSessionId: "session-r-document",
        sessionCount: 1
      });
    });

    await expect(
      test.waitForSession(workbench, test.testing, document, "orders_frame", "the exact document variable")
    ).resolves.toEqual(activeSession());
    expect(test.matchingTextDocumentCount).toHaveBeenCalledExactlyOnceWith("file:///workspace/orders.R");
  });

  it("rejects an ambiguous open document before accepting the session", async () => {
    const test = fixture();
    test.matchingTextDocumentCount.mockReturnValue(2);

    await expect(
      test.waitForSession(workbench, test.testing, document, "orders_frame", "the exact document variable")
    ).rejects.toThrow(/retain one exact source document/u);
  });

  it.each([
    ["backend", { backend: "python" }],
    ["R dataframe flavor", { rDataframeFlavor: "r.tibble" }],
    ["editing mode", { mode: "viewing" }],
    ["source kind", { source: { kind: "notebookVariable", variableName: "orders_frame" } }],
    [
      "variable name",
      {
        source: {
          kind: "documentVariable",
          variableName: "other_frame",
          uri: "file:///workspace/orders.R"
        }
      }
    ],
    [
      "source URI",
      {
        source: {
          kind: "documentVariable",
          variableName: "orders_frame",
          uri: "file:///workspace/other.R"
        }
      }
    ],
    ["notebook insertion", { capabilities: { notebookInsert: true, documentInsert: true } }],
    ["document insertion", { capabilities: { notebookInsert: false, documentInsert: false } }]
  ])("fails closed when the %s boundary drifts", async (_label, override) => {
    const test = fixture();
    test.setActive(activeSession(override));
    test.waitFor.mockImplementationOnce(async () => {
      test.setActive(activeSession(override));
    });

    await expect(
      test.waitForSession(workbench, test.testing, document, "orders_frame", "the exact document variable")
    ).rejects.toThrow();
  });

  it("adds bounded panel, tab, coordinator, and UI evidence to a polling failure", async () => {
    const test = fixture();
    test.waitFor.mockRejectedValueOnce(new Error("session polling failed"));
    test.visibleOpenWranglerPanelAlert.mockResolvedValueOnce("R runtime failed visibly");
    test.releasedJupyterSessionTabLabels.mockReturnValueOnce(["Open Wrangler: failed orders"]);
    test.boundedImportPromptDiagnostics.mockResolvedValueOnce({ dialogs: ["Choose an R dataframe"] });

    const failure = await test
      .waitForSession(workbench, test.testing, document, "orders_frame", "the exact document variable")
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("session polling failed");
    expect(String(failure)).toContain('"alert":"R runtime failed visibly"');
    expect(String(failure)).toContain('"sessionTabs":["Open Wrangler: failed orders"]');
    expect(String(failure)).toContain('"coordinator":{"activeSessionId":"session-r-document","sessionCount":1}');
    expect(String(failure)).toContain('"ui":{"dialogs":["Choose an R dataframe"]}');
    expect(test.matchingTextDocumentCount).not.toHaveBeenCalled();
  });
});
