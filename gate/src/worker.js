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
      const meta = html.match(/<meta\s+name=["']sd:title["']\s+content=(["'])([\s\S]*?)\1/i);
      if (meta) return meta[2].trim();
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

/* ── the field ───────────────────────────────────────────────────────────────
 * The morphing particle field from the index page (docs/index.html), inlined
 * into the gate so it stays one self-contained response. Keep the two copies
 * in step. It contains no backticks, ${ or backslashes, so it sits safely in
 * a template literal.
 */
const FIELD_JS = `
/* ── the field ────────────────────────────────────────────────────────────
   A couple of thousand points in 3D, drawn on a 2D canvas, that morph from
   one shape to the next. Same engine idea as the TrialThread hero, in the
   4Cs palette. No libraries. It only draws; it never decides anything.

     var f = Field(canvas, { anchor: function(name){ return {x, y, r, a}; } });
     f.set('rings');            // a shape, in the 4Cs
     f.set('spade', '#e8b84b'); // a shape, in one tone
     f.pulse(.4);               // a kick outwards that settles back
   ──────────────────────────────────────────────────────────────────── */
var Field = (function(){
  var TAU = Math.PI * 2;
  var C = {
    curious:[245,200,66], caring:[255,95,126], constructive:[0,229,160],
    chill:[155,143,255], white:[240,238,255], dim:[60,56,92]
  };
  var FOUR = [C.curious, C.caring, C.constructive, C.chill];

  function rnd(a){ return (Math.random() * 2 - 1) * (a || 1); }
  function inBall(r){ var x, y, z; do { x = rnd(); y = rnd(); z = rnd(); } while(x*x + y*y + z*z > 1); return [x*r, y*r, z*r]; }
  function fib(i, n){ var y = 1 - 2 * (i + .5) / n, r = Math.sqrt(1 - y*y), th = i * 2.399963; return [Math.cos(th)*r, y, Math.sin(th)*r]; }
  function hash(i){ var s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); }
  function rn(i, n){ return hash(i * 7.13 + n * 1.37) * 2 - 1; }
  function clamp(v, a, b){ return v < a ? a : v > b ? b : v; }
  function ease(t){ return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }
  function mix(a, b, t){ return [a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t]; }
  function rgb(hex){ var n = parseInt(String(hex).replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function paint(c, col){ c[0] = col[0]; c[1] = col[1]; c[2] = col[2]; }

  function build(N, fn){
    var p = new Float32Array(N*3), c = new Float32Array(N*3), s = new Float32Array(N), m = {};
    for(var i = 0; i < N; i++){
      var o = fn(i, m, N);
      p[i*3] = o.p[0]; p[i*3+1] = o.p[1]; p[i*3+2] = o.p[2];
      c[i*3] = o.c[0]; c[i*3+1] = o.c[1]; c[i*3+2] = o.c[2];
      s[i] = o.s || 1;
    }
    return { p:p, c:c, s:s, m:m };
  }

  /* fill a flat 2D outline with points, given an inside() test */
  function slab(N, inside, depth, colour){
    return build(N, function(i){
      var x, y, n = 0;
      do { x = rnd(); y = rnd(); n++; } while(!inside(x, y) && n < 60);
      return { p:[x, y, rnd(depth)], c:colour(i, x, y), s:1 };
    });
  }

  /* ── the shapes. Each takes a tone (or null for the 4Cs) ────────────── */
  var SHAPES = {

    /* four tilted orbits, one per C, round a small bright core */
    rings: function(t){ return { spin:.12, build:function(N){ return build(N, function(i, m){
        m.r = m.r || new Uint8Array(N); m.a = m.a || new Float32Array(N); m.j = m.j || new Float32Array(N);
        var core = i % 9 === 0, r = core ? 4 : i % 4;
        m.r[i] = r; m.a[i] = Math.random() * TAU; m.j[i] = rnd(.04);
        return { p:[0,0,0], c: core ? C.white : (t ? (r % 2 ? t : mix(t, C.white, .45)) : FOUR[r]), s: core ? .8 : 1.05 };
      }); },
      anim:function(i, v, c, te, D){
        var m = D.m, r = m.r[i];
        if(r === 4){ var q = fib(i % 300, 300), b = .2 + .03 * Math.sin(te * 3); v[0] = q[0]*b; v[1] = q[1]*b; v[2] = q[2]*b; return; }
        var a = m.a[i] + te * (.35 + r * .07) * (r % 2 ? -1 : 1), R = 1 + m.j[i];
        var tilt = r * TAU / 8 + .3, tw = r * .9;
        var x = Math.cos(a) * R, z = Math.sin(a) * R;
        var y1 = -z * Math.sin(tilt), z1 = z * Math.cos(tilt);
        v[0] = x * Math.cos(tw) + z1 * Math.sin(tw); v[1] = y1; v[2] = -x * Math.sin(tw) + z1 * Math.cos(tw);
      } }; },

    /* the thread: a double helix with rungs, flowing upwards */
    helix: function(t){ return { spin:.35, build:function(N){ return build(N, function(i, m){
        m.k = m.k || new Uint8Array(N); m.u = m.u || new Float32Array(N); m.w = m.w || new Float32Array(N); m.j = m.j || new Float32Array(N*3);
        var k = i % 5 < 2 ? 0 : i % 5 < 4 ? 1 : 2;
        m.k[i] = k; m.u[i] = Math.random(); m.w[i] = Math.random(); m.j.set(inBall(.04), i*3);
        return { p:[0,0,0], c: k === 2 ? C.white : k ? (t || C.chill) : (t ? mix(t, C.white, .5) : C.caring), s: k === 2 ? .7 : 1.1 };
      }); },
      anim:function(i, v, c, te, D){
        var m = D.m, k = m.k[i], s = (m.u[i] + te * .02) % 1, L = 2.6, R = .52, x, y, z;
        if(k < 2){ var a = s * TAU * 2.2 + (k ? Math.PI : 0); x = Math.cos(a) * R; z = Math.sin(a) * R; y = (s - .5) * L; }
        else {
          var rung = Math.floor(s * 26), rs = rung / 26, b = rs * TAU * 2.2, w = m.w[i], x0 = Math.cos(b) * R, z0 = Math.sin(b) * R;
          x = x0 - 2 * x0 * w; z = z0 - 2 * z0 * w; y = (rs - .5) * L;
          paint(c, t ? (rung % 4 === 0 ? C.white : t) : FOUR[rung % 4]);
        }
        x += m.j[i*3]; y += m.j[i*3+1]; z += m.j[i*3+2];
        var ct = Math.cos(-.5), st = Math.sin(-.5);
        v[0] = x * ct - y * st; v[1] = x * st + y * ct; v[2] = z;
        if(k < 2 && ((s * 3 - te * .4) % 1 + 1) % 1 < .05) paint(c, [255,250,240]);
      } }; },

    /* a trefoil knot, the colour running round it */
    knot: function(t){ return { spin:.22, build:function(N){ return build(N, function(i, m){
        m.u = m.u || new Float32Array(N); m.j = m.j || new Float32Array(N*3);
        m.u[i] = i / N; m.j.set(inBall(.11), i*3);
        return { p:[0,0,0], c:C.white, s:1 };
      }); },
      anim:function(i, v, c, te, D){
        var m = D.m, u = (m.u[i] + te * .015) % 1, a = u * TAU, r = Math.cos(3 * a) + 2.2;
        v[0] = r * Math.cos(2 * a) * .36 + m.j[i*3];
        v[1] = -Math.sin(3 * a) * .5 + m.j[i*3+1];
        v[2] = r * Math.sin(2 * a) * .36 + m.j[i*3+2];
        var f = u * 4, k = Math.floor(f);
        paint(c, t ? mix(t, C.white, .5 + .5 * Math.sin(f * Math.PI)) : mix(FOUR[k % 4], FOUR[(k + 1) % 4], f - k));
      } }; },

    /* a breathing globe, banded in the four colours */
    globe: function(t){ return { spin:.18, build:function(N){ return build(N, function(i){
        var q = fib(i, N), band = Math.floor((q[1] + 1) * 2) % 4;
        return { p:q, c: hash(i) < .13 ? C.white : (t || FOUR[band]), s:.95 };
      }); },
      anim:function(i, v, c, te){
        var b = 1 + .06 * Math.pow(Math.max(0, Math.sin(te * 2.6)), 10) + .025 * Math.sin(te * 1.1 + v[1] * 3);
        v[0] *= b; v[1] *= b; v[2] *= b;
      } }; },

    /* a padlock. Deterministic, so lock, checking and unlock morph into
       each other without the points reshuffling */
    lock: function(t, mode){ var tone = t || C.chill; return { spin: mode === 'checking' ? 3.2 : 0, mode:mode,
      build:function(N){ return build(N, function(i, m){
        m.k = m.k || new Uint8Array(N);
        var p, c = tone, s = 1, k;
        if(hash(i + 3) < .34){
          k = 0;
          var tube = [rn(i,1) * .06, rn(i,2) * .06, rn(i,3) * .06];
          if(hash(i + 5) < .35){ var side = rn(i,4) < 0 ? -1 : 1; p = [side * .42 + tube[0], .25 + rn(i,5) * .15 + tube[1], tube[2]]; }
          else { var a = (rn(i,6) + 1) / 2 * Math.PI; p = [Math.cos(a) * .42 + tube[0], .4 + Math.sin(a) * .42 + tube[1], tube[2]]; }
          c = mix(tone, C.white, .35);
        } else {
          k = 1;
          var x = rn(i,7) * .66, y = -.35 + rn(i,8) * .48, z = rn(i,9) * .22, f = Math.floor(hash(i + 11) * 3);
          if(f === 0) x = x < 0 ? -.66 : .66; else if(f === 1) y = y < -.35 ? -.83 : .13; else z = z < 0 ? -.22 : .22;
          p = [x, y, z];
          var dy = y + .3;
          if(f === 2 && z < 0 && (x*x + dy*dy < .02 || (Math.abs(x) < .045 && dy < 0 && dy > -.32))){ c = C.white; s = 1.6; }
        }
        m.k[i] = k; return { p:p, c:c, s:s };
      }); },
      anim:function(i, v, c, te, D){
        if(this.mode !== 'open') return;
        var lift = ease(clamp(te / .55, 0, 1)) * .36, burst = Math.max(0, te - .65);
        if(D.m.k[i] === 0) v[1] += lift;
        if(burst){ var g = 1 + burst * burst * 2.6; v[0] *= g; v[1] *= g; v[2] *= g; paint(c, mix(c, C.constructive, clamp(burst * 2, 0, 1))); }
      } }; },

    /* not that one: a cloud that shudders, then settles */
    scatter: function(t){ var tone = t || C.caring; return { spin:.05, build:function(N){ return build(N, function(i){
        return { p:inBall(1.45), c: hash(i) < .25 ? C.white : tone, s:.9 };
      }); },
      anim:function(i, v, c, te){ var sh = Math.exp(-te * 2.4) * .22; v[0] += Math.sin(te * 42 + i) * sh; v[1] += Math.cos(te * 37 + i) * sh * .4; } }; },

    /* ── one shape per page icon ── */
    spade: function(t){ var tone = t || C.curious; return { spin:.3, build:function(N){
        return slab(N, function(x, y){
          var lobe = (Math.abs(x) - .38) * (Math.abs(x) - .38) + (y + .08) * (y + .08) < .2;
          var top = y > -.08 && y < .95 && Math.abs(x) < (.95 - y) * .86;
          var stem = y < -.2 && y > -.95 && Math.abs(x) < .08 + (-.2 - y) * .4;
          return lobe || top || stem;
        }, .1, function(i){ return hash(i) < .18 ? C.white : tone; });
      } }; },

    eightball: function(t){ var tone = t || C.chill; return { spin:0, build:function(N){ return build(N, function(i){
        var q = fib(i, N), col = mix(tone, C.dim, .35), s = .9;
        if(q[2] < -.8){
          var a = q[0] / .6, b = q[1] / .6, top = Math.hypot(a, b - .12), bot = Math.hypot(a, b + .14);
          col = (Math.abs(top - .1) < .035 || Math.abs(bot - .13) < .035) ? tone : C.white; s = 1.2;
        }
        return { p:[q[0], q[1], q[2]], c:col, s:s };
      }); },
      anim:function(i, v, c, te){ var w = Math.sin(te * 1.6) * .08 * Math.exp(-te * .2); v[0] += w * v[1]; } }; },

    compass: function(t){ var tone = t || C.chill; return { spin:0, build:function(N){ return build(N, function(i, m){
        m.k = m.k || new Uint8Array(N);
        var h = hash(i + 1), k, p, c = tone;
        if(h < .5){ k = 0; var a = Math.random() * TAU, rr = 1 + rnd(.03); p = [Math.cos(a) * rr, Math.sin(a) * rr, rnd(.05)]; if(Math.abs(Math.sin(a * 2)) < .05){ c = C.white; } }
        else if(h < .62){ k = 0; var b = Math.random() * TAU; p = [Math.cos(b) * .78, Math.sin(b) * .78, 0]; c = mix(tone, C.dim, .5); }
        else { k = 1; var u = Math.random(), w = rnd() * (1 - Math.abs(u * 2 - 1)) * .14, y = (u * 2 - 1) * .74; p = [w, y, rnd(.03)]; c = y > 0 ? C.white : tone; }
        m.k[i] = k; return { p:p, c:c, s:1 };
      }); },
      anim:function(i, v, c, te, D){
        if(D.m.k[i] !== 1) return;
        var a = .9 * Math.sin(te * 1.4) * Math.exp(-te * .35) + .15 * Math.sin(te * .5), ca = Math.cos(a), sa = Math.sin(a), x = v[0], y = v[1];
        v[0] = x * ca - y * sa; v[1] = x * sa + y * ca;
      } }; },

    sparkles: function(t){ var tone = t || C.constructive; return { spin:.2, build:function(N){ return build(N, function(i, m){
        m.k = m.k || new Uint8Array(N);
        var k = hash(i + 2) < .74 ? 0 : hash(i + 4) < .6 ? 1 : 2, sc = [1, .3, .2][k], ox = [0, .9, -.85][k], oy = [0, .75, -.72][k], x, y, n = 0;
        do { x = rnd(); y = rnd(); n++; } while(Math.sqrt(Math.abs(x)) + Math.sqrt(Math.abs(y)) > 1 && n < 60);
        m.k[i] = k;
        return { p:[ox + x * sc, oy + y * sc, rnd(.08)], c: k ? C.white : (hash(i) < .15 ? C.white : tone), s:k ? 1.2 : 1 };
      }); },
      anim:function(i, v, c, te, D){
        var k = D.m.k[i]; if(!k) { var b = 1 + .04 * Math.sin(te * 2); v[0] *= b; v[1] *= b; return; }
        var ox = k === 1 ? .9 : -.85, oy = k === 1 ? .75 : -.72, g = .6 + .6 * Math.abs(Math.sin(te * 2.2 + k));
        v[0] = ox + (v[0] - ox) * g; v[1] = oy + (v[1] - oy) * g;
      } }; }
  };
  SHAPES.thread = SHAPES.helix;

  function Field(cv, opt){
    opt = opt || {};
    var ctx = cv.getContext('2d');
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var N = opt.N || (Math.min(innerWidth, innerHeight) < 600 ? 1000 : 1700);
    var cur = new Float32Array(N*3), from = new Float32Array(N*3), cc = new Float32Array(N*3), cf = new Float32Array(N*3), dl = new Float32Array(N);
    for(var i = 0; i < N; i++){ cur.set(inBall(2.6), i*3); cc.set(C.dim, i*3); dl[i] = hash(i + 7) * .5; }
    var F = { name:'', key:'', scene:null, data:null, t0:0, last:0, yaw:0, pitch:-.22, W:0, H:0,
              ax:0, ay:0, ar:0, aa:0, tx:0, ty:0, tr:0, ta:1, px:0, py:0, ptx:0, pty:0, mx:-1e4, my:-1e4, kick:0, raf:0 };
    var cache = {}, v = [0,0,0], c = [0,0,0];

    function place(snap){
      var a = (opt.anchor && opt.anchor(F.name)) || { x:F.W / 2, y:F.H / 2, r:Math.min(F.W, F.H) * .35 };
      F.tx = a.x; F.ty = a.y; F.tr = a.r; F.ta = a.a == null ? 1 : a.a;
      if(snap){ F.ax = F.tx; F.ay = F.ty; F.ar = F.tr; F.aa = F.ta; }
    }
    function size(){
      var d = Math.min(window.devicePixelRatio || 1, 2);
      F.W = innerWidth; F.H = innerHeight;
      cv.width = Math.max(1, F.W * d); cv.height = Math.max(1, F.H * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      place(!F.ar);
      if(reduce) frame(performance.now());
    }

    function frame(now){
      var sc = F.scene, D = F.data; if(!sc || !F.W) return;
      var dt = Math.min(.05, (now - F.last) / 1000 || 0); F.last = now;
      var te = reduce ? 4 : (now - F.t0) / 1000, DUR = opt.dur || 1.5;
      place(reduce);
      var e = Math.min(1, dt * 3.2);
      F.ax += (F.tx - F.ax) * e; F.ay += (F.ty - F.ay) * e; F.ar += (F.tr - F.ar) * e; F.aa += (F.ta - F.aa) * e;
      if(sc.spin){ if(!reduce) F.yaw += sc.spin * dt * (1 + F.kick * 5); }
      else { var tg = Math.round(F.yaw / TAU) * TAU + (reduce ? 0 : Math.sin(te * .7) * .35); F.yaw += (tg - F.yaw) * Math.min(1, dt * 2.4); }
      F.px += (F.ptx - F.px) * .05; F.py += (F.pty - F.py) * .05;
      F.kick *= Math.pow(.05, dt);
      var yw = F.yaw + F.px * .5, cy = Math.cos(yw), sy = Math.sin(yw), pt = F.pitch + F.py * .25, cp = Math.cos(pt), sp = Math.sin(pt);
      var dist = 5, f = F.ar * dist, ox = F.ax, oy = F.ay, base = clamp(F.ar / 200, .8, 2.1) * (opt.pt || 1);
      var mx = F.mx, my = F.my, RR = 120, RR2 = RR * RR;
      ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, F.W, F.H);
      ctx.globalCompositeOperation = 'lighter';
      for(var i = 0; i < N; i++){
        var j = i * 3;
        v[0] = D.p[j]; v[1] = D.p[j+1]; v[2] = D.p[j+2]; c[0] = D.c[j]; c[1] = D.c[j+1]; c[2] = D.c[j+2];
        if(sc.anim) sc.anim(i, v, c, te, D);
        var k = reduce ? 1 : ease(clamp((te - dl[i] * DUR * .5) / (DUR * .7), 0, 1));
        var X = from[j] + (v[0] - from[j]) * k, Y = from[j+1] + (v[1] - from[j+1]) * k, Z = from[j+2] + (v[2] - from[j+2]) * k;
        var R = cf[j] + (c[0] - cf[j]) * k, G = cf[j+1] + (c[1] - cf[j+1]) * k, B = cf[j+2] + (c[2] - cf[j+2]) * k;
        cur[j] = X; cur[j+1] = Y; cur[j+2] = Z; cc[j] = R; cc[j+1] = G; cc[j+2] = B;
        if(F.kick > .002){ var g = 1 + F.kick * (.5 + hash(i) * .9); X *= g; Y *= g; Z *= g; }
        var x1 = X * cy - Z * sy, z1 = X * sy + Z * cy, y1 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp, d = z2 + dist;
        if(d <= .3) continue;
        var s = f / d, px = ox + x1 * s, py = oy - y1 * s;
        var dx = px - mx, dy = py - my, dd = dx * dx + dy * dy;
        if(dd < RR2 && dd > .01){ var q = Math.sqrt(dd), push = 1 - q / RR; push = push * push * 36; px += dx / q * push; py += dy / q * push; }
        var r = Math.max(.5, base * D.s[i] * dist / d), al = clamp(.95 - z2 * .16, .22, 1) * F.aa;
        ctx.fillStyle = 'rgba(' + (R | 0) + ',' + (G | 0) + ',' + (B | 0) + ',' + al.toFixed(3) + ')';
        if(r < 1.7) ctx.fillRect(px - r, py - r, r * 2, r * 2);
        else { ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill(); }
      }
      ctx.globalCompositeOperation = 'source-over';
      if(opt.after) opt.after(F);
    }
    function loop(now){ if(F.stopped) return; frame(now); F.raf = requestAnimationFrame(loop); }

    F.set = function(name, tone){
      var key = name + '|' + (tone || '');
      if(F.key === key || !SHAPES[name]) return;
      var sc = cache[key];
      if(!sc){
        var base = name.split(':'), make = SHAPES[base[0]];
        sc = make(tone ? rgb(tone) : null, base[1]); sc.data = sc.build(N); cache[key] = sc;
      }
      from.set(cur); cf.set(cc);
      F.key = key; F.name = name; F.scene = sc; F.data = sc.data; F.t0 = performance.now();
      if(reduce) frame(F.t0);
    };
    F.pulse = function(n){ if(!reduce) F.kick = Math.min(1.1, F.kick + (n || .3)); };
    F.reduce = reduce;
    F.stop = function(){ F.stopped = true; cancelAnimationFrame(F.raf); };

    size();
    addEventListener('resize', size);
    addEventListener('pointermove', function(e){
      if(e.pointerType !== 'mouse') return;
      F.mx = e.clientX; F.my = e.clientY;
      F.ptx = (e.clientX / F.W - .5) * 2; F.pty = (e.clientY / F.H - .5) * 2;
    }, { passive:true });
    document.addEventListener('pointerleave', function(){ F.mx = F.my = -1e4; F.ptx = F.pty = 0; });
    addEventListener('blur', function(){ F.mx = F.my = -1e4; });
    if(!reduce) F.raf = requestAnimationFrame(loop);
    return F;
  }

  /* lock, checking and open share one build, so register the variants */
  SHAPES['lock:checking'] = true; SHAPES['lock:open'] = true;
  return Field;
})();
`;

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
#field{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.floor{position:fixed;left:-50%;right:-50%;bottom:-10%;height:46%;pointer-events:none;
  background-image:linear-gradient(rgba(123,108,255,.28) 1px,transparent 1px),
    linear-gradient(90deg,rgba(123,108,255,.28) 1px,transparent 1px);
  background-size:64px 64px;transform:perspective(520px) rotateX(64deg);transform-origin:center top;
  -webkit-mask-image:linear-gradient(to bottom,transparent,#000 30%,#000 65%,transparent);
  mask-image:linear-gradient(to bottom,transparent,#000 30%,#000 65%,transparent);
  animation:floor 3.2s linear infinite;opacity:.55}
@keyframes floor{to{background-position:0 64px}}
.fieldtag{position:fixed;left:0;top:0;pointer-events:none;white-space:nowrap;
  font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:600;letter-spacing:.14em;
  text-transform:uppercase;color:var(--tag,var(--muted));padding:5px 11px;border-radius:var(--pill);
  background:rgba(9,9,15,.66);border:1px solid rgba(255,255,255,.07);transition:color .4s,opacity .4s}
.fieldtag b{color:var(--muted2);font-weight:600;margin-right:6px}
.card{z-index:1;background:rgba(17,17,26,.62);-webkit-backdrop-filter:blur(14px) saturate(140%);
  backdrop-filter:blur(14px) saturate(140%)}
.card.ok{border-color:rgba(0,229,160,.5);box-shadow:0 30px 80px rgba(0,0,0,.5),0 0 60px rgba(0,229,160,.25)}
h1 span{background:linear-gradient(90deg,var(--caring),var(--curious),var(--constructive),
  var(--chill),var(--caring));background-size:300% 100%;-webkit-background-clip:text;
  background-clip:text;color:transparent;animation:hue 9s linear infinite}
@keyframes hue{to{background-position:300% 0}}
input:focus{box-shadow:0 0 0 4px rgba(123,108,255,.15),0 0 26px rgba(123,108,255,.3)}
@media (min-width:960px){body{place-items:center start;padding-left:max(9vw,48px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="gblob gb1"></div><div class="gblob gb2"></div>
<div class="floor" aria-hidden="true"></div>
<canvas id="field" aria-hidden="true"></canvas>
<div class="fieldtag" id="fieldTag" aria-hidden="true"><b>01</b><span>four Cs</span></div>
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
    stir('bad');
  }
  function stir(state){document.dispatchEvent(new CustomEvent('gate-state',{detail:state}));}

  async function unlock(auto){
    var page=pageEl.value.trim(), pw=pwEl.value;
    if(!page||!pw) return;
    var key=projectKey(page);
    btn.disabled=true;btn.textContent='Opening…';msg.textContent='';
    stir('checking');
    try{
      var res=await fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({page:page,password:pw})});
      if(res.ok){
        var html=await res.text();
        if(key) save(key,pw);
        stir('ok');card.classList.add('ok');
        /* let the lock spring open before the page replaces this one */
        var calm=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(function(){document.open();document.write(html);document.close();},calm?0:950);
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
<script>${FIELD_JS}</script>
<script>
/* the field: a thread while you name the page, a lock for the password,
   spinning while the gate checks, springing open on a match */
(function(){
  var cv=document.getElementById('field');
  if(!cv||!cv.getContext||typeof Field!=='function')return;
  var card=document.getElementById('card'),pageEl=document.getElementById('page'),
      pwEl=document.getElementById('pw'),tag=document.getElementById('fieldTag'),
      tagN=tag.firstChild,tagT=tag.lastChild,tagW=0,busy=false,timer=0;
  var T={chill:'#9b8fff',caring:'#ff5f7e',constructive:'#00e5a0',curious:'#f5c842'};
  function anchor(){
    var W=innerWidth,H=innerHeight,c=card.getBoundingClientRect(),gut=W-c.right;
    if(W>=960&&gut>=320)return{x:c.right+gut/2,y:H*.5,r:Math.min(gut*.32,H*.3),a:1};
    return{x:W/2,y:H*.5,r:Math.min(W,H)*.46,a:.4};
  }
  var field=Field(cv,{anchor:anchor,after:function(F){
    var y=Math.min(F.ay+F.ar*1.5+14,innerHeight-40);
    tag.style.transform='translate('+Math.round(F.ax-tagW/2)+'px,'+Math.round(y)+'px)';
    tag.style.opacity=F.aa<.7?0:1;
  }});
  function show(shape,n,text,tone){field.set(shape,tone);tagN.textContent=n;tagT.textContent=text;
    tag.style.setProperty('--tag',tone||'var(--muted)');tagW=tag.offsetWidth;}
  function rest(){
    if(busy)return;
    var a=document.activeElement;
    if(a===pwEl)show('lock','02','password',T.chill);
    else if(a===pageEl)show('helix','01',pageEl.value.trim()||'page name',T.caring);
    else show('rings','··','four Cs',null);
  }
  pageEl.addEventListener('focus',rest);
  pwEl.addEventListener('focus',rest);
  pageEl.addEventListener('input',function(){field.pulse(.12);tagT.textContent=pageEl.value.trim()||'page name';tagW=tag.offsetWidth;});
  pwEl.addEventListener('input',function(){field.pulse(.12);});
  [pageEl,pwEl].forEach(function(el){el.addEventListener('blur',function(){setTimeout(rest,200);});});
  document.addEventListener('gate-state',function(e){
    clearTimeout(timer);
    if(e.detail==='checking'){busy=true;show('lock:checking','··','checking',T.chill);return;}
    if(e.detail==='ok'){show('lock:open','✓','open',T.constructive);field.pulse(.3);return;}
    show('scatter','×','not that one',T.caring);field.pulse(.6);
    timer=setTimeout(function(){busy=false;rest();},1500);
  });
  document.addEventListener('pointerdown',function(e){if(e.pointerType!=='mouse')field.pulse(.2);});
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(function(){tagW=tag.offsetWidth;});
  rest();
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
