// Tests two things against fully-local mock servers (no real facilitators, no production):
// 1. Does a genuinely hanging (not just unreachable) facilitator actually cost ~30s per request?
// 2. Does caching the built middleware (reusing the same instance across requests) eliminate
//    that cost for every request after the first, by only running initialize() once?
import http from "node:http";
import { Hono } from "hono";
import { paymentMiddlewareFromConfig } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// A healthy mock facilitator: responds instantly to /supported.
const healthyServer = http.createServer((req, res) => {
  if (req.url === "/supported") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// A hanging mock facilitator: accepts the connection, never responds. Simulates a genuinely
// unhealthy third-party facilitator (not just a bad DNS name, which fails fast and understates
// the real risk).
const hangingServer = http.createServer(() => {
  /* never calls res.end() */
});

await new Promise((resolve) => healthyServer.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => hangingServer.listen(0, "127.0.0.1", resolve));
const healthyPort = healthyServer.address().port;
const hangingPort = hangingServer.address().port;
console.log(`Mock healthy facilitator: http://127.0.0.1:${healthyPort}`);
console.log(`Mock hanging facilitator: http://127.0.0.1:${hangingPort}`);

// Short timeout so this test doesn't take the full default 30s per hung facilitator — proves the
// same mechanism with a timeout small enough to run quickly, not a different one.
const TIMEOUT_MS = 2000;
const healthyClient = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${healthyPort}`, timeoutMs: TIMEOUT_MS });
const hangingClient1 = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${hangingPort}`, timeoutMs: TIMEOUT_MS });
const hangingClient2 = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${hangingPort}`, timeoutMs: TIMEOUT_MS });

const network = "eip155:8453";
const accepts = { scheme: "exact", price: "$0.05", network, payTo: "0x65c767C483dd862d08Bc3d6500Cd4CD770Ae28ED" };
const routes = { "/extract/invoice": { accepts, description: "test", serviceName: "test" } };
const schemes = [{ network, server: new ExactEvmScheme() }];

async function timeRequest(app) {
  const start = Date.now();
  const res = await app.request("/extract/invoice", { method: "POST" });
  return { status: res.status, ms: Date.now() - start };
}

console.log("\n=== Rebuilt per request (today's production pattern) — 3 facilitators, 2 hanging ===");
for (let i = 1; i <= 3; i++) {
  const app = new Hono();
  app.use("/extract/*", (c, next) =>
    paymentMiddlewareFromConfig(routes, [healthyClient, hangingClient1, hangingClient2], schemes)(c, next)
  );
  app.post("/extract/invoice", (c) => c.json({ ok: true }));
  const result = await timeRequest(app);
  console.log(`  request ${i}: HTTP ${result.status} in ${result.ms}ms`);
}

console.log("\n=== Built ONCE, reused across requests (proposed fix) — same 3 facilitators ===");
const cachedMiddleware = paymentMiddlewareFromConfig(routes, [healthyClient, hangingClient1, hangingClient2], schemes);
const cachedApp = new Hono();
cachedApp.use("/extract/*", cachedMiddleware);
cachedApp.post("/extract/invoice", (c) => c.json({ ok: true }));
for (let i = 1; i <= 3; i++) {
  const result = await timeRequest(cachedApp);
  console.log(`  request ${i}: HTTP ${result.status} in ${result.ms}ms`);
}

healthyServer.close();
hangingServer.close();
