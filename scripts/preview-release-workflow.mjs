import { inspectReleaseTrainWorkflow } from "./release-train-workflow.mjs";

export function inspectPreviewReleaseWorkflow(source) {
  return inspectReleaseTrainWorkflow(source, "preview");
}
