// jsdom has popover hiding styles but no native show/hide methods. Keep its
// existing details-owned visibility for component action/focus tests; the
// Chromium header owner verifies native popover visibility and placement.
if (typeof HTMLElement.prototype.showPopover !== "function") {
  for (const method of ["showPopover", "hidePopover"] as const) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value() {}
    });
  }
  const style = document.createElement("style");
  style.textContent = ".columnMenuContent[popover] { display: block !important; }";
  document.head.append(style);
}
