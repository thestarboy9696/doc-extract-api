import { callExtractionTool, type DocumentInput } from "./claude";
import { validateInvoice, validateReceipt, validateContract, validateResume, type ValidationResult } from "./validate";
import type { DocKind, Env, ExtractionResult, ExtractedData } from "../types";

const VALIDATORS: Record<DocKind, (data: any) => ValidationResult> = {
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
  let result = validate(firstPass);

  if (result.warnings.length === 0) {
    return { data: firstPass, validation_warnings: [], retried: false, hardFailure: false };
  }

  const correction = `Recheck the following before returning: ${result.warnings.join("; ")}.`;
  const secondPass = (await callExtractionTool(env, kind, input, correction)) as T;
  result = validate(secondPass);

  return { data: secondPass, validation_warnings: result.warnings, retried: true, hardFailure: result.hardFailure };
}
