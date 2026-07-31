export const MAX_VIEW_VALUE_TEXT_CHARACTERS = 65_536;
export const MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS = MAX_VIEW_VALUE_TEXT_CHARACTERS * 2;

export function hasAtMostViewValueTextCodePoints(value: string): boolean {
  if (value.length <= MAX_VIEW_VALUE_TEXT_CHARACTERS) return true;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) index += 1;
    }
    count += 1;
    if (count > MAX_VIEW_VALUE_TEXT_CHARACTERS) return false;
  }
  return true;
}

export function truncateViewValueTextToCodePoints(value: string): string {
  if (value.length <= MAX_VIEW_VALUE_TEXT_CHARACTERS) return value;
  let count = 0;
  let codeUnitEnd = 0;
  while (codeUnitEnd < value.length && count < MAX_VIEW_VALUE_TEXT_CHARACTERS) {
    const codeUnit = value.charCodeAt(codeUnitEnd);
    codeUnitEnd += 1;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(codeUnitEnd);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) codeUnitEnd += 1;
    }
    count += 1;
  }
  return codeUnitEnd === value.length ? value : value.slice(0, codeUnitEnd);
}
