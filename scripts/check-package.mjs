import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const expected = ['DOCUMENTATION.md', 'LICENSE', 'README.md', 'core.js', 'index.js', 'rules.js', 'rules.example.json', 'package.json'].sort();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'opencode-advisory-nudges');
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
assert.equal(manifest.private, undefined);
assert.equal(manifest.type, 'module');
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.repository.url, 'https://github.com/KonTy/opencode-advisory-nudges.git');
assert.deepEqual(manifest.exports, { '.': './index.js' });
assert.deepEqual([...manifest.files, 'package.json'].sort(), expected);
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
  assert.equal(Object.keys(manifest[field] ?? {}).length, 0, `${field} must remain empty`);
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublishOnly']) {
  assert.equal(manifest.scripts?.[hook], undefined, `${hook} is not needed for this source-only package`);
}

const scratch = mkdtempSync(join(tmpdir(), 'advisory-package-'));
try {
  const report = JSON.parse(execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', scratch,
  ], { cwd: root, encoding: 'utf8' }));
  const packed = Array.isArray(report) ? report : Object.values(report);
  assert.equal(packed.length, 1);
  const [pack] = packed;
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, manifest.version);
  assert.equal(pack.filename, `${manifest.name}-${manifest.version}.tgz`);
  assert.deepEqual(pack.files.map((file) => file.path).sort(), expected);
  assert.deepEqual(pack.bundled, []);
  const tarball = join(scratch, basename(pack.filename));
  const consumer = join(scratch, 'clean consumer with spaces');
  mkdirSync(consumer);
  execFileSync('npm', [
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', '--prefix', consumer, tarball,
  ], { cwd: consumer, stdio: 'pipe' });
  const installed = join(consumer, 'node_modules', manifest.name);
  assert.deepEqual(readdirSync(installed).sort(), expected);
  for (const name of expected) {
    assert.deepEqual(readFileSync(join(installed, name)), readFileSync(join(root, name)), name);
  }
  const entry = execFileSync(process.execPath, [
    '--input-type=module', '--eval',
    `console.log(import.meta.resolve(${JSON.stringify(manifest.name)}))`,
  ], { cwd: consumer, encoding: 'utf8' }).trim();
  assert.equal(fileURLToPath(entry), join(installed, 'index.js'));
  console.log(`Verified ${manifest.name}@${manifest.version}: exact eight files, byte-identical offline install and ESM entry resolution.`);
  console.log('This does not import the host-supplied Effect entry or validate native plugin loading.');
  if (process.argv[2]) {
    const output = resolve(process.argv[2]);
    mkdirSync(output, { recursive: true });
    const destination = join(output, pack.filename);
    copyFileSync(tarball, destination);
    console.log(`Verified tarball: ${destination}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
