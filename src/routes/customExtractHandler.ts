import type { Context } from "hono";
import { callCustomExtractionTool, type CustomExtractionInput } from "../lib/claude";
import { parseCustomSchema, validateInstructions, validateTextContent } from "../lib/customSchema";
import type { Env } from "../types";

const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB

export async function handleExtractCustom(c: Context<{ Bindings: Env }>) {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return c.json(
      {
        error:
          "Send as multipart/form-data with 'schema' plus exactly one of 'file' (binary PDF/image) " +
          "or 'content' (raw text/HTML string) — optional 'instructions'",
      },
      400
    );
  }

  const form = await c.req.formData();

  const fileEntry = form.get("file");
  const contentEntry = form.get("content");
  const hasFile = fileEntry != null && typeof fileEntry !== "string";
  const hasContent = typeof contentEntry === "string" && contentEntry.length > 0;

  if (hasFile && hasContent) {
    return c.json({ error: "Send exactly one of 'file' or 'content', not both" }, 400);
  }
  if (!hasFile && !hasContent) {
    return c.json({ error: "Missing input — send either 'file' (binary) or 'content' (raw text/HTML string)" }, 400);
  }

  const schemaEntry = form.get("schema");
  if (!schemaEntry || typeof schemaEntry !== "string") {
    return c.json({ error: "Missing 'schema' field (a JSON Schema string, type: \"object\")" }, 400);
  }
  const schemaResult = parseCustomSchema(schemaEntry);
  if ("error" in schemaResult) {
    return c.json({ error: schemaResult.error }, 400);
  }

  const instructionsEntry = form.get("instructions");
  const instructionsResult = validateInstructions(
    typeof instructionsEntry === "string" ? instructionsEntry : null
  );
  if ("error" in instructionsResult) {
    return c.json({ error: instructionsResult.error }, 400);
  }

  let extractionInput: CustomExtractionInput;
  if (hasFile) {
    const file = fileEntry as File;
    if (!ALLOWED_MIME.has(file.type)) {
      return c.json({ error: `Unsupported file type '${file.type}'. Allowed: pdf, png, jpeg, webp` }, 400);
    }
    if (file.size > MAX_BYTES) {
      return c.json({ error: "File exceeds 15MB limit" }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base64 = btoa(String.fromCharCode(...bytes));
    extractionInput = { type: "document", document: { base64, mediaType: file.type } };
  } else {
    const contentResult = validateTextContent(contentEntry as string);
    if ("error" in contentResult) {
      return c.json({ error: contentResult.error }, 400);
    }
    extractionInput = { type: "text", text: contentResult.content };
  }

  let data: Record<string, unknown>;
  try {
    data = await callCustomExtractionTool(c.env, extractionInput, schemaResult.schema, instructionsResult.instructions);
  } catch (err) {
    console.error("custom extraction failed", err);
    return c.json({ error: "Extraction failed. Check that 'schema' is a valid JSON Schema and retry." }, 502);
  }

  return c.json({ data, validation_warnings: [], retried: false });
}
