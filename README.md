# Stashdrop

> Everything you've kept, in one place.

Stashdrop is a local-first bookmarking app with a canvas desk. Keep a link — an article, video, image, PDF, repo, screenshot — and it lands on an infinite canvas as a card. AI running on your own machine files it into a pile, tags it, and describes why you kept it.

## Features

- **Canvas desk** — saved links and notes float on an infinite canvas, arranged into piles. Drag to reposition; positions persist.
- **Piles** — items are filed into clusters (Local-first & sync, Creator video, Type & print, Unsorted, …) with a "why it belongs here" note.
- **Capture by URL** — paste a link and Stashdrop fetches the page server-side, detects its kind, and drops a card immediately; a background pass enriches it while you watch.
- **Local AI enrichment** — Ollama (running locally) summarizes the page, picks tags, chooses a pile, and pulls notable highlights.
- **Semantic search & related links** — every item gets an embedding; search matches by meaning, and items link to the nearest neighbors in your stash.
- **Sticky notes & comments** — drop freeform notes on the canvas, and attach discussion threads to any card.
- **Workspaces** — a personal space plus teams (organizations) with invites, owner/admin/member roles, and per-workspace stashes.
- **Trash** — remove and restore, with a soft-delete + empty-trash flow.

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router) + React 19 + TypeScript
- [better-auth](https://www.better-auth.com) — email + password, email-OTP verification, organizations
- SQLite via `node:sqlite` (`stashdrop.db`) — one database for both auth and app data
- [Ollama](https://ollama.com) — local LLM for enrichment and embeddings
- [nodemailer](https://nodemailer.com) — verification codes and team invites over SMTP

## Prerequisites

- Node.js (for `node:sqlite`)
- [pnpm](https://pnpm.io) (`packageManager: pnpm@11.24.0`)
- [Ollama](https://ollama.com) running locally (for AI enrichment/search — the app works without it, just without the AI pass)

## Getting started

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create `.env.local` from the example and fill in the values:

   ```bash
   cp .env.local.example .env.local
   ```

   | Variable | Purpose |
   | --- | --- |
   | `OLLAMA_URL` | Base URL of your local Ollama instance |
   | `OLLAMA_MODEL` | Model used for enrichment (chat) |
   | `BETTER_AUTH_SECRET` | Session-signing secret (any random string) |
   | `BETTER_AUTH_URL` | Public base URL of the app |
   | `SMTP_SERVER` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` | SMTP relay for verification codes and invites |

   To use semantic search you'll also want an embedding model (defaults to `nomic-embed-text`) — pull it with `ollama pull nomic-embed-text`.

3. Run the development server:

   ```bash
   pnpm dev
   ```

4. Open [http://localhost:3000](http://localhost:3000).

On first boot the app creates the SQLite database, runs better-auth migrations, and seeds a signed-in-able demo workspace (see `seedDemoWorkspace` in `lib/db.ts`). A demo account is available:

- Email: `ashwincherian.spam+demo@gmail.com`
- Password: `demo1234`

> `BETTER_AUTH_SECRET` has no default — the app expects you to provide one. Emails are only sent once `SMTP_SERVER` etc. are set.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the dev server |
| `pnpm dev:clean` | Delete the local DB and start fresh |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm lint` | ESLint |

## Project structure

```
app/           Routes and UI — Canvas (desk), Onboarding, auth pages, settings modals
lib/           Server logic — db.ts (schema + queries), actions.ts (server actions),
               auth.ts (better-auth config), ollama/embeddings (AI),
               fetchMeta (page capture), mailer (SMTP)
proxy.ts       Route protection (Next 16's renamed middleware) — redirects
               unauthenticated visitors to /sign-in
stashdrop.db   SQLite database (generated, not committed)
```

Note: this repo is on Next.js 16, which has breaking changes from earlier versions (e.g. `proxy.ts` in place of `middleware.ts`). Read the bundled docs in `node_modules/next/dist/docs/` before making changes.

## Learn more

- [Next.js documentation](https://nextjs.org/docs)
- [better-auth documentation](https://www.better-auth.com)
- [Ollama documentation](https://docs.ollama.com)