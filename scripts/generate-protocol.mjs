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
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const operationCatalog = canonicalOperationCatalog(schema);
const prettierConfig = (await prettier.resolveConfig(catalogOutputPath)) ?? {};
const protocolOutput = await compileFromFile(schemaPath, {
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
const catalogOutput = await prettier.format(renderTypeScriptCatalog(operationCatalog), {
  ...prettierConfig,
  parser: "typescript"
});
const pythonCatalogOutput = renderPythonCatalog(operationCatalog);

const outputs = [
  [protocolOutputPath, protocolOutput, "protocol types"],
  [catalogOutputPath, catalogOutput, "operation catalog types"],
  [pythonCatalogOutputPath, pythonCatalogOutput, "Python operation catalog"]
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
  return `/* Generated from protocol/openwrangler.v2.schema.json. Do not edit. */
import type { OperationKind } from "./protocol.generated";

export type OperationGroup = ${groups.map(JSON.stringify).join(" | ")};

export interface OperationCatalogItem {
  readonly kind: OperationKind;
  readonly title: string;
  readonly description: string;
  readonly group: OperationGroup;
  readonly icon: string;
}

export const operationGroups = Object.freeze(${JSON.stringify(groups)}) satisfies readonly OperationGroup[];

export const operationCatalog = Object.freeze(${JSON.stringify(
    catalog.map(({ required: _required, optional: _optional, ...entry }) => entry)
  )}) satisfies readonly OperationCatalogItem[];

export const operationKinds = Object.freeze(operationCatalog.map(({ kind }) => kind)) as readonly OperationKind[];
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

function pythonString(value) {
  return JSON.stringify(value);
}

function pythonTuple(values) {
  if (values.length === 0) return "()";
  const members = values.map(pythonString).join(", ");
  return `(${members}${values.length === 1 ? "," : ""})`;
}
