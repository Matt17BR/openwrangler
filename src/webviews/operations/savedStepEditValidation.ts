import type { ColumnSchema, ColumnType, TransformStep } from "../../shared/protocol";
import {
  byExampleProgramReferences,
  savedReferencePolicy,
  unknownOperationPolicy,
  type SavedReferenceCheck
} from "../../shared/transformStepReferences";
import { createPredicate } from "../../shared/filterModel";
import { isTransformStep } from "../../shared/protocolValidation";
import {
  directionalOrderColumnsForTarget,
  explicitFillValueKind,
  fallbackColumnsForTarget,
  fillModeForReplacement,
  fillModesForColumn,
  fillTargetColumns,
  fillValueKindForColumn,
  groupedKeyColumnsForTarget,
  interpolationCoordinateColumnsForTarget
} from "./fillMissingModel";
import {
  aggregationColumnTypes,
  isAggregationOperation,
  operationColumnTypes,
  pivotLongerColumnTypes,
  textColumnTypes
} from "./operationFieldCompatibility";
import { portableRegexContract, validatePortableRegexOutputName } from "../../shared/portableRegex";
import { portablePivotLongerNameKey, validatePivotLongerOutputName } from "../../shared/pivotLonger";
import { pivotWiderKeyValue, portablePivotWiderNameKey, validatePivotWiderOutputName } from "../../shared/pivotWider";

const recovery = "Cancel editing, then reload the session or undo and recreate this step.";

function incompatibleReferenceType(
  checks: readonly SavedReferenceCheck[],
  columnsById: ReadonlyMap<string, ColumnSchema>,
  allowedTypes: ReadonlySet<ColumnType>,
  requirement: string
): string | undefined {
  for (const check of checks) {
    const column = columnsById.get(check.reference.id);
    if (column && !allowedTypes.has(column.type)) {
      return `The saved ${check.label} uses a recorded ${column.type} column, but ${requirement}.`;
    }
  }
  return undefined;
}

function fillCompatibilityError(
  step: Extract<TransformStep, { kind: "fillMissingValues" }>,
  inputSchema: readonly ColumnSchema[],
  columnsById: ReadonlyMap<string, ColumnSchema>
): string | undefined {
  const target = columnsById.get(step.params.column.id);
  if (!target) return "The saved fill target is absent from the recorded input schema.";
  if (!fillTargetColumns(inputSchema).some((column) => column.id === target.id)) {
    return `The saved fill target uses a recorded ${target.type} column that does not support filling.`;
  }

  const replacement = step.params.replacement;
  if (replacement.kind === "linearInterpolation" && target.type !== "float") {
    return "The saved interpolation target is not a floating-point column.";
  }
  const mode = fillModeForReplacement(replacement);
  if (!mode || !fillModesForColumn(target, inputSchema).includes(mode)) {
    return `The saved ${replacement.kind} fill method is not compatible with the recorded ${target.type} target.`;
  }
  if (replacement.kind === "fallbackColumns") {
    const compatibleIds = new Set(fallbackColumnsForTarget(target, inputSchema).map((column) => column.id));
    const incompatible = replacement.columns.find((reference) => !compatibleIds.has(reference.id));
    if (incompatible) {
      return `The saved fallback column “${incompatible.name}” is not compatible with the recorded ${target.type} target.`;
    }
  }
  if (replacement.kind === "directional") {
    const compatibleIds = new Set(directionalOrderColumnsForTarget(target, inputSchema).map((column) => column.id));
    const incompatible = replacement.orderBy.find((rule) => !compatibleIds.has(rule.column.id));
    if (incompatible) {
      return `The saved calculation-order column “${incompatible.column.name}” cannot be ordered safely.`;
    }
  }
  if (replacement.kind === "linearInterpolation") {
    const compatibleIds = new Set(
      interpolationCoordinateColumnsForTarget(target, inputSchema).map((column) => column.id)
    );
    if (!compatibleIds.has(replacement.coordinate.id)) {
      return "The saved interpolation coordinate cannot be used safely.";
    }
  }
  if (replacement.kind === "groupedStatistic") {
    const compatibleIds = new Set(groupedKeyColumnsForTarget(target, inputSchema).map((column) => column.id));
    const incompatible = replacement.keys.find((reference) => !compatibleIds.has(reference.id));
    if (incompatible) {
      return `The saved group key “${incompatible.name}” cannot be used for grouped filling.`;
    }
  }

  const explicitKind = explicitFillValueKind(replacement);
  if (explicitKind && target.type !== "unknown" && explicitKind !== fillValueKindForColumn(target.type)) {
    return `The saved ${explicitKind} replacement value is not compatible with the recorded ${target.type} target.`;
  }
  return undefined;
}

