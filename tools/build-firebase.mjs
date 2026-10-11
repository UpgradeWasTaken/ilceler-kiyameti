// Bundles the tree-shaken Firebase SDK into ../vendor/firebase.js so the site has
// no CDN dependency and loads only the code it needs.
//   cd tools && npm install && node build-firebase.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const r = await build({
  entryPoints: [fileURLToPath(new URL('./firebase-entry.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../vendor/firebase.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'eof',
  metafile: true,
});
const out = Object.entries(r.metafile.outputs)[0];
console.log(`${out[0]}: ${(out[1].bytes / 1024).toFixed(0)} KB`);
