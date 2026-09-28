import { describe, expect, it } from "vitest";
import convertTypeContract from "../../fixtures/convert-type-contract.json";
import { CONVERT_TYPE_SOURCES, convertTypeTargets } from "../shared/convertType";

describe("Convert Type contract", () => {
  it("offers exactly the source types every runtime accepts", () => {
    const offered = Object.fromEntries(
      [...CONVERT_TYPE_SOURCES].map(([target, sources]) => [target, [...sources].sort()])
    );
    const shared = Object.fromEntries(
      Object.entries(convertTypeContract.targets).map(([target, sources]) => [target, [...sources].sort()])
    );
    expect(offered).toEqual(shared);
  });

  it("lists targets in menu order and none for columns it can't convert", () => {
    expect(convertTypeTargets("string")).toEqual(["string", "integer", "float", "boolean", "date", "datetime"]);
    expect(convertTypeTargets("decimal")).toEqual(["string", "integer", "float", "boolean"]);
    expect(convertTypeTargets("datetime")).toEqual(["string", "date", "datetime"]);
    expect(convertTypeTargets("duration")).toEqual([]);
  });
});
