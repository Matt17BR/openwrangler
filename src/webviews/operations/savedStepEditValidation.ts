import type {
  ByExampleProgram,
  ColumnReference,
  ColumnSchema,
  FillMissingReplacement,
  TransformStep
} from "../../shared/protocol";
import { isDirectionalOrderColumn, isGroupedKeyColumn, isInterpolationCoordinateColumn } from "./fillMissingModel";

const recovery = "Cancel editing, then reload the session or undo and recreate this step.";

interface SavedReferenceCheck {
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

function unknownOperationPolicy(step: never): string {
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

function byExampleProgramReferences(program: ByExampleProgram): ColumnReference[] | undefined {
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

function savedReferencePolicy(step: TransformStep): SavedReferencePolicy {
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
    case "castColumn":
    case "textLength":
    case "multiLabelBinarize":
    case "findReplace":
    case "stripText":
    case "splitText":
    case "capitalizeText":
    case "lowerText":
    case "upperText":
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

export function savedStepEditError(
  step: TransformStep,
  inputSchema: readonly ColumnSchema[] | undefined
): string | undefined {
  if (!inputSchema) {
    return `This saved step cannot be edited safely because its recorded input schema is unavailable. ${recovery}`;
  }

  const columnsById = new Map(inputSchema.map((column) => [column.id, column]));
  if (columnsById.size !== inputSchema.length) {
    return `This saved step cannot be edited safely because its recorded input schema contains duplicate column IDs. ${recovery}`;
  }

  const policy = savedReferencePolicy(step);
  if (typeof policy === "string") return `${policy} ${recovery}`;
  for (const group of policy) {
    const seenIds = new Set<string>();
    for (const check of group.references) {
      const column = columnsById.get(check.reference.id);
      if (!column) {
        return `The saved ${check.label} refers to column ID “${check.reference.id}”, which is absent from the recorded input schema. ${recovery}`;
      }
      if (column.name !== check.reference.name) {
        return `The saved ${check.label} expects column name “${check.reference.name}” for ID “${check.reference.id}”, but the recorded input schema names it “${column.name}”. ${recovery}`;
      }
      if (check.expectedType !== undefined && column.type !== check.expectedType) {
        return `The saved ${check.label} declares type “${check.expectedType}”, but its recorded input column has type “${column.type}”. ${recovery}`;
      }
      if (group.rejectRepeatedIds && seenIds.has(check.reference.id)) {
        return `The saved ${group.label} repeats column ID “${check.reference.id}”. ${recovery}`;
      }
      seenIds.add(check.reference.id);
    }
  }

  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "fallbackColumns") {
    const target = columnsById.get(step.params.column.id);
    if (!target) return `The saved fill target is absent from the recorded input schema. ${recovery}`;
    const incompatible = step.params.replacement.columns.find(
      (reference) => columnsById.get(reference.id)?.type !== target.type
    );
    if (incompatible) {
      return `The saved fallback column “${incompatible.name}” is not compatible with the recorded ${target.type} target. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "directional") {
    const incompatible = step.params.replacement.orderBy.find((rule) => {
      const column = columnsById.get(rule.column.id);
      return !column || !isDirectionalOrderColumn(column);
    });
    if (incompatible) {
      return `The saved calculation-order column “${incompatible.column.name}” cannot be ordered safely. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "linearInterpolation") {
    const target = columnsById.get(step.params.column.id);
    const coordinate = columnsById.get(step.params.replacement.coordinate.id);
    if (target?.type !== "float") {
      return `The saved interpolation target is not a floating-point column. ${recovery}`;
    }
    if (!coordinate || !isInterpolationCoordinateColumn(coordinate)) {
      return `The saved interpolation coordinate cannot be used safely. ${recovery}`;
    }
  }
  if (step.kind === "fillMissingValues" && step.params.replacement.kind === "groupedStatistic") {
    const incompatible = step.params.replacement.keys.find((reference) => {
      const column = columnsById.get(reference.id);
      return !column || !isGroupedKeyColumn(column);
    });
    if (incompatible) {
      return `The saved group key “${incompatible.name}” cannot be used for grouped filling. ${recovery}`;
    }
  }
  if (step.kind === "byExample") {
    if (!step.params.program) {
      return `This saved by-example step has no deterministic program. ${recovery}`;
    }
    const programReferences = byExampleProgramReferences(step.params.program);
    if (!programReferences) return `This saved by-example step uses an unsupported program kind. ${recovery}`;
    const sourceIds = new Set(step.params.sourceColumns.map((reference) => reference.id));
    const outsideSource = programReferences.find((reference) => !sourceIds.has(reference.id));
    if (outsideSource) {
      return `The saved by-example program uses column ID “${outsideSource.id}” outside its selected sources. ${recovery}`;
    }
  }
  return undefined;
}
