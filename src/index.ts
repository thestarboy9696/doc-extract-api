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

app.get("/", (c) =>
  c.json({
    status: "ok",
    description: "Document-to-structured-JSON extraction for AI agents. Pay per call via x402 (USDC). Listed on the x402 Bazaar.",
    endpoints: {
      ...Object.fromEntries(
        DOC_KINDS.map((kind) => [`POST /extract/${kind}`, `${c.env.X402_PRICE_PER_CALL} per call`])
      ),
      "POST /extract/custom": `${c.env.X402_CUSTOM_PRICE_PER_CALL} per call (caller-supplied JSON Schema)`,
    },
    payment: "x402",
    network: c.env.X402_NETWORK,
  })
);

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
    const price = c.env.X402_PRICE_PER_CALL;
    const accepts = { scheme: "exact" as const, price, network, payTo };
    const customAccepts = { scheme: "exact" as const, price: c.env.X402_CUSTOM_PRICE_PER_CALL, network, payTo };

    cachedMiddleware = paymentMiddlewareFromConfig(
      {
        "/extract/custom": {
          accepts: customAccepts,
          description: CUSTOM_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: CUSTOM_TAGS,
          mimeType: "application/json",
          extensions: customDiscoveryExtension,
        },
        "/extract/invoice": {
          accepts,
          description: INVOICE_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: INVOICE_TAGS,
          mimeType: "application/json",
          extensions: invoiceDiscoveryExtension,
        },
        "/extract/receipt": {
          accepts,
          description: RECEIPT_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: RECEIPT_TAGS,
          mimeType: "application/json",
          extensions: receiptDiscoveryExtension,
        },
        "/extract/contract": {
          accepts,
          description: CONTRACT_DESCRIPTION,
          serviceName: SERVICE_NAME,
          tags: CONTRACT_TAGS,
          mimeType: "application/json",
          extensions: contractDiscoveryExtension,
        },
        "/extract/resume": {
          accepts,
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
