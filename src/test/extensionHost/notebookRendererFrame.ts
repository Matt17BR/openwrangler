interface NotebookRendererDocument extends NotebookRendererElement {
  readonly readyState: string;
}

interface NotebookRendererElement {
  readonly contentDocument?: NotebookRendererDocument | null;
  readonly isConnected: boolean;
  readonly textContent: string | null;
  querySelector(selector: string): NotebookRendererElement | null;
  querySelectorAll(selector: string): ArrayLike<NotebookRendererElement>;
}

/**
 * Resolve an action only through VS Code's authoritative notebook renderer
 * guest. During output replacement VS Code can retain a visible old guest
 * while a pending guest is being promoted; either representation may contain
 * working DOM, but only the single settled active frame owns authoritative
 * renderer messaging.
 *
 * This function is closure-free because Playwright serializes it into the
 * candidate notebook wrapper frame.
 */
export function findExactActiveNotebookRendererButton({
  expectedLabel,
  expectedButtonName
}: {
  readonly expectedLabel: string;
  readonly expectedButtonName: string;
}): unknown | null {
  const outerDocument = (globalThis as unknown as { readonly document: NotebookRendererDocument }).document;
  const activeFrames = Array.from(outerDocument.querySelectorAll("iframe#active-frame"));
  const pendingFrames = Array.from(outerDocument.querySelectorAll("iframe#pending-frame"));
  if (activeFrames.length !== 1 || pendingFrames.length !== 0) return null;

  const activeFrame = activeFrames[0];
  if (!activeFrame?.isConnected) return null;
  const innerDocument = activeFrame.contentDocument;
  if (!innerDocument || innerDocument.readyState === "loading") return null;

  const titlePrefix = `Open Wrangler preview: ${expectedLabel} (`;
  const matches = Array.from(innerDocument.querySelectorAll("section.openwrangler-notebook")).flatMap((section) => {
    const title = section.querySelector("header > span")?.textContent ?? "";
    if (!title.startsWith(titlePrefix)) return [];
    return Array.from(section.querySelectorAll("button")).filter(
      (button) => button.isConnected && (button.textContent ?? "").trim() === expectedButtonName
    );
  });
  return matches.length === 1 ? matches[0] : null;
}
