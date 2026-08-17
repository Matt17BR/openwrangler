import type * as vscode from "vscode";
import type { ColumnSummary, ValueCount } from "../../shared/protocol";
import type { RColumnSchema, RFramePageContract } from "./rFrameContract";
import type {
  RKernelColumnReference,
  RKernelDataExportResult,
  RKernelDatasetStatsResult,
  RKernelExportFormat,
  RKernelPageWindow,
  RKernelPlanUpdatedResult,
  RKernelStepInspectionResult,
  RKernelStepPreviewResult,
  RKernelTransformStep,
  RKernelViewQuery
} from "./rKernelProtocol";
import type { RKernelOpenResult, RKernelRequestOptions } from "./rKernelTransport";

export interface RKernelBridgeTransport {
  readonly onDidInvalidateKernel: vscode.Event<void>;
  open(variableName: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RKernelOpenResult>;
  getPage(sessionId: string, page: RKernelPageWindow, options?: RKernelRequestOptions): Promise<RFramePageContract>;
  getSummary(
    sessionId: string,
    columns: readonly RKernelColumnReference[],
    view: RKernelViewQuery,
    options?: RKernelRequestOptions
  ): Promise<readonly ColumnSummary[]>;
  getDatasetStats(
    sessionId: string,
    view: RKernelViewQuery,
    options?: RKernelRequestOptions
  ): Promise<RKernelDatasetStatsResult>;
  getColumnValues(
    sessionId: string,
    column: RKernelColumnReference,
    view: RKernelViewQuery,
    search: string | undefined,
    limit: number,
    options?: RKernelRequestOptions
  ): Promise<Readonly<{ column: string; values: readonly ValueCount[]; hasMore: boolean; sampleSize?: number }>>;
  previewStep(
    sessionId: string,
    revision: number,
    step: RKernelTransformStep,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    replaceStepId?: string,
    options?: RKernelRequestOptions
  ): Promise<RKernelStepPreviewResult>;
  applyDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  discardDraft(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  undoStep(
    sessionId: string,
    revision: number,
    page: RKernelPageWindow,
    options?: RKernelRequestOptions
  ): Promise<RKernelPlanUpdatedResult>;
  inspectStep(
    sessionId: string,
    revision: number,
    stepId: string,
    page: RKernelPageWindow,
    inputSchema: readonly RColumnSchema[],
    outputSchema: readonly RColumnSchema[],
    options?: RKernelRequestOptions
  ): Promise<RKernelStepInspectionResult>;
  exportData?(
    sessionId: string,
    revision: number,
    format: RKernelExportFormat,
    writeChunk: (chunk: Uint8Array) => Promise<void>,
    options?: RKernelRequestOptions
  ): Promise<RKernelDataExportResult>;
  close(sessionId: string, options?: RKernelRequestOptions): Promise<void>;
  isSessionMapped(sessionId: string): boolean;
  dispose(): Promise<void>;
}
