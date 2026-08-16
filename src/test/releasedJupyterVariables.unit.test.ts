import { describe, expect, it } from "vitest";
import { RELEASED_JUPYTER_VARIABLES_PANDAS } from "./extensionHost/releasedJupyterVariables";

describe("released Jupyter variable showcase", () => {
  it("owns the immutable canonical orders dataframe and insertion columns", () => {
    expect(RELEASED_JUPYTER_VARIABLES_PANDAS).toEqual({
      name: "orders_df",
      type: "DataFrame",
      backend: "pandas",
      firstValue: "2400001",
      insertionInputColumn: "units",
      insertionOutputColumn: "units_plus_10"
    });
    expect(Object.isFrozen(RELEASED_JUPYTER_VARIABLES_PANDAS)).toBe(true);
  });
});
