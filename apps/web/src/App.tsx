import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authEvents } from './api';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { restoreUploads } from './uploads';

export function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, staleTime: Infinity });
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['session'], (s: object | undefined) => ({ ...s, authenticated: false }));
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, [qc]);

  const authed = session.data?.authenticated === true;
  useEffect(() => {
    if (authed && !restored) {
      setRestored(true);
      void restoreUploads();
    }
  }, [authed, restored]);

  if (session.isPending) return <div className="h-full grid place-items-center text-muted text-sm">Loading…</div>;
  if (!authed) return <Login provider={session.data?.provider} onSuccess={() => void qc.invalidateQueries({ queryKey: ['session'] })} />;
  return <Shell account={session.data?.account === true} />;
}
