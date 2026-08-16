import * as assert from "node:assert/strict";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import * as vscode from "vscode";
import type { Frame, Locator, Page } from "playwright-core";
import { probeAcceptanceBeforeDeadline } from "./playwrightLifecycle";

export interface ReleasedNativeQuartoPreviewDependencies {
  readonly operationTimeoutMs: number;
  readonly diagnosticTimeoutMs: number;
  readonly frames: (workbench: Page) => readonly Frame[];
  readonly recordProgress: (checkpoint: string) => void;
  readonly waitFor: (condition: () => boolean, timeoutMs: number, description: string) => Promise<void>;
  readonly withBoundedPromise: <T>(promise: PromiseLike<T>, timeoutMs: number, description: string) => Promise<T>;
}

export function isReleasedQuartoPreviewInput(
  input: unknown,
  isWebviewInput: (candidate: unknown) => boolean = (candidate) => candidate instanceof vscode.TabInputWebview
): boolean {
  return (
    isWebviewInput(input) &&
    (input as { readonly viewType?: unknown }).viewType === "mainThreadWebview-quarto.previewView"
  );
}

export async function openReleasedNativeQuartoPreview(
  workbench: Page,
  source: vscode.Uri,
  dependencies: ReleasedNativeQuartoPreviewDependencies
): Promise<() => Promise<void>> {
  const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === source.toString());
  assert.ok(document, "The Quarto preview requires its exact open source document.");
  assert.equal(document.languageId, "quarto");
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  const outputPath = source.fsPath.replace(/\.qmd$/u, ".html");
  rmSync(outputPath, { force: true });
  assert.deepEqual(releasedQuartoPreviewTabs(), [], "The Quarto journey must start without an existing preview tab.");
  const priorTerminals = new Set(vscode.window.terminals);
  let cleaned = false;
  let previewTab: vscode.Tab | undefined;
  let previewTabGroup: vscode.TabGroup | undefined;
  let previewTerminal: vscode.Terminal | undefined;
  let previewOwnershipReady = false;
  const ownedPreviewTerminals = () =>
    vscode.window.terminals.filter((terminal) => !priorTerminals.has(terminal) && terminal.name === "Quarto Preview");
  const captureOwnedUi = () => {
    const tabs = releasedQuartoPreviewTabs();
    const terminals = ownedPreviewTerminals();
    assert.ok(tabs.length <= 1, "Quarto Preview must not create an additional internal preview tab.");
    assert.ok(terminals.length <= 1, "Quarto Preview must not create an additional owned terminal.");
    if (previewTab) {
      assert.equal(tabs.length, 1, "Quarto Preview must retain its first exact internal preview tab.");
      assert.equal(tabs[0], previewTab, "Quarto Preview must not replace its first exact internal preview tab.");
    } else if (tabs[0]) {
      previewTab = tabs[0];
    }
    if (previewTerminal) {
      assert.equal(terminals.length, 1, "Quarto Preview must retain its first exact owned terminal.");
      assert.equal(terminals[0], previewTerminal, "Quarto Preview must not replace its first exact owned terminal.");
    } else if (terminals[0]) {
      previewTerminal = terminals[0];
    }
    if (previewTab) {
      const containingGroups = vscode.window.tabGroups.all.filter((group) => group.tabs.includes(previewTab!));
      assert.equal(containingGroups.length, 1, "The exact Quarto preview tab must belong to one tab group.");
      if (previewTabGroup) {
        assert.equal(
          containingGroups[0],
          previewTabGroup,
          "Quarto Preview must retain the first exact tab-group identity."
        );
      } else {
        previewTabGroup = containingGroups[0];
      }
    }
    return {
      tabOwned: previewTab !== undefined && previewTabGroup !== undefined,
      terminalReady: previewTerminal !== undefined
    };
  };
  const assertFrozenOwnership = () => {
    assert.ok(previewTab, "Quarto Preview must retain its frozen internal preview tab.");
    assert.ok(previewTabGroup, "Quarto Preview must retain its frozen tab group.");
    assert.ok(previewTerminal, "Quarto Preview must retain its frozen owned terminal.");
    const frozenTabs = releasedQuartoPreviewTabs();
    const frozenTerminals = ownedPreviewTerminals();
    assert.equal(frozenTabs.length, 1, "Quarto Preview must retain one frozen internal preview tab.");
    assert.equal(
      frozenTabs[0],
      previewTab,
      "Quarto Preview must not replace or add to its frozen internal preview tab."
    );
    assert.equal(
      vscode.window.tabGroups.all.filter((group) => group.tabs.includes(previewTab!)).length,
      1,
      "The frozen Quarto preview tab must remain in one exact group."
    );
    assert.equal(
      vscode.window.tabGroups.all.find((group) => group.tabs.includes(previewTab!)),
      previewTabGroup,
      "The frozen Quarto preview tab must retain its exact group."
    );
    assert.equal(frozenTerminals.length, 1, "Quarto Preview must retain one frozen owned terminal.");
    assert.equal(
      frozenTerminals[0],
      previewTerminal,
      "Quarto Preview must not replace or add to its frozen owned terminal."
    );
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let ownershipFailure: unknown;
    if (previewOwnershipReady) {
      try {
        assertFrozenOwnership();
      } catch (error) {
        ownershipFailure = error;
      }
    }
    const openTabs = releasedQuartoPreviewTabs();
    if (openTabs.length > 0) {
      assert.equal(
        await dependencies.withBoundedPromise(
          vscode.window.tabGroups.close(openTabs, true),
          dependencies.operationTimeoutMs,
          "the owned Quarto preview tabs to close"
        ),
        true
      );
    }
    for (const terminal of ownedPreviewTerminals()) terminal.dispose();
    await dependencies.waitFor(
      () => ownedPreviewTerminals().length === 0,
      10_000,
      "the official Quarto preview terminal to close"
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(releasedQuartoPreviewTabs(), [], "Quarto preview cleanup must leave zero preview tabs.");
    assert.deepEqual(ownedPreviewTerminals(), [], "Quarto preview cleanup must leave zero owned terminals.");
    rmSync(outputPath, { force: true });
    if (ownershipFailure) throw ownershipFailure;
  };

  try {
    const deadline = Date.now() + 120_000;
    dependencies.recordProgress("jupyter-r:quarto:preview");
    const previewCommand = vscode.commands.executeCommand("quarto.preview");
    dependencies.recordProgress("jupyter-r:quarto:preview-command-returned");
    const commandRemainingMs = deadline - Date.now();
    assert.ok(commandRemainingMs > 0, "The Quarto preview command exhausted its render deadline before settling.");
    await dependencies.withBoundedPromise(
      previewCommand,
      commandRemainingMs,
      "the exact Quarto preview command to settle"
    );
    dependencies.recordProgress("jupyter-r:quarto:preview-command-settled");
    let previewLocator: Locator | undefined;
    let renderedHtmlReady = false;
    let previousHtmlSignature: string | undefined;
    let stableHtmlObservations = 0;
    let previewProbeReturned = false;
    while (Date.now() < deadline) {
      const ownership = captureOwnedUi();
      previewLocator = await probeAcceptanceBeforeDeadline(
        () => findReleasedQuartoPreviewLocator(dependencies.frames(workbench)),
        Math.min(deadline, Date.now() + dependencies.diagnosticTimeoutMs)
      );
      if (!previewProbeReturned) {
        previewProbeReturned = true;
        dependencies.recordProgress("jupyter-r:quarto:preview-probe-returned");
      }
      const html = releasedRenderedHtmlSnapshot(outputPath, ["Regional orders", "Regional orders preview", "2400001"]);
      if (html) {
        if (html.signature === previousHtmlSignature) stableHtmlObservations += 1;
        else {
          previousHtmlSignature = html.signature;
          stableHtmlObservations = 1;
        }
        renderedHtmlReady = stableHtmlObservations >= 2;
      }
      const visiblePreviewReady = previewLocator !== undefined;
      if (ownership.tabOwned && ownership.terminalReady && renderedHtmlReady && visiblePreviewReady) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const ownership = captureOwnedUi();
    assert.equal(ownership.tabOwned, true, "The exact Quarto preview tab must belong to its exact tab group.");
    assert.equal(ownership.terminalReady, true, "Quarto Preview must own one exact disposable terminal.");
    assert.equal(renderedHtmlReady, true, "Quarto Preview must finish the expected HTML render.");
    assert.ok(previewLocator, "The internal Quarto media preview must show the rendered R table.");
    previewOwnershipReady = true;
    assertFrozenOwnership();
    dependencies.recordProgress("jupyter-r:quarto:preview-ready");
    return cleanup;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "The Quarto preview and its cleanup both failed.");
    }
    throw error;
  }
}

function releasedQuartoPreviewTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => {
      // VS Code exposes WebviewPanel tab types with its main-thread prefix through TabInputWebview.
      return isReleasedQuartoPreviewInput(tab.input);
    });
}

export function releasedRenderedHtmlSnapshot(
  outputPath: string,
  requiredText: readonly string[]
): { readonly signature: string } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 5n * 1024n * 1024n) {
      throw new Error("The native R document render did not produce one bounded regular HTML file.");
    }
    if (opened.size === 0n) return undefined;

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    if (
      !completed.isFile() ||
      completed.nlink !== 1n ||
      completed.dev !== opened.dev ||
      completed.ino !== opened.ino ||
      completed.size !== opened.size ||
      completed.size !== BigInt(offset) ||
      completed.mtimeNs !== opened.mtimeNs ||
      completed.ctimeNs !== opened.ctimeNs
    ) {
      return undefined;
    }

    let pathIdentity;
    try {
      pathIdentity = lstatSync(outputPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      pathIdentity.isSymbolicLink() ||
      !pathIdentity.isFile() ||
      pathIdentity.nlink !== 1n ||
      pathIdentity.dev !== completed.dev ||
      pathIdentity.ino !== completed.ino
    ) {
      return undefined;
    }

    const output = bytes.toString("utf8");
    if (!/<\/html>\s*$/iu.test(output) || requiredText.some((text) => !output.includes(text))) return undefined;
    return { signature: `${completed.dev}:${completed.ino}:${completed.size}:${completed.mtimeNs}` };
  } finally {
    closeSync(descriptor);
  }
}

export async function findReleasedQuartoPreviewLocator(frames: readonly Frame[]): Promise<Locator | undefined> {
  for (const frame of frames) {
    const caption = frame.getByText("Regional orders preview", { exact: true }).first();
    if ((await caption.count().catch(() => 0)) > 0 && (await caption.isVisible().catch(() => false))) {
      const knownOrder = frame.getByText(/^(?:2400001|2,400,001)$/u).first();
      if ((await knownOrder.count().catch(() => 0)) > 0 && (await knownOrder.isVisible().catch(() => false))) {
        // A table caption spans the table's scroll width. Use the visible first
        // cell as the compact geometry anchor for the captured preview instead.
        return knownOrder;
      }
    }
  }
  return undefined;
}
