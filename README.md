# Invoice Stamper

Writes the **merchant name** and **reference number** under the table of ACT invoices (PDF), looked
up from an Excel file by the invoice's bill of lading. TypeScript port of the original Flask app.

| Package | What | Runs on |
|---|---|---|
| `apps/api` | Hono API: reads Excel, reads and stamps PDFs (pdf-lib, fontkit, pdf.js) | Cloudflare Workers |
| `apps/web` | Svelte UI: upload, review, download ZIP (PDF or JPG) | Cloudflare Pages |
| `packages/shared` | Types and route names used by both | |

The master Excel file is stored in Workers KV. Invoices are never stored: each PDF is sent to the
API, analysed or stamped in memory, and returned. The ZIP and the JPG rendering happen in the browser.

## Local development

```
npm install
npm run dev        # API on :8787 (wrangler dev) + web on :5173 (Vite proxies /api to the API)
npm run typecheck
```

Open http://localhost:5173.

## Deploy

Requires a Cloudflare account and `npx wrangler login`.

> **Workers plan:** parsing PDFs takes more than the 10 ms CPU limit of the Workers Free plan, so
> the API needs the **Workers Paid** plan (the default 30 s CPU limit is far more than needed).

1. **API**
   ```
   npm run deploy:api
   ```
   The first deploy creates the `MASTER` KV namespace automatically. Note the printed URL,
   e.g. `https://invoice-stamper-api.<subdomain>.workers.dev`.

2. **Web** (Pages). Build with the API URL baked in, then deploy:
   ```
   # PowerShell
   $env:VITE_API_URL = "https://invoice-stamper-api.<subdomain>.workers.dev"
   npm run deploy:web
   ```
   Or connect the repo in the Pages dashboard with build command
   `npm run build -w @stamper/web`, output directory `apps/web/dist`, Node 22+, and the
   `VITE_API_URL` environment variable.

3. **Lock down CORS.** In [apps/api/wrangler.toml](apps/api/wrangler.toml) set
   `ALLOWED_ORIGINS` to your Pages URL (e.g. `https://invoice-stamper.pages.dev`) and redeploy the API.

The app has **no login**. Before exposing it publicly, put both the Pages site and the Worker behind
Cloudflare Access (Zero Trust), or add your own authentication.

## Excel layout

Fixed columns, no header row: **C** bill of lading, **D** reference, **E** merchant (a `/` in the
name is removed). Change the columns in [apps/api/src/excel.ts](apps/api/src/excel.ts).

## Stamp appearance

Constants at the top of [apps/api/src/stamp.ts](apps/api/src/stamp.ts): `FONT_SIZE_PT`,
`GAP_BELOW_TABLE`, margins. JPG DPI and quality are in
[packages/shared/src/index.ts](packages/shared/src/index.ts). Arabic uses the bundled Noto Sans
Arabic font; Latin text and digits use Helvetica.

## Differences from the Flask app

- Invoices and jobs are not stored on a server (no 6-hour job folder); everything is per request.
- JPG export is rendered in the browser (pdf.js) instead of on the server.
- The Arabic font is Noto Sans Arabic (the Flask app used MuPDF's Noto Naskh), so letter shapes
  differ slightly.
- "Already stamped" detection also catches an invoice stamped with a name but no reference.
- No optional Basic Auth; use Cloudflare Access instead.
