import { useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, X, ListMusic } from 'lucide-react';
import { useStore } from '../lib/store';
import { formatDuration } from '../lib/format';
import { VolumeControl } from './VolumeControl';
import { player, playerStore } from '../player';

/** Persistent mini-player: rendered once at the shell level, so audio keeps playing while you browse. */
export function MiniPlayer() {
  const s = useStore(playerStore);
  const [queueOpen, setQueueOpen] = useState(false);
  const t = s.queue[s.index];
  if (!t) return null;
  return (
    <div className="shrink-0 border-t border-line bg-panel px-3 py-2 flex items-center gap-3 text-sm relative" role="region" aria-label="Audio player">
      <div className="flex items-center gap-0.5">
        <button className="btn btn-icon" aria-label="Previous" onClick={player.prev}><SkipBack size={16} /></button>
        <button className="btn btn-icon" aria-label={s.playing ? 'Pause' : 'Play'} onClick={player.toggle}>
          {s.playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button className="btn btn-icon" aria-label="Next" onClick={player.next}><SkipForward size={16} /></button>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="truncate font-medium">{t.name}</div>
        <div className="flex items-center gap-2 text-xs text-muted tabular-nums">
          <span>{formatDuration(s.time)}</span>
          <input
            type="range"
            min={0}
            max={s.duration || 0}
            step={0.1}
            value={s.time}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="flex-1 accent-[var(--color-accent)]"
            aria-label="Seek"
          />
          <span>{formatDuration(s.duration)}</span>
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        <button className={`btn btn-icon ${s.shuffle ? 'text-[var(--color-accent)]' : ''}`} aria-pressed={s.shuffle} aria-label="Shuffle" onClick={player.toggleShuffle}><Shuffle size={15} /></button>
        <button className={`btn btn-icon ${s.repeat !== 'off' ? 'text-[var(--color-accent)]' : ''}`} aria-label={`Repeat: ${s.repeat}`} onClick={player.cycleRepeat}>
          {s.repeat === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
        </button>
      </div>
      <VolumeControl width="w-16 sm:w-20 hidden min-[420px]:block" />
      <button className="btn btn-icon" aria-label="Queue" aria-expanded={queueOpen} onClick={() => setQueueOpen((o) => !o)}><ListMusic size={16} /></button>
      <button className="btn btn-icon" aria-label="Close player" onClick={player.stop}><X size={16} /></button>
      {queueOpen && (
        <ol className="menu absolute bottom-full right-3 mb-2 max-h-80 overflow-y-auto w-80">
          {s.queue.map((q, i) => (
            <li key={q.mount + q.path + i}>
              <button className={i === s.index ? 'font-semibold text-[var(--color-accent)]' : ''} onClick={() => player.jump(i)}>
                <span className="text-muted tabular-nums w-5 text-right">{i + 1}</span>
                <span className="truncate">{q.name}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
