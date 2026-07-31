export const SESSION_OPEN_PROGRESS_STAGES = ["acquiringKernel", "bootstrappingRuntime", "preparingSparkView"] as const;

export type SessionOpenProgressStage = (typeof SESSION_OPEN_PROGRESS_STAGES)[number];
