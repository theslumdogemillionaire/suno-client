// Stamps each build output with the module type Node needs.
//
// The package itself is "type": "module", so every .js under dist/ is treated as
// ESM unless a nearer package.json says otherwise. Without the commonjs marker,
// requiring dist/cjs/index.js fails with ERR_REQUIRE_ESM, which is the classic
// broken dual-package publish.
//
// Also makes the CLI executable: tsc emits 0644 and `bin` points at it.
import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

await writeFile(join(dist, 'esm', 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
await writeFile(join(dist, 'cjs', 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
await chmod(join(dist, 'esm', 'cli.js'), 0o755);

console.log('stamped dist/esm (module) and dist/cjs (commonjs), cli.js +x');
