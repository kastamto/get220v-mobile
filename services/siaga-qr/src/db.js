/**
 * Penyimpanan lifecycle label QR (SQLite bawaan Node, satu file, WAL).
 * Migration hanya additive (tidak drop/rename) supaya rollback aman: kembalikan backup
 * (`npm run backup`) + rilis sebelumnya.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE siaga_qr_labels (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        customer_id TEXT,
        device_id TEXT NOT NULL,
        site_id_snapshot TEXT,
        device_name_snapshot TEXT,
        key_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL UNIQUE,
        nonce_enc TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED','EXPIRED','REPLACED')),
        iat INTEGER NOT NULL,
        exp INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        issued_by_user_id TEXT NOT NULL,
        issued_by_name TEXT,
        revoked_at TEXT,
        revoked_by_user_id TEXT,
        revoke_reason TEXT,
        replaced_by_label_id TEXT REFERENCES siaga_qr_labels(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ix_labels_tenant_device_status ON siaga_qr_labels (tenant_id, device_id, status);
      CREATE INDEX ix_labels_tenant_issued ON siaga_qr_labels (tenant_id, issued_at DESC, id DESC);
      CREATE UNIQUE INDEX ux_labels_tenant_id ON siaga_qr_labels (tenant_id, id);
      -- kebijakan: maksimal satu label ACTIVE per device
      CREATE UNIQUE INDEX ux_labels_one_active ON siaga_qr_labels (tenant_id, device_id) WHERE status = 'ACTIVE';

      CREATE TABLE siaga_qr_audit (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        label_id TEXT,
        device_id TEXT,
        actor_user_id TEXT,
        actor_name TEXT,
        action TEXT NOT NULL CHECK (action IN ('GENERATED','VERIFIED','VERIFY_REJECTED','REVOKED','REISSUED','PRINT_EXPORTED')),
        at TEXT NOT NULL,
        correlation_id TEXT,
        reason TEXT,
        source_ip_hash TEXT,
        user_agent TEXT,
        app_version TEXT,
        metadata TEXT
      );
      CREATE INDEX ix_audit_tenant_at ON siaga_qr_audit (tenant_id, at DESC);
      CREATE INDEX ix_audit_label ON siaga_qr_audit (label_id);
      CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON siaga_qr_audit
        BEGIN SELECT RAISE(ABORT, 'siaga_qr_audit append-only'); END;
      CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON siaga_qr_audit
        BEGIN SELECT RAISE(ABORT, 'siaga_qr_audit append-only'); END;

      CREATE TABLE siaga_qr_idempotency (
        tenant_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        label_id TEXT NOT NULL REFERENCES siaga_qr_labels(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, actor_user_id, idem_key)
      );

      CREATE TABLE siaga_qr_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        items TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
    });
  }
}

/** Transaksi sinkron: tidak ada await di dalam fn, jadi atomik di proses tunggal ini. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const isUniqueViolation = (e) => /UNIQUE constraint failed/i.test(e?.message ?? '');
