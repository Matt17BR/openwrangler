import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

export const DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT = "__OW_DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION__";
export const DATA_WRANGLER_COEXISTENCE_VARIABLE = "coexist_frame";

export interface DataWranglerCoexistenceKernelTarget {
  readonly label: string;
  readonly name: string;
}

export function dataWranglerCoexistenceNotebookFixture(
  target: DataWranglerCoexistenceKernelTarget,
  ownershipSentinel: string
) {
  const cell = (source: readonly string[]) => ({
    cell_type: "code" as const,
    execution_count: null,
    metadata: {},
    outputs: [],
    source: source.map((line) => `${line}\n`)
  });
  return {
    cells: [
      cell([
        "import json",
        "import os",
        "import sys",
        "import pandas as pd",
        `${DATA_WRANGLER_COEXISTENCE_VARIABLE} = pd.DataFrame({`,
        "    'order_id': [2400001, 2400002, 2400003, 2400004],",
        `    'market': [${JSON.stringify(ownershipSentinel)}, 'Nordics', 'Iberia', 'France'],`,
        "    'revenue': [620.50, 1840.75, 991.00, 2420.25],",
        "})",
        `print(${JSON.stringify(DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT)} + json.dumps({`,
        "    'executable': sys.executable,",
        "    'pid': os.getpid(),",
        "}, sort_keys=True))",
        DATA_WRANGLER_COEXISTENCE_VARIABLE
      ])
    ],
    metadata: {
      kernelspec: {
        display_name: target.label,
        language: "python" as const,
        name: target.name
      },
      language_info: { name: "python" as const }
    },
    nbformat: 4 as const,
    nbformat_minor: 5 as const
  };
}

export function writeDataWranglerCoexistenceNotebook(
  notebookPath: string,
  target: DataWranglerCoexistenceKernelTarget
): string {
  const ownershipSentinel = `__OW_${randomBytes(16).toString("hex")}__`;
  writeFileSync(notebookPath, JSON.stringify(dataWranglerCoexistenceNotebookFixture(target, ownershipSentinel)));
  return ownershipSentinel;
}
