import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { handleExtract } from "./routes/extractHandler";
import { handleExtractCustom } from "./routes/customExtractHandler";
import { getFacilitatorClients, toCaip2Network } from "./lib/facilitator";
import {
  invoiceDiscoveryExtension,
  receiptDiscoveryExtension,
  contractDiscoveryExtension,
  resumeDiscoveryExtension,
  customDiscoveryExtension,
  SERVICE_NAME,
  INVOICE_TAGS,
  RECEIPT_TAGS,
  CONTRACT_TAGS,
  RESUME_TAGS,
  CUSTOM_TAGS,
  INVOICE_DESCRIPTION,
  RECEIPT_DESCRIPTION,
  CONTRACT_DESCRIPTION,
  RESUME_DESCRIPTION,
  CUSTOM_DESCRIPTION,
} from "./lib/discovery";
import type { DocKind, Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

const DOC_KINDS: DocKind[] = ["invoice", "receipt", "contract", "resume"];

// Per-route, not shared — see wrangler.toml for why. Reused across the root listing, the
// well-known manifest, llms.txt, and the actual payment middleware, so there's exactly one place
// that maps a kind to its env var.
function priceFor(env: Env, kind: DocKind): string {
  const map: Record<DocKind, string> = {
    invoice: env.X402_INVOICE_PRICE,
    receipt: env.X402_RECEIPT_PRICE,
    contract: env.X402_CONTRACT_PRICE,
    resume: env.X402_RESUME_PRICE,
  };
  return map[kind];
}

app.get("/", (c) =>
  c.json({
    status: "ok",
    description: "Document-to-structured-JSON extraction for AI agents. Pay per call via x402 (USDC). Listed on the x402 Bazaar.",
    endpoints: {
      ...Object.fromEntries(DOC_KINDS.map((kind) => [`POST /extract/${kind}`, `${priceFor(c.env, kind)} per call`])),
      "POST /extract/custom": `${c.env.X402_CUSTOM_PRICE} per call (caller-supplied JSON Schema)`,
    },
    payment: "x402",
    network: c.env.X402_NETWORK,
  })
);

// A discovery surface that doesn't depend on any one facilitator's catalog: an agent (or an
// aggregator, or another LLM doing a live fetch of this domain) that checks the x402 protocol's
// own well-known convention finds this regardless of whether it's been crawled into CDP's, or any
// other facilitator's, Bazaar-equivalent index yet.
app.get("/.well-known/x402", (c) => {
  const base = new URL(c.req.url).origin;
  const priceList = DOC_KINDS.map((kind) => `${kind} ${priceFor(c.env, kind)}`).join(", ");
  return c.json({
    version: 1,
    resources: [...DOC_KINDS.map((kind) => `${base}/extract/${kind}`), `${base}/extract/custom`],
    ownershipProofs: [c.env.X402_PAY_TO_ADDRESS],
    wellKnown: `${base}/.well-known/x402`,
    llmsTxt: `${base}/llms.txt`,
    mcp: "doc-extract-api-mcp (npm: doc-extract-api; also on the official MCP Registry, io.github.thestarboy9696/doc-extract-api) — a paid client for these same endpoints, not a free alternative",
    instructions: `POST multipart/form-data to any resource above. Fixed types (invoice/receipt/contract/resume) take a 'file' field (PDF/PNG/JPEG/WEBP, max 15MB) — per-route price: ${priceList}. /extract/custom additionally needs a 'schema' field (JSON Schema string) and takes 'file' OR 'content' (raw text/HTML, max 100000 chars) at ${c.env.X402_CUSTOM_PRICE}/call. Unauthenticated requests get a 402 with the full payment manifest per resource. A document that fails validation after one automatic retry returns 422, not 200 — x402 settlement is skipped for that call, not just flagged in the response body.`,
  });
});

// Same information as the root endpoint and the well-known manifest, but as plain text aimed
// specifically at an LLM doing a generic read of this domain rather than a structured discovery
// query — the emerging llms.txt convention other x402 services in this ecosystem already publish.
app.get("/llms.txt", (c) => {
  const base = new URL(c.req.url).origin;
  const lines = [
    "# SchemaLock",
    "",
    "Document-to-structured-JSON extraction for AI agents. No signup, no API key. Pay per call",
    "via x402 (USDC on Base) directly over HTTP.",
    "",
    "## Endpoints",
    "",
    ...DOC_KINDS.map(
      (kind) =>
        `- POST ${base}/extract/${kind} — ${priceFor(c.env, kind)}/call. multipart/form-data, field 'file' (PDF/PNG/JPEG/WEBP, max 15MB).`
    ),
    `- POST ${base}/extract/custom — ${c.env.X402_CUSTOM_PRICE}/call. multipart/form-data, field 'schema' (a JSON Schema string) plus exactly one of 'file' (as above) or 'content' (raw text/HTML, max 100000 chars). Optional 'instructions' field.`,
    "",
    "## How payment works",
    "",
    "Send the request with no payment first. The response is 402 with a PAYMENT-REQUIRED header",
    "carrying the full manifest (price, network, asset, receiving address). Sign a USDC transfer",
    "authorization and retry with an X-PAYMENT header — any x402-aware HTTP client (e.g. @x402/fetch)",
    "does this automatically. No account, no API key.",
    "",
    "## The guarantee that's actually enforced, not just claimed",
    "",
    "Extractions are checked against their own source math (line items vs. subtotal vs. total,",
    "dates, currency/email format). If a document still fails one of those checks after one",
    "automatic corrective retry, the response is HTTP 422, not 200 — x402 only settles payment on",
    "a non-error response, so that specific call is free. Low-confidence flags alone (the model",
    "being unsure on a genuinely hard-to-read source) don't trigger this — only a real",
    "arithmetic/format failure does.",
    "",
    "## Also available as an MCP client",
    "",
    "`npx doc-extract-api-mcp` (npm: doc-extract-api; official MCP Registry:",
    "io.github.thestarboy9696/doc-extract-api). This is a thin client for the same paid API above —",
    "every tool call is a real x402 payment from a wallet you supply via WALLET_PRIVATE_KEY. There",
    "is no free extraction path anywhere this service is exposed.",
    "",
    "## Links",
    "",
    `- Source: https://github.com/thestarboy9696/doc-extract-api`,
    `- Well-known manifest: ${base}/.well-known/x402`,
  ];
  return c.text(lines.join("\n"));
});

// Cloudflare Workers only expose env bindings inside a request handler, not at module load
// time, so this middleware can't be built once up front the normal way. But it MUST still only
// be built once per isolate, not once per request: @x402/hono's paymentMiddlewareFromConfig
// defaults to syncFacilitatorOnStart=true, which calls initialize() — fetching /supported from
// every registered facilitator, sequentially — the first time its *returned middleware function*
// runs, then caches that in a closure (`isInitialized`). Rebuilding the middleware fresh on every
// request throws that closure away every time, so initialize() (and its network calls to every
// facilitator, including any unhealthy ones) reran on every single request — this is what broke
// multi-facilitator support previously: an unhealthy extra facilitator added its full timeout to
// every request, including bare unauthenticated 402s, easily exceeding Workers' execution limits.
// Confirmed by direct local reproduction (scripts/test-multi-facilitator-latency.mjs) — the fix is
// exactly this: cache the built middleware in a module-level variable so only the isolate's first
// request pays the initialize() cost, and reuse it for every request after that.
let cachedMiddleware: ReturnType<typeof paymentMiddlewareFromConfig> | null = null;

app.use("/extract/*", async (c, next) => {
  if (!cachedMiddleware) {
    const network = toCaip2Network(c.env.X402_NETWORK);
    const payTo = c.env.X402_PAY_TO_ADDRESS;
    const acceptsFor = (price: string) => ({ scheme: "exact" as const, price, network, payTo });

    cachedMiddleware = paymentMiddlewareFromConfig(
      {
        "/extract/custom": {
          accepts: acceptsFor(c.env.X402_CUSTOM_PRICE),
          description: CUSTOM_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: CUSTOM_TAGS,
          mimeType: "application/json",
          extensions: customDiscoveryExtension,
        },
        "/extract/invoice": {
          accepts: acceptsFor(c.env.X402_INVOICE_PRICE),
          description: INVOICE_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: INVOICE_TAGS,
          mimeType: "application/json",
          extensions: invoiceDiscoveryExtension,
        },
        "/extract/receipt": {
          accepts: acceptsFor(c.env.X402_RECEIPT_PRICE),
          description: RECEIPT_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: RECEIPT_TAGS,
          mimeType: "application/json",
          extensions: receiptDiscoveryExtension,
        },
        "/extract/contract": {
          accepts: acceptsFor(c.env.X402_CONTRACT_PRICE),
          description: CONTRACT_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: CONTRACT_TAGS,
          mimeType: "application/json",
          extensions: contractDiscoveryExtension,
        },
        "/extract/resume": {
          accepts: acceptsFor(c.env.X402_RESUME_PRICE),
          description: RESUME_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: RESUME_TAGS,
          mimeType: "application/json",
          extensions: resumeDiscoveryExtension,
        },
      },
      getFacilitatorClients(c.env),
      [{ network, server: new ExactEvmScheme() }]
    );
  }
  return cachedMiddleware(c, next);
});

for (const kind of DOC_KINDS) {
  app.post(`/extract/${kind}`, (c) => handleExtract(c, kind));
}
app.post("/extract/custom", handleExtractCustom);

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
