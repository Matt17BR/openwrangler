/** Keep native picker icon syntax out of literal names while leaving ordinary names unchanged. */
export function formatQuickPickName(name: string): string {
  if (
    name.includes("$(") ||
    name.includes('"') ||
    name.includes("\\") ||
    name.trim() !== name ||
    [...name].some((character) => character.charCodeAt(0) < 0x20)
  ) {
    return JSON.stringify(name).replaceAll("$(", "\\u0024(");
  }
  return name;
}
