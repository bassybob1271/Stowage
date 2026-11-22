import { useEffect, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Pencil, Save, X } from 'lucide-react';
import { api } from '../api';
import { toast } from '../components/Dialogs';
import { languageFor } from './monaco';
import type { PreviewProps } from './registry';

const MAX = 5 * 1024 * 1024;

export function useText(mount: string, path: string, etag?: string) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    setText(null);
    api.readText(mount, path, MAX).then((t) => !c && setText(t), (e: Error) => !c && setErr(e.message));
    return () => {
      c = true;
    };
  }, [mount, path, etag]);
  return { text, err, setText };
}

/** Monaco, read-only by default; "Edit" saves back when the mount is writable. */
export function CodeEditor({ value, name, editing, onChange }: { value: string; name: string; editing: boolean; onChange?: (v: string) => void }) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches || true; // previewer is always dark
  return (
    <Editor
      value={value}
      language={languageFor(name)}
      theme={dark ? 'vs-dark' : 'vs'}
      onChange={(v) => onChange?.(v ?? '')}
      options={{
        readOnly: !editing,
        minimap: { enabled: value.length > 20_000 },
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        fontSize: 13,
        renderWhitespace: 'selection',
        automaticLayout: true,
      }}
      loading={<div className="text-sm text-neutral-400 p-4">Loading editor…</div>}
    />
  );
}

export default function CodeView({ mount, file, onSaved }: PreviewProps) {
  const { text, err } = useText(mount.id, file.path, file.etag);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = editing && draft !== text;

  async function save() {
    setSaving(true);
    try {
      await api.saveText(mount.id, file.path, draft);
      toast('Saved');
      setEditing(false);
      onSaved();
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (err) return <div className="h-full grid place-items-center text-sm text-red-400">{err}</div>;
  if (text == null) return <div className="h-full grid place-items-center text-sm text-neutral-400">Loading…</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-sm">
        <span className="text-neutral-400">{text.split('\n').length.toLocaleString()} lines</span>
        <div className="ml-auto flex gap-1">
          {!editing && !mount.readOnly && (
            <button className="btn hover:!bg-white/10" onClick={() => (setDraft(text), setEditing(true))}><Pencil size={14} /> Edit</button>
          )}
          {mount.readOnly && <span className="text-xs text-neutral-500">read-only mount</span>}
          {editing && (
            <>
              <button className="btn hover:!bg-white/10" onClick={() => setEditing(false)}><X size={14} /> Cancel</button>
              <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}><Save size={14} /> {saving ? 'Saving…' : 'Save'}</button>
            </>
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <CodeEditor value={editing ? draft : text} name={file.name} editing={editing} onChange={setDraft} />
      </div>
    </div>
  );
}
