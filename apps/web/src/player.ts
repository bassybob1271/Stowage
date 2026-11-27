import { createStore, local } from './lib/store';
import { fileUrl } from './api';

/**
 * Global audio player. One <audio> element lives outside React's route tree,
 * so playback continues while browsing (persistent mini-player).
 */
export interface Track {
  mount: string;
  path: string;
  name: string;
}

export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  time: number;
  duration: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  volume: number;
  muted: boolean;
  /** Shuffle order (indexes into queue). */
  order: number[];
}

export const audio = new Audio();
audio.preload = 'metadata';

export const playerStore = createStore<PlayerState>({
  queue: [],
  index: -1,
  playing: false,
  time: 0,
  duration: 0,
  shuffle: local.get('player.shuffle', false),
  repeat: local.get('player.repeat', 'off'),
  volume: local.get('player.volume', 1),
  muted: local.get('player.muted', false),
  order: [],
});
audio.volume = playerStore.get().volume;
audio.muted = playerStore.get().muted;

const set = (p: Partial<PlayerState>) => playerStore.set((s) => ({ ...s, ...p }));

function shuffled(n: number, first: number) {
  const a = Array.from({ length: n }, (_, i) => i).filter((i) => i !== first);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return [first, ...a];
}

function load(index: number, autoplay = true) {
  const s = playerStore.get();
  const t = s.queue[index];
  if (!t) return;
  audio.src = fileUrl(t.mount, t.path);
  set({ index, time: 0, duration: 0 });
  if (autoplay) void audio.play().catch(() => set({ playing: false }));
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.name.replace(/\.[^.]+$/, ''), album: t.path.split('/').slice(-2, -1)[0] ?? '' });
  }
}

/** Play a track with its folder as the playlist. */
export function playFolder(tracks: Track[], startPath: string) {
  const index = Math.max(0, tracks.findIndex((t) => t.path === startPath));
  set({ queue: tracks, order: shuffled(tracks.length, index) });
  load(index);
}

export function enqueueTrack(t: Track) {
  const s = playerStore.get();
  if (!s.queue.length) return playFolder([t], t.path);
  set({ queue: [...s.queue, t], order: [...s.order, s.queue.length] });
}

function step(dir: 1 | -1): number | null {
  const s = playerStore.get();
  if (!s.queue.length) return null;
  if (s.shuffle) {
    const pos = s.order.indexOf(s.index) + dir;
    if (pos >= 0 && pos < s.order.length) return s.order[pos]!;
    return s.repeat === 'all' ? s.order[(pos + s.order.length) % s.order.length]! : null;
  }
  const n = s.index + dir;
  if (n >= 0 && n < s.queue.length) return n;
  return s.repeat === 'all' ? (n + s.queue.length) % s.queue.length : null;
}

export const player = {
  toggle: () => (audio.paused ? void audio.play() : audio.pause()),
  next: () => {
    const n = step(1);
    if (n != null) load(n);
  },
  prev: () => {
    if (audio.currentTime > 3) return void (audio.currentTime = 0);
    const n = step(-1);
    if (n != null) load(n);
  },
  seek: (t: number) => (audio.currentTime = t),
  jump: (i: number) => load(i),
  setVolume: (v: number) => {
    v = Math.max(0, Math.min(1, v));
    audio.volume = v;
    local.set('player.volume', v);
    // Moving the slider up unmutes, like every music app.
    if (v > 0 && playerStore.get().muted) {
      audio.muted = false;
      local.set('player.muted', false);
      set({ volume: v, muted: false });
    } else set({ volume: v });
  },
  toggleMute: () => {
    const s = playerStore.get();
    const muted = !s.muted;
    // Unmuting at volume 0 would still be silent: bring it back to a sensible level.
    if (!muted && s.volume === 0) player.setVolume(0.7);
    audio.muted = muted;
    local.set('player.muted', muted);
    set({ muted });
  },
  toggleShuffle: () => {
    const s = playerStore.get();
    local.set('player.shuffle', !s.shuffle);
    set({ shuffle: !s.shuffle, order: shuffled(s.queue.length, Math.max(0, s.index)) });
  },
  cycleRepeat: () => {
    const r = playerStore.get().repeat;
    const next = r === 'off' ? 'all' : r === 'all' ? 'one' : 'off';
    local.set('player.repeat', next);
    set({ repeat: next });
  },
  stop: () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    set({ queue: [], index: -1, playing: false, time: 0, duration: 0 });
  },
};

audio.addEventListener('play', () => set({ playing: true }));
audio.addEventListener('pause', () => set({ playing: false }));
audio.addEventListener('loadedmetadata', () => set({ duration: audio.duration }));
let lastTick = 0;
audio.addEventListener('timeupdate', () => {
  const now = performance.now();
  if (now - lastTick > 250) {
    lastTick = now;
    set({ time: audio.currentTime });
  }
});
audio.addEventListener('ended', () => {
  if (playerStore.get().repeat === 'one') {
    audio.currentTime = 0;
    void audio.play();
    return;
  }
  const n = step(1);
  if (n != null) load(n);
  else set({ playing: false });
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => void audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack', player.next);
  navigator.mediaSession.setActionHandler('previoustrack', player.prev);
  navigator.mediaSession.setActionHandler('seekto', (d) => d.seekTime != null && player.seek(d.seekTime));
}

// M mutes/unmutes the music player from anywhere in the app (not while typing, and not over a video).
addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest('input,textarea,select,[contenteditable],video,.monaco-editor')) return;
  if (playerStore.get().index < 0) return;
  e.preventDefault();
  player.toggleMute();
});
