import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileFromFile } from "json-schema-to-typescript";
import prettier from "prettier";
import { canonicalOperationCatalog } from "./operation-catalog.mjs";

const root = resolve(import.meta.dirname, "..");
const schemaPath = resolve(root, "protocol", "openwrangler.v2.schema.json");
const protocolOutputPath = resolve(root, "src", "shared", "protocol.generated.ts");
const catalogOutputPath = resolve(root, "src", "shared", "operationCatalog.generated.ts");
const pythonCatalogOutputPath = resolve(root, "python", "openwrangler_runtime", "operation_catalog_generated.py");
const protocolLimitsOutputPath = resolve(root, "src", "shared", "protocolLimits.generated.ts");
const pythonProtocolLimitsOutputPath = resolve(root, "python", "openwrangler_runtime", "protocol_limits_generated.py");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const operationCatalog = canonicalOperationCatalog(schema);
const protocolLimits = canonicalProtocolLimits(schema);
const requestShapes = canonicalTaggedUnionShapes(schema, {
  unionName: "OpenWranglerRequest",
  variantLabel: "Request",
  repeatedClosedObjectBases: new Map([["PageRequest", "SessionRequestBase"]])
});
const responseShapes = canonicalTaggedUnionShapes(schema, {
  unionName: "OpenWranglerResponse",
  variantLabel: "Response"
});
const prettierConfig = (await prettier.resolveConfig(catalogOutputPath)) ?? {};
const protocolTypesOutput = await compileFromFile(schemaPath, {
  bannerComment: "/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */",
  style: {
    bracketSpacing: true,
    printWidth: 120,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "none",
    useTabs: false
  },
  unreachableDefinitions: true
});
const requestShapesOutput = await prettier.format(
  renderTypeScriptTaggedUnionShapes("OpenWranglerRequest", "openWranglerRequestShapes", requestShapes),
  {
    ...prettierConfig,
    parser: "typescript"
  }
);
const responseShapesOutput = await prettier.format(
  renderTypeScriptTaggedUnionShapes("OpenWranglerResponse", "openWranglerResponseShapes", responseShapes),
  {
    ...prettierConfig,
    parser: "typescript"
  }
);
const protocolOutput = `${protocolTypesOutput.trimEnd()}\n\n${requestShapesOutput.trimEnd()}\n\n${responseShapesOutput}`;
const catalogOutput = await prettier.format(renderTypeScriptCatalog(operationCatalog), {
  ...prettierConfig,
  parser: "typescript"
});
const pythonCatalogOutput = renderPythonCatalog(operationCatalog);
const protocolLimitsOutput = renderTypeScriptProtocolLimits(protocolLimits);
const pythonProtocolLimitsOutput = renderPythonProtocolLimits(protocolLimits);

const outputs = [
  [protocolOutputPath, protocolOutput, "protocol types"],
  [catalogOutputPath, catalogOutput, "operation catalog types"],
  [pythonCatalogOutputPath, pythonCatalogOutput, "Python operation catalog"],
  [protocolLimitsOutputPath, protocolLimitsOutput, "protocol limits"],
  [pythonProtocolLimitsOutputPath, pythonProtocolLimitsOutput, "Python protocol limits"]
];

if (process.argv.includes("--check")) {
  const stale = [];
  for (const [outputPath, output, label] of outputs) {
    const existing = await readFile(outputPath, "utf8").catch(() => "");
    if (existing !== output) stale.push(label);
  }
  if (stale.length > 0) {
    throw new Error(`Generated ${stale.join(", ")} stale. Run npm run generate:protocol.`);
  }
} else {
  await Promise.all(outputs.map(([outputPath, output]) => writeFile(outputPath, output, "utf8")));
}

function renderTypeScriptCatalog(catalog) {
  const groups = [...new Set(catalog.map((entry) => entry.group))];
  const definitions = catalog
    .map(
      (entry) => `Object.freeze({
  kind: ${JSON.stringify(entry.kind)},
  title: ${JSON.stringify(entry.title)},
  description: ${JSON.stringify(entry.description)},
  group: ${JSON.stringify(entry.group)},
  icon: ${JSON.stringify(entry.icon)},
  required: Object.freeze(${JSON.stringify(entry.required)}),
  optional: Object.freeze(${JSON.stringify(entry.optional)})
})`
    )
    .join(",");
  return `/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */
import type { OperationKind } from "./protocol.generated";

export type OperationGroup = ${groups.map(JSON.stringify).join(" | ")};

export interface OperationCatalogItem {
  readonly kind: OperationKind;
  readonly title: string;
  readonly description: string;
  readonly group: OperationGroup;
  readonly icon: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export const operationGroups = Object.freeze(${JSON.stringify(groups)}) satisfies readonly OperationGroup[];

export const operationCatalog: readonly OperationCatalogItem[] = Object.freeze([${definitions}]);

export const operationKinds = Object.freeze(operationCatalog.map(({ kind }) => kind)) as readonly OperationKind[];
`;
}

