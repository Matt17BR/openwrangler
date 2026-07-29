import type { ColumnSchema } from "../shared/protocol";

export interface ColumnTypePresentation {
  icon: string;
  label: string;
}

export function columnTypePresentation(column: Pick<ColumnSchema, "rawType" | "type">): ColumnTypePresentation {
  const rawType = column.rawType.toLowerCase();

  if (/(?:category|categorical|enum)/u.test(rawType)) {
    return { icon: "codicon-symbol-enum", label: "Category" };
  }
  if (column.type === "duration" || /(?:duration|timedelta|interval)/u.test(rawType)) {
    return { icon: "codicon-clock", label: "Duration" };
  }
  if (
    column.type === "datetime" &&
    /(?:^|[^a-z])time(?:$|[^a-z])/u.test(rawType) &&
    !/(?:datetime|timestamp)/u.test(rawType)
  ) {
    return { icon: "codicon-clock", label: "Time" };
  }

  switch (column.type) {
    case "string":
      return { icon: "codicon-symbol-string", label: "Text" };
    case "integer":
      return { icon: "codicon-symbol-numeric", label: "Integer" };
    case "float":
      return { icon: "codicon-symbol-numeric", label: "Number" };
    case "decimal":
      return { icon: "codicon-symbol-numeric", label: "Decimal" };
    case "boolean":
      return { icon: "codicon-symbol-boolean", label: "Boolean" };
    case "datetime":
      return { icon: "codicon-calendar", label: "Date and time" };
    case "date":
      return { icon: "codicon-calendar", label: "Date" };
    case "binary":
      return { icon: "codicon-file-binary", label: "Binary" };
    case "list":
      return { icon: "codicon-symbol-array", label: "List" };
    case "struct":
      return { icon: "codicon-symbol-object", label: "Struct" };
    case "unknown":
      return { icon: "codicon-question", label: "Unknown" };
  }
}
