import { zipSync } from "fflate";
import { JPG_DPI, JPG_QUALITY } from "@stamper/shared";

/** Same rules as werkzeug's secure_filename: ASCII letters, digits, `_`, `.`, `-` only. */
function secureFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[/\\]/g, " ")
    .trim()
    .split(/\s+/)
    .join("_")
    .replace(/[^A-Za-z0-9_.-]/g, "")
    .replace(/^[._]+|[._]+$/g, "");
}

/** A safe, unique `.pdf` name for an uploaded file ("F123.pdf", "F123_2.pdf", "invoice_3.pdf"). */
export function safePdfName(original: string, used: Set<string>): string {
  const base = original.replace(/\.[^.]*$/, "");
  const clean = secureFilename(base) || `invoice_${used.size + 1}`;
  let candidate = `${clean}.pdf`;
  for (let n = 2; used.has(candidate); n++) candidate = `${clean}_${n}.pdf`;
  used.add(candidate);
  return candidate;
}

/** Render each page of a PDF to a JPG: [page number, page count, bytes]. Runs in the browser. */
export async function pdfToJpgs(pdf: Uint8Array): Promise<[number, number, Uint8Array][]> {
  const pdfjs = await import("pdfjs-dist");
  const { default: workerSrc } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const doc = await pdfjs.getDocument({ data: pdf.slice() }).promise;
  const out: [number, number, Uint8Array][] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: JPG_DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff"; // JPG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPG_QUALITY));
      if (!blob) throw new Error("تعذّر تحويل الصفحة إلى صورة");
      out.push([n, doc.numPages, new Uint8Array(await blob.arrayBuffer())]);
      canvas.width = canvas.height = 0; // release the bitmap
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** Zip entries and trigger a download. `report.txt` gets a BOM so Excel/Notepad read it as UTF-8. */
export function downloadZip(entries: Record<string, Uint8Array>, report: string[], jpg: boolean): void {
  const text = new TextEncoder().encode(report.join("\n"));
  const reportBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...text]);
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const [name, bytes] of Object.entries(entries)) files[name] = [bytes, { level: jpg ? 0 : 6 }];
  files["report.txt"] = [reportBytes, { level: 6 }];

  const zip = zipSync(files);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;

  const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoices_${stamp}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Run async tasks with a concurrency limit; results keep the input order. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}
