import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { defaultImportOptions } from "../extension/files/importOptions";

describe("Excel import defaults", () => {
  it.each(["workbook.xlsx", "legacy.xls", "UPPER.XLS"])("uses the public zero-based sheet index for %s", (name) => {
    expect(defaultImportOptions(vscode.Uri.file(`/tmp/${name}`))).toEqual({ sheet: 0 });
  });
});
