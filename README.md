# Pete — pages

This is the site I publish pages from. It's two repos working together.

| | Repo | Who can see it | What's in it |
|---|---|---|---|
| **The shelf** | `selfdriven-peter/prod` (this one) | **Public** | The index page everyone lands on, plus pages that are fine for anyone to read |
| **The vault** | `selfdriven-peter/lab` | **Private** | Pages that need a password |

The index page lists both. Public pages link straight to the file. Private
pages show a padlock and link to a password gate, which fetches the real file
out of the private repo only after the password checks out.

---

## Why two repos

This is the part worth understanding, because it's the whole reason the
password means anything.

A password box on a public web page protects nothing. If a file sits in a
public repo, anyone can open it directly — they just need the URL, and Google
will happily find it for them. No amount of JavaScript in front of it changes
that.

So the private pages don't live in this repo at all. They live in `lab`, which
is private. Nobody on the internet can fetch them, with or without a password.
The only thing that *can* read them is the gate — a small program running on
Cloudflare that holds a GitHub token. You give it a page name and a password;
if both are right, it reads the file using its token and hands you the HTML.

That's the same design the selfdriven studio pages use. Theirs runs on AWS
Lambda; this one runs on a Cloudflare Worker, which does the same job for free.

---

## How the naming works

Your access code is written as `<CODE>` everywhere in this file. **The real
value is not in this repo** — this README is public, so putting the live
password in it would defeat the point. You'll find it in the private vault at:

```
lab/vault/README.md
```

It's also the name of the folder in `lab/vault/`. Wherever you see
`<CODE>` below, substitute that string.

That one string is both the folder name and the password.

```
lab/vault/<CODE>-peter/peter-welcome.html
               └───┬────┘ └┬─┘ └──┬───┘
                   │       │      └── page name — always starts with "peter-"
                   │       └───────── project key
                   └───────────────── access code = the password
```

When someone types `peter-welcome` into the gate, it takes everything before
the first hyphen (`peter`), looks that up to find the code (`<CODE>`),
checks the password against it, then goes and reads
`docs/pages/<CODE>-peter/peter-welcome.html`.

Share a page as `https://your-gate-url/#peter-welcome`. The gate pre-fills the
page name, so the person only has to type the password. It's remembered in
their browser after that, so other pages in the same project open without
asking again.

---

## What you need to do

I've written all the code. These are the five things only you can do, because
they need your accounts. About 15 minutes.

### 1. Make a Cloudflare account (free)

Go to <https://dash.cloudflare.com/sign-up>. Email and password, that's it.
You don't need to add a domain and you don't need a credit card.

### 2. Make a GitHub token so the gate can read the vault

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. **Token name**: `pages-gate`
3. **Expiration**: pick a date — a year is sensible. Put a reminder in your
   calendar, because the gate stops working the day it expires.
4. **Repository access**: choose **Only select repositories**, then pick
   **`selfdriven-peter/lab`** and nothing else.
5. **Permissions** → **Repository permissions** → find **Contents** and set it
   to **Read-only**. Leave everything else alone.
6. Click **Generate token** and copy what it shows you. You only get to see it
   once. Don't paste it into a file — you'll paste it into a terminal prompt in
   step 4, which doesn't save it anywhere.

### 3. Install the deploy tool

```bash
cd ~/GitHub/prod/gate
npm install
npx wrangler login
```

That last one opens your browser and asks you to allow it. Say yes.

### 4. Give the gate its two secrets

```bash
npx wrangler secret put GH_TOKEN
```

It'll prompt you — paste the GitHub token from step 2 and press enter.

```bash
npx wrangler secret put PROJECTS
```

Paste this exactly, all on one line, and press enter:

```
{"peter":{"code":"<CODE>","passwords":["<CODE>"]}}
```

These two live encrypted inside Cloudflare. They're never in any file and never
in either repo — which is why it's safe for all the gate's code to be public.

### 5. Deploy it

```bash
npx wrangler deploy
```

The first time, it asks you to pick a `workers.dev` subdomain. Choose something
like `selfdriven-peter`. When it finishes it prints your gate's address:

```
https://pages-gate.<whatever-you-chose>.workers.dev
```

**Copy that address**, then update it in two places:

- `gate/wrangler.toml` — the `GATE_URL` line
- `docs/index.html` — the `var GATE = '...'` line, near the bottom

Then run `npx wrangler deploy` once more so the gate knows its own address.

### 6. Check it worked

Open your gate address, type `peter-welcome` and the password `<CODE>`.
You should get a page saying "It works." That file is in the private repo, so
seeing it proves the whole chain is connected.

---

## Adding pages from now on

The list on the index page is **generated**. You never edit `index.html` again.
Each page says what it is in its own `<head>`, and a script collects them:

