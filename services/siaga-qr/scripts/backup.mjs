#!/usr/bin/env node
// Backup konsisten DB (aman saat service jalan): node scripts/backup.mjs [/path/backup.db]
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, loadDotEnv } from '../src/config.js';

loadDotEnv();
const { dbPath } = loadConfig();
const target = process.argv[2] ?? `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const db = new DatabaseSync(dbPath, { readOnly: true });
db.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(`backup: ${target}`);
