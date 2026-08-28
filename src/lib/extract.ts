import { callExtractionTool, type DocumentInput } from "./claude";
import { validateInvoice, validateReceipt, validateContract, validateResume } from "./validate";
import type { DocKind, Env, ExtractionResult, ExtractedData } from "../types";

const VALIDATORS: Record<DocKind, (data: any) => string[]> = {
  invoice: validateInvoice,
  receipt: validateReceipt,
  contract: validateContract,
  resume: validateResume,
};

export async function extractDocument<T extends ExtractedData>(
  env: Env,
  kind: DocKind,
  input: DocumentInput
): Promise<ExtractionResult<T>> {
  const validate = VALIDATORS[kind];

  const firstPass = (await callExtractionTool(env, kind, input)) as T;
  let warnings = validate(firstPass);

  if (warnings.length === 0) {
    return { data: firstPass, validation_warnings: [], retried: false };
  }

  const correction = `Recheck the following before returning: ${warnings.join("; ")}.`;
  const secondPass = (await callExtractionTool(env, kind, input, correction)) as T;
  warnings = validate(secondPass);

  return { data: secondPass, validation_warnings: warnings, retried: true };
}
