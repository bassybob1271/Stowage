import { useEffect, useState } from 'react';
import type { PreviewProps } from './registry';

const SIZES = [12, 16, 24, 36, 56, 80];

/** Specimen render via the FontFace API. */
export default function FontView({ file, url }: PreviewProps) {
  const [family, setFamily] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog');

  useEffect(() => {
    const fam = `stowage-preview-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(fam, `url("${url}")`);
    face.load().then(
      (f) => {
        document.fonts.add(f);
        setFamily(fam);
      },
      (e: Error) => setErr(e.message),
    );
    return () => {
      document.fonts.delete(face);
    };
  }, [url]);

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">Couldn't load font: {err}</div>;
  if (!family) return <div className="h-full grid place-items-center text-sm text-neutral-400">Loading font…</div>;
  return (
    <div className="h-full overflow-y-auto bg-white text-neutral-900">
      <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col gap-6" style={{ fontFamily: family }}>
        <input
          className="input !text-neutral-900 !bg-neutral-50 font-sans"
          value={sample}
          onChange={(e) => setSample(e.target.value)}
          aria-label="Sample text"
          data-keys
        />
        <div className="text-5xl break-words">{file.name.replace(/\.[^.]+$/, '')}</div>
        <div className="text-2xl tracking-wide break-words">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !?&amp;@#%(){}[]</div>
        {SIZES.map((s) => (
          <div key={s} className="flex items-baseline gap-4 border-t border-neutral-200 pt-3">
            <span className="text-xs text-neutral-400 w-10 font-sans shrink-0">{s}px</span>
            <span className="break-words min-w-0" style={{ fontSize: s, lineHeight: 1.2 }}>{sample}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
