import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, 'dist');

console.log('\n  SherlockMail Build\n  ==================\n');

mkdirSync(dist, { recursive: true });

console.log('  [1/5] Bundling with esbuild...');
execSync([
  'npx esbuild sea-entry.js',
  '--bundle --platform=node --target=node18 --format=cjs',
  '--outfile=dist/sherlock-mail.cjs',
  `--banner:js="const _importMetaUrl = require('url').pathToFileURL(__filename).href;"`,
  '--define:import.meta.url=_importMetaUrl',
].join(' '), { stdio: 'inherit', cwd: __dirname });

console.log('  [2/5] Copying static assets...');
cpSync(join(__dirname, 'src/ui/public'), join(dist, 'public'), { recursive: true });
copyFileSync(
  join(__dirname, 'node_modules/sql.js/dist/sql-wasm.wasm'),
  join(dist, 'sql-wasm.wasm')
);

console.log('  [3/5] Generating SEA blob...');
execSync('node --experimental-sea-config sea-config.json', {
  stdio: 'inherit', cwd: __dirname
});

console.log('  [4/5] Creating executable...');
const nodeExe = process.execPath;
copyFileSync(nodeExe, join(dist, 'SherlockMail.exe'));

console.log('  [5/5] Injecting SEA blob...');
execSync([
  'npx postject dist/SherlockMail.exe NODE_SEA_BLOB dist/sea-prep.blob',
  '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--overwrite',
].join(' '), { stdio: 'inherit', cwd: __dirname });

console.log('\n  Build complete!\n');
console.log('  Output: dist/SherlockMail.exe');
console.log('  To distribute, copy the entire dist/ folder:');
console.log('    dist/SherlockMail.exe');
console.log('    dist/public/         (dashboard UI)');
console.log('    dist/sql-wasm.wasm   (database engine)\n');
console.log('  Usage:');
console.log('    SherlockMail.exe              Start dashboard');
console.log('    SherlockMail.exe help          CLI help');
console.log('    SherlockMail.exe create ...    Create project\n');
