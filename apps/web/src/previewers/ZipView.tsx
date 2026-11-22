import { useEffect, useState } from 'react';
import { ZipReader, HttpRangeReader, BlobWriter, configure, type Entry, type FileEntry } from '@zip.js/zip.js';
import { Download, X } from 'lucide-react';
import { formatBytes } from '../lib/format';
import { FileIcon } from '../components/FileIcon';
import { mimeFor } from '@stowage/shared';
import type { PreviewProps } from './registry';

configure({ useWebWorkers: false });

/** Lists the central directory with Range reads (doesn't download the whole archive). */
export default function ZipView({ url }: PreviewProps) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<{ entry: FileEntry; blobUrl: string; text?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const reader = new ZipReader(new HttpRangeReader(url));
    reader.getEntries().then(setEntries, (e: Error) => setErr(e.message));
    return () => void reader.close().catch(() => {});
  }, [url]);

  useEffect(() => () => { if (open) URL.revokeObjectURL(open.blobUrl); }, [open]);

  async function extract(e: FileEntry, mode: 'view' | 'download') {
    setBusy(e.filename);
    try {
      const blob = await e.getData(new BlobWriter(mimeFor(e.filename)));
      const blobUrl = URL.createObjectURL(blob);
      if (mode === 'download') {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = e.filename.split('/').pop() ?? 'file';
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000);
      } else {
        const m = mimeFor(e.filename);
        const text = m.startsWith('text/') || m === 'application/json' ? (await blob.slice(0, 1_000_000).text()) : undefined;
        setOpen({ entry: e, blobUrl, text });
      }
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">Couldn't read archive: {err}</div>;
  if (!entries) return <div className="h-full grid place-items-center text-sm text-neutral-400">Reading archive index…</div>;
  const total = entries.reduce((s, e) => s + (e.uncompressedSize ?? 0), 0);

  return (
    <div className="h-full flex">
      <div className="flex-1 overflow-auto">
        <div className="px-4 py-2 text-xs text-neutral-400 border-b border-white/10">{entries.length} entries · {formatBytes(total)} uncompressed</div>
        <table className="w-full text-sm">
          <tbody>
            {entries.map((e) => {
              const m = mimeFor(e.filename);
              const previewable = !e.directory && (m.startsWith('image/') || m.startsWith('text/') || m === 'application/json');
              return (
                <tr key={e.filename} className="border-b border-white/5 hover:bg-white/5">
                  <td className="px-4 py-1.5">
                    <button className="flex items-center gap-2 text-left disabled:cursor-default" disabled={!previewable} onClick={() => void extract(e as FileEntry, 'view')}>
                      <FileIcon entry={{ name: e.filename, isDir: e.directory, mime: m }} size={16} />
                      <span className="break-all">{e.filename}</span>
                      {busy === e.filename && <span className="text-xs text-neutral-400">…</span>}
                    </button>
                  </td>
                  <td className="px-2 text-right text-neutral-400 tabular-nums whitespace-nowrap">{e.directory ? '' : formatBytes(e.uncompressedSize)}</td>
                  <td className="px-2 w-10">
                    {!e.directory && <button className="btn btn-icon hover:!bg-white/10" aria-label={`Download ${e.filename}`} onClick={() => void extract(e as FileEntry, 'download')}><Download size={14} /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && (
        <aside className="w-1/2 border-l border-white/10 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-sm">
            <span className="truncate flex-1">{open.entry.filename}</span>
            <button className="btn btn-icon hover:!bg-white/10" aria-label="Close entry" onClick={() => setOpen(null)}><X size={16} /></button>
          </div>
          <div className="flex-1 overflow-auto grid place-items-center">
            {open.text != null ? (
              <pre className="w-full h-full p-3 text-xs whitespace-pre-wrap break-all">{open.text}</pre>
            ) : (
              <img src={open.blobUrl} alt={open.entry.filename} className="max-w-full max-h-full object-contain" />
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
