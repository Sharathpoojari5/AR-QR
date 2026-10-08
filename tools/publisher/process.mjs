import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, weld, dedup, prune, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const MAX_TRIS = +process.env.AR_MAX_TRIS || 100000, TARGET_TRIS = Math.round(MAX_TRIS * 0.6), MAX_TEX = 2048, MAX_MB = 10;

function triCount(doc) {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const i = p.getIndices(), pos = p.getAttribute('POSITION');
    n += Math.floor((i ? i.getCount() : (pos ? pos.getCount() : 0)) / 3);
  }
  return n;
}

/** Take a GLB buffer and the real height (cm). Returns {glb, report}. */
export async function processGlb(buf, { heightCm, widthCm, depthCm }) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(buf));
  const warnings = [], notes = [];
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  if (!scene) throw new Error('This GLB has no scene in it.');
  if (root.listAnimations().length) notes.push('Has animation; it is kept but AR viewers may not play it.');

  await doc.transform(weld(), dedup(), prune());

  let tris = triCount(doc);
  if (tris > MAX_TRIS) {
    await MeshoptSimplifier.ready;
    await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: TARGET_TRIS / tris, error: 0.01 }), prune());
    const after = triCount(doc);
    notes.push(`Reduced from ${tris.toLocaleString()} to ${after.toLocaleString()} triangles so phones can load it.`);
    tris = after;
  }

  // textures: shrink anything over 2048 px if sharp is available
  let maxTex = 0;
  for (const t of root.listTextures()) { const s = t.getSize(); if (s) maxTex = Math.max(maxTex, s[0], s[1]); }
  if (maxTex > MAX_TEX) {
    try {
      const sharp = (await import('sharp')).default;
      const { textureCompress } = await import('@gltf-transform/functions');
      await doc.transform(textureCompress({ encoder: sharp, resize: [MAX_TEX, MAX_TEX] }));
      notes.push(`Textures were up to ${maxTex}px; shrunk to ${MAX_TEX}px.`);
      maxTex = MAX_TEX;
    } catch {
      warnings.push(`Textures are up to ${maxTex}px. Google's AR viewer may refuse more than ${MAX_TEX}px. Run "npm install" to enable automatic shrinking.`);
    }
  }

  // real size
  const b0 = getBounds(scene);
  const cur = { w: b0.max[0] - b0.min[0], h: b0.max[1] - b0.min[1], d: b0.max[2] - b0.min[2] };
  if (!(cur.h > 0)) throw new Error('The model has no height. Is the file empty?');
  const target = heightCm ? [heightCm / 100, cur.h] : widthCm ? [widthCm / 100, cur.w] : depthCm ? [depthCm / 100, cur.d] : null;
  if (!target) throw new Error('Give the real height, width or depth in cm.');
  const s = target[0] / target[1];
  if (s < 0.001 || s > 1000) warnings.push(`Scale factor is ${s.toFixed(4)}. Check the size you typed.`);

  const cx = (b0.min[0] + b0.max[0]) / 2, cz = (b0.min[2] + b0.max[2]) / 2;
  const wrap = doc.createNode('fit-real-size').setScale([s, s, s]).setTranslation([-cx * s, -b0.min[1] * s, -cz * s]);
  for (const child of scene.listChildren()) { scene.removeChild(child); wrap.addChild(child); }
  scene.addChild(wrap);

  const b1 = getBounds(scene);
  const size = { w: b1.max[0] - b1.min[0], h: b1.max[1] - b1.min[1], d: b1.max[2] - b1.min[2] };
  const out = Buffer.from(await io.writeBinary(doc));
  const mb = out.length / 1048576;

  if (mb > MAX_MB) warnings.push(`File is ${mb.toFixed(1)} MB. Google's AR viewer works best under ${MAX_MB} MB.`);
  if (!root.listTextures().length) notes.push('No textures: it will show as a plain colour. For a realistic look use a scan or model with textures.');
  const mx = Math.max(size.w, size.h, size.d);
  if (mx > 5) warnings.push(`Longest side is ${(mx * 100).toFixed(0)} cm, over 5 m. Check the size you typed.`);
  if (mx < 0.02) warnings.push(`Longest side is only ${(mx * 100).toFixed(1)} cm. Check the size you typed.`);

  return {
    glb: out,
    report: { cmBefore: { w: cur.w, h: cur.h, d: cur.d }, sizeCm: { w: size.w * 100, h: size.h * 100, d: size.d * 100 }, sizeM: size, scale: s, triangles: tris, textureMax: maxTex, mb, warnings, notes }
  };
}
