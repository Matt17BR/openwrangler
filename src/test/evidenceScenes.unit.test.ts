import { describe, expect, it } from "vitest";
import {
  PACKAGED_EVIDENCE_SCENES,
  PACKAGED_SCREENSHOT_SCENES,
  packagedEvidenceScene,
  packagedScreenshotFileName,
  type PackagedEvidenceSceneId,
  type PackagedEvidenceTheme
} from "./extensionHost/evidenceScenes";

describe("packaged evidence scenes", () => {
  it("owns the bounded public artifact inventory without journey implementation details", () => {
    expect(PACKAGED_SCREENSHOT_SCENES).toEqual([
      "hero",
      "file-explorer-action",
      "explore",
      "high-contrast-explore",
      "filter-result",
      "workflow",
      "sidebar-overview",
      "operation-catalog",
      "operation-configuration",
      "applied-step-inspection",
      "latest-step-edited",
      "latest-step-undone",
      "notebook-pandas",
      "notebook-code-insertion",
      "notebook-variable-picker",
      "notebook-r-operations",
      "notebook-pyspark-picker",
      "notebook-polars",
      "notebook-duckdb",
      "notebook-pyspark",
      "notebook-r",
      "notebook-r-editing",
      "notebook-r-code-insertion",
      "r-quarto-variable-picker"
    ]);
    expect(new Set(PACKAGED_SCREENSHOT_SCENES).size).toBe(PACKAGED_SCREENSHOT_SCENES.length);
    expect(PACKAGED_EVIDENCE_SCENES.every((scene) => scene.themes.length > 0)).toBe(true);
    expect(PACKAGED_EVIDENCE_SCENES.filter((scene) => scene.runnerKey === "workbench")).toHaveLength(12);
    expect(
      PACKAGED_EVIDENCE_SCENES.filter((scene) => scene.runnerKey === "notebook-output").map(({ id }) => id)
    ).toEqual(["notebook-pandas"]);
    expect(PACKAGED_EVIDENCE_SCENES.filter((scene) => scene.runnerKey === "notebook-workbench")).toHaveLength(11);
  });

  it("resolves runner and viewport ownership for representative executable scenes", () => {
    expect(packagedEvidenceScene("hero")).toMatchObject({
      runnerKey: "workbench",
      viewportKey: "showcase",
      themes: ["dark", "light"]
    });
    expect(packagedEvidenceScene("file-explorer-action")).toMatchObject({
      runnerKey: "workbench",
      viewportKey: "product",
      themes: ["dark"]
    });
    expect(packagedEvidenceScene("notebook-pandas")).toMatchObject({
      runnerKey: "notebook-output",
      viewportKey: "pandas-output",
      themes: ["dark"]
    });
    expect(packagedEvidenceScene("notebook-duckdb")).toMatchObject({
      runnerKey: "notebook-workbench",
      viewportKey: "notebook",
      themes: ["dark"]
    });
  });

  it("derives safe artifact names only for each scene's declared themes", () => {
    for (const scene of PACKAGED_EVIDENCE_SCENES) {
      for (const theme of scene.themes) {
        expect(packagedScreenshotFileName("vscode", scene.id, theme)).toBe(`vscode-${scene.id}-${theme}.png`);
      }
    }
    expect(() => packagedScreenshotFileName("../outside", "hero", "dark")).toThrow(TypeError);
    expect(() => packagedScreenshotFileName("vscode", "hero", "high-contrast" as PackagedEvidenceTheme)).toThrow(
      /does not support/u
    );
    expect(() => packagedEvidenceScene("missing" as PackagedEvidenceSceneId)).toThrow(
      /Unknown packaged evidence scene/u
    );
  });
});
