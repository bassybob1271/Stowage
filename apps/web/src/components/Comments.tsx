import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CornerDownRight, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import { api, type TimedComment } from '../api';
import { formatDuration } from '../lib/format';
import { confirmDialog, toast } from './Dialogs';

/** Comments on one file, refreshed every 20 s so notes from review-link guests show up. */
export function useTimedComments(mount: string, path: string) {
  return useQuery({
    queryKey: ['comments', mount, path],
    queryFn: () => api.comments.list(mount, path).then((r) => r.comments),
    refetchInterval: 20_000,
  });
}

const TS_RE = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g;

/** "raise the vocal at 1:36" → 1:36 becomes a button that jumps there. */
function Linkified({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TS_RE)) {
    out.push(text.slice(last, m.index));
    const t = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    out.push(<TimeChip key={m.index} onClick={() => onSeek(t)}>{m[0]}</TimeChip>);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function TimeChip({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mx-0.5 rounded border border-[color-mix(in_oklab,var(--color-accent)_55%,transparent)] px-1.5 text-xs font-semibold tabular-nums text-[var(--color-accent)] hover:bg-white/10" title="Jump here">
      {children}
    </button>
  );
}

/** Pins along the timeline; click one to jump. Ranges draw as bars. */
export function CommentMarkers({ comments, duration, time, onSeek, onPick }: { comments: TimedComment[]; duration: number; time: number; onSeek: (t: number) => void; onPick?: (c: TimedComment) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!duration || !Number.isFinite(duration)) return null;
  const pins = comments.filter((c) => !c.parentId && c.t !== null && c.t <= duration);
  return (
    <div
      ref={ref}
      className="relative h-5 w-full rounded-full bg-white/5 cursor-pointer"
      title="Comments on the timeline. Click to jump."
      onClick={(e) => {
        const r = ref.current!.getBoundingClientRect();
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
    >
      <div className="absolute inset-y-0 left-0 rounded-full bg-white/10 pointer-events-none" style={{ width: `${Math.min(100, (time / duration) * 100)}%` }} />
      {pins.map((c) => {
        const left = (c.t! / duration) * 100;
        const width = c.tEnd !== null ? Math.max(0.8, ((Math.min(c.tEnd, duration) - c.t!) / duration) * 100) : null;
        return (
          <button
            key={c.id}
            type="button"
            aria-label={`Comment at ${formatDuration(c.t!)} by ${c.author}`}
            title={`${formatDuration(c.t!)} · ${c.author}: ${c.body.slice(0, 90)}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeek(c.t!);
              onPick?.(c);
            }}
            className={`absolute top-1 h-3 border-2 border-neutral-950 ${c.resolved ? 'bg-neutral-500' : 'bg-[var(--color-accent)]'} ${width === null ? 'w-3 -ml-1.5 rounded-full' : 'rounded-md opacity-80'} hover:scale-125 transition`}
            style={{ left: `${left}%`, ...(width !== null ? { width: `${width}%` } : {}) }}
          />
        );
      })}
    </div>
  );
}

/**
 * The comment list and the composer. Focusing the box pins the current playhead, so a note
 * lands where you paused ("at 1:36"); "+ end" turns it into a range; or untick for the whole file.
 */
export function CommentPanel({
  mount,
  path,
  comments,
  getTime,
  time,
  onSeek,
  highlight,
  className = '',
}: {
  mount: string;
  path: string;
  comments: TimedComment[];
  getTime: () => number;
  time: number;
  onSeek: (t: number) => void;
  highlight?: string | null;
  className?: string;
}) {
  const qc = useQueryClient();
  const key = ['comments', mount, path];
  const [body, setBody] = useState('');
  const [timed, setTimed] = useState(true);
  const [pinned, setPinned] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<TimedComment | null>(null);
  const [showResolved, setShowResolved] = useState(true);
  const box = useRef<HTMLTextAreaElement>(null);
  const at = pinned ?? time;

  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: () =>
      api.comments.add(mount, path, {
        body: body.trim(),
        t: replyTo || !timed ? null : at,
        tEnd: replyTo || !timed ? null : end,
        parentId: replyTo?.id ?? null,
      }),
    onSuccess: () => {
      setBody('');
      setPinned(null);
      setEnd(null);
      setReplyTo(null);
      void refresh();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const update = useMutation({
    mutationFn: (v: { id: string; resolved: boolean }) => api.comments.update(mount, v.id, { resolved: v.resolved }),
    onSuccess: () => void refresh(),
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const remove = async (c: TimedComment) => {
    const replies = comments.filter((x) => x.parentId === c.id).length;
    if (!(await confirmDialog({ title: 'Delete comment?', message: replies ? `Its ${replies} repl${replies > 1 ? 'ies go' : 'y goes'} too.` : 'This can’t be undone.', confirm: 'Delete', danger: true }))) return;
    try {
      await api.comments.remove(mount, c.id);
      void refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const hiddenIds = new Set(showResolved ? [] : comments.filter((c) => !c.parentId && c.resolved).map((c) => c.id));
  const visible = comments.filter((c) => !hiddenIds.has(c.id) && !(c.parentId && hiddenIds.has(c.parentId)));
  const open = comments.filter((c) => !c.parentId && !c.resolved).length;
  const resolvedCount = comments.filter((c) => !c.parentId && c.resolved).length;

  return (
    <section className={`flex flex-col min-h-0 rounded-xl border border-white/10 bg-white/[0.03] text-sm ${className}`} data-keys aria-label="Comments">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <MessageSquare size={15} className="text-neutral-400" />
        <h3 className="font-semibold flex-1">
          Comments <span className="text-neutral-500 font-normal tabular-nums">{open ? `${open} open` : comments.length ? 'all resolved' : ''}</span>
        </h3>
        {resolvedCount > 0 && (
          <button className="text-xs text-neutral-400 hover:text-neutral-100" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolvedCount})
          </button>
        )}
      </header>

      <ol className="flex-1 min-h-0 overflow-y-auto py-1">
        {visible.length === 0 && <li className="px-3 py-4 text-neutral-500">No comments yet. Pause where you hear something and write a note: it’s pinned to that moment.</li>}
        {visible.map((c) => (
          <li key={c.id} className={`group px-3 py-2 ${c.parentId ? 'pl-8' : ''} ${highlight === c.id ? 'bg-white/[0.06]' : ''}`}>
            <div className="flex items-baseline gap-2 text-xs text-neutral-400">
              {c.parentId && <CornerDownRight size={12} className="self-center" />}
              <b className="text-neutral-100 font-semibold">{c.author}</b>
              {c.guest && <span>guest</span>}
              <span>{new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
              <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition">
                {!c.parentId && (
                  <button className="hover:text-neutral-100" title={c.resolved ? 'Reopen' : 'Resolve'} aria-label={c.resolved ? 'Reopen' : 'Resolve'} onClick={() => update.mutate({ id: c.id, resolved: !c.resolved })}>
                    {c.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                  </button>
                )}
                <button className="hover:text-red-400" title="Delete" aria-label="Delete" onClick={() => void remove(c)}><Trash2 size={13} /></button>
              </span>
            </div>
            <p className={`mt-0.5 whitespace-pre-wrap break-words ${c.resolved ? 'line-through text-neutral-500' : ''}`}>
              {c.t !== null && <TimeChip onClick={() => onSeek(c.t!)}>{formatDuration(c.t)}{c.tEnd !== null ? `–${formatDuration(c.tEnd)}` : ''}</TimeChip>}{' '}
              <Linkified text={c.body} onSeek={onSeek} />
            </p>
            {!c.parentId && (
              <button className="mt-0.5 text-xs text-neutral-500 hover:text-neutral-200" onClick={() => (setReplyTo(c), box.current?.focus())}>Reply</button>
            )}
          </li>
        ))}
      </ol>

      <form
        className="border-t border-white/10 p-3 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) add.mutate();
        }}
      >
        {replyTo && (
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <CornerDownRight size={12} /> Replying to <b className="text-neutral-200">{replyTo.author}</b>
            <button type="button" className="ml-auto hover:text-neutral-100" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><X size={13} /></button>
          </div>
        )}
        <textarea
          ref={box}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (!e.target.value) setPinned(null);
          }}
          onFocus={() => pinned === null && !replyTo && setPinned(getTime())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (body.trim()) add.mutate();
            }
          }}
          rows={2}
          maxLength={4000}
          placeholder={replyTo ? 'Write a reply' : 'e.g. raise the vocal here'}
          className="w-full resize-y rounded-lg bg-black/40 border border-white/10 px-3 py-2 outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {!replyTo && (
            <>
              <button
                type="button"
                aria-pressed={timed}
                onClick={() => (setTimed((v) => !v), setEnd(null))}
                className={`rounded-full border px-2.5 py-1 tabular-nums ${timed ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-white/15 text-neutral-300'}`}
                title="Pin to this moment, or make it about the whole file"
              >
                {timed ? `at ${formatDuration(at)}` : 'whole file'}
              </button>
              {timed && (
                <button
                  type="button"
                  onClick={() => setEnd(end === null ? Math.max(getTime(), at + 1) : null)}
                  className="rounded-full border border-white/15 px-2.5 py-1 text-neutral-300 tabular-nums hover:border-white/30"
                  title="Mark where this section ends (uses the current playhead)"
                >
                  {end === null ? '+ end' : `to ${formatDuration(end)} ✕`}
                </button>
              )}
              {pinned !== null && timed && (
                <button type="button" className="text-neutral-500 hover:text-neutral-200" onClick={() => setPinned(getTime())} title="Move the pin to the playhead">
                  re-pin
                </button>
              )}
            </>
          )}
          <button type="submit" className="btn btn-primary ml-auto !py-1" disabled={!body.trim() || add.isPending}>
            {replyTo ? 'Reply' : 'Comment'}
          </button>
        </div>
      </form>
    </section>
  );
}
