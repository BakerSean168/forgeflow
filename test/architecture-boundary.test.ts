import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = fs.readFileSync(path.join(root, 'scripts/check-architecture-boundary.mjs'), 'utf8');

test('architecture boundary uses the TypeScript AST and permanently forbids inline composition routes', () => {
  assert.match(checker, /ts\.createSourceFile/);
  assert.match(checker, /ts\.isImportDeclaration/);
  assert.match(checker, /ts\.isExportDeclaration/);
  assert.match(checker, /legacyCompositionRouteBudget = 0/);
  assert.match(checker, /compositionLineBudget = 250/);
  assert.match(checker, /composition root must remain thin/);
  assert.match(checker, /runtime configuration must flow through src\/bootstrap\/config\.ts/);
  assert.match(checker, /rawRuntimeConfigForbidden/);
  assert.doesNotMatch(checker, /function imports\(text\)/);
});
