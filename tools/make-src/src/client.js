import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, weld, dedup, prune, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';
import QRCode from 'qrcode';
import TPL from '../tpl/index.html';
import CARD from '../tpl/card.html';

const $ = id => document.getElementById(id);
const MAX_TRIS = 100000, TARGET_TRIS = 60000, MAX_TEX = 2048, MAX_MB = 25;
let file = null, last = null;

/* ---------- model processing (runs in the visitor's browser) ---------- */
function triCount(doc) {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices(), pos = p.getAttribute('POSITION');
    n += Math.floor((i ? i.getCount() : (pos ? pos.getCount() : 0)) / 3);
  }
  return n;
}
async function shrinkTextures(doc) {
  let changed = 0, max = 0;
  for (const t of doc.getRoot().listTextures()) {
    const s = t.getSize(), mime = t.getMimeType();
    if (!s) continue;
    max = Math.max(max, s[0], s[1]);
    if (Math.max(s[0], s[1]) <= MAX_TEX || !/^image\/(png|jpeg)$/.test(mime)) continue;
    const k = MAX_TEX / Math.max(s[0], s[1]);
    const w = Math.max(1, Math.round(s[0] * k)), h = Math.max(1, Math.round(s[1] * k));
    const bmp = await createImageBitmap(new Blob([t.getImage()], { type: mime }));
    const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await c.convertToBlob({ type: mime, quality: 0.9 });
    t.setImage(new Uint8Array(await blob.arrayBuffer()));
    changed++;
  }
  return { changed, max };
}
function viewSettings(sz) {
  const mx = Math.max(sz.w, sz.h, sz.d);
  const dist = Math.min(2.5, Math.max(0.7, Math.round(mx * 4 * 10) / 10));
  return dist < 1.5 ? { dist, dmin: 0.4, dmax: 2, step: 0.2 } : { dist, dmin: 1.5, dmax: 5, step: 0.5 };
}
async function processGlb(buf, dim, cm) {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  await MeshoptDecoder.ready;
  let doc;
  try { doc = await io.readBinary(new Uint8Array(buf)); }
  catch (e) { throw new Error('Could not read this file. If it uses Draco compression, export it again without compression.'); }
  const warnings = [], notes = [];
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) throw new Error('This GLB has no scene in it.');
  await doc.transform(weld(), dedup(), prune());
  let tris = triCount(doc);
  if (tris > MAX_TRIS) {
    await MeshoptSimplifier.ready;
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIS / tris, error: 0.01 }), prune());
    const a = triCount(doc); notes.push(`Reduced from ${tris.toLocaleString()} to ${a.toLocaleString()} triangles so phones can load it.`); tris = a;
  }
  const tx = await shrinkTextures(doc);
  if (tx.changed) notes.push(`Large textures were shrunk to ${MAX_TEX}px.`);
  const b0 = getBounds(scene);
  const cur = { w: b0.max[0] - b0.min[0], h: b0.max[1] - b0.min[1], d: b0.max[2] - b0.min[2] };
  if (!(cur.h > 0)) throw new Error('The model has no height. Is the file empty?');
  const ref = { height: cur.h, width: cur.w, depth: cur.d }[dim];
  if (!(ref > 0)) throw new Error('The model has no ' + dim + '. Choose a different measurement.');
  const s = (cm / 100) / ref;
  const cx = (b0.min[0] + b0.max[0]) / 2, cz = (b0.min[2] + b0.max[2]) / 2;
  const wrap = doc.createNode('fit-real-size').setScale([s, s, s]).setTranslation([-cx * s, -b0.min[1] * s, -cz * s]);
  for (const c of scene.listChildren()) { scene.removeChild(c); wrap.addChild(c); }
  scene.addChild(wrap);
  const b1 = getBounds(scene);
  const size = { w: b1.max[0] - b1.min[0], h: b1.max[1] - b1.min[1], d: b1.max[2] - b1.min[2] };
  const out = await io.writeBinary(doc);
  const mb = out.byteLength / 1048576;
  if (mb > 10) warnings.push(`File is ${mb.toFixed(1)} MB. Google's AR viewer works best under 10 MB. Large files may not open on some phones.`);
  if (!doc.getRoot().listTextures().length) notes.push('No textures: it will look like a plain colour.');
  const mx = Math.max(size.w, size.h, size.d);
  if (mx > 5) warnings.push(`Longest side is ${(mx * 100).toFixed(0)} cm. Check the size you typed.`);
  if (mx < 0.02) warnings.push(`Longest side is only ${(mx * 100).toFixed(1)} cm. Check the size you typed.`);
  return { glb: out, size, tris, mb, warnings, notes };
}

/* ---------- GitHub publishing ---------- */
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f\u007f\\]/g, '').trim().slice(0, 60);
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

