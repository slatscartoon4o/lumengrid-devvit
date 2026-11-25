/**
 * Dead-export check.
 *
 * Two defects shipped in this project that a test could not have caught
 * because nothing was broken at runtime:
 *
 *   - `awardFlair` was defined, correct, and never called, so streak flair was
 *     silently never granted.
 *   - `buildShareLine`, `buildSharePayload`, `placementCode` and
 *     `codeToPlacement` were exported and never used at all.
 *
 * ESLint's `no-unused-vars` does not see these: it works per file, so a symbol
 * exported from one module and imported by nobody looks used.  TypeScript's
 * `noUnusedLocals` has the same blind spot.  This script does the cross-file
 * count that neither does.
 *
 * Scope is deliberately narrow — exported *functions* in src/.  Exported types
 * and constants are excluded because they are legitimately part of a public
 * surface (the wire contract in api.ts, the cell codes in types.ts), and the
 * `__testing` export in UgcStudio exists for the showcase.
 *
 * Exit code 1 when anything is unreferenced, so this can gate a build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const ALSO_SCAN = ['tests', 'scripts'].map((d) => join(ROOT, d));

/** Every .ts/.tsx file under a directory, recursively. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const srcFiles = walk(SRC);
const allFiles = [...srcFiles, ...ALSO_SCAN.flatMap((d) => walk(d))];

/** name -> { file, line } for every `export function name` in src/. */
const exported = new Map();
const DECL = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;

for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(DECL)) {
    const name = match[1];
    const line = text.slice(0, match.index).split('\n').length;
    exported.set(name, { file, line });
  }
}

/** Count non-declaration references to each name across the whole tree. */
const uses = new Map([...exported.keys()].map((n) => [n, []]));

for (const file of allFiles) {
  const text = readFileSync(file, 'utf8');
  for (const [name, decl] of exported) {
    // Same file: skip the declaration itself but count every other occurrence.
    const pattern = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g');
    let count = 0;
    for (const m of text.matchAll(pattern)) {
      const isDecl = file === decl.file && text.slice(0, m.index).match(/export\s+(?:async\s+)?function\s+$/);
      if (!isDecl) count++;
    }
    if (count > 0) uses.get(name).push(relative(ROOT, file));
  }
}

const dead = [...exported].filter(([name]) => uses.get(name).length === 0);

if (dead.length === 0) {
  console.log(`ok    ${exported.size} exported functions in src/, all referenced`);
  process.exit(0);
}

for (const [name, decl] of dead) {
  console.error(`DEAD  ${relative(ROOT, decl.file)}:${decl.line}  ${name}() is exported but never referenced`);
}
console.error(`\n${dead.length} of ${exported.size} exported functions are unreachable.`);
console.error('Delete them, or call them — an unused export reads as a feature that exists.');
process.exit(1);
