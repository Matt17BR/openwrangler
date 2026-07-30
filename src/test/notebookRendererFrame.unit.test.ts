import { beforeEach, describe, expect, it, vi } from "vitest";
import { findExactActiveNotebookRendererButton } from "./extensionHost/notebookRendererFrame";

describe("authoritative notebook renderer frame selection", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("rejects a visible pending guest and activates only the settled active guest", () => {
    const pending = notebookGuest("pending-frame", "orders", "Open in Open Wrangler");
    const active = notebookGuest("active-frame", "orders", "Open in Open Wrangler");
    const pendingActivation = vi.fn();
    const activeActivation = vi.fn();
    pending.button.addEventListener("click", pendingActivation);
    active.button.addEventListener("click", activeActivation);

    expect(
      findExactActiveNotebookRendererButton({
        expectedLabel: "orders",
        expectedButtonName: "Open in Open Wrangler"
      })
    ).toBeNull();

    pending.frame.remove();
    const selected = findExactActiveNotebookRendererButton({
      expectedLabel: "orders",
      expectedButtonName: "Open in Open Wrangler"
    });
    expect(selected).toBe(active.button);
    (selected as HTMLButtonElement).click();
    expect(activeActivation).toHaveBeenCalledOnce();
    expect(pendingActivation).not.toHaveBeenCalled();
  });

  it("rejects ambiguous retained active guests instead of choosing one by discovery order", () => {
    notebookGuest("active-frame", "orders", "Open in Open Wrangler");
    notebookGuest("active-frame", "orders", "Open in Open Wrangler");

    expect(
      findExactActiveNotebookRendererButton({
        expectedLabel: "orders",
        expectedButtonName: "Open in Open Wrangler"
      })
    ).toBeNull();
  });
});

function notebookGuest(id: "active-frame" | "pending-frame", label: string, action: string) {
  const frame = document.createElement("iframe");
  frame.id = id;
  document.body.append(frame);
  const guest = frame.contentDocument;
  if (!guest) throw new Error("The DOM test environment did not create an iframe document.");

  const section = guest.createElement("section");
  section.className = "openwrangler-notebook";
  const header = guest.createElement("header");
  const title = guest.createElement("span");
  title.textContent = `Open Wrangler preview: ${label} (duckdb) - 10 x 2`;
  const button = guest.createElement("button");
  button.textContent = action;
  header.append(title, button);
  section.append(header);
  guest.body.append(section);
  return { frame, button };
}
