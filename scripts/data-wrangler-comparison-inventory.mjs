import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";

export const DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS = Object.freeze([
  Object.freeze({ extensionId: "ms-python.debugpy", version: "2026.6.0" }),
  Object.freeze({ extensionId: "ms-python.python", version: "2026.4.0" }),
  Object.freeze({ extensionId: "ms-python.vscode-pylance", version: "2026.3.1" }),
  Object.freeze({ extensionId: "ms-python.vscode-python-envs", version: "1.36.0" }),
  Object.freeze({ extensionId: "ms-toolsai.jupyter", version: "2025.9.1" }),
  Object.freeze({ extensionId: "ms-toolsai.jupyter-keymap", version: "1.1.2" }),
  Object.freeze({ extensionId: "ms-toolsai.jupyter-renderers", version: "1.3.0" }),
  Object.freeze({ extensionId: "ms-toolsai.vscode-jupyter-cell-tags", version: "0.1.9" }),
  Object.freeze({ extensionId: "ms-toolsai.vscode-jupyter-slideshow", version: "0.1.6" })
]);

function clone(entries) {
  return entries.map((entry) => ({ ...entry }));
}

export function createDataWranglerComparisonTemplateInventory(productExtension) {
  return Object.freeze([...clone(DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS), { ...productExtension }]);
}

export function createDataWranglerComparisonMeasuredInventory(productExtension) {
  return Object.freeze([
    ...clone(DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS),
    { ...productExtension },
    { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }
  ]);
}

export function createDataWranglerComparisonControlInventory() {
  return Object.freeze([
    ...clone(DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS),
    { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }
  ]);
}
