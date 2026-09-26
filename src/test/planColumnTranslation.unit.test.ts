import { describe, expect, it } from "vitest";
import type { ColumnSchema, TransformStep } from "../shared/protocol";
import { translatePlanColumns } from "../shared/transformStepReferences";

const original: ColumnSchema[] = [
  { id: "c:value", name: "value", position: 0, type: "float", rawType: "Float64", nullable: true },
  { id: "c:label", name: "label", position: 1, type: "string", rawType: "String", nullable: true }
];
const targets = new Map([
  ["c:value", { id: "t:1", name: "price" }],
  ["c:label", { id: "t:0", name: "label" }]
]);

describe("plan column translation", () => {
  it("follows a renamed input through references and in-place outputs while created names stay literal", () => {
    const steps: TransformStep[] = [
      {
        id: "round",
        kind: "roundNumber",
        params: { column: { id: "c:value", name: "value" }, decimals: 1, newColumn: "value" }
      },
      {
        id: "double",
        kind: "formula",
        params: {
          leftColumn: { id: "c:value", name: "value" },
          rightColumn: { id: "c:value", name: "value" },
          operator: "add",
          newColumn: "value_doubled"
        }
      },
      { id: "rename", kind: "renameColumn", params: { column: { id: "c:value", name: "value" }, newName: "amount" } },
      { id: "floor", kind: "floorNumber", params: { column: { id: "c:value", name: "amount" } } },
      { id: "hot", kind: "oneHotEncode", params: { columns: [{ id: "c:label", name: "label" }] } },
      { id: "drop", kind: "dropColumns", params: { columns: [{ id: "c:step:hot:0", name: "label_a" }] } }
    ];
    const saved = structuredClone(steps);

    expect(translatePlanColumns(steps, original, targets)).toEqual([
      {
        id: "round",
        kind: "roundNumber",
        params: { column: { id: "t:1", name: "price" }, decimals: 1, newColumn: "price" }
      },
      {
        id: "double",
        kind: "formula",
        params: {
          leftColumn: { id: "t:1", name: "price" },
          rightColumn: { id: "t:1", name: "price" },
          operator: "add",
          newColumn: "value_doubled"
        }
      },
      { id: "rename", kind: "renameColumn", params: { column: { id: "t:1", name: "price" }, newName: "amount" } },
      { id: "floor", kind: "floorNumber", params: { column: { id: "t:1", name: "amount" } } },
      { id: "hot", kind: "oneHotEncode", params: { columns: [{ id: "t:0", name: "label" }] } },
      steps[5]
    ]);
    expect(steps).toEqual(saved);
  });

  it.each([
    ["one-hot", { kind: "oneHotEncode", params: { columns: [{ id: "c:value", name: "value" }] } }, true],
    [
      "prefixless multi-label",
      { kind: "multiLabelBinarize", params: { column: { id: "c:value", name: "value" }, delimiter: "|" } },
      true
    ],
    [
      "prefixed multi-label",
      {
        kind: "multiLabelBinarize",
        params: { column: { id: "c:value", name: "value" }, delimiter: "|", prefix: "tag_" }
      },
      false
    ]
  ] as const)("handles a later reference to %s outputs of a renamed input", (_name, derive, refused) => {
    const steps = [
      { id: "derive", ...structuredClone(derive) },
      { id: "drop", kind: "dropColumns", params: { columns: [{ id: "c:step:derive:0", name: "value_a" }] } }
    ] as TransformStep[];

    const translated = translatePlanColumns(steps, original, targets);

    if (refused) expect(translated).toContain("named after the renamed column “value”");
    else expect(translated).toMatchObject([{}, steps[1]]);
    expect(translatePlanColumns(steps.slice(0, 1), original, targets)).not.toBeTypeOf("string");
  });

  it("refuses a source reference whose name does not match the column at its step", () => {
    const steps: TransformStep[] = [
      { id: "floor", kind: "floorNumber", params: { column: { id: "c:value", name: "amount" } } }
    ];

    expect(translatePlanColumns(steps, original, targets)).toBe(
      "The plan refers to “amount” by a name that does not match its input column."
    );
  });
});
