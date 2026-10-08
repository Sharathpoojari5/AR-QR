import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, weld, dedup, prune, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptDecoder } from 'meshoptimizer';
import QRCode from 'qrcode';

const $ = id => document.getElementById(id);
const MAX_TRIS = 100000, TARGET_TRIS = 60000, MAX_TEX = 2048, MAX_MB = 25;
let file = null, slugEdited = false, last = null;

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

/* ---------- UI ---------- */
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const check = () => { $('go').disabled = !(file && $('name').value.trim() && parseFloat($('cm').value) > 0); };
const showErr = m => { $('err').innerHTML = m ? '<div class="msg err"></div>' : ''; if (m) $('err').firstChild.textContent = m; };

function pick(f) {
  if (!f) return;
  if (!/\.glb$/i.test(f.name)) return showErr('Please choose a .glb file. Export your scan as GLB from Polycam, RealityScan or Kiri.');
  if (f.size > MAX_MB * 1048576) return showErr(`That file is ${(f.size / 1048576).toFixed(0)} MB. The limit is ${MAX_MB} MB. Try exporting at lower quality.`);
  showErr(''); file = f; $('fname').textContent = f.name + ' (' + (f.size / 1048576).toFixed(1) + ' MB)'; $('drop').classList.add('on');
  if (!$('name').value) { $('name').value = f.name.replace(/\.glb$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
  check();
}
$('drop').onclick = () => $('file').click();
$('file').onchange = e => pick(e.target.files[0]);
['dragover', 'dragenter'].forEach(t => $('drop').addEventListener(t, e => { e.preventDefault(); $('drop').classList.add('on'); }));
$('drop').addEventListener('drop', e => { e.preventDefault(); pick(e.dataTransfer.files[0]); });
$('name').oninput = check; $('cm').oninput = check;

fetch('/api/config').then(r => r.json()).then(c => { if (c.needsPasscode) $('pcwrap').style.display = 'block'; }).catch(() => {});

async function qrFor(url) { return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 4, scale: 16 }); }

$('go').onclick = async () => {
  $('go').disabled = true; showErr('');
  const status = t => { $('go').textContent = t; };
  try {
    status('Resizing and optimising...');
    const cm = parseFloat($('cm').value);
    const buf = await file.arrayBuffer();
    const r = await processGlb(buf, $('dim').value, cm);
    status('Uploading...');
    const v = viewSettings(r.size);
    const fd = new FormData();
    fd.append('file', new Blob([r.glb], { type: 'model/gltf-binary' }), 'model.glb');
    fd.append('name', $('name').value.trim());
    for (const k of ['dist', 'dmin', 'dmax', 'step']) fd.append(k, String(v[k]));
    if ($('passcode').value) fd.append('passcode', $('passcode').value);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Upload failed. Please try again.');
    status('Making QR...');
    const qr = await qrFor(j.url);
    last = { id: j.id, url: j.url, token: j.token, name: $('name').value.trim(), qr };
    const list = store.get('mine', []); list.unshift({ id: j.id, url: j.url, token: j.token, name: last.name, at: Date.now() }); store.set('mine', list.slice(0, 50));
    showResult(r, URL.createObjectURL(new Blob([r.glb], { type: 'model/gltf-binary' })));
    renderMine();
  } catch (e) { showErr(e.message || String(e)); }
  $('go').textContent = 'Make my QR code'; check();
};

function showResult(r, blobUrl) {
  $('pv').src = blobUrl; $('qr').src = last.qr; $('dl').href = last.qr; $('dl').download = (slugify(last.name) || 'qr') + '-qr.png';
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
      const r = await fetch('/api/delete', { method: 'POST', body: JSON.stringify({ id: it.id, token: it.token }) });
      if (r.ok || r.status === 404) { store.set('mine', store.get('mine', []).filter(x => x.id !== it.id)); renderMine(); } else alert('Could not delete. Try again.');
    };
    s.appendChild(del); row.append(a, s); box.appendChild(row);
  }
}
renderMine();
