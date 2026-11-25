import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, RefreshCw, Trash2, X } from 'lucide-react';
import { api, type BoxSummary } from '../api';
import { confirmDialog, toast } from './Dialogs';

const fmtBytes = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`;
const fmtCredits = (c: number) => Math.floor(c).toLocaleString('en-US');
const usd = (credits: number) => `$${(credits / 100).toFixed(2)}`;
const fmtDate = (ms: number | string) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** BazzyBox: storage meter, plan switch, credits wallet, share links. */
export function Billing({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['box-me'], queryFn: api.box.me });
  const shares = useQuery({ queryKey: ['box-shares'], queryFn: api.box.shares });
  const set = (s: BoxSummary) => qc.setQueryData(['box-me'], s);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('credits');
    if (q === 'success') toast('Payment received. Credits appear as soon as Stripe confirms.');
    if (q === 'cancel') toast('Checkout cancelled. No charge was made.');
  }, []);

  const plan = useMutation({
    mutationFn: api.box.setPlan,
    onSuccess: (s) => {
      set(s);
      toast(s.plan.id === 'flex' ? 'You are on Flex: 3 TB.' : 'Moved to Free. Unused days went back to your wallet.');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const buy = useMutation({
    mutationFn: api.box.buy,
    onSuccess: (r) => {
      if ('checkoutUrl' in r) location.assign(r.checkoutUrl);
      else {
        set(r);
        toast('Credits added.');
      }
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const refresh = useMutation({ mutationFn: api.box.refreshUsage, onSuccess: set });

  async function downgrade() {
    const ok = await confirmDialog({
      title: 'Switch to Free?',
      message: 'Unused Flex days go back to your wallet as credits right now. Files over the free space stay safe; uploads pause until you are under it or switch back.',
      confirm: 'Switch to Free',
    });
    if (ok) plan.mutate('free');
  }

  const s = me.data;
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Plan and credits" className="w-full max-w-2xl max-h-full overflow-y-auto rounded-xl bg-panel border border-line shadow-2xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="flex items-center px-4 py-3 border-b border-line">
          <h2 className="font-semibold flex-1">Plan &amp; credits</h2>
          <button className="btn btn-icon" aria-label="Recount storage" title="Recount storage" onClick={() => refresh.mutate()}>
            <RefreshCw size={16} className={refresh.isPending ? 'animate-spin' : ''} />
          </button>
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        {me.isPending && <div className="p-6 text-sm text-muted">Loading…</div>}
        {me.isError && <div className="p-6 text-sm text-red-500">{(me.error as Error).message}</div>}
        {s && (
          <div className="p-4 flex flex-col gap-6 text-sm">
            <Meter s={s} />

            <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {s.plans.map((p) => {
                const current = s.plan.id === p.id;
                return (
                  <div key={p.id} className={`rounded-lg border p-3 flex flex-col gap-1 ${current ? 'border-[var(--color-accent)] bg-accent-soft' : 'border-line'}`}>
                    <div className="flex items-baseline gap-2">
                      <h3 className="font-semibold">{p.label}</h3>
                      <span className="ml-auto font-semibold tabular-nums">{p.priceCredits ? `${usd(p.priceCredits)}/mo` : 'Free'}</span>
                    </div>
                    <p className="text-muted">
                      {fmtBytes(p.includedBytes)} included
                      {p.overageCreditsPerTbMonth ? `, then ${usd(p.overageCreditsPerTbMonth)} per extra TB-month, billed daily` : ''}. {fmtBytes(p.sendFreeBytes)} of share-link downloads a month.
                    </p>
                    {current ? (
                      <p className="text-xs mt-1">
                        Current plan{s.plan.periodEnd ? `, renews from your wallet on ${fmtDate(s.plan.periodEnd)}` : ''}.
                      </p>
                    ) : (
                      <button
                        className={`btn mt-2 justify-center ${p.id === 'flex' ? 'btn-primary' : ''}`}
                        disabled={plan.isPending}
                        onClick={() => (p.id === 'free' ? void downgrade() : plan.mutate('flex'))}
                      >
                        {p.id === 'flex' ? `Upgrade for ${fmtCredits(p.priceCredits)} credits` : 'Switch to Free'}
                      </button>
                    )}
                  </div>
                );
              })}
            </section>

            <section className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <h3 className="font-semibold">Wallet</h3>
                <span className="ml-auto text-lg font-semibold tabular-nums">{fmtCredits(s.wallet.credits)} credits</span>
                <span className="text-muted tabular-nums">({usd(s.wallet.credits)})</span>
              </div>
              <p className="text-muted">1 credit = $0.01. Credits never expire. Plan fees, extra storage and share-link downloads past your allowance come out of here.</p>
              {s.payments === 'none' ? (
                <p className="text-amber-500">Payments aren't set up on this server yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {Object.entries(s.packs).map(([id, p]) => (
                    <button key={id} className="btn flex-col items-start py-2 h-auto" disabled={buy.isPending} onClick={() => buy.mutate(id)}>
                      <span className="font-semibold tabular-nums">${(p.usdCents / 100).toFixed(0)}</span>
                      <span className="text-xs text-muted tabular-nums">
                        {fmtCredits(p.credits)} credits{p.credits > p.usdCents ? ` (+${Math.round((p.credits / p.usdCents - 1) * 100)}%)` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {s.payments === 'dev' && <p className="text-xs text-muted">Test mode: credits are granted without payment.</p>}
            </section>

            <section>
              <h3 className="font-semibold mb-1">Share links</h3>
              {!shares.data?.shares.length && <p className="text-muted">Right-click a file and choose “Create share link” to send it to anyone, no account needed.</p>}
              <ul className="flex flex-col">
                {shares.data?.shares.map((l) => (
                  <li key={l.token} className="flex items-center gap-2 py-1 border-b border-line/60">
                    <span className="truncate flex-1">{l.path}</span>
                    <span className="text-xs text-muted tabular-nums whitespace-nowrap">{l.downloads} downloads{l.expiresAt ? ` · until ${fmtDate(l.expiresAt)}` : ''}</span>
                    <button className="btn btn-icon" aria-label={`Copy link to ${l.path}`} onClick={() => void navigator.clipboard.writeText(location.origin + l.url).then(() => toast('Link copied'), () => toast(location.origin + l.url))}>
                      <Copy size={14} />
                    </button>
                    <button
                      className="btn btn-icon text-red-500"
                      aria-label={`Delete link to ${l.path}`}
                      onClick={() => void api.box.unshare(l.token).then(() => qc.invalidateQueries({ queryKey: ['box-shares'] }))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="font-semibold mb-1">Activity</h3>
              {!s.history.length && <p className="text-muted">No charges yet.</p>}
              <ul className="flex flex-col">
                {s.history.map((h, i) => (
                  <li key={i} className="flex items-baseline gap-2 py-1 border-b border-line/60">
                    <span className="text-xs text-muted w-24 shrink-0 tabular-nums">{fmtDate(h.at)}</span>
                    <span className="flex-1">{h.note}</span>
                    <span className={`tabular-nums whitespace-nowrap ${h.credits > 0 ? 'text-emerald-500' : ''}`}>
                      {h.credits > 0 ? '+' : ''}
                      {h.credits.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="text-xs text-muted">
              No lock-in: switch plans any day, and unused days come back as credits instantly. Exports are always free. If your wallet runs out, uploads pause; nothing is deleted. Close your account and unused purchased credits are refunded.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Meter({ s }: { s: BoxSummary }) {
  const used = s.usage.usedBytes;
  const included = s.plan.includedBytes;
  const max = Math.max(s.usage.allowedBytes, used, included);
  const pct = (n: number) => `${Math.min(100, (n / max) * 100)}%`;
  const over = used > included;
  return (
    <section className="flex flex-col gap-2" aria-label="Storage used">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{fmtBytes(used)}</span>
        <span className="text-muted">of {fmtBytes(included)} included</span>
        {s.wallet.dailyChargeCredits > 0 && <span className="ml-auto text-xs tabular-nums">{s.wallet.dailyChargeCredits.toFixed(1)} credits/day for the extra</span>}
      </div>
      <div className="relative h-3 rounded-full bg-[var(--hover)] overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-[var(--color-accent)]" style={{ width: pct(Math.min(used, included)) }} />
        {over && <div className="absolute inset-y-0 bg-amber-500" style={{ left: pct(included), width: `calc(${pct(used)} - ${pct(included)})` }} />}
        <div className="absolute inset-y-0 w-px bg-[var(--fg)] opacity-40" style={{ left: pct(included) }} />
      </div>
      <p className="text-xs text-muted">
        You can store up to {fmtBytes(s.usage.allowedBytes)} right now
        {s.plan.overageCreditsPerTbMonth ? ' (your wallet covers a week of anything past the included space)' : ''}. Share-link downloads this month: {fmtBytes(s.usage.sendBytes)} of {fmtBytes(s.usage.sendFreeBytes)} free.
      </p>
    </section>
  );
}