function canonicalTaggedUnionShapes(value, { unionName, variantLabel, repeatedClosedObjectBases = new Map() }) {
  const definitions = value?.definitions;
  const variants = definitions?.[unionName]?.oneOf;
  if (
    definitions === null ||
    typeof definitions !== "object" ||
    Array.isArray(definitions) ||
    !Array.isArray(variants) ||
    variants.length === 0
  ) {
    throw new Error(`Canonical ${variantLabel.toLowerCase()} variants are missing or invalid.`);
  }

  const kinds = new Set();
  const mappedDefinitions = new Set();
  const shapes = variants.map((variant) => {
    const reference = variant?.$ref;
    const definitionName = referencedDefinitionName(variant);
    const definition =
      definitionName !== undefined && Object.prototype.hasOwnProperty.call(definitions, definitionName)
        ? definitions[definitionName]
        : undefined;
    const mappedBase = definitionName === undefined ? undefined : repeatedClosedObjectBases.get(definitionName);
    const closedDefinition =
      mappedBase === undefined
        ? definition
        : repeatedClosedObjectDefinition(definitions, definitionName, definition, mappedBase, variantLabel);
    if (mappedBase !== undefined) mappedDefinitions.add(definitionName);

    const properties = closedDefinition?.properties;
    const required = closedDefinition?.required;
    if (
      closedDefinition === null ||
      typeof closedDefinition !== "object" ||
      Array.isArray(closedDefinition) ||
      closedDefinition.type !== "object" ||
      closedDefinition.additionalProperties !== false ||
      properties === null ||
      typeof properties !== "object" ||
      Array.isArray(properties) ||
      !Array.isArray(required)
    ) {
      throw new Error(
        `${variantLabel} variant ${reference ?? "<unknown>"} is not a supported closed object definition.`
      );
    }

    const propertyKeys = Object.keys(properties);
    const requiredKeys = new Set(required);
    const kindSchema = properties.kind;
    const kind = kindSchema?.const;
    if (
      propertyKeys.length === 0 ||
      propertyKeys.some((key) => key.length === 0) ||
      required.length === 0 ||
      required.some((key) => typeof key !== "string" || key.length === 0 || !propertyKeys.includes(key)) ||
      requiredKeys.size !== required.length ||
      !requiredKeys.has("kind") ||
      kindSchema === null ||
      typeof kindSchema !== "object" ||
      Array.isArray(kindSchema) ||
      Object.keys(kindSchema).length !== 1 ||
      typeof kind !== "string" ||
      kind.length === 0 ||
      kinds.has(kind)
    ) {
      throw new Error(`${variantLabel} variant ${reference} has invalid keys or a non-unique required string kind.`);
    }
    kinds.add(kind);

    return Object.freeze({
      kind,
      required: Object.freeze([...required]),
      optional: Object.freeze(propertyKeys.filter((key) => !requiredKeys.has(key)))
    });
  });
  if ([...repeatedClosedObjectBases.keys()].some((definitionName) => !mappedDefinitions.has(definitionName))) {
    throw new Error(`${variantLabel} repeated closed-object mapping does not match the canonical union.`);
  }
  return Object.freeze(shapes);
}

function referencedDefinitionName(value) {
  const reference = value?.$ref;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof reference !== "string"
  ) {
    return undefined;
  }
  return /^#\/definitions\/([A-Za-z][A-Za-z0-9]*)$/u.exec(reference)?.[1];
}

