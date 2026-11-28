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
import { sharedWallet, WalletUnavailable, type SharedWallet } from './wallet.js';
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
 * Every user's files live in one backing mount (BOX_MOUNT, e.g. Backblaze B2) under u/<id>/.
 */
export class BoxService {
  readonly plans: Record<PlanId, Plan>;
  private readonly scoped = new Map<string, Mount>();
  private readonly usageTimers = new Map<string, NodeJS.Timeout>();
  private readonly settling = new Map<string, Promise<void>>();
  /** The shared Bazzy TV wallet, when Bazzy TV sign-in is on. */
  readonly shared: SharedWallet | null;

  constructor(private readonly cfg: Config, private readonly db: Db, private readonly mounts: MountRegistry, private readonly now = () => Date.now(), shared?: SharedWallet | null) {
    this.plans = plans(cfg.BOX_FREE_GB);
    this.shared = shared === undefined ? sharedWallet(cfg) : shared;
  }

  private get base(): Mount {
    const m = this.mounts.get(this.cfg.BOX_MOUNT);
    if (!m) throw new BoxError(503, `BOX_MOUNT "${this.cfg.BOX_MOUNT}" is not defined in mounts.yaml`);
    return m;
  }

  /** Fail fast at boot if the backing mount is missing or of a kind we can't scope per user. */
  validate() {
    const m = this.base;
    if (!['s3', 'local'].includes(m.def.kind)) throw new Error(`BOX_MOUNT must be an s3 (Backblaze B2) or local mount, got ${m.def.kind}`);
    if (m.def.readOnly) throw new Error('BOX_MOUNT must be writable');
  }

  // ---------- accounts ----------

  async signup(emailRaw: string, password: string): Promise<Account> {
    // With Bazzy TV sign-in on, every new member gets one Bazzy TV account (films, Live, Box), not a Box-only login.
    if (this.cfg.BAZZYBOX && this.cfg.BAZZY_AUTH_URL && this.cfg.BAZZY_CLIENT_SECRET) {
      throw new BoxError(403, 'Create your account with Bazzy TV: one account for films, live concerts and BazzyBox.', 'use_bazzy');
    }
    return this.createAccount(emailRaw, password);
  }

  private async createAccount(emailRaw: string, password: string): Promise<Account> {
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

  /**
   * "Sign in with Bazzy TV". A known Bazzy user gets their linked account. Otherwise a Bazzy-verified
   * email joins the BazzyBox account with that email, or a new account is made (with an unusable
   * password: they sign in through Bazzy TV). An unverified email that matches an existing account
   * is refused, so nobody can claim someone else's files by registering their address on Bazzy TV.
   */
  async signInWithBazzy(u: { sub: string; email?: string; emailVerified?: boolean }): Promise<Account> {
    const links = this.db.t.accountLinks;
    const linkId = `bazzy:${u.sub}`;
    const [link] = await this.db.orm.select().from(links).where(eq(links.id, linkId));
    if (link) return this.get(link.accountId);

    if (!u.email) throw new BoxError(400, 'Bazzy TV did not share an email address');
    const email = u.email.trim().toLowerCase();
    const t = this.db.t.accounts;
    const [existing] = await this.db.orm.select().from(t).where(eq(t.email, email));
    let account: Account;
    if (existing) {
      if (!u.emailVerified) {
        throw new BoxError(409, 'A BazzyBox account already uses this email. Sign in with your password, or verify your email on Bazzy TV first.', 'email_taken');
      }
      account = existing as Account;
    } else {
      account = await this.createAccount(email, randomBytes(32).toString('base64url'));
    }
    await this.db.orm.insert(links).values({ id: linkId, provider: 'bazzy', subject: u.sub, accountId: account.id, createdAt: new Date(this.now()).toISOString() });
    log.info('box.bazzy_link', { account: account.id, created: !existing });
    // Any credits left in the old Box-only wallet move into the shared Bazzy TV wallet now.
    await this.settle(account.id, 'BazzyBox credits moved to your Bazzy wallet').catch((e) => log.warn('box.settle_failed', { account: account.id, error: (e as Error).message }));
    return this.get(account.id);
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

  /** Recount stored bytes by walking the user's folder (B2 charges nothing for these API calls). */
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
    const after = a.usedBytes + Math.max(0, incoming);
    if (after <= plan.includedBytes) return; // inside the plan: no need to ask the wallet
    if (after <= allowedBytes(plan, await this.walletMcOf(a))) return;
    if (plan.overageCreditsPerTbMonth === null)
      throw new BoxError(507, `This upload would pass your ${fmtBytes(plan.includedBytes)} free space. Upgrade to Lite for 1 TB, Flex for 3 TB or Studio for 15 TB.`, 'quota');
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
    if (deltaMc !== 0) await this.settle(id, note).catch((e) => log.warn('box.settle_failed', { account: id, error: (e as Error).message }));
    return true;
  }

  // ---------- the shared Bazzy wallet ----------
  //
  // For a member signed in with Bazzy TV, the balance is their Bazzy TV wallet: the same credits rent films
  // and buy Live tickets. accounts.wallet_mc then holds only what Box hasn't pushed yet: fractions of a
  // credit from daily storage metering, or a charge Bazzy TV refused for lack of credits (owed, negative).
  // Their balance is always Bazzy TV's balance + that remainder. Members without a Bazzy TV link keep the
  // old Box-only wallet until they sign in with Bazzy TV, which moves it across.

  private async bazzySub(id: string): Promise<string | null> {
    if (!this.shared) return null;
    const l = this.db.t.accountLinks;
    const [row] = await this.db.orm.select({ subject: l.subject }).from(l).where(and(eq(l.accountId, id), eq(l.provider, 'bazzy'))).limit(1);
    return row?.subject ?? null;
  }

  /** Spendable millicredits: the shared wallet plus anything not yet pushed to it. */
  async walletMcOf(a: Account): Promise<number> {
    const sub = await this.bazzySub(a.id);
    if (!sub) return a.walletMc;
    try {
      return (await this.shared!.balance(sub)) * 1000 + a.walletMc;
    } catch (e) {
      if (e instanceof WalletUnavailable) throw new BoxError(503, 'Your Bazzy wallet is unreachable right now. Try again in a minute.', 'wallet_down');
      throw e;
    }
  }

  /** Push whole credits from the local remainder to the shared wallet. One run per account at a time. */
  settle(id: string, note: string): Promise<void> {
    const prev = this.settling.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.settleNow(id, note));
    this.settling.set(id, run);
    void run.finally(() => this.settling.get(id) === run && this.settling.delete(id)).catch(() => {});
    return run;
  }

