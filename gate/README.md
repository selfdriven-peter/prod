# pages-gate

Password gate for the private vault repo, on Cloudflare Workers.
A port of the `selfdriven-studio-secure` / `archy-studio-secure` AWS Lambda gate.

**Setup instructions are in the repo root README** — this file is the technical
detail behind them.

## Request flow

```
GET  /              → the gate screen (page name + password)
GET  /robots.txt    → Disallow: /
POST /              → { page, password } → validate → fetch → HTML
```

On POST:

1. `sanitisePage` — letters, numbers, hyphens, underscores, max 120 chars.
   Blocks path traversal.
2. `resolveProject` — project key is everything before the first hyphen in the
   page name. Looked up in the `PROJECTS` secret to get `{ code, passwords }`.
3. Password compared against the project's list with a constant-time byte
   compare. A wrong password and an unknown project return the **same** message
   after the same 400ms delay, so the gate doesn't confirm which page names exist.
4. File fetched from `REPO_BASE/<code>-<key>/<page>.html` via the GitHub
   Contents API with `Accept: application/vnd.github.raw+json`.
5. `rewriteLinks` rewrites relative and absolute `.html` hrefs to
   `GATE_URL/#<page>`, leaving `http(s)://` and `#`-only hrefs alone.

## Differences from the Lambda original

| | Lambda | this |
|---|---|---|
| Secrets | `settings.json`, committed in plaintext | Worker secrets, nothing in source |
| Password compare | `Set.has()` | constant-time byte compare |
| Wrong password vs unknown project | different messages | same message |
| Headers | `Referrer-Policy` only on archy fork | full set incl. `X-Robots-Tag: noindex` |
| `robots.txt` | none | `Disallow: /` |
| Page name length | unbounded | 120 chars |

Link rewriting, project resolution, `#page` hash pre-fill, `pp_pw_<key>`
localStorage persistence and the 400ms failed-auth delay all behave the same.

## Bindings

Secrets (`npx wrangler secret put <NAME>`):

| Name | Value |
|---|---|
| `GH_TOKEN` | Fine-grained PAT, read-only Contents, vault repo only |
| `PROJECTS` | `{"peter":{...},"russ":{...}}` — one entry per person |

Vars (`wrangler.toml`, not secret):

| Name | Value |
|---|---|
| `REPO_BASE` | `https://api.github.com/repos/selfdriven-peter/lab/contents/vault` |
| `GATE_TITLE` | Browser tab title |
| `GATE_URL` | This Worker's public origin, used for link rewriting |

`passwords` is an array, so you can run two valid passwords during a rotation
and drop the old one once everyone's moved.

## Tests

```bash
npm test
```

11 checks against the handler with a stubbed GitHub: gate rendering, security
headers, `robots.txt`, the vault path the gate builds, link rewriting,
wrong-password refusal, indistinguishable error messages, path traversal,
missing pages, missing passwords, and failing closed when unconfigured.

## Local development

```bash
cp .dev.vars.example .dev.vars    # fill in a real token + code
npm install
npm run dev                       # http://localhost:8787
```

`.dev.vars` is gitignored.

## Deploy

```bash
npx wrangler deploy
npx wrangler tail     # live logs
```

## If it breaks

| Symptom | Cause |
|---|---|
| "Gate is not configured" | `GH_TOKEN` or `PROJECTS` secret missing |
| "Unknown page" on a name you know is right | page name has no hyphen, or the prefix isn't a key in `PROJECTS` |
| "Page not found" | file isn't at `vault/<code>-<key>/<page>.html` in the vault, or isn't pushed |
| "Could not retrieve page" | token expired, revoked, or lacks Contents read on the vault repo |
| Links inside a page go nowhere | `GATE_URL` in `wrangler.toml` doesn't match the deployed URL |