function repeatedClosedObjectDefinition(definitions, definitionName, definition, baseName, variantLabel) {
  const allOf = definition?.allOf;
  const baseDefinition = definitions[baseName];
  const closedDefinition = Array.isArray(allOf) ? allOf[1] : undefined;
  const baseProperties = baseDefinition?.properties;
  const baseRequired = baseDefinition?.required;
  const closedProperties = closedDefinition?.properties;
  const closedRequired = closedDefinition?.required;
  if (
    definition === null ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    Object.keys(definition).length !== 1 ||
    !Array.isArray(allOf) ||
    allOf.length !== 2 ||
    referencedDefinitionName(allOf[0]) !== baseName ||
    baseDefinition === null ||
    typeof baseDefinition !== "object" ||
    Array.isArray(baseDefinition) ||
    Object.keys(baseDefinition).some((key) => !["type", "required", "properties"].includes(key)) ||
    baseDefinition.type !== "object" ||
    Object.prototype.hasOwnProperty.call(baseDefinition, "additionalProperties") ||
    baseProperties === null ||
    typeof baseProperties !== "object" ||
    Array.isArray(baseProperties) ||
    !Array.isArray(baseRequired) ||
    closedDefinition === null ||
    typeof closedDefinition !== "object" ||
    Array.isArray(closedDefinition) ||
    closedDefinition.type !== "object" ||
    closedDefinition.additionalProperties !== false ||
    closedProperties === null ||
    typeof closedProperties !== "object" ||
    Array.isArray(closedProperties) ||
    !Array.isArray(closedRequired)
  ) {
    throw new Error(`${variantLabel} variant ${definitionName} is not a strict repeated closed-object allOf.`);
  }

  const basePropertyKeys = Object.keys(baseProperties);
  const baseRequiredKeys = new Set(baseRequired);
  const closedRequiredKeys = new Set(closedRequired);
  if (
    basePropertyKeys.length === 0 ||
    basePropertyKeys.some((key) => key.length === 0) ||
    baseRequired.length === 0 ||
    baseRequired.some(
      (key) => typeof key !== "string" || key.length === 0 || !Object.prototype.hasOwnProperty.call(baseProperties, key)
    ) ||
    baseRequiredKeys.size !== baseRequired.length ||
    basePropertyKeys.some(
      (key) =>
        !Object.prototype.hasOwnProperty.call(closedProperties, key) ||
        JSON.stringify(closedProperties[key]) !== JSON.stringify(baseProperties[key])
    ) ||
    baseRequired.some((key) => !closedRequiredKeys.has(key))
  ) {
    throw new Error(`${variantLabel} variant ${definitionName} does not repeat its mapped base exactly.`);
  }
  return closedDefinition;
}

function renderTypeScriptTaggedUnionShapes(typeName, valueName, shapes) {
  const definitions = shapes
    .map(
      (shape) => `Object.freeze({
  kind: ${JSON.stringify(shape.kind)},
  required: Object.freeze(${JSON.stringify(shape.required)}),
  optional: Object.freeze(${JSON.stringify(shape.optional)})
})`
    )
    .join(",");
  return `export interface ${typeName}Shape {
  readonly kind: ${typeName}["kind"];
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export const ${valueName} = Object.freeze([${definitions}]) satisfies readonly ${typeName}Shape[];
`;
}

function renderPythonCatalog(catalog) {
  const definitions = catalog
    .map(
      (entry) => `    OperationDefinition(
        kind=${pythonString(entry.kind)},
        title=${pythonString(entry.title)},
        group=${pythonString(entry.group)},
        required=${pythonTuple(entry.required)},
        optional=${pythonTuple(entry.optional)},
    ),`
    )
    .join("\n");
  return `# Generated from protocol/openwrangler.v2.schema.json. Do not edit.
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OperationDefinition:
    kind: str
    title: str
    group: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()


OPERATION_DEFINITIONS: tuple[OperationDefinition, ...] = (
${definitions}
)
`;
}

function canonicalProtocolLimits(value) {
  const limits = value?.["x-openwrangler-limits"];
  const customCodeMaximum = value?.definitions?.CustomCodeParams?.properties?.code?.["x-openwrangler-utf8MaxBytes"];
  const names = ["pythonCustomCodeUtf8Bytes", "pythonRetainedPlanUtf8Bytes", "pythonGeneratedCodeUtf8Bytes"];
  if (
    limits === null ||
    typeof limits !== "object" ||
    names.some((name) => !Number.isSafeInteger(limits[name]) || limits[name] <= 0) ||
    customCodeMaximum !== limits.pythonCustomCodeUtf8Bytes
  ) {
    throw new Error("Canonical protocol byte limits are missing, invalid, or inconsistent.");
  }
  return Object.freeze({
    customCode: limits.pythonCustomCodeUtf8Bytes,
    retainedPlan: limits.pythonRetainedPlanUtf8Bytes,
    generatedCode: limits.pythonGeneratedCodeUtf8Bytes
  });
}

function renderTypeScriptProtocolLimits(limits) {
  return `/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */
export const MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES = ${limits.customCode};
export const MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES = ${limits.retainedPlan};
export const MAX_GENERATED_PYTHON_CODE_UTF8_BYTES = ${limits.generatedCode};
`;
}

function renderPythonProtocolLimits(limits) {
  return `# Generated from protocol/openwrangler.v2.schema.json. Do not edit.
MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES = ${limits.customCode}
MAX_PYTHON_RETAINED_PLAN_UTF8_BYTES = ${limits.retainedPlan}
MAX_GENERATED_PYTHON_CODE_UTF8_BYTES = ${limits.generatedCode}
`;
}

function pythonString(value) {
  return JSON.stringify(value);
}

function pythonTuple(values) {
  if (values.length === 0) return "()";
  const members = values.map(pythonString).join(", ");
  return `(${members}${values.length === 1 ? "," : ""})`;
}
