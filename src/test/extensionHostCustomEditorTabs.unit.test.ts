import { describe, expect, it } from "vitest";
import { customEditorTabDiagnostic, findExactCustomEditorTab } from "./extensionHost/customEditorTabs";

const uri = (value: string): { toString(): string } => ({ toString: () => value });

describe("extension-host custom-editor tab matching", () => {
  it("finds the exact structural custom editor in any tab group", () => {
    const expected = { input: { viewType: "openWrangler.viewer", uri: uri("file:///workspace/sample.csv") } };
    const groups = [
      { tabs: [{ input: { viewType: "openWrangler.viewer", uri: uri("file:///workspace/other.csv") } }] },
      { tabs: [{ input: { viewType: "text", uri: uri("file:///workspace/sample.csv") } }, expected] }
    ];

    expect(findExactCustomEditorTab(groups, "openWrangler.viewer", "file:///workspace/sample.csv")).toBe(expected);
  });

  it("requires both the requested view type and source URI", () => {
    const groups = [
      {
        tabs: [
          { input: { viewType: "openWrangler.viewer", uri: uri("file:///workspace/other.csv") } },
          { input: { viewType: "other.viewer", uri: uri("file:///workspace/sample.csv") } },
          {
            input: {
              viewType: "openWrangler.viewer",
              uri: {
                toString: () => {
                  throw new Error("unreadable");
                }
              }
            }
          }
        ]
      }
    ];

    expect(findExactCustomEditorTab(groups, "openWrangler.viewer", "file:///workspace/sample.csv")).toBeUndefined();
  });

  it("keeps timeout diagnostics bounded and omits URI and view-type values", () => {
    const secretUri = "file:///private/workspace/customer-data.csv";
    const groups = [
      {
        tabs: Array.from({ length: 20 }, (_, index) => ({
          input: { viewType: `private.viewer.${index}`, uri: uri(`${secretUri}?tab=${index}`) },
          isActive: index === 19
        }))
      }
    ];

    const diagnostic = customEditorTabDiagnostic(groups, "openWrangler.viewer", "file:///workspace/sample.csv");
    expect(diagnostic).toMatchObject({
      totalGroups: 1,
      totalTabs: 20,
      examinedTabs: 16,
      exactMatches: 0,
      truncated: true
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secretUri);
    expect(JSON.stringify(diagnostic)).not.toContain("private.viewer");
  });
});
