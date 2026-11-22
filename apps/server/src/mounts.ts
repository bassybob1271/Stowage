import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { eq } from 'drizzle-orm';
import { mountDefSchema, mountsFileSchema, type MountDef, type MountInfo } from '@stowage/shared';
import { createMount, type EmulatedAdapter } from '@stowage/storage';
import type { Db } from './db/index.js';
import { decrypt, encrypt } from './crypto.js';
import { log } from './log.js';

export interface Mount {
  def: MountDef & { label: string };
  adapter: EmulatedAdapter;
  source: 'yaml' | 'db';
  health: { ok: boolean; detail?: string; checkedAt: number };
}

/** Replace ${VAR} and ${VAR:-default} in YAML string values with env vars. */
export function interpolateEnv<T>(v: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof v === 'string')
    return v.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, k: string, d?: string) => env[k] ?? d ?? '') as T;
  if (Array.isArray(v)) return v.map((x) => interpolateEnv(x, env)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolateEnv(x, env)])) as T;
  return v;
}

/** Coerce "true"/"false"/numbers produced by env interpolation. */
function coerce(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^\d+$/.test(v) && v.length < 15) return Number(v);
    return v;
  }
  if (Array.isArray(v)) return v.map(coerce);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, coerce(x)]));
  return v;
}

export class MountRegistry {
  private readonly mounts = new Map<string, Mount>();
  constructor(private readonly db: Db, private readonly masterKey: string) {}

  get(id: string): Mount | undefined {
    return this.mounts.get(id);
  }
  all(): Mount[] {
    return [...this.mounts.values()];
  }

  private add(def: MountDef, source: 'yaml' | 'db') {
    if (this.mounts.has(def.id)) throw new Error(`duplicate mount id "${def.id}"`);
    const full = { ...def, label: def.label ?? def.id };
    this.mounts.set(def.id, { def: full, adapter: createMount(full), source, health: { ok: false, detail: 'pending', checkedAt: 0 } });
  }

  async load(mountsFile: string) {
    if (existsSync(mountsFile)) {
      const raw = coerce(interpolateEnv(parseYaml(readFileSync(mountsFile, 'utf8')) ?? {}));
      const parsed = mountsFileSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`invalid ${mountsFile}: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
      for (const m of parsed.data.mounts) this.add(m, 'yaml');
    } else {
      log.warn('mounts.file_missing', { mountsFile });
    }
    const t = this.db.t.mounts;
    for (const row of await this.db.orm.select().from(t)) {
      try {
        const config = JSON.parse(decrypt(this.masterKey, row.configEnc));
        this.add(mountDefSchema.parse({ id: row.id, label: row.label, kind: row.kind, readOnly: row.readOnly, config }), 'db');
      } catch (e) {
        log.error('mounts.db_load_failed', { id: row.id, error: (e as Error).message });
      }
    }
    log.info('mounts.loaded', { ids: [...this.mounts.keys()] });
  }

  async create(def: MountDef) {
    this.add(def, 'db');
    const t = this.db.t.mounts;
    await this.db.orm.insert(t).values({
      id: def.id,
      label: def.label ?? def.id,
      kind: def.kind,
      readOnly: def.readOnly,
      configEnc: encrypt(this.masterKey, JSON.stringify(def.config)),
      createdAt: new Date().toISOString(),
    });
    await this.checkOne(this.mounts.get(def.id)!);
  }

  async remove(id: string) {
    const m = this.mounts.get(id);
    if (!m) return false;
    if (m.source !== 'db') throw Object.assign(new Error('mounts from mounts.yaml must be removed in the file'), { status: 400 });
    await m.adapter.close?.();
    this.mounts.delete(id);
    await this.db.orm.delete(this.db.t.mounts).where(eq(this.db.t.mounts.id, id));
    return true;
  }

  private async checkOne(m: Mount) {
    const h = await Promise.race([
      m.adapter.healthCheck(),
      new Promise<{ ok: false; detail: string }>((r) => setTimeout(() => r({ ok: false, detail: 'health check timed out' }), 8000)),
    ]);
    m.health = { ...h, checkedAt: Date.now() };
  }

  async checkHealth(maxAgeMs = 30_000) {
    await Promise.all(this.all().filter((m) => Date.now() - m.health.checkedAt > maxAgeMs).map((m) => this.checkOne(m)));
  }

  info(m: Mount): MountInfo {
    return {
      id: m.def.id,
      label: m.def.label,
      kind: m.def.kind,
      readOnly: m.def.readOnly,
      capabilities: m.adapter.capabilities,
      emulated: m.adapter.emulated,
      health: { ok: m.health.ok, detail: m.health.detail },
      source: m.source,
    };
  }

  async closeAll() {
    await Promise.all(this.all().map((m) => m.adapter.close?.()));
  }
}
