import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pause, Play, RotateCcw, X, CheckCircle2, AlertCircle, FilePlus } from 'lucide-react';
import { useStore } from '../lib/store';
import { formatBytes } from '../lib/format';
import { playerStore } from '../player';
import { uploadsStore, pause, resume, retry, cancel, clearFinished, reattach, type UploadItem } from '../uploads';
import { toast } from './Dialogs';

export function UploadTray() {
  const items = useStore(uploadsStore);
  // Sit above the mini-player bar instead of covering its controls.
  const playerOpen = useStore(playerStore, (s) => s.index >= 0);
  const [collapsed, setCollapsed] = useState(false);
  if (!items.length) return null;

  const active = items.filter((u) => u.status !== 'done');
  const total = items.reduce((s, u) => s + u.size, 0);
  const sent = items.reduce((s, u) => s + (u.status === 'done' ? u.size : u.bytes), 0);
  const speed = items.reduce((s, u) => s + (u.status === 'uploading' ? u.speed : 0), 0);
  const pct = total ? Math.round((sent / total) * 100) : 100;

  return (
    <section
      aria-label="Uploads"
      className="fixed z-40 right-3 left-3 sm:left-auto sm:w-96 rounded-xl border border-line bg-panel shadow-2xl overflow-hidden transition-[bottom]"
      style={{ bottom: playerOpen ? 76 : 12 }}
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-medium">
            {active.length ? `Uploading ${active.length} item${active.length > 1 ? 's' : ''}` : 'Uploads complete'}
          </div>
          <div className="text-xs text-muted tabular-nums">
            {formatBytes(sent)} / {formatBytes(total)} · {pct}%{speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}
          </div>
        </div>
        {!active.length && <button className="btn text-xs" onClick={clearFinished}>Clear</button>}
        <button className="btn btn-icon" aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </header>
      <div className="h-1 bg-[var(--line)]"><div className="h-full bg-[var(--color-accent)] transition-[width]" style={{ width: `${pct}%` }} /></div>
      {!collapsed && (
        <ul className="max-h-72 overflow-y-auto text-sm">
          {items.map((u) => <Row key={u.id} u={u} />)}
        </ul>
      )}
    </section>
  );
}

function Row({ u }: { u: UploadItem }) {
  const pick = useRef<HTMLInputElement>(null);
  const pct = u.size ? Math.min(100, Math.round(((u.status === 'done' ? u.size : u.bytes) / u.size) * 100)) : 100;
  const eta = u.status === 'uploading' && u.speed > 0 ? Math.ceil((u.size - u.bytes) / u.speed) : null;
  return (
    <li className="px-3 py-2 border-b border-line/60 last:border-0">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="truncate" title={`${u.mount}/${u.dir ? u.dir + '/' : ''}${u.relPath}`}>{u.relPath}</div>
          <div className="text-xs text-muted tabular-nums">
            {u.status === 'done' && 'Done'}
            {u.status === 'queued' && 'Waiting…'}
            {u.status === 'paused' && `Paused · ${pct}%`}
            {u.status === 'uploading' && `${pct}% · ${formatBytes(u.speed)}/s${eta != null ? ` · ${eta < 90 ? eta + 's' : Math.ceil(eta / 60) + 'm'} left` : ''}`}
            {u.status === 'error' && <span className="text-red-500">{u.error ?? 'Failed'}</span>}
            {u.status === 'needs-file' && <span className="text-amber-600">Re-select the file to resume</span>}
          </div>
        </div>
        {u.status === 'done' && <CheckCircle2 size={18} className="text-emerald-500" aria-label="Done" />}
        {u.status === 'uploading' && <button className="btn btn-icon" aria-label={`Pause ${u.name}`} onClick={() => pause(u.id)}><Pause size={15} /></button>}
        {u.status === 'paused' && <button className="btn btn-icon" aria-label={`Resume ${u.name}`} onClick={() => resume(u.id)}><Play size={15} /></button>}
        {u.status === 'error' && (
          <>
            <AlertCircle size={16} className="text-red-500" aria-hidden />
            <button className="btn btn-icon" aria-label={`Retry ${u.name}`} onClick={() => retry(u.id)}><RotateCcw size={15} /></button>
          </>
        )}
        {u.status === 'needs-file' && (
          <>
            <button className="btn btn-icon" aria-label={`Choose ${u.name} again`} onClick={() => pick.current?.click()}><FilePlus size={15} /></button>
            <input
              ref={pick}
              type="file"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && !reattach(u.id, f)) toast(`That isn't ${u.name} (${formatBytes(u.size)})`, 'error');
              }}
            />
          </>
        )}
        {u.status !== 'done' && <button className="btn btn-icon" aria-label={`Cancel ${u.name}`} onClick={() => cancel(u.id)}><X size={15} /></button>}
      </div>
      {u.status !== 'done' && (
        <div className="mt-1.5 h-1 rounded bg-[var(--line)] overflow-hidden">
          <div className={`h-full ${u.status === 'error' ? 'bg-red-500' : 'bg-[var(--color-accent)]'}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}
