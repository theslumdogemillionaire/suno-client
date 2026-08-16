// tsc does not copy .json, and the drift baselines are data the built client
// reads at runtime. Without this the published package loads zero baselines,
// drift detection silently does nothing, and nothing says so.
import { chmod, cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'drift', 'baselines');
const to = join(root, 'dist', 'drift', 'baselines');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });

// package.json points `bin` at dist/cli.js. tsc emits it 0644, so a global
// install would produce a command that cannot execute.
await chmod(join(root, 'dist', 'cli.js'), 0o755);

console.log(`copied baselines -> ${to}`);
