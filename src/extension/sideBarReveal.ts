import * as vscode from "vscode";
import { getSetting } from "./configuration";

type SideBarView = Pick<vscode.TreeView<unknown>, "visible" | "onDidChangeVisibility">;

let trackedViews: ReadonlyArray<readonly [string, SideBarView]> = [];
let preferredViewId: string | undefined;

// VS Code reports a view as visible only while its container is shown and the view is expanded, so the last
// visible view is one the user left expanded and opening it does not change their layout.
export function trackSideBarViews(views: ReadonlyArray<readonly [string, SideBarView]>): vscode.Disposable {
  trackedViews = views;
  preferredViewId = views.find(([, view]) => view.visible)?.[0] ?? views[0]?.[0];
  const subscriptions = views.map(([, view]) =>
    view.onDidChangeVisibility(() => {
      if (trackedViews !== views) return;
      preferredViewId = views.find(([, candidate]) => candidate.visible)?.[0] ?? preferredViewId;
    })
  );
  return {
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      if (trackedViews !== views) return;
      trackedViews = [];
      preferredViewId = undefined;
    }
  };
}

export function revealSideBar(reportDiagnostic?: (message: string) => void): void {
  if (!preferredViewId || trackedViews.some(([, view]) => view.visible)) return;
  if (!getSetting("revealSideBar", true)) return;
  Promise.resolve(vscode.commands.executeCommand(`${preferredViewId}.open`, { preserveFocus: true })).catch(
    (error: unknown) =>
      reportDiagnostic?.(
        `Open Wrangler could not show its side bar: ${error instanceof Error ? error.message : String(error)}`
      )
  );
}
