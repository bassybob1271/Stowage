/**
 * Drizzle schema, defined once per dialect with identical column names so the
 * same queries run on SQLite (default) and Postgres (DATABASE_URL=postgres://...).
 */
import * as s from 'drizzle-orm/sqlite-core';
import * as p from 'drizzle-orm/pg-core';

// ---------- SQLite ----------
export const sqliteFiles = s.sqliteTable(
  'files',
  {
    mountId: s.text('mount_id').notNull(),
    path: s.text('path').notNull(),
    parent: s.text('parent').notNull(),
    name: s.text('name').notNull(),
    size: s.integer('size').notNull(),
    mime: s.text('mime').notNull(),
    isDir: s.integer('is_dir', { mode: 'boolean' }).notNull(),
    etag: s.text('etag'),
    cid: s.text('cid'),
    modifiedAt: s.text('modified_at').notNull(),
    indexedAt: s.text('indexed_at').notNull(),
  },
  (t) => [s.primaryKey({ columns: [t.mountId, t.path] }), s.index('files_parent').on(t.mountId, t.parent)],
);

export const sqliteShares = s.sqliteTable('shares', {
  token: s.text('token').primaryKey(),
  mountId: s.text('mount_id').notNull(),
  path: s.text('path').notNull(),
  passwordHash: s.text('password_hash'),
  expiresAt: s.text('expires_at'),
  maxDownloads: s.integer('max_downloads'),
  downloads: s.integer('downloads').notNull().default(0),
  createdAt: s.text('created_at').notNull(),
});

export const sqliteUploads = s.sqliteTable('uploads', {
  id: s.text('id').primaryKey(),
  mountId: s.text('mount_id').notNull(),
  path: s.text('path').notNull(),
  size: s.integer('size'),
  offset: s.integer('offset').notNull().default(0),
  status: s.text('status').notNull(),
  error: s.text('error'),
  createdAt: s.text('created_at').notNull(),
  updatedAt: s.text('updated_at').notNull(),
});

export const sqliteMounts = s.sqliteTable('mounts', {
  id: s.text('id').primaryKey(),
  label: s.text('label').notNull(),
  kind: s.text('kind').notNull(),
  readOnly: s.integer('read_only', { mode: 'boolean' }).notNull(),
  /** AES-256-GCM encrypted JSON config: base64(iv|tag|ciphertext) */
  configEnc: s.text('config_enc').notNull(),
  createdAt: s.text('created_at').notNull(),
});

// ---------- Postgres ----------
export const pgFiles = p.pgTable(
  'files',
  {
    mountId: p.text('mount_id').notNull(),
    path: p.text('path').notNull(),
    parent: p.text('parent').notNull(),
    name: p.text('name').notNull(),
    size: p.bigint('size', { mode: 'number' }).notNull(),
    mime: p.text('mime').notNull(),
    isDir: p.boolean('is_dir').notNull(),
    etag: p.text('etag'),
    cid: p.text('cid'),
    modifiedAt: p.text('modified_at').notNull(),
    indexedAt: p.text('indexed_at').notNull(),
  },
  (t) => [p.primaryKey({ columns: [t.mountId, t.path] }), p.index('files_parent').on(t.mountId, t.parent)],
);

export const pgShares = p.pgTable('shares', {
  token: p.text('token').primaryKey(),
  mountId: p.text('mount_id').notNull(),
  path: p.text('path').notNull(),
  passwordHash: p.text('password_hash'),
  expiresAt: p.text('expires_at'),
  maxDownloads: p.integer('max_downloads'),
  downloads: p.integer('downloads').notNull().default(0),
  createdAt: p.text('created_at').notNull(),
});

export const pgUploads = p.pgTable('uploads', {
  id: p.text('id').primaryKey(),
  mountId: p.text('mount_id').notNull(),
  path: p.text('path').notNull(),
  size: p.bigint('size', { mode: 'number' }),
  offset: p.bigint('offset', { mode: 'number' }).notNull().default(0),
  status: p.text('status').notNull(),
  error: p.text('error'),
  createdAt: p.text('created_at').notNull(),
  updatedAt: p.text('updated_at').notNull(),
});

export const pgMounts = p.pgTable('mounts', {
  id: p.text('id').primaryKey(),
  label: p.text('label').notNull(),
  kind: p.text('kind').notNull(),
  readOnly: p.boolean('read_only').notNull(),
  configEnc: p.text('config_enc').notNull(),
  createdAt: p.text('created_at').notNull(),
});

/** Idempotent DDL. Kept as plain SQL so boot needs no migration tool. */
export function ddl(dialect: 'sqlite' | 'pg'): string[] {
  const big = dialect === 'pg' ? 'BIGINT' : 'INTEGER';
  const bool = dialect === 'pg' ? 'BOOLEAN' : 'INTEGER';
  return [
    `CREATE TABLE IF NOT EXISTS files (
      mount_id TEXT NOT NULL, path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL,
      size ${big} NOT NULL, mime TEXT NOT NULL, is_dir ${bool} NOT NULL, etag TEXT, cid TEXT,
      modified_at TEXT NOT NULL, indexed_at TEXT NOT NULL, PRIMARY KEY (mount_id, path))`,
    `CREATE INDEX IF NOT EXISTS files_parent ON files (mount_id, parent)`,
    `CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY, mount_id TEXT NOT NULL, path TEXT NOT NULL, password_hash TEXT,
      expires_at TEXT, max_downloads INTEGER, downloads INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, mount_id TEXT NOT NULL, path TEXT NOT NULL, size ${big}, "offset" ${big} NOT NULL DEFAULT 0,
      status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS mounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL, read_only ${bool} NOT NULL,
      config_enc TEXT NOT NULL, created_at TEXT NOT NULL)`,
  ];
}
