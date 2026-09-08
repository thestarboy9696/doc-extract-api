# doc-extract-api

Document-to-structured-JSON extraction API. Takes a PDF/PNG/JPEG and returns clean JSON.
Four fixed document types (invoice, receipt, contract, resume) get a matched schema plus
domain-specific validation; `/extract/custom` accepts *any* JSON Schema, so a caller isn't
limited to those four types. Built for autonomous AI agents: no signup, no API key, no human
checkout — an agent discovers the price and pays per call via [x402](https://www.x402.org) v2
(USDC), entirely over HTTP, and can find this service programmatically via the **x402 Bazaar**
discovery catalog. Also published as an MCP server (`doc-extract-api-mcp` on npm, and on the
[official MCP Registry](https://registry.modelcontextprotocol.io)) — but that's a *client* for the
same paid API, not a free alternative: every MCP tool call is a real x402 payment from a wallet
you supply, not a locally-run, unmetered extraction. There is no free path to this service.

## Why x402, not Stripe

Stripe Checkout is built for humans — it collects a card through a UI, and its payment
button actively resists non-trusted, programmatic (agent-driven) submission. x402 revives
the HTTP `402 Payment Required` status code: hit a paid endpoint with no payment, get back a
`402` whose `PAYMENT-REQUIRED` header carries a complete, machine-readable manifest (price,
network, receiving address, asset, and — via the Bazaar extension — a full input/output
schema with a real example). Retry with an `X-PAYMENT` header carrying a signed USDC
transfer authorization, and the request goes through. No account, no key, no human in the
loop — the discovery step and the payment step are the same HTTP round trip.

Payment is only **settled** after the extraction succeeds — `@x402/hono`'s middleware
verifies the payment signature before running the handler, but only executes the actual
on-chain transfer if the handler returns a non-error status (confirmed: this project's
`paymentMiddlewareFromConfig` call skips settlement whenever the wrapped route responds
≥400). A failed extraction costs the caller nothing.

## Discovery: the x402 Bazaar

The Bazaar (`GET {facilitator}/discovery/resources`) is a live, queryable catalog of x402
services — ~15k listings as of this writing, searchable by agent clients
(`client.extensions.bazaar.search({ query: "..." })`). Getting listed isn't a submission
form: a facilitator catalogs a resource automatically the first time it processes a real
payment that echoes the route's declared `bazaar` extension. `src/lib/discovery.ts` declares
that extension for all four routes — full input schema (multipart form-data, a `file` field)
and a real, verified output example — so once a route's first live mainnet payment lands, it
becomes findable in the catalog with enough detail for an agent to integrate correctly
without reading any docs. As of this writing the `/extract/invoice` catalog entry is still
showing a stale pre-migration record rather than this rich content — see git history / ask
for status; `/extract/receipt`, `/extract/contract`, and `/extract/resume` haven't had a
mainnet payment yet so aren't catalogued at all.

**Positioning** (from surveying the live Bazaar before writing the listing copy): generic OCR
competitors are free but return raw unvalidated text; generic structured-extraction
competitors charge ~$0.10/call and require the caller to already have plain text, not a raw
file. This is the only listing found doing both — raw PDF/image in, a fixed validated schema
out. Pricing (see `wrangler.toml`) is matched per-route to the lowest verified live-402 price
from a direct competitor in that category, not set independently — $0.02 for
invoice/receipt/resume/custom, $0.03 for contract (its real comparable is a cent higher). See
`src/lib/discovery.ts` for the exact listing copy and each route's tags
(`serviceName`/`tags`/`description`).

## Architecture

- **`schemas/`** — JSON Schema for `invoice`, `receipt`, `contract`, and `resume` extractions
  (also the tool `input_schema` sent to Claude, so the model is forced into this exact shape).
- **`src/lib/claude.ts`** — calls the Anthropic Messages API with the document as a native
  `document`/`image` content block and a forced `tool_choice`, so the model can't return
  anything but the schema.
- **`src/lib/validate.ts`** — post-extraction sanity checks: line items sum to subtotal,
  subtotal + tax (+ tip) ≈ total, dates are valid and not in the future, currency is a real
  ISO 4217 code, low-confidence fields get flagged.
- **`src/lib/extract.ts`** — orchestrates one extraction pass, validates, and — if validation
  fails — retries once with a corrective prompt describing exactly what didn't add up. Never
  fails silently; returns `validation_warnings` alongside the data either way.
- **`src/lib/customSchema.ts`** / **`src/routes/customExtractHandler.ts`** — `/extract/custom`:
  same Claude forced-tool-use engine, but the tool's `input_schema` is a JSON Schema the caller
  supplies at request time instead of one of the four fixed schemas. There's no domain-specific
  validator (no fixed domain to check against), so this returns schema-conformant output, not
  fact-checked output — `validation_warnings` is always `[]`. The caller's schema is bounded
  (≤6000 chars, depth ≤4, ≤30 properties per level, no `$ref`) and rejected with a 400 —
  which costs nothing, since x402 only settles on a non-error response — before any model call.
  Accepts either a `file` (binary PDF/image, same as the fixed routes) **or** `content` (raw
  text/HTML the caller already has — e.g. an already-scraped web page, ≤100,000 chars) — exactly
  one of the two, not both. The text/HTML path is labeled explicitly as data in the prompt sent to
  Claude, not instructions, since it's arbitrary caller-supplied content and could otherwise be a
  prompt-injection vector.
- **`src/lib/facilitator.ts`** — picks the free default facilitator on testnet, or, on mainnet
  (`X402_NETWORK = "base"`), Coinbase's authenticated CDP facilitator plus Mogami and PayAI for
  additional Bazaar-equivalent discovery surface (CDP stays first/primary — earlier facilitators
  get precedence for verify/settle); maps this project's human-readable network names to the
  CAIP-2 identifiers x402 v2 uses (`eip155:8453` etc). **Important:** `src/index.ts` caches the
  built payment middleware at module scope rather than rebuilding it per-request — with multiple
  facilitators, an unhealthy one adds its full timeout to `initialize()`, and rebuilding per-request
  meant paying that cost on *every* request (this broke the API entirely the first time
  multi-facilitator was tried). Caching means only a cold isolate's first request pays that cost.
- **`src/lib/discovery.ts`** — the Bazaar listing content: descriptions, tags, and discovery
  extensions (schema + real example) for all four routes.
- **`src/index.ts`** — Hono app on Cloudflare Workers. `@x402/hono`'s
  `paymentMiddlewareFromConfig` guards `/extract/*`, built per-request from `Env` bindings
  (Workers only exposes env vars inside a request, not at module load time).
- **`src/routes/extractHandler.ts`** — pure extraction logic; payment has already been
  verified by the time this runs.
- **`mcp/server.ts`** — stdio MCP server exposing `extract_invoice`, `extract_receipt`,
  `extract_contract`, `extract_resume`, and `extract_custom` tools. Each tool call signs and
  sends a real x402 payment (via `@x402/fetch`'s `wrapFetchWithPayment`, same mechanism as
  `scripts/test-payment.mjs`) from a wallet supplied via `WALLET_PRIVATE_KEY`, then calls the
  live HTTP API over the network — it does not run extraction locally or call Claude directly.
  No free path: a missing or unfunded wallet fails the same way it would calling the API
  directly.

## One deliberate deviation from the original spec

The spec assumed a PDF→image conversion step (pdf2image/poppler). Cloudflare Workers can't
run native binaries, and Claude's Messages API accepts PDFs natively as a `document` content
block — so PDFs are sent to Claude as-is. This removes a whole pipeline stage and a
dependency that wouldn't run on Workers anyway.

## Setup

```bash
cd "doc-extract-api"
npm install
```

### 1. Secrets

Local dev — copy `.dev.vars.example` to `.dev.vars` and fill in a real key (gitignored):

```bash
cp .dev.vars.example .dev.vars
```

Production:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### 2. Wallet — where payments land

Edit `wrangler.toml`: `X402_PAY_TO_ADDRESS` must be a real wallet address you control before
this can receive actual payments. It's a public receiving address (safe to commit, like a
bank account number) — never put a private key anywhere in this project.

`X402_NETWORK` defaults to `base-sepolia` (testnet, free fake USDC from a faucet — good for
verifying the whole flow with zero real money at risk).

Pricing is per-route, not shared: `X402_INVOICE_PRICE`, `X402_RECEIPT_PRICE`,
`X402_CONTRACT_PRICE`, `X402_RESUME_PRICE`, `X402_CUSTOM_PRICE`. Defaults are matched to the
lowest verified live competitor per category — see the Positioning note above.

### 2b. Going to mainnet (`X402_NETWORK = "base"`)

The free default facilitator (`x402.org/facilitator`, used automatically on testnet) only
supports testnet — mainnet requires an authenticated facilitator. This project is wired for
Coinbase's CDP facilitator (`src/lib/facilitator.ts`):

1. Create a [CDP Portal](https://portal.cdp.coinbase.com) account and a **Secret API Key**
   under Project → API Keys.
2. `npx wrangler secret put CDP_API_KEY_ID`
3. `npx wrangler secret put CDP_API_KEY_SECRET`
4. Set `X402_NETWORK = "base"` in `wrangler.toml` and redeploy.

Pricing: free for the first ~1,000 settled transactions/month, then $0.001 each — payment
verification itself is always free. If `X402_NETWORK` is `"base"` and these secrets aren't
set, requests will fail loudly at the facilitator-config step rather than silently
misconfiguring payments.

Getting listed in the Bazaar requires at least one real mainnet payment to go through — the
facilitator catalogs the resource the first time it processes a payment that echoes the
`bazaar` extension. Run `scripts/test-payment.mjs` with a real funded wallet once to trigger
it (see below), then confirm with:

```bash
curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=200" \
  | grep -o 'doc-extract-api'
```

### 3. End-to-end payment test (`scripts/test-payment.mjs`)

Simulates a real autonomous agent: generates/uses a throwaway wallet, pays via x402 v2, and
calls the live API. Fund a test wallet first — testnet USDC from a faucet (e.g.
[faucet.circle.com](https://faucet.circle.com), Base Sepolia) for a free run, or a small
amount of real USDC on Base if `X402_NETWORK` is `"base"`:

```bash
node scripts/gen-test-wallet.mjs        # prints a fresh throwaway private key + address
TEST_WALLET_PRIVATE_KEY=0x... node scripts/test-payment.mjs
```

Prints the settlement details and the recipient's before/after USDC balance — confirmed
working end to end on both Base Sepolia (testnet) and Base mainnet with real USDC.

### 4. Run locally

```bash
npm run dev
```

```bash
curl -X POST http://localhost:8787/extract/invoice -F "file=@/path/to/invoice.pdf"
# → 402 Payment Required; full payment + discovery manifest in the PAYMENT-REQUIRED header
```

`/extract/custom` takes a `schema` field (a JSON Schema string, `type: "object"`), an optional
`instructions` field, and exactly one of `file` (binary) or `content` (raw text/HTML):

```bash
curl -X POST http://localhost:8787/extract/custom \
  -F "file=@/path/to/doc.pdf" \
  -F 'schema={"type":"object","properties":{"order_id":{"type":"string"},"ship_date":{"type":"string"}}}' \
  -F "instructions=Dates in YYYY-MM-DD"
```

Or from raw text/HTML you already have — no file needed:

```bash
curl -X POST http://localhost:8787/extract/custom \
  -F "content=<html><body><h1>Acme Corp</h1><p>Founded 1998, HQ in Austin, TX</p></body></html>" \
  -F 'schema={"type":"object","properties":{"company":{"type":"string"},"founded":{"type":"number"},"hq":{"type":"string"}}}'
```

An actual caller uses an x402-aware HTTP client (e.g. `@x402/fetch` on the agent's side) that
handles the 402 → sign payment → retry loop automatically.

### 5. Deploy

```bash
npm run deploy
```

### 6. MCP server (paid, agent use)

```bash
export WALLET_PRIVATE_KEY=0x...   # a wallet funded with real USDC on Base — every call spends from it
npm run mcp
```

Or, once published, an MCP client can run it directly without cloning this repo:

```bash
npx doc-extract-api-mcp
```

Point an MCP-capable client at this stdio server to expose `extract_invoice`, `extract_receipt`,
`extract_contract`, `extract_resume`, and `extract_custom` as tools. Every call pays the live API
over the network via x402 — there is no local/free extraction path, and no `ANTHROPIC_API_KEY` is
needed on the client side at all (the server holds that; callers only need a funded wallet).

## Not yet done

- Resumes carry real PII (name, contact info, work history). Nothing is persisted after the
  response is returned (same as every other document type here), but that's worth restating
  given the sensitivity — see `src/lib/discovery.ts`'s resume description.
