import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { and, eq, sql, notInArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { FileStat } from '@stowage/shared';
import * as schema from './schema.js';

type Tables = {
  files: typeof schema.sqliteFiles;
  shares: typeof schema.sqliteShares;
  uploads: typeof schema.sqliteUploads;
  mounts: typeof schema.sqliteMounts;
  accounts: typeof schema.sqliteAccounts;
  ledger: typeof schema.sqliteLedger;
  accountLinks: typeof schema.sqliteAccountLinks;
  settlements: typeof schema.sqliteSettlements;
  importSources: typeof schema.sqliteImportSources;
  importJobs: typeof schema.sqliteImportJobs;
  importItems: typeof schema.sqliteImportItems;
  playlists: typeof schema.sqlitePlaylists;
  comments: typeof schema.sqliteComments;
  reviewLinks: typeof schema.sqliteReviewLinks;
};

/**
 * Both dialects expose the same query-builder surface; we type the handle as
 * the SQLite flavor and pick dialect-specific table objects at runtime.
 */
export interface Db {
  dialect: 'sqlite' | 'pg';
  orm: BetterSQLite3Database;
  t: Tables;
  close(): Promise<void>;
}

export async function openDb(url: string): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const client = postgres(url, { max: 10 });
    for (const stmt of schema.ddl('pg')) await client.unsafe(stmt);
    return {
      dialect: 'pg',
      orm: drizzle(client) as unknown as BetterSQLite3Database,
      t: { files: schema.pgFiles, shares: schema.pgShares, uploads: schema.pgUploads, mounts: schema.pgMounts, accounts: schema.pgAccounts, ledger: schema.pgLedger, accountLinks: schema.pgAccountLinks, settlements: schema.pgSettlements, importSources: schema.pgImportSources, importJobs: schema.pgImportJobs, importItems: schema.pgImportItems, playlists: schema.pgPlaylists, comments: schema.pgComments, reviewLinks: schema.pgReviewLinks } as unknown as Tables,
      close: () => client.end(),
    };
  }
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const file = url.replace(/^file:/, '');
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  for (const stmt of schema.ddl('sqlite')) sqlite.exec(stmt);
  return {
    dialect: 'sqlite',
    orm: drizzle(sqlite),
    t: { files: schema.sqliteFiles, shares: schema.sqliteShares, uploads: schema.sqliteUploads, mounts: schema.sqliteMounts, accounts: schema.sqliteAccounts, ledger: schema.sqliteLedger, accountLinks: schema.sqliteAccountLinks, settlements: schema.sqliteSettlements, importSources: schema.sqliteImportSources, importJobs: schema.sqliteImportJobs, importItems: schema.sqliteImportItems, playlists: schema.sqlitePlaylists, comments: schema.sqliteComments, reviewLinks: schema.sqliteReviewLinks },
    close: async () => {
      sqlite.close();
    },
  };
}

// ---------- files index ----------

function parentOf(path: string) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Replace the cached listing for one folder with fresh adapter results. */
export async function indexListing(db: Db, mountId: string, folder: string, entries: FileStat[], complete: boolean) {
  const f = db.t.files;
  const now = new Date().toISOString();
  for (const e of entries) {
    const row = {
      mountId,
      path: e.path,
      parent: parentOf(e.path),
      name: e.name,
      size: e.size,
      mime: e.mime,
      isDir: e.isDir,
      etag: e.etag ?? null,
      cid: e.cid ?? null,
      modifiedAt: e.modifiedAt,
      indexedAt: now,
    };
    await db.orm
      .insert(f)
      .values(row)
      .onConflictDoUpdate({ target: [f.mountId, f.path], set: row });
  }
  if (complete) {
    // Drop entries that disappeared from the source of truth.
    const keep = entries.map((e) => e.path);
    const cond = keep.length
      ? and(eq(f.mountId, mountId), eq(f.parent, folder), notInArray(f.path, keep))
      : and(eq(f.mountId, mountId), eq(f.parent, folder));
    await db.orm.delete(f).where(cond);
  }
}

export async function unindex(db: Db, mountId: string, path: string) {
  const f = db.t.files;
  await db.orm
    .delete(f)
    .where(and(eq(f.mountId, mountId), sql`(${f.path} = ${path} OR ${f.path} LIKE ${escapeLike(path) + '/%'} ESCAPE '\\')`));
}

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

export async function countIndexed(db: Db, mountId: string): Promise<number> {
  const f = db.t.files;
  const r = await db.orm.select({ n: sql<number>`count(*)` }).from(f).where(eq(f.mountId, mountId));
  return Number(r[0]?.n ?? 0);
}
