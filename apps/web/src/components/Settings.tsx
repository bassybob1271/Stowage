import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, X, RefreshCw } from 'lucide-react';
import type { AdapterKind, MountInfo } from '@stowage/shared';
import { api } from '../api';
import { confirmDialog, toast } from './Dialogs';

const TEMPLATES: Record<AdapterKind, Record<string, unknown>> = {
  s3: { endpoint: 'https://<account>.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-bucket', accessKey: '', secretKey: '', forcePathStyle: true },
  ipfs: { apiUrl: 'http://kubo:5001', gatewayUrl: 'http://kubo:8080', mfsRoot: '/stowage' },
  local: { root: '/data/files' },
  webdav: { url: 'https://cloud.example.com/remote.php/dav/files/me', username: '', password: '' },
  sftp: { host: 'nas.local', port: 22, username: '', password: '', root: '/home/me' },
  azure: { connectionString: '', container: 'stowage' },
  gcs: { bucket: 'my-bucket', projectId: '', keyFilename: '/secrets/gcs.json' },
  rclone: { url: 'http://rclone:8080', rcUrl: 'http://rclone:5572' },
};

/** Mount management. Mounts added here are stored AES-GCM-encrypted in the database. */
export function Settings({ mounts, onClose }: { mounts: MountInfo[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<AdapterKind>('s3');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [config, setConfig] = useState(JSON.stringify(TEMPLATES.s3, null, 2));
  const [busy, setBusy] = useState(false);

  async function add() {
    let cfg: unknown;
    try {
      cfg = JSON.parse(config);
    } catch {
      return toast('Config must be valid JSON', 'error');
    }
    setBusy(true);
    try {
      const m = await api.createMount({ id, label: label || undefined, kind, readOnly, config: cfg });
      toast(m.health.ok ? `Mounted ${m.label}` : `Added ${m.label}, but health check failed: ${m.health.detail ?? ''}`, m.health.ok ? 'info' : 'error');
      setId('');
      setLabel('');
      await qc.invalidateQueries({ queryKey: ['mounts'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: MountInfo) {
    if (!(await confirmDialog({ title: `Remove mount “${m.label}”?`, message: 'Only the mount definition is removed. Files in the backend are not touched.', confirm: 'Remove', danger: true }))) return;
    try {
      await api.deleteMount(m.id);
      await qc.invalidateQueries({ queryKey: ['mounts'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="w-full max-w-2xl max-h-full overflow-y-auto rounded-xl bg-panel border border-line shadow-2xl" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="flex items-center px-4 py-3 border-b border-line">
          <h2 className="font-semibold flex-1">Mounts</h2>
          <button className="btn btn-icon" aria-label="Recheck health" onClick={() => qc.fetchQuery({ queryKey: ['mounts'], queryFn: () => api.mounts(true) })}><RefreshCw size={16} /></button>
          <button className="btn btn-icon" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </header>
        <table className="w-full text-sm">
          <tbody>
            {mounts.map((m) => (
              <tr key={m.id} className="border-b border-line/60">
                <td className="px-4 py-2">
                  <div className="font-medium flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${m.health.ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    {m.label} <span className="text-muted font-normal">/{m.id}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {m.kind}
                    {m.readOnly ? ' · read-only' : ''}
                    {m.emulated.length ? ` · emulated: ${m.emulated.join(', ')}` : ''}
                    {m.health.detail ? ` · ${m.health.detail}` : ''}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted">{m.source === 'yaml' ? 'mounts.yaml' : 'database'}</td>
                <td className="px-2 py-2 text-right">
                  {m.source === 'db' && <button className="btn btn-icon text-red-500" aria-label={`Remove ${m.label}`} onClick={() => void remove(m)}><Trash2 size={15} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="p-4 flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h3 className="font-semibold">Add a mount</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Kind</span>
              <select
                className="input"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as AdapterKind;
                  setKind(k);
                  setConfig(JSON.stringify(TEMPLATES[k], null, 2));
                }}
              >
                {Object.keys(TEMPLATES).map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Id (URL name)</span>
              <input className="input" required pattern="[a-z0-9][a-z0-9-]{0,62}" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="s3-main" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-muted text-xs">Label</span>
              <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main bucket" />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Config (JSON). Stored encrypted with MASTER_KEY.</span>
            <textarea className="input font-mono text-xs h-44" spellCheck={false} value={config} onChange={(e) => setConfig(e.target.value)} />
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only</label>
          <div className="flex justify-end"><button className="btn btn-primary" disabled={busy || !id}>{busy ? 'Checking…' : 'Add mount'}</button></div>
        </form>
      </div>
    </div>
  );
}
