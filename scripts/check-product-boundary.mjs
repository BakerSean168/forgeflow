#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const roots = ['src', 'test', 'scripts', 'openhands_tools', 'deploy', 'docs', '.github'];
const rootFiles = ['README.md', 'package.json'];

// Assemble retired identifiers so this guard does not itself keep their literal
// spellings alive in the repository.
const retired = [
  ['AI', 'OFFICE'].join('_'),
  ['HERMES', 'V3'].join('_'),
  ['PIXEL', 'V4'].join('_'),
  `${['MODEL', 'CP'].join('_')}_`,
  ['hermes', 'ai', 'office'].join('-'),
  ['pixel', 'v4'].join('-'),
  ['pixel', 'agents'].join('-'),
  ['pixel', 'agent'].join(' '),
  ['pixel', 'invalid'].join('.'),
  ['virtual', 'office'].join(' '),
  ['pixel', 'art'].join('-'),
];
const retiredWords = [['employee'].join(''), ['workforce'].join(''), ['of', 'fice'].join(''), ['her', 'mes'].join('')];
const retiredPaths = ['/workspace/' + ['v', '4'].join('') + '/', '/api/' + ['v', '4'].join('') + '/', '/api/forge' + 'flow/'];
const allowedModelToken = 'deepseek-' + ['v', '4'].join('');

function filesUnder(directory) {
  const result = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
    }
  };
  visit(path.join(root, directory));
  return result;
}

const files = [
  ...roots.flatMap(filesUnder),
  ...rootFiles.map((file) => path.join(root, file)).filter(fs.existsSync),
];
const failures = [];
for (const file of files) {
  if (file === path.resolve(import.meta.filename)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const relative = path.relative(root, file);
  const normalized = text.toLowerCase().replaceAll(allowedModelToken, 'allowed-model-version');
  for (const value of [...retired, ...retiredWords, ...retiredPaths]) {
    if (normalized.includes(value.toLowerCase())) failures.push(`${relative}: retired product/runtime identity: ${value}`);
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => /^(?:v3|v4)$/i.test(segment))) failures.push(`${relative}: versioned legacy path segment`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`ForgeFlow product boundary OK (${files.length} files)`);
