#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
if (!file) throw new Error('usage: check-operation-store.mjs DATABASE');
const database = new DatabaseSync(file, { readOnly: true });
try {
  const integrity = database.prepare('PRAGMA integrity_check').get();
  if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('operation store integrity check failed');
  const migration = database.prepare('SELECT MAX(version) AS version FROM operation_migrations').get();
  if (Number(migration?.version ?? 0) !== 2) throw new Error('unsupported operation store schema');
  console.log('operation store compatible');
} finally { database.close(); }
