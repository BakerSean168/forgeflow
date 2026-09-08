#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(root, 'src');
const failures = [];
const legacyCompositionRouteBudget = 0;
const compositionSource = fs.readFileSync(path.join(sourceRoot, 'app.ts'), 'utf8');
const inlineRoutes = compositionSource.match(/\bapp\.(?:get|post|put|patch|delete)\(/g)?.length ?? 0;
const compositionLineBudget = 250;
const compositionLines = compositionSource.split(/\r?\n/).length;
if (compositionLines > compositionLineBudget)
  failures.push(
    `src/app.ts: composition root must remain thin (line budget ${compositionLineBudget}, found ${compositionLines})`,
  );
if (inlineRoutes > legacyCompositionRouteBudget)
  failures.push(
    `src/app.ts: new public routes must be Fastify modules under src/api (legacy inline route budget ${legacyCompositionRouteBudget}, found ${inlineRoutes})`,
  );

function visit(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...visit(full));
    else if (entry.isFile() && /\.(?:ts|mts)$/.test(entry.name)) files.push(full);
  }
  return files;
}

function imports(file, text) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const values = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) values.push(specifier.text);
    }
  }
  return values;
}

for (const file of visit(sourceRoot)) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');
  const moduleImports = imports(file, source);
  const rawRuntimeConfigForbidden =
    relative === 'src/app.ts' ||
    relative === 'src/bootstrap/executionRuntime.ts' ||
    relative.startsWith('src/api/') ||
    relative.startsWith('src/application/');
  const bootstrapFeatureTimerForbidden = relative.startsWith('src/bootstrap/');
  if (bootstrapFeatureTimerForbidden && /\b(?:setInterval|setImmediate)\s*\(/.test(source))
    failures.push(`${relative}: bootstrap must not own feature timers; use the reconciler lifecycle manager`);
  if (
    relative.startsWith('src/reconcilers/') &&
    relative !== 'src/reconcilers/lifecycle.ts' &&
    relative !== 'src/reconcilers/contracts.ts' &&
    /\b(?:setInterval|setImmediate)\s*\(/.test(source)
  )
    failures.push(`${relative}: feature reconcilers must declare cadence, not create timers`);
  if (
    relative !== 'src/bootstrap/executionRuntime.ts' &&
    relative !== 'src/reconcilers/runtimeAdmission.ts' &&
    /\b(?:reconcileRuntimeAdmission|shutdownRuntimeAdmission)\s*\(/.test(source)
  )
    failures.push(`${relative}: runtime admission lifecycle must flow through RuntimeAdmissionReconciler`);
  if (
    rawRuntimeConfigForbidden &&
    (/\bprocess\.env\b/.test(source) || /\b[A-Za-z_][A-Za-z0-9_]*\.FORGEFLOW_[A-Z0-9_]+/.test(source))
  )
    failures.push(`${relative}: runtime configuration must flow through src/bootstrap/config.ts, not raw environment access`);
  for (const target of moduleImports) {
    if (relative.startsWith('src/core/')) {
      if (target.includes('/api/') || target.includes('/platform/') || /(?:^|\/)app\.js$/.test(target))
        failures.push(`${relative}: core must not depend on API/platform/composition root: ${target}`);
      if (target.includes('/integrations/') && !relative.startsWith('src/core/adapters/'))
        failures.push(`${relative}: core feature code must depend on ports, not concrete integrations: ${target}`);
    }
    if (relative.startsWith('src/platform/')) {
      const allowedCore = target.includes('/core/domain/');
      if (
        target.includes('/api/') ||
        /(?:^|\/)app\.js$/.test(target) ||
        (target.includes('/core/') && !allowedCore)
      )
        failures.push(`${relative}: platform may depend only on core/domain contracts, never runtime internals: ${target}`);
    }
    if (relative.startsWith('src/api/')) {
      if (
        target.includes('/core/adapters/') ||
        target.includes('/core/persistence/') ||
        target.includes('/core/orchestration/') ||
        target.includes('/integrations/')
      )
        failures.push(`${relative}: API modules must consume application/platform contracts, not runtime internals/integrations: ${target}`);
    }
    if (relative.startsWith('src/application/') && target.includes('/integrations/'))
      failures.push(`${relative}: application services must depend on ports, not concrete integrations: ${target}`);
    if (
      relative.startsWith('src/bootstrap/') &&
      target.includes('/integrations/') &&
      !target.endsWith('/index.js')
    )
      failures.push(`${relative}: bootstrap must consume integration package index surfaces only: ${target}`);
    if (
      relative.startsWith('src/integrations/') &&
      (target.includes('/api/') ||
        target.includes('/application/') ||
        target.includes('/bootstrap/') ||
        /(?:^|\/)app\.js$/.test(target))
    )
      failures.push(`${relative}: integrations must not depend back on API/application/bootstrap/composition: ${target}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('ForgeFlow architecture boundary OK');
