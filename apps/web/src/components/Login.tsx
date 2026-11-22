import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code || wait > 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(code);
      onSuccess();
    } catch (err) {
      const retry = (err instanceof ApiError && (err.body as { retryAfterSec?: number })?.retryAfterSec) || 0;
      setWait(retry);
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts.' : 'Wrong code.');
      setCode('');
      setTimeout(() => input.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h-full grid place-items-center px-4 bg-panel">
      <form onSubmit={submit} className="w-full max-w-xs flex flex-col gap-3" aria-describedby="login-error">
        <div className="flex items-center gap-2 mb-2 justify-center">
          <img src="/favicon.svg" alt="" className="w-7 h-7" />
          <span className="text-lg font-semibold tracking-tight">Stowage</span>
        </div>
        <label htmlFor="code" className="text-sm font-medium text-center">
          Enter access code.
        </label>
        <input
          id="code"
          ref={input}
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          className="input text-center text-lg tracking-[0.3em]"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={wait > 0}
          aria-invalid={Boolean(error)}
        />
        <button className="btn btn-primary justify-center py-2" disabled={!code || wait > 0 || busy}>
          {busy ? 'Checking…' : wait > 0 ? `Try again in ${wait}s` : 'Unlock'}
        </button>
        <p id="login-error" role="alert" className="text-sm text-center text-red-500 min-h-5">
          {error}
          {error && wait > 0 ? ` Wait ${wait}s.` : ''}
        </p>
      </form>
    </main>
  );
}
