// Generates document fixtures (no dependencies).  node e2e/fixtures/make-docs.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const w = (n, d) => writeFileSync(join(dir, n), d);

// Minimal 3-page PDF with real text (searchable).
function pdf(pages) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  const pagesId = objs.length + pages.length * 2 + 1;
  for (const text of pages) {
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return out;
}
w('doc.pdf', pdf(['Stowage page one', 'Second page has the needle', 'Third and final page']));
w('readme.md', '# Stowage fixture\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two\n\n```js\nconsole.log(42)\n```\n\n<script>window.__mdxss = 1</script>\n<img src=x onerror="window.__mdxss=2">\n');
w('data.csv', 'id,name,score\n' + Array.from({ length: 2000 }, (_, i) => `${i + 1},row ${i + 1},${(i * 37) % 101}`).join('\n') + '\n');
w('data.json', JSON.stringify({ name: 'stowage', nested: { list: [1, 2, 3], ok: true, none: null }, n: 42 }, null, 2));
w('notes.txt', 'plain text fixture\n'.repeat(50));
w('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="parent.__svgxss=1"><script>parent.__svgxss=1;fetch("/api/mounts")</script><circle cx="50" cy="50" r="40" fill="tomato"/></svg>');
w('evil.html', '<!doctype html><script>try{parent.__htmlxss=1}catch(e){};fetch("/api/mounts").then(()=>{document.title="LEAKED"})</script><p>hi</p>');
console.log('docs written to', dir);
