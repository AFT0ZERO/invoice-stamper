import type { AnalyzeResult } from "@stamper/shared";

/** One uploaded invoice in the review table. */
export interface Row {
  file: File;
  /** Safe, unique `.pdf` file name used inside the ZIP. */
  name: string;
  result: AnalyzeResult;
  merchant: string;
  reference: string;
  skip: boolean;
}
