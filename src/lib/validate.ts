import type { ContractData, ResumeData, InvoiceData, ReceiptData } from "../types";

const CENT_TOLERANCE = 0.01;
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function approxEqual(a: number, b: number, count = 1): boolean {
  return Math.abs(a - b) <= CENT_TOLERANCE * Math.max(1, count);
}

export function validateInvoice(data: InvoiceData): string[] {
  const warnings: string[] = [];

  const lineSum = data.line_items.reduce((sum, li) => sum + li.amount, 0);
  if (data.line_items.length > 0 && !approxEqual(lineSum, data.subtotal, data.line_items.length)) {
    warnings.push(
      `line_items sum to ${lineSum.toFixed(2)} but subtotal says ${data.subtotal.toFixed(2)}`
    );
  }

  const expectedTotal = data.subtotal + (data.tax ?? 0);
  if (!approxEqual(expectedTotal, data.total)) {
    warnings.push(
      `subtotal (${data.subtotal.toFixed(2)}) + tax (${(data.tax ?? 0).toFixed(2)}) = ${expectedTotal.toFixed(2)} but total says ${data.total.toFixed(2)}`
    );
  }

  if (!isValidDate(data.invoice_date)) {
    warnings.push(`invoice_date "${data.invoice_date}" is not a valid, non-future ISO 8601 date`);
  }
  if (data.due_date && !isValidDate(data.due_date) && new Date(data.due_date).toString() === "Invalid Date") {
    warnings.push(`due_date "${data.due_date}" is not a valid ISO 8601 date`);
  }

  if (!ISO_CURRENCY_RE.test(data.currency)) {
    warnings.push(`currency "${data.currency}" is not a valid 3-letter ISO 4217 code`);
  }

  for (const [field, score] of Object.entries(data.confidence.fields)) {
    if (score < 0.6) {
      warnings.push(`low confidence (${score.toFixed(2)}) on field "${field}"`);
    }
  }

  return warnings;
}

export function validateContract(data: ContractData): string[] {
  const warnings: string[] = [];

  if (data.parties.length === 0) {
    warnings.push("no parties extracted — expected at least one named party");
  }

  if (data.effective_date && !isWellFormedDate(data.effective_date)) {
    warnings.push(`effective_date "${data.effective_date}" is not a valid ISO 8601 date`);
  }
  if (data.expiration_date && !isWellFormedDate(data.expiration_date)) {
    warnings.push(`expiration_date "${data.expiration_date}" is not a valid ISO 8601 date`);
  }
  if (
    data.effective_date &&
    data.expiration_date &&
    isWellFormedDate(data.effective_date) &&
    isWellFormedDate(data.expiration_date) &&
    new Date(data.expiration_date).getTime() < new Date(data.effective_date).getTime()
  ) {
    warnings.push(`expiration_date (${data.expiration_date}) is before effective_date (${data.effective_date})`);
  }

  for (const [field, score] of Object.entries(data.confidence.fields)) {
    if (score < 0.6) {
      warnings.push(`low confidence (${score.toFixed(2)}) on field "${field}"`);
    }
  }

  return warnings;
}

export function validateResume(data: ResumeData): string[] {
  const warnings: string[] = [];

  if (data.candidate.email && !EMAIL_RE.test(data.candidate.email)) {
    warnings.push(`candidate.email "${data.candidate.email}" is not a well-formed email address`);
  }

  for (const job of data.work_experience) {
    if (
      job.start_date &&
      job.end_date &&
      isWellFormedDate(job.start_date) &&
      isWellFormedDate(job.end_date) &&
      new Date(job.end_date).getTime() < new Date(job.start_date).getTime()
    ) {
      warnings.push(`${job.company}: end_date (${job.end_date}) is before start_date (${job.start_date})`);
    }
  }

  for (const [field, score] of Object.entries(data.confidence.fields)) {
    if (score < 0.6) {
      warnings.push(`low confidence (${score.toFixed(2)}) on field "${field}"`);
    }
  }

  return warnings;
}

export function validateReceipt(data: ReceiptData): string[] {
  const warnings: string[] = [];

  if (data.subtotal !== null) {
    const itemSum = data.items.reduce((sum, it) => sum + it.amount, 0);
    if (data.items.length > 0 && !approxEqual(itemSum, data.subtotal, data.items.length)) {
      warnings.push(
        `items sum to ${itemSum.toFixed(2)} but subtotal says ${data.subtotal.toFixed(2)}`
      );
    }
  }

  if (data.subtotal !== null) {
    const expectedTotal = data.subtotal + (data.tax ?? 0) + (data.tip ?? 0);
    if (!approxEqual(expectedTotal, data.total)) {
      warnings.push(
        `subtotal + tax + tip = ${expectedTotal.toFixed(2)} but total says ${data.total.toFixed(2)}`
      );
    }
  }

  if (!isValidDate(data.transaction_date)) {
    warnings.push(`transaction_date "${data.transaction_date}" is not a valid, non-future ISO 8601 date`);
  }

  if (!ISO_CURRENCY_RE.test(data.currency)) {
    warnings.push(`currency "${data.currency}" is not a valid 3-letter ISO 4217 code`);
  }

  for (const [field, score] of Object.entries(data.confidence.fields)) {
    if (score < 0.6) {
      warnings.push(`low confidence (${score.toFixed(2)}) on field "${field}"`);
    }
  }

  return warnings;
}