function savedOperationTypeError(
  step: TransformStep,
  inputSchema: readonly ColumnSchema[],
  columnsById: ReadonlyMap<string, ColumnSchema>
): string | undefined {
  switch (step.kind) {
    case "conditionalColumn": {
      const original = step.params.predicate;
      if (
        [
          step.params.newColumn,
          step.params.trueValue,
          step.params.falseValue,
          step.params.missingValue,
          original.value,
          original.secondValue
        ].some((value) => typeof value === "string" && /[\r\n]/u.test(value))
      )
        return "This form cannot preserve line breaks in the saved condition, column name or results.";
      const text = (value: unknown) => (typeof value === "string" || typeof value === "boolean" ? String(value) : "");
      const represented = createPredicate(
        original.operator,
        text(original.value),
        text(original.secondValue),
        step.params.columnType
      );
      if (
        (["value", "secondValue"] as const).some(
          (key) =>
            Object.hasOwn(original, key) !== Object.hasOwn(represented, key) ||
            !Object.is(original[key], represented[key])
        )
      )
        return "This form cannot preserve the saved condition operand exactly. Recreate the condition with text or Boolean comparison values.";
      return undefined;
    }
    case "explodeList":
      return incompatibleReferenceType(
        [{ label: "List column", reference: step.params.column }],
        columnsById,
        operationColumnTypes(step.kind),
        "list expansion requires a List column"
      );
    case "extractStructFields":
      return !isTransformStep(step)
        ? "This form cannot preserve the saved field and output names. Use 1 to 64 unique, nonempty single-line names within the UTF-8 limit."
        : incompatibleReferenceType(
            [{ label: "Struct column", reference: step.params.column }],
            columnsById,
            operationColumnTypes(step.kind),
            "field extraction requires a Struct column"
          );
    case "formula":
      return incompatibleReferenceType(
        [
          { label: "left formula column", reference: step.params.leftColumn },
          ...(step.params.rightColumn ? [{ label: "right formula column", reference: step.params.rightColumn }] : [])
        ],
        columnsById,
        operationColumnTypes(step.kind),
        "formula inputs must be numeric"
      );
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
      return incompatibleReferenceType(
        [{ label: "input column", reference: step.params.column }],
        columnsById,
        operationColumnTypes(step.kind),
        "this text operation requires a string column"
      );
    case "denseRank":
    case "minMaxScale":
    case "roundNumber":
    case "floorNumber":
    case "ceilNumber":
      return incompatibleReferenceType(
        [{ label: "input column", reference: step.params.column }],
        columnsById,
        operationColumnTypes(step.kind),
        "this numeric operation requires an integer, float, or decimal column"
      );
    case "formatDatetime":
      return incompatibleReferenceType(
        [{ label: "input column", reference: step.params.column }],
        columnsById,
        operationColumnTypes(step.kind),
        "datetime formatting requires a date or datetime column"
      );
    case "pivotLonger": {
      const selected = step.params.columns.map((reference) => columnsById.get(reference.id));
      if (selected.some((column) => column === undefined)) return undefined;
      const first = selected[0]!;
      if (selected.some((column) => column!.type !== first.type || column!.rawType !== first.rawType)) {
        return "pivot-longer columns must have one exactly compatible scalar type";
      }
      return undefined;
    }
    case "pivotWider": {
      const namesFrom = columnsById.get(step.params.namesFrom.id);
      const valuesFrom = columnsById.get(step.params.valuesFrom.id);
      if (namesFrom && !textColumnTypes.has(namesFrom.type)) {
        return "pivot-wider names-from values must use a text or factor column";
      }
      if (valuesFrom && !pivotLongerColumnTypes.has(valuesFrom.type)) {
        return "pivot-wider values must use a portable scalar column";
      }
      return undefined;
    }
    case "oneHotEncode":
      return incompatibleReferenceType(
        step.params.columns.map((reference, index) => ({ label: `column ${index + 1}`, reference })),
        columnsById,
        operationColumnTypes(step.kind),
        "one-hot encoding requires portable scalar columns"
      );
    case "groupBy": {
      const keyError = incompatibleReferenceType(
        step.params.keys.map((reference, index) => ({ label: `group key ${index + 1}`, reference })),
        columnsById,
        operationColumnTypes(step.kind),
        "group keys must be portable scalar columns"
      );
      if (keyError) return keyError;
      for (const [index, aggregation] of step.params.aggregations.entries()) {
        if (!isAggregationOperation(aggregation.operation)) {
          return `The saved aggregation ${index + 1} uses unsupported operation “${String(aggregation.operation)}”.`;
        }
        const error = incompatibleReferenceType(
          [{ label: `aggregation value ${index + 1}`, reference: aggregation.column }],
          columnsById,
          aggregationColumnTypes(aggregation.operation),
          `the ${aggregation.operation} aggregation does not support that column type`
        );
        if (error) return error;
      }
      return undefined;
    }
    case "byExample":
      return incompatibleReferenceType(
        step.params.sourceColumns.map((reference, index) => ({
          label: `by-example source ${index + 1}`,
          reference
        })),
        columnsById,
        operationColumnTypes(step.kind),
        "by-example sources must be portable scalar columns"
      );
    case "fillMissingValues":
      return fillCompatibilityError(step, inputSchema, columnsById);
    case "castColumn":
      return step.params.inputFormat === undefined
        ? undefined
        : incompatibleReferenceType(
            [{ label: "input date column", reference: step.params.column }],
            columnsById,
            textColumnTypes,
            "an input date format requires a Text column"
          );
    case "sortRows":
    case "filterRows":
    case "dropMissingRows":
    case "dropDuplicates":
    case "markDuplicates":
    case "selectColumns":
    case "dropColumns":
    case "renameColumn":
    case "cloneColumn":
    case "customCode":
      return undefined;
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

  const typeError = savedOperationTypeError(step, inputSchema, columnsById);
  if (typeError) return `${typeError} ${recovery}`;
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
  if (step.kind === "extractRegexGroup") {
    try {
      portableRegexContract(step.params.pattern, step.params.group);
      validatePortableRegexOutputName(step.params.newColumn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `This saved regex-extraction step is not portable: ${message} ${recovery}`;
    }
  }
  if (step.kind === "pivotLonger") {
    const existing = new Set(inputSchema.map((column) => portablePivotLongerNameKey(column.name)));
    try {
      validatePivotLongerOutputName(step.params.labelColumn, "Pivot longer label output name");
      validatePivotLongerOutputName(step.params.valueColumn, "Pivot longer value output name");
      const labelKey = portablePivotLongerNameKey(step.params.labelColumn);
      const valueKey = portablePivotLongerNameKey(step.params.valueColumn);
      if (labelKey === valueKey || existing.has(labelKey) || existing.has(valueKey)) {
        return `This saved pivot-longer step has colliding output names. ${recovery}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `This saved pivot-longer step is not portable: ${message} ${recovery}`;
    }
  }
  if (step.kind === "pivotWider") {
    const removed = new Set([step.params.namesFrom.id, step.params.valuesFrom.id]);
    const existing = new Set(
      inputSchema.filter((column) => !removed.has(column.id)).map((column) => portablePivotWiderNameKey(column.name))
    );
    const keyValues: string[] = [];
    const outputNames: string[] = [];
    try {
      for (const [index, output] of step.params.outputs.entries()) {
        keyValues.push(pivotWiderKeyValue(output.key));
        validatePivotWiderOutputName(output.name, `Pivot wider output ${index + 1} name`);
        outputNames.push(portablePivotWiderNameKey(output.name));
      }
      if (
        step.params.outputs.length < 2 ||
        step.params.outputs.length > 64 ||
        new Set(keyValues).size !== keyValues.length ||
        new Set(outputNames).size !== outputNames.length ||
        outputNames.some((name) => existing.has(name))
      ) {
        return `This saved pivot-wider step has duplicate keys or colliding output names. ${recovery}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `This saved pivot-wider step is not portable: ${message} ${recovery}`;
    }
  }
  return undefined;
}
