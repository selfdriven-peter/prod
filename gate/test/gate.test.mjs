import worker from '../src/worker.js';

const CODE = 'testcode';  // fixture only — not the real access code
const env = {
  GH_TOKEN: 'fake-token',
  PROJECTS: JSON.stringify({ peter: { code: CODE, passwords: [CODE] } }),
  REPO_BASE: 'https://api.github.com/repos/selfdriven-peter/lab/contents/docs/pages',
  GATE_TITLE: 'Pete | Secure pages',
  GATE_URL: 'https://gate.example',
};

// stub GitHub so we can assert the URL the gate builds
let lastUrl = null;
globalThis.fetch = async (url) => {
  lastUrl = url;
  if (url.endsWith('peter-welcome.html'))
    return new Response('<a href="peter-other.html">next</a><a href="https://x.com/a.html">ext</a>', { status: 200 });
  return new Response('not found', { status: 404 });
};

const post = (body) => worker.fetch(
  new Request('https://gate.example/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env);

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' — ' + e.message); fail++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); };

console.log('\npages-gate');

await t('GET serves the gate screen', async () => {
  const r = await worker.fetch(new Request('https://gate.example/'), env);
  eq(r.status, 200);
  const h = await r.text();
  if (!h.includes('Locked')) throw new Error('no gate markup');
  eq(r.headers.get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
  eq(r.headers.get('X-Frame-Options'), 'DENY');
});

await t('GET ?page= pre-fills the page name', async () => {
  const r = await worker.fetch(new Request('https://gate.example/?page=peter-welcome'), env);
  const h = await r.text();
  if (!h.includes('value="peter-welcome"')) throw new Error('not pre-filled');
});

await t('robots.txt disallows everything', async () => {
  const r = await worker.fetch(new Request('https://gate.example/robots.txt'), env);
  if (!(await r.text()).includes('Disallow: /')) throw new Error('not disallowed');
});

await t('right password returns the page', async () => {
  const r = await post({ page: 'peter-welcome', password: CODE });
  eq(r.status, 200);
  eq(lastUrl, env.REPO_BASE + '/' + CODE + '-peter/peter-welcome.html', 'vault path:');
});

await t('links are rewritten to gate deep links', async () => {
  const r = await post({ page: 'peter-welcome', password: CODE });
  const h = await r.text();
  if (!h.includes('href="https://gate.example/#peter-other"')) throw new Error('relative link not rewritten');
  if (!h.includes('href="https://x.com/a.html"')) throw new Error('external link was rewritten');
});

await t('wrong password is refused', async () => {
  const r = await post({ page: 'peter-welcome', password: 'wrong' });
  eq(r.status, 403);
});

await t('wrong password and unknown project read identically', async () => {
  const a = await (await post({ page: 'peter-welcome', password: 'wrong' })).json();
  const b = await (await post({ page: 'nobody-x', password: 'wrong' })).json();
  eq(a.error, b.error, 'messages differ:');
});

await t('path traversal is blocked', async () => {
  for (const p of ['peter-../../../etc/passwd', '../secrets', 'peter-a/b', 'peter welcome']) {
    const r = await post({ page: p, password: CODE });
    if (r.status !== 400 && r.status !== 403) throw new Error(p + ' → ' + r.status);
  }
});

await t('missing page in the vault is a clean 404', async () => {
  const r = await post({ page: 'peter-nope', password: CODE });
  eq(r.status, 404);
});

await t('no password supplied is refused', async () => {
  eq((await post({ page: 'peter-welcome' })).status, 403);
});

await t('unconfigured gate fails closed', async () => {
  const r = await worker.fetch(
    new Request('https://gate.example/', { method: 'POST', body: '{}' }), { ...env, GH_TOKEN: '' });
  eq(r.status, 500);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
