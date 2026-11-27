/** Script for the public review page (/r/:token). Plain JS, no build step; CSP allows only same-origin scripts. */
export const reviewJs = String.raw`(function () {
  var root = document.getElementById('review');
  var token = root.getAttribute('data-token');
  var base = '/r/' + token;
  var state = { comments: [], at: true, end: null, replyTo: null };
  var media, track, pos, list, form, nameIn, bodyIn, atBtn, endBtn, replyNote;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function seek(t) { media.currentTime = t; media.play().catch(function () {}); }
  // "raise the vocal at 1:36" → 1:36 becomes a button that jumps there
  function linkify(text) {
    var out = [], re = /\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, last = 0, m;
    while ((m = re.exec(text))) {
      out.push(text.slice(last, m.index));
      var t = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
      out.push(el('button', { class: 'ts', type: 'button', text: m[0], onclick: (function (t) { return function () { seek(t); }; })(t) }));
      last = re.lastIndex;
    }
    out.push(text.slice(last));
    return out;
  }

  function renderMarkers() {
    [].slice.call(track.querySelectorAll('.mk')).forEach(function (n) { n.remove(); });
    var d = media.duration;
    if (!d || !isFinite(d)) return;
    state.comments.forEach(function (c) {
      if (c.parentId || c.t === null) return;
      var b = el('button', { class: 'mk' + (c.tEnd !== null ? ' range' : '') + (c.resolved ? ' done' : ''), type: 'button', title: fmt(c.t) + ' ' + c.author + ': ' + c.body.slice(0, 80), 'aria-label': 'Comment at ' + fmt(c.t),
        onclick: function (e) { e.stopPropagation(); seek(c.t); var row = document.getElementById('c-' + c.id); if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } });
      b.style.left = (c.t / d * 100) + '%';
      if (c.tEnd !== null) b.style.width = Math.max(14, (c.tEnd - c.t) / d * track.clientWidth) + 'px';
      track.appendChild(b);
    });
  }

  function renderList() {
    list.textContent = '';
    if (!state.comments.length) list.appendChild(el('p', { class: 'none', text: 'No comments yet. Play it, pause where you hear something, and write a note.' }));
    state.comments.forEach(function (c) {
      var when = c.t === null ? null : el('button', { class: 'ts', type: 'button', text: fmt(c.t) + (c.tEnd !== null ? '–' + fmt(c.tEnd) : ''), onclick: function () { seek(c.t); } });
      list.appendChild(el('div', { id: 'c-' + c.id, class: 'cm' + (c.parentId ? ' reply' : '') + (c.resolved ? ' done' : '') }, [
        el('div', { class: 'who' }, [el('b', { text: c.author }), c.guest ? ' · guest' : '', c.resolved ? ' · resolved' : '']),
        el('p', { class: 'txt' }, [when].concat(linkify(c.body))),
        c.parentId ? null : el('button', { class: 'lnk', type: 'button', text: 'Reply', onclick: function () { state.replyTo = c; syncForm(); bodyIn.focus(); } }),
      ]));
    });
    renderMarkers();
  }

  function syncForm() {
    atBtn.textContent = state.at ? 'at ' + fmt(media.currentTime || 0) : 'whole track';
    atBtn.setAttribute('aria-pressed', String(state.at));
    endBtn.hidden = !state.at || !!state.replyTo;
    atBtn.hidden = !!state.replyTo;
    endBtn.textContent = state.end === null ? '+ end point' : 'to ' + fmt(state.end) + ' ✕';
    replyNote.hidden = !state.replyTo;
    if (state.replyTo) replyNote.firstChild.textContent = 'Replying to ' + state.replyTo.author + ' ';
  }

  function load() {
    return fetch(base + '/info', { cache: 'no-store' }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not load'); return j; }); });
  }

  load().then(function (info) {
    root.textContent = '';
    state.comments = info.comments;
    media = el(info.kind === 'video' ? 'video' : 'audio', { controls: '', preload: 'metadata', playsinline: '', src: base + '/media' });
    pos = el('div', { class: 'pos' });
    track = el('div', { class: 'track', title: 'Click to jump', onclick: function (e) { var r = track.getBoundingClientRect(); if (media.duration) seek((e.clientX - r.left) / r.width * media.duration); } }, [pos]);
    list = el('div', { class: 'list', 'aria-live': 'polite' });
    nameIn = el('input', { placeholder: 'Your name', maxlength: '60', required: '', autocomplete: 'name' });
    try { nameIn.value = localStorage.getItem('bz-review-name') || ''; } catch (e) {}
    bodyIn = el('textarea', { placeholder: 'e.g. raise the vocal here', maxlength: '4000', required: '' });
    atBtn = el('button', { class: 'chip', type: 'button', onclick: function () { state.at = !state.at; state.end = null; syncForm(); } });
    endBtn = el('button', { class: 'chip', type: 'button', onclick: function () {
      if (state.end !== null) state.end = null; else state.end = media.currentTime;
      syncForm();
    } });
    replyNote = el('div', { class: 'row', hidden: '' }, [el('span', { text: '' }), el('button', { class: 'lnk', type: 'button', text: 'cancel', onclick: function () { state.replyTo = null; syncForm(); } })]);
    var send = el('button', { class: 'btn go', type: 'submit', text: 'Comment' });
    form = el('form', { class: 'add', onsubmit: function (e) {
      e.preventDefault();
      var t = state.at ? (state.start != null ? state.start : media.currentTime) : null;
      var payload = { name: nameIn.value.trim(), body: bodyIn.value.trim(), t: state.replyTo ? null : t, tEnd: state.replyTo ? null : state.end, parentId: state.replyTo ? state.replyTo.id : null };
      if (!payload.name || !payload.body) return;
      try { localStorage.setItem('bz-review-name', payload.name); } catch (e) {}
      send.disabled = true;
      fetch(base + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not save'); }); })
        .then(function () { bodyIn.value = ''; state.replyTo = null; state.end = null; state.start = null; return load(); })
        .then(function (i) { state.comments = i.comments; renderList(); syncForm(); })
        .catch(function (err) { alertBox.textContent = err.message; })
        .then(function () { send.disabled = false; });
    } }, [nameIn, bodyIn, el('div', { class: 'row' }, [atBtn, endBtn]), replyNote, send]);
    var alertBox = el('p', { class: 'row', role: 'status' });
    form.appendChild(alertBox);
    // Typing pins the time where you started, so the note lands where you paused.
    bodyIn.addEventListener('focus', function () { if (state.at && state.start == null && !state.replyTo) state.start = media.currentTime; });
    bodyIn.addEventListener('input', function () { if (!bodyIn.value) state.start = null; });

    root.appendChild(el('p', { class: 'kicker', text: 'Review · link works until ' + new Date(info.expiresAt).toLocaleDateString() }));
    root.appendChild(el('h1', { text: info.name.replace(/\.[^.]+$/, '') }));
    root.appendChild(el('div', { class: 'rv', style: 'margin-top:24px' }, [
      el('div', null, [el('div', { class: 'media' }, [media]), track, el('p', { class: 'row', style: 'margin-top:8px', text: 'Pause where you hear something, then write your note: it’s pinned to that moment.' })]),
      el('aside', { class: 'side' }, [el('h2', { text: 'Comments' }), list, form]),
    ]));
    media.addEventListener('timeupdate', function () {
      if (media.duration) pos.style.width = (media.currentTime / media.duration * 100) + '%';
      if (state.start == null) syncForm();
    });
    media.addEventListener('loadedmetadata', renderMarkers);
    window.addEventListener('resize', renderMarkers);
    renderList();
    syncForm();
    setInterval(function () { if (document.visibilityState === 'visible' && document.activeElement !== bodyIn) load().then(function (i) { state.comments = i.comments; renderList(); }).catch(function () {}); }, 20000);
  }).catch(function (err) {
    root.textContent = '';
    root.appendChild(el('div', { class: 'empty' }, [el('h1', { text: err.message })]));
  });
})();
`;
