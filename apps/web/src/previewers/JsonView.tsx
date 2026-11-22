import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useText, CodeEditor } from './CodeView';
import type { PreviewProps } from './registry';

type J = null | boolean | number | string | J[] | { [k: string]: J };

function Node({ k, v, depth }: { k: string | null; v: J; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = v !== null && typeof v === 'object';
  const entries = isObj ? (Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)) : [];
  const label = k != null && <span className="text-sky-300">{Array.isArray(v) || !/^\d+$/.test(k) ? JSON.stringify(k) : k}</span>;
  if (!isObj) {
    const color = typeof v === 'string' ? 'text-emerald-300' : typeof v === 'number' ? 'text-amber-300' : 'text-fuchsia-300';
    return (
      <div className="pl-5">
        {label}
        {label && ': '}
        <span className={`${color} break-all`}>{JSON.stringify(v)}</span>
      </div>
    );
  }
  const [o, c] = Array.isArray(v) ? ['[', ']'] : ['{', '}'];
  return (
    <div className={depth ? 'pl-5' : ''}>
      <button className="inline-flex items-center -ml-5 hover:text-white" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="ml-1">
          {label}
          {label && ': '}
          {o}
          {!open && <span className="text-neutral-500"> {entries.length} {Array.isArray(v) ? 'items' : 'keys'} </span>}
          {!open && c}
        </span>
      </button>
      {open && (
        <>
          {entries.slice(0, 5000).map(([ck, cv]) => <Node key={ck} k={ck} v={cv} depth={depth + 1} />)}
          {entries.length > 5000 && <div className="pl-5 text-neutral-500">… {entries.length - 5000} more</div>}
          <div>{c}</div>
        </>
      )}
    </div>
  );
}

/** Collapsible tree, with a raw view (and raw fallback for invalid JSON). */
export default function JsonView({ mount, file }: PreviewProps) {
  const { text, err } = useText(mount.id, file.path, file.etag);
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    if (text == null) return { ok: false as const };
    try {
      return { ok: true as const, v: JSON.parse(text) as J };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [text]);

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">{err}</div>;
  if (text == null) return <div className="h-full grid place-items-center text-sm text-neutral-400">Loading…</div>;
  const showRaw = raw || !parsed.ok;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-white/10 text-sm">
        {!parsed.ok && <span className="text-amber-400 text-xs">Invalid JSON: {'error' in parsed ? parsed.error : ''}</span>}
        <div className="ml-auto flex gap-1">
          <button disabled={!parsed.ok} className={`btn hover:!bg-white/10 ${!showRaw ? 'bg-white/10' : ''}`} onClick={() => setRaw(false)}>Tree</button>
          <button className={`btn hover:!bg-white/10 ${showRaw ? 'bg-white/10' : ''}`} onClick={() => setRaw(true)}>Raw</button>
        </div>
      </div>
      {showRaw ? (
        <div className="flex-1 min-h-0"><CodeEditor value={text} name={file.name} editing={false} /></div>
      ) : (
        <div className="flex-1 overflow-auto p-4 pl-8 font-mono text-[13px] leading-6 text-neutral-200">
          {parsed.ok && <Node k={null} v={parsed.v} depth={0} />}
        </div>
      )}
    </div>
  );
}
