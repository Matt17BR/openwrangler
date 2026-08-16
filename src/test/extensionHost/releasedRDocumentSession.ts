import * as assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type { TextDocument } from "vscode";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRDocumentSessionTesting = Pick<TestApi, "activeSession" | "diagnostics">;

interface ReleasedRDocumentSessionDependencies {
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
  readonly boundedImportPromptDiagnostics: (workbench: Page) => Promise<unknown>;
  readonly matchingTextDocumentCount: (uri: string) => number;
  readonly releasedJupyterSessionTabLabels: () => string[];
  readonly visibleOpenWranglerPanelAlert: (workbench: Page) => Promise<string | undefined>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
}

export function createReleasedRDocumentSession({
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
  boundedImportPromptDiagnostics,
  matchingTextDocumentCount,
  releasedJupyterSessionTabLabels,
  visibleOpenWranglerPanelAlert,
  waitFor
}: ReleasedRDocumentSessionDependencies) {
  return async function waitForReleasedRDocumentSession(
    workbench: Page,
    testing: ReleasedRDocumentSessionTesting,
    document: Pick<TextDocument, "uri">,
    variableName: string,
    description: string
  ): Promise<NonNullable<ReturnType<TestApi["activeSession"]>>> {
    try {
      await waitFor(
        () => {
          const active = testing.activeSession();
          return (
            active?.metadata.source.kind === "documentVariable" &&
            active.metadata.source.variableName === variableName &&
            active.metadata.source.uri === document.uri.toString()
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        description,
        () => JSON.stringify(testing.diagnostics())
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `Plain R panel state: ${JSON.stringify({
            alert: await visibleOpenWranglerPanelAlert(workbench),
            sessionTabs: releasedJupyterSessionTabLabels(),
            coordinator: testing.diagnostics(),
            ui: await boundedImportPromptDiagnostics(workbench)
          })}`
      );
    }
    assert.equal(
      matchingTextDocumentCount(document.uri.toString()),
      1,
      "The plain R session must retain one exact source document."
    );
    const active = testing.activeSession();
    assert.ok(active, `${description} must publish an active session.`);
    assert.equal(active.metadata.backend, "r");
    assert.equal(active.metadata.rDataframeFlavor, "r.data.frame");
    assert.equal(active.metadata.mode, "editing");
    assert.equal(active.metadata.source.kind, "documentVariable");
    assert.equal(active.metadata.source.variableName, variableName);
    assert.equal(active.metadata.source.uri, document.uri.toString());
    assert.equal(active.metadata.capabilities.notebookInsert, false);
    assert.equal(active.metadata.capabilities.documentInsert, true);
    return active;
  };
}
