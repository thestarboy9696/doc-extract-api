import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

// Positioning, informed by a survey of ~15k live x402 Bazaar listings (Aug 2026):
// - Generic OCR competitors (e.g. image-to-text) are free but return raw text — no schema,
//   no validation, nothing an agent can trust without its own parsing/checking pass.
// - Generic structured-extraction competitors (e.g. schema-to-JSON) charge ~$0.10/call and
//   require the caller to already have plain text — they don't accept a PDF/image directly.
// This service is the only one found doing both at once: raw file in, fixed validated schema out.
// Pricing (Sep 2026, see wrangler.toml) is matched to the lowest verified live-402 price from a
// direct per-category competitor, not set independently — so the differentiation has to carry the
// listing on its own merits (the settlement-skipped-on-failure guarantee, mainly), not on being
// unusually cheap.
// Kept short deliberately: CDP's facilitator enforces a 500-char max on this field (undocumented
// in the x402 spec itself, found by inspecting @coinbase/cdp-sdk's generated OpenAPI types) and
// silently fails payment verification on any resource whose description exceeds it — no error
// naming the field, just a generic union-mismatch. Every prior version of this copy was already
// over that limit, which is why no real payment had settled since it was written.
const DIFFERENTIATION =
  "Unlike generic OCR (raw text) or text-only extraction APIs, this takes the raw file directly " +
  "and validates against source math: line items checked against subtotal/tax/total, dates and " +
  "currency checked, one automatic retry. If it still fails after that, you aren't charged — " +
  "settlement is skipped, not just flagged.";

const INVOICE_OUTPUT_EXAMPLE = {
  data: {
    vendor: { name: "Acme Supply Co.", address: "123 Industrial Ave, Springfield, IL 62701", tax_id: "12-3456789" },
    invoice_number: "INV-20268",
    invoice_date: "2026-08-01",
    due_date: "2026-08-31",
    bill_to: { name: "Brandon Strouse", address: "55 Market St, Austin, TX 78701" },
    line_items: [
      { description: "Widget A (steel)", quantity: 10, unit_price: 4.5, amount: 45 },
      { description: "Widget B (plastic)", quantity: 25, unit_price: 1.2, amount: 30 },
      { description: "Shipping crate", quantity: 1, unit_price: 18, amount: 18 },
    ],
    subtotal: 93,
    tax: 7.44,
    total: 100.44,
    currency: "USD",
    payment_terms: "Net 30",
    confidence: { overall: 0.97, fields: { vendor: 0.99, total: 0.99 } },
  },
  validation_warnings: [],
  retried: false,
};

const RECEIPT_OUTPUT_EXAMPLE = {
  data: {
    merchant: { name: "Corner Cafe", address: "88 5th Ave, New York, NY 10011", phone: "212-555-0199" },
    transaction_date: "2026-08-12",
    transaction_time: "13:42",
    items: [
      { description: "Latte", quantity: 1, unit_price: 4.75, amount: 4.75 },
      { description: "Bagel w/ cream cheese", quantity: 1, unit_price: 3.5, amount: 3.5 },
    ],
    subtotal: 8.25,
    tax: 0.73,
    tip: 1.5,
    total: 10.48,
    currency: "USD",
    payment_method: "Visa •••• 4242",
    confidence: { overall: 0.96, fields: { merchant: 0.98, total: 0.99 } },
  },
  validation_warnings: [],
  retried: false,
};

const CONTRACT_DIFFERENTIATION =
  "Unlike generic OCR or text-only extraction APIs, this takes the raw file directly and " +
  "validates date logic (expiration after effective date), one automatic retry. Still fails " +
  "after that, you aren't charged. Per-field confidence included.";

const RESUME_DIFFERENTIATION =
  "Unlike generic OCR or text-only extraction APIs, this takes the raw file directly and " +
  "validates email format and work-history date order, one automatic retry. Still fails after " +
  "that, you aren't charged. No content stored after the response returns.";

