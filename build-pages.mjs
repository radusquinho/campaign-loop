import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

const source = new URL('./public/', import.meta.url);
const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const asset of ['app.css', 'app.mjs', 'browser-store.mjs']) {
  await cp(new URL(asset, source), new URL(asset, output));
}
await cp(new URL('./engine.mjs', import.meta.url), new URL('engine.mjs', output));
const html = await readFile(new URL('index.html', source), 'utf8');
if (!html.includes('<html lang="es">')) throw new Error('No se pudo activar el modo demo.');
await writeFile(new URL('index.html', output), html.replace('<html lang="es">', '<html lang="es" data-runtime="browser">'));
await writeFile(new URL('.nojekyll', output), '');
