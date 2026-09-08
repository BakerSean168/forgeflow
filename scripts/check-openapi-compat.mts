import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function localRef(document: JsonRecord, value: unknown): unknown {
  const source = record(value);
  const ref = source?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return value;
  let current: unknown = document;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    current = record(current)?.[key];
    if (current === undefined) break;
  }
  return current;
}

function operation(document: JsonRecord, pathName: string, method: HttpMethod): JsonRecord | undefined {
  const paths = record(document.paths);
  const item = record(paths?.[pathName]);
  return record(localRef(document, item?.[method]));
}

function pathItem(document: JsonRecord, pathName: string): JsonRecord | undefined {
  return record(localRef(document, record(document.paths)?.[pathName]));
}

function parameterMap(document: JsonRecord, pathName: string, method: HttpMethod): Map<string, JsonRecord> {
  const values = [
    ...array(pathItem(document, pathName)?.parameters),
    ...array(operation(document, pathName, method)?.parameters),
  ];
  const result = new Map<string, JsonRecord>();
  for (const raw of values) {
    const parameter = record(localRef(document, raw));
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.in !== 'string') continue;
    result.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return result;
}

function enumValues(schema: JsonRecord | undefined): string[] | undefined {
  if (!schema || !Array.isArray(schema.enum)) return undefined;
  return schema.enum.map((value) => JSON.stringify(value)).sort();
}

function schemaTypeSet(schema: JsonRecord | undefined): string[] | undefined {
  if (!schema) return undefined;
  if (typeof schema.type === 'string') return [schema.type];
  if (Array.isArray(schema.type) && schema.type.every((item) => typeof item === 'string'))
    return [...schema.type].sort() as string[];
  return undefined;
}

function compareEnums(
  baseline: JsonRecord | undefined,
  candidate: JsonRecord | undefined,
  location: string,
  failures: string[],
): void {
  const before = enumValues(baseline);
  const after = enumValues(candidate);
  if (!before || !after) return;
  const missing = before.filter((value) => !after.includes(value));
  if (missing.length)
    failures.push(`${location}: enum narrowed; removed ${missing.join(', ')}`);
}

function compareSchemaShape(
  baselineDocument: JsonRecord,
  candidateDocument: JsonRecord,
  baselineValue: unknown,
  candidateValue: unknown,
  location: string,
  failures: string[],
  direction: 'input' | 'output',
): void {
  const baseline = record(localRef(baselineDocument, baselineValue));
  const candidate = record(localRef(candidateDocument, candidateValue));
  if (!baseline) return;
  if (!candidate) {
    failures.push(`${location}: schema removed`);
    return;
  }

  compareEnums(baseline, candidate, location, failures);
  const beforeTypes = schemaTypeSet(baseline);
  const afterTypes = schemaTypeSet(candidate);
  if (beforeTypes && afterTypes && beforeTypes.join('|') !== afterTypes.join('|'))
    failures.push(`${location}: schema type changed from ${beforeTypes.join('|')} to ${afterTypes.join('|')}`);

  const beforeProperties = record(baseline.properties);
  const afterProperties = record(candidate.properties);
  if (beforeProperties && afterProperties) {
    for (const [name, child] of Object.entries(beforeProperties)) {
      if (!(name in afterProperties)) {
        failures.push(`${location}.properties.${name}: property removed`);
        continue;
      }
      compareSchemaShape(
        baselineDocument,
        candidateDocument,
        child,
        afterProperties[name],
        `${location}.properties.${name}`,
        failures,
        direction,
      );
    }
  }

  const beforeRequired = new Set(array(baseline.required).filter((value): value is string => typeof value === 'string'));
  const afterRequired = new Set(array(candidate.required).filter((value): value is string => typeof value === 'string'));
  if (direction === 'input') {
    for (const name of afterRequired)
      if (!beforeRequired.has(name)) failures.push(`${location}: request property became required: ${name}`);
  } else {
    for (const name of beforeRequired)
      if (!afterRequired.has(name)) failures.push(`${location}: required response property no longer guaranteed: ${name}`);
  }

  for (const key of ['items'] as const) {
    if (baseline[key] !== undefined)
      compareSchemaShape(
        baselineDocument,
        candidateDocument,
        baseline[key],
        candidate[key],
        `${location}.${key}`,
        failures,
        direction,
      );
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const before = array(baseline[key]);
    const after = array(candidate[key]);
    if (!before.length) continue;
    if (before.length !== after.length) {
      failures.push(`${location}.${key}: schema branch count changed from ${before.length} to ${after.length}`);
      continue;
    }
    for (let index = 0; index < before.length; index++)
      compareSchemaShape(
        baselineDocument,
        candidateDocument,
        before[index],
        after[index],
        `${location}.${key}[${index}]`,
        failures,
        direction,
      );
  }
}

