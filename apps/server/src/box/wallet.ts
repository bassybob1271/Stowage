/**
 * The shared Bazzy wallet. A member's credits live on Bazzy TV, like an Apple account: the same balance
 * rents films, buys Bazzy Live tickets and pays for BazzyBox. Box never holds a balance of its own for
 * a linked member; it charges and credits Bazzy TV, server to server, in whole credits.
 *
 * See apps/video/backend/app/api/routes/app_wallet.py in bazzy-tv for the other side.
 */
import type { Config } from '../config.js';
import { bazzyHttp } from './http.js';

export type EntryResult = { ok: true; credits: number } | { ok: false; reason: 'insufficient'; credits: number };

export interface SharedWallet {
  /** Whole credits on the member's Bazzy TV wallet. */
  balance(sub: string): Promise<number>;
  /** credits < 0 charges, > 0 credits. Same ref twice is applied once. */
  entry(sub: string, credits: number, ref: string, note: string): Promise<EntryResult>;
}

export class WalletUnavailable extends Error {}

export function sharedWallet(cfg: Config): SharedWallet | null {
  if (!(cfg.BAZZYBOX && cfg.BAZZY_AUTH_URL && cfg.BAZZY_CLIENT_SECRET)) return null;
  const base = `${cfg.BAZZY_AUTH_URL.replace(/\/$/, '')}/api/v1/apps/wallet`;
  const authorization = `Basic ${Buffer.from(`${cfg.BAZZY_CLIENT_ID}:${cfg.BAZZY_CLIENT_SECRET}`).toString('base64')}`;
  const call = async (path: string, init?: RequestInit) => {
    let r: Response;
    try {
      r = await bazzyHttp.fetch(`${base}/${path}`, { ...init, headers: { authorization, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new WalletUnavailable(`Bazzy TV wallet unreachable: ${(e as Error).message}`);
    }
    return r;
  };
  return {
    async balance(sub) {
      const r = await call(encodeURIComponent(sub));
      if (!r.ok) throw new WalletUnavailable(`Bazzy TV wallet answered ${r.status}`);
      return ((await r.json()) as { credits: number }).credits;
    },
    async entry(sub, credits, ref, note) {
      const r = await call(`${encodeURIComponent(sub)}/entries`, { method: 'POST', body: JSON.stringify({ credits, ref, note: note.slice(0, 300) }) });
      if (r.status === 402) {
        const body = (await r.json().catch(() => ({}))) as { detail?: { credits?: number } };
        return { ok: false, reason: 'insufficient', credits: body.detail?.credits ?? 0 };
      }
      if (!r.ok) throw new WalletUnavailable(`Bazzy TV wallet answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { ok: true, credits: ((await r.json()) as { credits: number }).credits };
    },
  };
}
