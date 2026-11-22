import { useEffect, useRef, useState } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { fileUrl } from '../api';
import { ext } from '../lib/format';
import { audio } from '../player';
import type { PreviewProps } from './registry';

/** SRT → WebVTT (timestamps use '.' and a header). */
export function srtToVtt(srt: string) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2').replace(/^\d+\n(?=\d\d:)/gm, '');
}

/** <video> with Range seeking (native), speed, PiP, sibling .vtt/.srt subtitles, and HLS via hls.js. */
export default function VideoView({ mount, file, url, siblings }: PreviewProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState(1);
  const [tracks, setTracks] = useState<{ label: string; src: string; lang: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const isHls = ext(file.name) === 'm3u8';

  // Pause the global audio player while a video plays.
  useEffect(() => {
    const v = ref.current;
    const onPlay = () => audio.pause();
    v?.addEventListener('play', onPlay);
    return () => v?.removeEventListener('play', onPlay);
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!isHls || v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      return;
    }
    let hls: import('hls.js').default | undefined;
    void import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) return setErr('HLS is not supported in this browser.');
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setErr(`HLS error: ${d.details}`));
      hls.loadSource(url);
      hls.attachMedia(v);
    });
    return () => hls?.destroy();
  }, [url, isHls]);

  // Subtitles: siblings named <stem>.vtt / <stem>.srt / <stem>.<lang>.vtt
  useEffect(() => {
    const stem = file.name.replace(/\.[^.]+$/, '');
    const subs = siblings.filter((s) => s.name.startsWith(stem + '.') && /\.(vtt|srt)$/i.test(s.name));
    const made: string[] = [];
    let cancelled = false;
    void Promise.all(
      subs.map(async (s) => {
        const lang = s.name.slice(stem.length + 1).replace(/\.(vtt|srt)$/i, '') || 'und';
        if (/\.vtt$/i.test(s.name)) return { label: lang === 'und' ? 'Subtitles' : lang, src: fileUrl(mount.id, s.path), lang };
        const text = await (await fetch(fileUrl(mount.id, s.path))).text();
        const src = URL.createObjectURL(new Blob([srtToVtt(text)], { type: 'text/vtt' }));
        made.push(src);
        return { label: lang === 'und' ? 'Subtitles' : lang, src, lang };
      }),
    ).then((t) => !cancelled && setTracks(t));
    return () => {
      cancelled = true;
      made.forEach(URL.revokeObjectURL);
    };
  }, [file.name, siblings, mount.id]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 grid place-items-center bg-black">
        {err ? (
          <p className="text-sm text-red-400">{err}</p>
        ) : (
          <video
            ref={ref}
            controls
            autoPlay
            playsInline
            preload="metadata"
            crossOrigin="use-credentials"
            className="max-w-full max-h-full"
            onError={() => setErr('The browser could not play this video (codec not supported?). Try downloading it.')}
          >
            {tracks.map((t, i) => <track key={t.src} kind="subtitles" src={t.src} label={t.label} srcLang={t.lang} default={i === 0} />)}
          </video>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-center gap-2 py-2 text-sm" data-keys>
        <label className="flex items-center gap-1 text-neutral-400">
          Speed
          <select className="input !bg-transparent !py-0.5 text-neutral-100" value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        {'pictureInPictureEnabled' in document && (
          <button className="btn hover:!bg-white/10" onClick={() => void ref.current?.requestPictureInPicture().catch(() => {})}>
            <PictureInPicture2 size={16} /> Picture-in-picture
          </button>
        )}
      </div>
    </div>
  );
}
