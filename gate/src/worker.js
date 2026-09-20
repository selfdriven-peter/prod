/**
 * pages-gate — a password gate for private pages, on Cloudflare Workers.
 *
 * Replicates the selfdriven-studio / archy-studio Lambda gate, with the same
 * folder-as-password convention, but on Workers and with NO secrets in source.
 *
 *   page name  "peter-plan"
 *     → key    "peter"            (everything before the first hyphen)
 *     → code   "abc123def"        (from the PROJECTS secret)
 *     → file   docs/pages/abc123def-peter/peter-plan.html
 *                                 (in the PRIVATE vault repo)
 *
 * The password is checked against that project's list; on success the Worker
 * fetches the file from the GitHub Contents API using GH_TOKEN and streams the
 * HTML back. The vault repo is never publicly reachable — the token lives only
 * here, and this file holds no secrets, so it is safe in a public repo.
 *
 * Bindings (see wrangler.toml):
 *   GH_TOKEN   secret  fine-grained PAT, read-only, Contents, vault repo only
 *   PROJECTS   secret  JSON, e.g.
 *                      {"peter":{"code":"abc123def","passwords":["abc123def"]}}
 *   REPO_BASE  var     https://api.github.com/repos/<owner>/<vault>/contents/docs/pages
 *   GATE_TITLE var     browser title for the gate
 *   GATE_URL   var     public origin of this Worker, used to rewrite links
 */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cache-Control": "no-store, max-age=0",
};

const FAIL_DELAY_MS = 400;

/* ── helpers ──────────────────────────────────────────────────────────────── */

function respond(status, body, contentType = "text/html; charset=utf-8") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
  });
}

