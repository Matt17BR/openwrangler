export const allowedVsixEntryPatterns: readonly RegExp[];
export const requiredVsixEntries: readonly string[];
export const packagedSourceDocumentEntries: readonly Readonly<{ source: string; archive: string }>[];
export function inspectVsixEntries(entries: readonly string[]): {
  forbidden: string[];
  missing: string[];
  duplicates: string[];
};
export function inspectNotebookRendererBundle(bundle: unknown): string[];
export function inspectVsixPreReleaseMetadata(packageJson: string, vsixManifest: string): string[];
export function inspectReadmeSourceSrcsets(readme: string): string[];
export function inspectPackagedReadmeSource(sourceReadme: unknown, packagedReadme: unknown): string[];
export function inspectPackagedSourceDocumentParity(
  sourceDocuments: ReadonlyMap<string, Buffer>,
  archiveEntryDigests: readonly (readonly [string, string])[],
  archiveEntrySizes: readonly (readonly [string, number])[]
): string[];
