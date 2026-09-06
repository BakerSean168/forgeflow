import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { DataResetRequiredError, ForgeFlowError } from '../domain/errors.js';
import { SCHEMA_SQL } from './database.js';

export interface ResetOptions {
  env?: NodeJS.ProcessEnv;
  environment?: 'test' | 'development' | 'staging' | 'production';
  log?: (message: string) => void;
}

export interface ResetResult {
  databaseFile: string;
  scope: 'ALL_DATA';
  authorized: true;
}

export function resetDatabase(file: string, options: ResetOptions = {}): ResetResult {
  const env = options.env ?? process.env;
  const environment = options.environment ?? (env.NODE_ENV as ResetOptions['environment']) ?? 'development';
  if (env.FORGEFLOW_ALLOW_DATA_RESET !== 'true') throw new DataResetRequiredError(file);
  if (environment === 'production') throw new ForgeFlowError('PRODUCTION_RESET_FORBIDDEN');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as Array<{ name: string }>;
    for (const row of rows) db.exec('DROP TABLE IF EXISTS "' + row.name.replaceAll('"', '""') + '"');
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA_SQL);
  } finally {
    db.close();
  }
  const result: ResetResult = { databaseFile: file, scope: 'ALL_DATA', authorized: true };
  options.log?.('ForgeFlow database reset scope: ' + result.scope + ' at ' + file);
  return result;
}
