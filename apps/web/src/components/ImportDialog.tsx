import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, File as FileIcon, Folder, Pause, Play, Square, Unplug, X } from 'lucide-react';
import { api, type DropboxEntry, type ImportJob } from '../api';
import { confirmDialog, toast } from './Dialogs';

const fmtBytes = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(2)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`;

const ACTIVE = new Set(['scanning', 'running', 'paused']);
const STATE_LABEL: Record<ImportJob['state'], string> = {
  scanning: 'Counting files…',
  running: 'Copying',
  paused: 'Paused',
  done: 'Done',
  failed: 'Stopped',
  canceled: 'Cancelled',
};

/** Copy folders from a member's Dropbox into their BazzyBox. The server does the copying, so the tab can close. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['box-import'],
    queryFn: api.box.importer.status,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => ACTIVE.has(j.state)) ? 3000 : false),
  });

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('import');
    if (q === 'connected') toast('Dropbox connected. Pick what to bring over.');
    if (q === 'cancelled') toast('Dropbox connection cancelled.');
    if (q === 'expired') toast('That sign-in took too long. Try Connect again.', 'error');
    if (q === 'failed') toast('Dropbox did not accept the connection. Try again.', 'error');
  }, []);

  const s = status.data;
  const active = s?.jobs.find((j) => ACTIVE.has(j.state));
  const past = s?.jobs.filter((j) => j !== active && !(j === s.jobs[0] && j.state === 'failed')).slice(0, 5) ?? [];

  const disconnect = useMutation({
    mutationFn: api.box.importer.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['box-import'] }),
    onError: (e) => toast((e as Error).message, 'error'),
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Import from Dropbox" className="w-full max-w-2xl max-h-full overflow-y-auto rounded-xl bg-panel border border-line shadow-2xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="flex items-center px-4 py-3 border-b border-line gap-2">
          <h2 className="font-semibold flex-1">Bring your files from Dropbox</h2>
          {s?.dropbox.connected && !active && (
            <button
              className="btn btn-icon"
              title="Disconnect Dropbox"
              aria-label="Disconnect Dropbox"
              onClick={async () => {
                if (await confirmDialog({ title: 'Disconnect Dropbox?', message: 'Files already copied stay in your BazzyBox. You can connect again any time.', confirm: 'Disconnect' })) disconnect.mutate();
              }}
            >
              <Unplug size={16} />
            </button>
          )}
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>

        {status.isPending && <div className="p-6 text-sm text-muted">Loading…</div>}
        {status.isError && <div className="p-6 text-sm text-red-500">{(status.error as Error).message}</div>}

        {s && (
          <div className="p-4 flex flex-col gap-5 text-sm">
            {!s.dropbox.available && (
              <p className="text-muted">Dropbox import isn’t switched on for this BazzyBox yet. The admin needs to add the Dropbox app keys.</p>
            )}

            {s.dropbox.available && !s.dropbox.connected && (
              <div className="flex flex-col gap-3 items-start">
                <p className="text-muted">
                  Connect your Dropbox and pick the folders you want. BazzyBox copies them into <b>From Dropbox</b> in the background. Nothing in your
                  Dropbox is changed or deleted, and you can close this window while it runs.
                </p>
                <a className="btn btn-primary" href="/api/box/import/dropbox/start">Connect Dropbox</a>
              </div>
            )}

            {active && <Progress job={active} />}
            {!active && s.jobs[0]?.state === 'failed' && <Failed job={s.jobs[0]} onDone={() => qc.invalidateQueries({ queryKey: ['box-import'] })} />}

            {s.dropbox.available && s.dropbox.connected && !active && (
              <Picker label={s.dropbox.label} onStarted={() => qc.invalidateQueries({ queryKey: ['box-import'] })} />
            )}

            {past.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="font-semibold">Earlier imports</h3>
                {past.map((j) => (
                  <div key={j.id} className="flex items-baseline gap-2">
                    <span className="truncate flex-1">{j.sources.map((p) => p.split('/').pop() || 'Dropbox').join(', ')}</span>
                    <span className="text-xs text-muted tabular-nums whitespace-nowrap">
                      {j.doneFiles}/{j.totalFiles} files · {fmtBytes(j.doneBytes)}
                      {j.failedFiles ? ` · ${j.failedFiles} failed` : ''}
                    </span>
                    <span className={`text-xs ${j.state === 'done' ? 'text-emerald-500' : 'text-muted'}`}>{STATE_LABEL[j.state]}</span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ job }: { job: ImportJob }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'cancel') => api.box.importer.act(job.id, a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['box-import'] }),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const pct = job.totalBytes ? Math.min(100, (job.doneBytes / job.totalBytes) * 100) : 0;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h3 className="font-semibold">{STATE_LABEL[job.state]}</h3>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {job.state === 'scanning' ? 'Checking sizes and your space…' : `${job.doneFiles}/${job.totalFiles} files · ${fmtBytes(job.doneBytes)} of ${fmtBytes(job.totalBytes)}`}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-[var(--hover)] overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-[var(--color-accent)] transition-[width] duration-700 ${job.state === 'scanning' ? 'w-1/3 animate-pulse' : ''}`}
          style={job.state === 'scanning' ? undefined : { width: `${pct}%` }}
        />
      </div>
      {job.failedFiles > 0 && <p className="text-xs text-amber-500">{job.failedFiles} file(s) couldn’t be copied after 3 tries. They’re skipped; the rest keeps going.</p>}
      <div className="flex gap-2">
        {job.state === 'running' && (
          <button className="btn" onClick={() => act.mutate('pause')}><Pause size={14} /> Pause</button>
        )}
        {job.state === 'paused' && (
          <button className="btn btn-primary" onClick={() => act.mutate('resume')}><Play size={14} /> Resume</button>
        )}
        <button
          className="btn"
          onClick={async () => {
            if (await confirmDialog({ title: 'Stop this import?', message: 'Files already copied stay in your BazzyBox.', confirm: 'Stop import', danger: true })) act.mutate('cancel');
          }}
        >
          <Square size={14} /> Stop
        </button>
      </div>
      <p className="text-xs text-muted">Copying into <b>{job.dest}</b>. You can close this window; it keeps going.</p>
    </section>
  );
}

