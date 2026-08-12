export const allowedVsixEntryPatterns: readonly RegExp[];
export const requiredVsixEntries: readonly string[];
export const VENDORED_JS_YAML_ENTRY: "extension/dist/extension/vendor/js-yaml.js";
export function requiredVsixEntriesForRelease(
  options?: Readonly<{ requireRFrameContract?: boolean; requireVendoredJsYaml?: boolean }>
): readonly string[];
export const packagedSourceDocumentEntries: readonly Readonly<{ source: string; archive: string }>[];
export function inspectVsixEntries(
  entries: readonly string[],
  options?: Readonly<{ requireRFrameContract?: boolean; requireVendoredJsYaml?: boolean }>
): {
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
