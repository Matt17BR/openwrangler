export const PUBLIC_MEDIA_PIXEL_RATIO = 2;
export const PUBLIC_MEDIA_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PUBLIC_MEDIA_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export function publicMediaPhysicalLength(logicalLength) {
  if (!Number.isSafeInteger(logicalLength) || logicalLength < 1) {
    throw new TypeError("A public-media logical length must be one positive safe integer.");
  }
  return logicalLength * PUBLIC_MEDIA_PIXEL_RATIO;
}

export function publicMediaPhysicalRect(rect) {
  if (!rect || typeof rect !== "object" || Array.isArray(rect)) {
    throw new TypeError("A public-media crop must be one logical rectangle.");
  }
  const { x, y, width, height } = rect;
  for (const [name, value] of Object.entries({ x, y, width, height })) {
    if (!Number.isSafeInteger(value) || value < (name === "x" || name === "y" ? 0 : 1)) {
      throw new TypeError(`A public-media crop ${name} must be a bounded logical integer.`);
    }
  }
  return {
    x: x * PUBLIC_MEDIA_PIXEL_RATIO,
    y: y * PUBLIC_MEDIA_PIXEL_RATIO,
    width: publicMediaPhysicalLength(width),
    height: publicMediaPhysicalLength(height)
  };
}
