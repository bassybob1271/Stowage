import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, ChevronRight, Copy, ExternalLink, Film, Folder, ImagePlus, Link2, ListMusic, Music, Plus, Trash2, X,
} from 'lucide-react';
import { mimeFor, type FileStat } from '@stowage/shared';
import { api, type Playlist } from '../api';
import { confirmDialog, promptDialog, toast } from './Dialogs';

const VIDEO_OK = new Set(['video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime', 'video/ogg']);
/** Same rule as the server: any audio, plus video a browser can play. */
const playable = (path: string): 'audio' | 'video' | null => {
  const m = mimeFor(path);
  return m.startsWith('audio/') ? 'audio' : VIDEO_OK.has(m) ? 'video' : null;
};
const titleOf = (path: string) => {
  const n = path.split('/').pop() ?? path;
  const d = n.lastIndexOf('.');
  return d > 0 ? n.slice(0, d) : n;
};

/** Shrink a photo to at most 1200 px on the long side as JPEG, so covers upload fast and stay small. */
async function prepareCover(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (JPEG, PNG, WebP or HEIC).');
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error('That picture format can’t be read here. Try a JPEG or PNG.');
  });
  const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.86));
  if (!blob) throw new Error('Couldn’t prepare the picture.');
  return blob;
}

function Cover({ p, size = 'full' }: { p: Pick<Playlist, 'coverUrl' | 'title'>; size?: 'full' | 'thumb' }) {
  return p.coverUrl ? (
    <img src={p.coverUrl} alt="" className="w-full h-full object-cover" />
  ) : (
    <div className="w-full h-full grid place-items-center bg-gradient-to-br from-[#3a1420] to-[#15171c]">
      <ListMusic size={size === 'full' ? 48 : 28} className="text-[#ff3d5a] opacity-70" />
    </div>
  );
}

