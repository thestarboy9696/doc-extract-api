import type { Context } from "hono";
import { extractDocument } from "../lib/extract";
import type { DocKind, Env, ExtractedData } from "../types";

const ALLOWED_MIME = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 15 * 1024 * 1024; // 15MB

export async function handleExtract(c: Context<{ Bindings: Env }>, kind: DocKind) {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return c.json({ error: "Send the document as multipart/form-data with a 'file' field" }, 400);
  }

  const form = await c.req.formData();
  const entry = form.get("file");
  if (!entry || typeof entry === "string") {
    return c.json({ error: "Missing 'file' field" }, 400);
  }
  const file = entry as File;
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: `Unsupported file type '${file.type}'. Allowed: pdf, png, jpeg, webp` }, 400);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: "File exceeds 15MB limit" }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const base64 = btoa(String.fromCharCode(...bytes));

  let result;
  try {
    result = await extractDocument<ExtractedData & any>(c.env, kind, {
      base64,
      mediaType: file.type,
    });
  } catch (err) {
    console.error(`extraction failed for ${kind}`, err);
    return c.json({ error: "Extraction failed. Please retry." }, 502);
  }

  const body = {
    data: result.data,
    validation_warnings: result.validation_warnings,
    retried: result.retried,
  };

  // A hard failure (real arithmetic/format inconsistency, not just a low-confidence flag) still
  // survived one corrective retry — the extraction is genuinely wrong, not just uncertain. Return
  // it anyway so the caller can see what happened, but at a non-2xx status: @x402/hono only
  // settles payment on a non-error response, so this specific call is free. Low-confidence-only
  // warnings don't hit this path — those settle normally, since low confidence on a legitimately
  // hard-to-read document isn't evidence the extraction is actually wrong.
  if (result.hardFailure) {
    return c.json(body, 422);
  }

  return c.json(body);
}
