import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { MountInfo } from '@stowage/shared';
import { createMount, type EmulatedAdapter } from '@stowage/storage';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Mount, MountRegistry } from '../mounts.js';
import { log } from '../log.js';
import {
  DAY_MS,
  PERIOD_DAYS,
  PACKS,
  allowedBytes,
  dailyOverageMc,
  plans,
  proratedRefundMc,
  sendChargeMc,
  type PackId,
  type Plan,
  type PlanId,
} from './pricing.js';

const ARGON2ID = 2;
const PERIOD_MS = PERIOD_DAYS * DAY_MS;

export class BoxError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type Account = typeof import('../db/schema.js').sqliteAccounts.$inferSelect;

/** Session subjects: the code gate issues "owner"; BazzyBox accounts are "u:<id>". */
export const userSub = (id: string) => `u:${id}`;
export const accountIdOf = (sub: string | undefined) => (sub?.startsWith('u:') ? sub.slice(2) : null);
export const userMountId = (id: string) => `box-${id}`;
export const accountIdOfMount = (mountId: string) => (/^box-[0-9a-f]{16}$/.test(mountId) ? mountId.slice(4) : null);

/**
 * Accounts, per-user storage, the credits wallet and the storage meter.
 * Every user's files live in one backing mount (BOX_MOUNT, e.g. IDrive e2) under u/<id>/.
 */
