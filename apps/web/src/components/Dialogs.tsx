import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from '../lib/store';

type Req =
  | { kind: 'prompt'; title: string; label?: string; value: string; confirm: string; selectStem?: boolean; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; confirm: string; danger?: boolean; resolve: (v: boolean) => void };

const dialogStore = createStore<Req | null>(null);
const toastStore = createStore<{ id: number; text: string; tone: 'info' | 'error' }[]>([]);

export function promptDialog(o: { title: string; label?: string; value?: string; confirm?: string; selectStem?: boolean }) {
  return new Promise<string | null>((resolve) =>
    dialogStore.set({ kind: 'prompt', value: '', confirm: 'OK', ...o, resolve }),
  );
}

export function confirmDialog(o: { title: string; message: string; confirm?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => dialogStore.set({ kind: 'confirm', confirm: 'OK', ...o, resolve }));
}

let toastId = 0;
export function toast(text: string, tone: 'info' | 'error' = 'info') {
  const id = ++toastId;
  toastStore.set((l) => [...l, { id, text, tone }]);
  setTimeout(() => toastStore.set((l) => l.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3000);
}

export function DialogHost() {
  const req = useStore(dialogStore);
  const toasts = useStore(toastStore);
  const [value, setValue] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (req?.kind === 'prompt') {
      setValue(req.value);
      setTimeout(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        const dot = req.value.lastIndexOf('.');
        if (req.selectStem && dot > 0) el.setSelectionRange(0, dot);
        else el.select();
      });
    }
  }, [req]);

  const close = (v: unknown) => {
    if (!req) return;
    (req.resolve as (x: unknown) => void)(v);
    dialogStore.set(null);
  };

  return (
    <>
      {req && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4" onMouseDown={(e) => e.target === e.currentTarget && close(req.kind === 'prompt' ? null : false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlg-title"
            className="w-full max-w-sm rounded-xl bg-panel border border-line p-4 shadow-2xl flex flex-col gap-3"
            onKeyDown={(e) => e.key === 'Escape' && close(req.kind === 'prompt' ? null : false)}
            onSubmit={(e) => {
              e.preventDefault();
              close(req.kind === 'prompt' ? value.trim() || null : true);
            }}
          >
            <h2 id="dlg-title" className="font-semibold">{req.title}</h2>
            {req.kind === 'prompt' ? (
              <label className="flex flex-col gap-1 text-sm">
                {req.label && <span className="text-muted">{req.label}</span>}
                <input ref={input} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
            ) : (
              <p className="text-sm text-muted whitespace-pre-wrap">{req.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => close(req.kind === 'prompt' ? null : false)}>
                Cancel
              </button>
              <button
                autoFocus={req.kind === 'confirm'}
                className={`btn ${req.kind === 'confirm' && req.danger ? 'bg-red-600 text-white hover:bg-red-700' : 'btn-primary'}`}
              >
                {req.confirm}
              </button>
            </div>
          </form>
        </div>
      )}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 items-center pointer-events-none" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-lg px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
