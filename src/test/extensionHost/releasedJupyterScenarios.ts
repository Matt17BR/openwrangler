import type { PackagedEvidenceSceneId } from "./evidenceScenes";

export const CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR = "candidate-compatibility-seam";

export const EXTENSION_HOST_TEST_SELECTORS = Object.freeze([
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  "core-operations",
  "categorical-operations",
  "value-operations",
  "kernel-restart",
  "native-frames",
  "interactive-terminal",
  "literate-documents"
] as const);

export type ExtensionHostTestSelector = (typeof EXTENSION_HOST_TEST_SELECTORS)[number];

export type ReleasedJupyterDispatchPhase =
  "jupyter-deny" | "jupyter-allow" | "jupyter-pyspark" | "jupyter-remote" | "jupyter-r" | "jupyter-r-remote";

export type ReleasedJupyterRunnerKey = "released-jupyter" | "focused-r-interactive" | "focused-r-literate";

export type ReleasedRCoverageProfileKey =
  | "local-default"
  | "remote-representative"
  | "candidate-core"
  | "categorical-operations"
  | "value-operations"
  | "kernel-restart"
  | "native-frames";

type ReleasedJupyterPrerequisite =
  "host-python" | "released-jupyter" | "released-r" | "remote-jupyter-descriptor" | "native-r-tooling";

export interface ReleasedJupyterScenarioDefinition {
  readonly phaseId: ReleasedJupyterDispatchPhase;
  readonly selector?: ExtensionHostTestSelector;
  readonly tierRiskOwner: "released-jupyter" | "released-jupyter-remote" | "released-r" | "released-r-focused";
  readonly editorEligibility: "all" | readonly string[];
  readonly platformEligibility: "all" | readonly NodeJS.Platform[];
  readonly prerequisites: readonly ReleasedJupyterPrerequisite[];
  readonly runnerKey: ReleasedJupyterRunnerKey;
  readonly rCoverageProfileKey?: ReleasedRCoverageProfileKey;
  readonly declaredProgressSections: readonly string[];
  readonly evidenceSceneIds: readonly PackagedEvidenceSceneId[];
}

const ORDINARY_R_PROGRESS_SECTIONS = [
  "notebook",
  "variable-discovery",
  "grid",
  "editing",
  "document",
  "collapse-open",
  "native-viewing",
  "native-editing",
  "restart"
] as const;
const FOCUSED_R_EDITING_PROGRESS_SECTIONS = ["notebook", "variable-discovery", "grid", "editing"] as const;

export const RELEASED_JUPYTER_SCENARIOS: readonly ReleasedJupyterScenarioDefinition[] = [
  {
    phaseId: "jupyter-deny",
    tierRiskOwner: "released-jupyter",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter"],
    runnerKey: "released-jupyter",
    declaredProgressSections: [],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-allow",
    tierRiskOwner: "released-jupyter",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter"],
    runnerKey: "released-jupyter",
    declaredProgressSections: [],
    evidenceSceneIds: [
      "notebook-pandas",
      "notebook-code-insertion",
      "notebook-variable-picker",
      "notebook-polars",
      "notebook-duckdb"
    ]
  },
  {
    phaseId: "jupyter-allow",
    selector: CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
    tierRiskOwner: "released-jupyter",
    editorEligibility: ["cursor"],
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter"],
    runnerKey: "released-jupyter",
    declaredProgressSections: [],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-pyspark",
    tierRiskOwner: "released-jupyter",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter"],
    runnerKey: "released-jupyter",
    declaredProgressSections: [],
    evidenceSceneIds: ["notebook-pyspark-picker", "notebook-pyspark"]
  },
  {
    phaseId: "jupyter-remote",
    tierRiskOwner: "released-jupyter-remote",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "remote-jupyter-descriptor"],
    runnerKey: "released-jupyter",
    declaredProgressSections: [],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "local-default",
    declaredProgressSections: ORDINARY_R_PROGRESS_SECTIONS,
    evidenceSceneIds: ["notebook-r-operations", "notebook-r", "notebook-r-editing", "notebook-r-code-insertion"]
  },
  {
    phaseId: "jupyter-r",
    selector: "core-operations",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "candidate-core",
    declaredProgressSections: FOCUSED_R_EDITING_PROGRESS_SECTIONS,
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "categorical-operations",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "categorical-operations",
    declaredProgressSections: FOCUSED_R_EDITING_PROGRESS_SECTIONS,
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "value-operations",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "value-operations",
    declaredProgressSections: FOCUSED_R_EDITING_PROGRESS_SECTIONS,
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "kernel-restart",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "kernel-restart",
    declaredProgressSections: ["notebook", "restart"],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "native-frames",
    tierRiskOwner: "released-r",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "native-frames",
    declaredProgressSections: ["notebook", "collapse-open", "native-viewing", "native-editing"],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "interactive-terminal",
    tierRiskOwner: "released-r-focused",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["released-r", "native-r-tooling"],
    runnerKey: "focused-r-interactive",
    declaredProgressSections: ["interactive"],
    evidenceSceneIds: []
  },
  {
    phaseId: "jupyter-r",
    selector: "literate-documents",
    tierRiskOwner: "released-r-focused",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-r", "native-r-tooling"],
    runnerKey: "focused-r-literate",
    declaredProgressSections: ["literate-documents"],
    evidenceSceneIds: ["r-quarto-variable-picker"]
  },
  {
    phaseId: "jupyter-r-remote",
    tierRiskOwner: "released-jupyter-remote",
    editorEligibility: "all",
    platformEligibility: "all",
    prerequisites: ["host-python", "released-jupyter", "released-r", "remote-jupyter-descriptor"],
    runnerKey: "released-jupyter",
    rCoverageProfileKey: "remote-representative",
    declaredProgressSections: ORDINARY_R_PROGRESS_SECTIONS,
    evidenceSceneIds: []
  }
];

export type ReleasedJupyterScenario = ReleasedJupyterScenarioDefinition;

export function releasedJupyterScenario(selection: {
  readonly phaseId: string;
  readonly selector: ExtensionHostTestSelector | undefined;
  readonly editor: string | undefined;
  readonly platform: NodeJS.Platform;
}): ReleasedJupyterScenario | undefined {
  const scenario = RELEASED_JUPYTER_SCENARIOS.find(
    (candidate) => candidate.phaseId === selection.phaseId && candidate.selector === selection.selector
  );
  if (!scenario) return undefined;
  if (scenario.editorEligibility !== "all" && !scenario.editorEligibility.includes(selection.editor ?? "")) {
    return undefined;
  }
  if (scenario.platformEligibility !== "all" && !scenario.platformEligibility.includes(selection.platform)) {
    return undefined;
  }
  return scenario;
}