export class BoxService {
  readonly plans: Record<PlanId, Plan>;
  private readonly scoped = new Map<string, Mount>();
  private readonly usageTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly cfg: Config, private readonly db: Db, private readonly mounts: MountRegistry, private readonly now = () => Date.now()) {
    this.plans = plans(cfg.BOX_FREE_GB);
  }

  private get base(): Mount {
    const m = this.mounts.get(this.cfg.BOX_MOUNT);
    if (!m) throw new BoxError(503, `BOX_MOUNT "${this.cfg.BOX_MOUNT}" is not defined in mounts.yaml`);
    return m;
  }

  /** Fail fast at boot if the backing mount is missing or of a kind we can't scope per user. */
  validate() {
    const m = this.base;
    if (!['s3', 'local'].includes(m.def.kind)) throw new Error(`BOX_MOUNT must be an s3 (IDrive e2) or local mount, got ${m.def.kind}`);
    if (m.def.readOnly) throw new Error('BOX_MOUNT must be writable');
  }

  // ---------- accounts ----------

  async signup(emailRaw: string, password: string): Promise<Account> {
    if (this.cfg.BOX_SIGNUP === 'closed') throw new BoxError(403, 'sign-ups are closed');
    const email = emailRaw.trim().toLowerCase();
    const t = this.db.t.accounts;
    if ((await this.db.orm.select({ id: t.id }).from(t).where(eq(t.email, email))).length) throw new BoxError(409, 'an account with this email exists');
    const row = {
      id: randomBytes(8).toString('hex'),
      email,
      passwordHash: await hash(password, { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      plan: 'free',
      walletMc: 0,
      periodStart: null,
      periodEnd: null,
      usedBytes: 0,
      usageAt: this.now(),
      meteredAt: this.now(),
      sendBytes: 0,
      sendPeriodStart: this.now(),
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.db.orm.insert(t).values(row);
    log.info('box.signup', { account: row.id });
    return row as Account;
  }

  /** Constant-time-ish: always runs one argon2 verify so unknown emails cost the same. */
  async login(emailRaw: string, password: string): Promise<Account | null> {
    const t = this.db.t.accounts;
    const [a] = await this.db.orm.select().from(t).where(eq(t.email, emailRaw.trim().toLowerCase()));
    const ok = await verify(a?.passwordHash ?? DUMMY_HASH, password).catch(() => false);
    return a && ok ? a : null;
  }

  async get(id: string): Promise<Account> {
    const t = this.db.t.accounts;
    const [a] = await this.db.orm.select().from(t).where(eq(t.id, id));
    if (!a) throw new BoxError(401, 'account not found');
    return a;
  }

  plan(a: Account): Plan {
    return this.plans[(a.plan as PlanId) in this.plans ? (a.plan as PlanId) : 'free'];
  }

  // ---------- per-user storage ----------

  /** The user's private view of BOX_MOUNT, rooted at u/<id>/. */
  mountFor(id: string): Mount {
    const hit = this.scoped.get(id);
    if (hit) return hit;
    const b = this.base;
    const cfg = { ...b.def.config } as Record<string, unknown>;
    if (b.def.kind === 'local') {
      cfg.root = join(String(cfg.root), 'u', id);
      mkdirSync(cfg.root as string, { recursive: true });
    } else {
      cfg.prefix = [String(cfg.prefix ?? '').replace(/^\/+|\/+$/g, ''), 'u', id].filter(Boolean).join('/');
      cfg.createBucket = false;
    }
    const def = { ...b.def, id: userMountId(id), label: 'BazzyBox', config: cfg };
    const m: Mount = { def, adapter: createMount(def) as EmulatedAdapter, source: 'yaml', health: b.health };
    this.scoped.set(id, m);
    return m;
  }

  mountInfo(id: string): MountInfo {
    const m = this.mountFor(id);
    const info = this.mounts.info(m);
    return { ...info, health: { ok: this.base.health.ok, detail: this.base.health.detail } };
  }

  /** Recount stored bytes by walking the user's folder (e2 charges nothing for API calls). */
  async refreshUsage(id: string): Promise<number> {
    let total = 0;
    for await (const e of this.mountFor(id).adapter.walk('')) if (!e.isDir) total += e.size;
    const t = this.db.t.accounts;
    await this.db.orm.update(t).set({ usedBytes: total, usageAt: this.now() }).where(eq(t.id, id));
    return total;
  }

  /** Recount shortly after writes/deletes, coalescing bursts (folder uploads). */
  scheduleUsage(id: string, delayMs = 1500) {
    clearTimeout(this.usageTimers.get(id));
    this.usageTimers.set(
      id,
      setTimeout(() => {
        this.usageTimers.delete(id);
        this.refreshUsage(id).catch((e) => log.warn('box.usage_failed', { account: id, error: (e as Error).message }));
      }, delayMs).unref(),
    );
  }

  /** Throw unless the account may store `incoming` more bytes. */
  async checkUpload(id: string, incoming: number) {
    const a = await this.get(id);
    const plan = this.plan(a);
    const limit = allowedBytes(plan, a.walletMc);
    if (a.usedBytes + Math.max(0, incoming) <= limit) return;
    if (plan.overageCreditsPerTbMonth === null)
      throw new BoxError(507, `This upload would pass your ${fmtBytes(plan.includedBytes)} free space. Upgrade to Flex for 3 TB or Studio for 15 TB.`, 'quota');
    throw new BoxError(402, `Add credits to store past ${fmtBytes(plan.includedBytes)}: your wallet must cover a week of the extra space.`, 'wallet');
  }

  // ---------- wallet ----------

  /** Add (or with negative delta, remove) millicredits and record it. `ref` makes the entry idempotent. */
  async ledger(id: string, deltaMc: number, kind: string, note: string, ref?: string): Promise<boolean> {
    const l = this.db.t.ledger;
    try {
      await this.db.orm.insert(l).values({
        id: randomBytes(10).toString('hex'),
        accountId: id,
        deltaMc,
        kind,
        note,
        ref: ref ?? null,
        createdAt: new Date(this.now()).toISOString(),
      });
    } catch (e) {
      if (ref && /unique|duplicate/i.test((e as Error).message)) return false; // already applied
      throw e;
    }
    const t = this.db.t.accounts;
    await this.db.orm.update(t).set({ walletMc: sql`${t.walletMc} + ${deltaMc}` }).where(eq(t.id, id));
    return true;
  }

  async history(id: string, limit = 50) {
    const l = this.db.t.ledger;
    return this.db.orm.select().from(l).where(eq(l.accountId, id)).orderBy(desc(l.createdAt)).limit(limit);
  }

  grantPack(id: string, pack: PackId, ref: string) {
    const p = PACKS[pack];
    return this.ledger(id, p.credits * 1000, 'topup', `Bought ${p.credits.toLocaleString('en-US')} credits ($${(p.usdCents / 100).toFixed(2)})`, ref);
  }

  // ---------- plans ----------

  /** Switch plans immediately. Upgrades are paid from the wallet; downgrades refund unused days to it. */
  async changePlan(id: string, to: PlanId) {
    const a = await this.get(id);
    if (a.plan === to) return a;
    const now = this.now();
    const t = this.db.t.accounts;
    const target = this.plans[to];
    const current = this.plan(a);
    // Unused days of the current paid plan always go back to the wallet, whichever way the switch goes.
    const refund = a.plan === 'free' ? 0 : proratedRefundMc(current, a.periodStart ?? now, a.periodEnd ?? now, now);
    const refundNote = () => `Unused ${current.label} days returned (${fmtDays(a.periodEnd! - now)})`;
    if (to === 'free') {
      if (refund > 0) await this.ledger(id, refund, 'refund', refundNote());
      await this.db.orm.update(t).set({ plan: 'free', periodStart: null, periodEnd: null }).where(eq(t.id, id));
      log.info('box.downgrade', { account: id, refundMc: refund });
    } else {
      const price = target.priceCredits * 1000;
      // Check before touching the ledger, so a failed switch leaves the old plan and wallet as they were.
      if (a.walletMc + refund < price) {
        throw new BoxError(402, `${target.label} costs ${target.priceCredits} credits; your wallet has ${Math.floor((a.walletMc + refund) / 1000)}${refund > 0 ? ' counting unused days' : ''}.`, 'wallet');
      }
      if (refund > 0) await this.ledger(id, refund, 'refund', refundNote());
      await this.ledger(id, -price, 'plan', `${target.label}, 30 days`);
      await this.db.orm.update(t).set({ plan: to, periodStart: now, periodEnd: now + PERIOD_MS, meteredAt: now }).where(eq(t.id, id));
      log.info('box.upgrade', { account: id, plan: to });
    }
    return this.get(id);
  }

  // ---------- metering ----------

  /**
   * Daily storage meter and renewals. Charges each full day past the included space,
   * renews paid plans from the wallet, and drops to Free (never deleting files) if the wallet can't pay.
   */
  async meter(id: string) {
    const now = this.now();
    let a = await this.get(id);
    const t = this.db.t.accounts;
    // Renew (possibly several missed periods if the meter was down).
    while (a.plan !== 'free' && a.periodEnd && a.periodEnd <= now) {
      const p = this.plan(a);
      if (a.walletMc >= p.priceCredits * 1000) {
        await this.ledger(id, -p.priceCredits * 1000, 'plan', `${p.label} renewal, 30 days`);
        await this.db.orm.update(t).set({ periodStart: a.periodEnd, periodEnd: a.periodEnd + PERIOD_MS }).where(eq(t.id, id));
      } else {
        await this.ledger(id, 0, 'plan', `Wallet too low to renew ${p.label}; moved to Free. Your files are untouched.`);
        await this.db.orm.update(t).set({ plan: 'free', periodStart: null, periodEnd: null }).where(eq(t.id, id));
      }
      a = await this.get(id);
    }
    const since = a.meteredAt ?? now;
    const days = Math.floor((now - since) / DAY_MS);
    if (days >= 1) {
      const used = await this.refreshUsage(id);
      const plan = this.plan(a);
      const charge = dailyOverageMc(plan, used - plan.includedBytes) * days;
      if (charge > 0) await this.ledger(id, -charge, 'storage', `${fmtBytes(used - plan.includedBytes)} extra storage × ${days} day${days > 1 ? 's' : ''}`);
      await this.db.orm.update(t).set({ meteredAt: since + days * DAY_MS }).where(eq(t.id, id));
    }
    // Reset the monthly send allowance.
    if (!a.sendPeriodStart || now - a.sendPeriodStart >= PERIOD_MS) await this.db.orm.update(t).set({ sendBytes: 0, sendPeriodStart: now }).where(eq(t.id, id));
  }

  async meterAll() {
    const t = this.db.t.accounts;
    for (const { id } of await this.db.orm.select({ id: t.id }).from(t)) {
      try {
        await this.meter(id);
      } catch (e) {
        log.warn('box.meter_failed', { account: id, error: (e as Error).message });
      }
    }
  }

  /** Account for a share-link download of `bytes`; throws 402 if the owner's allowance and wallet are used up. */
  async chargeSend(id: string, bytes: number) {
    const a = await this.get(id);
    const charge = sendChargeMc(this.plan(a), a.sendBytes, bytes);
    if (charge > 0 && a.walletMc < charge) throw new BoxError(402, "This link's owner has used up their sending allowance.", 'wallet');
    const t = this.db.t.accounts;
    await this.db.orm.update(t).set({ sendBytes: sql`${t.sendBytes} + ${bytes}` }).where(eq(t.id, id));
    if (charge > 0) await this.ledger(id, -charge, 'send', `Share-link download, ${fmtBytes(bytes)}`);
  }

  async summary(id: string) {
    const a = await this.get(id);
    const plan = this.plan(a);
    return {
      account: { id: a.id, email: a.email, createdAt: a.createdAt },
      plan: { id: plan.id, label: plan.label, priceCredits: plan.priceCredits, includedBytes: plan.includedBytes, periodEnd: a.periodEnd, overageCreditsPerTbMonth: plan.overageCreditsPerTbMonth },
      usage: { usedBytes: a.usedBytes, allowedBytes: allowedBytes(plan, a.walletMc), measuredAt: a.usageAt, sendBytes: a.sendBytes, sendFreeBytes: plan.sendFreeBytes },
      wallet: { credits: a.walletMc / 1000, dailyChargeCredits: dailyOverageMc(plan, a.usedBytes - plan.includedBytes) / 1000 },
      plans: Object.values(this.plans),
      packs: PACKS,
      payments: this.cfg.STRIPE_SECRET_KEY ? 'stripe' : this.cfg.BOX_DEV_CREDITS ? 'dev' : 'none',
      history: (await this.history(id, 30)).map((h) => ({ at: h.createdAt, credits: h.deltaMc / 1000, kind: h.kind, note: h.note })),
    };
  }

  async accountByMount(mountId: string) {
    const id = accountIdOfMount(mountId);
    if (!id) return null;
    const t = this.db.t.accounts;
    const [a] = await this.db.orm.select({ id: t.id }).from(t).where(and(eq(t.id, id)));
    return a ? id : null;
  }
}

// A real argon2id hash of a random string, so logins for unknown emails take the same time.
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$J6fBpYAXEL8VVb2rS0xUQwmtxMfc4xfs1wwbOqZzT9g';

export function fmtBytes(n: number) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(0, n)} bytes`;
}
const fmtDays = (ms: number) => `${Math.max(0, Math.round(ms / DAY_MS))} days`;
