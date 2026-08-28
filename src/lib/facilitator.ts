import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import type { Env } from "../types";

const DEFAULT_TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";

// Verified live on Base mainnet (Aug 2026) as supplementary discovery surfaces alongside CDP.
// Each gets its own catalog — more facilitators cataloging this resource means more places an
// agent can find it. CDP stays first in the array: @x402/core's initialize() gives earlier
// facilitators precedence for verify()/settle() when multiple support the same scheme/network,
// so CDP (our primary, authenticated, highest-trust facilitator) keeps handling actual payments;
// Mogami/PayAI mainly add Bazaar-equivalent listing surface.
const MOGAMI_FACILITATOR_URL = "https://facilitator.mogami.tech";
const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";

// Bounds how long a cold isolate's first request can be held up by a slow/unhealthy facilitator.
// initialize() (see src/index.ts's caching) awaits facilitatorClient.getSupported() for each
// registered facilitator *sequentially*; the SDK's own default is 30s per facilitator, so 3
// registered facilitators could in the worst case add up to 90s to a single request if left at
// the default. This is what actually broke the earlier multi-facilitator attempt: initialize()
// was re-running on literally every request (see the caching fix in src/index.ts) and an
// unhealthy extra facilitator added tens of seconds to *every* one, including bare unauthenticated
// 402s -- easily enough to blow past Workers' execution limits. Confirmed by direct local
// reproduction against mock servers (see scripts/test-multi-facilitator-latency.mjs): a hung
// facilitator with no cap costs its full timeout on every request when the middleware is rebuilt
// per-request; with the same middleware instance cached and reused, only the first request pays
// that cost at all, and a short per-client timeout keeps that cost small even then.
const FACILITATOR_TIMEOUT_MS = 8000;

// The free default facilitator only supports testnet. Mainnet ("base") requires an
// authenticated facilitator — wired here to Coinbase's CDP facilitator, plus Mogami and PayAI
// for additional Bazaar-equivalent discovery surface. See src/index.ts for why this can only be
// called once per isolate (its result must be cached, not rebuilt per-request) — that caching is
// what makes multiple facilitators safe here; without it, an unhealthy extra facilitator would
// add its full timeout to every single request again.
export function getFacilitatorClients(env: Env): HTTPFacilitatorClient[] {
  if (env.X402_NETWORK !== "base") {
    return [new HTTPFacilitatorClient({ url: DEFAULT_TESTNET_FACILITATOR_URL, timeoutMs: FACILITATOR_TIMEOUT_MS })];
  }

  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    throw new Error(
      "X402_NETWORK is 'base' (mainnet) but CDP_API_KEY_ID/CDP_API_KEY_SECRET are not set. " +
        "Get them from https://portal.cdp.coinbase.com and set as Worker secrets."
    );
  }

  return [
    new HTTPFacilitatorClient({
      ...createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
      timeoutMs: FACILITATOR_TIMEOUT_MS,
    }),
    new HTTPFacilitatorClient({ url: MOGAMI_FACILITATOR_URL, timeoutMs: FACILITATOR_TIMEOUT_MS }),
    new HTTPFacilitatorClient({ url: PAYAI_FACILITATOR_URL, timeoutMs: FACILITATOR_TIMEOUT_MS }),
  ];
}

// x402 v2 networks use CAIP-2 identifiers, not the human-readable "base"/"base-sepolia"
// names used elsewhere in this project's env vars and docs.
export function toCaip2Network(network: string): "eip155:8453" | "eip155:84532" {
  if (network === "base") return "eip155:8453";
  if (network === "base-sepolia") return "eip155:84532";
  throw new Error(`Unsupported X402_NETWORK: ${network}`);
}