```html
<!-- catalogue -->
<meta name="sd:title" content="Poker Night">
<meta name="sd:group" content="other">
<meta name="sd:tone"  content="gold">
<meta name="sd:icon"  content="ic-spade">
<meta name="sd:tag"   content="soon">
<meta name="sd:line"  content="The where, the when, the buy-in and the house rules.">
<meta name="sd:cta"   content="Deal me in">
<meta name="sd:order" content="10">
<!-- /catalogue -->
```

### The easy way

```
/publish-page
```

The skill asks what the page is and whether it's public or private, writes it
from the house template, rebuilds the catalogue, shows you the result, and
offers to push. That's the whole job.

### The manual way

**A public page** — anyone can read it:

1. Copy `templates/page.html` to `docs/pages/my-thing.html` and write it.
2. Fill in the `sd:` tags at the top.
3. `python3 tools/catalogue.py`
4. Commit and push `prod`.

**A private page** — password required:

1. Copy the template to `lab/vault/<CODE>-peter/peter-my-thing.html`.
   The `peter-` prefix is what makes the gate find it.
2. Fill in the `sd:` tags, with `sd:group` set to `vault`.
3. `python3 tools/catalogue.py`
4. Commit and push **both** repos — `lab` for the page, `prod` for the
   catalogue entry that lists it.

You never redeploy the gate to add a page. It reads the vault live.

### The script

```bash
python3 tools/catalogue.py            # rebuild the catalogue
python3 tools/catalogue.py --list     # show everything, grouped
python3 tools/catalogue.py --check    # is it up to date? (for CI)
```

It warns you about the mistakes that are easy to make: a page with no group, a
vault file missing its prefix, a group that doesn't exist, or — the one that
matters — a page in the **public** repo claiming to be in the vault.

### Do I need a folder per page?

No. **One folder is one password, holding as many pages as you like.**

```
lab/vault/<CODE>-peter/          ← one folder, one password
    peter-welcome.html
    peter-plan.html
    peter-anything-else.html     ← just keep adding files
```

You only add a second folder when you want a **different password for a
different person**:

```
lab/vault/<other-code>-russ/
    russ-something.html          ← Russ's password, not yours
```

Then update the `PROJECTS` secret to list both (see the skill, or
`gate/README.md`).

### A new group / tab

Add it to `catalogue.json` and rebuild. The tab appears on the index
automatically, and stays hidden until something is in it.

## What it costs

Nothing.

| | |
|---|---|
| Cloudflare Worker, free plan | $0 — 100,000 requests a day |
| Private GitHub repo | $0 — unlimited on a personal account |
| GitHub API calls | $0 — 5,000 an hour, we use one per page view |
| GitHub Pages for the public site | $0 |

The only thing that would ever cost money is putting a custom domain in front
of the gate, and even that's free if the domain's DNS is on Cloudflare.

---

## Things to keep in mind

- **The code is a password. Treat it like one.** It is deliberately kept out of
  this repo — it only appears in the private vault's README and in the folder
  name. Don't paste it into anything public. To rotate it: generate a new 8-character
  lowercase string, rename the folder in `lab`, and run `npx wrangler secret put
  PROJECTS` with the new value. Nothing else needs to change.
- **Never move a private page into `prod`.** The moment it lands in the public
  repo it's public, gate or no gate.
- **The token expires.** When it does, the gate returns "Could not retrieve
  page". Make a new token and run `npx wrangler secret put GH_TOKEN` again.
- **This keeps honest people out, and casual snooping out.** It is not a
  bank vault. Anyone you give the password to can pass it on.
- **To see what the gate is doing**, run `npx wrangler tail` in `gate/` and
  load a page. Errors show up there live.

---

## Where everything is

```
prod/                                  PUBLIC
├── README.md                          this file
├── catalogue.json                     groups, paths, gate URL  ← edit
├── tools/catalogue.py                 builds the catalogue
├── templates/page.html                starter for every new page
├── .claude/skills/publish-page/       the /publish-page skill
├── docs/                              the website (GitHub Pages serves this)
│   ├── index.html                     the board — generated list, don't edit
│   ├── data/catalogue.js              GENERATED, never hand-edit
│   ├── pages/*.html                   public pages, flat, permanent URLs
│   └── assets/
└── gate/                              the Cloudflare Worker
    ├── src/worker.js                  all the gate logic
    ├── test/gate.test.mjs             11 checks — npm test
    └── wrangler.toml                  settings, no secrets

lab/                                   PRIVATE
├── COMMANDS.md                        every command, copy-paste, in order
├── vault/                             the gated pages — one folder per person
│   ├── README.md                      the conventions (and the real codes)
│   ├── <CODE>-peter/peter-*.html
│   └── <CODE>-russ/russ-*.html
└── workings/                          everything else — notes, drafts, research
                                       (nothing here is served by anything)
```

**Why pages stay flat and are never renamed.** The whole point of the site is
that a link you sent someone two years ago still works. Filing pages into
folders by group would break every existing link, and would break them again
every time you re-tagged a page. The group lives in the page's metadata, so you
can move a page between tabs freely and its URL never changes.
