/**
 * BazzyBox pricing. Money is kept in millicredits (mc) as integers:
 * 1 credit = $0.01 = 1,000 mc. Integer math avoids float drift in the wallet.
 *
 * The numbers come from the BazzyBox revenue model (docs/BAZZYBOX.md):
 * Flex is $9.99/30 days for 3 TB, extra storage $9.50 per TB-month metered
 * daily, sends free up to a monthly allowance then 4 credits per GB.
 */

export const MC_PER_CREDIT = 1000;
export const DAY_MS = 86_400_000;
export const PERIOD_DAYS = 30;
export const TB = 1e12;
export const GB = 1e9;

export type PlanId = 'free' | 'flex';

export interface Plan {
  id: PlanId;
  label: string;
  /** Price per 30-day period, in credits. */
  priceCredits: number;
  includedBytes: number;
  /** Extra storage price per TB-month in credits; null = hard cap at includedBytes. */
  overageCreditsPerTbMonth: number | null;
  /** Free share-link (send) bytes per 30 days. */
  sendFreeBytes: number;
}

export function plans(freeGb = 10): Record<PlanId, Plan> {
  return {
    free: { id: 'free', label: 'Free', priceCredits: 0, includedBytes: freeGb * GB, overageCreditsPerTbMonth: null, sendFreeBytes: 2 * GB },
    flex: { id: 'flex', label: 'BazzyBox Flex', priceCredits: 999, includedBytes: 3 * TB, overageCreditsPerTbMonth: 950, sendFreeBytes: 50 * GB },
  };
}

/** Sends past the free allowance: credits per GB. MASV charges $0.25/GB; this is $0.04. */
export const SEND_CREDITS_PER_GB = 4;

/** Credit packs sold through Stripe Checkout. Bigger packs carry a bonus. */
export const PACKS = {
  p10: { usdCents: 1000, credits: 1000 },
  p25: { usdCents: 2500, credits: 2600 },
  p50: { usdCents: 5000, credits: 5300 },
  p100: { usdCents: 10000, credits: 11000 },
} as const;
export type PackId = keyof typeof PACKS;

/** Uploads are allowed past the included space only while the wallet covers this many days of the extra. */
export const OVERAGE_RUNWAY_DAYS = 7;

/** Millicredits charged for one day of `overBytes` past the plan's included space. */
export function dailyOverageMc(plan: Plan, overBytes: number): number {
  if (overBytes <= 0 || plan.overageCreditsPerTbMonth === null) return 0;
  return Math.ceil((overBytes / TB) * plan.overageCreditsPerTbMonth * MC_PER_CREDIT / PERIOD_DAYS);
}

/** Largest total stored size an upload may reach, given the plan and wallet. */
export function allowedBytes(plan: Plan, walletMc: number): number {
  if (plan.overageCreditsPerTbMonth === null || walletMc <= 0) return plan.includedBytes;
  const mcPerTbDay = (plan.overageCreditsPerTbMonth * MC_PER_CREDIT) / PERIOD_DAYS;
  const extraTb = walletMc / (mcPerTbDay * OVERAGE_RUNWAY_DAYS);
  return plan.includedBytes + Math.floor(extraTb * TB);
}

/** Unused part of a paid period, returned to the wallet on downgrade or cancel. */
export function proratedRefundMc(plan: Plan, periodStart: number, periodEnd: number, now: number): number {
  if (plan.priceCredits <= 0 || now >= periodEnd) return 0;
  const total = periodEnd - periodStart;
  if (total <= 0) return 0;
  const left = Math.min(total, periodEnd - Math.max(now, periodStart));
  return Math.floor((plan.priceCredits * MC_PER_CREDIT * left) / total);
}

/** Millicredits for `bytes` of sends, given bytes already sent this period. */
export function sendChargeMc(plan: Plan, sentBefore: number, bytes: number): number {
  const freeLeft = Math.max(0, plan.sendFreeBytes - sentBefore);
  const billable = Math.max(0, bytes - freeLeft);
  return Math.ceil((billable / GB) * SEND_CREDITS_PER_GB * MC_PER_CREDIT);
}

export const credits = (mc: number) => mc / MC_PER_CREDIT;
