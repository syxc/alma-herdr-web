import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies the browser side dependencies into the web assets.
 *
 * The web client is served as plain files, so every library it uses in the
 * browser has to sit next to the compiled scripts instead of inside a
 * package folder.
 *
 * Two libraries are vendored:
 *   jsQR      decodes QR codes where BarcodeDetector is missing
 *   noble     pure JavaScript crypto, used where crypto.subtle is missing
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'web', 'vendor');

await mkdir(join(vendorDir, 'noble'), { recursive: true });

await copyFile(
  join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js'),
  join(vendorDir, 'jsQR.js')
);

/**
 * Copies the ESM build of a noble package and rewrites its imports.
 *
 * The packages import each other by package name, which a browser cannot
 * resolve, so every import becomes a relative path inside the vendor folder.
 */
async function vendorNoble(pkg, entries) {
  const packageRoot = join(root, 'node_modules', '@noble', pkg, 'esm');
  const copied = new Map();

  async function resolve(spec, fromFile) {
    if (spec.startsWith('@noble/')) {
      const parts = spec.split('/');
      const name = parts[1];
      const rest = parts.slice(2).join('/');
      return join(root, 'node_modules', '@noble', name, 'esm', rest);
    }
    if (spec.startsWith('.')) {
      return join(dirname(fromFile), spec);
    }
    return null;
  }

  async function copyFileTo(source) {
    const target = source.endsWith('.js') ? source : source + '.js';
    if (copied.has(target)) {
      return copied.get(target);
    }
    // A file keeps its path inside its own package, so two packages with a
    // file of the same name do not land on top of each other.
    const owner = ownerOf(target);
    const destination = join(vendorDir, 'noble', owner.name, owner.rest);
    copied.set(target, destination);
    let code = await readFile(target, 'utf8');
    const matches = [...code.matchAll(/from ['"]([^'"]+)['"]/g)];
    for (const match of matches) {
      const resolved = await resolve(match[1], target);
      if (resolved === null) {
        continue;
      }
      const dependency = await copyFileTo(resolved);
      let relativePath = relative(dirname(destination), dependency);
      if (!relativePath.startsWith('.')) {
        relativePath = './' + relativePath;
      }
      code = code.replace(match[0], "from '" + relativePath + "'");
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, code, 'utf8');
    return destination;
  }

  /** The package a file belongs to and its path inside that package. */
  function ownerOf(file) {
    const marker = join('node_modules', '@noble');
    const index = file.indexOf(marker);
    const after = file.slice(index + marker.length + 1);
    const parts = after.split(sep);
    const name = parts[0] ?? pkg;
    const rest = parts.slice(2).join(sep);
    return { name, rest };
  }

  for (const entry of entries) {
    await copyFileTo(join(packageRoot, entry));
  }
  return copied;
}

await mkdir(join(vendorDir, 'ghostty'), { recursive: true });

/**
 * The terminal kernel: Ghostty's VT, compiled to WebAssembly.
 *
 * The kernel is built from the Ghostty sources and kept in the repository,
 * so the build only checks that it is in place. See
 * scripts/build-ghostty-vt.sh for how it is built.
 */
const kernel = join(vendorDir, 'ghostty', 'ghostty-vt.wasm');
if (!existsSync(kernel)) {
  throw new Error(
    'the terminal kernel is missing, run scripts/build-ghostty-vt.sh to build it'
  );
}

const curves = await vendorNoble('curves', ['p256.js']);
const hashes = await vendorNoble('hashes', ['hkdf.js', 'sha2.js']);
const ciphers = await vendorNoble('ciphers', ['aes.js']);

/**
 * Copies the licenses of the vendored packages along with the code.
 *
 * The code itself stays out of the repository, but anything that ships the
 * built client has to carry the licenses of the libraries it contains.
 */
for (const [pkg, folder] of [
  ['jsqr', 'jsQR'],
  ['@noble/curves', 'noble/curves'],
  ['@noble/hashes', 'noble/hashes'],
  ['@noble/ciphers', 'noble/ciphers']
]) {
  const license = join(root, 'node_modules', pkg, 'LICENSE');
  const target = join(vendorDir, folder, 'LICENSE');
  await mkdir(dirname(target), { recursive: true });
  await copyFile(license, target);
}

console.log('vendored jsQR and noble into ' + vendorDir);
console.log('curves: ' + [...curves.keys()].length + ' files');
console.log('hashes: ' + [...hashes.keys()].length + ' files');
console.log('ciphers: ' + [...ciphers.keys()].length + ' files');
