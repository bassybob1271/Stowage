import { File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileSpreadsheet, FileText, FileVideo, Folder, Type, Box } from 'lucide-react';
import type { FileStat } from '@stowage/shared';
import { ext } from '../lib/format';

const CODE = new Set(['js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'ini']);

export function FileIcon({ entry, size = 18 }: { entry: Pick<FileStat, 'name' | 'isDir' | 'mime'>; size?: number }) {
  const p = { size, className: 'shrink-0', 'aria-hidden': true } as const;
  if (entry.isDir) return <Folder {...p} className="shrink-0 text-sky-500 fill-sky-500/20" />;
  const e = ext(entry.name);
  const m = entry.mime;
  if (m.startsWith('image/')) return <FileImage {...p} className="shrink-0 text-pink-500" />;
  if (m.startsWith('video/') || e === 'm3u8') return <FileVideo {...p} className="shrink-0 text-violet-500" />;
  if (m.startsWith('audio/')) return <FileAudio {...p} className="shrink-0 text-orange-500" />;
  if (e === 'pdf') return <FileText {...p} className="shrink-0 text-red-500" />;
  if (e === 'json') return <FileJson {...p} className="shrink-0 text-yellow-600" />;
  if (e === 'csv' || e === 'tsv' || e === 'xlsx') return <FileSpreadsheet {...p} className="shrink-0 text-emerald-600" />;
  if (['zip', 'gz', 'tar', '7z'].includes(e)) return <FileArchive {...p} className="shrink-0 text-amber-600" />;
  if (['ttf', 'otf', 'woff', 'woff2'].includes(e)) return <Type {...p} className="shrink-0 text-teal-600" />;
  if (['glb', 'gltf', 'stl', 'obj'].includes(e)) return <Box {...p} className="shrink-0 text-indigo-500" />;
  if (CODE.has(e)) return <FileCode {...p} className="shrink-0 text-blue-500" />;
  if (m.startsWith('text/') || e === 'md') return <FileText {...p} className="shrink-0 text-slate-500" />;
  return <File {...p} className="shrink-0 text-slate-400" />;
}
