export interface StructuralEditorTab {
  readonly input: unknown;
  readonly isActive?: boolean;
}

export interface StructuralEditorTabGroup {
  readonly tabs: readonly StructuralEditorTab[];
}

const DEFAULT_DIAGNOSTIC_TAB_LIMIT = 16;

function structuralCustomEditorInput(input: unknown): { viewType?: string; uri?: string } | undefined {
  if (typeof input !== "object" || input === null || !("viewType" in input) || !("uri" in input)) return undefined;
  const candidate = input as { readonly viewType?: unknown; readonly uri?: unknown };
  let uri: string | undefined;
  try {
    const value = candidate.uri?.toString();
    if (typeof value === "string") uri = value;
  } catch {
    // An unreadable input cannot identify the requested source.
  }
  return { viewType: typeof candidate.viewType === "string" ? candidate.viewType : undefined, uri };
}

function isExactCustomEditorInput(input: unknown, expectedViewType: string, expectedUri: string): boolean {
  const candidate = structuralCustomEditorInput(input);
  return candidate?.viewType === expectedViewType && candidate.uri === expectedUri;
}

export function findExactCustomEditorTab<T extends StructuralEditorTab>(
  groups: readonly StructuralEditorTabGroup[],
  expectedViewType: string,
  expectedUri: string
): T | undefined {
  for (const group of groups) {
    for (const tab of group.tabs) {
      if (isExactCustomEditorInput(tab.input, expectedViewType, expectedUri)) return tab as T;
    }
  }
  return undefined;
}

export function customEditorTabDiagnostic(
  groups: readonly StructuralEditorTabGroup[],
  expectedViewType: string,
  expectedUri: string,
  limit = DEFAULT_DIAGNOSTIC_TAB_LIMIT
): unknown {
  const boundedLimit = Math.max(0, Math.min(DEFAULT_DIAGNOSTIC_TAB_LIMIT, Math.trunc(limit)));
  const tabs = groups.flatMap((group, groupIndex) =>
    group.tabs.map((tab, tabIndex) => ({ groupIndex, tabIndex, tab }))
  );

  return {
    totalGroups: groups.length,
    totalTabs: tabs.length,
    examinedTabs: Math.min(tabs.length, boundedLimit),
    exactMatches: tabs.filter(({ tab }) => isExactCustomEditorInput(tab.input, expectedViewType, expectedUri)).length,
    truncated: tabs.length > boundedLimit,
    tabs: tabs.slice(0, boundedLimit).map(({ groupIndex, tabIndex, tab }) => {
      const input = structuralCustomEditorInput(tab.input);
      return {
        groupIndex,
        tabIndex,
        active: tab.isActive === true,
        structural: input !== undefined,
        viewTypeMatches: input?.viewType === expectedViewType,
        uriMatches: input?.uri === expectedUri
      };
    })
  };
}
