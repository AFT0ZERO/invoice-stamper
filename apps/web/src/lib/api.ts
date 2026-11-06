import { ROUTES, type AnalyzeResult, type ApiError, type MasterInfo } from "@stamper/shared";

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch {
    throw new Error("تعذّر الاتصال بالخادم");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error || `خطأ من الخادم (${res.status})`);
  }
  return res;
}

export async function getMaster(): Promise<MasterInfo | null> {
  return (await call(ROUTES.master)).json();
}

export async function uploadExcel(file: File): Promise<MasterInfo> {
  const form = new FormData();
  form.set("excel", file);
  return (await call(ROUTES.excel, { method: "POST", body: form })).json();
}

export async function analyzeInvoice(file: File): Promise<AnalyzeResult> {
  const form = new FormData();
  form.set("pdf", file);
  return (await call(ROUTES.analyze, { method: "POST", body: form })).json();
}

/** Returns the stamped PDF bytes. */
export async function stampInvoice(file: File, merchant: string, reference: string): Promise<Uint8Array> {
  const form = new FormData();
  form.set("pdf", file);
  form.set("merchant", merchant);
  form.set("reference", reference);
  const res = await call(ROUTES.stamp, { method: "POST", body: form });
  return new Uint8Array(await res.arrayBuffer());
}
