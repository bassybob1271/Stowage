import { lazy, Suspense, useEffect, useMemo, type ComponentType, Component, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import type { FileStat, MountInfo } from '@stowage/shared';
import { api, downloadUrl, fileUrl } from '../api';
import { formatBytes } from '../lib/format';
import { addRecent } from '../lib/places';
import { pickPreviewer, type PreviewProps, type PreviewerDef } from '../previewers/registry';
import { FileIcon } from './FileIcon';

const lazyCache = new Map<string, ComponentType<PreviewProps>>();
function component(def: PreviewerDef) {
  let c = lazyCache.get(def.id);
  if (!c) lazyCache.set(def.id, (c = lazy(def.load)));
  return c;
}

class Boundary extends Component<{ children: ReactNode; fallback: (e: Error) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function InfoCard({ file, mount, note }: { file: FileStat; mount: MountInfo; note?: string }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/5 p-6 text-center flex flex-col items-center gap-3 text-neutral-200">
        <FileIcon entry={file} size={56} />
        <div className="font-medium break-all">{file.name}</div>
        <dl className="text-sm text-neutral-400 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left">
          <dt>Size</dt><dd>{formatBytes(file.size)}</dd>
          <dt>Type</dt><dd className="break-all">{file.mime}</dd>
          <dt>Modified</dt><dd>{new Date(file.modifiedAt).toLocaleString()}</dd>
          {file.cid && (<><dt>CID</dt><dd className="break-all font-mono text-xs">{file.cid}</dd></>)}
          <dt>Mount</dt><dd>{mount.label}</dd>
        </dl>
        {note && <p className="text-sm text-amber-300">{note}</p>}
        <a className="btn btn-primary" href={downloadUrl(mount.id, file.path)} download>
          <Download size={16} /> Download
        </a>
      </div>
    </div>
  );
}

export function Previewer({
  mount, files, current, onNavigate, onClose, onSaved,
}: {
  mount: MountInfo;
  files: FileStat[];
  current: FileStat;
  onNavigate: (f: FileStat) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const index = files.findIndex((f) => f.path === current.path);
  const prev = index > 0 ? files[index - 1] : undefined;
  const next = index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;
  const def = pickPreviewer(current);
  const View = component(def);
  const tooLarge = def.maxSize != null && current.size > def.maxSize;
  const url = useMemo(() => fileUrl(mount.id, current.path), [mount.id, current.path]);

  useEffect(() => addRecent({ mount: mount.id, path: current.path, name: current.name, isDir: false }), [mount.id, current.path, current.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest('input,textarea,select,[contenteditable],.monaco-editor');
      if (e.key === 'Escape' && !t.closest('.monaco-editor')) {
        e.preventDefault();
        onClose();
      }
      if (typing || t.closest('video,audio,[data-keys]')) return;
      if (e.key === 'ArrowLeft' && prev) (e.preventDefault(), onNavigate(prev));
      if (e.key === 'ArrowRight' && next) (e.preventDefault(), onNavigate(next));
    };
    addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [prev, next, onNavigate, onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label={`Preview ${current.name}`} className="fixed inset-0 z-30 bg-neutral-950 text-neutral-100 flex flex-col">
      <header className="h-12 shrink-0 flex items-center gap-2 px-2 border-b border-white/10">
        <button className="btn btn-icon hover:!bg-white/10" aria-label="Close preview (Esc)" onClick={onClose}><X size={20} /></button>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium">{current.name}</div>
          <div className="text-[11px] text-neutral-400 tabular-nums">
            {index + 1} / {files.length} · {formatBytes(current.size)}
            {current.cid ? ` · ${current.cid.slice(0, 16)}…` : ''}
          </div>
        </div>
        <button className="btn btn-icon hover:!bg-white/10" aria-label="Open in new tab" title="Open in new tab" onClick={async () => window.open((await api.link(mount.id, current.path)).url, '_blank', 'noopener')}>
          <ExternalLink size={18} />
        </button>
        <a className="btn btn-icon hover:!bg-white/10" aria-label="Download" title="Download" href={downloadUrl(mount.id, current.path)} download><Download size={18} /></a>
      </header>
      <div className="flex-1 min-h-0 relative">
        {prev && (
          <button className="absolute left-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 hover:bg-black/70 p-2 hidden sm:block" aria-label="Previous file" onClick={() => onNavigate(prev)}>
            <ChevronLeft size={22} />
          </button>
        )}
        {next && (
          <button className="absolute right-2 top-1/2 -translate-y-1/2 z-10 rounded-full bg-black/50 hover:bg-black/70 p-2 hidden sm:block" aria-label="Next file" onClick={() => onNavigate(next)}>
            <ChevronRight size={22} />
          </button>
        )}
        {tooLarge ? (
          <InfoCard file={current} mount={mount} note="Too large to preview — download." />
        ) : (
          <Boundary key={current.path} fallback={(e) => <InfoCard file={current} mount={mount} note={`Couldn't preview: ${e.message}`} />}>
            <Suspense fallback={<div className="h-full grid place-items-center text-sm text-neutral-400">Loading viewer…</div>}>
              <View key={current.path} mount={mount} file={current} url={url} siblings={files} onSaved={onSaved} />
            </Suspense>
          </Boundary>
        )}
      </div>
    </div>
  );
}
