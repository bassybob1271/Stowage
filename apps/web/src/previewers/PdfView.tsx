import { memo, useEffect, useRef, useState } from 'react';
import { Minus, Plus, Search, PanelLeft } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PreviewProps } from './registry';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders a page into a canvas when it scrolls near the viewport. */
const Page = memo(function Page({ doc, n, scale, thumb, onClick }: { doc: PDFDocumentProxy; n: number; scale: number; thumb?: boolean; onClick?: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancel = false;
    void doc.getPage(n).then((p) => {
      if (cancel) return;
      const v = p.getViewport({ scale });
      setSize({ w: v.width, h: v.height });
    });
    return () => {
      cancel = true;
    };
  }, [doc, n, scale]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { rootMargin: thumb ? '200px' : '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, [thumb]);

  useEffect(() => {
    if (!visible || !size) return;
    let task: { cancel(): void; promise: Promise<void> } | undefined;
    void doc.getPage(n).then((p) => {
      const c = canvas.current;
      if (!c) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const v = p.getViewport({ scale: scale * dpr });
      c.width = v.width;
      c.height = v.height;
      task = p.render({ canvas: c, viewport: v });
      task.promise.catch(() => {});
    });
    return () => task?.cancel();
  }, [visible, size, doc, n, scale]);

  return (
    <div ref={box} id={thumb ? undefined : `pdf-page-${n}`} className={`relative bg-white shadow-lg ${onClick ? 'cursor-pointer' : ''}`} style={size ? { width: size.w, height: size.h } : { width: thumb ? 120 : 600, height: thumb ? 160 : 800 }} onClick={onClick}>
      <canvas ref={canvas} className="w-full h-full" />
      {thumb && <span className="absolute bottom-1 right-1 text-[10px] bg-black/60 text-white px-1 rounded">{n}</span>}
    </div>
  );
});

export default function PdfView({ url }: PreviewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scale, setScale] = useState(1.2);
  const [thumbs, setThumbs] = useState(() => window.innerWidth > 900);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<number[] | null>(null);
  const [hit, setHit] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Range requests: pdf.js fetches only the chunks it needs.
    const task = pdfjs.getDocument({ url, rangeChunkSize: 256 * 1024, disableAutoFetch: true, disableStream: false, withCredentials: true });
    task.promise.then(setDoc, (e: Error) => setErr(e.message));
    return () => void task.destroy();
  }, [url]);

  const goto = (n: number) => document.getElementById(`pdf-page-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  async function search() {
    if (!doc || !query.trim()) return setHits(null);
    const q = query.toLowerCase();
    const found: number[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').toLowerCase();
      if (text.includes(q)) found.push(i);
    }
    setHits(found);
    setHit(0);
    if (found[0]) goto(found[0]);
  }

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">Couldn't open PDF: {err}</div>;
  if (!doc) return <div className="h-full grid place-items-center text-sm text-neutral-400">Loading PDF…</div>;
  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-sm" data-keys>
        <button className={`btn btn-icon hover:!bg-white/10 ${thumbs ? 'text-sky-400' : ''}`} aria-label="Page thumbnails" aria-pressed={thumbs} onClick={() => setThumbs((t) => !t)}><PanelLeft size={16} /></button>
        <span className="text-neutral-400">{doc.numPages} pages</span>
        <div className="flex items-center gap-1 ml-2">
          <button className="btn btn-icon hover:!bg-white/10" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.4, s / 1.2))}><Minus size={15} /></button>
          <span className="w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <button className="btn btn-icon hover:!bg-white/10" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(5, s * 1.2))}><Plus size={15} /></button>
        </div>
        <form className="ml-auto flex items-center gap-1" onSubmit={(e) => (e.preventDefault(), void search())}>
          <Search size={14} className="text-neutral-400" />
          <input className="input !bg-transparent !py-0.5 w-36 sm:w-48 text-neutral-100" placeholder="Search text" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search in PDF" />
          {hits && (
            <>
              <span className="text-xs text-neutral-400 tabular-nums">{hits.length ? `${hit + 1}/${hits.length}` : '0'}</span>
              <button type="button" className="btn btn-icon hover:!bg-white/10 text-xs" disabled={!hits.length} onClick={() => { const n = (hit + 1) % hits.length; setHit(n); goto(hits[n]!); }}>Next</button>
            </>
          )}
        </form>
      </div>
      <div className="flex-1 min-h-0 flex">
        {thumbs && (
          <div className="w-40 shrink-0 overflow-y-auto border-r border-white/10 p-3 flex flex-col items-center gap-3">
            {pages.map((n) => (
              <div key={n} className={hits?.includes(n) ? 'ring-2 ring-sky-400' : ''}>
                <Page doc={doc} n={n} scale={0.18} thumb onClick={() => goto(n)} />
              </div>
            ))}
          </div>
        )}
        <div ref={scroller} className="flex-1 overflow-auto p-4 flex flex-col items-center gap-4 bg-neutral-800">
          {pages.map((n) => <Page key={`${n}-${scale}`} doc={doc} n={n} scale={scale} />)}
        </div>
      </div>
    </div>
  );
}
