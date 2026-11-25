const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type PageView = { kind: 'home' } | { kind: 'watch'; slug: string } | { kind: 'studio' } | { kind: 'replay'; id: string };

export interface PageOptions {
  title: string;
  view: PageView;
  boxUrl?: string;
  tvUrl?: string;
  /** Sign in with Bazzy TV is on: show the Studio link. */
  studio?: boolean;
  signedIn?: boolean;
}

function body(v: PageView) {
  switch (v.kind) {
    case 'watch':
      return `
  <div class="player">
    <video id="video" controls playsinline autoplay muted></video>
    <div class="overlay" id="overlay">Connecting…</div>
  </div>
  <div class="bar">
    <span class="badge" id="status">Offline</span>
    <span class="muted" id="info"></span>
    <div class="q" id="quality" role="group" aria-label="Quality"></div>
  </div>
  <section id="past" hidden><h2 class="h2">Past shows on this channel</h2><div id="replays" class="grid"></div></section>`;
    case 'replay':
      return `
  <div class="player"><video id="video" controls playsinline preload="metadata"></video></div>
  <div class="bar"><span class="badge">Replay</span><strong id="rtitle"></strong><span class="muted" id="info"></span>
    <a class="btn ghost" id="download" download>Download</a></div>
  <section id="past" hidden><h2 class="h2">More from this channel</h2><div id="replays" class="grid"></div></section>`;
    case 'studio':
      return `
  <h1 class="h1">Studio</h1>
  <div id="studio" class="stack" aria-live="polite"><div class="empty">Loading…</div></div>`;
    default:
      return `
  <h1 class="h1">Live now</h1>
  <div id="list" class="grid" aria-live="polite"></div>
  <section id="past" hidden><h2 class="h2">Past shows</h2><div id="replays" class="grid"></div></section>`;
  }
}

