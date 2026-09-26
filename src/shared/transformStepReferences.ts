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
  columns: ReadonlyMap<string, ColumnReference>
): TransformStep | string {
  const mapped = structuredClone(step);
  const policy = savedReferencePolicy(mapped);
  if (typeof policy === "string") return policy;
  // Resolve every reference before writing: a repeated reference may be the same object.
  const replacements = policy.flatMap((group) =>
    group.references.map(({ reference }) => {
      const target = columns.get(reference.id);
      return { reference, id: target?.id ?? reference.id, name: target?.name ?? reference.name };
    })
  );
  for (const { reference, id, name } of replacements) {
    reference.id = id;
    reference.name = name;
  }
  return mapped;
}

/** Point an in-place output at the mapped column's name, so a replacement never becomes a new column. */
function followInPlaceOutput(
  step: TransformStep,
  originNames: ReadonlyMap<string, string>,
  targetNames: ReadonlyMap<string, string>
): void {
  switch (step.kind) {
    case "renameColumn": {
      const target = targetNames.get(step.params.column.id);
      if (target !== undefined && step.params.newName === originNames.get(step.params.column.id))
        step.params.newName = target;
      return;
    }
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
    case "formatDatetime": {
      const target = targetNames.get(step.params.column.id);
      if (target !== undefined && step.params.newColumn === originNames.get(step.params.column.id))
        step.params.newColumn = target;
      return;
    }
    default:
      return;
  }
}

/** Input columns whose names become output names, for steps that have no explicit output prefix. */
function nameDerivingInputs(step: TransformStep): ColumnReference[] {
  if (step.kind === "oneHotEncode") return step.params.columns;
  if (step.kind === "multiLabelBinarize" && step.params.prefix === undefined) return [step.params.column];
  return [];
}

/**
 * Copy a plan onto another input schema. `targets` maps each original input column ID to its column in the new input.
 * References take the target ID and the column's name at their step, outputs that replace a mapped column follow its
 * name, and created output names stay literal. A later reference to an output named after a renamed input is refused,
 * because that output's name changes with the input.
 */
export function translatePlanColumns(
  steps: readonly TransformStep[],
  original: readonly ColumnSchema[],
  targets: ReadonlyMap<string, ColumnReference>
): TransformStep[] | string {
  const originNames = new Map(original.map((column) => [column.id, column.name]));
  const targetNames = new Map([...targets].map(([id, target]) => [id, target.name]));
  const renamedDerivations = new Map<string, string>();
  const translated: TransformStep[] = [];
  for (const step of steps) {
    const copy = structuredClone(step);
    const policy = savedReferencePolicy(copy);
    if (typeof policy === "string") return policy;
    const stepTargets = new Map<string, ColumnReference>();
    for (const { reference } of policy.flatMap((group) => group.references)) {
      for (const [stepId, input] of renamedDerivations) {
        if (reference.id.startsWith(`c:step:${stepId}:`))
          return `A later step uses “${reference.name}”, which is named after the renamed column “${input}”. Copy this plan onto a file that keeps that column name.`;
      }
      const target = targets.get(reference.id);
      if (!target) continue;
      if (reference.name !== originNames.get(reference.id))
        return `The plan refers to “${reference.name}” by a name that does not match its input column.`;
      stepTargets.set(reference.id, { id: target.id, name: targetNames.get(reference.id)! });
    }
    followInPlaceOutput(copy, originNames, targetNames);
    const mapped = remapStepColumnReferences(copy, stepTargets);
    if (typeof mapped === "string") return mapped;
    for (const input of nameDerivingInputs(step)) {
      const name = originNames.get(input.id);
      if (targets.has(input.id) && name !== targetNames.get(input.id)) renamedDerivations.set(step.id, name!);
    }
    if (step.kind === "renameColumn" && copy.kind === "renameColumn" && targets.has(step.params.column.id)) {
      originNames.set(step.params.column.id, step.params.newName);
      targetNames.set(step.params.column.id, copy.params.newName);
    }
    translated.push(mapped);
  }
  return translated;
}
