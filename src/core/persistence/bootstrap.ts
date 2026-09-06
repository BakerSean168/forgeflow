import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from './database.js';

export interface BootstrapOptions {
  dbFile?: string;
  env?: NodeJS.ProcessEnv;
  environment?: 'test' | 'development' | 'staging' | 'production';
  allowDataReset?: boolean;
}

export function bootstrapForgeFlow(options: BootstrapOptions = {}): { db: DatabaseSync; dbFile: string } {
  const env = options.env ?? process.env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dbFile = options.dbFile ?? env.FORGEFLOW_DB ?? path.resolve(here, '../../../data/forgeflow.sqlite');
  return { db: openDatabase(dbFile, options), dbFile };
}
