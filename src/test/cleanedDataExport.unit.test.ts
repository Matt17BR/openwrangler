import * as path from "node:path";
import type { Locator, Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { exportCleanedDataThroughWorkbench, type CleanedDataExportTiming } from "./extensionHost/cleanedDataExport";

type LocatorKind =
  | "dialog"
  | "export"
  | "format"
  | "hover"
  | "input"
  | "options"
  | "policy"
  | "policy-dialog"
  | "policy-options"
  | "progress";

interface FakeExportSurfaceOptions {
  readonly formatAvailable?: boolean;
  readonly hoverCount?: number;
  readonly progressCount?: number;
}

class FakeExportSurface {
  readonly events: string[] = [];
  readonly options: string[] = [" CSV ", " Parquet "];
  readonly policyOptions: string[] = [" Preserve index ", " Omit index "];
  readonly formatAvailable: boolean;
  readonly hoverCount: number;
  readonly progressCount: number;
  input = "destination.cleaned.csv";
  selectedFormat: "csv" | "parquet" = "csv";
  selectedPolicy: "preserve" | "omit" = "preserve";

  readonly app = new FakeLocator(this, "export") as unknown as Locator;
  readonly page = {
    keyboard: {
      press: async (key: string) => {
        this.events.push(`keyboard:${key}`);
      }
    },
    mouse: {
      move: async (x: number, y: number) => {
        this.events.push(`mouse:${x},${y}`);
      }
    },
    locator: (selector: string) => this.locator(selector)
  } as unknown as Page;

  constructor({ formatAvailable = true, hoverCount = 0, progressCount = 0 }: FakeExportSurfaceOptions = {}) {
    this.formatAvailable = formatAvailable;
    this.hoverCount = hoverCount;
    this.progressCount = progressCount;
  }

  locator(selector: string): FakeLocator {
    if (selector === ".monaco-hover:visible") return new FakeLocator(this, "hover");
    if (selector === ".quick-input-widget:visible") return new FakeLocator(this, "dialog");
    if (selector.includes("notification-toast:visible")) return new FakeLocator(this, "progress");
    throw new Error(`Unexpected page locator: ${selector}`);
  }
}

class FakeLocator {
  constructor(
    private readonly surface: FakeExportSurface,
    private readonly kind: LocatorKind
  ) {}

  getByRole(role: string, options?: Readonly<{ name?: string; exact?: boolean }>): FakeLocator {
    if (this.kind === "export" && role === "button" && options?.name === "Export" && options.exact === true) {
      return this;
    }
    if (this.kind === "dialog" && role === "option") return new FakeLocator(this.surface, "options");
    if (this.kind === "policy-dialog" && role === "option") {
      return new FakeLocator(this.surface, "policy-options");
    }
    throw new Error(`Unexpected role locator: ${this.kind}:${role}:${JSON.stringify(options)}`);
  }

  filter({ hasText }: Readonly<{ hasText: string | RegExp }>): FakeLocator {
    if (this.kind === "dialog" && hasText === "Export Cleaned Data") return this;
    if (this.kind === "dialog" && hasText === "Export Pandas Index") {
      return new FakeLocator(this.surface, "policy-dialog");
    }
    if (this.kind === "options" && hasText instanceof RegExp) {
      this.surface.selectedFormat = hasText.test("Parquet") ? "parquet" : "csv";
      return new FakeLocator(this.surface, "format");
    }
    if (this.kind === "policy-options" && hasText instanceof RegExp) {
      this.surface.selectedPolicy = hasText.test("Preserve index") ? "preserve" : "omit";
      return new FakeLocator(this.surface, "policy");
    }
    if (this.kind === "progress" && hasText === "Exporting cleaned data…") return this;
    throw new Error(`Unexpected filtered locator: ${this.kind}:${String(hasText)}`);
  }

  last(): FakeLocator {
    return this;
  }

  first(): FakeLocator {
    return this;
  }

  locator(selector: string): FakeLocator {
    if (this.kind === "dialog" && selector === ".quick-input-box input") {
      return new FakeLocator(this.surface, "input");
    }
    throw new Error(`Unexpected nested locator: ${this.kind}:${selector}`);
  }

  async waitFor({ state, timeout }: Readonly<{ state: string; timeout: number }>): Promise<void> {
    this.surface.events.push(`${this.kind}:wait:${state}:${timeout}`);
    if (this.kind === "format" && !this.surface.formatAvailable) throw new Error("format absent");
  }

  async click(): Promise<void> {
    this.surface.events.push(
      this.kind === "policy" ? `policy:${this.surface.selectedPolicy}:click` : `${this.kind}:click`
    );
    if (this.kind === "format") {
      this.surface.input = `destination.cleaned.${this.surface.selectedFormat}`;
    }
  }

  async count(): Promise<number> {
    this.surface.events.push(`${this.kind}:count`);
    if (this.kind === "hover") return this.surface.hoverCount;
    if (this.kind === "progress") return this.surface.progressCount;
    throw new Error(`Unexpected count: ${this.kind}`);
  }

  async inputValue(): Promise<string> {
    this.surface.events.push(`${this.kind}:value`);
    if (this.kind !== "input") throw new Error(`Unexpected input value: ${this.kind}`);
    return this.surface.input;
  }

  async fill(value: string): Promise<void> {
    this.surface.events.push(`${this.kind}:fill:${value}`);
    this.surface.input = value;
  }

  async press(key: string): Promise<void> {
    this.surface.events.push(`${this.kind}:press:${key}`);
  }

  async allInnerTexts(): Promise<string[]> {
    if (this.kind === "options") return this.surface.options;
    if (this.kind === "policy-options") return this.surface.policyOptions;
    throw new Error(`Unexpected option inventory: ${this.kind}`);
  }
}

function immediateTiming(
  observed: Array<Readonly<{ timeoutMs: number; intervalMs: number }>>
): CleanedDataExportTiming {
  return {
    pollCondition: async (probe, options) => {
      observed.push(options);
      return probe();
    }
  };
}

describe("cleaned-data workbench export", () => {
  it.each(["csv", "parquet"] as const)("uses the exact toolbar and %s dialog path", async (format) => {
    const surface = new FakeExportSurface();
    const polls: Array<Readonly<{ timeoutMs: number; intervalMs: number }>> = [];
    const destination = `tmp/result.${format}`;

    await exportCleanedDataThroughWorkbench(surface.app, surface.page, destination, format, immediateTiming(polls));

    expect(surface.events).toEqual([
      "keyboard:Escape",
      "mouse:1,1",
      "hover:count",
      "export:click",
      "dialog:wait:visible:10000",
      "format:wait:visible:10000",
      "format:click",
      "input:value",
      `input:fill:${path.resolve(destination)}`,
      "input:press:Enter",
      "dialog:wait:hidden:30000",
      "progress:count"
    ]);
    expect(polls).toEqual([
      { timeoutMs: 3_000, intervalMs: 50 },
      { timeoutMs: 10_000, intervalMs: 50 },
      { timeoutMs: 30_000, intervalMs: 50 }
    ]);
  });

  it.each(["preserve", "omit"] as const)("selects the explicit Pandas %s-index policy before Save", async (policy) => {
    const surface = new FakeExportSurface();
    const destination = `tmp/result-${policy}.csv`;

    await exportCleanedDataThroughWorkbench(surface.app, surface.page, destination, "csv", {
      ...immediateTiming([]),
      rowAxisPolicy: policy
    });

    expect(surface.events).toEqual([
      "keyboard:Escape",
      "mouse:1,1",
      "hover:count",
      "export:click",
      "dialog:wait:visible:10000",
      "format:wait:visible:10000",
      "format:click",
      "policy-dialog:wait:visible:10000",
      "policy:wait:visible:10000",
      `policy:${policy}:click`,
      "input:value",
      `input:fill:${path.resolve(destination)}`,
      "input:press:Enter",
      "dialog:wait:hidden:30000",
      "progress:count"
    ]);
  });

  it("fails before the toolbar action when a stale hover remains", async () => {
    const surface = new FakeExportSurface({ hoverCount: 1 });

    await expect(
      exportCleanedDataThroughWorkbench(surface.app, surface.page, "tmp/result.csv", "csv", immediateTiming([]))
    ).rejects.toThrow("The workbench must dismiss stale toolbar hovers before the next webview action.");
    expect(surface.events).toEqual(["keyboard:Escape", "mouse:1,1", "hover:count"]);
  });

  it("reports the bounded visible option inventory when the requested format is absent", async () => {
    const surface = new FakeExportSurface({ formatAvailable: false });
    surface.input = "partial query";

    await expect(
      exportCleanedDataThroughWorkbench(surface.app, surface.page, "tmp/result.parquet", "parquet", immediateTiming([]))
    ).rejects.toThrow(
      'The cleaned-data export picker did not offer parquet. Visible options: ["CSV","Parquet"]. Input: "partial query".'
    );
  });

  it("fails closed until the export progress notification is gone", async () => {
    const surface = new FakeExportSurface({ progressCount: 1 });

    await expect(
      exportCleanedDataThroughWorkbench(surface.app, surface.page, "tmp/result.csv", "csv", immediateTiming([]))
    ).rejects.toThrow("The cleaned-data export progress notification must close.");
  });
});
