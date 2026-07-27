const INLINE_SCRIPT_ESCAPES = new Map([
  ["<", "\\u003c"],
  [">", "\\u003e"],
  ["&", "\\u0026"],
  ["\u2028", "\\u2028"],
  ["\u2029", "\\u2029"]
]);

export function stringifyForInlineScript(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return json.replace(/[<>&\u2028\u2029]/gu, (character) => INLINE_SCRIPT_ESCAPES.get(character));
}
