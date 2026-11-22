import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Menu, Search, Settings as SettingsIcon, Upload, X, Star, Clock, HardDrive, FolderUp } from 'lucide-react';
import type { MountInfo } from '@stowage/shared';
import { api } from '../api';
import { href, navigate, useLocation } from '../lib/router';
import { useStore } from '../lib/store';
import { recentStore, starredStore } from '../lib/places';
import { enqueue, onUploadDone } from '../uploads';
import { FileBrowser } from './FileBrowser';
import { UploadTray } from './UploadTray';
import { MiniPlayer } from './MiniPlayer';
import { DialogHost } from './Dialogs';
import { Settings } from './Settings';

export function Shell() {
  const loc = useLocation();
  const qc = useQueryClient();
  const mounts = useQuery({ queryKey: ['mounts'], queryFn: () => api.mounts(), refetchInterval: 60_000 });
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const list = mounts.data?.mounts ?? [];
  const current = list.find((m) => m.id === loc.mount);

  // Default route: first mount.
  useEffect(() => {
    if (!loc.mount && list[0]) navigate(href(list[0].id), true);
  }, [loc.mount, list]);

  useEffect(() => setFilter(''), [loc.mount, loc.path]);
  useEffect(() => setDrawer(false), [loc.mount, loc.path]);

  useEffect(
    () =>
      onUploadDone((u) => {
        void qc.invalidateQueries({ queryKey: ['list', u.mount] });
      }),
    [qc],
  );

  const pick = (input: HTMLInputElement | null) => {
    if (!input?.files?.length || !loc.mount) return;
    const files = [...input.files].map((f) => ({ file: f, relPath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }));
    enqueue(files, loc.mount, loc.path);
    input.value = '';
  };

  async function logout() {
    await api.logout().catch(() => {});
    qc.clear();
    qc.setQueryData(['session'], { authenticated: false });
    history.replaceState(null, '', '/');
  }

  const writable = current && !current.readOnly;

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 shrink-0 flex items-center gap-2 px-3 border-b border-line bg-app">
        <button className="btn btn-icon md:hidden" aria-label="Open sidebar" onClick={() => setDrawer(true)}>
          <Menu size={20} />
        </button>
        <a href="/" onClick={(e) => (e.preventDefault(), list[0] && navigate(href(list[0].id)))} className="flex items-center gap-2 font-semibold tracking-tight mr-2">
          <img src="/favicon.svg" alt="" className="w-6 h-6" />
          <span className="hidden sm:inline">Stowage</span>
        </a>
        <div className="flex-1 max-w-xl relative">
          <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input w-full pl-8"
            placeholder={current ? `Filter ${loc.path ? loc.path.split('/').pop() : current.label}` : 'Filter'}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            aria-label="Filter current folder"
          />
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <button className="btn btn-primary" disabled={!writable} onClick={() => fileInput.current?.click()} title={writable ? 'Upload files' : 'Mount is read-only'}>
            <Upload size={16} />
            <span className="hidden sm:inline">Upload</span>
          </button>
          <button className="btn btn-icon hidden sm:inline-flex" disabled={!writable} onClick={() => folderInput.current?.click()} title="Upload folder" aria-label="Upload folder">
            <FolderUp size={18} />
          </button>
          <button className="btn btn-icon" onClick={() => setSettings(true)} title="Mounts & settings" aria-label="Settings">
            <SettingsIcon size={18} />
          </button>
          <button className="btn btn-icon" onClick={logout} title="Log out" aria-label="Log out">
            <LogOut size={18} />
          </button>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => pick(e.currentTarget)} />
        <input ref={folderInput} type="file" hidden onChange={(e) => pick(e.currentTarget)} {...{ webkitdirectory: '', directory: '' }} />
      </header>

      <div className="flex-1 flex min-h-0">
        {drawer && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)} />}
        <aside
          className={`${drawer ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 fixed md:static z-40 inset-y-0 left-0 w-64 md:w-56 shrink-0 bg-panel border-r border-line flex flex-col transition-transform`}
        >
          <div className="md:hidden flex justify-end p-2">
            <button className="btn btn-icon" onClick={() => setDrawer(false)} aria-label="Close sidebar">
              <X size={18} />
            </button>
          </div>
          <Sidebar mounts={list} loading={mounts.isPending} active={loc.mount} />
        </aside>

        <main className="flex-1 min-w-0 flex flex-col">
          {mounts.isError && <div className="p-6 text-sm text-red-500">Couldn't load mounts: {(mounts.error as Error).message}</div>}
          {!mounts.isPending && list.length === 0 && (
            <div className="p-8 text-center text-muted text-sm">
              No mounts configured. Add one in <button className="underline" onClick={() => setSettings(true)}>Settings</button> or in <code>mounts.yaml</code>.
            </div>
          )}
          {current && <FileBrowser key={current.id} mount={current} path={loc.path} open={loc.open} filter={filter} />}
          {loc.mount && !current && !mounts.isPending && <div className="p-8 text-sm text-muted">Unknown mount “{loc.mount}”.</div>}
        </main>
      </div>

      <MiniPlayer />
      <UploadTray />
      <DialogHost />
      {settings && <Settings mounts={list} onClose={() => setSettings(false)} />}
    </div>
  );
}

function Sidebar({ mounts, loading, active }: { mounts: MountInfo[]; loading: boolean; active: string | null }) {
  const recent = useStore(recentStore);
  const starred = useStore(starredStore);
  const go = (mount: string, path: string, isDir: boolean, name: string) => {
    if (isDir) navigate(href(mount, path));
    else navigate(href(mount, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', name));
  };
  return (
    <nav className="flex-1 overflow-y-auto p-2 text-sm flex flex-col gap-4" aria-label="Sidebar">
      <section>
        <h3 className="px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Mounts</h3>
        {loading && <div className="px-2 text-muted">Loading…</div>}
        {mounts.map((m) => (
          <a
            key={m.id}
            href={href(m.id)}
            onClick={(e) => (e.preventDefault(), navigate(href(m.id)))}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${active === m.id ? 'bg-sel font-medium' : 'hover-row'}`}
            title={`${m.kind}${m.health.detail ? ' — ' + m.health.detail : ''}`}
          >
            <HardDrive size={15} className="shrink-0 text-muted" />
            <span className="truncate flex-1">{m.label}</span>
            {m.readOnly && <span className="text-[10px] uppercase text-muted">ro</span>}
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${m.health.ok ? 'bg-emerald-500' : 'bg-red-500'}`}
              aria-label={m.health.ok ? 'healthy' : `unhealthy: ${m.health.detail ?? ''}`}
            />
          </a>
        ))}
      </section>
      {starred.length > 0 && (
        <section>
          <h3 className="px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-muted flex items-center gap-1"><Star size={12} /> Starred</h3>
          {starred.map((p) => (
            <button key={p.mount + p.path} className="w-full text-left flex items-center gap-2 px-2 py-1 rounded-md hover-row truncate" onClick={() => go(p.mount, p.path, p.isDir, p.name)} title={`${p.mount}/${p.path}`}>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h3 className="px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-muted flex items-center gap-1"><Clock size={12} /> Recent</h3>
          {recent.slice(0, 10).map((p) => (
            <button key={p.mount + p.path} className="w-full text-left flex items-center gap-2 px-2 py-1 rounded-md hover-row" onClick={() => go(p.mount, p.path, p.isDir, p.name)} title={`${p.mount}/${p.path}`}>
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </section>
      )}
    </nav>
  );
}