const CONTRACT_OUTPUT_EXAMPLE = {
  data: {
    title: "Master Services Agreement",
    parties: [
      { name: "Acme Supply Co.", role: "Vendor" },
      { name: "Brandon Strouse", role: "Client" },
    ],
    effective_date: "2026-01-01",
    expiration_date: "2026-12-31",
    term: "12 months, auto-renews unless terminated with 30 days notice",
    payment_terms: "Net 30",
    termination_clause: "Either party may terminate with 30 days written notice",
    governing_law: "State of Delaware",
    key_obligations: [
      { party: "Vendor", obligation: "Deliver services per SOW" },
      { party: "Client", obligation: "Pay invoices within 30 days" },
    ],
    signatures: [
      { name: "Jane Doe", title: "CEO, Acme Supply Co.", signed: true, date: "2026-01-01" },
      { name: "Brandon Strouse", title: "Client", signed: true, date: "2026-01-01" },
    ],
    confidence: { overall: 0.96, fields: { parties: 0.98, effective_date: 0.97 } },
  },
  validation_warnings: [],
  retried: false,
};

const RESUME_OUTPUT_EXAMPLE = {
  data: {
    candidate: { name: "Jordan Rivera", email: "jordan.rivera@example.com", phone: "512-555-0142", location: "Austin, TX" },
    summary: "Backend engineer with 6 years building payment infrastructure.",
    work_experience: [
      {
        company: "Acme Supply Co.",
        title: "Senior Backend Engineer",
        start_date: "2022-03",
        end_date: null,
        description: "Built and maintained payment processing systems.",
      },
    ],
    education: [{ institution: "University of Texas at Austin", degree: "B.S.", field: "Computer Science", graduation_date: "2018-05" }],
    skills: ["TypeScript", "Node.js", "PostgreSQL"],
    confidence: { overall: 0.95, fields: { candidate: 0.98, work_experience: 0.94 } },
  },
  validation_warnings: [],
  retried: false,
};

const CUSTOM_DIFFERENTIATION =
  "Unlike the fixed invoice/receipt/contract/resume endpoints, this accepts any JSON Schema — " +
  "you define the fields. Takes a PDF/image file OR raw text/HTML you already have (e.g. a " +
  "scraped page). Schema-conformance, not fact-checking. A rejected schema is a 400 and costs " +
  "nothing.";

const CUSTOM_OUTPUT_EXAMPLE = {
  data: {
    order_id: "PO-88213",
    ship_date: "2026-07-14",
    total_weight_kg: 42.5,
  },
  validation_warnings: [],
  retried: false,
};

export const customDiscoveryExtension = declareDiscoveryExtension({
  bodyType: "form-data",
  input: {
    file: "<binary: PDF, PNG, or JPEG/WEBP, max 15MB — send this OR 'content', not both>",
    content: "<string: raw text or HTML, e.g. an already-scraped web page, max 100000 chars — send this OR 'file', not both>",
    schema:
      '<string: JSON Schema, type "object", e.g. {"type":"object","properties":{"order_id":{"type":"string"},"ship_date":{"type":"string"},"total_weight_kg":{"type":"number"}}}>',
    instructions: "<optional string: extra guidance for the model, max 1000 chars>",
  },
  output: { example: CUSTOM_OUTPUT_EXAMPLE },
});

export const invoiceDiscoveryExtension = declareDiscoveryExtension({
  bodyType: "form-data",
  input: { file: "<binary: PDF, PNG, or JPEG of an invoice, max 15MB>" },
  output: { example: INVOICE_OUTPUT_EXAMPLE },
});

export const receiptDiscoveryExtension = declareDiscoveryExtension({
  bodyType: "form-data",
  input: { file: "<binary: PDF, PNG, or JPEG of a receipt, max 15MB>" },
  output: { example: RECEIPT_OUTPUT_EXAMPLE },
});

