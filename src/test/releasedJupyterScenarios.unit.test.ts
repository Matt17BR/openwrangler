import { describe, expect, it } from "vitest";
import { PACKAGED_EVIDENCE_SCENES } from "./extensionHost/evidenceScenes";
import {
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  PYSPARK_PRERELEASE_DENIAL_SELECTOR,
  RELEASED_JUPYTER_SCENARIOS,
  releasedJupyterScenario,
  type ExtensionHostTestSelector
} from "./extensionHost/releasedJupyterScenarios";

function scenario(
  phaseId: string,
  selector?: ExtensionHostTestSelector,
  editor?: string,
  platform: NodeJS.Platform = "linux"
) {
  return releasedJupyterScenario({ editor, phaseId, platform, selector });
}

describe("released Jupyter scenarios", () => {
  it("declares one bounded owner for every executable phase and selector pair", () => {
    expect(RELEASED_JUPYTER_SCENARIOS.map(({ phaseId, selector }) => `${phaseId}:${selector ?? "default"}`)).toEqual([
      "jupyter-deny:default",
      "jupyter-allow:default",
      "jupyter-allow:candidate-compatibility-seam",
      "jupyter-pyspark:default",
      "jupyter-pyspark:pyspark-prerelease-denial",
      "jupyter-remote:default",
      "jupyter-r:default",
      "jupyter-r:core-operations",
      "jupyter-r:categorical-operations",
      "jupyter-r:value-operations",
      "jupyter-r:pivot-wider",
      "jupyter-r:kernel-restart",
      "jupyter-r:native-frames",
      "jupyter-r:interactive-terminal",
      "jupyter-r:literate-documents",
      "jupyter-r-remote:default"
    ]);
    expect(
      new Set(RELEASED_JUPYTER_SCENARIOS.map(({ phaseId, selector }) => `${phaseId}:${selector ?? ""}`)).size
    ).toBe(RELEASED_JUPYTER_SCENARIOS.length);
    expect(
      RELEASED_JUPYTER_SCENARIOS.every(
        ({ editorEligibility, platformEligibility, prerequisites, runnerKey }) =>
          (editorEligibility === "all" || editorEligibility.length > 0) &&
          (platformEligibility === "all" || platformEligibility.length > 0) &&
          prerequisites.length > 0 &&
          runnerKey.length > 0
      )
    ).toBe(true);
  });

  it("makes candidate and focused-selector eligibility executable", () => {
    expect(scenario("jupyter-allow", CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, "cursor")?.runnerKey).toBe(
      "released-jupyter"
    );
    expect(scenario("jupyter-allow", CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, "vscode")).toBeUndefined();
    expect(scenario("jupyter-deny", CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, "cursor")).toBeUndefined();
    expect(scenario("jupyter-pyspark", PYSPARK_PRERELEASE_DENIAL_SELECTOR, "vscode")?.runnerKey).toBe(
      "released-jupyter"
    );
    expect(scenario("jupyter-pyspark", PYSPARK_PRERELEASE_DENIAL_SELECTOR, "cursor")).toBeUndefined();
    expect(scenario("jupyter-allow", PYSPARK_PRERELEASE_DENIAL_SELECTOR, "vscode")).toBeUndefined();
    expect(scenario("jupyter-r", "interactive-terminal")?.runnerKey).toBe("focused-r-interactive");
    expect(scenario("jupyter-r", "literate-documents")?.runnerKey).toBe("focused-r-literate");
    expect(scenario("jupyter-r-remote", "native-frames")).toBeUndefined();
  });

  it("owns released-R coverage selection and declared progress sections", () => {
    expect(scenario("jupyter-r")?.rCoverageProfileKey).toBe("local-default");
    expect(scenario("jupyter-r-remote")?.rCoverageProfileKey).toBe("remote-representative");
    expect(scenario("jupyter-r", "core-operations")?.rCoverageProfileKey).toBe("candidate-core");
    expect(scenario("jupyter-r", "categorical-operations")?.rCoverageProfileKey).toBe("categorical-operations");
    expect(scenario("jupyter-r", "value-operations")?.rCoverageProfileKey).toBe("value-operations");
    expect(scenario("jupyter-r", "pivot-wider")?.rCoverageProfileKey).toBe("pivot-wider");
    expect(scenario("jupyter-r", "kernel-restart")).toMatchObject({
      rCoverageProfileKey: "kernel-restart",
      declaredProgressSections: ["notebook", "restart"]
    });
    expect(scenario("jupyter-r", "native-frames")).toMatchObject({
      rCoverageProfileKey: "native-frames",
      declaredProgressSections: ["notebook", "collapse-open", "native-viewing", "native-editing"]
    });
  });

  it("assigns every notebook evidence scene to its actual released runner", () => {
    const declaredEvidence = RELEASED_JUPYTER_SCENARIOS.flatMap(({ evidenceSceneIds }) => evidenceSceneIds).sort();
    const notebookEvidence = PACKAGED_EVIDENCE_SCENES.filter(({ runnerKey }) => runnerKey !== "workbench")
      .map(({ id }) => id)
      .sort();
    expect(declaredEvidence).toEqual(notebookEvidence);
    expect(new Set(declaredEvidence).size).toBe(declaredEvidence.length);
  });
});
