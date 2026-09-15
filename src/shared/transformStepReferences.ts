import type {
  ByExampleProgram,
  ColumnReference,
  ColumnSchema,
  FillMissingReplacement,
  TransformStep
} from "./protocol";

export interface SavedReferenceCheck {
  label: string;
  reference: ColumnReference;
  expectedType?: ColumnSchema["type"];
}

interface SavedReferenceGroup {
  label: string;
  references: SavedReferenceCheck[];
  rejectRepeatedIds: boolean;
}

type SavedReferencePolicy = SavedReferenceGroup[] | string;

export function unknownOperationPolicy(step: never): string {
  const kind = (step as { kind?: unknown }).kind;
  const label = typeof kind === "string" ? ` “${kind}”` : "";
  return `This saved step cannot be edited safely because its operation kind${label} is unsupported.`;
}

function unknownFillReplacement(replacement: never): undefined {
  void replacement;
  return undefined;
}

function fillMissingReferences(replacement: FillMissingReplacement): SavedReferenceCheck[] | undefined {
  switch (replacement.kind) {
    case "fallbackColumns":
      return replacement.columns.map((reference, index) => ({
        label: `fallback column ${index + 1}`,
        reference
      }));
    case "groupedStatistic":
      return replacement.keys.map((reference, index) => ({
        label: `group key ${index + 1}`,
        reference
      }));
    case "directional":
      return replacement.orderBy.map((rule, index) => ({
        label: `calculation order ${index + 1}`,
        reference: rule.column
      }));
    case "linearInterpolation":
      return [{ label: "interpolation coordinate", reference: replacement.coordinate }];
    case "median":
    case "mean":
    case "mostFrequent":
    case "string":
    case "integer":
    case "float":
    case "decimal":
    case "boolean":
    case "date":
    case "datetime":
      return [];
    default:
      return unknownFillReplacement(replacement);
  }
}

function unknownByExampleProgram(program: never): undefined {
  void program;
  return undefined;
}

export function byExampleProgramReferences(program: ByExampleProgram): ColumnReference[] | undefined {
  switch (program.kind) {
    case "column":
      return [program.column];
    case "literal":
      return [];
    case "concat":
      return collectByExampleProgramReferences(program.parts);
    case "arithmetic":
      return collectByExampleProgramReferences([program.left, program.right]);
    case "slice":
    case "split":
    case "regexExtract":
    case "regexReplace":
    case "case":
    case "datetimeFormat":
      return byExampleProgramReferences(program.input);
    default:
      return unknownByExampleProgram(program);
  }
}

function collectByExampleProgramReferences(programs: readonly ByExampleProgram[]): ColumnReference[] | undefined {
  const references: ColumnReference[] = [];
  for (const program of programs) {
    const nested = byExampleProgramReferences(program);
    if (!nested) return undefined;
    references.push(...nested);
  }
  return references;
}

export function savedReferencePolicy(step: TransformStep): SavedReferencePolicy {
  switch (step.kind) {
    case "sortRows":
      return [
        {
          label: "sort rules",
          references: step.params.rules.map((rule, index) => ({
            label: `sort rule ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "conditionalColumn":
      return [
        {
          label: "condition column",
          references: [
            { label: "condition column", reference: step.params.column, expectedType: step.params.columnType }
          ],
          rejectRepeatedIds: false
        }
      ];
    case "filterRows":
      return [
        {
          label: "filters",
          references: step.params.filterModel.filters.map((filter, index) => ({
            label: `filter ${index + 1}`,
            reference: filter.column,
            expectedType: filter.type
          })),
          rejectRepeatedIds: true
        },
        {
          label: "filter-step sorts",
          references: step.params.filterModel.sort.map((rule, index) => ({
            label: `filter-step sort ${index + 1}`,
            reference: rule.column
          })),
          rejectRepeatedIds: true
        }
      ];
    case "dropMissingRows":
    case "dropDuplicates":
      return [
        {
          label: "column list",
          references: (step.params.columns ?? []).map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "selectColumns":
    case "dropColumns":
    case "markDuplicates":
    case "oneHotEncode":
      return [
        {
          label: "column list",
          references: step.params.columns.map((reference, index) => ({
            label: `column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "formula":
      return [
        {
          label: "formula operands",
          references: [
            { label: "left formula column", reference: step.params.leftColumn },
            ...(step.params.rightColumn ? [{ label: "right formula column", reference: step.params.rightColumn }] : [])
          ],
          rejectRepeatedIds: false
        }
      ];
    case "fillMissingValues": {
      const references = fillMissingReferences(step.params.replacement);
      return references
        ? [
            {
              label: "fill columns",
              references: [{ label: "fill target", reference: step.params.column }, ...references],
              rejectRepeatedIds: true
            }
          ]
        : "This saved fill step uses an unsupported replacement kind.";
    }
    case "renameColumn":
    case "cloneColumn":
    case "extractStructFields":
    case "explodeList":
    case "castColumn":
    case "textLength":
    case "multiLabelBinarize":
    case "findReplace":
    case "stripText":
    case "splitText":
    case "splitTextColumns":
    case "extractRegexGroup":
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "denseRank":
    case "minMaxScale":
    case "roundNumber":
    case "floorNumber":
    case "ceilNumber":
    case "formatDatetime":
      return [
        {
          label: "input column",
          references: [{ label: "input column", reference: step.params.column }],
          rejectRepeatedIds: false
        }
      ];
    case "pivotLonger":
      return [
        {
          label: "pivot columns",
          references: step.params.columns.map((reference, index) => ({
            label: `pivot column ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        }
      ];
    case "pivotWider":
      return [
        {
          label: "pivot columns",
          references: [
            { label: "names-from column", reference: step.params.namesFrom },
            { label: "values-from column", reference: step.params.valuesFrom }
          ],
          rejectRepeatedIds: true
        }
      ];
    case "groupBy":
      return [
        {
          label: "group keys",
          references: step.params.keys.map((reference, index) => ({
            label: `group key ${index + 1}`,
            reference
          })),
          rejectRepeatedIds: true
        },
        {
          label: "aggregation values",
          references: step.params.aggregations.map((aggregation, index) => ({
            label: `aggregation value ${index + 1}`,
            reference: aggregation.column
          })),
          rejectRepeatedIds: false
        }
      ];
    case "byExample": {
      const programReferences = step.params.program ? byExampleProgramReferences(step.params.program) : [];
      return programReferences
        ? [
            {
              label: "by-example sources",
              references: step.params.sourceColumns.map((reference, index) => ({
                label: `by-example source ${index + 1}`,
                reference
              })),
              rejectRepeatedIds: true
            },
            {
              label: "by-example program operands",
              references: programReferences.map((reference, index) => ({
                label: `by-example program operand ${index + 1}`,
                reference
              })),
              rejectRepeatedIds: false
            }
          ]
        : "This saved by-example step uses an unsupported program kind.";
    }
    case "customCode":
      return [];
    default:
      return unknownOperationPolicy(step);
  }
}

/** Rewrite only declared references in a copy, preserving literals and repeated operands. */
export function remapStepColumnReferences(
  step: TransformStep,
  columnIds: ReadonlyMap<string, string>
): TransformStep | string {
  const mapped = structuredClone(step);
  const policy = savedReferencePolicy(mapped);
  if (typeof policy === "string") return policy;
  // Resolve every ID before writing: a repeated reference may be the same object.
  const replacements = policy.flatMap((group) =>
    group.references.map(({ reference }) => ({ reference, id: columnIds.get(reference.id) ?? reference.id }))
  );
  for (const { reference, id } of replacements) reference.id = id;
  return mapped;
}
