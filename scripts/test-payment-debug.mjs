import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { readFile } from "node:fs/promises";

const RAW_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
if (!RAW_KEY) {
  console.error("Set TEST_WALLET_PRIVATE_KEY env var first.");
  process.exit(1);
}
const PRIVATE_KEY = RAW_KEY.trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  console.error(
    `TEST_WALLET_PRIVATE_KEY doesn't look like a valid private key (expected 0x + 64 hex chars, got ${PRIVATE_KEY.length} chars). Check for stray whitespace or a missing '0x' prefix.`
  );
  process.exit(1);
}

const VALID_ROUTES = ["invoice", "receipt", "contract", "resume", "custom"];
const ROUTE = (process.env.ROUTE || "invoice").trim();
if (!VALID_ROUTES.includes(ROUTE)) {
  console.error(`ROUTE must be one of: ${VALID_ROUTES.join(", ")} (got "${ROUTE}")`);
  process.exit(1);
}

const API_URL = `https://doc-extract-api.thestarboy9696-4ef.workers.dev/extract/${ROUTE}`;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x65c767C483dd862d08Bc3d6500Cd4CD770Ae28ED";
// Conservative upper bound across all routes (invoice/receipt/contract/resume are $0.05, custom
// is $0.08) — this is just a pre-flight warning, the actual price is whatever the live 402 says.
const EXPECTED_PRICE_USDC = 0.08;
const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

let account;
try {
  account = privateKeyToAccount(PRIVATE_KEY);
} catch (err) {
  console.error("Failed to derive an account from TEST_WALLET_PRIVATE_KEY:", err.message);
  process.exit(1);
}

const publicClient = createPublicClient({ chain: base, transport: http() });

async function usdcBalance(address) {
  const raw = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(raw, 6);
}

console.log("Test wallet:", account.address);
const walletBalance = await usdcBalance(account.address);
console.log("Test wallet USDC balance:", walletBalance);

if (Number(walletBalance) < EXPECTED_PRICE_USDC) {
  console.error(
    `\n⚠️  Wallet balance (${walletBalance} USDC) is below the current price ($${EXPECTED_PRICE_USDC}). ` +
      `Send at least $${EXPECTED_PRICE_USDC} in real USDC on Base to ${account.address} before retrying.\n` +
      `This is not a fatal error for this script — it'll still attempt the call so you can see the real error — but it will very likely fail at settlement.`
  );
}

console.log("Recipient (payTo) USDC balance before:", await usdcBalance(PAY_TO));

const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));

const originalFetch = fetch;
const loggingFetch = async (input, opts) => {
  const headers = input instanceof Request ? input.headers : opts?.headers;
  for (const name of ["X-PAYMENT", "PAYMENT-SIGNATURE"]) {
    const value = headers?.get ? headers.get(name) : headers?.[name];
    if (value) {
      console.log(`\n--- Outgoing ${name} header (raw) ---`);
      console.log(value);
      try {
        console.log(`--- Outgoing ${name} header (decoded) ---`);
        console.log(JSON.stringify(JSON.parse(Buffer.from(value, "base64").toString()), null, 2));
      } catch (err) {
        console.log(`Couldn't decode ${name} as base64 JSON:`, err.message);
      }
    }
  }
  return originalFetch(input, opts);
};

const fetchWithPayment = wrapFetchWithPayment(loggingFetch, client);

const fileBytes = await readFile(
  "/private/tmp/claude-501/-Users-b-Desktop-DBA-Code-Testing/043a8d4b-2b1f-4eb6-8454-9e7e84780894/scratchpad/test-invoice.png"
);
const form = new FormData();
form.append("file", new Blob([fileBytes], { type: "image/png" }), "test-invoice.png");
if (ROUTE === "custom") {
  // The extraction result won't make much sense (it's an invoice image), but that doesn't matter
  // here — the goal is just a settled payment against /extract/custom to trigger Bazaar cataloging.
  form.append(
    "schema",
    JSON.stringify({ type: "object", properties: { note: { type: "string" } } })
  );
  form.append("instructions", "This is a Bazaar-cataloging test call, not a real extraction request.");
}

console.log(`\nSending paid request to /extract/${ROUTE} (v2 protocol, mainnet)...`);

let response;
try {
  response = await fetchWithPayment(API_URL, { method: "POST", body: form });
} catch (err) {
  console.error("\n❌ fetchWithPayment threw before getting a response:");
  console.error(err.stack || err.message || err);
  if (err.cause) console.error("Cause:", err.cause);
  process.exit(1);
}

console.log("Status:", response.status);
console.log("Status text:", response.statusText);

for (const [key, value] of response.headers.entries()) {
  if (key.toLowerCase().includes("payment")) {
    console.log(`\nHeader ${key} (raw, full length ${value.length}):`);
    console.log(value);
    try {
      const decoded = JSON.parse(Buffer.from(value, "base64").toString());
      console.log(`Header ${key} (decoded):`, JSON.stringify(decoded, null, 2));
    } catch {
      // not base64/JSON, raw value above is enough
    }
  }
}

let body;
const rawText = await response.text();
try {
  body = JSON.parse(rawText);
  console.log("\nResponse body:", JSON.stringify(body, null, 2));
} catch {
  console.log("\nResponse body (not JSON):", rawText.slice(0, 2000));
}

if (!response.ok) {
  console.error(`\n❌ Request did not succeed (HTTP ${response.status}). No payment should have settled — see body above for the reason.`);
}

console.log("\nRecipient (payTo) USDC balance after:", await usdcBalance(PAY_TO));
