const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Single page: stream list at "/", player at "/watch/<slug>". No inline script (CSP script-src 'self'). */
export function pageHtml(o: { title: string; slug: string | null; boxUrl?: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${esc(o.slug ? `${o.slug} · ${o.title}` : o.title)}</title>
<style>
  :root { --bg:#0c0d10; --panel:#16181d; --line:#262a31; --fg:#eceef2; --muted:#8e95a3; --accent:#ff3d5a; --ok:#2fd27a; }
  @media (prefers-color-scheme: light) { :root:not([data-theme=dark]) { --bg:#f6f7f9; --panel:#fff; --line:#e3e6eb; --fg:#15171c; --muted:#5f6673; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { display:flex; align-items:center; gap:10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  header a { color: inherit; text-decoration: none; font-weight: 650; letter-spacing: -0.01em; }
  header .box { margin-left: auto; display:inline-flex; align-items:center; gap:8px; min-height:40px; padding: 8px 12px; border-radius: 9px; border: 1px solid var(--line); background: var(--panel); font-size: 14px; }
  header .box:hover { border-color: var(--accent); }
  header .box span { color: var(--muted); font-weight: 500; }
  @media (max-width: 520px) { header .box span { display: none; } }
  header .box:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dot { width:10px; height:10px; border-radius:50%; background: var(--accent); box-shadow: 0 0 0 4px color-mix(in oklab, var(--accent) 25%, transparent); }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .player { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16/9; }
  video { width: 100%; height: 100%; display: block; background: #000; }
  .bar { display:flex; flex-wrap: wrap; align-items:center; gap: 8px 14px; margin-top: 12px; }
  .badge { display:inline-flex; align-items:center; gap:6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 4px 8px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
  .badge.live { color: #fff; background: var(--accent); border-color: transparent; }
  .muted { color: var(--muted); font-size: 13px; }
  .q { display:flex; gap:4px; flex-wrap: wrap; margin-left: auto; }
  .q button { font: inherit; font-size: 13px; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
  .q button[aria-pressed=true] { border-color: var(--fg); font-weight: 650; }
  .q button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .grid { display:grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card { display:block; padding: 16px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); color: inherit; text-decoration: none; }
  .card:hover { border-color: var(--muted); }
  .card h2 { margin: 8px 0 4px; font-size: 17px; }
  .empty { padding: 48px 16px; text-align:center; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; }
  .overlay { position:absolute; inset:0; display:grid; place-items:center; color:#cfd3da; font-size:14px; pointer-events:none; text-align:center; padding: 16px; }
  .overlay[hidden] { display: none; }
  code { font: 12.5px ui-monospace, monospace; background: var(--panel); border: 1px solid var(--line); padding: 1px 5px; border-radius: 5px; }
</style>
</head>
<body data-slug="${o.slug ? esc(o.slug) : ''}">
<header><span class="dot" aria-hidden="true"></span><a href="/">${esc(o.title)}</a>${o.boxUrl ? `<a class="box" href="${esc(o.boxUrl)}">BazzyBox <span>storage for creators</span></a>` : ''}</header>
<main id="app">${o.slug ? `
  <div class="player">
    <video id="video" controls playsinline autoplay muted></video>
    <div class="overlay" id="overlay">Connecting…</div>
  </div>
  <div class="bar">
    <span class="badge" id="status">Offline</span>
    <span class="muted" id="info"></span>
    <div class="q" id="quality" role="group" aria-label="Quality"></div>
  </div>` : `
  <h1 style="font-size:22px;margin:4px 0 16px">Live now</h1>
  <div id="list" class="grid" aria-live="polite"></div>`}
</main>
<script src="/static/hls.min.js"></script>
<script src="/static/app.js"></script>
</body>
</html>`;
}

/** Client script (served from /static/app.js). */
export const appJs = String.raw`
(() => {
  const slug = document.body.dataset.slug;
  const $ = (id) => document.getElementById(id);
  const kbps = (n) => n >= 1000 ? (n / 1000).toFixed(1) + ' Mbps' : n + ' kbps';

  async function streams() {
    try { return (await (await fetch('/api/streams', { cache: 'no-store' })).json()).streams; } catch { return []; }
  }

  if (!slug) {
    const render = async () => {
      const list = (await streams()).filter((s) => s.status !== 'ended');
      const el = $('list');
      el.replaceChildren();
      if (!list.length) {
        const d = document.createElement('div'); d.className = 'empty'; d.style.gridColumn = '1/-1';
        d.textContent = 'Nothing is live right now. This page updates automatically.';
        el.append(d); return;
      }
      for (const s of list) {
        const a = document.createElement('a'); a.className = 'card'; a.href = '/watch/' + encodeURIComponent(s.slug);
        const b = document.createElement('span'); b.className = 'badge' + (s.status === 'live' ? ' live' : ''); b.textContent = s.status === 'live' ? '● Live' : s.status;
        const h = document.createElement('h2'); h.textContent = s.name.replace(/^live\//, '');
        const p = document.createElement('div'); p.className = 'muted';
        p.textContent = (s.source || '') + (s.rungs.length ? ' · ' + s.rungs.map((r) => r.name).join(' / ') : '');
        a.append(b, h, p); el.append(a);
      }
    };
    render(); setInterval(render, 4000);
    return;
  }

  const video = $('video'), overlay = $('overlay'), status = $('status'), info = $('info'), q = $('quality');
  const src = '/hls/' + slug + '/master.m3u8';
  let hls = null, live = false;

  const setStatus = (s) => {
    live = s === 'live';
    status.textContent = live ? '● Live' : s === 'offline' ? 'Offline' : s;
    status.className = 'badge' + (live ? ' live' : '');
  };

  function buttons(levels, current, auto) {
    q.replaceChildren();
    const mk = (label, idx, pressed, title) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title || label;
      b.setAttribute('aria-pressed', String(pressed));
      b.onclick = () => { if (hls) hls.currentLevel = idx; buttons(levels, idx, idx === -1); };
      q.append(b);
    };
    mk('Auto', -1, auto, 'Adapt to your connection');
    levels.map((l, i) => ({ l, i })).sort((a, b) => b.l.height - a.l.height)
      .forEach(({ l, i }) => mk(l.height + 'p', i, !auto && i === current, kbps(Math.round(l.bitrate / 1000))));
  }

  function describe() {
    if (!hls || hls.currentLevel < 0) return;
    const l = hls.levels[hls.currentLevel];
    if (l) info.textContent = l.width + '×' + l.height + ' · ' + kbps(Math.round(l.bitrate / 1000)) + (hls.autoLevelEnabled ? ' (auto)' : '');
  }

  function start() {
    overlay.textContent = 'Connecting…'; overlay.hidden = false;
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, lowLatencyMode: false, enableWorker: true });
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => { buttons(d.levels, -1, true); overlay.hidden = true; setStatus('live'); video.play().catch(() => {}); });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => { describe(); buttons(hls.levels, hls.currentLevel, hls.autoLevelEnabled); });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        hls.destroy(); hls = null; setStatus('offline');
        overlay.textContent = 'Waiting for the stream…'; overlay.hidden = false;
        setTimeout(start, 4000);
      });
      hls.loadSource(src); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: native HLS does its own adaptive switching.
      video.src = src;
      video.addEventListener('loadedmetadata', () => { overlay.hidden = true; setStatus('live'); info.textContent = 'Adaptive (native HLS)'; }, { once: true });
      video.addEventListener('error', () => { setStatus('offline'); overlay.textContent = 'Waiting for the stream…'; overlay.hidden = false; setTimeout(() => { video.removeAttribute('src'); video.load(); start(); }, 4000); }, { once: true });
    } else {
      overlay.textContent = 'This browser cannot play HLS.';
    }
  }

  setInterval(describe, 2000);
  start();
})();
`;