function responseMap(document: JsonRecord, op: JsonRecord): JsonRecord {
  return record(op.responses) ?? {};
}

export function checkOpenApiCompatibility(baseline: unknown, candidate: unknown): string[] {
  const baselineDocument = record(baseline);
  const candidateDocument = record(candidate);
  if (!baselineDocument || !candidateDocument) return ['OpenAPI documents must be JSON objects'];
  const failures: string[] = [];
  const baselinePaths = record(baselineDocument.paths) ?? {};
  const candidatePaths = record(candidateDocument.paths) ?? {};

  for (const pathName of Object.keys(baselinePaths).sort()) {
    if (!(pathName in candidatePaths)) {
      failures.push(`${pathName}: path removed`);
      continue;
    }
    for (const method of HTTP_METHODS) {
      const before = operation(baselineDocument, pathName, method);
      if (!before) continue;
      const after = operation(candidateDocument, pathName, method);
      const operationName = `${method.toUpperCase()} ${pathName}`;
      if (!after) {
        failures.push(`${operationName}: operation removed`);
        continue;
      }

      const beforeParameters = parameterMap(baselineDocument, pathName, method);
      const afterParameters = parameterMap(candidateDocument, pathName, method);
      for (const [key, parameter] of beforeParameters) {
        const next = afterParameters.get(key);
        if (!next) {
          failures.push(`${operationName}: parameter removed: ${key}`);
          continue;
        }
        if (parameter.required !== true && next.required === true)
          failures.push(`${operationName}: parameter became required: ${key}`);
        compareSchemaShape(
          baselineDocument,
          candidateDocument,
          parameter.schema,
          next.schema,
          `${operationName} parameter ${key}`,
          failures,
          'input',
        );
      }
      for (const [key, parameter] of afterParameters)
        if (!beforeParameters.has(key) && parameter.required === true)
          failures.push(`${operationName}: new required parameter: ${key}`);

      const beforeBody = record(localRef(baselineDocument, before.requestBody));
      const afterBody = record(localRef(candidateDocument, after.requestBody));
      if (!beforeBody && afterBody?.required === true)
        failures.push(`${operationName}: new required request body`);
      if (beforeBody) {
        if (!afterBody) failures.push(`${operationName}: request body removed from contract`);
        else {
          if (beforeBody.required !== true && afterBody.required === true)
            failures.push(`${operationName}: request body became required`);
          const beforeContent = record(beforeBody.content) ?? {};
          const afterContent = record(afterBody.content) ?? {};
          for (const [mediaType, media] of Object.entries(beforeContent)) {
            if (!(mediaType in afterContent)) {
              failures.push(`${operationName}: request media type removed: ${mediaType}`);
              continue;
            }
            compareSchemaShape(
              baselineDocument,
              candidateDocument,
              record(media)?.schema,
              record(afterContent[mediaType])?.schema,
              `${operationName} request ${mediaType}`,
              failures,
              'input',
            );
          }
        }
      }

      const beforeResponses = responseMap(baselineDocument, before);
      const afterResponses = responseMap(candidateDocument, after);
      for (const [status, responseValue] of Object.entries(beforeResponses)) {
        if (!(status in afterResponses)) {
          failures.push(`${operationName}: response status removed: ${status}`);
          continue;
        }
        const beforeResponse = record(localRef(baselineDocument, responseValue));
        const afterResponse = record(localRef(candidateDocument, afterResponses[status]));
        const beforeContent = record(beforeResponse?.content) ?? {};
        const afterContent = record(afterResponse?.content) ?? {};
        for (const [mediaType, media] of Object.entries(beforeContent)) {
          if (!(mediaType in afterContent)) {
            failures.push(`${operationName} response ${status}: media type removed: ${mediaType}`);
            continue;
          }
          compareSchemaShape(
            baselineDocument,
            candidateDocument,
            record(media)?.schema,
            record(afterContent[mediaType])?.schema,
            `${operationName} response ${status} ${mediaType}`,
            failures,
            'output',
          );
        }
      }
    }
  }
  return failures;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const baselineFile = path.resolve(root, process.argv[2] ?? 'api/compat/openapi.v1.2.1.json');
  const candidateFile = path.resolve(root, process.argv[3] ?? 'api/openapi.v1.json');
  const failures = checkOpenApiCompatibility(readJson(baselineFile), readJson(candidateFile));
  if (failures.length) {
    console.error('ForgeFlow V1 OpenAPI compatibility check failed:\n' + failures.map((item) => `- ${item}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`ForgeFlow V1 OpenAPI compatibility OK (${path.relative(root, baselineFile)} -> ${path.relative(root, candidateFile)})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