function Failed({ job, onDone }: { job: ImportJob; onDone: () => void }) {
  const retry = useMutation({
    mutationFn: () => api.box.importer.act(job.id, 'resume'),
    onSuccess: onDone,
    onError: (e) => toast((e as Error).message, 'error'),
  });
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <h3 className="font-semibold">Some files didn’t come over</h3>
      <p className="text-xs text-muted tabular-nums">{job.doneFiles}/{job.totalFiles} files copied from {job.sources.map((p) => p.split('/').pop() || 'Dropbox').join(', ')}</p>
      {job.error && <p className="text-xs text-amber-500 break-words">{job.error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry failed files</button>
      </div>
    </section>
  );
}

function Picker({ label, onStarted }: { label?: string | null; onStarted: () => void }) {
  const [path, setPath] = useState('');
  const [picked, setPicked] = useState<Map<string, DropboxEntry>>(new Map());
  const list = useQuery({ queryKey: ['dropbox-list', path], queryFn: () => api.box.importer.list(path) });

  const start = useMutation({
    mutationFn: () => api.box.importer.start([...picked.keys()]),
    onSuccess: () => {
      toast('Import started. Counting files first.');
      setPicked(new Map());
      onStarted();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const toggle = (e: DropboxEntry) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(e.path)) n.delete(e.path);
      else n.set(e.path, e);
      return n;
    });

  const crumbs = path.split('/').filter(Boolean);
  const entries = list.data?.entries ?? [];
  const allHere = entries.length > 0 && entries.every((e) => picked.has(e.path));
  const knownBytes = [...picked.values()].reduce((a, e) => a + (e.folder ? 0 : e.size), 0);
  const folders = [...picked.values()].filter((e) => e.folder).length;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-xs text-muted flex-wrap">
        {label && label !== 'Dropbox' && <span className="mr-2">{label} ·</span>}
        <button className="hover:underline" onClick={() => setPath('')}>Dropbox</button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={12} />
            <button className="hover:underline" onClick={() => setPath('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
      </div>

      <div className="rounded-lg border border-line max-h-80 overflow-y-auto">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-xs text-muted sticky top-0 bg-panel">
          <input
            type="checkbox"
            aria-label="Select everything here"
            checked={allHere}
            onChange={() =>
              setPicked((m) => {
                const n = new Map(m);
                for (const e of entries) allHere ? n.delete(e.path) : n.set(e.path, e);
                return n;
              })
            }
          />
          {path && (
            <button className="flex items-center gap-1 hover:underline" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
              <ChevronLeft size={12} /> Up
            </button>
          )}
          <span className="ml-auto">{list.isFetching ? 'Loading…' : `${entries.length} items`}</span>
        </div>
        {list.isError && <div className="p-3 text-red-500">{(list.error as Error).message}</div>}
        {!list.isPending && entries.length === 0 && !list.isError && <div className="p-3 text-muted">This folder is empty.</div>}
        {entries.map((e) => (
          <div key={e.path} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--hover)]">
            <input type="checkbox" aria-label={`Select ${e.name}`} checked={picked.has(e.path)} onChange={() => toggle(e)} />
            {e.folder ? (
              <button className="flex items-center gap-2 flex-1 min-w-0 text-left" onClick={() => setPath(e.path)} title="Open folder">
                <Folder size={16} className="shrink-0 text-[var(--color-accent)]" />
                <span className="truncate">{e.name}</span>
              </button>
            ) : (
              <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" onClick={() => toggle(e)}>
                <FileIcon size={16} className="shrink-0 text-muted" />
                <span className="truncate">{e.name}</span>
              </label>
            )}
            {!e.folder && <span className="text-xs text-muted tabular-nums">{fmtBytes(e.size)}</span>}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted flex-1">
          {picked.size === 0
            ? 'Tick folders or files. Folders come over with everything inside.'
            : `${picked.size} picked${folders ? ` (${folders} folder${folders > 1 ? 's' : ''})` : ''}${knownBytes ? ` · ${fmtBytes(knownBytes)}+` : ''}. We check your space before copying.`}
        </span>
        <button className="btn btn-primary" disabled={picked.size === 0 || start.isPending} onClick={() => start.mutate()}>
          Start import
        </button>
      </div>
    </section>
  );
}