export const contractDiscoveryExtension = declareDiscoveryExtension({
  bodyType: "form-data",
  input: { file: "<binary: PDF, PNG, or JPEG of a contract, max 15MB>" },
  output: { example: CONTRACT_OUTPUT_EXAMPLE },
});

export const resumeDiscoveryExtension = declareDiscoveryExtension({
  bodyType: "form-data",
  input: { file: "<binary: PDF, PNG, or JPEG of a resume, max 15MB>" },
  output: { example: RESUME_OUTPUT_EXAMPLE },
});

// Bazaar keeps only the first 5 valid tags — ordered by expected search value.
//
// Renamed from "doc-extract-api" to "SchemaLock" (Aug 2026): a survey of the live catalog found
// the `serviceName` field is rarely populated (69 of 14,626 v2 listings) and doesn't render
// prominently — the busiest listings instead lead their `description` with a brand name
// ("Chainlink For Agents: ...", "PDL Person Enrich — ...", "FullEnrich People Search — ...").
// "doc-extract-api" named the mechanism, not the differentiator (validated/fixed-shape output
// vs. free-text OCR) — "SchemaLock" names that instead, and is now prefixed on every description
// below so it appears in the text agents actually search against, not just the serviceName field.
// Tags/description wording tuned against real Bazaar search results (Sep 2026), not guessed:
// querying the live discovery/search endpoint with realistic agent phrasing showed (a) we were
// completely absent from "convert document to JSON" — no listing here used the word "convert" or
// carried a "json" tag, just "document-extraction" — and (b) a bare-bones competitor with no
// tags and no serviceName outranked our own /extract/custom listing for "extract structured data
// from a PDF" purely because its one-line description echoed that exact phrase back, including
// the word "data" that ours was missing ("...JSON from..." vs the query's "...data from...").
// Richer differentiation copy doesn't help if it doesn't also contain the literal words an agent's
// query uses. "ocr" was dropped for "json" (also more accurate — this uses Claude's native vision,
// not an OCR pipeline) and "pdf" was restored to the custom-schema route, which had lost it when
// that listing's tags were last rewritten for the text/HTML addition.
export const SERVICE_NAME = "SchemaLock";
export const INVOICE_TAGS = ["invoice", "pdf", "json", "document-extraction", "accounts-payable"];
export const RECEIPT_TAGS = ["receipt", "pdf", "json", "document-extraction", "expense"];
export const CONTRACT_TAGS = ["contract", "pdf", "json", "document-extraction", "legal"];
export const RESUME_TAGS = ["resume", "pdf", "json", "document-extraction", "recruiting"];
export const CUSTOM_TAGS = ["custom-schema", "pdf", "json", "document-extraction", "structured-data"];

export const CUSTOM_DESCRIPTION = `SchemaLock — extract structured JSON data from any PDF/image or raw text/HTML, converting it into a JSON Schema you supply, not limited to invoice/receipt/contract/resume. ${CUSTOM_DIFFERENTIATION}`;

export const INVOICE_DESCRIPTION = `SchemaLock — extract structured JSON data from an invoice PDF or image (vendor, line items, subtotal, tax, total, dates, payment terms). ${DIFFERENTIATION}`;
export const RECEIPT_DESCRIPTION = `SchemaLock — extract structured JSON data from a receipt PDF or image (merchant, items, subtotal, tax, tip, total, payment method). ${DIFFERENTIATION}`;
export const CONTRACT_DESCRIPTION = `SchemaLock — extract structured JSON data from a contract PDF or image (parties, dates, term, payment terms, termination clause, governing law, obligations, signatures). ${CONTRACT_DIFFERENTIATION}`;
export const RESUME_DESCRIPTION = `SchemaLock — extract structured JSON data from a resume PDF or image (contact info, work experience, education, skills). ${RESUME_DIFFERENTIATION}`;
