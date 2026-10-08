// Make a scanned model real-size and sit it on the floor.
// Usage: node fit-glb.mjs input.glb output.glb --height 69      (real height in cm)
//        node fit-glb.mjs input.glb output.glb --width 83       (or real width in cm)
//        node fit-glb.mjs input.glb output.glb --depth 57       (or real depth in cm)
// The model is scaled so that side matches, centred left-right and front-back, with its lowest point on the floor (y = 0).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';

const [input, output, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = parseFloat(rest[i + 1]);
const key = ['height', 'width', 'depth'].find((k) => opt[k] > 0);
if (!input || !output || !key) {
  console.error('Usage: node fit-glb.mjs input.glb output.glb --height <cm> | --width <cm> | --depth <cm>');
  process.exit(1);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];

const b = getBounds(scene);
const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]; // x = width, y = height, z = depth
const current = { width: size[0], height: size[1], depth: size[2] }[key];
const s = (opt[key] / 100) / current; // glTF units are metres

const fit = doc.createNode('fit-real-size')
  .setScale([s, s, s])
  .setTranslation([-(b.min[0] + b.max[0]) / 2 * s, -b.min[1] * s, -(b.min[2] + b.max[2]) / 2 * s]);
for (const child of scene.listChildren()) { scene.removeChild(child); fit.addChild(child); }
scene.addChild(fit);

await io.write(output, doc);
const nb = getBounds(scene);
const cm = (v) => Math.round(v * 1000) / 10;
console.log(`before: ${cm(size[0])} x ${cm(size[2])} x ${cm(size[1])} cm (W x D x H)  scale applied: ${s.toFixed(4)}`);
console.log(`after:  ${cm(nb.max[0] - nb.min[0])} x ${cm(nb.max[2] - nb.min[2])} x ${cm(nb.max[1] - nb.min[1])} cm, floor at y=${nb.min[1].toFixed(4)}`);
