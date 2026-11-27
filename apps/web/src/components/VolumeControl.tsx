import { Volume1, Volume2, VolumeX } from 'lucide-react';
import { useStore } from '../lib/store';
import { player, playerStore } from '../player';

/** Mute button + volume slider for the shared audio player (song page and mini-player). */
export function VolumeControl({ className = '', width = 'w-24', dark = false }: { className?: string; width?: string; dark?: boolean }) {
  const volume = useStore(playerStore, (s) => s.volume);
  const muted = useStore(playerStore, (s) => s.muted);
  const silent = muted || volume === 0;
  const Icon = silent ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const shown = silent ? 0 : volume;
  return (
    <div className={`flex items-center gap-1 ${className}`} data-keys>
      <button
        type="button"
        className={`btn btn-icon ${dark ? 'hover:!bg-white/10' : ''} ${silent ? 'text-[var(--color-accent)]' : ''}`}
        aria-label={silent ? 'Unmute' : 'Mute'}
        aria-pressed={silent}
        title={silent ? 'Unmute (M)' : 'Mute (M)'}
        onClick={player.toggleMute}
      >
        <Icon size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shown}
        onChange={(e) => player.setVolume(Number(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
        className={`${width} accent-[var(--color-accent)]`}
        aria-label="Volume"
        aria-valuetext={`${Math.round(shown * 100)}%`}
        title={`Volume ${Math.round(shown * 100)}%`}
      />
    </div>
  );
}