/** One page for every view. No inline script (CSP script-src 'self'). */
export function pageHtml(o: PageOptions) {
  const v = o.view;
  const sub = v.kind === 'watch' ? v.slug : v.kind === 'studio' ? 'Studio' : v.kind === 'replay' ? 'Replay' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>${esc(sub ? `${sub} · ${o.title}` : o.title)}</title>
<style>
  :root { --bg:#0c0d10; --panel:#16181d; --line:#262a31; --fg:#eceef2; --muted:#8e95a3; --accent:#ff3d5a; --ok:#2fd27a; }
  @media (prefers-color-scheme: light) { :root:not([data-theme=dark]) { --bg:#f6f7f9; --panel:#fff; --line:#e3e6eb; --fg:#15171c; --muted:#5f6673; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: inherit; }
  header { display:flex; align-items:center; gap:10px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header .brand { display:inline-flex; align-items:center; gap:10px; text-decoration: none; font-weight: 650; letter-spacing: -0.01em; min-height: 40px; }
  header nav { margin-left: auto; display:flex; align-items:center; gap:6px; flex-wrap: wrap; }
  header nav a { display:inline-flex; align-items:center; gap:8px; min-height:40px; padding: 8px 12px; border-radius: 9px; border: 1px solid transparent; text-decoration: none; font-size: 14px; font-weight: 600; }
  header nav a:hover { border-color: var(--line); background: var(--panel); }
  header nav a.box { border-color: var(--line); background: var(--panel); }
  header nav a.box:hover, header nav a.studio:hover { border-color: var(--accent); }
  header nav a.studio { color: #fff; background: var(--accent); }
  header nav a span { color: var(--muted); font-weight: 500; }
  @media (max-width: 620px) { header nav a span { display: none; } header nav a { padding: 8px 10px; } }
  header a:focus-visible, .btn:focus-visible, .q button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dot { width:10px; height:10px; border-radius:50%; background: var(--accent); box-shadow: 0 0 0 4px color-mix(in oklab, var(--accent) 25%, transparent); }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  .h1 { font-size: 22px; margin: 4px 0 16px; }
  .h2 { font-size: 17px; margin: 28px 0 12px; }
  .player { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16/9; }
  video { width: 100%; height: 100%; display: block; background: #000; }
  .bar { display:flex; flex-wrap: wrap; align-items:center; gap: 8px 14px; margin-top: 12px; }
  .badge { display:inline-flex; align-items:center; gap:6px; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 4px 8px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); }
  .badge.live { color: #fff; background: var(--accent); border-color: transparent; }
  .muted { color: var(--muted); font-size: 13px; }
  .q { display:flex; gap:4px; flex-wrap: wrap; margin-left: auto; }
  .q button, .btn { font: inherit; font-size: 14px; font-weight: 600; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 8px 12px; min-height: 40px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; }
  .q button { font-size: 13px; font-weight: 500; padding: 6px 10px; min-height: 34px; }
  .q button[aria-pressed=true] { border-color: var(--fg); font-weight: 650; }
  .btn.primary { background: var(--accent); border-color: transparent; color: #fff; }
  .btn.ghost { margin-left: auto; }
  .btn.danger { color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .grid { display:grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .card { display:block; padding: 16px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); color: inherit; text-decoration: none; }
  a.card:hover { border-color: var(--muted); }
  .card h2, .card h3 { margin: 8px 0 4px; font-size: 17px; }
  .empty { padding: 48px 16px; text-align:center; color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; }
  .overlay { position:absolute; inset:0; display:grid; place-items:center; color:#cfd3da; font-size:14px; pointer-events:none; text-align:center; padding: 16px; }
  .overlay[hidden] { display: none; }
  .stack { display: grid; gap: 16px; }
  .field { display: grid; gap: 6px; }
  .field label { font-size: 13px; color: var(--muted); font-weight: 600; }
  .row { display: flex; gap: 8px; align-items: stretch; flex-wrap: wrap; }
  .row code { flex: 1 1 260px; min-width: 0; overflow-wrap: anywhere; display: flex; align-items: center; padding: 8px 10px; font-size: 13px; }
  .err { color: var(--accent); }
  code { font: 12.5px ui-monospace, monospace; background: var(--panel); border: 1px solid var(--line); padding: 1px 5px; border-radius: 6px; }
  .card code { background: var(--bg); }
  .between { display:flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  form { margin: 0; }
</style>
</head>
<body data-view="${v.kind}" data-slug="${v.kind === 'watch' ? esc(v.slug) : ''}" data-id="${v.kind === 'replay' ? esc(v.id) : ''}">
<header>
  <a class="brand" href="/"><span class="dot" aria-hidden="true"></span>${esc(o.title)}</a>
  <nav aria-label="Bazzy sites">
    ${o.tvUrl ? `<a href="${esc(o.tvUrl)}">Bazzy TV <span>films &amp; shows</span></a>` : ''}
    ${o.boxUrl ? `<a class="box" href="${esc(o.boxUrl)}">BazzyBox <span>storage for creators</span></a>` : ''}
    ${o.studio ? `<a class="studio" href="/studio">${o.signedIn ? 'Studio' : 'Go live'}</a>` : ''}
  </nav>
</header>
<main id="app">${body(v)}
</main>
${v.kind === 'watch' ? '<script src="/static/hls.min.js"></script>\n' : ''}<script src="/static/app.js"></script>
</body>
</html>`;
}

/** Client script (served from /static/app.js). */
export const appJs = String.raw`
(() => {
  const view = document.body.dataset.view;
  const slug = document.body.dataset.slug;
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids.filter((k) => k != null)); return n; };
  const kbps = (n) => n >= 1000 ? (n / 1000).toFixed(1) + ' Mbps' : n + ' kbps';
  const dur = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const getJson = async (u) => { try { const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin' }); return r.ok ? r.json() : null; } catch { return null; } };

  async function streams() { return (await getJson('/api/streams'))?.streams || []; }

  /** Past shows grid. opts: { query, exclude, mine } */
  async function replays(opts) {
    const box = $('replays'), sec = $('past');
    if (!box) return;
    const data = await getJson('/api/recordings' + (opts.query || ''));
    const list = (data?.recordings || []).filter((r) => r.id !== opts.exclude);
    box.replaceChildren();
    if (!list.length) { if (sec) sec.hidden = !opts.mine; if (opts.mine) box.append(el('div', { className: 'empty', textContent: data?.recording ? 'Your shows appear here a minute after you end them.' : 'Recording is off on this server.' })); return; }
    if (sec) sec.hidden = false;
    for (const r of list) {
      const card = el(opts.mine ? 'div' : 'a', { className: 'card' });
      if (!opts.mine) card.href = r.page;
      const title = opts.mine ? el('h3', {}, el('a', { href: r.page, textContent: when(r.startedAt) })) : el('h3', { textContent: r.title });
      card.append(el('span', { className: 'badge', textContent: 'Replay · ' + dur(r.durationSec) }), title,
        el('div', { className: 'muted', textContent: opts.mine ? (r.bytes / 1e9).toFixed(2) + ' GB' : when(r.startedAt) }));
      if (opts.mine) {
        const del = el('button', { className: 'btn danger', type: 'button', textContent: 'Delete' });
        del.onclick = async () => {
          if (!confirm('Delete this recording for good?')) return;
          del.disabled = true;
          const res = await fetch('/api/recordings/' + encodeURIComponent(r.id), { method: 'DELETE', credentials: 'same-origin' });
          if (res.ok) card.remove(); else { del.disabled = false; alert('Could not delete it. Try again.'); }
        };
        card.append(el('div', { className: 'row', style: 'margin-top:10px' }, del));
      }
      box.append(card);
    }
  }

  if (view === 'home') {
    const render = async () => {
      const list = (await streams()).filter((s) => s.status !== 'ended');
      const box = $('list');
      box.replaceChildren();
      if (!list.length) {
        box.append(el('div', { className: 'empty', style: 'grid-column:1/-1', textContent: 'Nothing is live right now. This page updates automatically.' }));
        return;
      }
      for (const s of list) {
        box.append(el('a', { className: 'card', href: '/watch/' + encodeURIComponent(s.slug) },
          el('span', { className: 'badge' + (s.status === 'live' ? ' live' : ''), textContent: s.status === 'live' ? '● Live' : s.status }),
          el('h2', { textContent: s.name.replace(/^live\//, '') }),
          el('div', { className: 'muted', textContent: (s.source || '') + (s.rungs.length ? ' · ' + s.rungs.map((r) => r.name).join(' / ') : '') })));
      }
    };
    render(); setInterval(render, 4000);
    replays({ query: '' });
    return;
  }

  if (view === 'replay') {
    const id = document.body.dataset.id;
    (async () => {
      const r = await getJson('/api/recordings/' + encodeURIComponent(id));
      if (!r) return;
      const v = $('video');
      v.src = r.url;
      $('download').href = r.url;
      $('rtitle').textContent = r.title;
      $('info').textContent = when(r.startedAt) + ' · ' + dur(r.durationSec);
      document.title = r.title + ' · Replay';
      replays({ query: '?slug=' + encodeURIComponent(r.slug), exclude: r.id });
    })();
    return;
  }

  if (view === 'studio') {
    const root = $('studio');
    const err = new URLSearchParams(location.search).get('error');
    const copyRow = (label, value, secret) => {
      const code = el('code', { textContent: secret ? '•'.repeat(24) : value });
      const row = el('div', { className: 'row' }, code);
      if (secret) {
        const show = el('button', { className: 'btn', type: 'button', textContent: 'Show' });
        show.onclick = () => { const on = show.textContent === 'Show'; code.textContent = on ? value : '•'.repeat(24); show.textContent = on ? 'Hide' : 'Show'; };
        row.append(show);
      }
      const copy = el('button', { className: 'btn', type: 'button', textContent: 'Copy' });
      copy.onclick = async () => { try { await navigator.clipboard.writeText(value); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); } catch { code.textContent = value; } };
      row.append(copy);
      return el('div', { className: 'field' }, el('label', { textContent: label }), row);
    };
    const render = async () => {
      const me = await getJson('/api/me');
      root.replaceChildren();
      if (err) root.append(el('p', { className: 'err', textContent: err }));
      if (!me || !me.bazzy) { root.append(el('div', { className: 'empty', textContent: 'Sign-in is not set up on this server yet.' })); return; }
      if (!me.signedIn) {
        root.append(el('div', { className: 'card stack' },
          el('h2', { textContent: 'Go live on Bazzy Live' }),
          el('p', { className: 'muted', textContent: 'Sign in with your Bazzy TV account (email, Google or Apple) to get your own channel and stream key. Every show is saved for replay.' }),
          el('div', {}, el('a', { className: 'btn primary', href: '/auth/bazzy/start', textContent: 'Sign in with Bazzy TV' }))));
        return;
      }
      const logout = el('form', { method: 'post', action: '/auth/logout' }, el('button', { className: 'btn', type: 'submit', textContent: 'Sign out' }));
      root.append(el('div', { className: 'between' }, el('div', {}, el('strong', { textContent: me.name }), el('div', { className: 'muted', textContent: 'Channel: ' + me.handle })), logout));
      if (!me.canGoLive) {
        root.append(el('div', { className: 'card', textContent: 'Your Bazzy TV account can watch but not go live yet. Ask Bazzy TV to make it a filmmaker account, then sign in again.' }));
        return;
      }
      const card = el('div', { className: 'card stack' },
        el('h2', { textContent: 'OBS settings' }),
        el('p', { className: 'muted', textContent: 'OBS → Settings → Stream → Service: Custom. Keep the stream key private: anyone with it can broadcast on your channel.' }),
        copyRow('Server', me.obs.server),
        copyRow('Stream key', me.obs.streamKey, true),
        copyRow('Your channel', me.watch),
        el('details', {}, el('summary', { className: 'muted', textContent: 'SRT instead of RTMP' }), copyRow('SRT URL', me.srt, true)));
      const reset = el('button', { className: 'btn danger', type: 'button', textContent: 'Reset stream key' });
      reset.onclick = async () => {
        if (!confirm('Make a new stream key? The old one stops working, so update OBS afterwards.')) return;
        reset.disabled = true;
        const res = await fetch('/api/me/key', { method: 'POST', credentials: 'same-origin' });
        if (res.ok) render(); else { reset.disabled = false; alert('Could not reset the key. Try again.'); }
      };
      card.append(el('div', { className: 'row' }, el('a', { className: 'btn primary', href: me.watch, textContent: 'Open my channel' }), reset));
      root.append(card, el('section', { id: 'past' }, el('h2', { className: 'h2', textContent: 'Your recordings' }), el('div', { id: 'replays', className: 'grid' })));
      replays({ query: '?mine=1', mine: true });
    };
    render();
    return;
  }

  // view === 'watch'
  replays({ query: '?slug=' + encodeURIComponent(slug) });
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