  private async settleNow(id: string, note: string) {
    const sub = await this.bazzySub(id);
    if (!sub) return;
    const st = this.db.t.settlements;
    // Finish anything a crash or timeout left open first, under its original ref.
    for (const p of await this.db.orm.select().from(st).where(and(eq(st.accountId, id), eq(st.state, 'pending')))) await this.push(sub, p);
    const a = await this.get(id);
    const whole = Math.trunc(a.walletMc / 1000);
    if (whole === 0) return;
    const row = { id: `box:${id}:${randomBytes(8).toString('hex')}`, accountId: id, mc: whole * 1000, note, state: 'pending', createdAt: new Date(this.now()).toISOString() };
    await this.db.orm.insert(st).values(row);
    await this.push(sub, row);
  }

  private async push(sub: string, row: { id: string; accountId: string; mc: number; note: string }) {
    const r = await this.shared!.entry(sub, row.mc / 1000, row.id, row.note);
    const st = this.db.t.settlements;
    const state = r.ok ? 'done' : 'refused';
    // Flip pending → done once; only the flip that wins moves the amount out of the remainder.
    const won = await this.db.orm.update(st).set({ state }).where(and(eq(st.id, row.id), eq(st.state, 'pending'))).returning({ id: st.id });
    if (won.length && r.ok) {
      const t = this.db.t.accounts;
      await this.db.orm.update(t).set({ walletMc: sql`${t.walletMc} - ${row.mc}` }).where(eq(t.id, row.accountId));
    }
    if (!r.ok) log.warn('box.settle_refused', { account: row.accountId, credits: row.mc / 1000, balance: r.credits });
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
      const bal = await this.walletMcOf(a);
      // Check before touching the ledger, so a failed switch leaves the old plan and wallet as they were.
      if (bal + refund < price) {
        throw new BoxError(402, `${target.label} costs ${target.priceCredits} credits; your wallet has ${Math.floor((bal + refund) / 1000)}${refund > 0 ? ' counting unused days' : ''}.`, 'wallet');
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
      if ((await this.walletMcOf(a)) >= p.priceCredits * 1000) {
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
    if (charge > 0 && (await this.walletMcOf(a)) < charge) throw new BoxError(402, "This link's owner has used up their sending allowance.", 'wallet');
    const t = this.db.t.accounts;
    await this.db.orm.update(t).set({ sendBytes: sql`${t.sendBytes} + ${bytes}` }).where(eq(t.id, id));
    if (charge > 0) await this.ledger(id, -charge, 'send', `Share-link download, ${fmtBytes(bytes)}`);
  }

  async summary(id: string) {
    const a = await this.get(id);
    const plan = this.plan(a);
    const bal = await this.walletMcOf(a);
    const shared = Boolean(await this.bazzySub(id));
    return {
      account: { id: a.id, email: a.email, createdAt: a.createdAt },
      plan: { id: plan.id, label: plan.label, priceCredits: plan.priceCredits, includedBytes: plan.includedBytes, periodEnd: a.periodEnd, overageCreditsPerTbMonth: plan.overageCreditsPerTbMonth },
      usage: { usedBytes: a.usedBytes, allowedBytes: allowedBytes(plan, bal), measuredAt: a.usageAt, sendBytes: a.sendBytes, sendFreeBytes: plan.sendFreeBytes },
      wallet: { credits: bal / 1000, shared, manageUrl: shared && (this.cfg.BAZZY_AUTH_URL ?? this.cfg.BAZZY_TV_URL) ? `${(this.cfg.BAZZY_AUTH_URL ?? this.cfg.BAZZY_TV_URL)!.replace(/\/$/, '')}/wallet` : null, dailyChargeCredits: dailyOverageMc(plan, a.usedBytes - plan.includedBytes) / 1000 },
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
