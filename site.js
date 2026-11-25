
(() => {
  const el = document.getElementById('calc');
  if (!el) return;
  const d = el.dataset;
  const plans = [
    ['Flex', Number(d.flex) / 100, Number(d.incl), Number(d.over) / 100],
    ['Studio', Number(d.studio) / 100, Number(d.sincl), Number(d.sover) / 100],
  ];
  /** Cheapest BazzyBox plan for a given amount stored. */
  const ours = (tb) => plans.map(([name, base, incl, over]) => ({ name, incl, cost: base + Math.max(0, tb - incl) * over }))
    .reduce((a, b) => (b.cost < a.cost ? b : a));
  const $ = (id) => document.getElementById(id);
  const dropbox = (tb) => tb <= 2 ? [11.99, 'Dropbox Plus, 2 TB']
    : tb <= 3 ? [19.99, 'Dropbox Professional, 3 TB']
    : tb <= 5 ? [54, 'Dropbox Standard, 3 seats, 5 TB']
    : tb <= 15 ? [90, 'Dropbox Advanced, 3 seats, 15 TB']
    : [Math.ceil(tb / 5) * 30, 'Dropbox Advanced, ' + Math.ceil(tb / 5) + ' seats, ' + Math.ceil(tb / 5) * 5 + ' TB'];
  const money = (x) => '$' + (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(2));
  const draw = () => {
    const tb = Number($('tb').value);
    const [db, dl] = dropbox(tb);
    const us = ours(tb), b = us.cost;
    const max = Math.max(db, b);
    $('tbv').textContent = tb + ' TB';
    $('tb').setAttribute('aria-valuetext', tb + ' TB');
    $('vd').textContent = money(db); $('vb').textContent = money(b);
    $('fd').style.width = (db / max * 100) + '%'; $('fb').style.width = (b / max * 100) + '%';
    const yr = Math.round((db - b) * 12);
    $('sv').textContent = '$' + Math.max(0, yr).toLocaleString('en-US');
    $('plan').textContent = dl + ' · BazzyBox ' + us.name + (tb > us.incl ? ', ' + us.incl + ' TB + ' + (tb - us.incl) + ' TB extra' : ', ' + us.incl + ' TB included');
  };
  $('tb').addEventListener('input', draw);
  draw();
})();
