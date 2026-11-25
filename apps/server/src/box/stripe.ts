import { createHmac, timingSafeEqual } from 'node:crypto';
import { PACKS, type PackId } from './pricing.js';

/** Creates a Stripe Checkout Session for a credit pack. No SDK: one form-encoded POST. */
export async function createCheckout(
  secretKey: string,
  opts: { pack: PackId; accountId: string; email: string; origin: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  const p = PACKS[opts.pack];
  const body = new URLSearchParams({
    mode: 'payment',
    success_url: `${opts.origin}/?credits=success`,
    cancel_url: `${opts.origin}/?credits=cancel`,
    client_reference_id: opts.accountId,
    customer_email: opts.email,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(p.usdCents),
    'line_items[0][price_data][product_data][name]': `BazzyBox credits (${p.credits.toLocaleString('en-US')})`,
    'metadata[account_id]': opts.accountId,
    'metadata[pack]': opts.pack,
  });
  const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !data.id || !data.url) throw new Error(`Stripe checkout failed: ${data.error?.message ?? res.status}`);
  return { id: data.id, url: data.url };
}

/**
 * Verify a Stripe-Signature header (t=…,v1=…) over the raw body.
 * Returns the parsed event, or null if the signature is wrong or older than `toleranceSec`.
 */
export function verifyWebhook<T = unknown>(rawBody: string, header: string | undefined, secret: string, nowSec = Date.now() / 1000, toleranceSec = 300): T | null {
  if (!header) return null;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((x) => x.length === 2 && x[0] !== 'v1'));
  const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !sigs.length) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const ok = sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) return null;
  try {
    return JSON.parse(rawBody) as T;
  } catch {
    return null;
  }
}

/** For tests and local tooling: produce a valid header for a body. */
export function signWebhook(rawBody: string, secret: string, tSec = Math.floor(Date.now() / 1000)) {
  return `t=${tSec},v1=${createHmac('sha256', secret).update(`${tSec}.${rawBody}`).digest('hex')}`;
}
