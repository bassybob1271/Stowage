import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

export function Login({ onSuccess, provider, bazzy = false }: { onSuccess: () => void; provider?: 'box' | 'code'; bazzy?: boolean }) {
  const [ownerGate, setOwnerGate] = useState(false);
  if (provider === 'box' && !ownerGate) return <BoxLogin onSuccess={onSuccess} onOwner={() => setOwnerGate(true)} bazzy={bazzy} />;
  return <CodeLogin onSuccess={onSuccess} />;
}

function CodeLogin({ onSuccess }: { onSuccess: () => void }) {
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
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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

/** BazzyBox: email + password, with sign-up. The owner can still use the access code. */
function BoxLogin({ onSuccess, onOwner, bazzy }: { onSuccess: () => void; onOwner: () => void; bazzy: boolean }) {
  // The public site links to /signup and /login; land on the matching tab.
  const [mode, setMode] = useState<'in' | 'up'>(() => (!bazzy && window.location.pathname === '/signup' ? 'up' : 'in'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // A failed "Sign in with Bazzy TV" comes back as /login?error=…
  const [error, setError] = useState<string | null>(() => new URLSearchParams(window.location.search).get('error'));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await (mode === 'in' ? api.boxLogin(email, password) : api.boxSignup(email, password));
      if (window.location.pathname === '/signup' || window.location.pathname === '/login') window.history.replaceState(null, '', '/');
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="h-full grid place-items-center px-4 bg-panel">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-3" aria-describedby="box-error">
        <div className="flex items-center gap-2 mb-1 justify-center">
          <img src="/favicon.svg" alt="" className="w-7 h-7" />
          <span className="text-lg font-semibold tracking-tight">BazzyBox</span>
        </div>
        <p className="text-sm text-muted text-center mb-2">
          Storage for filmmakers and musicians. 1 TB for $4.99, downgrade any day.
        </p>
        {bazzy && (
          <>
            <a href="/api/auth/bazzy/start" className="btn btn-primary justify-center py-2.5">
              Sign in with Bazzy TV
            </a>
            <a href="/api/auth/bazzy/start?signup=1" className="btn justify-center py-2.5">
              Create a Bazzy TV account
            </a>
            <p className="text-xs text-muted text-center -mt-1">One account for films, live concerts and BazzyBox. Apple and Google work too.</p>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-line" />or sign in with a BazzyBox password<span className="h-px flex-1 bg-line" />
            </div>
          </>
        )}
        {!bazzy && <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-app border border-line" role="tablist">
          {(['in', 'up'] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`btn justify-center ${mode === m ? 'btn-primary' : ''}`} onClick={() => setMode(m)}>
              {m === 'in' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>}
        <label className="flex flex-col gap-1 text-sm">
          <span>Email</span>
          <input id="box-email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span>Password{mode === 'up' ? ' (10+ characters)' : ''}</span>
          <input
            id="box-password"
            className="input"
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            minLength={mode === 'up' ? 10 : undefined}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="btn btn-primary justify-center py-2" disabled={busy || !email || !password}>
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create free account'}
        </button>
        <p id="box-error" role="alert" className="text-sm text-center text-red-500 min-h-5">{error}</p>
        <button type="button" className="text-xs text-muted underline self-center" onClick={onOwner}>Owner access code</button>
      </form>
    </main>
  );
}
