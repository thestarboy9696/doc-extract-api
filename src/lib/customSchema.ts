// Bounds on a caller-supplied JSON Schema for /extract/custom. The schema is passed straight
// through to Claude as a tool's input_schema, so these limits exist to keep prompt cost bounded
// and reject malformed input *before* calling the model — a 400 here costs the caller nothing
// (the x402 middleware only settles payment on a non-error response).
const MAX_SCHEMA_CHARS = 6000;
const MAX_DEPTH = 4;
const MAX_PROPERTIES_PER_LEVEL = 30;
const MAX_INSTRUCTIONS_CHARS = 1000;
// A reasonable ceiling, not a precise cost model — same philosophy as the 15MB file cap on the
// binary path. ~100k chars is roughly 25k tokens, comfortably inside a single request.
const MAX_CONTENT_CHARS = 100_000;

function depthAndRefCheck(node: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return `schema nesting exceeds max depth of ${MAX_DEPTH}`;
  if (Array.isArray(node)) {
    for (const item of node) {
      const err = depthAndRefCheck(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("$ref" in obj) return "'$ref' is not supported in a custom schema";
    const keys = Object.keys(obj);
    if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
      const propCount = Object.keys(obj.properties as object).length;
      if (propCount > MAX_PROPERTIES_PER_LEVEL) {
        return `too many properties at one level (max ${MAX_PROPERTIES_PER_LEVEL})`;
      }
    }
    for (const key of keys) {
      const err = depthAndRefCheck(obj[key], depth + 1);
      if (err) return err;
    }
  }
  return null;
}

export function parseCustomSchema(raw: string): { schema: Record<string, unknown> } | { error: string } {
  if (!raw || raw.length > MAX_SCHEMA_CHARS) {
    return { error: `'schema' must be present and under ${MAX_SCHEMA_CHARS} characters` };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(raw);
  } catch {
    return { error: "'schema' is not valid JSON" };
  }

  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { error: "'schema' must be a JSON object" };
  }
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") {
    return { error: "'schema'.type must be \"object\"" };
  }
  if (!obj.properties || typeof obj.properties !== "object" || Array.isArray(obj.properties)) {
    return { error: "'schema'.properties must be a non-empty object" };
  }
  if (Object.keys(obj.properties as object).length === 0) {
    return { error: "'schema'.properties must be a non-empty object" };
  }

  const structuralError = depthAndRefCheck(obj, 0);
  if (structuralError) return { error: structuralError };

  return { schema: obj };
}

export function validateInstructions(raw: string | null): { instructions?: string } | { error: string } {
  if (!raw) return {};
  if (raw.length > MAX_INSTRUCTIONS_CHARS) {
    return { error: `'instructions' must be under ${MAX_INSTRUCTIONS_CHARS} characters` };
  }
  return { instructions: raw };
}

export function validateTextContent(raw: string): { error: string } | { content: string } {
  if (!raw.trim()) {
    return { error: "'content' must not be empty" };
  }
  if (raw.length > MAX_CONTENT_CHARS) {
    return { error: `'content' must be under ${MAX_CONTENT_CHARS} characters` };
  }
  return { content: raw };
}
