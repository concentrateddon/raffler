'use strict';

/* =====================================================================
   Raffler — offline community raffle manager.
   All data lives in localStorage on this device. No network required.
   ===================================================================== */

const STORE_KEY = 'raffler.state.v1';
const DRAW_MS = 2000;

/* ---------- tiny helpers ---------- */

const appEl = document.getElementById('app');
const modalsEl = document.getElementById('modals');
const toastsEl = document.getElementById('toasts');

const PROPS = new Set(['value', 'disabled', 'checked', 'hidden']);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Unbiased random integer in [0, n) using the platform CSPRNG.
function randomInt(n) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents) => usd.format(cents / 100);
const moneyShort = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : usd.format(cents / 100));

function parseMoney(str) {
  const s = String(str).trim().replace(/^\$/, '');
  if (!/^\d*\.?\d{0,2}$/.test(s) || s === '' || s === '.') return NaN;
  return Math.round(parseFloat(s) * 100);
}

function toast(message, { action, onAction, bad = false, ms = 3500 } = {}) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, h('span', null, message));
  const dismiss = () => el.remove();
  if (action) {
    el.append(h('button', { onclick: () => { dismiss(); onAction && onAction(); } }, action));
  }
  toastsEl.append(el);
  setTimeout(dismiss, ms);
  return dismiss;
}

function openModal(content, { dismissable = true, onClose } = {}) {
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' }, content);
  const close = () => {
    overlay.remove();
    if (!modalsEl.children.length) document.body.classList.remove('modal-open');
    if (onClose) onClose();
  };
  if (dismissable) overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  modalsEl.append(overlay);
  document.body.classList.add('modal-open');
  return { close, overlay };
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let m;
    const done = (v) => { m.close(); resolve(v); };
    m = openModal(
      h('div', { class: 'modal' },
        h('h2', null, title),
        h('p', { class: 'msg' }, message),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => done(false) }, cancelLabel),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => done(true) }, confirmLabel))),
      { dismissable: false });
  });
}

/* ---------- state + persistence ---------- */

const emptyState = () => ({ v: 1, phase: 'setup', types: [], sales: [], tickets: [], winners: [] });

let S = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.v === 1 ? s : null;
  } catch (e) {
    return null;
  }
}

let storageWarned = false;
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
    return true;
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      toast('Could not save to this device — storage may be full or blocked.', { bad: true, ms: 8000 });
    }
    return false;
  }
}

function clearState() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  S = null;
}

const raffleInProgress = () => !!S && (S.phase === 'live' || S.types.length > 0);

/* ---------- pricing ---------- */

// Cheapest price for `qty` tickets: full bundles, then the remainder at
// whichever is lower — singles or one more bundle.
function priceFor(type, qty) {
  if (qty <= 0) return 0;
  if (!type.bundleQty) return qty * type.price;
  const bundles = Math.floor(qty / type.bundleQty);
  const rest = qty % type.bundleQty;
  return bundles * type.bundlePrice + Math.min(rest * type.price, rest ? type.bundlePrice : 0);
}

function priceLabel(type) {
  const base = `${moneyShort(type.price)} each`;
  return type.bundleQty ? `${base} · ${type.bundleQty} for ${moneyShort(type.bundlePrice)}` : base;
}

const drumCount = (typeId) => S.tickets.reduce((n, t) => n + (t.typeId === typeId && !t.drawn ? 1 : 0), 0);

/* ---------- navigation ---------- */

function show(node) {
  appEl.replaceChildren(node);
  window.scrollTo(0, 0);
}

function route() {
  if (!S) return renderHome();
  if (S.phase === 'live') return renderLive();
  return renderSetup();
}

/* =====================================================================
   INSTALL
   ===================================================================== */

let deferredInstall = null;
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  toast('Raffler installed!');
  if (document.querySelector('.home')) renderHome();
});