function fill(t, name, v) {
  const n = esc(cleanName(name));
  return t.replaceAll('__NAMEL__', n.toLowerCase()).replaceAll('__NAME__', n).replaceAll('__DIST__', String(v.dist)).replaceAll('__DMIN__', String(v.dmin)).replaceAll('__DMAX__', String(v.dmax)).replaceAll('__STEP__', String(v.step));
}
function toB64(bytes) { let s = ''; const c = 0x8000; for (let i = 0; i < bytes.length; i += c) s += String.fromCharCode.apply(null, bytes.subarray(i, i + c)); return btoa(s); }
const utf8 = s => new TextEncoder().encode(s);

const cfg = () => ({ repo: ($('repo').value || '').trim(), branch: ($('branch').value || 'main').trim(), token: ($('token').value || '').trim() });
async function gh(path, opts = {}) {
  const c = cfg();
  const r = await fetch('https://api.github.com/repos/' + c.repo + path, { ...opts, headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || ('GitHub error ' + r.status)); e.status = r.status; throw e; }
  return j;
}
function ghErr(e) {
  if (e.status === 401) return 'GitHub did not accept your token. Create a new one and paste it in Settings.';
  if (e.status === 403 || e.status === 404) return 'GitHub says this token cannot write to that repository. Check the repository name and that the token has "Contents: Read and write" for it.';
  return e.message || String(e);
}
const blob = async (bytes) => (await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: toB64(bytes), encoding: 'base64' }) })).sha;

async function freeSlug(base) {
  let slug = base, n = 1;
  while (true) {
    try { await gh('/contents/' + encodeURIComponent(slug) + '?ref=' + encodeURIComponent(cfg().branch)); slug = base + '-' + (++n); if (n > 50) throw new Error('Too many products with this name. Please pick another name.'); }
    catch (e) { if (e.status === 404) return slug; throw e; }
  }
}
async function commitTree(entries, message) {
  const c = cfg();
  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = await gh('/git/ref/heads/' + encodeURIComponent(c.branch));
    const base = (await gh('/git/commits/' + ref.object.sha)).tree.sha;
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base, tree: entries }) });
    const commit = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
    try { await gh('/git/refs/heads/' + encodeURIComponent(c.branch), { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) }); return commit.sha; }
    catch (e) { if (e.status !== 422 || attempt === 2) throw e; }
  }
}
async function waitLive(url, onTick) {
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    try { const r = await fetch(url + 'index.html?_=' + Date.now(), { cache: 'no-store' }); if (r.ok) { const g = await fetch(url + 'model.glb?_=' + Date.now(), { method: 'HEAD', cache: 'no-store' }); if (g.ok) return true; } } catch {}
    onTick(Math.round((Date.now() - t0) / 1000));
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}
function siteBase() { const c = cfg(); const [o, r] = c.repo.split('/'); return 'https://' + o.toLowerCase() + '.github.io/' + r + '/'; }

/* ---------- UI ---------- */
const check = () => { $('go').disabled = !(file && $('name').value.trim() && parseFloat($('cm').value) > 0 && cfg().token && /^[\w.-]+\/[\w.-]+$/.test(cfg().repo)); };
const showErr = m => { $('err').innerHTML = m ? '<div class="msg err"></div>' : ''; if (m) $('err').firstChild.textContent = m; };

