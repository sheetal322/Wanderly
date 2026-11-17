import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { testDatabaseUrl } from './database';

/**
 * Recreates the test database and applies the real migrations to it, so every
 * run also proves the migrations apply cleanly to an empty database.
 */
export default async function globalSetup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const database = url.pathname.slice(1);

  // This drops a database. Refuse anything that is not obviously disposable.
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to recreate "${database}": test database names must end in _test`);
  }

  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const client = new Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'libs/db/prisma/schema.prisma'], {
    cwd: resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}
