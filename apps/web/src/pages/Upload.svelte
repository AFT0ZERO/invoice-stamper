<script lang="ts">
  import { onMount } from "svelte";
  import { EXCEL_ACCEPT, type MasterInfo } from "@stamper/shared";
  import { analyzeInvoice, getMaster, uploadExcel } from "../lib/api";
  import { pool, safePdfName } from "../lib/export";
  import type { Row } from "../lib/types";

  let { onanalyzed }: { onanalyzed: (rows: Row[]) => void } = $props();

  let master = $state<MasterInfo | null>(null);
  let error = $state("");
  let busy = $state(false);
  let progress = $state("");
  let excelFiles = $state<FileList | null>(null);
  let pdfFiles = $state<FileList | null>(null);

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  onMount(async () => {
    try {
      master = await getMaster();
    } catch (e) {
      error = message(e);
    }
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = "";
    const pdfs = Array.from(pdfFiles ?? []).filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      error = pdfFiles?.length ? "لم يتم رفع أي ملف PDF" : "اختر فاتورة واحدة على الأقل";
      return;
    }

    busy = true;
    try {
      const excel = excelFiles?.[0];
      if (excel) {
        progress = "جارٍ رفع ملف الإكسل…";
        master = await uploadExcel(excel);
      } else if (!master) {
        throw new Error("ارفع ملف الإكسل أولاً");
      }

      let done = 0;
      const used = new Set<string>();
      const names = pdfs.map((f) => safePdfName(f.name, used));
      const results = await pool(
        pdfs.map((file) => async () => {
          const result = await analyzeInvoice(file);
          progress = `جارٍ قراءة الفواتير… ${++done} / ${pdfs.length}`;
          return result;
        }),
        4,
      );

      onanalyzed(
        results.map((result, i) => ({
          file: pdfs[i],
          name: names[i],
          result,
          merchant: result.merchant,
          reference: result.reference,
          skip: result.already_stamped, // never stamp twice by default
        })),
      );
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
      progress = "";
    }
  }
</script>

{#if error}<div class="error">{error}</div>{/if}

<form class="card" onsubmit={submit}>
  <h2>رفع الفواتير</h2>

  <label class="field" for="excel">ملف الإكسل</label>
  <input id="excel" type="file" accept={EXCEL_ACCEPT} bind:files={excelFiles} />
  <div class="hint">
    البوليصة في العمود C، والمرجع في D، واسم التاجر في E.
    {#if master}
      إذا لم تختر ملفاً سيُستخدم آخر ملف مرفوع:
      <b>{master.name}</b> ({master.uploaded} — {master.count} بوليصة).
    {:else}
      لم يُرفع أي ملف إكسل بعد.
    {/if}
  </div>

  <label class="field" for="pdfs">الفواتير (PDF)</label>
  <input id="pdfs" type="file" accept=".pdf" multiple required bind:files={pdfFiles} />
  <div class="hint">يمكنك اختيار عدة فواتير مرة واحدة.</div>

  <div class="actions">
    <button type="submit" disabled={busy}>متابعة للمراجعة</button>
    {#if progress}<span class="progress">{progress}</span>{/if}
  </div>
</form>
