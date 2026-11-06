/** Types and constants shared by the API (Worker) and the web app. */

/** A merchant name and its reference number, as read from the Excel sheet. */
export type Match = [merchant: string, reference: string];

export type InvoiceStatus = "ok" | "multiple" | "missing" | "error";

/** Metadata about the master Excel file currently stored on the server. */
export interface MasterInfo {
  name: string;
  /** Local upload time, formatted `YYYY-MM-DD HH:mm`. */
  uploaded: string;
  /** Number of distinct bills of lading in the file. */
  count: number;
}

/** Result of analysing one uploaded invoice against the master Excel file. */
export interface AnalyzeResult {
  /** Original file name as uploaded. */
  original: string;
  invoice_no: string;
  /** Bill of lading read from the invoice. */
  bl: string;
  error: string;
  status: InvoiceStatus;
  /** True when text already exists under the invoice table. */
  already_stamped: boolean;
  matches: Match[];
  merchant: string;
  reference: string;
}

export interface ApiError {
  error: string;
}

/** Form field names and routes, so both sides stay in sync. */
export const ROUTES = {
  health: "/healthz",
  master: "/api/master",
  excel: "/api/excel",
  analyze: "/api/analyze",
  stamp: "/api/stamp",
} as const;

/** JPG export settings (used by the web app when rendering stamped pages). */
export const JPG_DPI = 200;
export const JPG_QUALITY = 0.9;

/** Pages the master Excel upload accepts. */
export const EXCEL_ACCEPT = ".xlsx,.xlsm";