function detectPlatform() {
  const ua = navigator.userAgent;
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // iPadOS reports as a Mac
  const ios = /iPhone|iPad|iPod/.test(ua) || touchMac;
  const android = /Android/.test(ua);
  const edge = /Edg\//.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(ua);
  const mac = /Macintosh/.test(ua) && !touchMac;
  const device = ios ? (/iPhone|iPod/.test(ua) ? 'iPhone' : 'iPad') : android ? 'Android' : mac ? 'Mac' : 'computer';
  return { ios, android, edge, firefox, safari, mac, device };
}

function installSteps(p) {
  if (p.ios) {
    return [
      p.safari ? null : 'If these steps are missing in this browser, open this page in Safari instead.',
      'Tap the Share button (a square with an arrow pointing up) in the toolbar.',
      'Scroll down and tap “Add to Home Screen”.',
      'Tap “Add”. Raffler will appear on your Home Screen and run full screen, even offline.',
    ];
  }
  if (p.android) {
    return p.firefox
      ? ['Tap the ⋮ menu in Firefox.', 'Tap “Install”.', 'Confirm by tapping “Add”.']
      : ['Tap the ⋮ menu in the top corner of your browser.', 'Tap “Install app” (or “Add to Home screen”).', 'Confirm by tapping “Install”.'];
  }
  if (p.mac && p.safari) {
    return ['In the menu bar choose File → Add to Dock… (Safari 17 or newer).', 'Click “Add”. Raffler will appear in your Dock and Launchpad.'];
  }
  if (p.firefox) {
    return ['Firefox on desktop can’t install web apps.', 'Open this page in Chrome or Edge, then use the Install button there.'];
  }
  return [
    p.edge ? 'Click the ⋯ menu → Apps → “Install this site as an app”.' : 'Click the install icon (a monitor with a down arrow) at the right end of the address bar, or open the ⋮ menu → “Install Raffler…”.',
    'Click “Install”. Raffler will open in its own window and work offline.',
  ];
}

function showInstallHelp() {
  const p = detectPlatform();
  let m;
  m = openModal(
    h('div', { class: 'modal' },
      h('h2', null, `Install on your ${p.device}`),
      h('p', { class: 'msg' }, 'Installing makes Raffler launch like a regular app and keeps your raffle data available offline.'),
      h('ol', null, installSteps(p).filter(Boolean).map((s) => h('li', null, s))),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')));
}

async function onInstallClick() {
  if (deferredInstall) {
    const evt = deferredInstall;
    deferredInstall = null;
    evt.prompt();
    try { await evt.userChoice; } catch (e) { /* ignore */ }
    return;
  }
  showInstallHelp();
}

/* =====================================================================
   HOME
   ===================================================================== */

function renderHome() {
  const standalone = isStandalone();
  show(
    h('main', { class: 'home' },
      h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
      h('h1', null, 'Raffler'),
      h('p', { class: 'tag' }, 'Community prize raffles without the paper tickets. Works fully offline.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn accent big block', onclick: startNew }, 'START NEW RAFFLE'),
        standalone
          ? h('p', { class: 'installed' }, '✓ Running as an installed app')
          : h('button', { class: 'btn ghost big block', id: 'install-btn', onclick: onInstallClick }, '⬇ INSTALL')),
      h('p', { class: 'foot' }, 'Everything is stored on this device.')));
  if (raffleInProgress() && !modalsEl.children.length) promptResume();
}

function startNew() {
  S = emptyState();
  saveState();
  route();
}

function promptResume() {
  const live = S.phase === 'live';
  const sold = S.tickets.length;
  const summary = live
    ? `${sold} ticket${sold === 1 ? '' : 's'} sold, ${S.winners.length} winner${S.winners.length === 1 ? '' : 's'} drawn.`
    : `${S.types.length} ticket type${S.types.length === 1 ? '' : 's'} set up so far.`;
  let m;
  m = openModal(
    h('div', { class: 'modal' },
      h('h2', null, 'A raffle is in progress'),
      h('p', { class: 'msg' }, `${summary} Would you like to pick up where you left off?`),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn ghost',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Erase everything?',
              message: 'This permanently deletes all ticket types, sales, and winners on this device. This cannot be undone.',
              confirmLabel: 'Erase & start over',
              danger: true,
            });
            if (!ok) return;
            m.close();
            clearState();
            startNew();
          },
        }, 'Start over'),
        h('button', { class: 'btn primary', onclick: () => { m.close(); route(); } }, 'Continue'))),
    { dismissable: false });
}

