import { useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import { useReactTable, getCoreRowModel, getSortedRowModel, flexRender, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ext } from '../lib/format';
import type { PreviewProps } from './registry';

type Row = string[];

/** Streamed parse (papaparse) into a virtualized, sortable table. */
export default function CsvView({ file, url }: PreviewProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [header, setHeader] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let first = true;
    const buf: Row[] = [];
    let flushT: number | undefined;
    const flush = () => setRows((r) => r.concat(buf.splice(0)));
    Papa.parse<Row>(url, {
      download: true,
      delimiter: ext(file.name) === 'tsv' ? '\t' : '',
      skipEmptyLines: true,
      worker: false,
      chunkSize: 512 * 1024,
      chunk(res) {
        let data = res.data;
        if (first) {
          setHeader(data[0] ?? []);
          data = data.slice(1);
          first = false;
        }
        buf.push(...data);
        if (!flushT) flushT = window.setTimeout(() => ((flushT = undefined), flush()), 100);
      },
      complete() {
        flush();
        setDone(true);
      },
      error(e) {
        setErr(e.message);
      },
    });
    return () => window.clearTimeout(flushT);
  }, [url, file.name]);

  const columns = useMemo<ColumnDef<Row>[]>(
    () =>
      header.map((h, i) => ({
        id: String(i),
        header: h || `Column ${i + 1}`,
        accessorFn: (r) => r[i] ?? '',
        sortingFn: (a, b, id) => {
          const x = a.getValue<string>(id);
          const y = b.getValue<string>(id);
          const nx = Number(x);
          const ny = Number(y);
          return x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y, undefined, { numeric: true });
        },
      })),
    [header],
  );

  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const all = table.getRowModel().rows;
  const v = useVirtualizer({ count: all.length, getScrollElement: () => scroller.current, estimateSize: () => 30, overscan: 20 });

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">{err}</div>;
  return (
    <div className="h-full flex flex-col bg-neutral-900">
      <div className="shrink-0 px-3 py-1.5 border-b border-white/10 text-xs text-neutral-400 tabular-nums">
        {rows.length.toLocaleString()} rows × {header.length} columns{done ? '' : ' · loading…'}
      </div>
      <div ref={scroller} className="flex-1 overflow-auto text-xs font-mono">
        <table className="border-collapse" style={{ minWidth: '100%' }}>
          <thead className="sticky top-0 z-10 bg-neutral-800">
            {table.getHeaderGroups().map((g) => (
              <tr key={g.id}>
                <th className="px-2 py-1.5 text-right text-neutral-500 border-b border-white/10">#</th>
                {g.headers.map((h) => (
                  <th key={h.id} className="px-2 py-1.5 text-left font-semibold border-b border-l border-white/10 whitespace-nowrap cursor-pointer select-none" onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const r = all[vi.index]!;
              return (
                <tr key={r.id} className="absolute left-0 right-0 flex hover:bg-white/5" style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}>
                  <td className="px-2 py-1 text-right text-neutral-500 w-14 shrink-0 tabular-nums">{vi.index + 1}</td>
                  {r.getVisibleCells().map((c) => (
                    <td key={c.id} className="px-2 py-1 border-l border-white/5 whitespace-nowrap overflow-hidden text-ellipsis w-48 shrink-0" title={String(c.getValue())}>
                      {String(c.getValue())}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
