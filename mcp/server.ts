#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractDocument } from "../src/lib/extract";
import { callCustomExtractionTool, type CustomExtractionInput } from "../src/lib/claude";
import { parseCustomSchema, validateInstructions, validateTextContent } from "../src/lib/customSchema";
import type { DocKind, Env, ExtractedData } from "../src/types";

const env: Env = {
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  // x402 payment is enforced by the HTTP API's middleware, not by this local MCP transport.
  X402_PAY_TO_ADDRESS: "",
  X402_NETWORK: "",
  X402_PRICE_PER_CALL: "",
  X402_CUSTOM_PRICE_PER_CALL: "",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_base64: { type: "string", description: "Base64-encoded document bytes" },
    mime_type: {
      type: "string",
      enum: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
    },
  },
  required: ["file_base64", "mime_type"],
} as const;

const TOOLS: Record<DocKind, string> = {
  invoice: "Extract structured JSON (vendor, line items, totals, dates) from an invoice PDF or image.",
  receipt: "Extract structured JSON (merchant, items, totals) from a receipt PDF or image.",
  contract: "Extract structured JSON (parties, dates, term, obligations, signatures) from a contract PDF or image.",
  resume: "Extract structured JSON (contact info, work experience, education, skills) from a resume PDF or image.",
};

const CUSTOM_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_base64: { type: "string", description: "Base64-encoded document bytes — send this OR content, not both" },
    mime_type: {
      type: "string",
      enum: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
      description: "Required if file_base64 is given",
    },
    content: { type: "string", description: "Raw text or HTML (e.g. a scraped page), max 100000 chars — send this OR file_base64, not both" },
    schema: { type: "string", description: "JSON Schema string (type: \"object\") describing the fields to extract" },
    instructions: { type: "string", description: "Optional extra guidance for the model" },
  },
  required: ["schema"],
} as const;

const server = new Server(
  { name: "doc-extract", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...Object.entries(TOOLS).map(([kind, description]) => ({
      name: `extract_${kind}`,
      description,
      inputSchema: FILE_INPUT_SCHEMA,
    })),
    {
      name: "extract_custom",
      description: "Extract structured JSON from a PDF or image into a caller-supplied JSON Schema.",
      inputSchema: CUSTOM_INPUT_SCHEMA,
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "extract_custom") {
    const fileBase64 = args?.file_base64 as string | undefined;
    const mimeType = args?.mime_type as string | undefined;
    const rawContent = args?.content as string | undefined;
    const rawSchema = args?.schema as string;
    const rawInstructions = (args?.instructions as string) ?? null;

    if (!rawSchema) {
      throw new Error("schema is required");
    }
    if ((fileBase64 && rawContent) || (!fileBase64 && !rawContent)) {
      throw new Error("Provide exactly one of file_base64 (with mime_type) or content");
    }

    const schemaResult = parseCustomSchema(rawSchema);
    if ("error" in schemaResult) {
      throw new Error(schemaResult.error);
    }
    const instructionsResult = validateInstructions(rawInstructions);
    if ("error" in instructionsResult) {
      throw new Error(instructionsResult.error);
    }

    let extractionInput: CustomExtractionInput;
    if (fileBase64) {
      if (!mimeType) {
        throw new Error("mime_type is required when file_base64 is given");
      }
      extractionInput = { type: "document", document: { base64: fileBase64, mediaType: mimeType } };
    } else {
      const contentResult = validateTextContent(rawContent as string);
      if ("error" in contentResult) {
        throw new Error(contentResult.error);
      }
      extractionInput = { type: "text", text: contentResult.content };
    }

    const data = await callCustomExtractionTool(env, extractionInput, schemaResult.schema, instructionsResult.instructions);

    return {
      content: [{ type: "text", text: JSON.stringify({ data, validation_warnings: [], retried: false }, null, 2) }],
    };
  }

  const kind = name.replace(/^extract_/, "") as DocKind;
  if (!(kind in TOOLS)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const fileBase64 = args?.file_base64 as string;
  const mimeType = args?.mime_type as string;

  if (!fileBase64 || !mimeType) {
    throw new Error("file_base64 and mime_type are required");
  }

  const result = await extractDocument<ExtractedData>(env, kind, {
    base64: fileBase64,
    mediaType: mimeType,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            data: result.data,
            validation_warnings: result.validation_warnings,
            retried: result.retried,
          },
          null,
          2
        ),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
