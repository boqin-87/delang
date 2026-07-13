# delang

delang turns any article URL into a clean, translated reading page. One Cloudflare Worker serves a Vite-built React SPA and does server-side extraction (defuddle) + translation (Gemini).

- **Stack:** React 19 · Vite 8 · `@cloudflare/vite-plugin` · Tailwind 4 · shadcn (base-nova) · Biome · Vitest.
- **Worker entry:** `worker/index.ts`. **SPA:** `src/` + `index.html`. **Built client assets:** `dist/client/` (the `assets.directory`).
- **Secrets:** `GEMINI_API_KEY` (locally via `.dev.vars`, remotely via `wrangler secret`).

---

## How routing works

`wrangler.jsonc` sets `assets.run_worker_first: true` + `not_found_handling: "single-page-application"`, so every request hits `worker/index.ts` first. `parseRoute()` (in `worker/index.ts`, unit-tested) then decides:

| URL path                       | Behavior                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `/`, `/index.html`, asset files | Served by `env.ASSETS` (SPA fallback returns `index.html`).         |
| `/<url>`                        | Render: extract the URL → return HTML (no translation).             |
| `/<lang>/<url>`                | Tagged render: extract → translate title + body into `<lang>`.     |

Tagged renders inject the result as `<script id="delang-result" type="application/json">` into the SPA shell (fetched via `env.ASSETS` so hashed built assets are reused), then hydrate. The H1 and body are translated in parallel Gemini calls so a large body can't crowd out the title.

> Known wrinkle: a bare tag with no URL (e.g. `/zh`, `/meow`) falls through to the SPA, because `normalizeTarget` requires an `https?://` scheme or a `.` in the host before the first `/`.

---

## Getting started

```bash
pnpm install
pnpm dev          # vite dev (Worker runs via @cloudflare/vite-plugin)
```

Create your local secrets file (gitignored):

```bash
cp ".dev copy.example" .dev.vars   # then fill in GEMINI_API_KEY="..."
```

`.dev.vars` holds `GEMINI_API_KEY` for local dev. It's gitignored (`.dev.vars*` is ignored, `.dev.vars.example` is kept).

---

## Scripts

| Script              | What it does                                              |
| ------------------- | -------------------------------------------------------- |
| `pnpm dev`          | Vite dev server with the Worker running locally.         |
| `pnpm build`        | Type-check-free Vite build → `dist/client` + Worker bundle. |
| `pnpm test`         | `vitest run` — unit tests for `parseRoute` / `languageForTag`. |
| `pnpm check`        | Biome lint + format, writing fixes.                      |
| `pnpm cf-typegen`   | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc`. |
| `pnpm deploy`       | `vite build && wrangler deploy` (no custom-domain route). |
| `pnpm deploy:personal` | `vite build && wrangler deploy --config wrangler.personal.jsonc` (your custom domain). |

---

## Deployment

delang deploys as a single Worker. The committed `wrangler.jsonc` is shared and contains **no `routes`**, so `pnpm deploy` pushes to a route-less Worker (reachable on its `workers.dev` subdomain). Your personal custom-domain route (e.g. `delang.eflx.top`) lives in a gitignored file and is never committed.

### First-time setup

1. Copy the example and edit the route to your domain:

   ```bash
   cp wrangler.personal.jsonc.example wrangler.personal.jsonc
   # edit wrangler.personal.jsonc: set "pattern" under "routes" to your domain
   ```

   `wrangler.personal.jsonc` is gitignored (`.gitignore` ignores it, keeps the `.example`).

2. Set the production secret:

   ```bash
   wrangler secret put GEMINI_API_KEY
   # paste the value from your .dev.vars
   ```

   Verify it's set: `wrangler secret list`.

### Deploy

```bash
pnpm deploy:personal   # build + deploy Worker with your custom-domain route
```

### Authentication

`wrangler deploy` / `wrangler secret put` need Cloudflare auth. Do one of:

- `wrangler login` in an interactive terminal, **or**
- `export CLOUDFLARE_API_TOKEN=<token>` in the environment.

### What each deploy path does

- **`pnpm deploy`** (committed `wrangler.jsonc`, no routes): `@cloudflare/vite-plugin` generated `.wrangler/deploy/config.json`, which **redirects** `wrangler deploy` to the pre-built `dist/delang/wrangler.json`. You'll see `Using redirected Wrangler configuration` in the output. Good for a route-less/`workers.dev` preview deploy and for anyone who forks the repo.
- **`pnpm deploy:personal`** (`wrangler.personal.jsonc`, your route): `--config` reads that file **directly** (no redirect), so your `routes` field is what gets sent to Cloudflare and your custom domain is attached on deploy.

If you just want to check a build without deploying, dry-runs need no auth:

```bash
pnpm exec wrangler deploy --dry-run                        # committed config
pnpm exec wrangler deploy --config wrangler.personal.jsonc --dry-run
```

> Note: `--config` must point at a **recognized** config filename (`wrangler.personal.jsonc`, not `wrangler.personal.jsonc.example`). The `.example` extension isn't loaded by wrangler — that's why you copy it to the real name first.

## Acknowledgement

- [Defuddle](https://github.com/kepano/defuddle)
- [Streamup](https://github.com/OpticLM/streamup)
- [shadcn/typeset](https://ui.shadcn.com/typeset)
- [Vite](https://vite.dev/)
- [Cloudflare](https://cloudflare.com)
- [LINUX DO](https://linux.do)