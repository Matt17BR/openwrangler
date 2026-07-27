export interface StrictJsonOptions {
  maxBytes?: number;
  maxDepth?: number;
}

export class DuplicateJsonKeyError extends SyntaxError {}

export function parseStrictJson(contents: string, options?: StrictJsonOptions): unknown;