/* =====================================================================
   SETUP MODE
   ===================================================================== */

function renderSetup() {
  let editingId = null;

  const nameIn = h('input', { class: 'input', type: 'text', id: 'f-name', maxlength: '40', autocomplete: 'off', placeholder: 'e.g. Blue Ticket' });
  const priceIn = h('input', { class: 'input', type: 'text', id: 'f-price', inputmode: 'decimal', autocomplete: 'off', placeholder: '1.00' });
  const bundleChk = h('input', { type: 'checkbox', id: 'f-bundle', onchange: () => { bundleBox.hidden = !bundleChk.checked; } });
  const bQtyIn = h('input', { class: 'input', type: 'text', id: 'f-bqty', inputmode: 'numeric', autocomplete: 'off', placeholder: '6' });
  const bPriceIn = h('input', { class: 'input', type: 'text', id: 'f-bprice', inputmode: 'decimal', autocomplete: 'off', placeholder: '5.00' });
  const bundleBox = h('div', { class: 'bundle-fields', hidden: true },
    h('div', { class: 'field' }, h('label', { for: 'f-bqty' }, 'Bundle quantity'), bQtyIn),
    h('div', { class: 'field' }, h('label', { for: 'f-bprice' }, 'Bundle price ($)'), bPriceIn));
  const errEl = h('p', { class: 'error', role: 'alert' });
  const submitBtn = h('button', { class: 'btn primary', onclick: submit }, 'Add ticket type');
  const cancelBtn = h('button', { class: 'btn ghost', hidden: true, onclick: resetForm }, 'Cancel');
  const formTitle = h('h2', null, 'New ticket type');
  const listEl = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  const finishBtn = h('button', { class: 'btn accent big', onclick: finish }, 'FINISH SETUP →');
  const hintEl = h('p', { class: 'hint' });

  function resetForm() {
    editingId = null;
    nameIn.value = priceIn.value = bQtyIn.value = bPriceIn.value = '';
    bundleChk.checked = false;
    bundleBox.hidden = true;
    errEl.textContent = '';
    for (const el of [nameIn, priceIn, bQtyIn, bPriceIn]) el.classList.remove('invalid');
    formTitle.textContent = 'New ticket type';
    submitBtn.textContent = 'Add ticket type';
    cancelBtn.hidden = true;
  }

  function fail(msg, ...fields) {
    errEl.textContent = msg;
    for (const el of [nameIn, priceIn, bQtyIn, bPriceIn]) el.classList.toggle('invalid', fields.includes(el));
    if (fields[0]) fields[0].focus();
  }

  function submit() {
    const name = nameIn.value.trim();
    if (!name) return fail('Give this ticket type a name.', nameIn);
    if (S.types.some((t) => t.id !== editingId && t.name.toLowerCase() === name.toLowerCase())) {
      return fail('Another ticket type already has that name.', nameIn);
    }
    const price = parseMoney(priceIn.value);
    if (!(price > 0)) return fail('Enter a price per ticket, like 1 or 0.50.', priceIn);

    let bundleQty = null;
    let bundlePrice = null;
    if (bundleChk.checked) {
      bundleQty = /^\d+$/.test(bQtyIn.value.trim()) ? parseInt(bQtyIn.value, 10) : NaN;
      if (!(bundleQty >= 2)) return fail('Bundle quantity must be a whole number of 2 or more.', bQtyIn);
      bundlePrice = parseMoney(bPriceIn.value);
      if (!(bundlePrice > 0)) return fail('Enter the bundle price.', bPriceIn);
      if (bundlePrice >= bundleQty * price) return fail('The bundle should cost less than buying that many singly.', bPriceIn);
    }

    if (editingId) {
      Object.assign(S.types.find((t) => t.id === editingId), { name, price, bundleQty, bundlePrice });
    } else {
      S.types.push({ id: uid(), name, price, bundleQty, bundlePrice, nextNo: 1 });
    }
    saveState();
    resetForm();
    refresh();
    nameIn.focus();
  }

  function edit(t) {
    editingId = t.id;
    nameIn.value = t.name;
    priceIn.value = (t.price / 100).toFixed(2);
    bundleChk.checked = !!t.bundleQty;
    bundleBox.hidden = !t.bundleQty;
    bQtyIn.value = t.bundleQty || '';
    bPriceIn.value = t.bundlePrice ? (t.bundlePrice / 100).toFixed(2) : '';
    errEl.textContent = '';
    formTitle.textContent = `Edit “${t.name}”`;
    submitBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    nameIn.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async function remove(t) {
    const ok = await confirmDialog({ title: `Remove “${t.name}”?`, message: 'This ticket type will be deleted.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    S.types = S.types.filter((x) => x.id !== t.id);
    saveState();
    if (editingId === t.id) resetForm();
    refresh();
  }

  async function finish() {
    const ok = await confirmDialog({
      title: 'Start selling?',
      message: 'Once you start, ticket types and prices can’t be changed — there is no going back to setup. To change them you’d have to erase everything and start a new raffle.',
      confirmLabel: 'Start selling',
    });
    if (!ok) return;
    S.phase = 'live';
    saveState();
    route();
  }

  function refresh() {
    listEl.replaceChildren(
      ...S.types.map((t) =>
        h('div', { class: 'card type-card' },
          h('div', { class: 'info' }, h('div', { class: 'name' }, t.name), h('div', { class: 'price' }, priceLabel(t))),
          h('div', { class: 'btns' },
            h('button', { class: 'btn small ghost', onclick: () => edit(t) }, 'Edit'),
            h('button', { class: 'btn small ghost', onclick: () => remove(t) }, 'Remove')))));
    finishBtn.disabled = S.types.length === 0;
    hintEl.textContent = S.types.length ? '' : 'Add at least one ticket type to continue.';
  }

  show(
    h('div', null,
      h('main', { class: 'screen' },
        h('div', { class: 'screen-head' },
          h('span', { class: 'step-badge' }, 'SETUP MODE'),
          h('h1', null, 'Set up your raffle'),
          h('p', null, 'Create one or more ticket types, each with a price. Optionally add a bundle deal, like “6 for $5”.')),
        listEl,
        h('section', { class: 'card', style: 'display:flex;flex-direction:column;gap:16px' },
          formTitle,
          h('div', { class: 'form-grid' },
            h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Name'), nameIn),
            h('div', { class: 'field' }, h('label', { for: 'f-price' }, 'Price per ticket ($)'), priceIn),
            h('label', { class: 'switch full', for: 'f-bundle' }, bundleChk, 'Offer a bundle deal'),
            bundleBox),
          errEl,
          h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' }, submitBtn, cancelBtn))),
      h('div', { class: 'footer-bar' },
        h('div', { class: 'inner' }, finishBtn, hintEl))));
  refresh();
}

/* =====================================================================
   SELL / DRAW MODE
   ===================================================================== */

function renderLive() {
  const draft = { qty: Object.fromEntries(S.types.map((t) => [t.id, 0])) };

  const buyerIn = h('input', { class: 'input', type: 'text', id: 'f-buyer', autocomplete: 'off', autocapitalize: 'words', maxlength: '60', placeholder: 'Buyer’s name' });
  const contactIn = h('input', { class: 'input', type: 'text', id: 'f-contact', autocomplete: 'off', autocapitalize: 'none', maxlength: '80', placeholder: 'Phone or email (optional)' });
  const totalEl = h('div', { class: 'amount' }, '$0');
  const countEl = h('div', { class: 'count' });
  const saveBtn = h('button', { class: 'btn primary big', onclick: save }, 'SAVE');
  const winnersCount = h('span', { class: 'badge' }, '0');
  const rows = new Map();

  function totals() {
    let cents = 0;
    let tickets = 0;
    for (const t of S.types) {
      cents += priceFor(t, draft.qty[t.id]);
      tickets += draft.qty[t.id];
    }
    return { cents, tickets };
  }

  function setQty(t, n) {
    const q = Math.max(0, Math.min(999, Number.isFinite(n) ? n : 0));
    draft.qty[t.id] = q;
    const r = rows.get(t.id);
    if (document.activeElement !== r.input) r.input.value = q;
    r.sub.textContent = q ? money(priceFor(t, q)) : '—';
    r.sub.classList.toggle('zero', !q);
    updateTotal();
  }

  function updateTotal() {
    const { cents, tickets } = totals();
    totalEl.textContent = money(cents);
    countEl.textContent = tickets ? `${tickets} ticket${tickets === 1 ? '' : 's'}` : 'No tickets selected';
    saveBtn.disabled = tickets === 0;
  }

  function refreshCounts() {
    winnersCount.textContent = S.winners.length;
    for (const t of S.types) rows.get(t.id).drum.textContent = `${drumCount(t.id)} in the drum`;
  }

  function save() {
    const { cents, tickets } = totals();
    if (!tickets) return;
    const buyer = buyerIn.value.trim();
    if (!buyer) {
      buyerIn.classList.add('invalid');
      buyerIn.focus();
      buyerIn.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('Enter the buyer’s name first.', { bad: true });
      return;
    }
    const sale = { id: uid(), ts: Date.now(), buyer, contact: contactIn.value.trim(), items: {}, total: cents };
    const startNos = {};
    for (const t of S.types) {
      const q = draft.qty[t.id];
      if (!q) continue;
      sale.items[t.id] = q;
      startNos[t.id] = t.nextNo;
      for (let i = 0; i < q; i++) S.tickets.push({ typeId: t.id, no: t.nextNo++, saleId: sale.id, drawn: false });
    }
    S.sales.push(sale);
    saveState();

    buyerIn.value = contactIn.value = '';
    buyerIn.classList.remove('invalid');
    for (const t of S.types) setQty(t, 0);
    refreshCounts();
    document.activeElement && document.activeElement.blur();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast(`Saved ${tickets} ticket${tickets === 1 ? '' : 's'} for ${buyer} · ${money(cents)}`, {
      action: 'UNDO',
      ms: 10000,
      onAction: () => undoSale(sale, startNos),
    });
  }

  // Only the most recent sale can be undone, and only while none of its tickets were drawn.
  function undoSale(sale, startNos) {
    const last = S.sales[S.sales.length - 1];
    const mine = S.tickets.filter((t) => t.saleId === sale.id);
    if (!last || last.id !== sale.id || mine.some((t) => t.drawn)) {
      toast('That sale can’t be undone any more.', { bad: true });
      return;
    }
    S.sales.pop();
    S.tickets = S.tickets.filter((t) => t.saleId !== sale.id);
    for (const t of S.types) if (startNos[t.id]) t.nextNo = startNos[t.id];
    saveState();
    refreshCounts();
    toast('Sale undone.');
  }

  const sellRows = S.types.map((t) => {
    const input = h('input', {
      type: 'text', inputmode: 'numeric', pattern: '[0-9]*', 'aria-label': `${t.name} quantity`, value: '0',
      onfocus: (e) => e.target.select(),
      oninput: (e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
        e.target.value = digits;
        setQty(t, digits ? parseInt(digits, 10) : 0);
      },
      onblur: (e) => { e.target.value = draft.qty[t.id]; },
    });
    const sub = h('div', { class: 'sub zero' }, '—');
    const drum = h('div', { class: 'drum-count' });
    rows.set(t.id, { input, sub, drum });
    return h('div', { class: 'sell-row' },
      h('div', { class: 'info' }, h('div', { class: 'name' }, t.name), h('div', { class: 'price' }, priceLabel(t)), drum),
      h('div', { class: 'stepper' },
        h('button', { 'aria-label': `Fewer ${t.name}`, onclick: () => setQty(t, draft.qty[t.id] - 1) }, '−'),
        input,
        h('button', { class: 'plus', 'aria-label': `More ${t.name}`, onclick: () => setQty(t, draft.qty[t.id] + 1) }, '+')),
      sub);
  });

  buyerIn.addEventListener('input', () => buyerIn.classList.remove('invalid'));

  show(
    h('div', null,
      h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, h('img', { src: 'icons/icon-192.png', alt: '' }), h('span', null, 'Raffler')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost', onclick: showWinners }, 'WINNERS ', winnersCount),
          h('button', { class: 'btn accent', onclick: startDraw }, '🎟️ DRAW'))),
      h('main', { class: 'screen' },
        h('div', { class: 'screen-head' }, h('span', { class: 'step-badge' }, 'SELL / DRAW MODE'), h('h1', null, 'Sell tickets')),
        h('section', { class: 'card' }, sellRows),
        h('section', { class: 'card', style: 'display:flex;flex-direction:column;gap:16px' },
          h('div', { class: 'field' }, h('label', { for: 'f-buyer' }, 'Buyer’s name'), buyerIn),
          h('div', { class: 'field' }, h('label', { for: 'f-contact' }, 'Contact'), contactIn,
            h('span', { class: 'hint' }, 'Used to reach the buyer if they win.'))),
        h('p', { class: 'hint', style: 'text-align:center' }, 'Tap SAVE only after you’ve collected the money — saved tickets go straight into the drum.')),
      h('div', { class: 'footer-bar pay-bar' },
        h('div', { class: 'inner' },
          h('div', { class: 'total' }, h('span', { class: 'label' }, 'Total due'), totalEl, countEl),
          saveBtn))));

  refreshCounts();
  updateTotal();

  /* ----- winners ----- */

  function showWinners() {
    let m;
    const list = S.winners.length
      ? h('ul', { class: 'winner-list' },
          [...S.winners].reverse().map((w) =>
            h('li', null,
              h('span', { class: 'num' }, `#${w.no}`),
              h('span', { class: 'who' }, w.buyer),
              h('span', { class: 'when' }, new Date(w.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
              h('span', { class: 'meta' }, `${w.typeName} · ${w.contact || 'no contact info'}`))))
      : h('p', { class: 'empty' }, 'No tickets have been drawn yet.');
    m = openModal(
      h('div', { class: 'modal wide' },
        h('h2', null, `Winners (${S.winners.length})`),
        list,
        h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close')));
  }

  /* ----- draw ----- */

  function startDraw() {
    let m;
    const choices = S.types.map((t) => {
      const n = drumCount(t.id);
      return h('button', { class: 'btn', disabled: n === 0, onclick: () => { m.close(); drawFrom(t); } },
        h('span', null, t.name), h('span', { class: 'count' }, `${n} left`));
    });
    m = openModal(
      h('div', { class: 'modal' },
        h('h2', null, 'Which raffle are we drawing?'),
        h('div', { class: 'type-pick' }, choices),
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel')));
  }

  function drawFrom(type) {
    const pool = S.tickets.filter((t) => t.typeId === type.id && !t.drawn);
    if (!pool.length) { toast('No tickets left for that raffle.', { bad: true }); return; }
    const saleById = new Map(S.sales.map((s) => [s.id, s]));
    const ticket = pool[randomInt(pool.length)];
    const sale = saleById.get(ticket.saleId);

    // Record the result up front so a ticket can never be drawn twice, even if the app closes mid-animation.
    ticket.drawn = true;
    S.winners.push({ id: uid(), ts: Date.now(), typeId: type.id, typeName: type.name, no: ticket.no, buyer: sale.buyer, contact: sale.contact });
    saveState();
    refreshCounts();

    runDrawAnimation(type, pool.map((t) => saleById.get(t.saleId).buyer), ticket, sale);
  }

  function runDrawAnimation(type, names, ticket, sale) {
    const shuffleEl = h('div', { class: 'shuffle' }, '…');
    const stage = h('div', { class: 'draw-stage', 'aria-live': 'polite' },
      h('div', { class: 'drum', 'aria-hidden': 'true' }, '🎟️'),
      h('div', { class: 'drawing' }, `Drawing ${type.name}…`),
      shuffleEl);
    const sparks = ['✨', '⭐', '🎉', '✨', '🌟', '🎊'].map((s, i) =>
      h('span', { class: 'spark', 'aria-hidden': 'true', style: `left:${8 + i * 17}%;top:${i % 2 ? 14 : 78}%;animation-delay:${i * 0.17}s` }, s));
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const overlay = h('div', { class: 'draw-overlay', role: 'dialog', 'aria-modal': 'true' }, sparks, canvas, stage);
    modalsEl.append(overlay);
    document.body.classList.add('modal-open');

    const start = performance.now();
    let timer;
    const tick = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= DRAW_MS) return reveal();
      shuffleEl.textContent = names[randomInt(names.length)];
      // Start fast, slow down as the draw nears its end.
      const next = 60 + Math.pow(elapsed / DRAW_MS, 2) * 260;
      timer = setTimeout(tick, Math.min(next, DRAW_MS - elapsed));
    };
    tick();

    function reveal() {
      clearTimeout(timer);
      const close = () => {
        overlay.remove();
        if (!modalsEl.children.length) document.body.classList.remove('modal-open');
      };
      const remaining = drumCount(type.id);
      stage.replaceChildren(
        h('div', { class: 'reveal', style: 'display:flex;flex-direction:column;align-items:center;gap:18px' },
          h('div', { class: 'banner' }, '🎉 WINNER 🎉'),
          h('div', { class: 'kind' }, `${type.name} · Ticket #${ticket.no}`),
          h('div', { class: 'name' }, sale.buyer),
          sale.contact
            ? h('div', { class: 'contact' }, sale.contact)
            : h('div', { class: 'contact none' }, 'No contact info provided'),
          h('div', { class: 'row' },
            h('button', { class: 'btn ghost big', onclick: close }, 'DONE'),
            remaining
              ? h('button', { class: 'btn accent big', onclick: () => { close(); drawFrom(type); } }, `DRAW ANOTHER (${remaining} left)`)
              : h('p', { class: 'kind', style: 'align-self:center' }, 'That was the last ticket in the drum.'))));
      confetti(canvas);
    }
  }
}

/* ---------- confetti ---------- */

function confetti(canvas) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dpr = window.devicePixelRatio || 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const hgt = (canvas.height = canvas.clientHeight * dpr);
  const ctx = canvas.getContext('2d');
  const colors = ['#ffb703', '#ff5d8f', '#5ee3ff', '#9b8cff', '#7bf1a8', '#ffffff'];
  const bits = Array.from({ length: 160 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.25,
    y: hgt * 0.35,
    vx: (Math.random() - 0.5) * 22 * dpr,
    vy: (-Math.random() * 20 - 6) * dpr,
    size: (6 + Math.random() * 8) * dpr,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    color: colors[randomInt(colors.length)],
  }));
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    ctx.clearRect(0, 0, w, hgt);
    for (const b of bits) {
      b.vy += 0.5 * dpr;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      ctx.globalAlpha = Math.max(0, 1 - t / 4200);
      ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
      ctx.restore();
    }
    if (t < 4200 && canvas.isConnected) requestAnimationFrame(frame);
  })(t0);
}

/* =====================================================================
   BOOT
   ===================================================================== */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
  });
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// On launch always show the home screen; if a raffle is in progress it offers Continue / Start over.
renderHome();