function pick(f) {
  if (!f) return;
  if (!/\.glb$/i.test(f.name)) return showErr('Please choose a .glb file. Export your scan as GLB from Polycam, RealityScan or Kiri.');
  if (f.size > MAX_MB * 1048576) return showErr('That file is ' + (f.size / 1048576).toFixed(0) + ' MB. The limit is ' + MAX_MB + ' MB. Try exporting at lower quality.');
  showErr(''); file = f; $('fname').textContent = f.name + ' (' + (f.size / 1048576).toFixed(1) + ' MB)'; $('drop').classList.add('on');
  if (!$('name').value) $('name').value = f.name.replace(/\.glb$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  check();
}
$('drop').onclick = () => $('file').click();
$('file').onchange = e => pick(e.target.files[0]);
['dragover', 'dragenter'].forEach(t => $('drop').addEventListener(t, e => { e.preventDefault(); $('drop').classList.add('on'); }));
$('drop').addEventListener('drop', e => { e.preventDefault(); pick(e.dataTransfer.files[0]); });
for (const id of ['name', 'cm', 'repo', 'branch', 'token']) $(id).addEventListener('input', check);

const saved = store.get('ghcfg', { repo: 'Sharathpoojari5/AR-QR', branch: 'main', token: '' });
$('repo').value = saved.repo; $('branch').value = saved.branch; $('token').value = saved.token;
if (saved.token) $('setwrap').open = false; else $('setwrap').open = true;
$('savecfg').onclick = () => { store.set('ghcfg', cfg()); $('savecfg').textContent = 'Saved on this device'; setTimeout(() => $('savecfg').textContent = 'Save settings', 1600); check(); };
$('forget').onclick = () => { store.set('ghcfg', { repo: cfg().repo, branch: cfg().branch, token: '' }); $('token').value = ''; check(); };

$('go').onclick = async () => {
  $('go').disabled = true; showErr(''); $('out').style.display = 'none';
  const status = t => { $('go').textContent = t; };
  try {
    store.set('ghcfg', cfg());
    status('Resizing and optimising...');
    const buf = await file.arrayBuffer();
    const r = await processGlb(buf, $('dim').value, parseFloat($('cm').value));
    const v = viewSettings(r.size);
    const name = cleanName($('name').value);
    status('Checking the name...');
    const slug = await freeSlug(slugify(name) || 'item');
    const url = siteBase() + slug + '/';
    status('Making QR...');
    const qr = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, scale: 16 });
    const qrBytes = Uint8Array.from(atob(qr.split(',')[1]), ch => ch.charCodeAt(0));
    status('Sending to GitHub...');
    const mv = new Uint8Array(await (await fetch('model-viewer.min.js')).arrayBuffer());
    const [shaGlb, shaMv, shaQr, shaIdx, shaCard] = await Promise.all([blob(r.glb), blob(mv), blob(qrBytes), blob(utf8(fill(TPL, name, v))), blob(utf8(fill(CARD, name, v)))]);
    const entries = [['model.glb', shaGlb], ['model-viewer.min.js', shaMv], ['qr-universal.png', shaQr], ['index.html', shaIdx], ['card.html', shaCard]].map(([f, sha]) => ({ path: slug + '/' + f, mode: '100644', type: 'blob', sha }));
    await commitTree(entries, 'Add ' + name + ' (AR)');
    last = { slug, url, name, qr };
    const list = store.get('mine', []); list.unshift({ slug, url, name, at: Date.now() }); store.set('mine', list.slice(0, 50));
    showResult(r, URL.createObjectURL(new Blob([r.glb], { type: 'model/gltf-binary' })));
    renderMine();
    $('live').className = 'msg warn'; $('live').textContent = 'Going live on GitHub Pages. Wait for the green tick before scanning (usually 1 to 2 minutes).';
    const ok = await waitLive(url, s => { $('live').textContent = 'Going live on GitHub Pages... ' + s + 's. Wait for the green tick before scanning.'; });
    if (ok) { $('live').className = 'msg ok'; $('live').textContent = '✓ Live. You can scan the QR now.'; }
    else { $('live').className = 'msg warn'; $('live').textContent = 'Still publishing. GitHub can take a few more minutes. Try the link again shortly.'; }
  } catch (e) { showErr(ghErr(e)); }
  $('go').textContent = 'Publish and make my QR'; check();
};

function showResult(r, blobUrl) {
  $('pv').src = blobUrl; $('qr').src = last.qr; $('dl').href = last.qr; $('dl').download = last.slug + '-qr.png';
  $('sz').textContent = (r.size.w * 100).toFixed(0) + ' × ' + (r.size.d * 100).toFixed(0) + ' × ' + (r.size.h * 100).toFixed(0) + ' cm (W×D×H)';
  $('url').textContent = last.url;
  const m = $('msgs'); m.innerHTML = '';
  for (const [t, c] of [...r.warnings.map(w => [w, 'warn']), ...r.notes.map(w => [w, 'note'])]) { const d = document.createElement('div'); d.className = 'msg ' + c; d.textContent = t; m.appendChild(d); }
  $('cardname').textContent = last.name; $('cardqr').src = last.qr;
  $('out').style.display = 'block'; $('out').scrollIntoView({ behavior: 'smooth' });
}
$('copy').onclick = () => { navigator.clipboard.writeText(last.url); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy link', 1500); };
$('print').onclick = () => window.print();
$('again').onclick = () => { file = null; $('file').value = ''; $('name').value = ''; $('cm').value = ''; $('fname').textContent = 'Export your scan as GLB'; $('drop').classList.remove('on'); $('out').style.display = 'none'; check(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

async function removeFolder(slug) {
  const c = cfg();
  const files = await gh('/contents/' + encodeURIComponent(slug) + '?ref=' + encodeURIComponent(c.branch));
  const entries = files.filter(f => f.type === 'file').map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: null }));
  if (entries.length) await commitTree(entries, 'Remove ' + slug);
}
function renderMine() {
  const list = store.get('mine', []); const box = $('mine');
  $('minewrap').style.display = list.length ? 'block' : 'none'; box.innerHTML = '';
  for (const it of list) {
    const row = document.createElement('div'); row.className = 'kv';
    const a = document.createElement('a'); a.href = it.url; a.target = '_blank'; a.textContent = it.name;
    const s = document.createElement('span');
    const del = document.createElement('button'); del.className = 'ghost'; del.style.padding = '4px 10px'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete "' + it.name + '"? Its QR code will stop working.')) return;
      try { await removeFolder(it.slug); } catch (e) { if (e.status !== 404) return alert(ghErr(e)); }
      store.set('mine', store.get('mine', []).filter(x => x.slug !== it.slug)); renderMine();
    };
    s.appendChild(del); row.append(a, s); box.appendChild(row);
  }
}
renderMine(); check();
