const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 128;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;

export class DuplicateJsonKeyError extends SyntaxError {
  constructor() {
    super("JSON objects must not contain duplicate keys.");
    this.name = "DuplicateJsonKeyError";
  }
}

class StrictJsonScanner {
  constructor(contents, maxDepth) {
    this.contents = contents;
    this.maxDepth = maxDepth;
    this.index = 0;
  }

  scan() {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.index !== this.contents.length) {
      throw new SyntaxError("Unexpected trailing JSON content.");
    }
  }

  skipWhitespace() {
    while (this.index < this.contents.length && /[\t\n\r ]/u.test(this.contents[this.index] ?? "")) {
      this.index += 1;
    }
  }

  scanValue(depth) {
    if (depth > this.maxDepth) {
      throw new SyntaxError("JSON nesting exceeds the supported depth.");
    }
    const current = this.contents[this.index];
    if (current === "{") {
      this.scanObject(depth);
      return;
    }
    if (current === "[") {
      this.scanArray(depth);
      return;
    }
    if (current === '"') {
      this.scanString();
      return;
    }
    if (current === "t") {
      this.scanLiteral("true");
      return;
    }
    if (current === "f") {
      this.scanLiteral("false");
      return;
    }
    if (current === "n") {
      this.scanLiteral("null");
      return;
    }
    this.scanNumber();
  }

  scanObject(depth) {
    this.index += 1;
    this.skipWhitespace();
    if (this.contents[this.index] === "}") {
      this.index += 1;
      return;
    }

    const keys = new Set();
    while (this.index < this.contents.length) {
      if (this.contents[this.index] !== '"') {
        throw new SyntaxError("JSON object keys must be strings.");
      }
      const key = this.scanString();
      if (keys.has(key)) {
        throw new DuplicateJsonKeyError();
      }
      keys.add(key);

      this.skipWhitespace();
      if (this.contents[this.index] !== ":") {
        throw new SyntaxError("JSON object keys must be followed by a colon.");
      }
      this.index += 1;
      this.skipWhitespace();
      this.scanValue(depth + 1);
      this.skipWhitespace();

      const delimiter = this.contents[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return;
      }
      if (delimiter !== ",") {
        throw new SyntaxError("JSON object entries must be separated by commas.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw new SyntaxError("Unterminated JSON object.");
  }

  scanArray(depth) {
    this.index += 1;
    this.skipWhitespace();
    if (this.contents[this.index] === "]") {
      this.index += 1;
      return;
    }

    while (this.index < this.contents.length) {
      this.scanValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.contents[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return;
      }
      if (delimiter !== ",") {
        throw new SyntaxError("JSON array entries must be separated by commas.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
    throw new SyntaxError("Unterminated JSON array.");
  }

  scanString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.contents.length) {
      const current = this.contents[this.index];
      if (current === '"') {
        this.index += 1;
        return JSON.parse(this.contents.slice(start, this.index));
      }
      if (current === "\\") {
        this.index += 2;
      } else {
        this.index += 1;
      }
    }
    throw new SyntaxError("Unterminated JSON string.");
  }

  scanLiteral(literal) {
    if (this.contents.slice(this.index, this.index + literal.length) !== literal) {
      throw new SyntaxError("Invalid JSON literal.");
    }
    this.index += literal.length;
  }

  scanNumber() {
    JSON_NUMBER.lastIndex = this.index;
    const match = JSON_NUMBER.exec(this.contents);
    if (match === null) {
      throw new SyntaxError("Invalid JSON value.");
    }
    this.index = JSON_NUMBER.lastIndex;
  }
}

export function parseStrictJson(contents, { maxBytes = DEFAULT_MAX_BYTES, maxDepth = DEFAULT_MAX_DEPTH } = {}) {
  if (typeof contents !== "string") {
    throw new TypeError("JSON input must be a string.");
  }
  if (Buffer.byteLength(contents, "utf8") > maxBytes) {
    throw new SyntaxError("JSON input exceeds the supported size.");
  }

  new StrictJsonScanner(contents, maxDepth).scan();
  return JSON.parse(contents);
}
