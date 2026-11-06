<script lang="ts">
  import { stampInvoice } from "../lib/api";
  import { downloadZip, pdfToJpgs, pool } from "../lib/export";
  import type { Row } from "../lib/types";

  let { rows, onback }: { rows: Row[]; onback: () => void } = $props();

  // The table inputs bind to each row's fields, so work on a reactive copy of the initial rows
  // svelte-ignore state_referenced_locally
  const items = $state(rows);

  let busy = $state(false);
  let progress = $state("");
  let error = $state("");

  const count = (status: string) => items.filter((r) => r.result.status === status).length;
  let counts = $derived({
    ok: count("ok"),
    multiple: count("multiple"),
    missing: count("missing"),
    error: count("error"),
    stamped: items.filter((r) => r.result.already_stamped).length,
  });

  function pick(row: Row, value: string) {
    const [merchant, reference] = row.result.matches[Number(value)] ?? ["", ""];
    row.merchant = merchant;
    row.reference = reference;
  }

  interface Outcome {
    line: string;
    entries: [string, Uint8Array][];
  }

  async function generate(format: "pdf" | "jpg") {
    busy = true;
    error = "";
    let done = 0;
    progress = `جارٍ الختم… 0 / ${items.length}`;
    try {
      const outcomes = await pool<Outcome>(
        items.map((row) => async () => {
          const merchant = row.merchant.trim();
          const reference = row.reference.trim();
          const original = row.result.original;
          let outcome: Outcome;
          if (row.skip || (!merchant && !reference)) {
            outcome = { line: `${original}\tلم تُعدّل (فارغة أو مستثناة)`, entries: [] };
          } else {
            try {
              const stamped = await stampInvoice(row.file, merchant, reference);
              const entries: [string, Uint8Array][] = [];
              if (format === "pdf") {
                entries.push([row.name, stamped]);
              } else {
                const stem = row.name.replace(/\.pdf$/i, "");
                for (const [n, total, jpg] of await pdfToJpgs(stamped)) {
                  entries.push([`${stem}${total > 1 ? `_${n}` : ""}.jpg`, jpg]);
                }
              }
              outcome = { line: `${original}\t${merchant}\t${reference}`, entries };
            } catch (e) {
              // keep going with the rest of the batch
              outcome = { line: `${original}\tخطأ: ${e instanceof Error ? e.message : e}`, entries: [] };
            }
          }
          progress = `جارٍ الختم… ${++done} / ${items.length}`;
          return outcome;
        }),
        format === "jpg" ? 2 : 3,
      );

      const files: Record<string, Uint8Array> = {};
      for (const o of outcomes) for (const [name, bytes] of o.entries) files[name] = bytes;
      downloadZip(files, outcomes.map((o) => o.line), format === "jpg");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      progress = "";
    }
  }
</script>

{#if error}<div class="error">{error}</div>{/if}

<div class="card">
  <h2>مراجعة قبل الختم ({items.length} فاتورة)</h2>
  <div class="summary">
    <span class="badge b-ok">مطابقة: {counts.ok}</span>
    {#if counts.multiple}<span class="badge b-multiple">أكثر من نتيجة: {counts.multiple}</span>{/if}
    {#if counts.missing}<span class="badge b-missing">غير موجودة في الإكسل: {counts.missing}</span>{/if}
    {#if counts.stamped}<span class="badge b-multiple">مختومة سابقاً (مستثناة): {counts.stamped}</span>{/if}
    {#if counts.error}<span class="badge b-error">خطأ في الملف: {counts.error}</span>{/if}
  </div>
  <p class="info">
    يمكنك تعديل أي اسم أو مرجع قبل التنزيل. الفاتورة التي يبقى حقلاها فارغين أو التي تحددها "استثناء" لن تُضاف إلى الملف المضغوط.
  </p>

  <table>
    <thead>
      <tr>
        <th>#</th><th>رقم الفاتورة</th><th>البوليصة</th><th>الحالة</th>
        <th style="width: 24%">اسم التاجر</th><th style="width: 14%">رقم المرجع</th><th>استثناء</th>
      </tr>
    </thead>
    <tbody>
      {#each items as row, i (row.name)}
        <tr class="row-{row.result.status}">
          <td>{i + 1}</td>
          <td class="mono" title={row.result.original}>{row.result.invoice_no || row.result.original}</td>
          <td class="mono">{row.result.bl || "—"}</td>
          <td>
            {#if row.result.status === "ok"}<span class="badge b-ok">مطابقة</span>
            {:else if row.result.status === "multiple"}<span class="badge b-multiple">أكثر من نتيجة</span>
            {:else if row.result.status === "missing"}<span class="badge b-missing">غير موجودة</span>
            {:else}<span class="badge b-error" title={row.result.error}>{row.result.error}</span>{/if}
            {#if row.result.already_stamped}<br /><span class="badge b-multiple">مختومة سابقاً</span>{/if}
          </td>
          <td>
            <input type="text" bind:value={row.merchant} />
            {#if row.result.status === "multiple"}
              <select onchange={(e) => pick(row, e.currentTarget.value)}>
                {#each row.result.matches as match, m}
                  <option value={m}>{match[0]} — {match[1]}</option>
                {/each}
              </select>
            {/if}
          </td>
          <td><input type="text" dir="ltr" bind:value={row.reference} /></td>
          <td style="text-align: center"><input type="checkbox" bind:checked={row.skip} /></td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="actions">
    <button type="button" disabled={busy} onclick={() => generate("pdf")}>ختم وتنزيل PDF (ZIP)</button>
    <button type="button" disabled={busy} onclick={() => generate("jpg")}>ختم وتنزيل JPG (ZIP)</button>
    <button type="button" class="secondary" disabled={busy} onclick={onback}>رجوع</button>
    {#if progress}<span class="progress">{progress}</span>{/if}
  </div>
</div>
