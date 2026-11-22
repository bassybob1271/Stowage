import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { PreviewProps } from './registry';

/** Best-effort client-side .docx render (mammoth → sanitized HTML). */
export default function DocxView({ url }: PreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const [{ default: mammoth }, buf] = await Promise.all([import('mammoth'), fetch(url).then((r) => r.arrayBuffer())]);
        const r = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!c) setHtml(DOMPurify.sanitize(r.value));
      } catch (e) {
        if (!c) setErr((e as Error).message);
      }
    })();
    return () => {
      c = true;
    };
  }, [url]);
  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">Couldn't render document: {err}</div>;
  if (html == null) return <div className="h-full grid place-items-center text-sm text-neutral-400">Rendering document…</div>;
  return (
    <div className="h-full overflow-y-auto bg-neutral-200 py-8">
      <article className="prose-md max-w-3xl mx-auto bg-white text-neutral-900 shadow-xl px-12 py-14 min-h-full" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
