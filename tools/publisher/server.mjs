import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { processGlb } from './process.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(here, 'config.json');
const defaults = {
  baseUrl: 'https://sharathpoojari5.github.io/AR-QR',   // public address of the folder that holds the product folders
  outputDir: path.resolve(here, '..', '..'),             // where product folders are written (the AR-QR repo root)
  port: 4173
};
async function loadCfg() { try { return { ...defaults, ...JSON.parse(await fs.readFile(cfgPath, 'utf8')) }; } catch { return { ...defaults }; } }
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function viewSettings(sizeM) {
  const mx = Math.max(sizeM.w, sizeM.h, sizeM.d);
  const dist = Math.min(2.5, Math.max(0.7, Math.round(mx * 4 * 10) / 10));
  return dist < 1.5 ? { dist, dmin: 0.4, dmax: 2, step: 0.2 } : { dist, dmin: 1.5, dmax: 5, step: 0.5 };
}

async function publish({ buf, name, slug, heightCm, widthCm, depthCm }, cfg) {
  if (!name) throw new Error('Give the product a name.');
  slug = slugify(slug || name);
  if (!slug) throw new Error('Name needs letters or numbers.');
  if (['tools', 'node_modules', 'publisher', 'assets'].includes(slug)) throw new Error('Pick a different name; that one is reserved.');
  const { glb, report } = await processGlb(buf, { heightCm, widthCm, depthCm });
  const dir = path.join(cfg.outputDir, slug);
  const existed = await fs.stat(dir).then(() => true, () => false);
  await fs.mkdir(dir, { recursive: true });
  const v = viewSettings(report.sizeM);
  const nameE = esc(name.trim());
  const fill = t => t.replaceAll('__NAMEL__', nameE.toLowerCase()).replaceAll('__NAME__', nameE)
    .replaceAll('__DIST__', String(v.dist)).replaceAll('__DMIN__', String(v.dmin)).replaceAll('__DMAX__', String(v.dmax)).replaceAll('__STEP__', String(v.step));
  const tpl = path.join(here, 'template');
  await fs.writeFile(path.join(dir, 'index.html'), fill(await fs.readFile(path.join(tpl, 'index.html'), 'utf8')));
  await fs.writeFile(path.join(dir, 'card.html'), fill(await fs.readFile(path.join(tpl, 'card.html'), 'utf8')));
  await fs.copyFile(path.join(tpl, 'model-viewer.min.js'), path.join(dir, 'model-viewer.min.js'));
  await fs.writeFile(path.join(dir, 'model.glb'), glb);
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/${slug}/`;
  await QRCode.toFile(path.join(dir, 'qr-universal.png'), url, { errorCorrectionLevel: 'M', margin: 4, scale: 16 });
  return { slug, url, dir, existed, report, qr: `/files/${slug}/qr-universal.png`, preview: `/files/${slug}/model.glb` };
}

const ui = await fs.readFile(path.join(here, 'ui.html'), 'utf8');
const mime = { '.png': 'image/png', '.glb': 'model/gltf-binary', '.js': 'text/javascript', '.html': 'text/html' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  try {
    const cfg = await loadCfg();
    if (req.method === 'GET' && u.pathname === '/') return send(200, ui, 'text/html; charset=utf-8');
    if (req.method === 'POST' && u.pathname === '/api/quit') { send(200, { ok: true }); setTimeout(() => process.exit(0), 150); return; }
    if (u.pathname === '/favicon.ico') return send(204, '');
    if (req.method === 'GET' && u.pathname === '/mv.js') return send(200, await fs.readFile(path.join(here, 'template', 'model-viewer.min.js')), 'text/javascript');
    if (req.method === 'GET' && u.pathname === '/api/config') return send(200, { baseUrl: cfg.baseUrl, outputDir: cfg.outputDir });
    if (req.method === 'POST' && u.pathname === '/api/config') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const j = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const next = { ...cfg }; if (typeof j.baseUrl === 'string' && /^https?:\/\//.test(j.baseUrl)) next.baseUrl = j.baseUrl.replace(/\/+$/, '');
      await fs.writeFile(cfgPath, JSON.stringify({ baseUrl: next.baseUrl, outputDir: next.outputDir, port: next.port }, null, 2));
      return send(200, { ok: true, baseUrl: next.baseUrl });
    }
    if (req.method === 'POST' && u.pathname === '/api/publish') {
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 200 * 1048576) throw new Error('File is over 200 MB.'); chunks.push(c); }
      const buf = Buffer.concat(chunks);
      if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('That is not a .glb file. Export your scan as GLB.');
      const num = k => { const x = parseFloat(u.searchParams.get(k)); return x > 0 ? x : undefined; };
      const out = await publish({ buf, name: u.searchParams.get('name') || '', slug: u.searchParams.get('slug') || '', heightCm: num('height'), widthCm: num('width'), depthCm: num('depth') }, cfg);
      return send(200, out);
    }
    if (req.method === 'GET' && u.pathname.startsWith('/files/')) {
      const rel = decodeURIComponent(u.pathname.slice(7)); const abs = path.resolve(cfg.outputDir, rel);
      if (!abs.startsWith(path.resolve(cfg.outputDir) + path.sep)) return send(403, { error: 'no' });
      return send(200, await fs.readFile(abs), mime[path.extname(abs)] || 'application/octet-stream');
    }
    send(404, { error: 'not found' });
  } catch (e) { send(400, { error: String(e.message || e) }); }
}).listen((await loadCfg()).port, '127.0.0.1', async () => { const c = await loadCfg(); console.log(`AR publisher running: http://localhost:${c.port}\nProducts are written to: ${c.outputDir}`); });
