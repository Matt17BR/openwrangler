import type { ExtensionHostTestSelector } from "./phaseDispatch";

export type ReleasedRAcceptanceCoverageProfile = Readonly<{
  name:
    | "categorical-operations"
    | "value-operations"
    | "kernel-restart"
    | "native-frames"
    | "comprehensive"
    | "representative";
  coreJourney: boolean;
  kernelLifecycle: boolean;
  gridPaging: "all-blocks" | "single-round-trip";
  editing: "clone-lifecycle" | "core-catalog" | "rename-lifecycle";
  focusedEditing: "none" | "categorical-operations" | "value-operations";
  openCollapseSessions: boolean;
  openNativeFramesInViewingMode: boolean;
  nativeFrameEditing: "none" | "rename-and-drop" | "one-operation-per-flavor";
}>;

export interface ReleasedRAcceptanceCoverageRequest {
  readonly editor: string | undefined;
  readonly phase: "jupyter-r" | "jupyter-r-remote";
  readonly platform: NodeJS.Platform;
  readonly selector: ExtensionHostTestSelector | undefined;
}

export const RELEASED_R_COMPREHENSIVE_COVERAGE: ReleasedRAcceptanceCoverageProfile = Object.freeze({
  name: "comprehensive",
  coreJourney: true,
  kernelLifecycle: true,
  gridPaging: "all-blocks",
  editing: "core-catalog",
  focusedEditing: "none",
  openCollapseSessions: true,
  openNativeFramesInViewingMode: true,
  nativeFrameEditing: "rename-and-drop"
});

export const RELEASED_R_REPRESENTATIVE_COVERAGE: ReleasedRAcceptanceCoverageProfile = Object.freeze({
  name: "representative",
  coreJourney: true,
  kernelLifecycle: true,
  gridPaging: "single-round-trip",
  editing: "rename-lifecycle",
  focusedEditing: "none",
  openCollapseSessions: false,
  openNativeFramesInViewingMode: false,
  nativeFrameEditing: "one-operation-per-flavor"
});

export const RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE: ReleasedRAcceptanceCoverageProfile = Object.freeze({
  ...RELEASED_R_REPRESENTATIVE_COVERAGE,
  name: "categorical-operations",
  kernelLifecycle: false,
  focusedEditing: "categorical-operations",
  nativeFrameEditing: "none"
});

export const RELEASED_R_VALUE_OPERATIONS_COVERAGE: ReleasedRAcceptanceCoverageProfile = Object.freeze({
  ...RELEASED_R_REPRESENTATIVE_COVERAGE,
  name: "value-operations",
  kernelLifecycle: false,
  focusedEditing: "value-operations",
  nativeFrameEditing: "none"
});

export const RELEASED_R_KERNEL_RESTART_COVERAGE: ReleasedRAcceptanceCoverageProfile = Object.freeze({
  ...RELEASED_R_REPRESENTATIVE_COVERAGE,
  name: "kernel-restart",
  coreJourney: false,
  kernelLifecycle: true
});

export function releasedRCoreAcceptanceCoverageProfile(
  editor: string | undefined,
  platform: NodeJS.Platform
): ReleasedRAcceptanceCoverageProfile {
  if (editor === "cursor") return RELEASED_R_REPRESENTATIVE_COVERAGE;
  return platform === "win32" ? RELEASED_R_REPRESENTATIVE_COVERAGE : RELEASED_R_COMPREHENSIVE_COVERAGE;
}

export function releasedRCandidateCoreAcceptanceCoverageProfile(
  editor: string | undefined,
  platform: NodeJS.Platform
): ReleasedRAcceptanceCoverageProfile {
  if (editor === "cursor") return RELEASED_R_REPRESENTATIVE_COVERAGE;
  return platform === "linux" ? RELEASED_R_COMPREHENSIVE_COVERAGE : RELEASED_R_REPRESENTATIVE_COVERAGE;
}

export function releasedRNativeFramesAcceptanceCoverageProfile(
  editor: string | undefined,
  platform: NodeJS.Platform
): ReleasedRAcceptanceCoverageProfile {
  return Object.freeze({
    ...releasedRCandidateCoreAcceptanceCoverageProfile(editor, platform),
    name: "native-frames",
    coreJourney: false,
    kernelLifecycle: false
  });
}

export function releasedRAcceptanceCoverageProfile(
  request: ReleasedRAcceptanceCoverageRequest
): ReleasedRAcceptanceCoverageProfile {
  if (request.selector === "categorical-operations") return RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE;
  if (request.selector === "value-operations") return RELEASED_R_VALUE_OPERATIONS_COVERAGE;
  if (request.selector === "kernel-restart") return RELEASED_R_KERNEL_RESTART_COVERAGE;
  if (request.selector === "native-frames") {
    return releasedRNativeFramesAcceptanceCoverageProfile(request.editor, request.platform);
  }
  if (request.selector === "core-operations") {
    return Object.freeze({
      ...releasedRCandidateCoreAcceptanceCoverageProfile(request.editor, request.platform),
      editing: "clone-lifecycle",
      kernelLifecycle: false,
      openCollapseSessions: false,
      openNativeFramesInViewingMode: false,
      nativeFrameEditing: "none"
    });
  }
  if (request.phase === "jupyter-r-remote") return RELEASED_R_REPRESENTATIVE_COVERAGE;
  return releasedRCoreAcceptanceCoverageProfile(request.editor, request.platform);
}
