#!/usr/bin/env node
// This MCP server is a thin client for the paid SchemaLock API — every tool call is a real x402
// (USDC on Base) payment against the same live endpoints agents pay via HTTP. There is no free
// extraction path: earlier versions ran extraction locally with the operator's own
// ANTHROPIC_API_KEY at no cost per call; this version requires the caller's own funded wallet and
// pays for every call, so MCP distribution (npm, the official MCP Registry) is a discovery
// surface, not a way to use the service for free.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import type { DocKind } from "../src/types";

const API_BASE = "https://doc-extract-api.thestarboy9696-4ef.workers.dev";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const rawKey = requireEnv("WALLET_PRIVATE_KEY").trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
  throw new Error(
    "WALLET_PRIVATE_KEY doesn't look like a valid private key (expected 0x + 64 hex chars). " +
      "This must be a wallet funded with real USDC on Base — every tool call spends from it."
  );
}

const account = privateKeyToAccount(rawKey as `0x${string}`);
const publicClient = createPublicClient({ chain: base, transport: viemHttp() });
const signer = toClientEvmSigner(account, publicClient);
const x402 = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

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
  invoice: "Extract structured JSON (vendor, line items, totals, dates) from an invoice PDF or image. $0.05 in USDC on Base, paid from WALLET_PRIVATE_KEY on every call.",
  receipt: "Extract structured JSON (merchant, items, totals) from a receipt PDF or image. $0.05 in USDC on Base, paid from WALLET_PRIVATE_KEY on every call.",
  contract: "Extract structured JSON (parties, dates, term, obligations, signatures) from a contract PDF or image. $0.05 in USDC on Base, paid from WALLET_PRIVATE_KEY on every call.",
  resume: "Extract structured JSON (contact info, work experience, education, skills) from a resume PDF or image. $0.05 in USDC on Base, paid from WALLET_PRIVATE_KEY on every call.",
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
  { name: "doc-extract", version: "0.2.0" },
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
      description:
        "Extract structured JSON from a PDF/image or raw text/HTML into a caller-supplied JSON Schema. " +
        "$0.08 in USDC on Base, paid from WALLET_PRIVATE_KEY on every call.",
      inputSchema: CUSTOM_INPUT_SCHEMA,
    },
  ],
}));

async function base64ToBlob(base64: string, mimeType: string): Promise<Blob> {
  const bytes = Buffer.from(base64, "base64");
  return new Blob([bytes], { type: mimeType });
}

async function callPaidEndpoint(path: string, form: FormData) {
  const response = await fetchWithPayment(`${API_BASE}${path}`, { method: "POST", body: form });
  const rawText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }
  if (!response.ok) {
    throw new Error(
      `Paid request to ${path} failed (HTTP ${response.status}): ${typeof body === "string" ? body : JSON.stringify(body)}`
    );
  }
  return body;
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "extract_custom") {
    const fileBase64 = args?.file_base64 as string | undefined;
    const mimeType = args?.mime_type as string | undefined;
    const rawContent = args?.content as string | undefined;
    const rawSchema = args?.schema as string;
    const rawInstructions = args?.instructions as string | undefined;

    if (!rawSchema) {
      throw new Error("schema is required");
    }
    if ((fileBase64 && rawContent) || (!fileBase64 && !rawContent)) {
      throw new Error("Provide exactly one of file_base64 (with mime_type) or content");
    }

    const form = new FormData();
    form.append("schema", rawSchema);
    if (rawInstructions) form.append("instructions", rawInstructions);
    if (fileBase64) {
      if (!mimeType) throw new Error("mime_type is required when file_base64 is given");
      form.append("file", await base64ToBlob(fileBase64, mimeType), "document");
    } else {
      form.append("content", rawContent as string);
    }

    const data = await callPaidEndpoint("/extract/custom", form);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

  const form = new FormData();
  form.append("file", await base64ToBlob(fileBase64, mimeType), "document");
  const data = await callPaidEndpoint(`/extract/${kind}`, form);

  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
