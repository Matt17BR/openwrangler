import {
  REPLACEABLE_COLUMN_TYPES,
  findCouldMatch,
  replaceMatchesIsPortable,
  type FindOptions
} from "../../shared/find";
import type { ColumnSchema, DataBackend, ReplaceMatchesTransformStep } from "../../shared/protocol";

export interface FindReplaceStepRequest {
  readonly id: string;
  readonly schema: readonly ColumnSchema[];
  readonly backend: DataBackend;
  readonly options: FindOptions;
  readonly replacement: string;
  /** One column ID, or undefined for every column. */
  readonly scope: string | undefined;
  /** A single cell, addressed by its zero-based row in the dataframe before viewing filters and sorts. */
  readonly cell?: Readonly<{ columnId: string; position: number }>;
}

export type FindReplaceStepResult = { readonly step: ReplaceMatchesTransformStep } | { readonly error: string };

export function findReplaceStep(request: FindReplaceStepRequest): FindReplaceStepResult {
  const { schema, options, cell } = request;
  const targetId = cell?.columnId ?? request.scope;
  const columns =
    targetId === undefined
      ? schema.filter(
          (column) => REPLACEABLE_COLUMN_TYPES.has(column.type) && findCouldMatch(column.type, options.text)
        )
      : schema.filter((column) => column.id === targetId);
  const [first, ...rest] = columns;
  if (first === undefined) {
    return {
      error:
        targetId === undefined
          ? "No column can contain the search text."
          : "The column to replace in is no longer available."
    };
  }
  const unsupported = columns.find((column) => !REPLACEABLE_COLUMN_TYPES.has(column.type));
  if (unsupported) {
    return { error: `Replace can't write text back into ${unsupported.type} column '${unsupported.name}'.` };
  }
  const portable = columns.every((column) => replaceMatchesIsPortable(column.type, options));
  return {
    step: {
      id: request.id,
      kind: "replaceMatches",
      params: {
        columns: [reference(first), ...rest.map(reference)],
        find: options.text,
        replacement: request.replacement,
        matchCase: options.matchCase,
        wholeCell: options.wholeCell,
        spelling: portable ? "portable" : request.backend === "r" ? "r" : "python",
        ...(cell === undefined ? {} : { row: cell.position })
      }
    }
  };
}

function reference(column: ColumnSchema): { id: string; name: string } {
  return { id: column.id, name: column.name };
}
