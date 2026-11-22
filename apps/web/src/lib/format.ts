export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (!d.getTime()) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}

export function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function typeLabel(name: string, isDir: boolean, mime: string): string {
  if (isDir) return 'Folder';
  const e = ext(name);
  if (e) return e.toUpperCase();
  return mime.split('/')[1] ?? 'File';
}
