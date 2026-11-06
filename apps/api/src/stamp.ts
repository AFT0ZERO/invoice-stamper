/**
 * Writes the merchant name and reference number under the invoice table.
 *
 * pdf-lib has no text shaping, so Arabic is shaped with fontkit (contextual forms, marks,
 * cursive attachment) and mixed Arabic/Latin text is ordered with the Unicode bidi algorithm.
 * Arabic runs use the bundled Noto Sans Arabic; Latin text and digits use Helvetica.
 */
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingGrayscaleColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import arabicFontData from "../assets/NotoSansArabic_400Regular.ttf";
import { FOOTER_TOP_Y, readTableBottom } from "./pdf-read";

// ---------- Stamp appearance (same values as the original app) ----------
const FONT_SIZE_PT = 30;
const LINE_HEIGHT = 1.15;
const GAP_BELOW_TABLE = 6; // space between table bottom and the stamp (points)
const RIGHT_MARGIN_X = 553; // right edge, aligned with the invoice table
const LEFT_LIMIT_X = 120; // long names wrap inside [LEFT_LIMIT_X, RIGHT_MARGIN_X]
const RIGHT_INK_X = 552; // text is right-aligned a hair inside the margin
const BASELINE_IN_LINE = 27.2 / (FONT_SIZE_PT * LINE_HEIGHT); // baseline position within a line box
const MIN_SCALE = 0.5;
const FALLBACK_TABLE_BOTTOM = 431;

const bidi = bidiFactory();
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

type Kind = "arabic" | "latin";

interface Piece {
  text: string;
  level: number;
  kind: Kind;
}

/** A shaped run ready to draw, in visual left-to-right order. */
type Run =
  | { kind: "arabic"; glyphs: FkGlyph[]; positions: FkPosition[] }
  | { kind: "latin"; text: string };

// Minimal shapes for the parts of fontkit we use (the package ships loose types).
interface FkGlyph {
  id: number;
}
interface FkPosition {
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}
interface FkFont {
  unitsPerEm: number;
  layout(
    text: string,
    features?: unknown,
    script?: string,
    language?: string,
    direction?: "ltr" | "rtl",
  ): { glyphs: FkGlyph[]; positions: FkPosition[] };
}
interface SubsetEmbedder {
  font: FkFont;
  subset: { includeGlyph(glyph: FkGlyph): number };
  glyphCache: { invalidate(): void };
  /** Subset glyphs by (subset id - 1); pdf-lib uses these for the width table and ToUnicode map. */
  glyphs: FkGlyph[];
  glyphIdMap: Map<number, number>;
}

interface Fonts {
  arabic: PDFFont;
  latin: PDFFont;
  /** Whether Helvetica (WinAnsi) can draw this code point. */
  canLatin: (cp: number) => boolean;
  fk: FkFont;
  embedder: SubsetEmbedder;
}

// ---------- bidi + shaping ----------

/** Split text into same-level, same-font pieces. */
function splitPieces(text: string, baseRtl: boolean, canLatin: (cp: number) => boolean): Piece[] {
  const levels = bidi.getEmbeddingLevels(text, baseRtl ? "rtl" : "ltr").levels;
  const chars: { ch: string; level: number; kind: Kind | null }[] = [];
  let index = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const level = levels[index];
    index += ch.length;
    let kind: Kind | null;
    if (/\s/.test(ch)) kind = null; // spaces follow their neighbours
    else if (ARABIC_RANGE.test(ch)) kind = "arabic";
    else kind = canLatin(cp) ? "latin" : "arabic"; // Noto covers what Helvetica can't
    chars.push({ ch, level, kind });
  }
  // Spaces take the font of the previous character (or the next one at the start)
  let prev: Kind | null = null;
  for (const c of chars) c.kind ? (prev = c.kind) : (c.kind = prev);
  let next: Kind | null = null;
  for (let i = chars.length - 1; i >= 0; i--) chars[i].kind ? (next = chars[i].kind) : (chars[i].kind = next);

  const pieces: Piece[] = [];
  for (const c of chars) {
    const last = pieces[pieces.length - 1];
    const ch = c.level % 2 === 1 ? (bidi.getMirroredCharacter(c.ch) ?? c.ch) : c.ch;
    if (last && last.level === c.level && last.kind === (c.kind ?? "latin")) last.text += ch;
    else pieces.push({ text: ch, level: c.level, kind: c.kind ?? "latin" });
  }
  return pieces;
}

/** Unicode L2: reverse runs from the highest level down to the lowest odd level. */
function visualOrder(pieces: Piece[]): Piece[] {
  if (!pieces.length) return pieces;
  const out = [...pieces];
  const max = Math.max(...out.map((p) => p.level));
  const lowestOdd = Math.min(...out.filter((p) => p.level % 2 === 1).map((p) => p.level), Infinity);
  for (let level = max; level >= lowestOdd; level--) {
    for (let i = 0; i < out.length; ) {
      if (out[i].level < level) { i++; continue; }
      let j = i;
      while (j < out.length && out[j].level >= level) j++;
      out.splice(i, j - i, ...out.slice(i, j).reverse());
      i = j;
    }
  }
  return out;
}

function shape(text: string, baseRtl: boolean, fonts: Fonts): Run[] {
  return visualOrder(splitPieces(text, baseRtl, fonts.canLatin)).map((piece): Run => {
    const rtl = piece.level % 2 === 1;
    if (piece.kind === "arabic") {
      const { glyphs, positions } = fonts.fk.layout(piece.text, undefined, "arab", undefined, rtl ? "rtl" : "ltr");
      return { kind: "arabic", glyphs, positions };
    }
    // A Latin piece at an odd level only happens for stray neutrals; put it in visual order
    return { kind: "latin", text: rtl ? [...piece.text].reverse().join("") : piece.text };
  });
}