function respondJSON(status, obj) {
  return respond(status, JSON.stringify(obj), "application/json; charset=utf-8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Letters, numbers, hyphens, underscores only — no path traversal. */
function sanitisePage(raw) {
  if (!raw || typeof raw !== "string") return null;
  const clean = raw.trim().replace(/\.html$/i, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(clean)) return null;
  if (clean.length > 120) return null;
  return clean;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Length-independent leaks are unavoidable; the byte compare is constant-time. */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function loadProjects(env) {
  try {
    const parsed = JSON.parse(env.PROJECTS || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.error("PROJECTS secret is not valid JSON");
    return {};
  }
}

/** Project key is the page name up to the first hyphen. */
function resolveProject(page, projects) {
  const dash = page.indexOf("-");
  if (dash === -1) return null;
  const key = page.slice(0, dash);
  const project = projects[key];
  if (!project || !project.code) return null;
  return { key, code: project.code, passwords: project.passwords || [] };
}

/**
 * Rewrite .html links in a served page so they route back through the gate,
 * e.g. href="peter-notes.html" → href="https://gate/#peter-notes".
 * External (http/https) and anchor-only hrefs are left alone.
 */
function rewriteLinks(html, gateUrl) {
  return html.replace(/href=(["'])([^"']+\.html)\1/gi, (match, quote, href) => {
    if (/^https?:\/\//i.test(href)) return match;
    const page = href.split("/").pop().replace(/\.html$/i, "");
    return "href=" + quote + gateUrl + "/#" + page + quote;
  });
}

async function fetchFromGitHub(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pages-gate",
    },
  });
  if (res.status === 404) return { status: 404, html: null };
  if (!res.ok) {
    console.error("GitHub API error " + res.status + ": " + (await res.text().catch(() => "")));
    return { status: res.status, html: null };
  }
  return { status: 200, html: await res.text() };
}


/* ── one link per person ──────────────────────────────────────────────────────
 * /?who=russ shows a password-only gate. On success the Worker lists that
 * project's folder in the vault and renders the pages as links. The folder
 * name contains the code, so the listing is only ever built after the
 * password has been checked, and the code itself never reaches the browser.
 */
async function listProject(env, code, key) {
  const base = (env.REPO_BASE || "").replace(/\/$/, "");
  const res = await fetch(base + "/" + code + "-" + key, {
    headers: {
      Authorization: "Bearer " + env.GH_TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pages-gate",
    },
  });
  if (!res.ok) {
    console.error("GitHub listing error " + res.status);
    return null;
  }
  const items = await res.json().catch(() => null);
  if (!Array.isArray(items)) return null;
  return items
    .filter((f) => f && f.type === "file" && /\.html$/i.test(f.name))
    .map((f) => f.name.replace(/\.html$/i, ""))
    .filter((n) => /^[a-zA-Z0-9_-]+$/.test(n))
    .sort();
}

/** Fallback label when a page has no usable <title>: "russ-have-a-go" → "Have a go". */
function pageLabel(page, key) {
  const bare = page.startsWith(key + "-") ? page.slice(key.length + 1) : page;
  const words = (bare || page).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : page;
}

/**
 * The real titles, read from the pages themselves — "Poker Night — 19 Sep 2026"
 * rather than a guess made from the filename. Capped, fetched in parallel, and
 * any page that fails simply falls back to its filename label.
 */
async function pageTitles(env, code, key, pages) {
  const base = (env.REPO_BASE || "").replace(/\/$/, "");
  const capped = pages.slice(0, 25);
  const titles = await Promise.all(capped.map(async (pg) => {
    try {
      const { status, html } = await fetchFromGitHub(
        base + "/" + code + "-" + key + "/" + pg + ".html", env.GH_TOKEN);
      if (status !== 200 || !html) return null;
      const meta = html.match(/<meta\s+name=["']sd:title["']\s+content=["']([^"']+)["']/i);
      if (meta) return meta[1].trim();
      const t = html.match(/<title>([^<]*)<\/title>/i);
      if (!t) return null;
      // drop a trailing " — moved" / " | Something" suffix noise
      return t[1].replace(/\s+/g, " ").trim() || null;
    } catch { return null; }
  }));
  const out = {};
  capped.forEach((pg, i) => { out[pg] = titles[i] || pageLabel(pg, key); });
  pages.slice(25).forEach((pg) => { out[pg] = pageLabel(pg, key); });
  return out;
}

function projectHTML(key, pages, gateUrl, title, labels) {
  const name = key.charAt(0).toUpperCase() + key.slice(1);
  const rows = pages.length
    ? pages.map((pg) => `<a class="p-row" href="${escapeHTML(gateUrl)}/#${escapeHTML(pg)}">
         <span class="p-name">${escapeHTML((labels && labels[pg]) || pageLabel(pg, key))}</span>
         <span class="p-slug">${escapeHTML(pg)}</span>
         <span class="p-go">Open →</span></a>`).join("")
    : `<p class="lede">Nothing here yet.</p>`;
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHTML(name)} · ${escapeHTML(title || "Secure pages")}</title>
<meta name="theme-color" content="#09090f">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090f;--surface:#111118;--border:rgba(255,255,255,.08);
  --text:#f0eeff;--muted:#7e7a9a;--chill:#7b6cff}
html,body{min-height:100%;background:var(--bg);color:var(--text)}
body{font-family:'DM Sans',system-ui,sans-serif;line-height:1.6;display:grid;
  place-items:start center;padding:8vh 20px 12vh}
.wrap{width:100%;max-width:640px}
h1{font-size:clamp(1.6rem,5vw,2.3rem);font-weight:800;letter-spacing:-.02em;margin-bottom:6px}
h1 span{color:var(--chill)}
.lede{color:var(--muted);font-size:.93rem;margin-bottom:26px}
.p-row{display:flex;align-items:center;gap:14px;padding:15px 17px;margin-bottom:9px;
  background:var(--surface);border:1px solid var(--border);border-radius:13px;
  text-decoration:none;color:inherit;transition:border-color .18s,transform .18s}
.p-row:hover{border-color:var(--chill);transform:translateX(3px)}
.p-name{font-weight:600;flex:1 1 auto}
.p-slug{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:.72rem;color:var(--muted)}
.p-go{font-size:.8rem;color:var(--chill);white-space:nowrap}
.foot{margin-top:28px;font-size:.8rem;color:var(--muted)}
.foot a{color:var(--muted)}
@media (max-width:460px){.p-slug{display:none}}
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHTML(name)}'s <span>pages.</span></h1>
  <p class="lede">${pages.length} page${pages.length === 1 ? "" : "s"}. You're already signed in — these open straight away.</p>
  ${rows}
  <p class="foot"><a href="${escapeHTML(gateUrl)}/">Open a page by name instead</a></p>
</div>
</body>
</html>`;
}


/** A password-only gate for /?who=<key> — no page name to know or type. */
function whoGateHTML(key, title) {
  const k = escapeHTML(key);
  const name = k.charAt(0).toUpperCase() + k.slice(1);
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHTML(title || "Secure pages")}</title>
<meta name="theme-color" content="#09090f">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090f;--surface:#111118;--border:rgba(255,255,255,.08);
  --text:#f0eeff;--muted:#7e7a9a;--chill:#7b6cff}
html,body{height:100%;background:var(--bg);color:var(--text)}
body{font-family:'DM Sans',system-ui,sans-serif;line-height:1.6;display:grid;place-items:center;padding:22px}
.card{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--border);
  border-radius:22px;padding:38px 32px}
h1{font-size:1.75rem;font-weight:800;letter-spacing:-.03em;line-height:1.15;margin-bottom:10px}
h1 span{color:var(--chill)}
.lede{color:var(--muted);font-size:.9rem;margin-bottom:24px}
label{display:block;font-size:.75rem;color:var(--muted);margin-bottom:6px}
input{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:11px;
  padding:12px 14px;color:var(--text);font:inherit}
input:focus{outline:2px solid var(--chill);outline-offset:1px}
button{width:100%;margin-top:16px;background:var(--chill);color:#0b0b12;border:0;border-radius:11px;
  padding:12px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:14px;font-size:.83rem;color:#ff5f7e;min-height:1.2em}
.foot{margin-top:20px;font-size:.78rem;color:var(--muted)}
.foot a{color:var(--muted)}
</style>
</head>
<body>
<main class="card">
  <h1>${name}'s <span>pages.</span></h1>
  <p class="lede">Enter the password you were given. No page name needed.</p>
  <form id="f" autocomplete="off">
    <label for="pw">Password</label>
    <input id="pw" type="password" placeholder="••••••••" autocomplete="current-password" required>
    <button id="go" type="submit">Show me</button>
  </form>
  <p class="msg" id="msg" role="status" aria-live="polite"></p>
  <p class="foot"><a href="/">Open a page by name instead</a></p>
</main>
<script>
(function(){
  var f=document.getElementById('f'),pw=document.getElementById('pw'),
      go=document.getElementById('go'),msg=document.getElementById('msg'),KEY=${JSON.stringify(key)};
  function skey(k){return 'pp_pw_'+k;}
  async function show(v){
    go.disabled=true;go.textContent='Checking…';msg.textContent='';
    try{
      var r=await fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({who:KEY,password:v})});
      if(r.ok){
        try{localStorage.setItem(skey(KEY),v);}catch(e){}
        var h=await r.text();document.open();document.write(h);document.close();return;
      }
      var e={};try{e=await r.json();}catch(x){}
      msg.textContent=e.error||'That password was not recognised.';
      try{localStorage.removeItem(skey(KEY));}catch(x){}
    }catch(x){ msg.textContent='Network error. Try again.'; }
    go.disabled=false;go.textContent='Show me';
  }
  f.addEventListener('submit',function(e){e.preventDefault();if(pw.value)show(pw.value);});
  var saved=null;try{saved=localStorage.getItem(skey(KEY));}catch(e){}
  if(saved){pw.value=saved;show(saved);}else{pw.focus();}
})();
</script>
</body>
</html>`;
}

/* ── the gate page ────────────────────────────────────────────────────────── */

function gateHTML(prefill, title) {
  const t = escapeHTML(title || "Pages | Secure");
  const p = escapeHTML(prefill || "");
  return `<!DOCTYPE html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${t}</title>
<meta name="theme-color" content="#09090f">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090f;--surface:#111118;--border:rgba(255,255,255,.08);
  --text:#f0eeff;--muted:#7e7a9a;--muted2:#3d3a55;
  --curious:#f5c842;--caring:#ff5f7e;--constructive:#00e5a0;--chill:#7b6cff;
  --chill-bright:#9b8fff;--pill:999px}
html,body{height:100%;background:var(--bg);color:var(--text)}
body{font-family:'DM Sans',sans-serif;line-height:1.6;display:grid;place-items:center;
  padding:max(24px,env(safe-area-inset-top)) 22px max(24px,env(safe-area-inset-bottom));
  overflow:hidden}
::selection{background:var(--caring);color:#09090f}
.gblob{position:fixed;border-radius:50%;filter:blur(90px);pointer-events:none}
.gb1{width:420px;height:420px;background:var(--caring);top:-12%;left:-8%;opacity:.13}
.gb2{width:380px;height:380px;background:var(--chill);bottom:-14%;right:-10%;opacity:.16}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.card{position:relative;width:100%;max-width:400px;padding:34px 30px 28px;
  border:1px solid var(--border);border-radius:24px;background:var(--surface);
  box-shadow:0 30px 80px rgba(0,0,0,.5);animation:rise .6s cubic-bezier(.22,1,.36,1)}
.markdots{display:inline-flex;gap:5px;margin-bottom:18px}
.markdots i{width:9px;height:9px;border-radius:50%;display:block}
.markdots i:nth-child(1){background:var(--curious)}
.markdots i:nth-child(2){background:var(--caring)}
.markdots i:nth-child(3){background:var(--constructive)}
.markdots i:nth-child(4){background:var(--chill)}
@keyframes dotWave{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
.markdots.wave i{animation:dotWave .7s ease}
.markdots.wave i:nth-child(2){animation-delay:.07s}
.markdots.wave i:nth-child(3){animation-delay:.14s}
.markdots.wave i:nth-child(4){animation-delay:.21s}
h1{font-family:'Bricolage Grotesque',sans-serif;font-size:29px;font-weight:800;
  letter-spacing:-.04em;line-height:1.05}
h1 span{color:var(--caring)}
.lede{font-size:13.5px;color:var(--muted);margin:9px 0 24px}
label{display:block;font-family:'JetBrains Mono',monospace;font-size:10px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--muted2);margin-bottom:7px}
.field{margin-bottom:15px}
input{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:12px;
  background:rgba(255,255,255,.03);color:var(--text);font-family:'JetBrains Mono',monospace;
  font-size:14px;outline:0;transition:border-color .25s,background .25s}
input::placeholder{color:var(--muted2);font-family:'DM Sans',sans-serif}
input:focus{border-color:rgba(155,143,255,.55);background:rgba(123,108,255,.07)}
button{width:100%;margin-top:9px;padding:13px;border:0;border-radius:12px;cursor:pointer;
  background:var(--text);color:var(--bg);font-family:'Bricolage Grotesque',sans-serif;
  font-size:14px;font-weight:800;letter-spacing:.02em;
  transition:transform .2s cubic-bezier(.34,1.5,.5,1),opacity .2s}
button:hover:not(:disabled){transform:translateY(-2px)}
button:disabled{opacity:.5;cursor:progress}
button:focus-visible,input:focus-visible{outline:2px solid var(--chill-bright);outline-offset:2px}
@keyframes shake{10%,90%{transform:translateX(-2px)}30%,70%{transform:translateX(4px)}
  50%{transform:translateX(-4px)}}
.card.bad{animation:shake .45s}
.msg{min-height:19px;margin-top:12px;font-size:12.5px;color:var(--caring);text-align:center}
.foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);
  font-size:11.5px;color:var(--muted2);text-align:center}
.foot a{color:var(--muted);text-decoration:none}
.foot a:hover{color:var(--text)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="gblob gb1"></div><div class="gblob gb2"></div>
<main class="card" id="card">
  <span class="markdots" id="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
  <h1>Locked <span>page.</span></h1>
  <p class="lede">Enter the page name and the password you were given.</p>
  <form id="form" autocomplete="off">
    <div class="field">
      <label for="page">Page</label>
      <input id="page" name="page" value="${p}" placeholder="peter-plan" autocapitalize="off"
             autocorrect="off" spellcheck="false" required>
    </div>
    <div class="field">
      <label for="pw">Password</label>
      <input id="pw" name="pw" type="password" placeholder="••••••••" autocomplete="current-password" required>
    </div>
    <button id="go" type="submit">Unlock</button>
  </form>
  <p class="msg" id="msg" role="status" aria-live="polite"></p>
  <p class="foot"><a href="/">Back to the gate</a></p>
</main>
<script>
(function(){
  var form=document.getElementById('form'),pageEl=document.getElementById('page'),
      pwEl=document.getElementById('pw'),btn=document.getElementById('go'),
      msg=document.getElementById('msg'),card=document.getElementById('card'),
      dots=document.getElementById('dots');

  function wave(){dots.classList.remove('wave');void dots.offsetWidth;dots.classList.add('wave');}
  wave(); dots.addEventListener('mouseenter',wave);

  /* password is remembered per project, keyed on the page-name prefix,
     the same scheme secure.selfdriven.studio uses */
  function projectKey(p){var i=String(p).indexOf('-');return i===-1?'':String(p).slice(0,i);}
  function skey(k){return 'pp_pw_'+k;}
  function save(k,v){try{localStorage.setItem(skey(k),v);}catch(e){}}
  function load(k){try{return localStorage.getItem(skey(k));}catch(e){return null;}}
  function drop(k){try{localStorage.removeItem(skey(k));}catch(e){}}

  function fail(text,key){
    msg.textContent=text;
    card.classList.remove('bad');void card.offsetWidth;card.classList.add('bad');
    if(key) drop(key);
    btn.disabled=false;btn.textContent='Unlock';
  }

  async function unlock(auto){
    var page=pageEl.value.trim(), pw=pwEl.value;
    if(!page||!pw) return;
    var key=projectKey(page);
    btn.disabled=true;btn.textContent='Opening…';msg.textContent='';
    try{
      var res=await fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({page:page,password:pw})});
      if(res.ok){
        var html=await res.text();
        if(key) save(key,pw);
        document.open();document.write(html);document.close();
        return;
      }
      var err={};try{err=await res.json();}catch(e){}
      fail(err.error||'Could not open that page.', auto?key:null);
      if(auto) pwEl.value='';
    }catch(e){ fail('Network error. Try again.'); }
  }

  form.addEventListener('submit',function(e){e.preventDefault();unlock(false);});

  /* deep link: /#peter-plan pre-fills the page and auto-unlocks if we already
     hold this project's password from a previous visit */
  var hash=(location.hash||'').replace(/^#/,'').trim();
  if(hash && /^[a-zA-Z0-9_-]+$/.test(hash)) pageEl.value=hash;
  var k=projectKey(pageEl.value), saved=k?load(k):null;
  if(pageEl.value && saved){ pwEl.value=saved; unlock(true); }
  else if(pageEl.value) pwEl.focus(); else pageEl.focus();
})();
</script>
</body>
</html>`;
}


/* ── who-am-I, for the public index ───────────────────────────────────────────
 * The index lives on a different origin, so it cannot read the password this
 * Worker remembers. It POSTs a password here and gets back only the project
 * key ("peter"), which it uses to un-fade that person's rows. No codes, no
 * page names and no token ever cross the boundary — and the key is cosmetic,
 * since every real page fetch still goes through the password check below.
 */
function corsHeaders(request, env) {
  const allowed = (env.INDEX_ORIGIN || "").split(",").map((o) => o.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** Which project does this password belong to? null if none. */
function whichProject(password, projects) {
  if (typeof password !== "string" || !password) return null;
  for (const key of Object.keys(projects)) {
    const list = projects[key] && projects[key].passwords;
    if (Array.isArray(list) && list.some((p) => safeEqual(p, password))) return key;
  }
  return null;
}

/* ── handler ──────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const gateUrl = (env.GATE_URL || url.origin).replace(/\/$/, "");

    if (url.pathname === "/robots.txt") {
      return respond(200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8");
    }

    // ── /whoami → tell the public index which project a password opens ──────
    if (url.pathname === "/whoami") {
      const cors = corsHeaders(request, env);
      if (!cors) return respondJSON(403, { error: "Not allowed." });
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
      }
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "POST only." }), {
          status: 405,
          headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...cors },
        });
      }
      if (!env.PROJECTS) return respondJSON(500, { error: "Gate is not configured." });
      let who = null;
      try {
        const b = await request.json();
        who = whichProject(b && b.password, loadProjects(env));
      } catch { /* fall through to the refusal */ }
      if (!who) await sleep(FAIL_DELAY_MS);
      return new Response(JSON.stringify(who ? { key: who } : { error: "That password was not recognised." }), {
        status: who ? 200 : 403,
        headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...cors },
      });
    }

    // ── GET → the gate ──────────────────────────────────────────────────────
    if (request.method !== "POST") {
      // /?who=russ — one link per person, password only
      const rawWho = (url.searchParams.get("who") || "").trim();
      if (rawWho && /^[a-zA-Z0-9_]{1,40}$/.test(rawWho)) {
        return respond(200, whoGateHTML(rawWho, env.GATE_TITLE));
      }
      const prefill = sanitisePage(url.searchParams.get("page") || "") || "";
      return respond(200, gateHTML(prefill, env.GATE_TITLE));
    }

    // ── POST → validate, then fetch from the private vault ──────────────────
    if (!env.GH_TOKEN || !env.PROJECTS) {
      console.error("Missing GH_TOKEN or PROJECTS binding");
      return respondJSON(500, { error: "Gate is not configured." });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return respondJSON(400, { error: "Invalid request." });
    }

    // ── {who, password} → list that project's pages ────────────────────────
    if (body && typeof body.who === "string" && body.who) {
      const key = body.who.trim();
      const projects = loadProjects(env);
      const project = /^[a-zA-Z0-9_]{1,40}$/.test(key) ? projects[key] : null;
      const ok = project && project.code && Array.isArray(project.passwords)
        && project.passwords.some((pw) => safeEqual(pw, body.password));
      if (!ok) {
        await sleep(FAIL_DELAY_MS);
        // identical wording to a bad page password, so this cannot be used to
        // discover which project keys exist
        return respondJSON(403, { error: "Unknown page. Check the name you were given." });
      }
      const pages = await listProject(env, project.code, key);
      if (!pages) return respondJSON(502, { error: "Could not retrieve pages. Try again." });
      const labels = await pageTitles(env, project.code, key, pages);
      return respond(200, projectHTML(key, pages, gateUrl, env.GATE_TITLE, labels));
    }

    const page = sanitisePage(body && body.page);
    if (!page) {
      return respondJSON(400, { error: "Invalid page name. Letters, numbers, hyphens." });
    }

    const resolved = resolveProject(page, loadProjects(env));
    if (!resolved) {
      await sleep(FAIL_DELAY_MS);
      return respondJSON(403, { error: "Unknown page. Check the name you were given." });
    }

    const password = body && body.password;
    const ok = Array.isArray(resolved.passwords)
      && resolved.passwords.some((p) => safeEqual(p, password));
    if (!ok) {
      await sleep(FAIL_DELAY_MS);
      // same wording as an unknown page, so the gate does not confirm which
      // page names exist to someone guessing
      return respondJSON(403, { error: "Unknown page. Check the name you were given." });
    }

    const base = (env.REPO_BASE || "").replace(/\/$/, "");
    const target = base + "/" + resolved.code + "-" + resolved.key + "/" + page + ".html";
    const { status, html } = await fetchFromGitHub(target, env.GH_TOKEN);

    if (status === 404) return respondJSON(404, { error: 'Page "' + page + '" not found.' });
    if (status !== 200) return respondJSON(502, { error: "Could not retrieve page. Try again." });

    return respond(200, rewriteLinks(html, gateUrl));
  },
};
