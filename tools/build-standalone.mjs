/**
 * Bundle the sketch into one self-contained HTML file.
 *
 *   node tools/build-standalone.mjs [outfile]
 *
 * The project is sixteen ES modules plus a vendored p5, which is right for
 * working on but useless for sharing: anywhere you might want to drop a preview
 * — an artifact host, a pasted file, an email attachment — takes exactly one
 * file and blocks external fetches. So this inlines everything.
 *
 * It is a real (if tiny) bundler rather than a concatenation, because
 * concatenating would collide: `core/noise.js` has its own private `lerp` and
 * `fade`, and `core/mathx.js` exports a different `lerp`. Each module is
 * therefore wrapped in its own scope and its exports handed to dependents
 * explicitly, which is what module scope was doing for us before.
 *
 * Only the syntax this project actually uses is supported — named imports,
 * `export class|function|const`, and `export { a, b }`. It is deliberately not
 * a general-purpose bundler.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'src/main.js');
const OUT = resolve(ROOT, process.argv[2] || 'dist/sea-monkey.html');

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm;
const EXPORT_DECL_RE = /^(\s*)export\s+(class|function|const|let)\s+/gm;

const modules = new Map();   // id -> { id, code, deps, exports }

function idOf(file) { return relative(ROOT, file).replace(/\\/g, '/'); }

function load(file) {
  const id = idOf(file);
  if (modules.has(id)) return id;

  let code = readFileSync(file, 'utf8');
  const deps = [];
  const exports = new Set();

  // Rewrite `import { a, b } from './x.js'` into a destructure of the
  // dependency's export record, and record the edge for the topological sort.
  code = code.replace(IMPORT_RE, (_m, names, spec) => {
    const depFile = resolve(dirname(file), spec);
    const depId = load(depFile);
    deps.push(depId);
    const clean = names.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    return `  const { ${clean} } = __M[${JSON.stringify(depId)}];`;
  });

  code = code.replace(EXPORT_LIST_RE, (_m, names) => {
    for (const n of names.split(',').map((s) => s.trim()).filter(Boolean)) exports.add(n);
    return '';
  });

  code = code.replace(EXPORT_DECL_RE, (_m, indent, kind) => `${indent}${kind} `);

  // Collect the names introduced by `export class|function|const` declarations.
  for (const m of readFileSync(file, 'utf8').matchAll(
    /^\s*export\s+(?:class|function|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    exports.add(m[1]);
  }

  modules.set(id, { id, code, deps, exports: [...exports] });
  return id;
}

load(ENTRY);

// Depth-first topological order: a module is emitted after everything it needs.
const order = [];
const seen = new Set();
(function visit(id) {
  if (seen.has(id)) return;
  seen.add(id);
  for (const d of modules.get(id).deps) visit(d);
  order.push(id);
})(idOf(ENTRY));

const bundle = [
  '(function () {',
  '  "use strict";',
  '  const __M = Object.create(null);',
  ...order.map((id) => {
    const m = modules.get(id);
    const ret = m.exports.length ? `    return { ${m.exports.join(', ')} };` : '    return {};';
    return [
      `  // ---- ${id} ${'-'.repeat(Math.max(0, 66 - id.length))}`,
      `  __M[${JSON.stringify(id)}] = (function () {`,
      m.code,
      ret,
      '  })();',
    ].join('\n');
  }),
  '})();',
].join('\n\n');

const p5 = readFileSync(resolve(ROOT, 'vendor/p5.min.js'), 'utf8');
const template = readFileSync(resolve(ROOT, 'tools/standalone.template.html'), 'utf8');

/**
 * Escape every non-ASCII character as \uXXXX.
 *
 * The page is injected into a host document whose <head> we do not control, so
 * we cannot count on a charset declaration reaching the parser in time. UTF-8
 * source read as Latin-1 turns the sketch's own bullet separators into "A."
 * mojibake. Escaping sidesteps the question entirely: the emitted script is
 * pure ASCII and decodes identically under any encoding.
 */
const asciiOnly = (src) =>
  src.replace(/[^\x00-\x7F]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));

const html = template
  .replace('/*__P5__*/', () => asciiOnly(p5))
  .replace('/*__BUNDLE__*/', () => asciiOnly(bundle));

const nonAscii = html.match(/[^\x00-\x7F]/g);
if (nonAscii) {
  console.warn(`  warning: ${nonAscii.length} non-ASCII char(s) remain in the template markup`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`bundled ${order.length} modules -> ${relative(ROOT, OUT)}`);
console.log(`  p5 ${kb(p5.length)}   sketch ${kb(bundle.length)}   page ${kb(html.length)}`);
console.log(`  order: ${order.join(' ')}`);
