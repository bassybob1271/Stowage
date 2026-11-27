import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, ListPlus, Music } from 'lucide-react';
import type WaveSurfer from 'wavesurfer.js';
import { thumbUrl } from '../api';
import { useStore } from '../lib/store';
import { formatDuration } from '../lib/format';
import { enqueueTrack, player, playerStore, playFolder } from '../player';
import type { PreviewProps } from './registry';
import { VolumeControl } from '../components/VolumeControl';
import { CommentMarkers, CommentPanel, useTimedComments } from '../components/Comments';

const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/i;
const WAVEFORM_MAX = 60 * 1024 * 1024;

/**
 * Plays through the global player (folder = playlist), so closing the preview
 * leaves the mini-player running. The waveform uses its own muted element and
 * mirrors the global player's position.
 */
export default function AudioView({ mount, file, url, siblings }: PreviewProps) {
  const s = useStore(playerStore);
  const wave = useRef<HTMLDivElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const [cover, setCover] = useState(true);
  const current = s.queue[s.index];
  const isCurrent = current?.mount === mount.id && current.path === file.path;

  useEffect(() => {
    if (isCurrent) return;
    const tracks = siblings.filter((f) => AUDIO_RE.test(f.name)).map((f) => ({ mount: mount.id, path: f.path, name: f.name }));
    playFolder(tracks.length ? tracks : [{ mount: mount.id, path: file.path, name: file.name }], file.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  useEffect(() => {
    if (!wave.current || file.size > WAVEFORM_MAX) return;
    let destroyed = false;
    void import('wavesurfer.js').then(({ default: WS }) => {
      if (destroyed || !wave.current) return;
      const media = document.createElement('audio');
      media.muted = true;
      const w = WS.create({
        container: wave.current,
        url,
        media,
        height: 96,
        waveColor: 'rgba(160,170,190,0.55)',
        progressColor: 'oklch(0.68 0.17 265)',
        cursorColor: '#fff',
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
      });
      w.on('interaction', (t) => player.seek(t));
      ws.current = w;
    });
    return () => {
      destroyed = true;
      ws.current?.destroy();
      ws.current = null;
    };
  }, [url, file.size]);

  useEffect(() => {
    if (isCurrent && ws.current && s.duration) ws.current.setTime(s.time);
  }, [s.time, s.duration, isCurrent]);

  const time = isCurrent ? s.time : 0;
  const duration = isCurrent ? s.duration : 0;
  const comments = useTimedComments(mount.id, file.path);
  const [picked, setPicked] = useState<string | null>(null);
  const seekTo = (t: number) => {
    if (!isCurrent) return;
    player.seek(t);
    if (!playerStore.get().playing) player.toggle();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-8 flex flex-col items-center gap-6">
        <div className="w-56 h-56 rounded-xl bg-white/5 grid place-items-center overflow-hidden shadow-2xl">
          {cover ? (
            <img src={thumbUrl(mount.id, file, 512)} alt="" className="w-full h-full object-cover" onError={() => setCover(false)} />
          ) : (
            <Music size={64} className="text-neutral-500" />
          )}
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold">{file.name.replace(/\.[^.]+$/, '')}</div>
          <div className="text-sm text-neutral-400">{file.path.split('/').slice(-2, -1)[0] ?? mount.label}</div>
        </div>
        <div className="w-full" data-keys>
          {file.size <= WAVEFORM_MAX ? (
            <div ref={wave} className="w-full cursor-pointer" aria-label="Waveform (click to seek)" />
          ) : (
            <input type="range" className="w-full accent-[var(--color-accent)]" min={0} max={duration || 0} step={0.1} value={time} onChange={(e) => player.seek(Number(e.target.value))} aria-label="Seek" />
          )}
          <div className="flex justify-between text-xs text-neutral-400 tabular-nums mt-1">
            <span>{formatDuration(time)}</span>
            <span>{formatDuration(duration)}</span>
          </div>
          <div className="mt-2">
            <CommentMarkers comments={comments.data ?? []} duration={duration} time={time} onSeek={seekTo} onPick={(c) => setPicked(c.id)} />
          </div>
        </div>
        <div className="flex items-center gap-2" data-keys>
          <button className={`btn btn-icon hover:!bg-white/10 ${s.shuffle ? 'text-sky-400' : ''}`} aria-pressed={s.shuffle} aria-label="Shuffle" onClick={player.toggleShuffle}><Shuffle size={18} /></button>
          <button className="btn btn-icon hover:!bg-white/10" aria-label="Previous track" onClick={player.prev}><SkipBack size={22} /></button>
          <button className="rounded-full bg-white text-black p-3 hover:scale-105 transition" aria-label={s.playing && isCurrent ? 'Pause' : 'Play'} onClick={() => (isCurrent ? player.toggle() : playFolder([{ mount: mount.id, path: file.path, name: file.name }], file.path))}>
            {s.playing && isCurrent ? <Pause size={24} /> : <Play size={24} />}
          </button>
          <button className="btn btn-icon hover:!bg-white/10" aria-label="Next track" onClick={player.next}><SkipForward size={22} /></button>
          <button className={`btn btn-icon hover:!bg-white/10 ${s.repeat !== 'off' ? 'text-sky-400' : ''}`} aria-label={`Repeat: ${s.repeat}`} onClick={player.cycleRepeat}>
            {s.repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
          </button>
          <button className="btn btn-icon hover:!bg-white/10" aria-label="Add to queue" title="Add to queue" onClick={() => enqueueTrack({ mount: mount.id, path: file.path, name: file.name })}><ListPlus size={18} /></button>
          <VolumeControl dark className="ml-2" width="w-28" />
        </div>
        <CommentPanel
          className="w-full max-h-[28rem]"
          mount={mount.id}
          path={file.path}
          comments={comments.data ?? []}
          getTime={() => (isCurrent ? playerStore.get().time : 0)}
          time={time}
          onSeek={seekTo}
          highlight={picked}
        />
        {s.queue.length > 1 && (
          <ol className="w-full text-sm divide-y divide-white/5">
            {s.queue.map((t, i) => (
              <li key={t.path + i}>
                <button className={`w-full text-left px-3 py-2 rounded hover:bg-white/5 flex gap-3 ${i === s.index ? 'text-sky-400 font-medium' : ''}`} onClick={() => player.jump(i)}>
                  <span className="w-6 text-right text-neutral-500 tabular-nums">{i + 1}</span>
                  <span className="truncate">{t.name}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
