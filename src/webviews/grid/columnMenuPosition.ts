export interface ColumnMenuBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ColumnMenuPosition {
  readonly left: number;
  readonly top: number;
  readonly anchorVisible: boolean;
}

/**
 * Places a column menu below the start of its actions button, flipping to the
 * button's end edge or above it only when the menu would leave the viewport.
 * The button counts as visible until it lies entirely outside the visible
 * area; touching an edge still counts. All values are viewport pixels.
 */
export function columnMenuPosition(
  anchor: ColumnMenuBounds,
  menu: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  visibleArea: ColumnMenuBounds
): ColumnMenuPosition {
  const fitsInline = (left: number) => left >= 0 && left + menu.width <= viewport.width;
  const fitsBlock = (top: number) => top >= 0 && top + menu.height <= viewport.height;
  const left =
    [anchor.left, anchor.right - menu.width].find(fitsInline) ?? clamp(anchor.left, 0, viewport.width - menu.width);
  const top =
    [anchor.bottom, anchor.top - menu.height].find(fitsBlock) ?? clamp(anchor.bottom, 0, viewport.height - menu.height);
  const anchorVisible =
    anchor.right >= visibleArea.left &&
    anchor.left <= visibleArea.right &&
    anchor.bottom >= visibleArea.top &&
    anchor.top <= visibleArea.bottom;
  return { left, top, anchorVisible };
}

/**
 * Keeps an open column menu attached to its actions button until the returned
 * cleanup runs. The menu stays open but hidden while the button is scrolled
 * out of the grid.
 */
export function trackColumnMenuPosition(menu: HTMLElement, anchor: HTMLElement): () => void {
  const document = menu.ownerDocument;
  const view = document.defaultView;
  const scroller = anchor.closest<HTMLElement>(".tableScroller");
  const update = () => {
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const menuBounds = menu.getBoundingClientRect();
    const scale = menu.offsetWidth > 0 ? menuBounds.width / menu.offsetWidth : 1;
    const area = scroller?.getBoundingClientRect();
    const position = columnMenuPosition(anchor.getBoundingClientRect(), menuBounds, viewport, {
      left: Math.max(0, area?.left ?? 0),
      top: Math.max(0, area?.top ?? 0),
      right: Math.min(viewport.width, area?.right ?? viewport.width),
      bottom: Math.min(viewport.height, area?.bottom ?? viewport.height)
    });
    // Inline insets are multiplied by the menu's effective CSS zoom.
    menu.style.left = `${position.left / scale}px`;
    menu.style.top = `${position.top / scale}px`;
    menu.style.visibility = position.anchorVisible ? "" : "hidden";
  };
  update();
  document.addEventListener("scroll", update, { capture: true, passive: true });
  view?.addEventListener("resize", update);
  const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
  resizeObserver?.observe(menu);
  if (scroller) resizeObserver?.observe(scroller);
  return () => {
    document.removeEventListener("scroll", update, { capture: true });
    view?.removeEventListener("resize", update);
    resizeObserver?.disconnect();
    for (const property of ["left", "top", "visibility"]) menu.style.removeProperty(property);
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
