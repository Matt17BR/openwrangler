import { describe, expect, it } from "vitest";
import {
  idleRLiveVariableSnapshot,
  rInteractiveQuickPickItem,
  rLiveVariableItem,
  watcherFallbackRLiveVariableSnapshot
} from "../extension/r/rInteractiveVariableModel";

describe("R interactive variable model", () => {
  it.each([
    ["r.data.frame", "data.frame"],
    ["r.tibble", "tibble"],
    ["r.data.table", "data.table"]
  ] as const)("labels %s variables consistently", (dataframeFlavor, label) => {
    const variable = { name: "orders", backend: "r" as const, dataframeFlavor };

    expect(rInteractiveQuickPickItem(variable)).toEqual({
      label: "orders",
      description: `R · ${label}`,
      detail: "Active R session",
      variable
    });
    expect(rLiveVariableItem(variable, "handle-1", "R Interactive")).toEqual({
      handle: "handle-1",
      label: "orders",
      description: `R · ${label}`,
      detail: "R Interactive"
    });
  });

  it("describes idle official and non-R terminals without retaining variables", () => {
    expect(idleRLiveVariableSnapshot({ name: "R" }, true)).toEqual({
      state: "idle",
      terminalLabel: "R",
      message: "Dataframes appear here after the R prompt returns.",
      variables: []
    });
    expect(idleRLiveVariableSnapshot({ name: "shell" }, false)).toEqual({
      state: "idle",
      terminalLabel: "R session",
      message: "Select the R terminal that owns the dataframe first.",
      variables: []
    });
  });

  it("keeps watcher fallback guidance bound to the selected R terminal", () => {
    expect(watcherFallbackRLiveVariableSnapshot({ name: "R Interactive" })).toEqual({
      state: "idle",
      terminalLabel: "R Interactive",
      message: "Choose Refresh R dataframes.",
      variables: []
    });
  });
});