/** BazzyBox Playlist Maker: playlists of your audio and video, with a cover picture and a public link. */
export function PlaylistMaker({ mount, onClose }: { mount: string; onClose: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['playlists'], queryFn: api.box.playlists.list });

  const create = useMutation({
    mutationFn: (title: string) => api.box.playlists.create(title),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      setOpenId(p.id);
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  async function newPlaylist() {
    const title = await promptDialog({ title: 'New playlist', label: 'Name', value: '', confirm: 'Create' });
    if (title?.trim()) create.mutate(title.trim());
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 grid place-items-center p-2 sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Playlist Maker"
        className="w-full max-w-3xl h-full max-h-[min(860px,100%)] flex flex-col rounded-xl bg-panel border border-line shadow-2xl overflow-hidden"
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <header className="flex items-center gap-2 px-4 py-3 border-b border-line">
          {openId && (
            <button className="btn btn-icon" onClick={() => setOpenId(null)} aria-label="Back to playlists">
              <ArrowLeft size={18} />
            </button>
          )}
          <ListMusic size={18} className="text-[#ff3d5a]" />
          <h2 className="font-semibold flex-1">Playlist Maker</h2>
          {!openId && (
            <button className="btn btn-primary" onClick={() => void newPlaylist()} disabled={create.isPending}>
              <Plus size={16} /> New playlist
            </button>
          )}
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {openId ? (
            <Editor id={openId} mount={mount} onDeleted={() => setOpenId(null)} />
          ) : list.isPending ? (
            <p className="p-6 text-sm text-muted">Loading…</p>
          ) : list.isError ? (
            <p className="p-6 text-sm text-red-500">{(list.error as Error).message}</p>
          ) : list.data.playlists.length === 0 ? (
            <div className="p-10 text-center flex flex-col items-center gap-3">
              <ListMusic size={40} className="text-[#ff3d5a]" />
              <h3 className="text-lg font-semibold">Make your first playlist</h3>
              <p className="text-sm text-muted max-w-sm">
                Pick mixes, stems, demos or video from your BazzyBox, add a cover picture, and send one link. Anyone can listen without an account.
              </p>
              <button className="btn btn-primary mt-2" onClick={() => void newPlaylist()}>
                <Plus size={16} /> New playlist
              </button>
            </div>
          ) : (
            <ul className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-4">
              {list.data.playlists.map((p) => (
                <li key={p.id}>
                  <button className="w-full text-left group" onClick={() => setOpenId(p.id)}>
                    <div className="aspect-square rounded-lg overflow-hidden border border-line group-hover:border-[#ff3d5a] transition-colors">
                      <Cover p={p} />
                    </div>
                    <div className="mt-2 font-semibold truncate">{p.title}</div>
                    <div className="text-xs text-muted flex items-center gap-1.5">
                      {p.tracks.length} {p.tracks.length === 1 ? 'track' : 'tracks'}
                      {p.shareUrl && (
                        <span className="inline-flex items-center gap-1 text-[#ff3d5a]">
                          · <Link2 size={12} /> Shared
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Editor({ id, mount, onDeleted }: { id: string; mount: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['playlist', id], queryFn: () => api.box.playlists.get(id) });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [busyCover, setBusyCover] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);

  const p = q.data;
  // Fill the form once, when this playlist first loads. Later server updates (cover, share link)
  // must not overwrite name, description or track edits that haven't been saved yet.
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!p || loaded.current === p.id) return;
    loaded.current = p.id;
    setTitle(p.title);
    setDescription(p.description);
    setItems(p.tracks.map((t) => t.path));
  }, [p]);

  const dirty = !!p && (title !== p.title || description !== p.description || items.join('\n') !== p.tracks.map((t) => t.path).join('\n'));
  const fresh = (np: Playlist) => {
    qc.setQueryData(['playlist', id], np);
    void qc.invalidateQueries({ queryKey: ['playlists'] });
  };

  const save = useMutation({
    mutationFn: () => api.box.playlists.update(id, { title: title.trim(), description, items }),
    onSuccess: (np) => {
      fresh(np);
      toast('Playlist saved.');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const share = useMutation({
    mutationFn: async () => {
      if (dirty) fresh(await api.box.playlists.update(id, { title: title.trim(), description, items }));
      return api.box.playlists.share(id);
    },
    onSuccess: () => void q.refetch().then(() => qc.invalidateQueries({ queryKey: ['playlists'] })),
    onError: (e) => toast((e as Error).message, 'error'),
  });

  async function stopSharing() {
    const ok = await confirmDialog({ title: 'Stop sharing?', message: 'The current link stops working right away. You can make a new link later.', confirm: 'Stop sharing', danger: true });
    if (!ok) return;
    await api.box.playlists.unshare(id).catch((e) => toast((e as Error).message, 'error'));
    void q.refetch();
    void qc.invalidateQueries({ queryKey: ['playlists'] });
  }

  async function remove() {
    const ok = await confirmDialog({ title: 'Delete playlist?', message: 'The playlist and its share link go away. Your files stay in BazzyBox.', confirm: 'Delete', danger: true });
    if (!ok) return;
    await api.box.playlists.remove(id);
    void qc.invalidateQueries({ queryKey: ['playlists'] });
    onDeleted();
  }

  async function onCover(file: File | undefined) {
    if (!file) return;
    setBusyCover(true);
    try {
      fresh(await api.box.playlists.setCover(id, await prepareCover(file)));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusyCover(false);
      if (coverInput.current) coverInput.current.value = '';
    }
  }

  const move = (i: number, d: -1 | 1) =>
    setItems((xs) => {
      const j = i + d;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied.');
    } catch {
      toast('Copy didn’t work here. Select the link and copy it.', 'error');
    }
  }

  if (q.isPending) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (q.isError || !p) return <p className="p-6 text-sm text-red-500">{(q.error as Error)?.message ?? 'Not found'}</p>;
  if (picking)
    return (
      <Picker
        mount={mount}
        already={new Set(items)}
        onCancel={() => setPicking(false)}
        onAdd={(paths) => {
          setItems((xs) => [...xs, ...paths.filter((x) => !xs.includes(x))]);
          setPicking(false);
        }}
      />
    );

  return (
    <div className="p-4 flex flex-col gap-6 text-sm">
      <section className="grid grid-cols-1 sm:grid-cols-[200px_minmax(0,1fr)] gap-5">
        <div>
          <button
            className="relative w-full aspect-square rounded-lg overflow-hidden border border-line hover:border-[#ff3d5a] transition-colors group"
            onClick={() => coverInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onCover(e.dataTransfer.files[0]);
            }}
            aria-label={p.coverUrl ? 'Change cover picture' : 'Add a cover picture'}
          >
            <Cover p={p} />
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 py-2 bg-black/60 text-white text-xs font-semibold opacity-90 group-hover:opacity-100">
              <ImagePlus size={14} /> {busyCover ? 'Uploading…' : p.coverUrl ? 'Change picture' : 'Add picture'}
            </span>
          </button>
          {p.coverUrl && (
            <button className="text-xs text-muted underline mt-2" onClick={() => void api.box.playlists.removeCover(id).then(fresh)}>
              Remove picture
            </button>
          )}
          <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => void onCover(e.currentTarget.files?.[0])} />
        </div>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-muted">Name</span>
            <input id="pl-title" className="input text-base font-semibold" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Description (optional)</span>
            <textarea id="pl-desc" className="input min-h-[84px]" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Rough mixes for the label, final cut for the client…" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!dirty || !title.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : dirty ? 'Save changes' : <><Check size={16} /> Saved</>}
            </button>
            <button className="btn" onClick={() => setPicking(true)}>
              <Plus size={16} /> Add tracks
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-line p-3 flex flex-col gap-2" aria-label="Share link">
        <div className="flex items-center gap-2">
          <Link2 size={16} className="text-[#ff3d5a]" />
          <h3 className="font-semibold flex-1">Share link</h3>
          {p.shareUrl && <span className="text-xs text-muted">{p.views} {p.views === 1 ? 'view' : 'views'}</span>}
        </div>
        {p.shareUrl ? (
          <>
            <div className="flex gap-2">
              <input className="input flex-1 text-xs" readOnly value={p.shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <button className="btn" onClick={() => void copy(p.shareUrl!)}>
                <Copy size={16} /> Copy
              </button>
              <a className="btn btn-icon" href={p.shareUrl} target="_blank" rel="noreferrer" aria-label="Open the shared page">
                <ExternalLink size={16} />
              </a>
            </div>
            <p className="text-xs text-muted">
              Anyone with the link can listen. Plays count toward your monthly share-link allowance.{' '}
              <button className="underline" onClick={() => void stopSharing()}>Stop sharing</button>
            </p>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={!items.length || share.isPending} onClick={() => share.mutate()}>
              {share.isPending ? 'Creating…' : 'Create share link'}
            </button>
            <span className="text-xs text-muted">{items.length ? 'One link with the cover, track list and a player.' : 'Add tracks first.'}</span>
          </div>
        )}
      </section>

      <section aria-label="Tracks">
        <h3 className="font-semibold mb-2">
          {items.length} {items.length === 1 ? 'track' : 'tracks'}
          {dirty && <span className="text-xs font-normal text-muted"> · unsaved changes</span>}
        </h3>
        {items.length === 0 ? (
          <button className="w-full rounded-lg border border-dashed border-line p-6 text-muted hover:border-[#ff3d5a]" onClick={() => setPicking(true)}>
            <Plus size={16} className="inline -mt-0.5" /> Add tracks from your BazzyBox
          </button>
        ) : (
          <ol className="flex flex-col">
            {items.map((path, i) => (
              <li key={path} className="flex items-center gap-2 py-1.5 border-b border-line/60">
                <span className="w-6 text-right text-muted tabular-nums">{i + 1}</span>
                {playable(path) === 'video' ? <Film size={14} className="text-muted shrink-0" /> : <Music size={14} className="text-muted shrink-0" />}
                <span className="flex-1 truncate" title={path}>{titleOf(path)}</span>
                <button className="btn btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button className="btn btn-icon" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                <button className="btn btn-icon" aria-label="Remove from playlist" onClick={() => setItems((xs) => xs.filter((x) => x !== path))}><X size={14} /></button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <button className="self-start text-xs text-red-500 inline-flex items-center gap-1" onClick={() => void remove()}>
        <Trash2 size={14} /> Delete playlist
      </button>
    </div>
  );
}

/** Browse your BazzyBox and tick audio/video files to add. */
function Picker({ mount, already, onAdd, onCancel }: { mount: string; already: Set<string>; onAdd: (paths: string[]) => void; onCancel: () => void }) {
  const [path, setPath] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const q = useQuery({ queryKey: ['list-all', mount, path], queryFn: () => api.listAll(mount, path) });
  const entries = (q.data ?? [])
    .filter((f: FileStat) => f.isDir || playable(f.path))
    .sort((a: FileStat, b: FileStat) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files = entries.filter((f) => !f.isDir && !already.has(f.path));
  const crumbs = path ? path.split('/') : [];
  const toggle = (p: string) => setChosen((xs) => (xs.includes(p) ? xs.filter((x) => x !== p) : [...xs, p]));

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="px-4 py-2 border-b border-line flex items-center gap-1 flex-wrap">
        <button className="underline" onClick={() => setPath('')}>My files</button>
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <ChevronRight size={14} className="text-muted" />
            <button className="underline" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
          </span>
        ))}
        {files.length > 0 && (
          <button className="ml-auto text-xs underline" onClick={() => setChosen((xs) => [...new Set([...xs, ...files.map((f) => f.path)])])}>
            Select all here
          </button>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto">
        {q.isPending && <li className="p-4 text-muted">Loading…</li>}
        {q.isError && <li className="p-4 text-red-500">{(q.error as Error).message}</li>}
        {q.data && entries.length === 0 && <li className="p-4 text-muted">No audio, video or folders here.</li>}
        {entries.map((f) =>
          f.isDir ? (
            <li key={f.path}>
              <button className="w-full flex items-center gap-2 px-4 py-2 hover:bg-app text-left" onClick={() => setPath(f.path)}>
                <Folder size={16} className="text-muted" /> <span className="flex-1 truncate">{f.name}</span> <ChevronRight size={14} className="text-muted" />
              </button>
            </li>
          ) : (
            <li key={f.path}>
              <label className={`flex items-center gap-2 px-4 py-2 hover:bg-app ${already.has(f.path) ? 'opacity-50' : 'cursor-pointer'}`}>
                <input type="checkbox" className="w-4 h-4 accent-[#ff3d5a]" disabled={already.has(f.path)} checked={already.has(f.path) || chosen.includes(f.path)} onChange={() => toggle(f.path)} />
                {playable(f.path) === 'video' ? <Film size={16} className="text-muted" /> : <Music size={16} className="text-muted" />}
                <span className="flex-1 truncate">{f.name}</span>
                {already.has(f.path) && <span className="text-xs text-muted">In playlist</span>}
              </label>
            </li>
          ),
        )}
      </ul>
      <div className="px-4 py-3 border-t border-line flex items-center gap-2">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary ml-auto" disabled={!chosen.length} onClick={() => onAdd(chosen)}>
          Add {chosen.length || ''} {chosen.length === 1 ? 'track' : 'tracks'}
        </button>
      </div>
    </div>
  );
}
