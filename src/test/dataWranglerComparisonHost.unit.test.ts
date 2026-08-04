import { describe, expect, it } from "vitest";
import { comparisonTabsOpenedAfter } from "./extensionHost/dataWranglerComparison";

describe("comparison workbench helpers", () => {
  it("returns only tabs opened after the launch baseline", () => {
    const source = { id: "source" };
    const target = { id: "target" };
    const opened = comparisonTabsOpenedAfter([source], [source, target]);

    expect(opened).toEqual([target]);
    expect(Object.isFrozen(opened)).toBe(true);
  });

  it("fails if a baseline tab disappears during launch", () => {
    const source = { id: "source" };
    const target = { id: "target" };

    expect(() => comparisonTabsOpenedAfter([source], [target])).toThrow(/pre-existing comparison tab disappeared/u);
  });

  it("rejects ambiguous or unbounded snapshots", () => {
    const source = { id: "source" };
    expect(() => comparisonTabsOpenedAfter([source, source], [source])).toThrow(/identity-unique/u);
    expect(() =>
      comparisonTabsOpenedAfter(
        [],
        Array.from({ length: 65 }, (_, index) => ({ index }))
      )
    ).toThrow(/bounded identity-unique/u);
  });
});
