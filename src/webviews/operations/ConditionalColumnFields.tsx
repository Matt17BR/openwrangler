import { useId, useState } from "react";
import type { ColumnSchema, ConditionalColumnParams } from "../../shared/protocol";
import { operatorRequiresValue, viewPredicateOperators } from "../../shared/filterModel";
import type { PredicateOperator } from "../../shared/filterModel";
import { predicateLabels } from "../filters/filterPresentation";
import { MAX_VIEW_VALUE_TEXT_CHARACTERS, MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS } from "../../shared/viewValueLimits";
import { ColumnReferenceSelect, Fieldset, TextField } from "./operationFormControls";

export function ConditionalColumnFields({
  columns,
  initial
}: {
  columns: ColumnSchema[];
  initial?: ConditionalColumnParams;
}) {
  const [selection, setSelection] = useState(() =>
    initial
      ? { id: initial.column.id, type: initial.columnType }
      : columns[0] && { id: columns[0].id, type: columns[0].type }
  );
  if (!selection && columns[0]) setSelection({ id: columns[0].id, type: columns[0].type });
  const [operator, setOperator] = useState<PredicateOperator>(
    () =>
      initial?.predicate.operator ??
      (selection && viewPredicateOperators(selection.type).includes("equals") ? "equals" : "isNull")
  );
  const [resultType, setResultType] = useState(initial?.resultType ?? "string");
  const helpId = useId();
  const currentColumn = columns.find((column) => column.id === selection?.id);
  const selected = currentColumn?.type === selection?.type ? currentColumn : undefined;
  const operators = selected ? viewPredicateOperators(selected.type) : [];
  const compatibleOperator = operators.includes(operator);
  const takesValue = compatibleOperator && operatorRequiresValue(operator);
  const between = takesValue && operator === "between";
  const operandRequired = selected?.type !== "string";
  return (
    <>
      <Fieldset legend="Condition">
        <ColumnReferenceSelect
          name="column"
          label="Condition column"
          columns={columns}
          value={selected?.id ?? ""}
          onChange={(id) => {
            const column = columns.find((candidate) => candidate.id === id);
            if (column) setSelection({ id, type: column.type });
          }}
          emptyMessage="No columns are available for a condition."
        />
        <input type="hidden" name="columnType" value={selection?.type ?? ""} />
        {currentColumn && !selected && <p role="status">The condition column type changed. Choose the column again.</p>}
        <label className="formField">
          <span>Operator</span>
          <select
            name="operator"
            aria-label="Operator"
            aria-describedby={helpId}
            required
            value={compatibleOperator ? operator : ""}
            onChange={(event) => {
              const next = operators.find((candidate) => candidate === event.target.value);
              if (next) setOperator(next);
            }}
          >
            {!compatibleOperator && <option value="">Choose an operator</option>}
            {operators.map((choice) => (
              <option key={choice} value={choice}>
                {predicateLabels[choice]}
              </option>
            ))}
          </select>
        </label>
        <div hidden={!takesValue}>
          <TextField
            name="predicateValue"
            label="Comparison value"
            defaultValue={String(initial?.predicate.value ?? "")}
            disabled={!takesValue}
            required={operandRequired}
            maxLength={MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS}
            maxCodePoints={MAX_VIEW_VALUE_TEXT_CHARACTERS}
          />
        </div>
        <div hidden={!between}>
          <TextField
            name="secondPredicateValue"
            label="Upper comparison value"
            defaultValue={String(initial?.predicate.secondValue ?? "")}
            disabled={!between}
            required={operandRequired}
            maxLength={MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS}
            maxCodePoints={MAX_VIEW_VALUE_TEXT_CHARACTERS}
          />
        </div>
        <p id={helpId}>
          {compatibleOperator && !takesValue
            ? "This condition evaluates every row. The missing-input result is not used."
            : "Null and NaN inputs use the missing result. Empty text is a value."}
        </p>
      </Fieldset>
      <Fieldset legend="New column">
        <TextField name="newColumn" label="New column name" defaultValue={initial?.newColumn ?? ""} required />
        <label className="formField">
          <span>Result type</span>
          <select
            name="resultType"
            aria-label="Result type"
            value={resultType}
            onChange={(event) => {
              if (event.target.value === "string" || event.target.value === "boolean")
                setResultType(event.target.value);
            }}
          >
            <option value="string">Text</option>
            <option value="boolean">Boolean</option>
          </select>
        </label>
      </Fieldset>
      <Fieldset legend="Results">
        <ConditionalResult
          name="trueValue"
          label="When condition matches"
          resultType={resultType}
          initial={initial ? initial.trueValue : ""}
        />
        <ConditionalResult
          name="falseValue"
          label="When condition does not match"
          resultType={resultType}
          initial={initial ? initial.falseValue : ""}
        />
        <ConditionalResult
          name="missingValue"
          label="When input is missing"
          resultType={resultType}
          initial={initial ? initial.missingValue : null}
          descriptionId={compatibleOperator && !takesValue ? helpId : undefined}
        />
      </Fieldset>
    </>
  );
}

function ConditionalResult({
  name,
  label,
  resultType,
  initial,
  descriptionId
}: {
  name: string;
  label: string;
  resultType: "string" | "boolean";
  initial: string | boolean | null;
  descriptionId?: string;
}) {
  const [choice, setChoice] = useState(
    initial === null ? "null" : typeof initial === "string" ? "string" : String(initial)
  );
  const errorId = useId();
  const compatible =
    choice === "null" || (resultType === "string" ? choice === "string" : choice === "true" || choice === "false");
  const textActive = resultType === "string" && choice === "string";
  return (
    <div className="compoundRow conditionalResultRow">
      <label className="formField">
        <span>{label}</span>
        <select
          name={`${name}Choice`}
          aria-label={label}
          value={compatible ? choice : ""}
          required
          aria-invalid={!compatible || undefined}
          aria-describedby={!compatible ? errorId : descriptionId}
          onChange={(event) => setChoice(event.target.value)}
        >
          {!compatible && <option value="">Choose a {resultType === "string" ? "text" : "Boolean"} result</option>}
          {resultType === "string" ? (
            <option value="string">Text</option>
          ) : (
            <>
              <option value="true">True</option>
              <option value="false">False</option>
            </>
          )}
          <option value="null">Null</option>
        </select>
      </label>
      {!compatible && (
        <p id={errorId}>Choose a result for the selected output type. The previous value has not been converted.</p>
      )}
      <div hidden={!textActive}>
        <TextField
          name={name}
          label={`${label}: text`}
          defaultValue={typeof initial === "string" ? initial : ""}
          disabled={!textActive}
          maxLength={MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS}
          maxCodePoints={MAX_VIEW_VALUE_TEXT_CHARACTERS}
        />
      </div>
    </div>
  );
}
