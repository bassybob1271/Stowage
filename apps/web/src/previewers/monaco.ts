// Self-hosted Monaco (no CDN): bundle the editor and its base worker.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

const LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', swift: 'swift', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
  xml: 'xml', md: 'markdown', markdown: 'markdown', lua: 'lua', r: 'r', pl: 'perl', dart: 'dart', graphql: 'graphql',
  dockerfile: 'dockerfile', proto: 'protobuf', vue: 'html', svelte: 'html',
};

export function languageFor(name: string) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const e = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return LANG[e] ?? 'plaintext';
}

export { monaco };
