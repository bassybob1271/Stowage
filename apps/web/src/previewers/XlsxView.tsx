import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import type { WorkBook } from 'xlsx';
import type { PreviewProps } from './registry';

/** Best-effort spreadsheet render with SheetJS (sheet tabs, sanitized HTML table). */
export default function XlsxView({ url }: PreviewProps) {
  const [wb, setWb] = useState<WorkBook | null>(null);
  const [xlsx, setXlsx] = useState<typeof import('xlsx') | null>(null);
  const [sheet, setSheet] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const [X, buf] = await Promise.all([import('xlsx'), fetch(url).then((r) => r.arrayBuffer())]);
        if (c) return;
        setXlsx(X);
        setWb(X.read(buf, { type: 'array', sheetRows: 5000 }));
      } catch (e) {
        if (!c) setErr((e as Error).message);
      }
    })();
    return () => {
      c = true;
    };
  }, [url]);

  const html = useMemo(() => {
    if (!wb || !xlsx) return '';
    const name = wb.SheetNames[sheet];
    const ws = name ? wb.Sheets[name] : undefined;
    return ws ? DOMPurify.sanitize(xlsx.utils.sheet_to_html(ws, { header: '', footer: '' })) : '';
  }, [wb, xlsx, sheet]);

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">Couldn't read spreadsheet: {err}</div>;
  if (!wb) return <div className="h-full grid place-items-center text-sm text-neutral-400">Reading spreadsheet…</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto bg-white text-neutral-900 text-xs [&_td]:border [&_td]:border-neutral-200 [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap [&_table]:border-collapse" dangerouslySetInnerHTML={{ __html: html }} />
      {wb.SheetNames.length > 1 && (
        <div className="shrink-0 flex gap-1 px-2 py-1 border-t border-white/10 overflow-x-auto text-sm" role="tablist">
          {wb.SheetNames.map((n, i) => (
            <button key={n} role="tab" aria-selected={i === sheet} className={`btn hover:!bg-white/10 ${i === sheet ? 'bg-white/10' : ''}`} onClick={() => setSheet(i)}>{n}</button>
          ))}
        </div>
      )}
      <p className="shrink-0 text-[11px] text-neutral-500 px-3 py-1">Preview shows up to 5,000 rows per sheet.</p>
    </div>
  );
}
