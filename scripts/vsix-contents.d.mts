export const allowedVsixEntryPatterns: readonly RegExp[];
export const requiredVsixEntries: readonly string[];
export function inspectVsixEntries(entries: readonly string[]): {
  forbidden: string[];
  missing: string[];
  duplicates: string[];
};
export function inspectVsixPreReleaseMetadata(packageJson: string, vsixManifest: string): string[];
export function inspectReadmeSourceSrcsets(readme: string): string[];
