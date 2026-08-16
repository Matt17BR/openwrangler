export function canonicalOperationCatalog(schema) {
  const catalog = schema["x-openwrangler-operationCatalog"];
  const operationKinds = schema.definitions?.OperationKind?.enum;
  const transformSteps = schema.definitions?.TransformStep?.oneOf;
  if (!Array.isArray(catalog) || !Array.isArray(operationKinds) || !Array.isArray(transformSteps)) {
    throw new Error("The protocol schema must define its operation catalog, kinds, and transform-step union.");
  }
  if (catalog.length !== operationKinds.length || transformSteps.length !== operationKinds.length) {
    throw new Error("Operation catalog, OperationKind, and TransformStep must contain the same number of entries.");
  }

  const seenKinds = new Set();
  return catalog.map((entry, index) => {
    if (!isExactOperationCatalogEntry(entry)) {
      throw new Error(`Operation catalog entry ${index} must contain exact non-empty metadata fields.`);
    }
    const expectedKind = operationKinds[index];
    if (entry.kind !== expectedKind) {
      throw new Error(`Operation catalog entry ${index} must match OperationKind ${JSON.stringify(expectedKind)}.`);
    }
    if (seenKinds.has(entry.kind)) throw new Error(`Operation catalog kind ${JSON.stringify(entry.kind)} is repeated.`);
    seenKinds.add(entry.kind);

    const stepName = referenceName(transformSteps[index]?.$ref, `TransformStep entry ${index}`);
    const step = schema.definitions?.[stepName];
    const stepShape = step?.allOf?.find((part) => part?.properties?.kind?.const !== undefined);
    if (stepShape?.properties?.kind?.const !== entry.kind) {
      throw new Error(`${stepName} must bind operation kind ${JSON.stringify(entry.kind)}.`);
    }
    const paramsName = referenceName(stepShape?.properties?.params?.$ref, `${stepName}.params`);
    const params = schema.definitions?.[paramsName];
    if (!params || params.type !== "object" || params.additionalProperties !== false || !params.properties) {
      throw new Error(`${paramsName} must be an exact object schema.`);
    }
    const required = params.required ?? [];
    if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
      throw new Error(`${paramsName}.required must be an array of strings.`);
    }
    if (new Set(required).size !== required.length) {
      throw new Error(`${paramsName}.required must not repeat a parameter.`);
    }
    const parameterNames = Object.keys(params.properties);
    if (!required.every((name) => parameterNames.includes(name))) {
      throw new Error(`${paramsName}.required contains a parameter absent from its properties.`);
    }
    return {
      ...entry,
      required: [...required],
      optional: parameterNames.filter((name) => !required.includes(name))
    };
  });
}

function isExactOperationCatalogEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value).sort();
  const expected = ["description", "group", "icon", "kind", "title"];
  return (
    JSON.stringify(fields) === JSON.stringify(expected) &&
    expected.every((field) => typeof value[field] === "string" && value[field].trim().length > 0)
  );
}

function referenceName(reference, label) {
  if (typeof reference !== "string" || !reference.startsWith("#/definitions/")) {
    throw new Error(`${label} must be a local definition reference.`);
  }
  return reference.slice("#/definitions/".length);
}
