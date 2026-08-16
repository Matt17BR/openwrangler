export type PackagedEvidenceTheme = "dark" | "light" | "high-contrast";

export type PackagedEvidenceRunnerKey = "workbench" | "notebook-output" | "notebook-workbench";

export type PackagedEvidenceViewportKey = "showcase" | "product" | "pandas-output" | "notebook";

interface PackagedEvidenceSceneDefinition {
  readonly id: string;
  readonly runnerKey: PackagedEvidenceRunnerKey;
  readonly viewportKey: PackagedEvidenceViewportKey;
  readonly themes: readonly PackagedEvidenceTheme[];
}

export const PACKAGED_EVIDENCE_SCENES = [
  { id: "hero", runnerKey: "workbench", viewportKey: "showcase", themes: ["dark", "light"] },
  { id: "file-explorer-action", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "explore", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  {
    id: "high-contrast-explore",
    runnerKey: "workbench",
    viewportKey: "product",
    themes: ["high-contrast"]
  },
  { id: "filter-result", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "workflow", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "sidebar-overview", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "operation-catalog", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "operation-configuration", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "applied-step-inspection", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "latest-step-edited", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "latest-step-undone", runnerKey: "workbench", viewportKey: "product", themes: ["dark"] },
  { id: "notebook-pandas", runnerKey: "notebook-output", viewportKey: "pandas-output", themes: ["dark"] },
  {
    id: "notebook-code-insertion",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  },
  {
    id: "notebook-variable-picker",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  },
  {
    id: "notebook-r-operations",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  },
  {
    id: "notebook-pyspark-picker",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  },
  { id: "notebook-polars", runnerKey: "notebook-workbench", viewportKey: "notebook", themes: ["dark"] },
  { id: "notebook-duckdb", runnerKey: "notebook-workbench", viewportKey: "notebook", themes: ["dark"] },
  { id: "notebook-pyspark", runnerKey: "notebook-workbench", viewportKey: "notebook", themes: ["dark"] },
  { id: "notebook-r", runnerKey: "notebook-workbench", viewportKey: "notebook", themes: ["dark"] },
  { id: "notebook-r-editing", runnerKey: "notebook-workbench", viewportKey: "notebook", themes: ["dark"] },
  {
    id: "notebook-r-code-insertion",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  },
  {
    id: "r-quarto-variable-picker",
    runnerKey: "notebook-workbench",
    viewportKey: "notebook",
    themes: ["dark"]
  }
] as const satisfies readonly PackagedEvidenceSceneDefinition[];

export type PackagedEvidenceSceneId = (typeof PACKAGED_EVIDENCE_SCENES)[number]["id"];

export const PACKAGED_SCREENSHOT_SCENES: readonly PackagedEvidenceSceneId[] = PACKAGED_EVIDENCE_SCENES.map(
  ({ id }) => id
);

const packagedEvidenceScenesById = new Map<PackagedEvidenceSceneId, (typeof PACKAGED_EVIDENCE_SCENES)[number]>(
  PACKAGED_EVIDENCE_SCENES.map((scene) => [scene.id, scene])
);

export function packagedEvidenceScene(sceneId: PackagedEvidenceSceneId): (typeof PACKAGED_EVIDENCE_SCENES)[number] {
  const scene = packagedEvidenceScenesById.get(sceneId);
  if (!scene) throw new TypeError(`Unknown packaged evidence scene: ${String(sceneId)}`);
  return scene;
}

export function packagedScreenshotFileName(
  editor: string,
  sceneId: PackagedEvidenceSceneId,
  theme: PackagedEvidenceTheme
): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(editor)) {
    throw new TypeError("Screenshot editor keys must be short lowercase identifiers.");
  }
  const scene = packagedEvidenceScene(sceneId);
  if (!(scene.themes as readonly PackagedEvidenceTheme[]).includes(theme)) {
    throw new TypeError(`The ${scene.id} evidence scene does not support the ${theme} theme.`);
  }
  return `${editor}-${scene.id}-${theme}.png`;
}
