import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as RME } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, ChevronRight, Download, FolderPlus, LayoutGrid, List, Trash2, MoveRight, Pencil, Link2, Hash, Star,
  ExternalLink, RefreshCw, Share2, MessageSquare, ListMusic } from 'lucide-react';
import type { FileStat, MountInfo } from '@stowage/shared';
import { api, downloadUrl, thumbUrl, zipUrl, ApiError } from '../api';
import { href, navigate } from '../lib/router';
import { formatBytes, formatDate, typeLabel } from '../lib/format';
import { local, useStore } from '../lib/store';
import { addRecent, forgetPlace, isStarred, starredStore, toggleStar } from '../lib/places';
import { enqueue } from '../uploads';
import { confirmDialog, promptDialog, toast } from './Dialogs';
import { FileIcon } from './FileIcon';
import { Previewer } from './Previewer';

type SortKey = 'name' | 'size' | 'modifiedAt' | 'type';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}

/** Recursively read dropped files and folders (webkitGetAsEntry). */
async function collectDropped(items: DataTransferItemList): Promise<{ file: File; relPath: string }[]> {
  const out: { file: File; relPath: string }[] = [];
  const readAll = (r: FileSystemDirectoryReader) =>
    new Promise<FileSystemEntry[]>((res, rej) => {
      const acc: FileSystemEntry[] = [];
      const next = () => r.readEntries((b) => (b.length ? (acc.push(...b), next()) : res(acc)), rej);
      next();
    });
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, relPath: prefix + f.name });
    } else if (e.isDirectory) {
      for (const c of await readAll((e as FileSystemDirectoryEntry).createReader())) await walk(c, `${prefix}${e.name}/`);
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return out;
  for (const e of entries) await walk(e, '');
  return out;
}

/** Marks a drag that started inside the file list (a move, not an upload). */
const DRAG_TYPE = 'application/x-bazzybox-paths';

