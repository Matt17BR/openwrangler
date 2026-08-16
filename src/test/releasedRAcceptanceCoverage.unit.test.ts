import { describe, expect, it } from "vitest";
import {
  RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE,
  RELEASED_R_COMPREHENSIVE_COVERAGE,
  RELEASED_R_KERNEL_RESTART_COVERAGE,
  RELEASED_R_REPRESENTATIVE_COVERAGE,
  RELEASED_R_VALUE_OPERATIONS_COVERAGE,
  releasedRAcceptanceCoverageProfile
} from "./extensionHost/releasedRAcceptanceCoverage";
import type { ExtensionHostTestSelector } from "./extensionHost/phaseDispatch";

function profile(
  phase: "jupyter-r" | "jupyter-r-remote",
  selector: ExtensionHostTestSelector | undefined,
  editor: string | undefined,
  platform: NodeJS.Platform
) {
  return releasedRAcceptanceCoverageProfile({ editor, phase, platform, selector });
}

describe("released-R acceptance coverage", () => {
  it("keeps the comprehensive and representative contracts immutable and distinct", () => {
    expect(RELEASED_R_COMPREHENSIVE_COVERAGE).toEqual({
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
    expect(RELEASED_R_REPRESENTATIVE_COVERAGE).toEqual({
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
    expect(Object.isFrozen(RELEASED_R_COMPREHENSIVE_COVERAGE)).toBe(true);
    expect(Object.isFrozen(RELEASED_R_REPRESENTATIVE_COVERAGE)).toBe(true);
  });

  it("assigns comprehensive default coverage to local VS Code except on Windows", () => {
    expect(profile("jupyter-r", undefined, "vscode", "linux")).toBe(RELEASED_R_COMPREHENSIVE_COVERAGE);
    expect(profile("jupyter-r", undefined, "vscode", "darwin")).toBe(RELEASED_R_COMPREHENSIVE_COVERAGE);
    expect(profile("jupyter-r", undefined, "vscode", "win32")).toBe(RELEASED_R_REPRESENTATIVE_COVERAGE);
    expect(profile("jupyter-r", undefined, "cursor", "linux")).toBe(RELEASED_R_REPRESENTATIVE_COVERAGE);
  });

  it("keeps remote R representative on every editor and platform", () => {
    expect(profile("jupyter-r-remote", undefined, "vscode", "linux")).toBe(RELEASED_R_REPRESENTATIVE_COVERAGE);
    expect(profile("jupyter-r-remote", undefined, "cursor", "darwin")).toBe(RELEASED_R_REPRESENTATIVE_COVERAGE);
  });

  it("routes focused categorical, value, and restart selectors to their exact owners", () => {
    expect(profile("jupyter-r", "categorical-operations", "vscode", "linux")).toBe(
      RELEASED_R_CATEGORICAL_OPERATIONS_COVERAGE
    );
    expect(profile("jupyter-r", "value-operations", "vscode", "linux")).toBe(RELEASED_R_VALUE_OPERATIONS_COVERAGE);
    expect(profile("jupyter-r", "kernel-restart", "vscode", "linux")).toBe(RELEASED_R_KERNEL_RESTART_COVERAGE);
  });

  it("gives candidate core one Clone lifecycle only on Linux VS Code", () => {
    expect(profile("jupyter-r", "core-operations", "vscode", "linux")).toEqual({
      ...RELEASED_R_COMPREHENSIVE_COVERAGE,
      editing: "clone-lifecycle",
      kernelLifecycle: false,
      openCollapseSessions: false,
      openNativeFramesInViewingMode: false,
      nativeFrameEditing: "none"
    });
    expect(profile("jupyter-r", "core-operations", "cursor", "linux")).toEqual({
      ...RELEASED_R_REPRESENTATIVE_COVERAGE,
      editing: "clone-lifecycle",
      kernelLifecycle: false,
      openCollapseSessions: false,
      openNativeFramesInViewingMode: false,
      nativeFrameEditing: "none"
    });
  });

  it("keeps native-frame coverage comprehensive only on Linux VS Code", () => {
    expect(profile("jupyter-r", "native-frames", "vscode", "linux")).toEqual({
      ...RELEASED_R_COMPREHENSIVE_COVERAGE,
      name: "native-frames",
      coreJourney: false,
      kernelLifecycle: false
    });
    expect(profile("jupyter-r", "native-frames", "cursor", "linux")).toEqual({
      ...RELEASED_R_REPRESENTATIVE_COVERAGE,
      name: "native-frames",
      coreJourney: false,
      kernelLifecycle: false
    });
  });
});
