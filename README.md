# Invoice Stamper

A monorepo with a web app and an API for stamping invoice PDFs.

## Structure

- `apps/web`: Svelte + Vite frontend
- `apps/api`: Cloudflare Worker API (Hono, pdf-lib, Wrangler)
- `packages/shared`: code shared between the web app and the API

## Requirements

- Node.js 22.12 or newer
- npm

## Setup

```sh
npm install
```

## Development

Start the API and the web app together:

```sh
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API and web app in development mode |
| `npm run build` | Builds the web app |
| `npm run typecheck` | Type-checks the API and web app |
| `npm run deploy:api` | Deploys the API Worker with Wrangler |
| `npm run deploy:web` | Builds the web app for deployment |
