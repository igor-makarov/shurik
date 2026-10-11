import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/worker.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, legalComments: 'eof' });
const sha256 = createHash('sha256').update(await readFile('dist/worker.cjs')).digest('hex');
await writeFile('dist/manifest.json', JSON.stringify({ version: 1, sha256, node: 24,
  dependencies: JSON.parse(await readFile('package.json', 'utf8')).dependencies }, null, 2) + '\n');
console.log(`Standalone worker built: ${sha256}`);
