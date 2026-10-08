// AR QR Maker: stores uploaded models in R2 and serves one AR page per model.
const MAX_BYTES = 30 * 1024 * 1024;
const ID_RE = /^[a-z0-9-]{3,48}$/;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, n); };
const hex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };
const num = (v, lo, hi, d) => { v = parseFloat(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f\\]/g, '').trim().slice(0, 60);
const same = (a, b) => { a = String(a); b = String(b); let r = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return r === 0; };

/** Check the bytes really are a self-contained glTF 2.0 binary. Returns an error string or null. */
function checkGlb(buf) {
  if (buf.byteLength < 28 || buf.byteLength > MAX_BYTES) return 'File must be a GLB under 30 MB.';
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2) return 'That is not a valid .glb file.';
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > buf.byteLength) return 'That is not a valid .glb file.';
  let g;
  try { g = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))); } catch { return 'That is not a valid .glb file.'; }
  if (!g.asset || String(g.asset.version) !== '2.0') return 'Only glTF 2.0 files are supported.';
  for (const x of [...(g.buffers || []), ...(g.images || [])]) if (x.uri && !/^data:/i.test(x.uri)) return 'The file links to outside files. Export a single self-contained GLB.';
  return null;
}

function viewSettings(q) {
  return { dist: num(q.dist, 0.5, 5, 2.5), dmin: num(q.dmin, 0.3, 3, 1.5), dmax: num(q.dmax, 1, 8, 5), step: num(q.step, 0.1, 1, 0.5) };
}

async function page(env, req, id) {
  const obj = await env.MODELS.get(`meta/${id}.json`);
  if (!obj) return new Response('This AR page was not found. It may have been deleted.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const m = await obj.json();
  const tplRes = await env.ASSETS.fetch(new Request(new URL('/_tpl/index.html', req.url)));
  let t = await tplRes.text();
  const n = esc(cleanName(m.name)), v = viewSettings(m);
  t = t.replaceAll('__NAMEL__', n.toLowerCase()).replaceAll('__NAME__', n).replaceAll('__DIST__', String(v.dist)).replaceAll('__DMIN__', String(v.dmin)).replaceAll('__DMAX__', String(v.dmax)).replaceAll('__STEP__', String(v.step));
  return new Response(t, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === '/api/config' && req.method === 'GET') return json({ needsPasscode: !!env.PASSCODE, maxMB: MAX_BYTES / 1048576 });

      if (p === '/api/upload' && req.method === 'POST') {
        const form = await req.formData();
        if (env.PASSCODE && !same(form.get('passcode') || '', env.PASSCODE)) return json({ error: 'Wrong passcode.' }, 403);
        const file = form.get('file');
        const name = cleanName(form.get('name'));
        if (!name) return json({ error: 'Please give the product a name.' }, 400);
        if (!file || typeof file === 'string') return json({ error: 'No file received.' }, 400);
        const buf = await file.arrayBuffer();
        const bad = checkGlb(buf);
        if (bad) return json({ error: bad }, 400);
        const id = (slugify(name) || 'item') + '-' + rand(5);
        const token = hex(16);
        const v = viewSettings({ dist: form.get('dist'), dmin: form.get('dmin'), dmax: form.get('dmax'), step: form.get('step') });
        await env.MODELS.put(`models/${id}.glb`, buf, { httpMetadata: { contentType: 'model/gltf-binary', cacheControl: 'public, max-age=31536000, immutable' } });
        await env.MODELS.put(`meta/${id}.json`, JSON.stringify({ name, ...v, token, bytes: buf.byteLength, created: new Date().toISOString() }));
        return json({ id, url: `${url.origin}/p/${id}/`, token });
      }

      if (p === '/api/delete' && req.method === 'POST') {
        const { id, token } = await req.json();
        if (!ID_RE.test(String(id))) return json({ error: 'Bad id.' }, 400);
        const o = await env.MODELS.get(`meta/${id}.json`);
        if (!o) return json({ error: 'Not found.' }, 404);
        const m = await o.json();
        if (!same(token || '', m.token)) return json({ error: 'Wrong key.' }, 403);
        await env.MODELS.delete([`models/${id}.glb`, `meta/${id}.json`]);
        return json({ ok: true });
      }

      const m = p.match(/^\/p\/([a-z0-9-]+)(\/.*)?$/);
      if (m && req.method === 'GET') {
        const id = m[1], rest = m[2] || '';
        if (!ID_RE.test(id)) return new Response('Not found', { status: 404 });
        if (rest === '') return Response.redirect(`${url.origin}/p/${id}/`, 301);
        if (rest === '/' || rest === '/index.html') return page(env, req, id);
        if (rest === '/model.glb') {
          const o = await env.MODELS.get(`models/${id}.glb`);
          if (!o) return new Response('Not found', { status: 404 });
          return new Response(o.body, { headers: { 'content-type': 'model/gltf-binary', 'cache-control': 'public, max-age=31536000, immutable', 'content-length': String(o.size) } });
        }
        if (rest === '/model-viewer.min.js') return env.ASSETS.fetch(new Request(new URL('/model-viewer.min.js', req.url)));
        return new Response('Not found', { status: 404 });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    }
  }
};
