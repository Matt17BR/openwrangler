import { MAX_GENERATED_PYTHON_CODE_UTF8_BYTES } from "./protocolLimits.generated";

export const CODE_PREVIEW_MAX_UTF8_BYTES = MAX_GENERATED_PYTHON_CODE_UTF8_BYTES;
export const CODE_PREVIEW_EDIT_DEBOUNCE_MS = 150;

export function isValidCodePreviewText(value: string, maximumUtf8Bytes = CODE_PREVIEW_MAX_UTF8_BYTES): boolean {
  let utf8Bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      utf8Bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      utf8Bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      utf8Bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else {
      utf8Bytes += 3;
    }
    if (utf8Bytes > maximumUtf8Bytes) return false;
  }
  return true;
}
