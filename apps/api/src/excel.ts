/**
 * Reads the master Excel file (.xlsx) without a spreadsheet library: an xlsx is a zip of XML
 * files, so fflate plus a few targeted regexes is enough for plain text/number cells.
 *
 * Expected layout (fixed columns, no header row):
 *   C = Bill of Lading, D = reference, E = merchant
 */
import { strFromU8, unzipSync } from "fflate";
import type { Match } from "@stamper/shared";

export const COL_BL = "C";
export const COL_REFERENCE = "D";
export const COL_MERCHANT = "E";

/** Normalized bill of lading -> every distinct (merchant, reference) pair found for it. */
export type ExcelRows = Record<string, Match[]>;

export interface ExcelData {
  rows: ExcelRows;
  error: string;
}

/** Uppercase and drop spaces/dashes so 'medu sf-687819' == 'MEDUSF687819'. */
export function normalizeBl(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\s\-_/]/g, "").toUpperCase();
}

/** Remove every '/' (and '\') from the merchant name: 'سنيورة/' -> 'سنيورة'. */
export function cleanMerchant(value: string): string {
  return value.replace(/[/\\]+/g, " ").replace(/\s+/g, " ").trim();
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[e.toLowerCase()] ?? "";
  });
}

/** Concatenate every <t>…</t> inside a fragment (handles rich-text runs). */
function textOf(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += m[1] ?? "";
  return decodeXml(out);
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(textOf(m[1] ?? ""));
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
}

/** A cell as text: whole numbers drop their '.0', like Python's int(float) cleanup. */
function cleanCell(raw: string): string {
  return raw.trim();
}

function numberToText(raw: string): string {
  const n = Number(raw);
  if (Number.isFinite(n) && Number.isInteger(n)) return String(n);
  return raw.trim();
}

/** Worksheet XML paths in workbook order. */
function sheetPaths(files: Record<string, Uint8Array>): string[] {
  const workbook = files["xl/workbook.xml"];
  const rels = files["xl/_rels/workbook.xml.rels"];
  const fallback = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
    .sort();
  if (!workbook || !rels) return fallback;

  const targets = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target);
  }

  const paths: string[] = [];
  for (const m of strFromU8(workbook).matchAll(/<sheet\b[^>]*>/g)) {
    const rid = attr(m[0], "r:id");
    const target = rid ? targets.get(rid) : undefined;
    if (!target) continue;
    paths.push(target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const existing = paths.filter((p) => files[p]);
  return existing.length ? existing : fallback;
}

export function readExcel(data: Uint8Array): ExcelData {
  const result: ExcelData = { rows: {}, error: "" };

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) =>
        /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name),
    });
  } catch {
    result.error = "تعذّر فتح ملف الإكسل";
    return result;
  }
  if (!files["xl/workbook.xml"] && !Object.keys(files).some((n) => n.startsWith("xl/worksheets/"))) {
    result.error = "تعذّر فتح ملف الإكسل";
    return result;
  }

  const shared = files["xl/sharedStrings.xml"] ? parseSharedStrings(strFromU8(files["xl/sharedStrings.xml"])) : [];
  const idxBl = columnIndex(COL_BL);
  const idxRef = columnIndex(COL_REFERENCE);
  const idxMerchant = columnIndex(COL_MERCHANT);

  for (const path of sheetPaths(files)) {
    const xml = strFromU8(files[path]);
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r");
        const col = ref ? columnIndex(/^[A-Za-z]+/.exec(ref)?.[0] ?? "A") : cells.length;
        const type = attr(c[1], "t");
        const body = c[2] ?? "";
        const v = /<v\b[^>]*?>([\s\S]*?)<\/v>/.exec(body)?.[1];

        let value = "";
        if (type === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "str") value = v !== undefined ? decodeXml(v) : "";
        else if (type === "b" || type === "e") value = "";
        else if (v !== undefined) value = numberToText(decodeXml(v));
        cells[col] = cleanCell(value);
      }

      const bl = normalizeBl(cells[idxBl] ?? "");
      const reference = (cells[idxRef] ?? "").trim();
      const merchant = cleanMerchant(cells[idxMerchant] ?? "");
      // Skip header/info rows: a real data row has a BL with digits and a reference
      if (!bl || !reference || !/\d/.test(bl)) continue;
      const list = (result.rows[bl] ??= []);
      if (!list.some(([m, r]) => m === merchant && r === reference)) list.push([merchant, reference]);
    }
  }

  if (!Object.keys(result.rows).length) {
    result.error = "لم يتم العثور على بيانات في ملف الإكسل (البوليصة في العمود C، المرجع D، التاجر E)";
  }
  return result;
}

export function lookup(rows: ExcelRows, billOfLading: string): Match[] {
  const bl = normalizeBl(billOfLading);
  if (!bl) return [];
  if (rows[bl]) return rows[bl];
  // Fallback: Excel may hold the BL without its carrier prefix; accept only a unique hit
  const hits = Object.keys(rows).filter((k) => k.length >= 8 && bl.endsWith(k));
  return hits.length === 1 ? rows[hits[0]] : [];
}
