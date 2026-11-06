/**
 * Reads ACT invoices with pdf.js (via unpdf, which runs inside Workers): invoice number,
 * bill of lading, where the invoice table ends, and whether it was already stamped.
 *
 * Coordinates below are "top-based" (y grows downward from the page top), matching the
 * original PyMuPDF implementation, so the layout constants carry over unchanged.
 */
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

/** Never write over the footer line. */
export const FOOTER_TOP_Y = 755;

export interface InvoiceInfo {
  invoiceNo: string;
  billOfLading: string;
  tableBottom: number | null;
  alreadyStamped: boolean;
  error: string;
}

interface Word {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface PageData {
  words: Word[];
  /** Raw text, used for the invoice-number regex. */
  text: string;
  /** Bounding boxes (top-based) of every painted path: [x0, y0, x1, y1]. */
  paths: [number, number, number, number][];
  width: number;
  height: number;
}

// Approximate PyMuPDF's word boxes: ascender above the baseline, descender below.
const ASCENT = 1.07;
const DESCENT = 0.31;

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

async function loadFirstPage(bytes: Uint8Array): Promise<PageData> {
  const pdfjs = await getResolvedPDFJS();
  // pdf.js takes ownership of the buffer, so hand it a copy
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const page = await doc.getPage(1);
    const [vx0, , , vy1] = page.view as number[];
    const width = (page.view as number[])[2] - vx0;
    const height = vy1 - (page.view as number[])[1];

    // ---- words ----
    const content = await page.getTextContent();
    const words: Word[] = [];
    const lines: string[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      lines.push(item.str);
      if (!item.str.trim()) continue;
      const [a, b, , , e, f] = item.transform as number[];
      const size = Math.hypot(a, b) || item.height || 10;
      const baseline = vy1 - f;
      const len = item.str.length;
      for (const m of item.str.matchAll(/\S+/g)) {
        const start = m.index ?? 0;
        words.push({
          text: m[0],
          x0: e - vx0 + (item.width * start) / len,
          x1: e - vx0 + (item.width * (start + m[0].length)) / len,
          y0: baseline - ASCENT * size,
          y1: baseline + DESCENT * size,
        });
      }
    }

    // ---- painted paths (table rules) ----
    const paths: PageData["paths"] = [];
    const ops = await page.getOperatorList();
    const OPS = pdfjs.OPS as Record<string, number>;
    const painting = new Set([
      OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
      OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
    ]);
    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] as unknown;
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = multiply(args as Matrix, ctm);
      else if (fn === OPS.constructPath) {
        const [paintOp, data] = args as [number, unknown];
        if (!painting.has(paintOp)) continue;
        const raw = Array.isArray(data) ? data[0] : data;
        const box = pathBox(raw as ArrayLike<number>, ctm, vx0, vy1);
        if (box) paths.push(box);
      }
    }

    return { words, text: lines.join("\n"), paths, width, height };
  } finally {
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/**
 * pdf.js path data: a flat list of [code, ...coords]. 0 = moveTo(x,y), 1 = lineTo(x,y),
 * 2 = curveTo(6 numbers), 3 = quadraticCurveTo(4 numbers), 4 = closePath.
 */
function pathBox(
  data: ArrayLike<number>,
  ctm: Matrix,
  vx0: number,
  vy1: number,
): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const point = (x: number, y: number) => {
    const px = ctm[0] * x + ctm[2] * y + ctm[4] - vx0;
    const py = vy1 - (ctm[1] * x + ctm[3] * y + ctm[5]);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };
  for (let i = 0; i < data.length; ) {
    const code = data[i++];
    if (code === 0 || code === 1) { point(data[i], data[i + 1]); i += 2; }
    else if (code === 2) { for (let k = 0; k < 6; k += 2) point(data[i + k], data[i + k + 1]); i += 6; }
    else if (code === 3) { for (let k = 0; k < 4; k += 2) point(data[i + k], data[i + k + 1]); i += 4; }
    else if (code !== 4) return null; // unknown code: bail out rather than misread coordinates
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Group words into visual lines (same vertical midpoint), each sorted left to right. */
function groupLines(words: Word[]): Word[][] {
  const sorted = [...words].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const lines: Word[][] = [];
  for (const w of sorted) {
    const mid = (w.y0 + w.y1) / 2;
    const line = lines.find((l) => Math.abs((l[0].y0 + l[0].y1) / 2 - mid) < 3);
    if (line) line.push(w);
    else lines.push([w]);
  }
  for (const l of lines) l.sort((a, b) => a.x0 - b.x0);
  return lines;
}

/** Value printed to the right of a label (e.g. "Bill of Lading") in the left info column. */
function labelValue(words: Word[], pageWidth: number, lastWord: string, firstWord: string): string {
  const midX = pageWidth / 2;
  for (const w of words) {
    if (w.text !== lastWord || w.x0 >= midX) continue;
    const yMid = (w.y0 + w.y1) / 2;
    const line = words
      .filter((x) => Math.abs((x.y0 + x.y1) / 2 - yMid) < 3)
      .sort((a, b) => a.x0 - b.x0);
    if (!line.length || line[0].text !== firstWord) continue;
    return line
      .filter((x) => x.x0 > w.x1 + 5 && x.x0 < midX)
      .map((x) => x.text)
      .join(" ")
      .trim();
  }
  return "";
}

function findTableBottom(page: PageData): number | null {
  // Locate "Net Invoice Amount" as three consecutive words on one line
  let textBottom: number | null = null;
  for (const line of groupLines(page.words)) {
    for (let i = 0; i + 2 < line.length; i++) {
      if (line[i].text === "Net" && line[i + 1].text === "Invoice" && line[i + 2].text === "Amount") {
        const bottom = Math.max(line[i].y1, line[i + 1].y1, line[i + 2].y1);
        textBottom = textBottom === null ? bottom : Math.max(textBottom, bottom);
      }
    }
  }
  if (textBottom === null) return null;

  // Snap to the horizontal rule just under the "Net Invoice Amount" row
  let best = textBottom;
  for (const [, y0, , y1] of page.paths) {
    if (y1 - y0 < 1.5 && y0 >= textBottom - 2 && y0 <= textBottom + 8) best = Math.max(best, y1);
  }
  return best;
}

export async function readInvoice(bytes: Uint8Array): Promise<InvoiceInfo> {
  const info: InvoiceInfo = { invoiceNo: "", billOfLading: "", tableBottom: null, alreadyStamped: false, error: "" };
  let page: PageData;
  try {
    page = await loadFirstPage(bytes);
  } catch {
    info.error = "الملف ليس PDF صالحاً";
    return info;
  }

  info.invoiceNo = /#\s*(F\d+)/.exec(page.text)?.[1] ?? "";
  info.billOfLading = labelValue(page.words, page.width, "Lading", "Bill");
  info.tableBottom = findTableBottom(page);
  if (info.tableBottom !== null) {
    const bottom = info.tableBottom;
    // Any text between the table and the footer means the invoice was stamped before
    // (the vertical midpoint is used because glyph boxes of tall scripts start above the baseline box)
    info.alreadyStamped = page.words.some((w) => (w.y0 + w.y1) / 2 > bottom + 2 && w.y1 < FOOTER_TOP_Y);
  }
  if (!info.billOfLading) info.error = "لم يتم العثور على رقم البوليصة في الفاتورة";
  else if (info.tableBottom === null) info.error = "لم يتم العثور على نهاية جدول الفاتورة";
  return info;
}

/** Where the invoice table ends, or null when it can't be found. */
export async function readTableBottom(bytes: Uint8Array): Promise<number | null> {
  return findTableBottom(await loadFirstPage(bytes));
}
