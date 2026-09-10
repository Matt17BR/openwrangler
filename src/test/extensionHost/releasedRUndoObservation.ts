import type { Locator } from "playwright-core";
import { withAcceptanceOperationDeadline } from "./playwrightLifecycle";

// Structural browser types keep the editor harness independent of the DOM TypeScript library.
interface ObservedElement {
  readonly isConnected: boolean;
  readonly disabled?: boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ObservedElement | null;
  readonly ownerDocument: {
    hasFocus(): boolean;
    addEventListener(type: string, listener: (event: ObservedEvent) => void, capture: boolean): void;
    removeEventListener(type: string, listener: (event: ObservedEvent) => void, capture: boolean): void;
    readonly defaultView: {
      readonly location: { readonly origin: string };
      addEventListener(type: string, listener: (event: ObservedEvent) => void): void;
      removeEventListener(type: string, listener: (event: ObservedEvent) => void): void;
      readonly MutationObserver: new (callback: (records: readonly ObservedMutation[]) => void) => {
        observe(target: ObservedElement, options: Record<string, unknown>): void;
        disconnect(): void;
      };
    } | null;
  };
}
interface ObservedEvent {
  readonly type: string;
  readonly isTrusted: boolean;
  readonly origin: string;
  readonly data: unknown;
  composedPath(): readonly unknown[];
}
interface ObservedMutation {
  readonly type: string;
  readonly oldValue: string | null;
  readonly addedNodes: ArrayLike<Partial<ObservedElement>>;
  readonly removedNodes: ArrayLike<Partial<ObservedElement>>;
}

export async function observeReleasedRUndo(app: Locator, expected: { sessionId: string; syncId: string | null }) {
  const acquisition = app.evaluateHandle((element, owner) => {
    const root = element as unknown as ObservedElement;
    const button = root.querySelector("button[data-cleaning-plan-undo]");
    const shell = root.querySelector(".gridShell");
    const document = root.ownerDocument;
    const window = document.defaultView;
    if (!button || !shell || !window) throw new Error("The Undo observation target is unavailable.");
    const records: Record<string, string | number | boolean | null>[] = [];
    let dropped = 0;
    const counts = {
      capture: { pointerdown: 0, pointerup: 0, click: 0 },
      bubble: { pointerdown: 0, pointerup: 0, click: 0 }
    };
    const state = () => ({
      connected:
        root.isConnected && button.isConnected && root.querySelector("button[data-cleaning-plan-undo]") === button,
      documentFocused: document.hasFocus(),
      sessionMatches: root.getAttribute("data-session-id") === owner.sessionId,
      syncMatches: owner.syncId !== null && root.getAttribute("data-renderer-sync-id") === owner.syncId,
      disabled: button.disabled ?? null
    });
    const record = (value: (typeof records)[number]) => {
      if (records.length < 16) records.push({ ...value, ...state() });
      else dropped = Math.min(dropped + 1, 1_000_000);
    };
    record({ kind: "start" });
    const input = (event: ObservedEvent, phase: keyof typeof counts) => {
      if (!event.isTrusted || !event.composedPath().includes(button)) return;
      const type = event.type as keyof typeof counts.capture;
      counts[phase][type] = Math.min(counts[phase][type] + 1, 1_000_000);
      record({ kind: type, phase });
    };
    const capture = (event: ObservedEvent) => input(event, "capture");
    const bubble = (event: ObservedEvent) => input(event, "bubble");
    const kinds = new Set(["page", "planUpdated", "sessionOpened", "rendererSynchronization", "error", "cancelled"]);
    const codes = new Set([
      "runtime_error",
      "bridge_error",
      "invalid_runtime_response",
      "session_reconfiguring",
      "session_not_open",
      "workspace_untrusted",
      "stale_revision",
      "stale_request",
      "stale_response",
      "invalid_request",
      "r_kernel_changed"
    ]);
    const object = (value: unknown): Record<string, unknown> | undefined =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const message = (event: ObservedEvent) => {
      if (event.origin !== window.location.origin) return;
      const envelope = object(event.data);
      if (!envelope) return;
      const recovery = envelope.kind === "sessionRecovered";
      const response = recovery ? (object(envelope.result) ?? object(envelope.snapshot)) : envelope;
      if (!response || typeof response.kind !== "string" || !kinds.has(response.kind)) return;
      const metadata = object(response.metadata);
      const revision = metadata?.revision ?? response.revision;
      record({
        kind: response.kind,
        recovery,
        responseSessionMatches: (response.sessionId ?? metadata?.sessionId) === owner.sessionId,
        revision: typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
        code:
          response.kind === "error"
            ? typeof response.code === "string" && codes.has(response.code)
              ? response.code
              : "other"
            : null
      });
    };
    const observer = new window.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes")
          record({ kind: "disabled", previouslyDisabled: mutation.oldValue !== null });
        else {
          for (const [kind, nodes] of [
            ["alert-added", mutation.addedNodes],
            ["alert-removed", mutation.removedNodes]
          ] as const) {
            if (Array.from(nodes).some((node) => node.getAttribute?.("role") === "alert")) record({ kind });
          }
        }
      }
    });
    observer.observe(button, { attributes: true, attributeFilter: ["disabled"], attributeOldValue: true });
    observer.observe(shell, { childList: true });
    for (const type of ["pointerdown", "pointerup", "click"]) {
      document.addEventListener(type, capture, true);
      document.addEventListener(type, bubble, false);
    }
    window.addEventListener("message", message);
    return {
      read: () => ({
        records: records.slice(),
        counts: { capture: { ...counts.capture }, bubble: { ...counts.bubble } },
        dropped,
        current: state()
      }),
      dispose: () => {
        observer.disconnect();
        for (const type of ["pointerdown", "pointerup", "click"]) {
          document.removeEventListener(type, capture, true);
          document.removeEventListener(type, bubble, false);
        }
        window.removeEventListener("message", message);
      }
    };
  }, expected);
  const release = async (handle: Awaited<typeof acquisition>) => {
    await withAcceptanceOperationDeadline(
      handle.evaluate((observation) => observation.dispose()),
      2_000,
      "Undo observer cleanup"
    ).catch(() => undefined);
    await withAcceptanceOperationDeadline(handle.dispose(), 2_000, "Undo observer handle cleanup").catch(
      () => undefined
    );
  };
  const handle = await withAcceptanceOperationDeadline(acquisition, 2_000, "Undo observer setup").catch(() => {
    void acquisition.then(release).catch(() => undefined);
    return undefined;
  });
  return {
    read: async () =>
      handle
        ? withAcceptanceOperationDeadline(
            handle.evaluate((observation) => observation.read()),
            2_000,
            "Undo observer read"
          ).catch(() => ({ unavailable: true as const }))
        : { unavailable: true as const },
    dispose: async () => {
      if (handle) await release(handle);
    }
  };
}