export function FileBrowser({ mount, path, open, filter }: { mount: MountInfo; path: string; open: string | null; filter: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['list', mount.id, path], queryFn: () => api.listAll(mount.id, path) });
  const [view, setView] = useState<'list' | 'grid'>(() => local.get('view', 'list'));
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(() => local.get('sort', { key: 'name', dir: 1 }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number>(-1);
  const [focus, setFocus] = useState<number>(-1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Drag-to-select box, in the pane's scrolled content coordinates. */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeEnd = useRef(0);
  /** A click right after a drag-select is the mouseup of that drag, not a click. */
  const marqueeJustEnded = () => Date.now() - marqueeEnd.current < 250;
  /** Paths being dragged inside the app (dataTransfer can't be read during dragover). */
  const dragging = useRef<string[]>([]);
  /** BazzyBox member's own mount (playlists, share and review links). */
  const isBox = /^box-[0-9a-f]{16}$/.test(mount.id);
  /** Folder (path; '' = mount root) that something is being dragged over. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const starred = useStore(starredStore);
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => local.set('view', view), [view]);
  useEffect(() => local.set('sort', sort), [sort]);
  useEffect(() => {
    setSelected(new Set());
    setFocus(-1);
    setAnchor(-1);
    pane.current?.focus({ preventScroll: true });
  }, [path]);

  const entries = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = (q.data ?? []).filter((e) => !f || e.name.toLowerCase().includes(f));
    const cmp = (a: FileStat, b: FileStat) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (sort.key === 'name') r = collator.compare(a.name, b.name);
      else if (sort.key === 'size') r = a.size - b.size;
      else if (sort.key === 'modifiedAt') r = a.modifiedAt.localeCompare(b.modifiedAt);
      else r = collator.compare(typeLabel(a.name, a.isDir, a.mime), typeLabel(b.name, b.isDir, b.mime));
      return (r || collator.compare(a.name, b.name)) * sort.dir;
    };
    return list.sort(cmp);
  }, [q.data, filter, sort]);

  const sel = entries.filter((e) => selected.has(e.path));
  const refresh = () => qc.invalidateQueries({ queryKey: ['list', mount.id] });
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  const openEntry = useCallback(
    (e: FileStat) => {
      addRecent({ mount: mount.id, path: e.path, name: e.name, isDir: e.isDir });
      if (e.isDir) navigate(href(mount.id, e.path));
      else navigate(href(mount.id, path, e.name));
    },
    [mount.id, path],
  );

  // ---------- actions ----------
  const act = {
    async newFolder() {
      const name = await promptDialog({ title: 'New folder', value: 'Untitled folder', confirm: 'Create' });
      if (!name) return;
      try {
        await api.mkdir(mount.id, path ? `${path}/${name}` : name);
        await refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    },
    async rename(e: FileStat) {
      const name = await promptDialog({ title: 'Rename', value: e.name, confirm: 'Rename', selectStem: !e.isDir });
      if (!name || name === e.name) return;
      if (name.includes('/')) return toast('Names cannot contain “/”', 'error');
      try {
        await api.move(mount.id, e.path, parentOf(e.path) ? `${parentOf(e.path)}/${name}` : name);
        forgetPlace(mount.id, e.path);
        await refresh();
      } catch (err) {
        toast(err instanceof ApiError && err.status === 409 ? 'Something with that name already exists' : (err as Error).message, 'error');
      }
    },
    async move(items: FileStat[]) {
      const dest = await promptDialog({ title: `Move ${items.length} item${items.length > 1 ? 's' : ''}`, label: `Destination folder in ${mount.label} (blank = root)`, value: path, confirm: 'Move' });
      if (dest == null) return;
      const d = dest.replace(/^\/+|\/+$/g, '');
      try {
        for (const e of items) {
          await api.move(mount.id, e.path, d ? `${d}/${e.name}` : e.name);
          forgetPlace(mount.id, e.path);
        }
        setSelected(new Set());
        await refresh();
        toast(`Moved to /${d}`);
      } catch (err) {
        toast((err as Error).message, 'error');
        await refresh();
      }
    },
    /** Drag-and-drop move: put these paths inside `dest` ('' = top of the mount). */
    async moveInto(paths: string[], dest: string) {
      const items = paths.filter((p) => canDropInto([p], dest));
      if (!items.length) return;
      let moved = 0;
      const clashes: string[] = [];
      for (const from of items) {
        const name = from.split('/').pop()!;
        try {
          await api.move(mount.id, from, dest ? `${dest}/${name}` : name);
          forgetPlace(mount.id, from);
          moved++;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) clashes.push(name);
          else toast((err as Error).message, 'error');
        }
      }
      setSelected(new Set());
      await refresh();
      const where = dest ? `“${dest.split('/').pop()}”` : mount.label;
      if (moved) toast(`Moved ${moved === 1 ? `“${items[0]!.split('/').pop()}”` : `${moved} items`} to ${where}`);
      if (clashes.length) toast(`${where} already has ${clashes.length === 1 ? `“${clashes[0]}”` : `${clashes.length} items with those names`}; left in place`, 'error');
    },
    /** BazzyBox: a playlist from the selected songs and videos (and those directly inside selected folders), in the order shown. */
    async makePlaylist(items: FileStat[]) {
      const playable = (f: FileStat) => !f.isDir && /^(audio\/|video\/(mp4|x-m4v|webm|quicktime|ogg)$)/.test(f.mime);
      const tracks: string[] = [];
      try {
        for (const e of items) {
          if (playable(e)) tracks.push(e.path);
          else if (e.isDir) for (const c of (await api.listAll(mount.id, e.path)).sort((a, b) => collator.compare(a.name, b.name))) if (playable(c)) tracks.push(c.path);
        }
      } catch (err) {
        return toast((err as Error).message, 'error');
      }
      if (!tracks.length) return toast('Select songs or videos (or folders with some in them) to make a playlist.', 'error');
      const list = [...new Set(tracks)].slice(0, 200);
      const folder = items.length === 1 && items[0]!.isDir ? items[0]!.name : path.split('/').pop() || 'New playlist';
      const title = await promptDialog({ title: `Make a playlist of ${list.length} track${list.length > 1 ? 's' : ''}`, label: 'Name', value: folder, confirm: 'Make playlist' });
      if (!title?.trim()) return;
      try {
        const p = await api.box.playlists.create(title.trim(), list);
        setSelected(new Set());
        if (tracks.length > list.length) toast(`Playlists hold up to 200 tracks; the first 200 are in.`);
        dispatchEvent(new CustomEvent('bazzybox:open-playlist', { detail: p.id }));
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    },
    async remove(items: FileStat[]) {
      if (!items.length) return;
      const ok = await confirmDialog({
        title: `Delete ${items.length === 1 ? `“${items[0]!.name}”` : `${items.length} items`}?`,
        message: items.some((e) => e.isDir) ? 'Folders are deleted with everything inside them. This cannot be undone.' : 'This cannot be undone.',
        confirm: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        for (const e of items) {
          await api.remove(mount.id, e.path);
          forgetPlace(mount.id, e.path);
        }
        setSelected(new Set());
        await refresh();
      } catch (err) {
        toast((err as Error).message, 'error');
        await refresh();
      }
    },
    download(items: FileStat[]) {
      if (items.length === 1 && !items[0]!.isDir) download(downloadUrl(mount.id, items[0]!.path));
      else if (items.length) download(zipUrl(mount.id, items.map((e) => e.path)));
    },
    async copyLink(e: FileStat) {
      const u = e.isDir ? location.origin + href(mount.id, e.path) : location.origin + href(mount.id, path, e.name);
      await navigator.clipboard.writeText(u).then(() => toast('Link copied'), () => toast(u));
    },
    /** BazzyBox: a public link anyone can download, metered against the owner's send allowance. */
    async shareLink(e: FileStat) {
      try {
        const { url, expiresAt } = await api.box.share(e.path, 7);
        const full = location.origin + url;
        await navigator.clipboard.writeText(full).then(
          () => toast(`Share link copied. It works until ${new Date(expiresAt).toLocaleDateString()}.`),
          () => toast(full),
        );
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    },
    /** BazzyBox: a link where anyone can play the file and leave timed comments. */
    async reviewLink(e: FileStat) {
      try {
        const { url, expiresAt } = await api.box.review(e.path, 14);
        const full = location.origin + url;
        await navigator.clipboard.writeText(full).then(
          () => toast(`Review link copied. Anyone with it can play and comment until ${new Date(expiresAt).toLocaleDateString()}.`),
          () => toast(full),
        );
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    },
    async openNewTab(e: FileStat) {
      const { url } = await api.link(mount.id, e.path);
      window.open(url, '_blank', 'noopener');
    },
    async showCid(e: FileStat) {
      if (!e.cid) return;
      await navigator.clipboard.writeText(e.cid).catch(() => {});
      toast(`CID ${e.cid} (copied)`);
    },
  };

  // ---------- selection ----------
  function clickRow(ev: RME, i: number) {
    const e = entries[i]!;
    setFocus(i);
    if (ev.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      const next = new Set(ev.metaKey || ev.ctrlKey ? selected : []);
      for (let k = a; k <= b; k++) next.add(entries[k]!.path);
      setSelected(next);
    } else if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      next.has(e.path) ? next.delete(e.path) : next.add(e.path);
      setSelected(next);
      setAnchor(i);
    } else {
      setSelected(new Set([e.path]));
      setAnchor(i);
    }
  }
  function toggleCheck(i: number) {
    const e = entries[i]!;
    const next = new Set(selected);
    next.has(e.path) ? next.delete(e.path) : next.add(e.path);
    setSelected(next);
    setAnchor(i);
    setFocus(i);
  }

  // New folder: ⌘N / Ctrl+N where the browser lets a page have it, plus ⇧N and ⌥⌘N, which always work.
  const newFolderRef = useRef(act.newFolder);
  newFolderRef.current = act.newFolder;
  useEffect(() => {
    if (mount.readOnly || open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'KeyN' || e.repeat) return;
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable],[role=dialog]')) return;
      const cmd = e.metaKey || e.ctrlKey;
      const shiftOnly = e.shiftKey && !cmd && !e.altKey;
      const cmdN = cmd && !e.shiftKey; // ⌘N or ⌥⌘N
      if (!shiftOnly && !cmdN) return;
      e.preventDefault();
      void newFolderRef.current();
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, [mount.readOnly, open]);

  // ---------- keyboard ----------
  function onKey(ev: React.KeyboardEvent) {
    if ((ev.target as HTMLElement).closest('input,textarea,[contenteditable]')) return;
    const n = entries.length;
    const cols = view === 'grid' ? Math.max(1, Math.floor((pane.current?.clientWidth ?? 800) / 168)) : 1;
    const moveTo = (i: number) => {
      const k = Math.max(0, Math.min(n - 1, i));
      setFocus(k);
      if (ev.shiftKey && anchor >= 0) {
        const s = new Set<string>();
        for (let j = Math.min(anchor, k); j <= Math.max(anchor, k); j++) s.add(entries[j]!.path);
        setSelected(s);
      } else {
        setSelected(new Set([entries[k]!.path]));
        setAnchor(k);
      }
      document.getElementById(`row-${k}`)?.scrollIntoView({ block: 'nearest' });
    };
    const cur = focus >= 0 ? entries[focus] : undefined;
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); moveTo(focus + cols); break;
      case 'ArrowUp': ev.preventDefault(); moveTo(focus < 0 ? n - 1 : focus - cols); break;
      case 'ArrowRight': if (view === 'grid') { ev.preventDefault(); moveTo(focus + 1); } break;
      case 'ArrowLeft': if (view === 'grid') { ev.preventDefault(); moveTo(focus - 1); } break;
      case 'Home': ev.preventDefault(); moveTo(0); break;
      case 'End': ev.preventDefault(); moveTo(n - 1); break;
      case 'Enter': if (cur) { ev.preventDefault(); openEntry(cur); } break;
      case ' ': if (cur && !cur.isDir) { ev.preventDefault(); openEntry(cur); } break;
      case 'Backspace':
        if (ev.metaKey) { ev.preventDefault(); if (!mount.readOnly) void act.remove(sel); }
        else if (path) { ev.preventDefault(); navigate(href(mount.id, parentOf(path))); }
        break;
      case 'Delete': if (sel.length && !mount.readOnly) { ev.preventDefault(); void act.remove(sel); } break;
      case 'F2': if (cur && !mount.readOnly) { ev.preventDefault(); void act.rename(cur); } break;
      case 'Escape': setSelected(new Set()); setMenu(null); break;
      case 'a': case 'A':
        if (ev.metaKey || ev.ctrlKey) { ev.preventDefault(); setSelected(new Set(entries.map((e) => e.path))); }
        break;
    }
  }

  // ---------- drag to select ----------
  function startMarquee(ev: RME<HTMLDivElement>) {
    if (ev.button !== 0) return;
    const t = ev.target as HTMLElement;
    // Names and tiles move things; checkboxes, buttons, links and the column headers do their own thing.
    if (t.closest('[data-drag-handle],input,button,a,select,thead,[role=dialog]')) return;
    const el = pane.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (ev.clientX > box.left + el.clientWidth) return; // the scrollbar
    const add = ev.metaKey || ev.ctrlKey || ev.shiftKey;
    const base = add ? new Set(selected) : new Set<string>();
    const start = { x: ev.clientX - box.left + el.scrollLeft, y: ev.clientY - box.top + el.scrollTop };
    let last = { x: ev.clientX, y: ev.clientY };
    let active = false;
    let raf = 0;
    const update = () => {
      const b = el.getBoundingClientRect();
      const cur = { x: last.x - b.left + el.scrollLeft, y: last.y - b.top + el.scrollTop };
      if (!active && Math.hypot(cur.x - start.x, cur.y - start.y) < 5) return;
      if (!active) {
        active = true;
        el.focus({ preventScroll: true });
        window.getSelection()?.removeAllRanges();
      }
      setMarquee({ x0: start.x, y0: start.y, x1: cur.x, y1: cur.y });
      // Which rows/tiles the box touches, in screen coordinates.
      const sx = start.x - el.scrollLeft + b.left, sy = start.y - el.scrollTop + b.top;
      const L = Math.min(sx, last.x), R = Math.max(sx, last.x), T = Math.min(sy, last.y), B = Math.max(sy, last.y);
      const next = new Set(base);
      entries.forEach((e, i) => {
        const r = document.getElementById(`row-${i}`)?.getBoundingClientRect();
        if (r && r.right >= L && r.left <= R && r.bottom >= T && r.top <= B) next.add(e.path);
      });
      setSelected(next);
    };
    // Keep scrolling while the pointer sits past the top or bottom edge.
    const tick = () => {
      const b = el.getBoundingClientRect();
      const dy = last.y < b.top + 24 ? -14 : last.y > b.bottom - 24 ? 14 : 0;
      if (active && dy) {
        el.scrollTop += dy;
        update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (e: MouseEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (active) e.preventDefault();
      update();
    };
    const up = () => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      cancelAnimationFrame(raf);
      if (active) marqueeEnd.current = Date.now();
      setMarquee(null);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    raf = requestAnimationFrame(tick);
  }

  // ---------- drag & drop ----------
  /** A folder can take these items unless it is one of them, inside one of them, or already their parent. */
  function canDropInto(paths: string[], dest: string) {
    return paths.some((p) => p !== dest && !dest.startsWith(p + '/') && parentOf(p) !== dest);
  }
  function startDrag(ev: DragEvent, e: FileStat) {
    if (mount.readOnly) return ev.preventDefault();
    const paths = selected.has(e.path) ? [...selected] : [e.path];
    if (!selected.has(e.path)) setSelected(new Set([e.path]));
    ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    ev.dataTransfer.effectAllowed = 'move';
    dragging.current = paths;
    if (paths.length > 1) {
      const badge = document.createElement('div');
      badge.textContent = `${paths.length} items`;
      badge.style.cssText = 'position:fixed;top:-100px;left:0;padding:6px 12px;border-radius:999px;background:#ff3d5a;color:#fff;font:600 13px system-ui';
      document.body.appendChild(badge);
      ev.dataTransfer.setDragImage(badge, 10, 10);
      setTimeout(() => badge.remove(), 0);
    }
  }
  /** Props that make a folder (or breadcrumb) accept dragged items, and outside files to upload into it. */
  function dropZone(dest: string) {
    return {
      onDragOver: (ev: DragEvent) => {
        const internal = ev.dataTransfer.types.includes(DRAG_TYPE);
        if (mount.readOnly || (!internal && !ev.dataTransfer.types.includes('Files'))) return;
        if (internal && !canDropInto(dragging.current, dest)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.dataTransfer.dropEffect = internal ? 'move' : 'copy';
        if (dropTarget !== dest) setDropTarget(dest);
        setDragOver(false);
      },
      onDragLeave: (ev: DragEvent) => {
        if (!(ev.currentTarget as Node).contains(ev.relatedTarget as Node | null)) setDropTarget((t) => (t === dest ? null : t));
      },
      onDrop: async (ev: DragEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        setDropTarget(null);
        setDragOver(false);
        const raw = ev.dataTransfer.getData(DRAG_TYPE);
        if (raw) return void act.moveInto(JSON.parse(raw) as string[], dest);
        const items = ev.dataTransfer.items;
        let files = items ? await collectDropped(items) : [];
        if (!files.length) files = [...ev.dataTransfer.files].map((f) => ({ file: f, relPath: f.name }));
        if (files.length) enqueue(files, mount.id, dest);
      },
    };
  }

  async function onDrop(ev: DragEvent) {
    ev.preventDefault();
    setDragOver(false);
    setDropTarget(null);
    if (ev.dataTransfer.types.includes(DRAG_TYPE)) return; // dropped back where it was
    if (mount.readOnly) return toast('This mount is read-only', 'error');
    const items = ev.dataTransfer.items;
    let files = items ? await collectDropped(items) : [];
    if (!files.length) files = [...ev.dataTransfer.files].map((f) => ({ file: f, relPath: f.name }));
    if (files.length) enqueue(files, mount.id, path);
  }

  const crumbs = path ? path.split('/') : [];
  const previewFiles = useMemo(() => entries.filter((e) => !e.isDir), [entries]);
  const openFile = open ? previewFiles.find((e) => e.name === open) : undefined;
  const menuTarget = sel.length === 1 ? sel[0] : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-2 border-b border-line flex-wrap">
        <nav aria-label="Breadcrumb" className="flex items-center gap-0.5 text-sm min-w-0 flex-1 overflow-x-auto">
          <a href={href(mount.id)} onClick={(e) => (e.preventDefault(), navigate(href(mount.id)))} {...dropZone('')} className={`px-1.5 py-1 rounded hover-row font-medium shrink-0 ${dropTarget === '' ? 'ring-2 ring-[var(--color-accent)] bg-accent-soft' : ''}`}>
            {mount.label}
          </a>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join('/');
            return (
              <span key={p} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight size={14} className="text-muted" />
                <a href={href(mount.id, p)} onClick={(e) => (e.preventDefault(), navigate(href(mount.id, p)))} {...(i < crumbs.length - 1 ? dropZone(p) : {})} className={`px-1.5 py-1 rounded hover-row ${i === crumbs.length - 1 ? 'font-medium' : ''} ${dropTarget === p ? 'ring-2 ring-[var(--color-accent)] bg-accent-soft' : ''}`} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                  {c}
                </a>
              </span>
            );
          })}
        </nav>
        {sel.length > 0 ? (
          <div className="flex items-center gap-1 text-sm">
            <span className="text-muted mr-1">{sel.length} selected</span>
            <button className="btn btn-icon" title="Download" aria-label="Download selected" onClick={() => act.download(sel)}><Download size={17} /></button>
            {isBox && <button className="btn btn-icon" title="Make a playlist of these" aria-label="Make a playlist of the selected files" onClick={() => void act.makePlaylist(sel)}><ListMusic size={17} /></button>}
            {!mount.readOnly && <button className="btn btn-icon" title="Move" aria-label="Move selected" onClick={() => void act.move(sel)}><MoveRight size={17} /></button>}
            {!mount.readOnly && <button className="btn btn-icon text-red-500" title="Delete" aria-label="Delete selected" onClick={() => void act.remove(sel)}><Trash2 size={17} /></button>}
          </div>
        ) : (
          <div className="flex items-center gap-1">
            {mount.capabilities.contentAddressed && <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-soft text-accent" title="Content-addressed (IPFS)">IPFS</span>}
            {mount.emulated.length > 0 && <span className="text-[11px] px-1.5 py-0.5 rounded border border-line text-muted" title={`Emulated: ${mount.emulated.join(', ')}`}>emulated: {mount.emulated.join(', ')}</span>}
            {!mount.readOnly && <button className="btn btn-icon" title="New folder (⇧N or ⌥⌘N)" aria-label="New folder" onClick={() => void act.newFolder()}><FolderPlus size={17} /></button>}
            <button className="btn btn-icon" title="Refresh" aria-label="Refresh" onClick={() => void refresh()}><RefreshCw size={16} className={q.isFetching ? 'animate-spin' : ''} /></button>
          </div>
        )}
        <div className="flex items-center border border-line rounded-lg p-0.5">
          <button className={`btn btn-icon ${view === 'list' ? 'bg-sel' : ''}`} aria-pressed={view === 'list'} aria-label="List view" onClick={() => setView('list')}><List size={16} /></button>
          <button className={`btn btn-icon ${view === 'grid' ? 'bg-sel' : ''}`} aria-pressed={view === 'grid'} aria-label="Grid view" onClick={() => setView('grid')}><LayoutGrid size={16} /></button>
        </div>
      </div>

      {/* pane */}
      <div
        ref={pane}
        tabIndex={0}
        role={view === 'list' ? 'grid' : 'listbox'}
        aria-multiselectable="true"
        aria-label="Files"
        className={`flex-1 overflow-auto outline-none relative ${dragOver ? 'ring-2 ring-inset ring-accent' : ''}`}
        onKeyDown={onKey}
        onMouseDown={startMarquee}
        onClick={(e) => !marqueeJustEnded() && e.target === e.currentTarget && setSelected(new Set())}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) {
            e.preventDefault(); // allow the drop so the browser doesn't animate a "rejected" snap-back
            e.dataTransfer.dropEffect = 'none';
            if (dropTarget !== null) setDropTarget(null);
            return;
          }
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
        onDrop={onDrop}
      >
        {q.isPending && <div className="p-6 text-sm text-muted">Loading…</div>}
        {q.isError && <div className="p-6 text-sm text-red-500">Couldn't list this folder: {(q.error as Error).message}</div>}
        {q.isSuccess && entries.length === 0 && (
          <div className="h-full min-h-64 grid place-items-center text-sm text-muted text-center p-6">
            {filter ? `Nothing matches “${filter}”.` : mount.readOnly ? 'This folder is empty.' : 'This folder is empty. Drop files or folders here to upload.'}
          </div>
        )}

        {entries.length > 0 && view === 'list' && (
          <table className="w-full text-sm border-collapse select-none">
            <thead className="sticky top-0 bg-app z-10">
              <tr className="text-left text-muted border-b border-line">
                <th className="w-10 pl-3 py-2 font-normal">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={sel.length > 0 && sel.length === entries.length}
                    ref={(el) => { if (el) el.indeterminate = sel.length > 0 && sel.length < entries.length; }}
                    onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.path)) : new Set())}
                  />
                </th>
                {(
                  [
                    ['name', 'Name', ''],
                    ['size', 'Size', 'w-24 text-right hidden sm:table-cell'],
                    ['modifiedAt', 'Modified', 'w-32 hidden md:table-cell'],
                    ['type', 'Type', 'w-20 hidden lg:table-cell'],
                  ] as [SortKey, string, string][]
                ).map(([k, label, cls]) => (
                  <th key={k} className={`py-2 pr-3 font-medium ${cls}`} aria-sort={sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button className="inline-flex items-center gap-1 hover:text-[var(--fg)]" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : 1 }))}>
                      {label}
                      {sort.key === k && (sort.dir === 1 ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const isSel = selected.has(e.path);
                return (
                  <tr
                    key={e.path}
                    id={`row-${i}`}
                    aria-selected={isSel}
                    className={`border-b border-line/50 cursor-default ${isSel ? 'bg-sel' : 'hover-row'} ${focus === i ? 'outline outline-1 -outline-offset-1 outline-[var(--color-accent)]' : ''} ${e.isDir && dropTarget === e.path ? 'bg-accent-soft outline outline-2 -outline-offset-2 outline-[var(--color-accent)]' : ''}`}
                    {...(e.isDir ? dropZone(e.path) : {})}
                    onClick={(ev) => !marqueeJustEnded() && clickRow(ev, i)}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      if (!isSel) setSelected(new Set([e.path]));
                      setFocus(i);
                      setMenu({ x: ev.clientX, y: ev.clientY });
                    }}
                  >
                    <td className="pl-3 py-1.5" onClick={(ev) => ev.stopPropagation()}>
                      <input type="checkbox" aria-label={`Select ${e.name}`} checked={isSel} onChange={() => toggleCheck(i)} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <button
                        className="flex items-center gap-2 min-w-0 text-left"
                        data-drag-handle
                        draggable={!mount.readOnly}
                        onDragStart={(ev) => startDrag(ev, e)}
                        onDragEnd={() => ((dragging.current = []), setDropTarget(null))}
                        onClick={(ev) => { ev.stopPropagation(); openEntry(e); }}
                      >
                        <FileIcon entry={e} size={18} />
                        <span className="truncate">{e.name}</span>
                        {isStarred(starred, { mount: mount.id, path: e.path }) && <Star size={12} className="text-amber-500 fill-amber-500 shrink-0" />}
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 text-right text-muted tabular-nums hidden sm:table-cell">{e.isDir ? '—' : formatBytes(e.size)}</td>
                    <td className="py-1.5 pr-3 text-muted hidden md:table-cell">{e.isDir && e.modifiedAt.startsWith('1970') ? '—' : formatDate(e.modifiedAt)}</td>
                    <td className="py-1.5 pr-3 text-muted hidden lg:table-cell">{typeLabel(e.name, e.isDir, e.mime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {entries.length > 0 && view === 'grid' && (
          <div className="grid gap-2 p-3 select-none" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {entries.map((e, i) => {
              const isSel = selected.has(e.path);
              const thumbable = !e.isDir && /^(image\/(?!svg)|video\/|audio\/|application\/pdf)/.test(e.mime);
              return (
                <div
                  key={e.path}
                  id={`row-${i}`}
                  role="option"
                  aria-selected={isSel}
                  className={`group rounded-lg p-2 flex flex-col gap-1.5 cursor-default relative ${isSel ? 'bg-sel' : 'hover-row'} ${focus === i ? 'outline outline-1 outline-[var(--color-accent)]' : ''} ${e.isDir && dropTarget === e.path ? 'bg-accent-soft outline outline-2 outline-[var(--color-accent)]' : ''}`}
                  data-drag-handle
                  draggable={!mount.readOnly}
                  onDragStart={(ev) => startDrag(ev, e)}
                  onDragEnd={() => ((dragging.current = []), setDropTarget(null))}
                  {...(e.isDir ? dropZone(e.path) : {})}
                  onClick={(ev) => !marqueeJustEnded() && clickRow(ev, i)}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (!isSel) setSelected(new Set([e.path]));
                    setFocus(i);
                    setMenu({ x: ev.clientX, y: ev.clientY });
                  }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.name}`}
                    className={`absolute top-3 left-3 z-10 ${isSel ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                    checked={isSel}
                    onClick={(ev) => ev.stopPropagation()}
                    onChange={() => toggleCheck(i)}
                  />
                  <div className="aspect-[4/3] rounded-md bg-panel grid place-items-center overflow-hidden">
                    {thumbable ? <Thumb mount={mount.id} entry={e} /> : <FileIcon entry={e} size={40} />}
                  </div>
                  <div className="text-xs truncate text-center" title={e.name}>{e.name}</div>
                </div>
              );
            })}
          </div>
        )}
        {marquee && (
          <div
            aria-hidden
            className="absolute z-20 pointer-events-none rounded-sm border border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--color-accent)_15%,transparent)]"
            style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menuTarget && <button onClick={() => openEntry(menuTarget)}><ExternalLink size={15} /> Open</button>}
          {menuTarget && !menuTarget.isDir && <button onClick={() => void act.openNewTab(menuTarget)}><ExternalLink size={15} /> Open in new tab</button>}
          {sel.length > 0 && <button onClick={() => act.download(sel)}><Download size={15} /> Download{sel.length > 1 || menuTarget?.isDir ? ' as zip' : ''}</button>}
          {menuTarget && <button disabled={mount.readOnly} onClick={() => void act.rename(menuTarget)}><Pencil size={15} /> Rename <span className="ml-auto text-xs text-muted">F2</span></button>}
          {sel.length > 0 && <button disabled={mount.readOnly} onClick={() => void act.move(sel)}><MoveRight size={15} /> Move…</button>}
          {sel.length > 0 && isBox && <button onClick={() => void act.makePlaylist(sel)}><ListMusic size={15} /> Make playlist{sel.length > 1 ? ` (${sel.length})` : ''}</button>}
          {menuTarget && <button onClick={() => void act.copyLink(menuTarget)}><Link2 size={15} /> Copy link</button>}
          {menuTarget && !menuTarget.isDir && /^box-[0-9a-f]{16}$/.test(mount.id) && (
            <button onClick={() => void act.shareLink(menuTarget)}><Share2 size={15} /> Create share link</button>
          )}
          {menuTarget && !menuTarget.isDir && /^box-[0-9a-f]{16}$/.test(mount.id) && /^(audio|video)\//.test(menuTarget.mime) && (
            <button onClick={() => void act.reviewLink(menuTarget)}><MessageSquare size={15} /> Get review link</button>
          )}
          {menuTarget?.cid && <button onClick={() => void act.showCid(menuTarget)}><Hash size={15} /> Show CID</button>}
          {menuTarget && (
            <button onClick={() => toggleStar({ mount: mount.id, path: menuTarget.path, name: menuTarget.name, isDir: menuTarget.isDir })}>
              <Star size={15} /> {isStarred(starred, { mount: mount.id, path: menuTarget.path }) ? 'Unstar' : 'Star'}
            </button>
          )}
          {sel.length > 0 && <button disabled={mount.readOnly} className="text-red-500" onClick={() => void act.remove(sel)}><Trash2 size={15} /> Delete</button>}
          {sel.length === 0 && <button disabled={mount.readOnly} onClick={() => void act.newFolder()}><FolderPlus size={15} /> New folder</button>}
        </ContextMenu>
      )}

      {openFile && (
        <Previewer
          mount={mount}
          files={previewFiles}
          current={openFile}
          onNavigate={(f) => navigate(href(mount.id, path, f.name), true)}
          onClose={() => {
            navigate(href(mount.id, path));
            setTimeout(() => pane.current?.focus({ preventScroll: true }));
          }}
          onSaved={() => void refresh()}
        />
      )}
      {open && q.isSuccess && !openFile && <MissingFile name={open} onClose={() => navigate(href(mount.id, path), true)} />}
    </div>
  );
}

function MissingFile({ name, onClose }: { name: string; onClose: () => void }) {
  useEffect(() => {
    toast(`“${name}” was not found in this folder`, 'error');
    onClose();
  }, [name, onClose]);
  return null;
}

function Thumb({ mount, entry }: { mount: string; entry: FileStat }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileIcon entry={entry} size={40} />;
  return <img src={thumbUrl(mount, entry)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" onError={() => setFailed(true)} />;
}

function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ left: Math.min(x, innerWidth - r.width - 8), top: Math.min(y, innerHeight - r.height - 8) });
      el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => {
      addEventListener('mousedown', close);
      addEventListener('scroll', onClose, true);
    });
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', close);
      removeEventListener('scroll', onClose, true);
      removeEventListener('keydown', key);
    };
  }, [x, y, onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="menu fixed z-50"
      style={pos}
      onClick={(e) => (e.target as HTMLElement).closest('button') && onClose()}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') (e.preventDefault(), items[(i + 1) % items.length]?.focus());
        if (e.key === 'ArrowUp') (e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus());
      }}
    >
      {children}
    </div>
  );
}
