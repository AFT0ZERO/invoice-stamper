import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { AnalyzeResult, InvoiceStatus, MasterInfo } from "@stamper/shared";
import { ROUTES } from "@stamper/shared";
import { lookup, readExcel, type ExcelRows } from "./excel";
import { readInvoice } from "./pdf-read";
import { stampInvoice } from "./stamp";

export interface Env {
  /** Stores the parsed master Excel data (persistent, shared by all users). */
  MASTER: KVNamespace;
  /** Comma-separated list of allowed web origins; `*` (the default) allows any. */
  ALLOWED_ORIGINS?: string;
  /** Per-file upload limit in MB (default 100, Cloudflare's own request limit). */
  MAX_UPLOAD_MB?: string;
}

const KV_ROWS = "master:rows";
const KV_META = "master:meta";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({
    origin: allowed.includes("*") ? "*" : allowed,
    allowMethods: ["GET", "POST", "OPTIONS"],
    maxAge: 86400,
  })(c, next);
});

/** Errors reach the web app as `{ error }` so it can show the message directly. */
app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "حدث خطأ غير متوقع في الخادم" }, 500);
});

app.notFound((c) => c.json({ error: "غير موجود" }, 404));

// ---------------- helpers ----------------

const fail = (status: 400 | 413 | 422, message: string) => new HTTPException(status, { message });

function maxUploadBytes(env: Env): number {
  return (Number(env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
}

async function formParts(req: Request, env: Env, field: string) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw fail(400, "طلب غير صالح");
  }
  const file = form.get(field) as File | string | null;
  if (!file || typeof file === "string" || !file.name) throw fail(400, "لم يتم اختيار ملف");
  if (file.size > maxUploadBytes(env)) throw fail(413, "حجم الملف كبير جداً");
  return { file, form };
}

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------- routes ----------------

app.get(ROUTES.health, (c) => c.text("ok"));

app.get(ROUTES.master, async (c) => c.json(await c.env.MASTER.get<MasterInfo>(KV_META, "json")));

app.post(ROUTES.excel, async (c) => {
  const { file } = await formParts(c.req.raw, c.env, "excel");
  const excel = readExcel(new Uint8Array(await file.arrayBuffer()));
  if (excel.error) throw fail(422, excel.error);

  const meta: MasterInfo = {
    name: file.name,
    uploaded: nowLocal(),
    count: Object.keys(excel.rows).length,
  };
  await c.env.MASTER.put(KV_ROWS, JSON.stringify(excel.rows));
  await c.env.MASTER.put(KV_META, JSON.stringify(meta));
  return c.json(meta);
});

app.post(ROUTES.analyze, async (c) => {
  const { file } = await formParts(c.req.raw, c.env, "pdf");
  const rows = await c.env.MASTER.get<ExcelRows>(KV_ROWS, "json");
  if (!rows) throw fail(400, "ارفع ملف الإكسل أولاً");

  const info = await readInvoice(new Uint8Array(await file.arrayBuffer()));
  const matches = info.error ? [] : lookup(rows, info.billOfLading);

  let status: InvoiceStatus;
  if (info.error) status = "error";
  else if (!matches.length) status = "missing";
  else if (matches.length > 1) status = "multiple";
  else status = "ok";

  const result: AnalyzeResult = {
    original: file.name,
    invoice_no: info.invoiceNo,
    bl: info.billOfLading,
    error: info.error,
    status,
    already_stamped: info.alreadyStamped,
    matches,
    merchant: matches[0]?.[0] ?? "",
    reference: matches[0]?.[1] ?? "",
  };
  return c.json(result);
});

app.post(ROUTES.stamp, async (c) => {
  const { file, form } = await formParts(c.req.raw, c.env, "pdf");
  const merchant = text(form, "merchant");
  const reference = text(form, "reference");

  let stamped: Uint8Array;
  try {
    stamped = await stampInvoice(new Uint8Array(await file.arrayBuffer()), merchant, reference);
  } catch (e) {
    throw fail(422, e instanceof Error ? e.message : "تعذّر ختم الفاتورة");
  }
  return new Response(stamped, {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
  });
});

export default app;
