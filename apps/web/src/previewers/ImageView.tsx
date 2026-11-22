import { useEffect, useRef, useState, type PointerEvent as RPE } from 'react';
import { Info, Minus, Plus, Maximize } from 'lucide-react';
import { ext } from '../lib/format';
import type { PreviewProps } from './registry';

/** <img> with wheel/pinch zoom + drag pan; HEIC via heic2any; SVG only via <img> (scripts never run). */
export default function ImageView({ file, url }: PreviewProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [exif, setExif] = useState<Record<string, unknown> | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const e = ext(file.name);

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    setSrc(null);
    setErr(null);
    if (e === 'heic' || e === 'heif') {
      (async () => {
        try {
          const blob = await (await fetch(url)).blob();
          const { default: heic2any } = await import('heic2any');
          const out = await heic2any({ blob, toType: 'image/jpeg', quality: 0.9 });
          if (cancelled) return;
          revoke = URL.createObjectURL(Array.isArray(out) ? out[0]! : out);
          setSrc(revoke);
        } catch (x) {
          if (!cancelled) setErr(`HEIC decode failed: ${(x as Error).message ?? x}`);
        }
      })();
    } else setSrc(url);
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [url, e]);

  useEffect(() => {
    if (!showInfo || exif) return;
    import('exifr')
      .then(({ default: exifr }) => exifr.parse(url, { tiff: true, exif: true, gps: true, xmp: false, translateValues: true }))
      .then((d) => setExif(d ?? {}))
      .catch(() => setExif({}));
  }, [showInfo, exif, url]);

  const reset = () => (setScale(1), setOff({ x: 0, y: 0 }));
  const zoom = (f: number) => setScale((s) => Math.min(20, Math.max(0.1, s * f)));

  function down(ev: RPE) {
    (ev.target as Element).setPointerCapture(ev.pointerId);
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.current.size === 1) drag.current = { x: ev.clientX, y: ev.clientY, ox: off.x, oy: off.y };
  }
  function move(ev: RPE) {
    if (!pointers.current.has(ev.pointerId)) return;
    pointers.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch.current) zoom(d / pinch.current);
      pinch.current = d;
      return;
    }
    if (drag.current) setOff({ x: drag.current.ox + ev.clientX - drag.current.x, y: drag.current.oy + ev.clientY - drag.current.y });
  }
  function up(ev: RPE) {
    pointers.current.delete(ev.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) drag.current = null;
  }

  return (
    <div className="h-full flex">
      <div
        className="flex-1 overflow-hidden grid place-items-center touch-none cursor-grab active:cursor-grabbing select-none"
        onWheel={(ev) => zoom(ev.deltaY < 0 ? 1.12 : 1 / 1.12)}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => (scale === 1 ? setScale(2.5) : reset())}
      >
        {err && <p className="text-sm text-red-400">{err}</p>}
        {!src && !err && <p className="text-sm text-neutral-400">Decoding…</p>}
        {src && (
          <img
            src={src}
            alt={file.name}
            draggable={false}
            className={`max-w-full max-h-full object-contain ${e === 'svg' || e === 'png' || e === 'gif' || e === 'webp' ? 'checker' : ''}`}
            style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${scale})`, transition: drag.current ? 'none' : 'transform 80ms' }}
            onError={() => setErr('This image could not be displayed by the browser.')}
          />
        )}
      </div>
      {showInfo && (
        <aside className="w-72 shrink-0 border-l border-white/10 overflow-y-auto p-3 text-xs hidden sm:block">
          <h3 className="font-semibold mb-2 text-sm">EXIF</h3>
          {!exif && <p className="text-neutral-400">Reading…</p>}
          {exif && Object.keys(exif).length === 0 && <p className="text-neutral-400">No EXIF metadata.</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            {exif &&
              Object.entries(exif)
                .filter(([, v]) => v != null && typeof v !== 'object')
                .slice(0, 80)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-400">{k}</dt>
                    <dd className="break-all">{String(v)}</dd>
                  </div>
                ))}
            {exif?.DateTimeOriginal instanceof Date && (<><dt className="text-neutral-400">Taken</dt><dd>{(exif.DateTimeOriginal as Date).toLocaleString()}</dd></>)}
          </dl>
        </aside>
      )}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1" data-keys>
        <button className="btn btn-icon hover:!bg-white/10" aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}><Minus size={16} /></button>
        <span className="text-xs tabular-nums w-12 text-center">{Math.round(scale * 100)}%</span>
        <button className="btn btn-icon hover:!bg-white/10" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={16} /></button>
        <button className="btn btn-icon hover:!bg-white/10" aria-label="Fit" onClick={reset}><Maximize size={15} /></button>
        <button className={`btn btn-icon hover:!bg-white/10 ${showInfo ? 'text-sky-400' : ''}`} aria-label="EXIF info" aria-pressed={showInfo} onClick={() => setShowInfo((s) => !s)}><Info size={16} /></button>
      </div>
    </div>
  );
}
