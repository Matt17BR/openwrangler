export interface ReleasedJupyterPandasShowcase {
  readonly name: "orders_df";
  readonly type: "DataFrame";
  readonly backend: "pandas";
  readonly firstValue: "2400001";
  readonly insertionInputColumn: "units";
  readonly insertionOutputColumn: "units_plus_10";
}

export const RELEASED_JUPYTER_VARIABLES_PANDAS: ReleasedJupyterPandasShowcase = Object.freeze({
  name: "orders_df",
  type: "DataFrame",
  backend: "pandas",
  firstValue: "2400001",
  insertionInputColumn: "units",
  insertionOutputColumn: "units_plus_10"
});