function runWidth(run: Run, size: number, fonts: Fonts): number {
  if (run.kind === "latin") return fonts.latin.widthOfTextAtSize(run.text, size);
  const scale = size / fonts.fk.unitsPerEm;
  return run.positions.reduce((sum, p) => sum + p.xAdvance * scale, 0);
}

const lineWidth = (runs: Run[], size: number, fonts: Fonts) =>
  runs.reduce((sum, run) => sum + runWidth(run, size, fonts), 0);

// ---------- layout + drawing ----------

interface Line {
  text: string;
  rtl: boolean;
}

/** Greedy word wrap of one paragraph to maxWidth. */
function wrap(text: string, rtl: boolean, size: number, maxWidth: number, fonts: Fonts): Line[] {
  const measure = (s: string) => lineWidth(shape(s, rtl, fonts), size, fonts);
  const lines: Line[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate) > maxWidth) {
      lines.push({ text: current, rtl });
      current = word;
    } else current = candidate;
  }
  if (current) lines.push({ text: current, rtl });
  return lines;
}

function drawLine(page: PDFPage, line: Line, baselineTop: number, size: number, fonts: Fonts): void {
  const runs = shape(line.text, line.rtl, fonts);
  const y = page.getHeight() - baselineTop;
  let x = RIGHT_INK_X - lineWidth(runs, size, fonts);

  const keys = new Map<PDFFont, PDFName>();
  const keyFor = (font: PDFFont) => {
    let key = keys.get(font);
    if (!key) keys.set(font, (key = page.node.newFontDictionary(font.name, font.ref)));
    return key;
  };

  const ops = [pushGraphicsState(), setFillingGrayscaleColor(0)];
  for (const run of runs) {
    if (run.kind === "latin") {
      ops.push(beginText(), setFontAndSize(keyFor(fonts.latin), size), setTextMatrix(1, 0, 0, 1, x, y));
      ops.push(showText(fonts.latin.encodeText(run.text)), endText());
      x += runWidth(run, size, fonts);
      continue;
    }
    const scale = size / fonts.fk.unitsPerEm;
    ops.push(beginText(), setFontAndSize(keyFor(fonts.arabic), size));
    run.glyphs.forEach((glyph, i) => {
      const pos = run.positions[i];
      const subsetId = fonts.embedder.subset.includeGlyph(glyph);
      fonts.embedder.glyphs[subsetId - 1] = glyph;
      fonts.embedder.glyphIdMap.set(glyph.id, subsetId);
      const hex = subsetId.toString(16).padStart(4, "0");
      ops.push(setTextMatrix(1, 0, 0, 1, x + pos.xOffset * scale, y + pos.yOffset * scale));
      ops.push(showText(PDFHexString.of(hex)));
      x += pos.xAdvance * scale;
    });
    ops.push(endText());
  }
  ops.push(popGraphicsState());
  page.pushOperators(...ops);
  // pdf-lib builds the font's width table lazily from the subset; refresh it after new glyphs
  fonts.embedder.glyphCache.invalidate();
}

async function loadFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const arabic = await doc.embedFont(new Uint8Array(arabicFontData), { subset: true });
  const latin = await doc.embedFont(StandardFonts.Helvetica);
  const embedder = (arabic as unknown as { embedder: SubsetEmbedder }).embedder;
  const cache = new Map<number, boolean>();
  const canLatin = (cp: number) => {
    let ok = cache.get(cp);
    if (ok === undefined) {
      try {
        latin.encodeText(String.fromCodePoint(cp));
        ok = true;
      } catch {
        ok = false;
      }
      cache.set(cp, ok);
    }
    return ok;
  };
  return { arabic, latin, canLatin, fk: embedder.font, embedder };
}

/** Stamp the merchant name and reference under the invoice table; returns the new PDF. */
export async function stampInvoice(source: Uint8Array, merchant: string, reference: string): Promise<Uint8Array> {
  const merchantText = merchant.trim();
  const referenceText = reference.trim();

  const tableBottom = (await readTableBottom(source)) ?? FALLBACK_TABLE_BOTTOM;
  const top = tableBottom + GAP_BELOW_TABLE;
  const maxWidth = RIGHT_MARGIN_X - LEFT_LIMIT_X;
  const boxHeight = FOOTER_TOP_Y - top;

  const doc = await PDFDocument.load(source);
  const page = doc.getPage(0);

  if (merchantText || referenceText) {
    const fonts = await loadFonts(doc);

    // Shrink the text (down to 50%) until it fits the space between the table and the footer
    for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale -= 0.05) {
      const size = FONT_SIZE_PT * scale;
      const lineHeight = size * LINE_HEIGHT;
      const lines: Line[] = [];
      if (merchantText) lines.push(...wrap(merchantText, true, size, maxWidth, fonts));
      if (referenceText) lines.push({ text: referenceText, rtl: false });

      const fits =
        lines.length * lineHeight <= boxHeight &&
        lines.every((l) => lineWidth(shape(l.text, l.rtl, fonts), size, fonts) <= maxWidth);
      if (!fits) continue;

      lines.forEach((line, i) =>
        drawLine(page, line, top + lineHeight * i + lineHeight * BASELINE_IN_LINE, size, fonts),
      );
      return doc.save();
    }
    throw new Error("النص أطول من المساحة المتاحة في الفاتورة");
  }
  return doc.save();
}
