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


// ---------- BazzyBox (BAZZYBOX=true) ----------
export const sqliteAccounts = s.sqliteTable('accounts', {
  id: s.text('id').primaryKey(),
  email: s.text('email').notNull().unique(),
  passwordHash: s.text('password_hash').notNull(),
  plan: s.text('plan').notNull(),
  walletMc: s.integer('wallet_mc').notNull().default(0),
  periodStart: s.integer('period_start'),
  periodEnd: s.integer('period_end'),
  usedBytes: s.integer('used_bytes').notNull().default(0),
  usageAt: s.integer('usage_at'),
  meteredAt: s.integer('metered_at'),
  sendBytes: s.integer('send_bytes').notNull().default(0),
  sendPeriodStart: s.integer('send_period_start'),
  createdAt: s.text('created_at').notNull(),
});

export const sqliteLedger = s.sqliteTable('ledger', {
  id: s.text('id').primaryKey(),
  accountId: s.text('account_id').notNull(),
  deltaMc: s.integer('delta_mc').notNull(),
  kind: s.text('kind').notNull(),
  note: s.text('note').notNull(),
  /** External reference (Stripe session id) — unique, makes webhook credits idempotent. */
  ref: s.text('ref').unique(),
  createdAt: s.text('created_at').notNull(),
});

/** Outside sign-ins linked to a BazzyBox account (Bazzy TV today). id = `${provider}:${subject}`. */
export const sqliteAccountLinks = s.sqliteTable('account_links', {
  id: s.text('id').primaryKey(),
  provider: s.text('provider').notNull(),
  subject: s.text('subject').notNull(),
  accountId: s.text('account_id').notNull(),
  createdAt: s.text('created_at').notNull(),
});

export const sqlitePlaylists = s.sqliteTable('playlists', {
  id: s.text('id').primaryKey(),
  accountId: s.text('account_id').notNull(),
  title: s.text('title').notNull(),
  description: s.text('description').notNull(),
  /** JSON array of file paths in the owner's folder, in play order. */
  items: s.text('items').notNull(),
  /** Cover picture, base64 (resized in the browser, at most ~1.5 MB). */
  cover: s.text('cover'),
  coverType: s.text('cover_type'),
  shareToken: s.text('share_token').unique(),
  plays: s.integer('plays').notNull().default(0),
  createdAt: s.text('created_at').notNull(),
  updatedAt: s.text('updated_at').notNull(),
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


export const pgAccounts = p.pgTable('accounts', {
  id: p.text('id').primaryKey(),
  email: p.text('email').notNull().unique(),
  passwordHash: p.text('password_hash').notNull(),
  plan: p.text('plan').notNull(),
  walletMc: p.bigint('wallet_mc', { mode: 'number' }).notNull().default(0),
  periodStart: p.bigint('period_start', { mode: 'number' }),
  periodEnd: p.bigint('period_end', { mode: 'number' }),
  usedBytes: p.bigint('used_bytes', { mode: 'number' }).notNull().default(0),
  usageAt: p.bigint('usage_at', { mode: 'number' }),
  meteredAt: p.bigint('metered_at', { mode: 'number' }),
  sendBytes: p.bigint('send_bytes', { mode: 'number' }).notNull().default(0),
  sendPeriodStart: p.bigint('send_period_start', { mode: 'number' }),
  createdAt: p.text('created_at').notNull(),
});

export const pgLedger = p.pgTable('ledger', {
  id: p.text('id').primaryKey(),
  accountId: p.text('account_id').notNull(),
  deltaMc: p.bigint('delta_mc', { mode: 'number' }).notNull(),
  kind: p.text('kind').notNull(),
  note: p.text('note').notNull(),
  ref: p.text('ref').unique(),
  createdAt: p.text('created_at').notNull(),
});

export const pgAccountLinks = p.pgTable('account_links', {
  id: p.text('id').primaryKey(),
  provider: p.text('provider').notNull(),
  subject: p.text('subject').notNull(),
  accountId: p.text('account_id').notNull(),
  createdAt: p.text('created_at').notNull(),
});

export const pgPlaylists = p.pgTable('playlists', {
  id: p.text('id').primaryKey(),
  accountId: p.text('account_id').notNull(),
  title: p.text('title').notNull(),
  description: p.text('description').notNull(),
  items: p.text('items').notNull(),
  cover: p.text('cover'),
  coverType: p.text('cover_type'),
  shareToken: p.text('share_token').unique(),
  plays: p.bigint('plays', { mode: 'number' }).notNull().default(0),
  createdAt: p.text('created_at').notNull(),
  updatedAt: p.text('updated_at').notNull(),
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
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, plan TEXT NOT NULL,
      wallet_mc ${big} NOT NULL DEFAULT 0, period_start ${big}, period_end ${big}, used_bytes ${big} NOT NULL DEFAULT 0,
      usage_at ${big}, metered_at ${big}, send_bytes ${big} NOT NULL DEFAULT 0, send_period_start ${big}, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, delta_mc ${big} NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL,
      ref TEXT UNIQUE, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ledger_account ON ledger (account_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS account_links (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS account_links_account ON account_links (account_id)`,
    `CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, items TEXT NOT NULL,
      cover TEXT, cover_type TEXT, share_token TEXT UNIQUE, plays ${big} NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS playlists_account ON playlists (account_id, updated_at)`,
  ];
}
