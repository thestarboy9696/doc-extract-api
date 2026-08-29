import type { ContractData, ResumeData, InvoiceData, ReceiptData } from "../types";

const CENT_TOLERANCE = 0.01;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A validator's output is split into two severities, not one flat list — this distinction is
// what actually backs the "financially validated" claim (see extractHandler.ts): a `hard`
// warning survives one corrective retry and still means the extraction failed a real
// consistency/format check, and settlement is cancelled for it (HTTP ≥400, so x402 never
// charges the caller). A `soft` warning is only a low-confidence flag — the model itself saying
// it isn't sure — which is not evidence of an actual error on a genuinely hard-to-read source
// document, so it stays informational-only and still settles normally. Conflating the two
// (treating every warning as payment-blocking) would mean legitimately difficult documents never
// get paid for regardless of extraction quality; conflating them the other way (never blocking)
// is the gap this file used to have — real arithmetic/format failures were charged the same as
// clean extractions, with no way to tell from the response status.
export interface ValidationResult {
  warnings: string[];
  hardFailure: boolean;
}

function isValidDate(value: string | null): boolean {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return d.getTime() <= now.getTime();
}

// Contracts and resumes routinely carry future or open-ended dates (expiration dates,
// upcoming graduation dates) — unlike invoices/receipts, "not in the future" isn't a
// valid check here, just well-formedness.
function isWellFormedDate(value: string | null): boolean {
  if (!value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

// Tolerance always scales with the number of terms actually summed (each term can independently
// be off by up to half a cent from the source's own rounding) — applied consistently to every
// addition check below, not just the line-item sums.
function approxEqual(a: number, b: number, termCount = 1): boolean {
  return Math.abs(a - b) <= CENT_TOLERANCE * Math.max(1, termCount);
}

function confidenceWarnings(fields: Record<string, number>): string[] {
  const warnings: string[] = [];
  for (const [field, score] of Object.entries(fields)) {
    if (score < 0.6) {
      warnings.push(`low confidence (${score.toFixed(2)}) on field "${field}"`);
    }
  }
  return warnings;
}

export function validateInvoice(data: InvoiceData): ValidationResult {
  const hard: string[] = [];

  const lineSum = data.line_items.reduce((sum, li) => sum + li.amount, 0);
  if (data.line_items.length > 0 && !approxEqual(lineSum, data.subtotal, data.line_items.length)) {
    hard.push(`line_items sum to ${lineSum.toFixed(2)} but subtotal says ${data.subtotal.toFixed(2)}`);
  }

  const expectedTotal = data.subtotal + (data.tax ?? 0);
  if (!approxEqual(expectedTotal, data.total, 2)) {
    hard.push(
      `subtotal (${data.subtotal.toFixed(2)}) + tax (${(data.tax ?? 0).toFixed(2)}) = ${expectedTotal.toFixed(2)} but total says ${data.total.toFixed(2)}`
    );
  }

  if (!isValidDate(data.invoice_date)) {
    hard.push(`invoice_date "${data.invoice_date}" is not a valid, non-future ISO 8601 date`);
  }
  if (data.due_date && !isValidDate(data.due_date) && new Date(data.due_date).toString() === "Invalid Date") {
    hard.push(`due_date "${data.due_date}" is not a valid ISO 8601 date`);
  }

  if (!ISO_CURRENCY_RE.test(data.currency)) {
    hard.push(`currency "${data.currency}" is not a valid 3-letter ISO 4217 code`);
  }

  const soft = confidenceWarnings(data.confidence.fields);
  return { warnings: [...hard, ...soft], hardFailure: hard.length > 0 };
}

export function validateContract(data: ContractData): ValidationResult {
  const hard: string[] = [];

  if (data.parties.length === 0) {
    hard.push("no parties extracted — expected at least one named party");
  }

  if (data.effective_date && !isWellFormedDate(data.effective_date)) {
    hard.push(`effective_date "${data.effective_date}" is not a valid ISO 8601 date`);
  }
  if (data.expiration_date && !isWellFormedDate(data.expiration_date)) {
    hard.push(`expiration_date "${data.expiration_date}" is not a valid ISO 8601 date`);
  }
  if (
    data.effective_date &&
    data.expiration_date &&
    isWellFormedDate(data.effective_date) &&
    isWellFormedDate(data.expiration_date) &&
    new Date(data.expiration_date).getTime() < new Date(data.effective_date).getTime()
  ) {
    hard.push(`expiration_date (${data.expiration_date}) is before effective_date (${data.effective_date})`);
  }

  const soft = confidenceWarnings(data.confidence.fields);
  return { warnings: [...hard, ...soft], hardFailure: hard.length > 0 };
}

export function validateResume(data: ResumeData): ValidationResult {
  const hard: string[] = [];

  if (data.candidate.email && !EMAIL_RE.test(data.candidate.email)) {
    hard.push(`candidate.email "${data.candidate.email}" is not a well-formed email address`);
  }

  for (const job of data.work_experience) {
    if (
      job.start_date &&
      job.end_date &&
      isWellFormedDate(job.start_date) &&
      isWellFormedDate(job.end_date) &&
      new Date(job.end_date).getTime() < new Date(job.start_date).getTime()
    ) {
      hard.push(`${job.company}: end_date (${job.end_date}) is before start_date (${job.start_date})`);
    }
  }

  const soft = confidenceWarnings(data.confidence.fields);
  return { warnings: [...hard, ...soft], hardFailure: hard.length > 0 };
}

export function validateReceipt(data: ReceiptData): ValidationResult {
  const hard: string[] = [];

  if (data.subtotal !== null) {
    const itemSum = data.items.reduce((sum, it) => sum + it.amount, 0);
    if (data.items.length > 0 && !approxEqual(itemSum, data.subtotal, data.items.length)) {
      hard.push(`items sum to ${itemSum.toFixed(2)} but subtotal says ${data.subtotal.toFixed(2)}`);
    }

    const expectedTotal = data.subtotal + (data.tax ?? 0) + (data.tip ?? 0);
    if (!approxEqual(expectedTotal, data.total, 3)) {
      hard.push(
        `subtotal + tax + tip = ${expectedTotal.toFixed(2)} but total says ${data.total.toFixed(2)}`
      );
    }
  }

  if (!isValidDate(data.transaction_date)) {
    hard.push(`transaction_date "${data.transaction_date}" is not a valid, non-future ISO 8601 date`);
  }

  if (!ISO_CURRENCY_RE.test(data.currency)) {
    hard.push(`currency "${data.currency}" is not a valid 3-letter ISO 4217 code`);
  }

  const soft = confidenceWarnings(data.confidence.fields);
  return { warnings: [...hard, ...soft], hardFailure: hard.length > 0 };
}
