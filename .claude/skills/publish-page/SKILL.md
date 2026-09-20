---
name: publish-page
description: Publish a page to Pete's pages site — public on GitHub Pages, or password-gated in the private vault. Scaffolds the page from the house template with its catalogue metadata, rebuilds docs/data/catalogue.js, previews it, and commits and pushes both repos. Use whenever the user wants to add, publish, update, rename, move, lock, unlock or remove a page, asks "put this on my site", "publish this", "make this private", "add it to the index", or wants to know what is on the site. Not for editing the index board's own design (that is docs/index.html by hand) and not for the password gate's code (that is gate/).
---

# Publishing a page

## The model

Two repos, one index.

| | Repo | Visibility | Holds |
|---|---|---|---|
| Shelf | `prod` | **public** | `docs/index.html`, `docs/pages/*.html` |
| Vault | `lab` | **private** | `docs/pages/<code>-<key>/<key>-*.html` |

**The page is the source of truth. The catalogue is derived.** Each page
declares itself in its own `<head>`; `tools/catalogue.py` scans both repos and
writes `docs/data/catalogue.js`. Never hand-edit that file and never hand-edit
the site list inside `docs/index.html` — both are generated or read-only.

**Public vs locked is decided by which repo the file is in, never by a tag.**
A page in `prod` is readable by anyone on earth the moment it is pushed. A page
in `lab` is only reachable through the gate, after a password.

## Before anything else

Read `catalogue.json` for the groups, the vault path and the gate URL. Never
hardcode the access code or the vault folder name — read them from the
filesystem (`ls ../lab/docs/pages`) so a rotated code just works.

## Publishing a page

### 1. Settle four things

Ask only what you cannot infer from the request or the content:

- **Public or locked?** If there is any doubt, ask. Getting this wrong in the
  public direction cannot be undone — assume the person shared a link.
- **Which group?** From `catalogue.json`. Locked pages are always `vault`.
- **Title, one-line description, tag, call to action.** Draft these from the
  content and show them rather than interrogating; they are easy to change.
- **Tone and icon.** Pick from the existing pages' conventions:
  `chill` `caring` `gold` `constructive` `curious`, and any `ic-*` symbol in
  the sprite at the top of `docs/index.html`. If nothing fits, add a new
  `<symbol>` to that sprite rather than settling for `ic-page`.

### 2. Name the file

- **Public** → `docs/pages/<slug>.html`, kebab-case, descriptive, no date.
  It is a permanent URL — the site's whole promise is that links keep working.
  **Never rename or move an existing public page.** If a name is genuinely
  wrong, add the new one and leave a redirect stub at the old path.
- **Locked** → `../lab/docs/pages/<code>-<key>/<key>-<slug>.html`. The
  `<key>-` prefix is mandatory; the gate resolves the folder from it, so a file
  without it is invisible. `catalogue.py --list` warns about this.

### 3. Write it

Start from `templates/page.html` and substitute the placeholders
(`{{TITLE}}`, `{{GROUP}}`, `{{TONE}}`, `{{TONE_VAR}}`, `{{ICON}}`, `{{TAG}}`,
`{{LINE}}`, `{{CTA}}`, `{{HOME}}`, `{{ASSETS}}`, `{{ROBOTS}}`).

| Placeholder | Public | Locked |
|---|---|---|
| `{{HOME}}` | `../index.html` | the gate URL from `catalogue.json` |
| `{{ASSETS}}` | `../assets` | absolute `https://selfdriven-peter.github.io/prod/docs/assets` |
| `{{ROBOTS}}` | *(empty)* | `<meta name="robots" content="noindex, nofollow">` |
| `{{TONE_VAR}}` | `chill` `caring` `gold` `constructive` `curious` | same |

Keep every page a single self-contained HTML file — inline CSS and JS, no build
step, no framework. Page-specific images go in `docs/assets/pages/<slug>/`.
Match the house palette the template sets up; do not invent a new one.

If the user supplied content, use it. Do not pad it out, and do not invent
facts — dates, names, prices and rules are theirs, not yours.

### 4. Rebuild and check

```bash
python3 tools/catalogue.py            # rebuild
python3 tools/catalogue.py --list     # confirm it landed in the right group
```

Treat every warning as a defect and fix it. Then open `docs/index.html` with
`open` so the person can see the row, and say what to look for.

### 5. Commit and push — ask first

Pushing `prod` publishes to the internet. Confirm before the first push of any
new page, even if told to "just do it" earlier in the session — that permission
was about the work, not about this page's contents.

```bash
git -C . add -A && git commit && git push                      # prod
git -C ../lab add docs/pages && git commit && git push          # lab
```

In `lab`, **only ever stage `docs/pages`**. That repo has unrelated work in
progress and sweeping it up with `git add -A` would commit things the person
did not mean to commit.

Locked pages need no deploy — the gate reads the vault live. Only redeploy
(`cd gate && npx wrangler deploy`) if `gate/` or `wrangler.toml` changed.

## Other jobs

**What is on the site?** → `python3 tools/catalogue.py --list`.

**Lock a page that is currently public.** Move the file to the vault, rename it
with the `<key>-` prefix, rebuild, push both. Then say plainly: it was public,
so treat anything in it as already seen, and the old URL will now 404 for
people who bookmarked it.

**Unlock a locked page.** Move it to `docs/pages/`, drop the `<key>-` prefix and
the `robots` tag, rebuild, push. Confirm first — this is irreversible in
practice.

**Remove a page.** Delete the file, rebuild, push. Warn that the URL will 404
for anyone holding the link.

**A new person with their own password.** New folder
`../lab/docs/pages/<new-8-char-code>-<name>/`, files prefixed `<name>-`. Then
the `PROJECTS` secret must be updated — that needs the person to run
`cd gate && npx wrangler secret put PROJECTS` themselves with every project in
one JSON line. Give them the exact line to paste.

**A new group.** Add it to `catalogue.json` with an `order`, rebuild. The tab
appears automatically and stays hidden while empty.

## Rules that are not negotiable

- Never put a page meant to be private in `prod`. Check twice.
- Never paste the access code into anything in `prod` — it is public. It lives
  in the vault folder name and in `lab/docs/pages/README.md`.
- Never hand-edit `docs/data/catalogue.js`.
- Never rename or delete an existing public page without saying the links break.
- Never `git add -A` in `lab`.
