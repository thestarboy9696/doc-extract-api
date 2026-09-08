import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { toClientEvmSigner, ExactEvmScheme } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PRIVATE_KEY = process.env.TEST_WALLET_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Set TEST_WALLET_PRIVATE_KEY env var first.");
  process.exit(1);
}

const API_URL = "https://doc-extract-api.thestarboy9696-4ef.workers.dev/extract/invoice";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x65c767C483dd862d08Bc3d6500Cd4CD770Ae28ED";
const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const account = privateKeyToAccount(PRIVATE_KEY);
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
console.log("Test wallet USDC balance:", await usdcBalance(account.address));
console.log("Recipient (payTo) USDC balance before:", await usdcBalance(PAY_TO));

const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register("eip155:8453", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// A repo-committed fixture, not a path into the ephemeral per-session scratchpad — that path
// broke this script the moment the session that created it ended and its scratchpad was cleared.
const fixturePath = fileURLToPath(new URL("./fixtures/test-invoice.pdf", import.meta.url));
const fileBytes = await readFile(fixturePath);
const form = new FormData();
form.append("file", new Blob([fileBytes], { type: "application/pdf" }), "test-invoice.pdf");

console.log("\nSending paid request (v2 protocol, mainnet)...");
const response = await fetchWithPayment(API_URL, { method: "POST", body: form });
console.log("Status:", response.status);

const paymentResponseHeader = response.headers.get("X-PAYMENT-RESPONSE") || response.headers.get("PAYMENT-RESPONSE");
if (paymentResponseHeader) {
  console.log("Settlement header (base64):", paymentResponseHeader.slice(0, 80) + "...");
  console.log("Settlement decoded:", JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString()));
}

const body = await response.json();
console.log("\nResponse body:", JSON.stringify(body, null, 2));

console.log("\nRecipient (payTo) USDC balance after:", await usdcBalance(PAY_TO));
