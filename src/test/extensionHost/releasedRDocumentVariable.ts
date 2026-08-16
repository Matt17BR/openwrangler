import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { Uri } from "vscode";

interface ReleasedRDocumentVariableDependencies {
  readonly releasedJupyterQuickPickRow: (picker: Locator, variableName: string) => Promise<Locator | undefined>;
  readonly runReleasedRDocument: (source: Pick<Uri, "fsPath">) => PromiseLike<boolean>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedRDocumentVariableInvoker({
  releasedJupyterQuickPickRow,
  runReleasedRDocument,
  withBoundedAcceptancePromise
}: ReleasedRDocumentVariableDependencies) {
  return async function invokeReleasedRDocumentVariable(
    workbench: Page,
    source: Pick<Uri, "fsPath">,
    variableName: string,
    assertDiscovery: boolean
  ): Promise<void> {
    const outcome = runReleasedRDocument(source);
    const title = `Open Wrangler: Choose a dataframe from ${path.basename(source.fsPath)}`;
    const picker = workbench.locator(".quick-input-widget:visible").filter({ hasText: title }).last();
    const first = await Promise.race([
      picker.waitFor({ state: "visible", timeout: 30_000 }).then(() => ({ kind: "picker" as const })),
      Promise.resolve(outcome).then((value) => ({ kind: "outcome" as const, value }))
    ]);
    assert.equal(
      first.kind,
      "picker",
      `The public R-file command ended before showing its real picker: ${JSON.stringify(first)}.`
    );
    if (assertDiscovery) {
      for (const [name, flavor] of [
        ["orders_frame", "data.frame"],
        ["orders_tibble", "tibble"],
        ["orders_table", "data.table"]
      ] as const) {
        const row = await releasedJupyterQuickPickRow(picker, name);
        assert.ok(row, `The plain R picker must expose ${name}.`);
        assert.match((await row.innerText()).replace(/\s+/gu, " "), new RegExp(`R · ${flavor}`, "u"));
      }
    }
    const input = picker.locator(".quick-input-box input:visible").first();
    await input.fill(variableName);
    const row = await releasedJupyterQuickPickRow(picker, variableName);
    assert.ok(row, `The plain R picker did not expose ${JSON.stringify(variableName)}.`);
    await row.click();
    assert.equal(
      await withBoundedAcceptancePromise(outcome, 30_000, `the public R-file command for ${variableName}`),
      true
    );
  };
}
