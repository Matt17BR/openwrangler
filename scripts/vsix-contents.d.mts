export const allowedVsixEntryPatterns: readonly RegExp[];
export const requiredVsixEntries: readonly string[];
export function inspectVsixEntries(entries: readonly string[]): { forbidden: string[]; missing: string[] };
