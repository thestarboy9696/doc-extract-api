/// <reference types="@cloudflare/workers-types" />

export type DocKind = "invoice" | "receipt" | "contract" | "resume";

export interface Confidence {
  overall: number;
  fields: Record<string, number>;
}

export interface InvoiceData {
  vendor: { name: string; address: string | null; tax_id: string | null };
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  bill_to: { name: string; address: string | null };
  line_items: Array<{
    description: string;
    quantity: number;
    unit_price: number;
    amount: number;
  }>;
  subtotal: number;
  tax: number | null;
  total: number;
  currency: string;
  payment_terms: string | null;
  confidence: Confidence;
}

export interface ReceiptData {
  merchant: { name: string; address: string | null; phone: string | null };
  transaction_date: string;
  transaction_time: string | null;
  items: Array<{
    description: string;
    quantity: number | null;
    unit_price: number | null;
    amount: number;
  }>;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number;
  currency: string;
  payment_method: string | null;
  confidence: Confidence;
}

export interface ContractData {
  title: string | null;
  parties: Array<{ name: string; role: string | null }>;
  effective_date: string | null;
  expiration_date: string | null;
  term: string | null;
  payment_terms: string | null;
  termination_clause: string | null;
  governing_law: string | null;
  key_obligations: Array<{ party: string; obligation: string }>;
  signatures: Array<{ name: string | null; title: string | null; signed: boolean; date: string | null }>;
  confidence: Confidence;
}

export interface ResumeData {
  candidate: { name: string; email: string | null; phone: string | null; location: string | null };
  summary: string | null;
  work_experience: Array<{
    company: string;
    title: string;
    start_date: string | null;
    end_date: string | null;
    description: string | null;
  }>;
  education: Array<{
    institution: string;
    degree: string | null;
    field: string | null;
    graduation_date: string | null;
  }>;
  skills: string[];
  confidence: Confidence;
}

export type ExtractedData = InvoiceData | ReceiptData | ContractData | ResumeData;

export interface ExtractionResult<T extends ExtractedData> {
  data: T;
  validation_warnings: string[];
  retried: boolean;
  // True if a real consistency/format check still failed after the one corrective retry — not
  // just a low-confidence flag. The route handler turns this into a non-2xx response so x402
  // never settles payment for it. See src/lib/validate.ts's ValidationResult doc comment.
  hardFailure: boolean;
}

export interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL?: string;
  X402_PAY_TO_ADDRESS: string;
  X402_NETWORK: string;
  // Per-route, not shared — see wrangler.toml for why contract differs from the rest.
  X402_INVOICE_PRICE: string;
  X402_RECEIPT_PRICE: string;
  X402_CONTRACT_PRICE: string;
  X402_RESUME_PRICE: string;
  X402_CUSTOM_PRICE: string;
  // Required only when X402_NETWORK is "base" (mainnet) — the free default facilitator
  // is testnet-only. Get these from https://portal.cdp.coinbase.com.
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
}
