import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnSchema, TransformStep } from "../shared/protocol";
import { useOperationDialogLifecycle } from "../webviews/operationDialogLifecycle";

const editingStep: TransformStep = {
  id: "select-a",
  kind: "selectColumns",
  params: { columns: [{ id: "c:a", name: "a" }] }
};
const editingStepInputSchema: ColumnSchema[] = [
  { id: "c:a", name: "a", position: 0, rawType: "String", type: "string", nullable: false }
];

describe("operation dialog lifecycle", () => {
  beforeEach(() => document.body.replaceChildren());

  afterEach(() => vi.restoreAllMocks());

  it("publishes generic and editing dialog payloads as one owned state", () => {
    const { result } = renderHook(() =>
      useOperationDialogLifecycle({
        scheduleFocusRestoration: () => 1,
        canRestoreFocus
      })
    );

    expect(result.current.dialog).toBeUndefined();
    act(() => result.current.openDialog({}));
    expect(result.current.dialog).toEqual({});

    act(() =>
      result.current.openDialog({
        kind: editingStep.kind,
        editingStep,
        editingStepInputSchema
      })
    );
    expect(result.current.dialog).toEqual({ kind: "selectColumns", editingStep, editingStepInputSchema });

    act(() => result.current.closeDialog());
    expect(result.current.dialog).toBeUndefined();
  });

  it("restores the exact captured trigger after the dialog closes", () => {
    const trigger = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(trigger, other);
    trigger.focus();
    let scheduledFocus: (() => void) | undefined;
    const scheduleFocusRestoration = vi.fn((restore: () => void) => {
      scheduledFocus = restore;
      return 17;
    });
    const { result } = renderHook(() => useOperationDialogLifecycle({ scheduleFocusRestoration, canRestoreFocus }));

    act(() => result.current.openDialog({}));
    act(() => result.current.closeDialog());
    expect(scheduleFocusRestoration).toHaveBeenCalledOnce();

    other.focus();
    act(() => scheduledFocus!());
    expect(document.activeElement).toBe(trigger);
  });

  it("uses the existing operation fallback when the captured trigger is unavailable", () => {
    const trigger = document.createElement("button");
    const fallback = document.createElement("button");
    fallback.setAttribute("data-operation-focus-fallback", "");
    document.body.append(trigger, fallback);
    trigger.focus();
    let scheduledFocus: (() => void) | undefined;
    const { result } = renderHook(() =>
      useOperationDialogLifecycle({
        scheduleFocusRestoration: (restore) => {
          scheduledFocus = restore;
          return 23;
        },
        canRestoreFocus
      })
    );

    act(() => result.current.openDialog({}));
    trigger.remove();
    act(() => result.current.closeDialog());
    act(() => scheduledFocus!());

    expect(document.activeElement).toBe(fallback);
  });

  it("honors focus ownership and cancels replaced or unmounted frames", () => {
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const trigger = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(trigger, other);
    trigger.focus();
    let webviewOwnsFocus = true;
    let scheduledFocus: (() => void) | undefined;
    let frame = 30;
    const { result, unmount } = renderHook(() =>
      useOperationDialogLifecycle({
        scheduleFocusRestoration: (restore) => {
          scheduledFocus = () => {
            if (webviewOwnsFocus) restore();
          };
          frame += 1;
          return frame;
        },
        canRestoreFocus
      })
    );

    act(() => result.current.openDialog({}));
    act(() => result.current.closeDialog());
    act(() => result.current.openDialog({ kind: "selectColumns" }));
    expect(cancelFrame).toHaveBeenCalledWith(31);

    act(() => result.current.closeDialog());
    other.focus();
    webviewOwnsFocus = false;
    act(() => scheduledFocus!());
    expect(document.activeElement).toBe(other);

    unmount();
    expect(cancelFrame).toHaveBeenLastCalledWith(32);
  });
});

function canRestoreFocus(target: HTMLElement | null | undefined): target is HTMLElement {
  return Boolean(target?.isConnected && !target.matches(":disabled"));
}
