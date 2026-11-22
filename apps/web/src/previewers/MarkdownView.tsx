import { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useText, CodeEditor } from './CodeView';
import type { PreviewProps } from './registry';

/** marked + DOMPurify, with a raw/rendered toggle. */
export default function MarkdownView({ mount, file }: PreviewProps) {
  const { text, err } = useText(mount.id, file.path, file.etag);
  const [raw, setRaw] = useState(false);
  const html = useMemo(() => {
    if (text == null) return '';
    const dirty = marked.parse(text, { async: false, gfm: true }) as string;
    // Sanitize; also neutralize remote images/links' ability to leak referrers.
    return DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input'], ADD_ATTR: ['target'] });
  }, [text]);

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">{err}</div>;
  if (text == null) return <div className="h-full grid place-items-center text-sm text-neutral-400">Loading…</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex justify-end gap-1 px-3 py-1.5 border-b border-white/10 text-sm" role="tablist">
        <button role="tab" aria-selected={!raw} className={`btn hover:!bg-white/10 ${!raw ? 'bg-white/10' : ''}`} onClick={() => setRaw(false)}>Rendered</button>
        <button role="tab" aria-selected={raw} className={`btn hover:!bg-white/10 ${raw ? 'bg-white/10' : ''}`} onClick={() => setRaw(true)}>Raw</button>
      </div>
      {raw ? (
        <div className="flex-1 min-h-0"><CodeEditor value={text} name={file.name} editing={false} /></div>
      ) : (
        <div className="flex-1 overflow-y-auto bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
          <article
            className="prose-md max-w-3xl mx-auto px-6 py-8"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest('a');
              if (a?.href && !a.href.startsWith(location.origin)) {
                e.preventDefault();
                window.open(a.href, '_blank', 'noopener,noreferrer');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
