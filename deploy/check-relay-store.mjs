#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
if (!file) throw new Error('usage: check-relay-store.mjs DATABASE');
const database = new DatabaseSync(file, { readOnly: true });
try {
  const integrity = database.prepare('PRAGMA integrity_check').get();
  if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('relay store integrity check failed');
  const version = database.prepare('PRAGMA user_version').get();
  if (Number(version?.user_version ?? 0) !== 2) throw new Error('unsupported relay store schema');
  database.prepare('SELECT operation_id FROM relay_operations LIMIT 1').all();
  console.log('relay store compatible');
} finally { database.close(); }
