// Standalone, local reproduction of the multi-facilitator bug — no Workers runtime, no
// production deploy, no real payment, no real credentials needed. Builds the exact same Hono app
// shape as src/index.ts but with 3 facilitator clients pointing at deliberately-unreachable URLs
// (stand-ins for CDP/Mogami/PayAI — doesn't matter which is "real" for this specific question),
// and hits it with a bare unauthenticated request — the case that broke last time. If the bare
// 402 path never touches facilitator clients (per reading @x402/core's processHTTPRequest, it
// shouldn't), this should behave identically whether there's 1 client or 3, sync on or off.
import { Hono } from "hono";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const cdpClient = new HTTPFacilitatorClient({ url: "https://cdp-stand-in.invalid" });
const unreachableClient1 = new HTTPFacilitatorClient({ url: "https://mogami-stand-in.invalid" });
const unreachableClient2 = new HTTPFacilitatorClient({ url: "https://payai-stand-in.invalid" });

const app = new Hono();
const network = "eip155:8453";
const accepts = {
  scheme: "exact",
  price: "$0.05",
  network,
  payTo: "0x65c767C483dd862d08Bc3d6500Cd4CD770Ae28ED",
};

async function buildApp(facilitatorClients, syncFacilitatorOnStart) {
  const testApp = new Hono();
  testApp.use("/extract/*", async (c, next) => {
    const middleware = paymentMiddlewareFromConfig(
      { "/extract/invoice": { accepts, description: "test", serviceName: "test" } },
      facilitatorClients,
      [{ network, server: new ExactEvmScheme() }],
      undefined,
      undefined,
      syncFacilitatorOnStart
    );
    return middleware(c, next);
  });
  testApp.post("/extract/invoice", (c) => c.json({ ok: true }));
  return testApp;
}

async function runCase(label, facilitatorClients, syncFacilitatorOnStart, repeats) {
  console.log(`\n=== ${label} (syncFacilitatorOnStart=${syncFacilitatorOnStart}) ===`);
  const testApp = await buildApp(facilitatorClients, syncFacilitatorOnStart);
  for (let i = 1; i <= repeats; i++) {
    const start = Date.now();
    try {
      const res = await testApp.request("/extract/invoice", { method: "POST" });
      const ms = Date.now() - start;
      console.log(`  call ${i}: HTTP ${res.status} (${ms}ms)`);
      if (res.status !== 402) {
        const text = await res.text();
        console.log(`    unexpected body: ${text.slice(0, 300)}`);
      }
    } catch (err) {
      const ms = Date.now() - start;
      console.log(`  call ${i}: THREW after ${ms}ms — ${err.message}`);
    }
  }
}

await runCase("Single facilitator (CDP only, baseline)", [cdpClient], false, 3);
await runCase("Multi-facilitator, sync disabled", [cdpClient, unreachableClient1, unreachableClient2], false, 5);
await runCase("Multi-facilitator, sync enabled", [cdpClient, unreachableClient1, unreachableClient2], true, 3);
