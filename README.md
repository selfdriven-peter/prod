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
lab/docs/pages/README.md
```

It's also the name of the folder in `lab/docs/pages/`. Wherever you see
`<CODE>` below, substitute that string.

That one string is both the folder name and the password.

```
lab/docs/pages/<CODE>-peter/peter-welcome.html
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

### A public page — anyone can read it

1. Put the HTML file in `prod/docs/pages/`.
2. Open `prod/docs/index.html`, scroll to the `SITES` list near the bottom, and
   add an entry:

```js
{
  group:'other', tone:'gold', icon:'ic-page',
  title:'My New Thing', tag:'Oct 2026',
  line:'One line about what it is.',
  cta:'Have a look', href:'pages/my-new-thing.html'
}
```

3. Commit and push. Done — the tab counts, numbering and colours all sort
   themselves out.

### A private page — password required

1. Put the HTML file in `lab/docs/pages/<CODE>-peter/` and name it
   `peter-something.html`. **The `peter-` prefix is what makes it work** — the
   gate uses it to find the folder.
2. Commit and push the `lab` repo.
3. Add an entry to `SITES` in `prod/docs/index.html` — note there's no `href`,
   just `locked` and `page`:

```js
{
  group:'vault', tone:'constructive', icon:'ic-note', locked:true,
  title:'My Private Thing', page:'peter-something',
  line:'Password protected — opens through the gate.',
  cta:'Unlock'
}
```

4. Commit and push `prod`. The row shows a padlock and a dashed outline, and
   the **Vault** tab appears on the index automatically.

There's a commented-out example of exactly this at the bottom of the `SITES`
list — uncomment it once you've deployed and it'll light up.

You don't need to redeploy the gate when you add a page. It reads the vault
live. You only redeploy if you change the gate's own code or settings.

### A second person with their own password

Say you want to give someone a separate set of pages with a different password.
Make a new folder `lab/docs/pages/<new-code>-sam/`, name the files
`sam-whatever.html`, then update the `PROJECTS` secret to include them:

```
{"peter":{"code":"<CODE>","passwords":["<CODE>"]},"sam":{"code":"<new-code>","passwords":["<new-code>"]}}
```

Run `npx wrangler secret put PROJECTS` again with the new version. Sam's
password won't open your pages and yours won't open theirs.

---

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
├── docs/                              the website (GitHub Pages serves this)
│   ├── index.html                     the index — edit SITES at the bottom
│   ├── assets/
│   └── pages/                         public pages
└── gate/                              the password gate's source code
    ├── src/worker.js                  all the gate logic
    ├── wrangler.toml                  settings — no secrets
    ├── .dev.vars.example              template for testing locally
    └── README.md                      technical notes

lab/                                   PRIVATE
└── docs/pages/
    └── <CODE>-peter/                the vault
        └── peter-welcome.html         the test page
```
