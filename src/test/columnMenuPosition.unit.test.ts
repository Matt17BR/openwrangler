import { describe, expect, it } from "vitest";
import { columnMenuPosition } from "../webviews/grid/columnMenuPosition";

const viewport = { width: 1000, height: 700 };
const grid = { left: 0, top: 40, right: 1000, bottom: 700 };
const menu = { width: 170, height: 150 };
const anchorAt = (left: number, top: number) => ({ left, top, right: left + 30, bottom: top + 30 });

describe("column menu position", () => {
  it("opens below the start of its actions button", () => {
    expect(columnMenuPosition(anchorAt(300, 90), menu, viewport, grid)).toEqual({
      left: 300,
      top: 120,
      anchorVisible: true
    });
  });

  it("aligns to the button's end edge near the right edge of the viewport", () => {
    expect(columnMenuPosition(anchorAt(900, 90), menu, viewport, grid)).toMatchObject({ left: 760, top: 120 });
  });

  it("opens above the button when the space below is too short", () => {
    expect(columnMenuPosition(anchorAt(300, 600), menu, viewport, grid)).toMatchObject({ left: 300, top: 450 });
  });

  it("flips on both axes in the bottom-right corner", () => {
    expect(columnMenuPosition(anchorAt(900, 600), menu, viewport, grid)).toMatchObject({ left: 760, top: 450 });
  });

  it("keeps a menu that fits nowhere inside the viewport", () => {
    const tall = { width: 170, height: 400 };
    expect(columnMenuPosition(anchorAt(300, 250), tall, { width: 1000, height: 500 }, grid)).toMatchObject({
      top: 100
    });
    expect(
      columnMenuPosition(anchorAt(100, 90), { width: 260, height: 150 }, { width: 274, height: 700 }, grid)
    ).toMatchObject({ left: 14 });
  });

  it("reports the button as hidden only once it lies entirely outside the grid's visible area", () => {
    expect(columnMenuPosition(anchorAt(-30, 90), menu, viewport, grid).anchorVisible).toBe(true);
    expect(columnMenuPosition(anchorAt(-31, 90), menu, viewport, grid).anchorVisible).toBe(false);
    expect(columnMenuPosition(anchorAt(1000, 90), menu, viewport, grid).anchorVisible).toBe(true);
    expect(columnMenuPosition(anchorAt(1001, 90), menu, viewport, grid).anchorVisible).toBe(false);
    expect(columnMenuPosition(anchorAt(300, 10), menu, viewport, grid).anchorVisible).toBe(true);
    expect(columnMenuPosition(anchorAt(300, 9), menu, viewport, grid).anchorVisible).toBe(false);
  });

  it("keeps the menu of an unmeasured button visible", () => {
    const unmeasured = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(columnMenuPosition(unmeasured, menu, viewport, unmeasured).anchorVisible).toBe(true);
  });
});
