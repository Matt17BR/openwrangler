export const PACKAGED_SCREENSHOT_COLUMNS = ["order_id", "city", "category", "revenue", "units", "order_date"] as const;

export const PACKAGED_SCREENSHOT_ROWS = [
  ["1001", "Milan", "Hardware", "1250.49", "4", "2026-01-08"],
  ["1002", "Rome", "Services", "875.04", "2", "2026-01-10"],
  ["1003", "Berlin", "Software", "1499.62", "5", "2026-01-14"],
  ["1004", "Paris", "Hardware", "640.38", "3", "2026-01-18"],
  ["1005", "Madrid", "Services", "920.76", "4", "2026-01-21"],
  ["1006", "Lisbon", "Software", "1185.31", "6", "2026-01-24"],
  ["1007", "Vienna", "Hardware", "705.84", "2", "2026-02-02"],
  ["1008", "Prague", "Services", "1320.27", "5", "2026-02-06"],
  ["1009", "Dublin", "Software", "980.63", "3", "2026-02-11"],
  ["1010", "Warsaw", "Hardware", "1560.42", "7", "2026-02-15"],
  ["1011", "Athens", "Services", "815.19", "2", "2026-02-20"],
  ["1012", "Oslo", "Software", "1095.73", "4", "2026-02-26"]
] as const;

export function packagedScreenshotFixtureCsv(): string {
  return [PACKAGED_SCREENSHOT_COLUMNS, ...PACKAGED_SCREENSHOT_ROWS].map((row) => row.join(",")).join("\n") + "\n";
}

export function packagedScreenshotFileName(
  editor: string,
  scene: "hero" | "transform",
  theme: "dark" | "light"
): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(editor)) {
    throw new TypeError("Screenshot editor keys must be short lowercase identifiers.");
  }
  return `${editor}-${scene}-${theme}.png`;
}
