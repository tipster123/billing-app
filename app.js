/* ==========================================================================
   Billing & Inventory — app (views, actions, events)
   Branches · staff accounts & permissions · stock transfers · expenses
   ========================================================================== */
(function () {
  'use strict';

  var S = window.Store;
  /* Which copy of the app is running. APP_VERSION only changes when the app
     files change (keep it in step with VERSION in sw.js and the ?v= strings in
     index.html); APP_BRANCH is the git branch this build came from. */
  var APP_VERSION = 'v146';
  var APP_BRANCH = 'newfix1';

  var db = null;
  var ui = {
    tab: 'dashboard', branch: '',
    q: '', qInv: '', qItems: '', qCust: '', qExp: '', qStaff: '', supQ: '', custOpen: '', f: {},
    custFilter: 'all', custSort: 'name', custMore: '', custSortMenu: false,
    invMore: '',
    staffMore: '',
    staffOpen: '',
    itemOpen: '', itemMore: '', itemHist: 'all', itmAll: false, purchMenu: '', purchMore: 0, partyTab: 'customers', supMenu: '', supFilter: 'all',
    inv: { status: 'all', page: 1, per: 12 },
    rep: { from: '', to: '' }, bill: null, transfer: null,
    settingsTab: 'company', scCharges: null, scTerms: null, scFields: null, pdf: null, previewStyle: '',
    expLink: { q: '', ids: [] },
    bin: { q: '', kind: 'all', sort: 'new' }
  };

  var esc = S.esc, money = S.money, num = S.num, r2 = S.r2,
      fmtDate = S.fmtDate, today = S.today, uid = S.uid, match = S.match;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  var _scriptLoads = {};
  function loadScript(src) {
    if (_scriptLoads[src]) return _scriptLoads[src];
    _scriptLoads[src] = new Promise(function (resolve, reject) {
      var el = document.querySelector('script[src="' + src + '"]');
      if (el && (window.html2canvas || window.jspdf || window.jsPDF || window.qrcode)) { resolve(); return; }
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
    return _scriptLoads[src];
  }
  function ensureHtml2Canvas() { return window.html2canvas ? Promise.resolve() : loadScript('html2canvas.min.js'); }
  function ensureJsPdf() { return (window.jspdf || window.jsPDF) ? Promise.resolve() : loadScript('jspdf.umd.min.js'); }

  var lastUndo = null;
  function toast(msg, opt) {
    var el = $('#toast');
    opt = opt && typeof opt === 'object' ? opt : null;
    if (opt && opt.undo) {
      lastUndo = opt.undo;
      el.innerHTML = '<span class="tmsg">' + esc(msg) + '</span><button type="button" class="tundo" data-act="do-undo">Undo</button>';
      clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.remove('show'); lastUndo = null; }, 6000);
    } else {
      lastUndo = null;
      el.textContent = msg;
      clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.remove('show'); }, 2400);
    }
    el.classList.add('show');
  }
  function logActivity(text, type) {
    if (!db) return;
    var me = S.currentStaff() || {};
    if (!Array.isArray(db.activity)) db.activity = [];
    db.activity.unshift({
      id: uid(), at: Date.now(), date: today(),
      text: String(text || ''),
      type: String(type || 'info'),
      who: me.name || 'Someone',
      whoId: me.id || '',
      branch: branchName(ui.branch)
    });
    if (db.activity.length > 150) db.activity.length = 150;
  }
  function can(p) { return S.can(p); }
  function itemById(id) { return db.items.filter(function (i) { return i.id === id; })[0] || null; }
  function findCust(id) { return db.customers.filter(function (c) { return c.id === id; })[0] || null; }
  function staffById(id) { return db.staff.filter(function (s) { return s.id === id; })[0] || null; }
  function invById(id) { return db.invoices.filter(function (i) { return i.id === id; })[0] || null; }
  function branchName(id) { return S.branchName(id); }
  function stockOf(it, b) { return S.stockOf(it, b || ui.branch); }
  function pendingDamages(bid) {
    return db.damages.filter(function (d) {
      return d.branchId === (bid || ui.branch) && !d.adjusted;
    });
  }
  function branchPrefix(bid) {
    var b = S.branchById(bid || ui.branch);
    return String((b && b.prefix) || db.settings.prefix || 'INV').trim().toUpperCase() || 'INV';
  }
  function invState() {
    if (!ui.inv) ui.inv = { status: 'all', page: 1, per: 12 };
    if (ui.inv.tab !== 'est') ui.inv.tab = 'bills';
    if (!ui.inv.status) ui.inv.status = 'all';
    if (!ui.inv.page) ui.inv.page = 1;
    if (!ui.inv.per) ui.inv.per = 12;
    return ui.inv;
  }
  var snapDayDone = '';
  function save() {
    if (S.save()) {
      cloudSchedule();
      if (snapDayDone !== today() && captureDailySnapshot()) snapDayDone = today();
    }
  }


  /* --------------------------------------------------- snapshots and the bin
     Two safety nets for a shop that only has this browser:
     • a quiet copy of the whole database is kept once a day (the last 7 days),
       so "restore from yesterday" exists after a mistake;
     • deleting a bill, item, party or expense parks it in a 7-day bin instead
       of throwing it away. */
  var SNAP_KEY = 'billing.snapshots.v1';
  var TRASH_KEY = 'billing.trash.v1';
  var SNAP_KEEP = 7;
  var TRASH_DAYS = 7;

  function readLocalJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeLocalJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  function snapshots() {
    var list = readLocalJson(SNAP_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  /* one snapshot per calendar day; older days beyond a week are dropped */
  function captureDailySnapshot(force) {
    if (!db || !db.settings) return false;
    var list = snapshots();
    var day = today();
    var last = list[list.length - 1];
    if (!force && last && last.day === day) return false;
    try {
      list.push({ day: day, at: Date.now(), data: JSON.stringify(db) });
    } catch (e) { return false; }
    var byDay = {};
    list.forEach(function (x) { if (x && x.day) byDay[x.day] = x; });
    var keep = Object.keys(byDay).sort().slice(-SNAP_KEEP).map(function (d) { return byDay[d]; });
    writeLocalJson(SNAP_KEY, keep);
    return true;
  }

  function trashEntries() {
    var list = readLocalJson(TRASH_KEY, []);
    if (!Array.isArray(list)) return [];
    var cut = Date.now() - TRASH_DAYS * 86400000;
    var live = list.filter(function (x) { return x && x.at >= cut; });
    if (live.length !== list.length) writeLocalJson(TRASH_KEY, live);
    return live;
  }
  function trashAdd(entry) {
    if (!entry) return;
    var list = trashEntries();
    entry.id = uid();
    entry.at = Date.now();
    list.push(entry);
    writeLocalJson(TRASH_KEY, list.slice(-200));
  }
  function trashRestore(trashId) {
    var list = trashEntries();
    var e = list.filter(function (x) { return x.id === trashId; })[0];
    if (!e) return toast('That one is past its 7 days');
    var arrName = { invoice: 'invoices', item: 'items', customer: 'customers', supplier: 'suppliers',
      expense: 'expenses', purchase: 'purchases', damage: 'damages', transfer: 'transfers',
      complaint: 'complaints' }[e.kind];
    if (!arrName || !e.rec) return toast('This entry cannot be restored');
    if ((db[arrName] || []).some(function (x) { return x.id === e.rec.id; })) return toast('It is already back');
    /* the delete put stock back, so restoring takes it out again */
    (e.stockBack || []).forEach(function (m) {
      var it = itemById(m.itemId);
      if (it) S.addStock(it, m.branchId, -(Number(m.qty) || 0));
    });
    db[arrName].push(e.rec);
    writeLocalJson(TRASH_KEY, list.filter(function (x) { return x.id !== trashId; }));
    save(); render();
    toast('Restored ' + (e.name || 'entry'));
  }
  function trashEmpty() {
    writeLocalJson(TRASH_KEY, []);
    save(); render();
    toast('Bin emptied');
  }

  /* daily copies shown in settings; deleted entries live on their own Bin page */
  function safetyNetHTML() {
    var snaps = snapshots();
    var older = snaps.filter(function (x) { return x.day < today(); });
    var latest = older[older.length - 1];
    return `<div class="card"><h3>Daily copies</h3>
      <div class="sub" style="margin-bottom:10px">A copy of everything is saved once a day on this device — the last ${SNAP_KEEP} days.</div>
      <div class="row-actions" style="margin-bottom:12px">
        <button class="btn" data-act="restore-yesterday"${latest ? '' : ' disabled'}>Restore from ${latest ? fmtDate(latest.day) : 'yesterday'}</button>
        <button class="btn" data-act="snapshot-now">Save a copy now</button>
      </div>
      <div class="sub">${snaps.length ? 'Copies kept: ' + snaps.map(function (x) { return fmtDate(x.day); }).join(', ') : 'No daily copy yet — one is made the first time the app is opened each day.'}</div>
    </div>`;
  }

  function binState() {
    if (!ui.bin || typeof ui.bin !== 'object') ui.bin = { q: '', kind: 'all', sort: 'new' };
    if (!ui.bin.q) ui.bin.q = '';
    if (!ui.bin.kind) ui.bin.kind = 'all';
    if (!ui.bin.sort) ui.bin.sort = 'new';
    return ui.bin;
  }
  function binKindLabel(kind) {
    var labels = {
      invoice: 'Invoice',
      item: 'Item',
      customer: 'Customer',
      supplier: 'Supplier',
      expense: 'Expense',
      purchase: 'Purchase',
      damage: 'Damage / loss',
      transfer: 'Transfer',
      complaint: 'Complaint'
    };
    return labels[kind] || (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Entry');
  }
  function binKinds() {
    return ['invoice', 'item', 'customer', 'supplier', 'expense', 'purchase', 'damage', 'transfer', 'complaint'];
  }
  function binDaysLeft(e) {
    return Math.ceil((TRASH_DAYS * 86400000 - (Date.now() - (e.at || 0))) / 86400000);
  }
  function viewBin() {
    var st = binState();
    var all = trashEntries();
    var kinds = binKinds();
    var q = String(st.q || '').trim().toLowerCase();
    var filtered = all.filter(function (e) {
      if (st.kind && st.kind !== 'all' && e.kind !== st.kind) return false;
      if (!q) return true;
      var hay = [e.name || '', e.sub || '', e.kind || '', binKindLabel(e.kind)].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    filtered.sort(function (a, b) {
      if (st.sort === 'old') return (a.at || 0) - (b.at || 0);
      if (st.sort === 'exp') return binDaysLeft(a) - binDaysLeft(b) || (a.at || 0) - (b.at || 0);
      return (b.at || 0) - (a.at || 0);
    });
    var rows = filtered.map(function (e) {
      var days = binDaysLeft(e);
      var age = days > 0 ? days + ' day' + (days === 1 ? '' : 's') + ' left' : 'last day';
      var when = new Date(e.at || Date.now());
      var whenDay = when.getFullYear() + '-' + String(when.getMonth() + 1).padStart(2, '0') + '-' + String(when.getDate()).padStart(2, '0');
      var meta = [binKindLabel(e.kind), fmtDate(whenDay), age];
      if (e.sub) meta.splice(1, 0, e.sub);
      return `<div class="rrow"><div class="grow"><div class="title">${esc(e.name || 'Entry')}</div>
        <div class="sub">${esc(meta.join(' · '))}</div></div>
        <div class="amt"><button class="btn sm" data-act="trash-restore" data-id="${esc(e.id)}">Restore</button></div></div>`;
    }).join('');
    var kindOpts = '<option value="all"' + (st.kind === 'all' ? ' selected' : '') + '>All types</option>' +
      kinds.map(function (k) { return '<option value="' + esc(k) + '"' + (st.kind === k ? ' selected' : '') + '>' + esc(binKindLabel(k)) + '</option>'; }).join('');
    /* one tap per type, with how many of each are waiting */
    var counts = { all: all.length };
    all.forEach(function (e) { counts[e.kind] = (counts[e.kind] || 0) + 1; });
    var chipKinds = ['all'].concat(kinds.filter(function (k) { return counts[k]; }));
    var chips = all.length ? '<div class="rep-chips" style="margin:0 0 10px">' + chipKinds.map(function (k) {
      return '<button type="button" data-act="bin-filter" data-id="' + esc(k) + '" class="' + (st.kind === k ? 'on' : '') + '">' +
        esc(k === 'all' ? 'All' : binKindLabel(k)) + ' (' + (counts[k] || 0) + ')</button>';
    }).join('') + '</div>' : '';
    var sortOpts = [
      ['new', 'Newest deleted'],
      ['old', 'Oldest deleted'],
      ['exp', 'Expiring soon']
    ].map(function (o) { return '<option value="' + o[0] + '"' + (st.sort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    return `<div class="page-head"><div><h2>Bin</h2><div class="sub">Deleted entries are kept for ${TRASH_DAYS} days. Restore anything you removed by mistake.</div></div></div>
      <div class="card">
        ${chips}
        <div class="bin-filters" style="margin-bottom:12px">
          <input class="inp" type="search" data-input="q-bin" placeholder="Search by name, detail or type" value="${esc(st.q || '')}" autocomplete="off">
          <select class="inp" data-change="bin-kind" aria-label="Filter by type">${kindOpts}</select>
          <select class="inp" data-change="bin-sort" aria-label="Sort">${sortOpts}</select>
        </div>
        <div class="sub" style="margin-bottom:10px">${filtered.length} of ${all.length} entr${all.length === 1 ? 'y' : 'ies'} shown</div>
        ${rows || '<div class="empty"><b>Nothing in the bin</b>' + (all.length ? 'No entries match these filters.' : 'Deleted bills, items, parties and other entries will appear here for ' + TRASH_DAYS + ' days.') + '</div>'}
        ${all.length ? '<div class="row-actions" style="margin-top:12px"><button class="btn danger sm" data-act="trash-empty">Empty the bin</button></div>' : ''}
      </div>`;
  }

  /* Writing to the browser can fail (storage full, private mode, blocked site
     data). Store raises this event every time so a failed save is never silent
     — the change is still in memory, but it is not on the device yet. */
  var saveErrorAt = 0;
  window.addEventListener('store-save-error', function (e) {
    var now = Date.now();
    if (now - saveErrorAt < 15000) return;
    saveErrorAt = now;
    var why = (e && e.detail && e.detail.message) || '';
    try {
      toast('Could not save on this device' + (why ? ' (' + why + ')' : '') + ' — browser storage is full. Free some space, then try again.');
    } catch (err) {}
  });

  /* ------------------------------------------------------------- cloud sync */
  var CLOUD_SQL = [
    "-- Billing & Inventory: cloud tables for Supabase",
    "-- Run this once in Supabase -> SQL Editor. Safe to run again later.",
    "",
    "create table if not exists public.app_settings (",
    "  id text primary key,",
    "  business text,",
    "  gstin text,",
    "  prefix text,",
    "  tax_rate numeric,",
    "  currency text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.app_settings enable row level security;",
    "drop policy if exists \"app all\" on public.app_settings;",
    "create policy \"app all\" on public.app_settings for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.branches (",
    "  id text primary key,",
    "  name text,",
    "  address text,",
    "  prefix text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.branches enable row level security;",
    "drop policy if exists \"app all\" on public.branches;",
    "create policy \"app all\" on public.branches for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.staff (",
    "  id text primary key,",
    "  name text,",
    "  username text,",
    "  role text,",
    "  branch_id text,",
    "  target numeric,",
    "  active boolean,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.staff enable row level security;",
    "drop policy if exists \"app all\" on public.staff;",
    "create policy \"app all\" on public.staff for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.items (",
    "  id text primary key,",
    "  name text,",
    "  sku text,",
    "  category text,",
    "  price numeric,",
    "  cost numeric,",
    "  reorder numeric,",
    "  stock jsonb,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.items enable row level security;",
    "drop policy if exists \"app all\" on public.items;",
    "create policy \"app all\" on public.items for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.customers (",
    "  id text primary key,",
    "  name text,",
    "  phone text,",
    "  email text,",
    "  address text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.customers enable row level security;",
    "drop policy if exists \"app all\" on public.customers;",
    "create policy \"app all\" on public.customers for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.suppliers (",
    "  id text primary key,",
    "  name text,",
    "  phone text,",
    "  email text,",
    "  address text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.suppliers enable row level security;",
    "drop policy if exists \"app all\" on public.suppliers;",
    "create policy \"app all\" on public.suppliers for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.invoices (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  customer_id text,",
    "  customer_name text,",
    "  branch_id text,",
    "  staff_id text,",
    "  discount numeric,",
    "  tax numeric,",
    "  total numeric,",
    "  paid numeric,",
    "  status text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.invoices enable row level security;",
    "drop policy if exists \"app all\" on public.invoices;",
    "create policy \"app all\" on public.invoices for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.estimates (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  customer_id text,",
    "  customer_name text,",
    "  branch_id text,",
    "  staff_id text,",
    "  total numeric,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.estimates enable row level security;",
    "drop policy if exists \"app all\" on public.estimates;",
    "create policy \"app all\" on public.estimates for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.purchases (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  supplier_id text,",
    "  supplier_name text,",
    "  status text,",
    "  total numeric,",
    "  branch_id text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.purchases enable row level security;",
    "drop policy if exists \"app all\" on public.purchases;",
    "create policy \"app all\" on public.purchases for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.sreturns (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  invoice_id text,",
    "  customer_name text,",
    "  branch_id text,",
    "  total numeric,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.sreturns enable row level security;",
    "drop policy if exists \"app all\" on public.sreturns;",
    "create policy \"app all\" on public.sreturns for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.preturns (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  supplier_id text,",
    "  total numeric,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.preturns enable row level security;",
    "drop policy if exists \"app all\" on public.preturns;",
    "create policy \"app all\" on public.preturns for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.transfers (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  from_branch text,",
    "  to_branch text,",
    "  status text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.transfers enable row level security;",
    "drop policy if exists \"app all\" on public.transfers;",
    "create policy \"app all\" on public.transfers for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.damages (",
    "  id text primary key,",
    "  date text,",
    "  item_id text,",
    "  item_name text,",
    "  qty numeric,",
    "  cost_value numeric,",
    "  branch_id text,",
    "  adjusted boolean,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.damages enable row level security;",
    "drop policy if exists \"app all\" on public.damages;",
    "create policy \"app all\" on public.damages for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.expenses (",
    "  id text primary key,",
    "  date text,",
    "  category text,",
    "  amount numeric,",
    "  method text,",
    "  branch_id text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.expenses enable row level security;",
    "drop policy if exists \"app all\" on public.expenses;",
    "create policy \"app all\" on public.expenses for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.staff_ledger (",
    "  id text primary key,",
    "  date text,",
    "  staff_id text,",
    "  type text,",
    "  amount numeric,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.staff_ledger enable row level security;",
    "drop policy if exists \"app all\" on public.staff_ledger;",
    "create policy \"app all\" on public.staff_ledger for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.activity (",
    "  id text primary key,",
    "  at bigint,",
    "  date text,",
    "  type text,",
    "  text text,",
    "  who text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.activity enable row level security;",
    "drop policy if exists \"app all\" on public.activity;",
    "create policy \"app all\" on public.activity for all to anon using (true) with check (true);",
    "",
    "create table if not exists public.complaints (",
    "  id text primary key,",
    "  no text,",
    "  date text,",
    "  status text,",
    "  item_name text,",
    "  customer_name text,",
    "  invoice_no text,",
    "  supplier_name text,",
    "  branch_id text,",
    "  data jsonb not null,",
    "  updated_at timestamptz not null default now()",
    ");",
    "alter table public.complaints enable row level security;",
    "drop policy if exists \"app all\" on public.complaints;",
    "create policy \"app all\" on public.complaints for all to anon using (true) with check (true);",
    "",
  ].join('\n');

  var cloudBusy = false, cloudTimer = null;

  function cloudConf() {
    if (!db || !db.settings) return { url: '', key: '', shop: '', auto: true, syncedAt: 0, lastError: '' };
    var c = db.settings.cloud;
    if (!c || typeof c !== 'object') c = db.settings.cloud = {};
    if (c.auto == null) c.auto = true;
    if (c.syncedAt == null) c.syncedAt = 0;
    if (c.lastError == null) c.lastError = '';
    return c;
  }
  function cloudReady() {
    var c = cloudConf();
    return !!(String(c.url || '').trim() && String(c.key || '').trim() && String(c.shop || '').trim());
  }
  function cloudBase() { return String(cloudConf().url || '').trim().replace(/\/+$/, ''); }

  function cloudReq(path, opts) {
    var c = cloudConf();
    opts = opts || {};
    var headers = { 'apikey': c.key, 'Authorization': 'Bearer ' + c.key, 'Content-Type': 'application/json' };
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    return fetch(cloudBase() + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (txt) {
          var msg = String(txt || '').slice(0, 200);
          throw new Error('Supabase returned ' + res.status + (msg ? ' — ' + msg : ''));
        });
      }
      var ct = res.headers.get('content-type') || '';
      return ct.indexOf('json') > -1 ? res.json() : null;
    });
  }

  function cloudSetStatus(state, msg) {
    ui.cloud = ui.cloud || {};
    ui.cloud.state = state;
    ui.cloud.msg = msg || '';
    ui.cloud.at = Date.now();
    var el = document.querySelector('#cloudStatus');
    if (el) el.innerHTML = cloudStatusHTML();
  }

  function cloudStatusHTML() {
    var c = cloudConf();
    var s2 = ui.cloud || {};
    if (s2.state === 'busy') return '<span class="badge warn">Syncing</span> <span class="sub">' + esc(s2.msg || 'Talking to the cloud…') + '</span>';
    if (s2.state === 'ok') return '<span class="badge ok">Synced</span> <span class="sub">' + esc(s2.msg || 'Up to date') + '</span>';
    if (s2.state === 'error') return '<span class="badge bad">Not synced</span> <span class="sub">' + esc(s2.msg || '') + '</span>';
    if (c.syncedAt) return '<span class="badge ok">Last sync</span> <span class="sub">' + esc(new Date(c.syncedAt).toLocaleString()) + '</span>';
    return cloudReady() ? '<span class="badge">Waiting for first sync</span>' : '<span class="badge">Not connected</span>';
  }

  function cloudSchedule() {
    var c = cloudConf();
    if (!c.auto || !cloudReady()) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(function () { cloudPush(true); }, 2500);
  }

  var CLOUD_TABLES = [
    { key: 'branches', table: 'branches', row: function (b) {
        return { id: b.id, name: b.name || '', address: b.address || '', prefix: b.prefix || '', data: b };
      } },
    { key: 'staff', table: 'staff', row: function (s) {
        return { id: s.id, name: s.name || '', username: s.username || '', role: s.role || '', branch_id: s.branchId || '', target: Number(s.target) || 0, active: s.active !== false, data: s };
      } },
    { key: 'items', table: 'items', row: function (i) {
        return { id: i.id, name: i.name || '', sku: i.sku || '', category: i.category || '', price: Number(i.price) || 0, cost: Number(i.cost) || 0, reorder: Number(i.reorder) || 0, stock: i.stock || {}, data: i };
      } },
    { key: 'customers', table: 'customers', row: function (c) {
        return { id: c.id, name: c.name || '', phone: c.phone || '', email: c.email || '', address: c.address || '', data: c };
      } },
    { key: 'suppliers', table: 'suppliers', row: function (s) {
        return { id: s.id, name: s.name || '', phone: s.phone || '', email: s.email || '', address: s.address || '', data: s };
      } },
    { key: 'invoices', table: 'invoices', row: function (i) {
        var c = findCust(i.customerId);
        var due = r2(Number(i.total) - Number(i.paid));
        return { id: i.id, no: i.no || '', date: i.date || '', customer_id: i.customerId || '', customer_name: c ? c.name : 'Walk-in', branch_id: i.branchId || '', staff_id: i.staffId || '', discount: Number(i.discount) || 0, tax: Number(i.tax) || 0, total: Number(i.total) || 0, paid: Number(i.paid) || 0, status: due <= 0.009 ? 'paid' : (Number(i.paid) > 0 ? 'partial' : 'unpaid'), data: i };
      } },
    { key: 'estimates', table: 'estimates', row: function (e) {
        var c = findCust(e.customerId);
        return { id: e.id, no: e.no || '', date: e.date || '', customer_id: e.customerId || '', customer_name: c ? c.name : 'Walk-in', branch_id: e.branchId || '', staff_id: e.staffId || '', total: Number(e.total) || 0, data: e };
      } },
    { key: 'purchases', table: 'purchases', row: function (p) {
        var sup = supplierById(p.supplierId);
        return { id: p.id, no: p.no || '', date: p.date || '', supplier_id: p.supplierId || '', supplier_name: sup ? sup.name : '', status: p.status || 'approved', total: Number(p.total) || 0, branch_id: p.branchId || '', data: p };
      } },
    { key: 'sreturns', table: 'sreturns', row: function (r) {
        var c = findCust(r.customerId);
        return { id: r.id, no: r.no || '', date: r.date || '', invoice_id: r.invoiceId || '', customer_name: c ? c.name : '', branch_id: r.branchId || '', total: Number(r.total) || 0, data: r };
      } },
    { key: 'preturns', table: 'preturns', row: function (r) {
        return { id: r.id, no: r.no || '', date: r.date || '', supplier_id: r.supplierId || '', total: Number(r.total) || 0, data: r };
      } },
    { key: 'transfers', table: 'transfers', row: function (t) {
        return { id: t.id, no: t.no || '', date: t.date || '', from_branch: t.fromId || '', to_branch: t.toId || '', status: t.status || '', data: t };
      } },
    { key: 'damages', table: 'damages', row: function (d) {
        return { id: d.id, date: d.date || '', item_id: d.itemId || '', item_name: d.name || '', qty: Number(d.qty) || 0, cost_value: Number(d.costValue) || 0, branch_id: d.branchId || '', adjusted: !!d.adjusted, data: d };
      } },
    { key: 'complaints', table: 'complaints', row: function (c) {
        return { id: c.id, no: c.no || '', date: c.date || '', status: c.status || 'open', item_name: c.itemName || '', customer_name: c.customerName || '', invoice_no: c.invoiceNo || '', supplier_name: c.supplierName || '', branch_id: c.branchId || '', data: c };
      } },
    { key: 'expenses', table: 'expenses', row: function (x) {
        return { id: x.id, date: x.date || '', category: x.category || '', amount: Number(x.amount) || 0, method: x.method || '', branch_id: x.branchId || '', data: x };
      } },
    { key: 'staffLedger', table: 'staff_ledger', row: function (e) {
        return { id: e.id, date: e.date || '', staff_id: e.staffId || '', type: e.type || '', amount: Number(e.amount) || 0, data: e };
      } },
    { key: 'activity', table: 'activity', row: function (a) {
        return { id: a.id, at: Number(a.at) || 0, date: a.date || '', type: a.type || '', text: a.text || '', who: a.who || '', data: a };
      } }
  ];

  var CLOUD_SYNC_KEY = 'cloud_sync_v1';

  function cloudLoadSync() {
    try { return JSON.parse(localStorage.getItem(CLOUD_SYNC_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function cloudSaveSync(s) {
    try { localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function cloudHash(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + 'x' + s.length.toString(36);
  }
  function cloudSettingRow() {
    var s = db.settings;
    return {
      id: 'main', business: s.business || '', gstin: s.gstin || '', prefix: s.prefix || '',
      tax_rate: Number(s.taxRate) || 0, currency: s.currency || '',
      data: { settings: s, counters: { counter: db.counter, tcounter: db.tcounter, pcounter: db.pcounter, rcounter: db.rcounter, ecounter: db.ecounter, ccomp: db.ccomp } }
    };
  }
  function cloudAllTables() {
    return CLOUD_TABLES.concat([{ key: '__settings', table: 'app_settings', single: true }]);
  }
  function cloudPlan() {
    var sync = cloudLoadSync();
    return cloudAllTables().map(function (t) {
      var rows = t.single ? [cloudSettingRow()] : (db[t.key] || []).map(function (x) { return t.row(x); });
      var prev = sync[t.table] || {};
      var changed = [], ids = [];
      rows.forEach(function (r) {
        ids.push(String(r.id));
        if (prev[r.id] !== cloudHash(JSON.stringify(r))) changed.push(r);
      });
      var removed = Object.keys(prev).filter(function (id) { return ids.indexOf(id) < 0; });
      return { t: t, rows: rows, changed: changed, removed: removed };
    });
  }

  function cloudVerify() {
    if (!cloudReady()) { toast('Connect Supabase first'); return Promise.resolve(false); }
    var el = document.querySelector('#cloudCheck');
    if (el) el.innerHTML = '<div class="sub">Checking every table…</div>';
    var tables = cloudAllTables();
    var out = [];
    var chain = Promise.resolve();
    tables.forEach(function (t) {
      chain = chain.then(function () {
        return cloudReq(t.table + '?select=id').then(function (rows) {
          var local = t.single ? 1 : (db[t.key] || []).length;
          out.push({ table: t.table, local: local, cloud: (rows || []).length, ok: true });
        }).catch(function (e) {
          out.push({ table: t.table, ok: false, err: String((e && e.message) || e) });
        });
      });
    });
    return chain.then(function () {
      var missing = out.filter(function (x) { return !x.ok; });
      var behind = out.filter(function (x) { return x.ok && x.cloud < x.local; });
      var rows = out.map(function (x) {
        var state = !x.ok ? 'Missing' : (x.cloud >= x.local ? 'Saved' : 'Pending');
        var cls = !x.ok ? 'bad' : (x.cloud >= x.local ? 'ok' : 'bad');
        return '<div class="dash-row rep-row"><span class="grow"><b>' + esc(x.table) + '</b><span class="sub">' +
          (x.ok ? (x.local + ' here · ' + x.cloud + ' in cloud') : esc(x.err)) +
          '</span></span><span class="val ' + cls + '">' + state + '</span></div>';
      }).join('');
      if (el) el.innerHTML = '<div class="dash-list">' + rows + '</div>';
      if (missing.length) toast('Run the setup SQL — ' + missing.length + ' table(s) missing');
      else if (behind.length) toast(behind.length + ' table(s) have newer data on this device — press Upload now');
      else toast('All data is saved in the cloud');
      return !missing.length;
    });
  }

  function cloudCheck() {
    if (!cloudReady()) return Promise.resolve(false);
    cloudSetStatus('busy', 'Checking the cloud tables…');
    return cloudReq('app_settings?select=id&limit=1').then(function (rows) {
      cloudSetStatus('ok', 'Cloud tables are ready');
      return true;
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      if (/Could not find the table|PGRST205|404/i.test(msg)) msg = 'Cloud tables are missing — run the SQL from this page in Supabase once.';
      cloudSetStatus('error', msg);
      return false;
    });
  }

  var CLOUD_DELETE_TABLES = ['app_settings', 'branches', 'staff', 'items', 'customers', 'suppliers',
    'invoices', 'estimates', 'purchases', 'sreturns', 'preturns', 'transfers', 'damages', 'complaints', 'expenses', 'staff_ledger', 'activity'];

  function cloudWipeAll() {
    if (!cloudReady()) return Promise.resolve({ ok: false, error: 'Cloud is not set up' });
    var chain = Promise.resolve();
    var reached = 0;
    CLOUD_DELETE_TABLES.forEach(function (t) {
      chain = chain.then(function () {
        return cloudReq(t + '?id=not.is.null', { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } })
          .then(function () { reached += 1; })
          .catch(function () { return null; });
      });
    });
    return chain.then(function () {
      try { localStorage.removeItem(CLOUD_SYNC_KEY); } catch (e) {}
      if (!reached) return { ok: false, error: 'could not reach Supabase, so the cloud copy was not touched' };
      cloudSetStatus('busy', 'Cloud emptied — uploading the clean setup…');
      return cloudPush(true).then(function (pushed) {
        if (!pushed) return { ok: false, error: 'the cloud records were cleared but the clean setup could not be uploaded' };
        cloudSetStatus('ok', 'Cloud emptied');
        return { ok: true };
      });
    }).catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  function cloudPush(silent) {
    if (!cloudReady()) return Promise.resolve(false);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      /* remember it, so the change (including a delete) is sent as soon as the
         internet comes back */
      var offc = cloudConf();
      offc.lastError = 'Offline — this will sync when the internet is back';
      S.save();
      cloudSetStatus('error', offc.lastError);
      return Promise.resolve(false);
    }
    if (cloudBusy) return Promise.resolve(false);
    cloudBusy = true;

    var plan;
    try { plan = cloudPlan(); }
    catch (e) { cloudBusy = false; cloudSetStatus('error', String((e && e.message) || e)); return Promise.resolve(false); }

    var total = plan.reduce(function (n, p) { return n + p.changed.length + p.removed.length; }, 0);
    if (!total) {
      cloudBusy = false;
      cloudSetStatus('ok', 'Everything is already saved');
      return Promise.resolve(true);
    }
    cloudSetStatus('busy', 'Saving ' + total + ' record' + (total === 1 ? '' : 's') + '…');

    var sync = cloudLoadSync();
    var chain = Promise.resolve();
    plan.forEach(function (p) {
      chain = chain.then(function () {
        var step = Promise.resolve();
        if (p.changed.length) {
          step = step.then(function () {
            return cloudReq(p.t.table + '?on_conflict=id', {
              method: 'POST',
              headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
              body: p.changed
            });
          });
        }
        if (p.removed.length) {
          step = step.then(function () {
            var chunks = [], i;
            for (i = 0; i < p.removed.length; i += 40) chunks.push(p.removed.slice(i, i + 40));
            return chunks.reduce(function (c, chunk) {
              return c.then(function () {
                var list = chunk.map(function (id) { return '"' + String(id).replace(/"/g, '') + '"'; }).join(',');
                return cloudReq(p.t.table + '?id=in.(' + encodeURIComponent(list) + ')', {
                  method: 'DELETE', headers: { 'Prefer': 'return=minimal' }
                });
              });
            }, Promise.resolve());
          });
        }
        return step.then(function () {
          var map = {};
          p.rows.forEach(function (r) { map[r.id] = cloudHash(JSON.stringify(r)); });
          sync[p.t.table] = map;
        });
      });
    });

    return chain.then(function () {
      cloudSaveSync(sync);
      var c = cloudConf();
      c.syncedAt = Date.now(); c.lastError = '';
      S.save();
      cloudSetStatus('ok', total + ' record' + (total === 1 ? '' : 's') + ' saved just now');
      if (!silent) toast('Saved to the cloud');
      return true;
    }).catch(function (e) {
      var c = cloudConf();
      c.lastError = String((e && e.message) || e);
      S.save();
      var msg = c.lastError;
      if (/Could not find the table|PGRST205/i.test(msg)) msg = 'Cloud tables are missing — run the SQL from this page in Supabase once.';
      cloudSetStatus('error', msg);
      if (!silent) toast(msg);
      return false;
    }).then(function (r) { cloudBusy = false; return r; });
  }

  /* read every table in one go; returns the raw rows plus the settings row */
  function cloudFetchCopy() {
    return Promise.all(cloudAllTables().map(function (t) {
      return cloudReq(t.table + '?select=*').then(function (rows) {
        return { t: t, rows: rows || [] };
      }).catch(function () { return { t: t, rows: [] }; });
    })).then(function (sets) {
      var fresh = {}, settingsRow = null;
      sets.forEach(function (set) {
        if (set.t.single) { settingsRow = set.rows[0] || null; return; }
        fresh[set.t.key] = set.rows.map(function (r) { return r.data || r; });
      });
      if (!settingsRow) throw new Error('Nothing has been uploaded to the cloud for this shop yet');
      return { fresh: fresh, settingsRow: settingsRow };
    });
  }

  /* after a cloud copy is loaded, make sure bill and estimate numbers are
     unique — two devices that billed offline can mint the same number */
  function cloudEnsureUniqueNos() {
    if (!db) return false;
    var changed = false;
    var seen = Object.create(null);
    (db.invoices || []).slice().sort(function (a, b) {
      return (a.created || 0) - (b.created || 0) || String(a.id || '').localeCompare(String(b.id || ''));
    }).forEach(function (inv) {
      var no = String(inv.no || '');
      if (!no) return;
      if (!seen[no]) { seen[no] = inv; return; }
      var pref = branchPrefix(inv.branchId);
      var seq = nextBillSeq();
      var nno = pref + '-' + seq;
      while (db.invoices.some(function (x) { return x !== inv && x.no === nno; })) { seq++; nno = pref + '-' + seq; }
      inv.no = nno;
      db.counter = Math.max(Number(db.counter) || 0, seq);
      seen[nno] = inv;
      changed = true;
    });
    var seenE = Object.create(null);
    (db.estimates || []).slice().sort(function (a, b) {
      return (a.created || 0) - (b.created || 0) || String(a.id || '').localeCompare(String(b.id || ''));
    }).forEach(function (est) {
      var no = String(est.no || '');
      if (!no) return;
      if (!seenE[no]) { seenE[no] = est; return; }
      var seq = nextEstSeq();
      var nno = 'EST-' + seq;
      while ((db.estimates || []).some(function (x) { return x !== est && x.no === nno; })) { seq++; nno = 'EST-' + seq; }
      est.no = nno;
      db.ecounter = Math.max(Number(db.ecounter) || 0, seq);
      seenE[nno] = est;
      changed = true;
    });
    return changed;
  }

  /* replace this device's data with the downloaded copy and remember what was
     downloaded, so the next save only uploads real changes */
  function cloudApplyCopy(fetched) {
    var c = cloudConf();
    var keep = { url: c.url, key: c.key, shop: c.shop, auto: c.auto !== false, syncedAt: Date.now(), lastError: '' };
    var payload = fetched.settingsRow.data || {};
    var cnt = payload.counters || {};
    var fresh = fetched.fresh;
    fresh.settings = payload.settings || {};
    fresh.counter = cnt.counter;
    fresh.tcounter = cnt.tcounter;
    fresh.pcounter = cnt.pcounter;
    fresh.rcounter = cnt.rcounter;
    fresh.ecounter = cnt.ecounter;
    fresh.ccomp = cnt.ccomp;
    db = S.importData(fresh);
    cloudEnsureUniqueNos();
    db.settings.cloud = keep;
    S.save();
    try { localStorage.removeItem(CLOUD_SYNC_KEY); } catch (e) {}
    try {
      var sync = {};
      cloudPlan().forEach(function (p) {
        var map = {};
        p.rows.forEach(function (r) { map[r.id] = cloudHash(JSON.stringify(r)); });
        sync[p.t.table] = map;
      });
      cloudSaveSync(sync);
    } catch (e) {}
    return db;
  }

  function cloudPull(silent) {
    if (!cloudReady()) return Promise.resolve(false);
    cloudSetStatus('busy', 'Downloading the cloud copy…');
    return cloudFetchCopy().then(function (fetched) {
      cloudApplyCopy(fetched);
      ui.branch = startBranchId();
      newBill();
      render();
      cloudSetStatus('ok', 'Loaded the cloud copy');
      if (!silent) toast('Cloud copy loaded');
      return true;
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      cloudSetStatus('error', msg);
      if (!silent) toast(msg || 'Could not reach the cloud');
      return false;
    });
  }

  /* a fresh device has nothing but the starter shop: no bills, no stock
     movements, no customers and no suppliers of its own */
  function cloudLocalIsFresh() {
    if (!db) return true;
    if (S.wasEmpty()) return true;
    var moved = ['invoices', 'estimates', 'purchases', 'sreturns', 'preturns', 'transfers', 'expenses', 'damages']
      .some(function (k) { return (db[k] || []).length > 0; });
    var people = (db.customers || []).length > 0 || (db.suppliers || []).length > 0;
    if (moved || people) return false;
    /* somebody who has already set their shop up is not a fresh install */
    var biz = String((db.settings && db.settings.business) || 'My Store').trim();
    return biz === 'My Store';
  }

  /* run once at startup: bring the shop back from Supabase when this browser
     has no data of its own, so restarting or opening a new device shows the
     saved shop instead of the empty starter data */
  var cloudRestoreTried = false;
  function cloudAutoRestore() {
    if (cloudRestoreTried) return Promise.resolve(false);
    cloudRestoreTried = true;
    if (!cloudReady() || !cloudLocalIsFresh()) return Promise.resolve(false);
    cloudSetStatus('busy', 'Checking the cloud for your saved data…');
    return cloudReq('app_settings?select=id&limit=1').then(function (rows) {
      if (!rows || !rows.length) { cloudSetStatus('ok', 'Connected — nothing saved in the cloud yet'); return false; }
      cloudSetStatus('busy', 'Restoring your saved data…');
      return cloudFetchCopy().then(function (fetched) {
        cloudApplyCopy(fetched);
        cloudSetStatus('ok', 'Your saved data was restored from the cloud');
        return true;
      });
    }).catch(function (e) {
      var msg = String((e && e.message) || e);
      if (/Could not find the table|PGRST205/i.test(msg)) msg = 'Cloud tables are missing — run the SQL in Supabase once.';
      cloudSetStatus('error', msg);
      return false;
    });
  }

  /* ---- core screen plumbing restored ---- */

  var ICON = {
    dash: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    bill: '<path d="M6 3h12v18H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    invoice: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>',
    swap: '<path d="M4 8h13l-3-3"/><path d="M20 16H7l3 3"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12v9M4 7.5 12 12l8-4.5"/>',
    user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.6-3.4 4-5 7-5s5.4 1.6 7 5"/>',
    money: '<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10h5M9.5 14h5"/>',
    chart: '<path d="M4 20V6M4 20h16"/><path d="M8 20v-6M13 20V9M18 20v-9"/>',
    staff: '<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c1.4-3.2 3.6-4.8 6.2-4.8S14 16.8 15.4 20"/><circle cx="17.5" cy="9" r="2.4"/><path d="M16 14.6c2.6-.4 4.4 1.2 5.2 3.6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17 5.6 18.4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2l2.4 10.4A2 2 0 0 0 9.4 16h8.2a2 2 0 0 0 2-1.6L21 8H6"/>',
    back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10H9"/>',
    warn: '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17h.01"/>',
    book: '<path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
    chat: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4.2A8 8 0 1 1 21 12z"/><path d="M9 11h.01M12.5 11h.01M16 11h.01"/>',
    bin: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>'
  };

  var TABS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dash', perm: 'dashboard', title: 'Dashboard' },
    { id: 'bill', label: 'New bill', icon: 'bill', perm: 'bill', title: 'New bill' },
    { id: 'invoices', label: 'Invoices', icon: 'invoice', perm: 'invoices', title: 'Invoices' },
    { id: 'returns', label: 'Sales returns', icon: 'back', perm: 'returns', title: 'Sales returns' },
    { id: 'purchases', label: 'Purchases', icon: 'cart', perm: 'purchases', title: 'Purchases & suppliers' },
    { id: 'damage', label: 'Damage / loss', icon: 'warn', perm: 'damage', title: 'Damage / loss' },
    { id: 'complaints', label: 'Complaints', icon: 'chat', perm: 'complaints', title: 'Complaints' },
    { id: 'transfers', label: 'Stock transfers', icon: 'swap', perm: 'transfer', title: 'Stock transfers' },
    { id: 'items', label: 'Items & stock', icon: 'box', perm: 'items', title: 'Items & stock' },
    { id: 'customers', label: 'Parties', icon: 'user', perm: 'customers', title: 'Parties' },
    { id: 'ledgers', label: 'Ledgers', icon: 'book', perm: 'ledgers', title: 'Ledgers' },
    { id: 'expenses', label: 'Expenses', icon: 'money', perm: 'expenses', title: 'Expenses' },
    { id: 'reports', label: 'Reports', icon: 'chart', perm: 'reports', title: 'Reports' },
    { id: 'staff', label: 'Staff & access', icon: 'staff', perm: 'staff', title: 'Staff & access' },
    { id: 'bin', label: 'Bin', icon: 'bin', perm: 'settings', title: 'Bin' },
    { id: 'settings', label: 'Settings', icon: 'gear', perm: 'settings', title: 'Settings' }
  ];

  function tabDef(id) { return TABS.filter(function (t) { return t.id === id; })[0] || TABS[0]; }

  /* The floating button follows the page: each screen gets the action that
     makes sense there, and screens with nothing to create hide it. */
  function fabFor(tabId) {
    var map = {
      dashboard: { label: 'New bill', act: 'new-bill' },
      /* the invoices screen also holds estimates, so the create button follows
         whichever tab is open */
      invoices: invState().tab === 'est'
        ? { label: 'New estimate', act: 'new-estimate' }
        : { label: 'New bill', act: 'new-bill' },
      customers: ui.partyTab === 'suppliers' && (S.isOwner() || can('purchases'))
        ? { label: 'Add supplier', act: 'supplier-new' }
        : { label: 'New customer', act: 'cust-new' },
      complaints: { label: 'New complaint', act: 'cmp-new' },
      damage: can('damage.entry') ? { label: 'New damage entry', act: 'dmg-new' } : null,
      expenses: { label: 'New expense', act: 'exp-new' },
      items: { label: 'New item', act: 'item-new' },
      purchases: canSubmitPurchase() ? { label: 'New purchase', act: 'purchase-new' } : null,
      transfers: { label: 'New transfer', act: 'tr-new' },
      staff: { label: 'Add staff', act: 'staff-new' }
    };
    return map[tabId] || null;
  }

  /* One create button per screen: the floating + on phones, the inline
     button on wider screens. Both do the same job, so we hide the spare. */
  function syncCreateButtons() {
    var fc = fabFor(ui.tab);
    var fab = $('#fabBill');
    var v = $('#view');
    var dupes = [];
    if (fc && v) {
      Array.prototype.forEach.call(v.querySelectorAll('[data-act="' + fc.act + '"]'), function (b) {
        if (b.closest && b.closest('.page-head, .cust-top')) {
          b.classList.add('js-dup-create');
          dupes.push(b);
        }
      });
    }
    if (fab && fc) fab.hidden = !!(dupes.length && window.innerWidth >= 720);
    return dupes.length;
  }

  function tabAllowed(id) {
    if (id === 'purchases') return !!(can('purchases') || canSubmitPurchase());
    if (id === 'damage') return !!(can('damage') || can('damage.entry') || can('damage.settle') || can('damage.delete'));
    var d = tabDef(id);
    return !!(can(d.perm) && (!d.extra || can(d.extra)));
  }
  function allowedTabs() {
    return TABS.filter(function (t) { return tabAllowed(t.id); });
  }
  function firstTab() { var a = allowedTabs(); return a.length ? a[0].id : 'dashboard'; }

  function ico(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[n] || '') + '</svg>'; }

  function focusSnapshot() {
    var el = document.activeElement;
    if (!el || !el.getAttribute) return null;
    var kind = el.getAttribute('data-input') ? 'data-input' : (el.getAttribute('data-change') ? 'data-change' : '');
    if (!kind) return null;
    var snap = { kind: kind, key: el.getAttribute(kind), id: el.getAttribute('data-id'), start: null, end: null };
    var fk = el.getAttribute('data-k');
    if (fk != null) snap.fk = fk;
    try { snap.start = el.selectionStart; snap.end = el.selectionEnd; } catch (e) {}
    return snap;
  }

  /* Put the caret at a given place in a field. Chrome and phone browsers drop
     the caret to position 0 when a freshly rendered input is focused, so every
     typed digit lands in front of the ones before it (123 comes out as 321).
     Number inputs cannot report or set a selection, so they are switched to
     text for the length of this call. */
  function setCaret(el, pos) {
    if (!el || typeof el.value !== 'string') return;
    var at = pos == null ? el.value.length : Math.max(0, Math.min(Number(pos) || 0, el.value.length));
    var isNum = String(el.type || '').toLowerCase() === 'number';
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    try {
      if (isNum) el.type = 'text';
      if (el.setSelectionRange) el.setSelectionRange(at, at);
    } catch (e) {}
    try { if (isNum) el.type = 'number'; } catch (e) {}
  }

  function restoreFocus(snap) {
    if (!snap) return;
    var sel = '[' + snap.kind + '="' + snap.key + '"]';
    if (snap.id != null && snap.id !== '') sel += '[data-id="' + snap.id + '"]';
    if (snap.fk != null) sel += '[data-k="' + snap.fk + '"]';
    var el = $(sel);
    if (!el || !el.focus) return;
    /* When the field cannot report a caret (number inputs), keep it at the end
       so typing stays left to right instead of being inserted at the start. */
    setCaret(el, snap.start == null ? el.value.length : snap.start);
  }

  function go(tab) {
    if (!tabAllowed(tab)) { toast('You do not have access to that section'); return; }
    if (tab !== 'settings' && ui.tab === 'settings') { ui.scCharges = null; ui.scTerms = null; ui.scFields = null; ui.settingsTab = 'company'; }
    ui.tab = tab;
    rememberTab(tab);
    if (tab === 'bill' && !ui.bill) newBill();
    if (tab === 'transfers' && !ui.transfer) newTransfer();
    closeSidebar();
    render();
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  function doLogin(e) {
    e.preventDefault();
    var uEl = $('#loginUser'), pEl = $('#loginPass');
    var btn = document.querySelector('#loginForm button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
    S.login(uEl ? uEl.value : '', pEl ? pEl.value : '').then(function (res) {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      if (!res || res.error) { toast((res && res.error) || 'Could not sign in'); return; }
      db = S.get();
      ui.branch = startBranchId();
      ui.tab = firstTab();
      newBill();
      $('#login').hidden = true;
      $('#app').style.display = '';
      render();
      toast('Welcome, ' + res.staff.name);
      if (res.changedDefault) setTimeout(forcePasswordChange, 250);
    }).catch(function (err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
      toast(String((err && err.message) || err || 'Could not sign in'));
    });
  }

  /* the seeded 1234 is not a real password — a new one is asked for right after
     the first sign-in so the shop is never left on the factory code */
  function forcePasswordChange() {
    var me = S.currentStaff();
    if (!me) return;
    openModal('Set your password', `<form data-form="force-password">
      <div class="sub" style="margin-bottom:10px">The default password 1234 must be changed before the shop is used.</div>
      <div class="field"><label>New password for ${esc(me.name)}</label>
        <input class="inp" type="password" name="pass1" required minlength="4" autocomplete="new-password" placeholder="At least 4 characters"></div>
      <div class="field"><label>Type it again</label>
        <input class="inp" type="password" name="pass2" required minlength="4" autocomplete="new-password"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:12px">
        <button class="btn primary" type="submit">Save password</button>
      </div>
    </form>`);
  }

  function doLogout() {
    if (!confirm('Sign out?')) return;
    S.logout();
    $('#login').hidden = false;
    showLogin();
  }

  function showLogin() {
    $('#app').style.display = 'none';
    $('#login').hidden = false;
    $('#loginBiz').textContent = (db.settings && db.settings.business) || 'My Store';
    var owner = db.staff.filter(function (s) { return s.role === 'owner'; })[0];
    var def = owner && S.needsPasswordChange(owner);
    $('#loginHint').innerHTML = def
      ? 'Default owner login: <b>owner</b> / <b>1234</b> — change it in Staff &amp; access.'
      : 'Ask the owner for your user ID and password.';
    var u = $('#loginUser'); if (u) { u.value = ''; u.focus(); }
    var p = $('#loginPass'); if (p) p.value = '';
  }

  function newBill(opts) {
    opts = opts || {};
    ui.bill = {
      kind: opts.kind === 'estimate' ? 'estimate' : 'sale',
      customerId: '', date: today(), discount: 0, autoPay: true, payments: [{ method: 'Cash', amount: 0 }],
      lines: [], customerChosen: false,
      fields: {},
      charges: (db.settings.extraCharges || []).map(function (c) {
        return { name: c.name, amount: Number(c.amount) || 0, on: false };
      })
    };
    ui.custQ = '';
  }

  function newTransfer() { ui.transfer = { to: '', lines: [], q: '' }; }

  /* Estimates are quotes. They are numbered on their own series, never touch
     stock, and never appear in invoices, dues, dashboards or reports. */
  function nextEstSeq() {
    return Math.max(Number(db.ecounter) || 100, 100) + 1;
  }
  function estById(id) {
    return (db.estimates || []).filter(function (x) { return x.id === id; })[0] || null;
  }
  function branchEstimates(b) {
    return (db.estimates || []).filter(function (e) { return e.branchId === (b || ui.branch); });
  }
  /* Estimates print with the same document as a bill, so they are handed to the
     document builders as a bill-shaped object that never carries money
     received, dues, EMI or payment details. */
  function estAsDoc(e) {
    if (!e) return null;
    return {
      id: e.id, no: e.no, date: e.date, created: e.created, isEstimate: true,
      branchId: e.branchId, staffId: e.staffId || '', customerId: e.customerId || '',
      lines: e.lines || [], discount: e.discount, taxRate: e.taxRate,
      charges: e.charges || [], fields: e.fields || [], note: '',
      subtotal: e.subtotal, tax: e.tax, total: e.total,
      paid: 0, payments: [], emi: null, method: ''
    };
  }
  function docById(id) { return invById(id) || estAsDoc(estById(id)); }
  function billKindSeg(b) {
    var est = b && b.kind === 'estimate';
    return '<div class="seg docseg" role="group" aria-label="Bill or estimate">' +
      '<button type="button" class="' + (est ? '' : 'on') + '" data-act="bill-kind" data-id="sale">Bill</button>' +
      '<button type="button" class="' + (est ? 'on' : '') + '" data-act="bill-kind" data-id="estimate">Estimate</button></div>';
  }

  function editInvoice(id) {
    if (!can('invoice.delete')) return toast('You do not have permission to edit bills');
    var inv = invById(id);
    if (!inv) return toast('Bill not found');
    closeModal();
    var lines = (inv.lines || []).map(function (l) {
      return {
        itemId: l.itemId || '', name: l.name, qty: Number(l.qty) || 1,
        price: Number(l.price) || 0, cost: Number(l.cost) || 0, disc: Number(l.disc) || 0,
        desc: String(l.desc || ''), imei: String(l.imei || ''), serial: String(l.serial || '')
      };
    });
    var fields = {};
    (db.settings.billFields || []).forEach(function (f) {
      var hit = (inv.fields || []).filter(function (x) { return x.label === f.label; })[0];
      fields[f.id] = hit ? hit.value : '';
    });
    var charges = (db.settings.extraCharges || []).map(function (c) {
      var hit = (inv.charges || []).filter(function (x) { return x.name === c.name; })[0];
      return { name: c.name, amount: hit ? Number(hit.amount) || 0 : Number(c.amount) || 0, on: !!hit };
    });
    (inv.charges || []).forEach(function (c) {
      var known = (db.settings.extraCharges || []).some(function (x) { return x.name === c.name; });
      if (!known) charges.push({ name: c.name, amount: Number(c.amount) || 0, on: true });
    });
    var pays = (inv.payments || []).filter(function (p) { return Number(p.amount) > 0; }).map(function (p) {
      return { method: p.method || 'Cash', amount: Number(p.amount) || 0, at: p.at, full: p.full,
        emi: (p.method === 'EMI' && inv.emi) ? { finance: inv.emi.finance, monthly: inv.emi.monthly, date: inv.emi.date, months: inv.emi.months } : null };
    });
    if (!pays.length && Number(inv.paid) > 0) pays = [{ method: inv.method || 'Cash', amount: Number(inv.paid), emi: inv.emi || null }];
    if (!pays.length) pays = [{ method: 'Cash', amount: 0 }];
    ui.custQ = '';
    ui.bill = {
      editId: inv.id, editNo: inv.no, editDate: inv.date, editBranch: inv.branchId,
      customerId: inv.customerId || '', customerChosen: true,
      discount: Number(inv.discount) || 0, autoPay: false, payments: pays,
      lines: lines, fields: fields, charges: charges
    };
    ui.tab = 'bill';
    render();
    try { window.scrollTo(0, 0); } catch (e) {}
    toast('Editing bill ' + inv.no);
  }

  function cancelEdit() {
    if (!(ui.bill && ui.bill.editId)) return;
    var no = ui.bill.editNo;
    ui.bill = null; newBill();
    ui.tab = 'invoices';
    render();
    toast('Back to bills — ' + no + ' was not changed');
  }


  /* global search — bill no, customer phone/name, item name/SKU */
  function globalSearchResults(q) {
    q = String(q || '').trim();
    if (q.length < 2) return { bills: [], items: [], customers: [] };
    var bills = (db.invoices || []).filter(function (inv) {
      var c = findCust(inv.customerId);
      return match(inv.no, q) || (c && (match(c.name, q) || match(c.phone, q)));
    }).slice(0, 8);
    var items = (db.items || []).filter(function (it) {
      return match(it.name, q) || match(it.sku, q) || match(it.category, q);
    }).slice(0, 8);
    var customers = (db.customers || []).filter(function (c) {
      return match(c.name, q) || match(c.phone, q);
    }).slice(0, 6);
    return { bills: bills, items: items, customers: customers };
  }
  function globalSearchHTML(q) {
    var r = globalSearchResults(q);
    if (!q || q.length < 2) return '<div class="sub">Type at least 2 characters to search bills, customers, items and SKUs.</div>';
    var out = '';
    if (r.bills.length) {
      out += '<div class="section-title" style="margin:8px 0 4px">Bills</div>' + r.bills.map(function (inv) {
        var c = findCust(inv.customerId);
        return '<button type="button" class="row between" style="width:100%;text-align:left;padding:10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;margin:4px 0;background:var(--card,#fff)" data-act="gsearch-bill" data-id="' + esc(inv.id) + '">'
          + '<span><b>' + esc(inv.no) + '</b> · ' + esc(c ? c.name : 'Walk-in') + (c && c.phone ? ' · ' + esc(c.phone) : '') + '</span>'
          + '<span>' + money(inv.total) + '</span></button>';
      }).join('');
    }
    if (r.items.length) {
      out += '<div class="section-title" style="margin:8px 0 4px">Items</div>' + r.items.map(function (it) {
        return '<button type="button" class="row between" style="width:100%;text-align:left;padding:10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;margin:4px 0;background:var(--card,#fff)" data-act="gsearch-item" data-id="' + esc(it.id) + '">'
          + '<span><b>' + esc(it.name) + '</b>' + (it.sku ? ' · ' + esc(it.sku) : '') + (it.category ? ' · ' + esc(it.category) : '') + '</span>'
          + '<span>' + money(it.price) + '</span></button>';
      }).join('');
    }
    if (r.customers.length) {
      out += '<div class="section-title" style="margin:8px 0 4px">Customers</div>' + r.customers.map(function (c) {
        return '<button type="button" class="row between" style="width:100%;text-align:left;padding:10px;border:1px solid var(--line,#e5e7eb);border-radius:10px;margin:4px 0;background:var(--card,#fff)" data-act="gsearch-customer" data-id="' + esc(c.id) + '">'
          + '<span><b>' + esc(c.name || 'Customer') + '</b></span>'
          + '<span>' + esc(c.phone || '') + '</span></button>';
      }).join('');
    }
    if (!out) out = '<div class="sub">No bills, items or customers match "' + esc(q) + '".</div>';
    return out;
  }
  function openGlobalSearch() {
    openModal('Search', '<div class="field"><label>Search</label><input class="inp" id="gSearchInp" type="search" data-input="g-search" placeholder="Bill no, customer phone, item name or SKU" autocomplete="off"></div><div id="gSearchOut" style="margin-top:8px;max-height:60vh;overflow:auto">' + globalSearchHTML('') + '</div>');
    setTimeout(function(){ var inp = document.getElementById('gSearchInp'); if (inp) { inp.focus(); try{ inp.select(); }catch(e){} } }, 30);
  }


  function render() {
    if (!S.currentStaff()) { showLogin(); return; }
    if (!tabAllowed(ui.tab)) ui.tab = firstTab();
    if (!ui.branch || !S.branchById(ui.branch)) ui.branch = startBranchId();

    var staff = S.currentStaff();
    var tab = tabDef(ui.tab);
    var fc = fabFor(ui.tab);
    var fab = $('#fabBill');
    if (fab) {
      if (!fc) fab.hidden = true;
      else {
        fab.hidden = false;
        fab.setAttribute('data-act', fc.act);
        fab.setAttribute('aria-label', fc.label);
        if (fab.getAttribute('data-label') !== fc.label) {
          fab.setAttribute('data-label', fc.label);
          fab.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>' + esc(fc.label) + '</span>';
        }
      }
    }
    $('#pageTitle').textContent = (ui.tab === 'bill' && ui.bill && ui.bill.editId) ? 'Edit bill ' + ui.bill.editNo : tab.title;
    var topBranch = $('#topBranch');
    if (topBranch) {
      topBranch.textContent = branchName(ui.branch);
      topBranch.title = 'Branch: ' + branchName(ui.branch);
    }
    $('#bizName').textContent = db.settings.business || 'My Store';
    $('#bizSub').textContent = branchName(ui.branch);
    $('#whoName').textContent = staff.name;
    $('#whoRole').textContent = S.ROLE_LABEL[staff.role] || staff.role;
    $('#whoAv').textContent = (staff.name || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();

    var branches = S.visibleBranches();
    $('#branchSel').innerHTML = branches.map(function (b) {
      return '<option value="' + b.id + '"' + (b.id === ui.branch ? ' selected' : '') + '>' + esc(b.name) + '</option>';
    }).join('');
    $('#branchSel').disabled = !S.canSwitchBranches() || branches.length < 2;

    var pend = S.pendingTransfersFor(ui.branch).length;
    var dmgPend = pendingDamages(ui.branch).length;
    var cmpPend = (db.complaints || []).filter(function (c) { return (c.status || 'open') === 'open' && c.branchId === ui.branch; }).length;
    $('#nav').innerHTML = allowedTabs().map(function (t) {
      var badge = (t.id === 'transfers' && pend) ? '<span class="count">' + pend + '</span>'
        : (t.id === 'damage' && dmgPend) ? '<span class="count">' + dmgPend + '</span>'
        : (t.id === 'complaints' && cmpPend) ? '<span class="count">' + cmpPend + '</span>' : '';
      return '<button type="button" data-act="tab" data-id="' + t.id + '" class="' + (ui.tab === t.id ? 'on' : '') + '">' +
        ico(t.icon) + '<span>' + esc(t.label) + '</span>' + badge + '</button>';
    }).join('');

    var bnav = $('#bnav');
    if (bnav) {
      var canTab = function(id){ return tabAllowed(id); };
      var bitems = [
        { id:'dashboard', icon:'dash', label:'Home' },
        { id:'bill', icon:'bill', label:'Sale' },
        { id:'items', icon:'box', label:'Items' },
        { id:'customers', icon:'user', label:'Parties' }
      ].filter(function(x){ return canTab(x.id); });
      var moreOn = !bitems.some(function(x){ return x.id === ui.tab; });
      bnav.innerHTML = bitems.map(function(t){
        return '<button type="button" data-act="tab" data-id="'+t.id+'" class="'+(ui.tab===t.id?'on':'')+'">'+ico(t.icon)+'<span>'+esc(t.label)+'</span></button>';
      }).join('') + '<button type="button" id="bnavMore" class="'+(moreOn?'on':'')+'">'+ico('gear')+'<span>More</span></button>';
    }

    var v = $('#view');
    var focusSnap = focusSnapshot();
    try {
      if (ui.tab === 'dashboard') v.innerHTML = viewDashboard();
      else if (ui.tab === 'bill') v.innerHTML = viewBill();
      else if (ui.tab === 'invoices') v.innerHTML = viewInvoices();
      else if (ui.tab === 'returns') v.innerHTML = viewReturns();
      else if (ui.tab === 'purchases') v.innerHTML = viewPurchases();
      else if (ui.tab === 'damage') v.innerHTML = viewDamage();
      else if (ui.tab === 'complaints') v.innerHTML = viewComplaints();
      else if (ui.tab === 'transfers') v.innerHTML = viewTransfers();
      else if (ui.tab === 'items') v.innerHTML = viewItems();
      else if (ui.tab === 'customers') v.innerHTML = viewCustomers();
      else if (ui.tab === 'ledgers') v.innerHTML = viewLedgers();
      else if (ui.tab === 'expenses') v.innerHTML = viewExpenses();
      else if (ui.tab === 'reports') v.innerHTML = viewReports();
      else if (ui.tab === 'staff') v.innerHTML = viewStaff();
      else if (ui.tab === 'bin') v.innerHTML = viewBin();
      else v.innerHTML = viewSettings();
    } catch (e) {
      v.innerHTML = '<div class="card"><b>Could not open this page</b><div class="sub" style="margin-top:6px;white-space:pre-wrap">' + esc(String(e && (e.stack || e.message || e))) + '</div></div>';
      console.error(e);
    }
    restoreFocus(focusSnap);
    try { syncCreateButtons(); } catch (e) { console.error(e); }
    syncViewportHeight();
  }

  function branchInvoices(b) { return db.invoices.filter(function (i) { return i.branchId === (b || ui.branch); }); }

  function branchExpenses(b) { return db.expenses.filter(function (x) { return x.branchId === (b || ui.branch); }); }

  /* Branch targets are monthly. Sales is what the branch billed; profit is what
     is left of it after cost of goods, that branch's expenses and damage. */
  function branchTargets() {
    if (!db.settings.branchTargets || typeof db.settings.branchTargets !== 'object') db.settings.branchTargets = {};
    return db.settings.branchTargets;
  }
  function branchTarget(branchId) {
    var t = branchTargets()[branchId] || {};
    return { sales: Math.max(0, Number(t.sales) || 0), profit: Math.max(0, Number(t.profit) || 0) };
  }
  function branchMonthStats(branchId) {
    var from = S.monthStart(), to = today();
    var sales = 0, gross = 0;
    db.invoices.forEach(function (i) {
      if (i.branchId !== branchId || i.date < from || i.date > to) return;
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      sales += t.taxable;
      gross += (t.taxable - t.cost);
    });
    var exp = db.expenses.filter(function (x) { return x.branchId === branchId && x.date >= from && x.date <= to; })
      .reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var dmg = db.damages.filter(function (d) { return d.branchId === branchId && d.date >= from && d.date <= to; })
      .reduce(function (s, d) { return s + Number(d.costValue || 0); }, 0);
    return { sales: r2(sales), profit: r2(gross - exp - dmg) };
  }
  function targetPct(got, target) {
    return target > 0 ? Math.max(0, Math.round(got / target * 100)) : 0;
  }

  /* An expense can be linked to one or more bills (one transport charge for two
     orders, say). Its amount is shared across those bills by bill value, so each
     bill — and the customer who bought it — carries its own share of the cost. */
  function linkedExpenseShare(invoice) {
    if (!invoice || !invoice.id) return 0;
    var share = 0;
    db.expenses.forEach(function (x) {
      var ids = x.linkedBills || [];
      if (!ids.length || ids.indexOf(invoice.id) < 0) return;
      var bills = ids.map(invById).filter(Boolean);
      if (!bills.length) return;
      var amt = Number(x.amount) || 0;
      var total = bills.reduce(function (s, b) { return s + (Number(b.total) || 0); }, 0);
      share += total > 0 ? amt * ((Number(invoice.total) || 0) / total) : amt / bills.length;
    });
    return r2(share);
  }
  function billProfit(inv) {
    var t = S.compute(inv.lines, inv.discount, inv.taxRate, invoiceCharges(inv), { roundOff: (typeof inv.roundOff === 'number' ? inv.roundOff : 0) });
    return r2((t.taxable - t.cost) - linkedExpenseShare(inv));
  }
  function customerProfit(cid, from, to) {
    var out = { n: 0, sales: 0, linked: 0, profit: 0 };
    db.invoices.forEach(function (i) {
      if (i.customerId !== cid) return;
      if (from && i.date < from) return;
      if (to && i.date > to) return;
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      out.n++;
      out.sales += t.taxable;
      out.profit += (t.taxable - t.cost);
      out.linked += linkedExpenseShare(i);
    });
    out.sales = r2(out.sales);
    out.linked = r2(out.linked);
    out.profit = r2(out.profit - out.linked);
    return out;
  }

  function restoreTab() {
    var last = '';
    try { last = sessionStorage.getItem('billing.tab') || ''; } catch (e) {}
    if (last && TABS.some(function (t) { return t.id === last; }) && can(tabDef(last).perm)) ui.tab = last;
  }
  function rememberTab(id) {
    try { sessionStorage.setItem('billing.tab', String(id || '')); } catch (e) {}
  }

  /* The branch you picked is remembered for this browser tab, so a refresh keeps
     you in that branch instead of dropping back to the first one. */
  function savedBranchId() {
    var id = '';
    try { id = sessionStorage.getItem('billing.branch') || ''; } catch (e) { id = ''; }
    if (!id) return '';
    var ok = false;
    try { ok = S.visibleBranches().some(function (b) { return b.id === id; }); } catch (e) { ok = false; }
    return ok ? id : '';
  }
  function rememberBranch(id) {
    try { sessionStorage.setItem('billing.branch', String(id || '')); } catch (e) {}
  }
  function startBranchId() { return savedBranchId() || S.myBranchId(); }

  /* ------------------------------------------- purchase approvals (cashier / manager) */
  function purchaseApprovalMode() {
    var st = S.currentStaff();
    return !!(st && st.role !== 'owner');
  }
  function canSubmitPurchase() {
    return !!(can('purchase.entry') || can('purchase.edit'));
  }
  /* recording a payment (and the amount on a purchase) is its own permission */
  function canPayPurchase() {
    return !!(can('purchase.pay') || can('purchase.edit'));
  }
  function canSeePurchaseMoney() {
    return S.isOwner();
  }
  function pendingPurchaseApprovals() {
    return (db.purchases || []).filter(function (p) { return p && p.status === 'pending'; });
  }
  function myPurchaseApprovalNotices() {
    var st = S.currentStaff();
    if (!st || S.isOwner()) return [];
    return (db.purchases || []).filter(function (p) {
      return p && p.status === 'approved' && p.createdById === st.id && p.approvalSeenBy && p.approvalSeenBy.indexOf(st.id) === -1;
    });
  }
  function markPurchaseApprovalsSeen() {
    var st = S.currentStaff();
    if (!st) return;
    var changed = false;
    (db.purchases || []).forEach(function (p) {
      if (p && p.status === 'approved' && p.createdById === st.id && p.approvalSeenBy && p.approvalSeenBy.indexOf(st.id) === -1) {
        p.approvalSeenBy.push(st.id);
        changed = true;
      }
    });
    if (changed) save();
  }

  /* --------------------------------------------------------------- dashboard */
  function viewDashboard() {
    var dc = (db.settings && db.settings.dashboard) || { view:'compact', cards:{salesToday:true,salesMonth:true,expensesMonth:true,unpaid:true,myTarget:true}, sections:[{id:'eod',on:true},{id:'kpis',on:true},{id:'target',on:true},{id:'attention',on:true},{id:'complaints',on:true},{id:'collect',on:true},{id:'recent',on:true},{id:'low',on:true}], limits:{recent:40,low:4,collect:3} };
    var secOn = function(id){ var x = (dc.sections||[]).filter(function(s){return s.id===id;})[0]; return !x || x.on !== false; };
    var secOrder = (dc.sections||[]).map(function(s){return s.id;});
    ['eod','kpis','target','btargets','attention','complaints','collect','recent','low'].forEach(function(id){ if(secOrder.indexOf(id)<0) secOrder.push(id); });
    if (secOrder.indexOf('complaints') > secOrder.indexOf('recent') && secOrder.indexOf('collect') >= 0) {
      secOrder.splice(secOrder.indexOf('complaints'), 1);
      secOrder.splice(secOrder.indexOf('collect'), 0, 'complaints');
    }
    var lim = dc.limits || {recent:4,low:4,collect:3};
    var cards = dc.cards || {};

    var secHead = function(label, actHtml){
      return '<div class="dash-sec"><h3>' + label + '</h3>' + (actHtml || '') + '</div>';
    };
    var seeAll = function(tabId, label){
      return '<button type="button" data-act="tab" data-id="' + tabId + '">' + (label || 'View all') + '</button>';
    };
    var alertRow = function(kind, title, sub, count, tabId){
      return '<button type="button" class="dash-alert" data-act="tab" data-id="' + tabId + '">' +
        '<span class="dot ' + kind + '"></span>' +
        '<span class="grow"><b>' + esc(title) + '</b><span class="sub">' + esc(sub) + '</span></span>' +
        (count ? '<span class="dash-count">' + count + '</span>' : '') +
        '<span class="dash-go">›</span></button>';
    };

    var inv = branchInvoices();
    var todays = inv.filter(function (i) { return i.date === today(); });
    var month = inv.filter(function (i) { return i.date >= S.monthStart() && i.date <= today(); });
    var salesToday = todays.reduce(function (s, i) { return s + i.total; }, 0);
    var salesMonth = month.reduce(function (s, i) { return s + i.total; }, 0);
    var expMonth = branchExpenses().filter(function (x) { return x.date >= S.monthStart(); })
      .reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var unpaid = inv.reduce(function (s, i) { return s + Math.max(0, i.total - i.paid); }, 0);
    var low = db.items.filter(function (it) { return stockOf(it) <= Number(it.reorder); });
    var pend = S.pendingTransfersFor(ui.branch);
    var dmgPend = pendingDamages(ui.branch);
    var purchPend = pendingPurchaseApprovals();
    var purchNotices = myPurchaseApprovalNotices();
    var purchApproved = (typeof visiblePurchases === 'function' ? visiblePurchases() : [])
      .filter(function (p) { return purchaseStatus(p) === 'approved'; });
    var purchPaid = r2(purchApproved.reduce(function (s, p) {
      var pd = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
      return s + Math.max(0, Number(pd) || 0);
    }, 0));
    var purchDue = r2(purchApproved.reduce(function (s, p) {
      var pd = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
      return s + Math.max(0, Number(p.total || 0) - Number(pd || 0));
    }, 0));
    var dashMore = ui.dashMore || (ui.dashMore = { complaints: 0, recent: 0 });
    var recentAll = inv.slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    var recent = recentAll.slice(0, 40 + Math.max(0, Number(dashMore.recent) || 0));
    var openComplaints = (db.complaints || []).filter(function (c) {
      return (c.status || 'open') === 'open' && c.branchId === ui.branch;
    }).sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || (a.created || 0) - (b.created || 0); });
    var me = S.currentStaff();
    var myTarget = me ? Number(me.target) || 0 : 0;
    var mySales = me ? staffSales(me.id) : 0;
    var myPct = myTarget > 0 ? Math.min(100, Math.round(mySales / myTarget * 100)) : 0;

    var eodRemind = new Date().getHours() >= 20;
    try {
      var _ek = 'eod_notif_' + today() + '_' + (ui.branch || '');
      if (eodRemind && typeof Notification !== 'undefined' && Notification.permission === 'granted' && !localStorage.getItem(_ek)) {
        localStorage.setItem(_ek, '1');
        new Notification("Share today's store report", { body: 'End of day report is ready to share before closing.' });
      }
    } catch (e) {}

    var sec = {};
    sec.eod = function(){
      if (!eodRemind) return '';
      return '<div class="dash-list" style="margin-bottom:10px">' +
        '<button type="button" class="dash-alert" data-act="eod-open">' +
          '<span class="dot info"></span>' +
          '<span class="grow"><b>Share today\u2019s report</b><span class="sub">It\u2019s past 8 PM \u2014 share the store report before closing.</span></span>' +
          '<span class="dash-go">\u203a</span>' +
        '</button></div>';
    };
    sec.kpis = function(){
      var showToday = cards.salesToday !== false;
      var strip = [];
      if (cards.salesMonth !== false) strip.push({ k:'This month', v:money(salesMonth) });
      if (cards.expensesMonth !== false) strip.push({ k:'Expenses', v:money(expMonth), bad: expMonth > 0 });
      if (cards.unpaid !== false) strip.push({ k:'Unpaid', v:money(unpaid), bad: unpaid > 0 });
      if (cards.myTarget !== false && myTarget > 0) strip.push({ k:'Target', v:myPct + '%' });
      if (!showToday && !strip.length) return '';
      return '<div class="dash-hero">' +
        (showToday ? '<div class="dash-hero-top"><div>' +
          '<div class="k">Sales today</div><div class="v">' + money(salesToday) + '</div></div>' +
          '<div class="meta">' + todays.length + ' bill' + (todays.length === 1 ? '' : 's') + ' today</div></div>' : '') +
        (strip.length ? '<div class="dash-strip">' + strip.map(function (x) {
          return '<div><span>' + esc(x.k) + '</span><b' + (x.bad ? ' class="bad"' : '') + '>' + x.v + '</b></div>';
        }).join('') + '</div>' : '') +
        (cards.purchases === false ? '' : '<div class="dash-list" style="margin-top:10px">' +
          '<button type="button" class="dash-alert" data-act="tab" data-id="purchases">' +
            '<span class="dot info"></span>' +
            '<span class="grow"><b>Purchases</b><span class="sub">Paid ' + money(purchPaid) + '</span></span>' +
            (purchDue > 0.009 ? '<b class="dash-purch-due">Pending ' + money(purchDue) + '</b>' : '') +
            '<span class="dash-go">\u203a</span></button></div>') +
        '</div>';
    };
    /* every target on one compact card — the personal target and each branch
       target, so the dashboard no longer shows a separate card per target */
    var goalRow = function(label, got, target){
      var pc = targetPct(got, target);
      return '<div class="trow">' +
        '<span class="tl">' + esc(label) + '</span>' +
        '<span class="tv">' + money(got) + ' / ' + money(target) + '</span>' +
        '<b class="tp">' + pc + '%</b>' +
        '<span class="tbar"><span style="width:' + Math.min(100, pc) + '%"></span></span></div>';
    };
    sec.btargets = function(){
      var showProfit = can('profit.view');
      var rows = '';
      if (myTarget > 0) rows += goalRow('My target', mySales, myTarget);
      S.visibleBranches().forEach(function (b) {
        var tg = branchTarget(b.id);
        if (!tg.sales && !(tg.profit && showProfit)) return;
        var st = branchMonthStats(b.id);
        if (tg.sales) rows += goalRow(b.name, st.sales, tg.sales);
        if (tg.profit && showProfit) rows += goalRow(b.name + ' \u00b7 profit', st.profit, tg.profit);
      });
      if (!rows) return '';
      return secHead('Targets \u00b7 this month') + '<div class="dash-goal dash-targets">' + rows + '</div>';
    };
    sec.attention = function(){
      var rows = '';
      if (S.isOwner()) {
        if (purchPend.length) rows += alertRow('warn', 'Purchases waiting for approval',
          purchPend.length + ' request' + (purchPend.length === 1 ? '' : 's') + ' to review', purchPend.length, 'purchases');
      } else if (purchNotices.length) {
        rows += alertRow('ok', 'Purchases approved',
          purchNotices.length + ' approved \u2014 tap to view', purchNotices.length, 'purchases');
      }
      if (pend.length) rows += alertRow('warn', 'Stock transfers to accept',
        'Waiting for ' + branchName(ui.branch), pend.length, 'transfers');
      if (dmgPend.length) rows += alertRow('bad', 'Damage not settled',
        can('damage.settle') ? 'Tap to settle the loss' : 'Waiting for the owner to settle', dmgPend.length, 'damage');
      if (low.length) rows += alertRow('bad', 'Low stock items',
        'At or below reorder level', low.length, 'items');
      if (!rows) return '';
      return secHead('Needs attention') + '<div class="dash-list">' + rows + '</div>';
    };
    sec.collect = function(){
      var dues = custDues();
      if (!dues.length) return '';
      var n = Math.max(1, Number(lim.collect) || 3);
      var total = r2(dues.reduce(function (a, r) { return a + r.due; }, 0));
      var rows = dues.slice(0, n).map(function (r) {
        return '<button type="button" class="dash-row" data-act="dues-open" data-id="' + esc(r.id) + '">' +
          '<span class="grow"><b>' + esc(r.name) + '</b><span class="sub">' +
            (r.oldest ? 'Since ' + esc(fmtDate(r.oldest)) + ' \u00b7 ' + daysSince(r.oldest) + ' days' : 'Open balance') +
          '</span></span><span class="val bad">' + money(r.due) + '</span></button>';
      }).join('');
      return secHead('To collect \u00b7 ' + money(total) + '<span class="dash-sec-sub">' + dues.length + ' part' + (dues.length === 1 ? 'y' : 'ies') + '</span>',
        dues.length > n ? seeAll('customers') : '') + '<div class="dash-list">' + rows + '</div>';
    };
    sec.complaints = function(){
      if (!openComplaints.length || !can('complaints')) return '';
      var n = 5 + Math.max(0, Number(dashMore.complaints) || 0);
      var rows = openComplaints.slice(0, n).map(function (c) {
        return '<button type="button" class="dash-row" data-act="cmp-open" data-id="' + c.id + '">' +
          '<span class="grow"><b>' + esc(c.itemName || 'Product') + '</b><span class="sub">' +
            esc(c.customerName || 'Walk-in') + (c.invoiceNo ? ' \u00b7 ' + esc(c.invoiceNo) : '') +
            ' \u00b7 raised ' + esc(fmtDate(c.date)) + '</span></span>' +
          '<span class="val bad">' + cmpDays(c) + 'd</span><span class="dash-go">\u203a</span></button>';
      }).join('');
      var more = openComplaints.length > n
        ? '<button type="button" class="btn sm" data-act="dash-more" data-id="complaints">Show more (' + (openComplaints.length - n) + ')</button>'
        : '';
      return secHead('Complaints pending<span class="dash-sec-sub">' + openComplaints.length + ' open</span>', more) +
        '<div class="dash-list">' + rows + '</div>';
    };
    sec.recent = function(){
      var list = recent;
      var rows = list.map(function (i) {
        var c = findCust(i.customerId);
        var due = i.total - i.paid;
        var st = due < 0.01 ? '<span class="badge ok">Paid</span>'
          : (i.paid > 0 ? '<span class="badge warn">Partial</span>' : '<span class="badge bad">Unpaid</span>');
        return '<button type="button" class="dash-row" data-act="inv-view" data-id="' + i.id + '">' +
          '<span class="grow"><b>' + esc(c ? c.name : 'Walk-in') + '</b>' +
            '<span class="sub">' + esc(i.no) + ' \u00b7 ' + esc(fmtDate(i.date)) + ' ' + st + '</span></span>' +
          '<span class="val">' + money(i.total) + '</span><span class="dash-go">\u203a</span></button>';
      }).join('');
      var moreRecent = inv.length > list.length
        ? '<div class="dash-more-wrap"><button type="button" class="btn sm" data-act="dash-more" data-id="recent">Show more bills</button></div>'
        : '';
      return secHead('Recent bills<span class="dash-sec-sub">last ' + list.length + ' of ' + inv.length + '</span>',
        inv.length > 40 ? seeAll('invoices') : '') +
        '<div class="dash-list">' + (rows || '<div class="dash-empty">No bills yet \u2014 your first bill will show up here.</div>') + '</div>' + moreRecent;
    };
    sec.low = function(){
      var n = Math.max(1, Number(lim.low) || 4);
      if (!low.length) return '';
      var rows = low.slice(0, n).map(function (it) {
        return '<button type="button" class="dash-row" data-act="tab" data-id="items">' +
          '<span class="grow"><b>' + esc(it.name) + '</b><span class="sub">' +
            esc(it.sku || 'No code') + ' \u00b7 reorder at ' + num(it.reorder) + '</span></span>' +
          '<span class="val bad">' + num(stockOf(it)) + ' left</span></button>';
      }).join('');
      return secHead('Low stock', low.length > n ? seeAll('items') : '') + '<div class="dash-list">' + rows + '</div>';
    };

    var body = '';
    secOrder.forEach(function(id){ if (secOn(id) && sec[id]) body += sec[id](); });

    return `
      <div class="dash-top">
        <div><h2>Dashboard</h2>
          <div class="sub">${esc(branchName(ui.branch))} \u00b7 ${esc(fmtDate(today()))} \u00b7 ${db.items.length} items</div></div>
        <details class="dash-menu">
          <summary aria-label="More actions">\u22ee</summary>
          <div class="dash-menu-panel">
            <button type="button" data-act="new-bill">New bill</button>
            <button type="button" data-act="eod-open">EOD report</button>
            ${can('reports') ? '<button type="button" data-act="tab" data-id="reports">Reports</button>' : ''}
          </div>
        </details>
      </div>
      ${body}
    `;
  }

  /* the highest number already used on any saved bill, so a bill can never
     repeat a number even if the saved counter is out of date or was restored
     from an older cloud copy */
  function billNumberFloor() {
    var max = 0;
    (db.invoices || []).forEach(function (i) {
      var m = String(i.no || '').match(/(\d+)\s*$/);
      if (m) max = Math.max(max, Number(m[1]) || 0);
    });
    return max;
  }
  function nextBillSeq() {
    return Math.max(Number(db.counter) || 1040, billNumberFloor()) + 1;
  }
  function billTotals() {
    var globalTaxOn = db && db.settings ? db.settings.taxOn !== false : true;
    var rate = (globalTaxOn && ui.bill && ui.bill.taxOn === true) ? (Number(db.settings.taxRate) || 0) : 0;
    return S.compute(ui.bill.lines, ui.bill.discount, rate, billChargesOn());
  }
  function billChargesOn() {
    return ((ui.bill && ui.bill.charges) || []).filter(function (c) { return c.on && Number(c.amount) > 0; })
      .map(function (c) { return { name: c.name, amount: r2(c.amount) }; });
  }
  function invoiceCharges(inv) {
    return (inv && Array.isArray(inv.charges)) ? inv.charges.filter(function (c) { return Number(c.amount) > 0; }) : [];
  }
  function termsList() {
    var list = (db.settings.termsList || []).filter(function (t) { return String(t || '').trim(); });
    if (!list.length && String(db.settings.terms || '').trim()) list = [db.settings.terms];
    return list;
  }
  function upiUri(amount, note) {
    var s = db.settings;
    if (!s.upiId) return '';
    var parts = ['pa=' + encodeURIComponent(s.upiId)];
    parts.push('pn=' + encodeURIComponent(s.business || ''));
    var amt = Number(amount) || 0;
    if (amt > 0) parts.push('am=' + encodeURIComponent(amt.toFixed(2)));
    parts.push('cu=INR');
    if (note) parts.push('tn=' + encodeURIComponent(note));
    return 'upi://pay?' + parts.join('&');
  }
  function qrHTML(amount, note, cls, showId) {
    var s = db.settings;
    if (s.showUpiQrOnInvoice === false || !s.upiId || typeof window.qrcode !== 'function') return '';
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(upiUri(amount, note));
      qr.make();
      return `<div class="qr-box ${cls || ''}"><img alt="UPI payment QR code" src="${qr.createDataURL(4, 8)}">
        <div class="qr-cap">Scan to pay${showId && s.upiId ? ' ' + esc(s.upiId) : ''}</div></div>`;
    } catch (e) { return ''; }
  }

  var PAY_METHODS = ['Cash', 'UPI', 'Card', 'Bank transfer', 'EMI', 'Credit'];

  /* a bill counts as EMI if it has finance details or was paid by EMI */
  function isEmiBill(i) {
    if (!i) return false;
    if (i.emi && (i.emi.finance || i.emi.monthly || i.emi.months || i.emi.date)) return true;
    if (/emi/i.test(String(i.method || ''))) return true;
    return (i.payments || []).some(function (p) { return /emi/i.test(String((p && p.method) || '')); });
  }

  function emiFromPayments() {
    var rows = (ui.bill && ui.bill.payments) || [];
    var src = rows.filter(function (p) { return p.method === 'EMI' && (Number(p.amount) || 0) > 0; })[0]
      || rows.filter(function (p) { return p.method === 'EMI'; })[0];
    if (!src || !src.emi) return null;
    var e = src.emi;
    var out = {
      finance: String(e.finance || '').trim(),
      monthly: r2(Number(e.monthly) || 0),
      date: e.date || '',
      months: Math.max(0, parseInt(e.months, 10) || 0)
    };
    if (!out.finance && !out.monthly && !out.date && !out.months) return null;
    return out;
  }

  /* EMI plans need a few extra details, kept with the payment row */
  function emiBoxHTML(p, i) {
    var e = p.emi || {};
    return `<div class="emi-box">
      <div class="emi-grid">
        <div class="emi-f"><label>Finance name</label>
          <input class="inp" type="text" data-input="emi-finance" data-id="${i}" value="${esc(e.finance || '')}" placeholder="Bajaj, HDB…"></div>
        <div class="emi-f"><label>Monthly EMI</label>
          <input class="inp" type="text" inputmode="decimal" data-input="emi-monthly" data-id="${i}" value="${e.monthly ? e.monthly : ''}" placeholder="0"></div>
        <div class="emi-f"><label>First EMI date</label>
          <input class="inp" type="date" data-input="emi-date" data-id="${i}" value="${esc(e.date || '')}"></div>
        <div class="emi-f"><label>Loan total months</label>
          <input class="inp" type="text" inputmode="numeric" data-input="emi-months" data-id="${i}" value="${e.months ? e.months : ''}" placeholder="0"></div>
      </div>
    </div>`;
  }

  function paymentTotal() {
    return r2((ui.bill.payments || []).reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0));
  }
  function syncPayments() {
    if (!ui.bill) return;
    var b = ui.bill;
    if (!b.payments || !b.payments.length) b.payments = [{ method: 'Cash', amount: 0 }];
    if (b.autoPay === false) return;
    var total = billTotals().total;
    if (b.payments.length === 1) { b.payments[0].amount = total; return; }
    var n = b.payments.length;
    var base = Math.floor((total / n) * 100) / 100;
    b.payments.forEach(function (p, i) {
      p.amount = i === n - 1 ? r2(total - base * (n - 1)) : base;
    });
  }
  function custPickHTML() {
    var q = ui.custQ || '';
    if (!q) return '';
    var list = db.customers.filter(function (c) {
      return match(c.name, q) || match(c.phone, q) || match(c.email, q);
    }).slice(0, 8);
    if (!list.length) {
      return '<div class="empty" style="border:0;background:transparent"><b>No customer found</b>Try another search or use “+ New customer”.</div>';
    }
    return list.map(function (c) {
      return `<button type="button" data-act="pick-cust" data-id="${c.id}">
        <span class="grow"><span class="nm">${esc(c.name)}</span><br>
        <span class="meta">${esc(c.phone || 'no phone')}${c.email ? ' · ' + esc(c.email) : ''}</span></span>
        <span class="pr">Select</span></button>`;
    }).join('');
  }

  function viewBill() {
    if (!ui.bill) newBill();
    var b = ui.bill;
    if (b.customerChosen === undefined) b.customerChosen = !!b.customerId;
    syncPayments();
    var t = billTotals();
    var taxRate = Number(db.settings.taxRate) || 0;
    var taxOn = !!(db.settings.taxOn !== false && b.taxOn && taxRate > 0);
    var isEst = b.kind === 'estimate';
    var nextNo = isEst ? 'EST-' + nextEstSeq() : branchPrefix(ui.branch) + '-' + nextBillSeq();
    var paid = paymentTotal();
    var due = r2(t.total - paid);
    var cust = b.customerId ? findCust(b.customerId) : null;
    var lines = b.lines.length;

    // Step 1: choose customer (compact)
    if (!b.customerChosen) {
      return `<div class="bill-compact bill-fast">
      <div class="page-head bill-fast-head compact-head">
        <div>
          <h2>New ${isEst ? 'estimate' : 'sale'} <span class="bill-fast-no">${esc(nextNo)}</span></h2>
          <div class="sub">${esc(branchName(ui.branch))} · ${esc(fmtDate(today()))}</div>
        </div>
        <div class="row-actions">${billKindSeg(b)}<button class="btn sm" data-act="clear-cart">Cancel</button></div>
      </div>

      <div class="card bill-step compact-card">
        <div class="card-head" style="margin-bottom:8px"><h3>Customer</h3><span class="sub">Step 1 of 2</span></div>
        <div class="searchbox" style="margin-bottom:8px">${ico('search')}
          <input class="inp" data-input="cust-search" placeholder="Search name or phone…" value="${esc(ui.custQ || '')}" autocomplete="off" autofocus></div>
        <div class="row-actions" style="margin-bottom:8px">
          <button class="btn sm primary" data-act="cust-walkin">Walk-in</button>
          <button class="btn sm" data-act="cust-quick-new">+ New customer</button>
        </div>
        <div class="item-pick" id="custPick">${custPickHTML()}</div>
      </div></div>`;
    }

    // Step 2: fast billing (compact)
    var custLabel = cust
      ? `<b>${esc(cust.name)}</b>${cust.phone ? ' · ' + esc(cust.phone) : ''}`
      : `<b>Walk-in</b>`;

    return `<div class="bill-compact bill-fast">
      <div class="bill-topbar">
        <div class="bill-topbar-main">
          <div class="bill-top-title">${b.editId ? 'Edit bill' : (isEst ? 'New estimate' : 'New sale')} <b>${esc(b.editId ? b.editNo : nextNo)}</b></div>
          <div class="sub">${custLabel}</div>
        </div>
        <div class="bill-topbar-actions">
          ${b.editId ? '' : billKindSeg(b)}
          <button class="btn sm" data-act="pick-cust" data-id="" aria-label="Change customer">Change</button>
          ${b.editId
            ? '<button class="btn sm" data-act="edit-cancel" title="Go back without changing this bill">← Back</button>'
            : '<button class="btn sm" data-act="clear-cart">Clear</button>'}
        </div>
      </div>

      <div class="bill-summary-strip">
        <span><span class="k">Items</span> <b>${lines}</b></span>
        <span><span class="k">Date</span> <input class="inp bill-date-inline" type="date" data-input="bill-date" value="${esc(b.editDate || b.date || today())}" title="Bill date — pick any past or present date"></span>
        <span class="bill-strip-total"><span class="k">Total</span> <b>${money(t.total)}</b></span>
      </div>

      <div class="sale-from-cart">
        <div class="billed-header"><span class="billed-check">✓</span> Billed Items</div>
        <div class="billed-list">
          ${lines ? b.lines.map(function (l, i) { return cartLine(l, i); }).join('')
            : '<div class="empty compact"><b>No items added</b>Add items to this sale below.</div>'}
        </div>
        <div class="billed-summary">
          <div class="bs-left">
            <div>Total Disc: ${money(t.discount || 0)}</div>
            <div>Total Qty: ${num(lines ? b.lines.reduce(function(s,l){return s + (Number(l.qty)||0);},0) : 0)}</div>
          </div>
          <div class="bs-right">
            ${(db.settings.taxOn !== false && (Number(db.settings.taxRate) || 0) > 0) ? `<div>Total Tax Amt: ${money(t.tax)}</div>` : ''}
            <div>Subtotal: ${money(t.subtotal)}</div>
          </div>
        </div>
        <div class="billed-add-row single">
          <button class="btn add-items-btn" type="button" data-act="open-item-sheet"><span class="plus">+</span> Add Items</button>
        </div>
      </div>

      ${(db.settings.billFields || []).length ? `<div class="card sale-block">
        <div class="sale-block-head">Bill Details</div>
        <div class="grid2 compact-grid">
          ${db.settings.billFields.map(function (f) {
            return `<div class="field"><label>${esc(f.label)}</label>
              <input class="inp" data-input="bill-field" data-id="${f.id}" value="${esc((b.fields || {})[f.id] || '')}" autocomplete="off"></div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <div class="card sale-block">
        <div class="sale-block-head">Discount &amp; Charges</div>
        <div class="dc-row">
          <span class="dc-label">Discount</span>
          <div class="dc-inputs dc-right">
            ${can('discount') ? `<span class="dc-box">${db.settings.discountType === 'percent' ? '%' : '₹'}</span><input class="inp dc-amt" type="text" inputmode="decimal" min="0" step="0.01" data-input="discount" value="${b.discount ? b.discount : ''}" placeholder="0" aria-label="Discount">`
            : '<span class="sub">Locked</span>'}
          </div>
        </div>
        ${((b.charges || []).length || (db.settings.taxOn !== false && taxRate > 0)) ? `<div class="dc-group">
          ${(db.settings.taxOn !== false && taxRate > 0) ? `<label class="dc-check-row"><input type="checkbox" data-change="bill-tax"${b.taxOn ? ' checked' : ''}> <span>Tax (${num(taxRate)}%)</span><span class="dc-val">${b.taxOn ? money(t.tax) : money(0)}</span></label>` : ''}
          ${(b.charges || []).map(function (c, i) {
            return `<div class="dc-charge-row"><label class="dc-check-row"><input type="checkbox" data-change="bill-charge" data-id="${i}"${c.on ? ' checked' : ''}> <span>${esc(c.name)}</span></label><div class="dc-right"><span class="dc-box">₹</span><input class="inp dc-amt" type="text" inputmode="decimal" min="0" step="0.01" data-input="bill-charge-amount" data-id="${i}" value="${c.amount || 0}" aria-label="${esc(c.name)} amount"></div></div>`;
          }).join('')}
        </div>` : ''}
        ${t.roundOff ? `<div class="dc-total-row"><span>Round off</span><b>${t.roundOff > 0 ? '+ ' : '− '}${money(Math.abs(t.roundOff))}</b></div>` : ''}
        <div class="dc-total-row"><span>${isEst ? 'Estimate Amount' : 'Total Amount'}</span><b>${money(t.total)}</b></div>
        ${isEst ? '' : `<div class="dc-total-row recv"><span>Received</span><b>${money(paid)}</b></div>
        <div class="dc-total-row due"><span>Balance Due</span><b>${money(Math.max(0, due))}</b></div>`}
      </div>

      ${isEst ? '' : `<div class="card sale-block">
        <div class="sale-block-head">Payment Details</div>
        <div class="pd-head-row${b.payments.length > 1 ? ' has-rm' : ''}"><span>Payment Type</span><span class="pd-head-amt">Amount</span>${b.payments.length > 1 ? '<span></span>' : ''}</div>
        ${b.payments.map(function (p, i) {
          return `<div class="pd-row${b.payments.length > 1 ? ' has-rm' : ''}">
            <div class="pd-col pd-method">
              <select class="inp" data-change="pay-method" data-id="${i}" aria-label="Payment method">
                ${PAY_METHODS.map(function (m) { return `<option${p.method === m ? ' selected' : ''}>${m}</option>`; }).join('')}
              </select>
            </div>
            <div class="pd-col pd-amount">
              <div class="pd-amt-wrap"><span class="dc-box">₹</span><input class="inp dc-amt" type="text" inputmode="decimal" min="0" step="0.01" data-input="pay-amount" data-id="${i}" value="${Number(p.amount) ? p.amount : ''}" placeholder="0" aria-label="Amount"></div>
            </div>
            ${b.payments.length > 1 ? `<button class="icon-btn pd-rm" type="button" data-act="pay-remove" data-id="${i}" aria-label="Remove">✕</button>` : ''}
          </div>${p.method === 'EMI' ? emiBoxHTML(p, i) : ''}`;
        }).join('')}
        <div class="row-actions" style="margin-top:8px">
          <button class="btn sm linkish" type="button" data-act="pay-add">+ Add Payment Type</button>
          <button class="btn sm" type="button" data-act="pay-full">Full amount</button>
        </div>
      </div>`}

      <div class="sale-bottom-bar single">
        <button class="btn primary sale-save-primary" type="button" data-act="save-bill" data-mode="save">${isEst ? 'Save Estimate' : 'Save Bill'}</button>
      </div>
      <div class="hint" style="margin:8px 4px 0">${b.editId
        ? 'Stock in ' + esc(branchName(b.editBranch)) + ' updates with your changes.'
        : isEst
          ? 'Estimate only — stock in ' + esc(branchName(ui.branch)) + ' is not changed.'
          : 'Stock in ' + esc(branchName(ui.branch)) + ' updates when you save.'}</div>
      ${itemSheetHTML()}
    </div>`;
  }

  function countPickText() {
    return (ui.q || '') ? 'Matching items' : 'Search to add';
  }

  function pickListHTML() {
    var q = ui.q || '';
    if (!q) return '';
    var list = db.items.filter(function (it) {
      return match(it.name, q) || match(it.sku, q) || match(it.category, q);
    }).slice(0, 12);
    if (!list.length) return '<div class="empty" style="border:0;background:transparent"><b>No match</b>Try another name or SKU.</div>';
    return list.map(function (it) {
      return `<button type="button" data-act="add-item" data-id="${it.id}">
        <span class="grow"><span class="nm">${esc(it.name)}</span><br>
        <span class="meta">${esc(it.sku || '—')} · ${num(stockOf(it))} in stock</span></span>
        <span class="pr">${money(it.price)}</span></button>`;
    }).join('');
  }

  function cartLine(l, i) {
    var details = [];
    if (l.desc) details.push(esc(l.desc));
    if (l.imei) details.push('IMEI: ' + esc(l.imei));
    if (l.serial) details.push('Serial: ' + esc(l.serial));
    var qty = Number(l.qty) || 0;
    var price = Number(l.price) || 0;
    var gross = r2(qty * price);
    var ldisc = Math.min(gross, Math.max(0, r2(Number(l.disc) || 0)));
    var lineAmt = r2(gross - ldisc);
    var taxShow = (db.settings && db.settings.taxOn !== false && (Number(db.settings.taxRate) || 0) > 0);
    var it = itemById(l.itemId);
    var brId = billBranchId();
    var have = it ? (Number(S.stockOf(it, brId)) || 0) : null;
    var over = (have != null && qty > have + 0.0001);
    return `<div class="billed-item" data-act="line-more" data-id="${i}" role="button" tabindex="0">
      <div class="bi-top">
        <div class="bi-left"><span class="bi-no">#${i + 1}</span><span class="bi-name">${esc(l.name)}</span></div>
        <div class="bi-amt">${money(lineAmt)}</div>
      </div>
      <div class="bi-row"><span>Item Subtotal</span><span>${num(qty)} x ${num(price)} = ${num(gross)}</span></div>
      ${ldisc > 0 ? `<div class="bi-row bi-muted"><span>Item discount</span><span>− ${money(ldisc)}</span></div>` : ''}
      ${taxShow ? `<div class="bi-row bi-muted"><span>Tax : 0%</span><span>${money(0)}</span></div>` : ''}
      ${over ? `<div class="bi-details" style="color:var(--danger,#b91c1c)">Only ${num(have)} in ${esc(branchName(brId))}</div>` : ''}
      ${details.length ? `<div class="bi-details">${details.join(' · ')}</div>` : ''}
    </div>`;
  }

  function lineDetailsModal(i) {
    if (!ui.bill || !ui.bill.lines[i]) return;
    var l = ui.bill.lines[i];
    var ldisc = Math.max(0, r2(Number(l.disc) || 0));
    openModal('Item options', `<form data-form="linedetails">
      <input type="hidden" name="idx" value="${i}">
      <div class="sub" style="margin-bottom:12px">${esc(l.name)}</div>
      <div class="grid2">
        <div class="field"><label>Quantity</label><input class="inp" type="text" inputmode="decimal" name="qty" value="${l.qty || 1}" min="1"></div>
        <div class="field"><label>Discount on this item (₹)</label><input class="inp" type="text" inputmode="decimal" name="disc" value="${ldisc ? ldisc : ''}" placeholder="0"></div>
      </div>
      <div class="field"><label>Description</label><input class="inp" name="desc" value="${esc(l.desc || '')}" placeholder="Colour, size, condition…"></div>
      <div class="grid2">
        <div class="field"><label>IMEI number</label><input class="inp" name="imei" value="${esc(l.imei || '')}" placeholder="For phones/devices"></div>
        <div class="field"><label>Serial number</label><input class="inp" name="serial" value="${esc(l.serial || '')}" placeholder="Product serial"></div>
      </div>
      <div class="row-actions" style="justify-content:space-between;margin-top:16px;gap:8px;flex-wrap:wrap">
        <button class="btn danger sm" type="button" data-act="line-remove" data-id="${i}">Remove item</button>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex:1">
          <button class="btn" type="button" data-act="close-modal">Cancel</button>
          <button class="btn primary" type="submit">Save</button>
        </div>
      </div>
    </form>`);
  }


  function billBranchId() {
    return (ui.bill && ui.bill.editId) ? (ui.bill.editBranch || ui.branch) : ui.branch;
  }
  function stockOverLines(lines, branchId) {
    var by = Object.create(null);
    (lines || []).forEach(function (l) {
      if (!l.itemId) return;
      by[l.itemId] = r2((by[l.itemId] || 0) + (Number(l.qty) || 0));
    });
    var over = [];
    Object.keys(by).forEach(function (id) {
      var it = itemById(id); if (!it) return;
      var have = Number(S.stockOf(it, branchId)) || 0;
      var need = Number(by[id]) || 0;
      if (need > have + 0.0001) over.push({ it: it, need: need, have: have, short: r2(need - have) });
    });
    return over;
  }
  function oversellMsg(over, branchId) {
    var br = branchName(branchId);
    return (over || []).map(function (o) { return 'Only ' + num(o.have) + ' in ' + br + ' for ' + o.it.name; }).join('. ');
  }
  function allowOversell(over, branchId) {
    var policy = (db.settings && db.settings.stockPolicy) || 'warn';
    var msg = oversellMsg(over, branchId);
    if (policy === 'block') { toast(msg || 'Not enough stock in this branch'); return false; }
    return confirm((msg ? msg + '. ' : '') + 'Sell anyway? stock will go negative');
  }


  function addToCart(id, opts) {
    opts = opts || {};
    var it = itemById(id);
    if (!it) return;
    var addQty = Math.max(1, Math.floor(Number(opts.qty) || 1));
    if (ui.bill && ui.bill.kind !== 'estimate') {
      var brId = billBranchId();
      var next = (ui.bill.lines || []).map(function (l) { return { itemId: l.itemId, qty: l.qty }; });
      var hit = next.filter(function (l) { return l.itemId === id; })[0];
      if (hit) hit.qty = r2((Number(hit.qty) || 0) + addQty); else next.push({ itemId: id, qty: addQty });
      var over = stockOverLines(next, brId);
      if (over.length && !opts.force && !allowOversell(over, brId)) return;
    }
    var line = ui.bill.lines.filter(function (l) { return l.itemId === id; })[0];
    if (line) line.qty = r2((Number(line.qty) || 0) + addQty);
    else ui.bill.lines.push({ itemId: it.id, name: it.name, qty: addQty, price: Number(it.price) || 0, cost: Number(it.cost) || 0, disc: 0, desc: '', imei: '', serial: '' });
    if (!opts.silent) {
      ui.q = '';
      render();
      var s = $('#itemSearch');
      if (s) s.focus();
    }
  }

  function addItemsToCart(items) {
    (items || []).forEach(function (x) {
      if (!x || !x.id) return;
      addToCart(x.id, { silent: true, qty: x.qty });
    });
  }

  function itemSheetState() {
    if (!ui.itemSheet) ui.itemSheet = { open: false, q: '', sel: {} };
    if (!ui.itemSheet.sel) ui.itemSheet.sel = {};
    return ui.itemSheet;
  }

  function itemSheetSelectedCount(sel) {
    return Object.keys(sel || {}).filter(function (k) { return Number(sel[k]) > 0; }).length;
  }

  function itemSheetHTML() {
    var sh = itemSheetState();
    if (!sh.open) return '';
    var q = sh.q || '';
    var list = db.items.filter(function (it) {
      return !q || match(it.name, q) || match(it.code, q) || match(it.cat, q);
    });
    var selCount = itemSheetSelectedCount(sh.sel);
    var rows = list.length ? list.map(function (it) {
      var stockQty = (typeof S !== 'undefined' && S.stockOf) ? S.stockOf(it, ui.branch) : ((typeof stockOf === 'function') ? stockOf(it, ui.branch) : 0);
      var low = stockQty <= (Number(it.reorder) || 0);
      var selQty = Math.max(0, Math.floor(Number(sh.sel[it.id]) || 0));
      var checked = selQty > 0;
      return `<div class="sheet-item${checked ? ' sel' : ''}" data-act="item-sheet-toggle" data-id="${it.id}" role="button" tabindex="0">
        <span class="sheet-check">${checked ? '✓' : ''}</span>
        <span class="sheet-item-main">
          <span class="sheet-item-name">${esc(it.name)}</span>
          <span class="sheet-item-meta">${esc(it.cat || 'Item')} · ${money(it.price || 0)} · <span class="${low ? 'badge warn' : 'sub'}">${num(stockQty)} in stock</span></span>
        </span>
        ${checked ? `<div class="sheet-qty" data-stop-sheet="1">
          <button class="btn sm icon" type="button" data-act="item-sheet-qty-down" data-id="${it.id}" aria-label="Less">−</button>
          <span class="sheet-qty-val">${selQty}</span>
          <button class="btn sm icon" type="button" data-act="item-sheet-qty-up" data-id="${it.id}" aria-label="More">+</button>
        </div>` : ''}
      </div>`;
    }).join('') : '<div class="empty" style="margin:8px 0"><b>No items found</b>Try a different search.</div>';
    return `<div class="sheet-overlay open" data-act="close-item-sheet">
      <div class="sheet-panel" data-stop-sheet="1">
        <div class="sheet-head">
          <div><b>Select items</b><div class="sub">${selCount} selected</div></div>
          <button class="icon-btn" type="button" data-act="close-item-sheet" aria-label="Close">✕</button>
        </div>
        <div class="sheet-search searchbox">${ico('search')}<input class="inp" data-input="item-sheet-q" placeholder="Search items…" value="${esc(q)}" autocomplete="off"></div>
        <div class="sheet-list">${rows}</div>
        <div class="sheet-foot">
          <button class="btn sheet-btn-light" type="button" data-act="item-new">+ New item</button>
          <span class="sheet-foot-spacer"></span>
          <button class="btn sheet-btn-light" type="button" data-act="close-item-sheet">Cancel</button>
          <button class="btn sheet-btn-light sheet-btn-add" type="button" data-act="item-sheet-add"${selCount ? '' : ' disabled'}>Add ${selCount ? selCount + ' item' + (selCount > 1 ? 's' : '') : 'items'}</button>
        </div>
      </div>
    </div>`;
  }

  function lineQtyMap(lines) {
    var map = {};
    (lines || []).forEach(function (l) {
      if (!l.itemId) return;
      map[l.itemId] = (map[l.itemId] || 0) + Number(l.qty || 0);
    });
    return map;
  }

  function updateInvoice(mode) {
    var b = ui.bill;
    var inv = invById(b.editId);
    if (!inv) return toast('That bill no longer exists');
    if (!b.lines.length) return toast('Add at least one item');
    var charges = billChargesOn();
    var taxRate = (db.settings.taxOn !== false && b.taxOn === true ? (Number(db.settings.taxRate) || 0) : 0);
    var t = S.compute(b.lines, b.discount, taxRate, charges);
    var payments = (b.payments || []).filter(function (p) { return (Number(p.amount) || 0) > 0; })
      .map(function (p) { return { method: p.method || 'Cash', amount: r2(p.amount) }; });
    var paid = r2(payments.reduce(function (a, p) { return a + p.amount; }, 0));
    if (paid > t.total + 0.009) return toast('Payments are more than the new total — lower the payment amounts, then save');

    var oldMap = lineQtyMap(inv.lines);
    var newMap = lineQtyMap(b.lines);
    var keys = Object.keys(newMap);
    Object.keys(oldMap).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    var overDelta = [];
    for (var i = 0; i < keys.length; i++) {
      var delta = r2((newMap[keys[i]] || 0) - (oldMap[keys[i]] || 0));
      if (delta > 0) {
        var chk = itemById(keys[i]);
        if (!chk) return toast('One of the items is no longer in your list');
        var have = Number(S.stockOf(chk, inv.branchId)) || 0;
        if (have < delta) {
          overDelta.push({ it: chk, need: delta, have: have, short: r2(delta - have) });
        }
      }
    }
    if (overDelta.length) {
      var policy = (db.settings && db.settings.stockPolicy) || 'warn';
      if (policy === 'block') {
        return toast('Only ' + num(overDelta[0].have) + ' more ' + overDelta[0].it.name + ' in stock');
      }
      var msg = overDelta.map(function (o) { return 'Only ' + num(o.have) + ' more ' + o.it.name + ' in ' + branchName(inv.branchId); }).join('. ');
      if (!confirm((msg ? msg + '. ' : '') + 'Sell anyway? stock will go negative')) return;
    }

    var snapshot = JSON.parse(JSON.stringify(inv));
    var branchId = inv.branchId;
    keys.forEach(function (id) {
      var it = itemById(id);
      if (!it) return;
      var d = r2((newMap[id] || 0) - (oldMap[id] || 0));
      if (d) S.addStock(it, branchId, -d);
    });

    if (b.editDate && /^\d{4}-\d{2}-\d{2}$/.test(b.editDate)) inv.date = b.editDate;
    inv.customerId = b.customerId || '';
    inv.lines = b.lines.map(function (l) {
      return {
        itemId: l.itemId, name: l.name, qty: l.qty, price: l.price, cost: l.cost, disc: r2(Number(l.disc) || 0),
        desc: String(l.desc || ''), imei: String(l.imei || ''), serial: String(l.serial || '')
      };
    });
    inv.discount = Number(b.discount) || 0;
    inv.charges = charges;
    inv.fields = (db.settings.billFields || [])
      .map(function (f) { return { label: f.label, value: String((b.fields || {})[f.id] || '').trim() }; })
      .filter(function (f) { return f.value; });
    inv.subtotal = t.subtotal;
    inv.taxRate = taxRate;
    inv.tax = t.tax;
    inv.roundOff = r2(t.roundOff || 0);
    inv.total = t.total;
    inv.paid = paid;
    inv.payments = payments;
    inv.emi = emiFromPayments();
    inv.method = payments.map(function (p) { return p.method; }).filter(function (m, n, arr) { return arr.indexOf(m) === n; }).join(' + ') || 'Credit';
    inv.editedAt = Date.now();
    inv.editedBy = (S.currentStaff() || {}).name || '';

    logActivity('Edited bill ' + inv.no + ' for ' + (findCust(inv.customerId) ? findCust(inv.customerId).name : 'walk-in') + ' — now ' + money(inv.total), 'bill');
    save();
    ui.bill = null; newBill();
    ui.tab = 'invoices';
    render();
    toast('Bill ' + inv.no + ' updated', { undo: { label: 'Bill changes undone', run: function () {
      var cur = invById(snapshot.id);
      if (!cur) return;
      var curMap = lineQtyMap(cur.lines);
      var backMap = lineQtyMap(snapshot.lines);
      Object.keys(curMap).concat(Object.keys(backMap)).filter(function (k, n, arr) { return arr.indexOf(k) === n; })
        .forEach(function (id) {
          var it = itemById(id);
          if (!it) return;
          var d = r2((curMap[id] || 0) - (backMap[id] || 0));
          if (d) S.addStock(it, branchId, d);
        });
      db.invoices = db.invoices.map(function (x) { return x.id === snapshot.id ? snapshot : x; });
    } } });
    openBillPreview(inv);
  }

  /* Saving a bill is confirmed first: the popup shows what is about to be
     saved and lets you save, cancel, or step back into the bill and edit it. */
  function billSaveModal(mode) {
    if (!can('bill')) return toast('No permission to bill');
    var b = ui.bill;
    if (!b) return;
    if (!b.editId && !b.lines.length) return toast('Add at least one item');
    var t = billTotals();
    var paid = r2((b.payments || []).reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0));
    var due = r2(Math.max(0, t.total - paid));
    var cust = b.customerId ? findCust(b.customerId) : null;
    var itemCount = (b.lines || []).reduce(function (s, l) { return s + (Number(l.qty) || 0); }, 0);
    var editMode = !!b.editId;
    var isEst = !editMode && b.kind === 'estimate';
    openModal(editMode ? 'Save changes to ' + (b.editNo || 'this bill') + '?' : (isEst ? 'Save this estimate?' : 'Save this bill?'), `
      <div class="card" style="margin:0 0 12px">
        <div class="title" style="font-weight:600">${cust ? esc(cust.name) : 'Walk-in customer'}</div>
        <div class="sub">${num(itemCount)} ${itemCount === 1 ? 'item' : 'items'} · ${esc(branchName(editMode ? b.editBranch : ui.branch))} · ${esc(fmtDate(b.editDate || b.date || today()))}</div>
      </div>
      <div class="p-view-tot">
        <div><span>Subtotal</span><b>${money(t.subtotal)}</b></div>
        ${Number(t.tax) ? `<div><span>Tax</span><b>${money(t.tax)}</b></div>` : ''}
        <div class="big"><span>Total</span><b>${money(t.total)}</b></div>
        ${isEst ? '' : `<div><span>Received</span><b>${money(paid)}</b></div>
        <div class="${due > 0.009 ? 'due' : ''}"><span>Balance due</span><b>${money(due)}</b></div>`}
      </div>
      <div class="hint" style="margin-top:10px">${editMode
        ? 'Save Bill updates this bill and puts the stock difference back in ' + esc(branchName(b.editBranch)) + '.'
        : isEst
          ? 'An estimate is a quote — nothing is taken out of stock in ' + esc(branchName(ui.branch)) + '.'
          : 'Save Bill takes the items out of stock in ' + esc(branchName(ui.branch)) + ' and opens the bill to print.'}</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="bill-save-cancel">Cancel</button>
        <button class="btn" type="button" data-act="bill-save-edit">Edit</button>
        <button class="btn primary" type="button" data-act="bill-save-yes" data-mode="${mode || 'save'}">${isEst ? 'Save Estimate' : 'Save Bill'}</button>
      </div>`);
  }

  /* Cancel closes the popup and keeps the bill as it is; Edit goes back to the
     bill so it can be changed before saving again. */
  function billSaveCancel() {
    closeModal();
    toast('Bill not saved — still editing');
  }
  function billSaveEdit() {
    closeModal();
    render();
    var first = document.querySelector('.bill-fast [data-input="bill-date"]');
    if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) { try { first.focus(); } catch (e2) {} } }
    toast('Change anything you need, then tap Save Bill again');
  }

  function saveBill(mode) {
    if (!can('bill')) return toast('No permission to bill');
    var b = ui.bill;
    if (b.editId) return updateInvoice(mode);
    if (!b.lines.length) return toast('Add at least one item');
    if (b.kind === 'estimate') return saveEstimate();
    var t = billTotals();
    var payments = (b.payments || []).filter(function (p) { return (Number(p.amount) || 0) > 0; })
      .map(function (p) { return { method: p.method, amount: r2(p.amount) }; });
    var paid = r2(payments.reduce(function (s, p) { return s + p.amount; }, 0));
    if (paid > t.total + 0.009) return toast('Payments are more than the total');
    var over = stockOverLines(b.lines, ui.branch);
    if (over.length && !allowOversell(over, ui.branch)) return;
    var seq = nextBillSeq();
    var invNo = branchPrefix(ui.branch) + '-' + seq;
    while (db.invoices.some(function (x) { return x.no === invNo; })) { seq++; invNo = branchPrefix(ui.branch) + '-' + seq; }
    db.counter = seq;
    var staff = S.currentStaff();
    var inv = {
      id: uid(), no: invNo,
      date: (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : today(), created: Date.now(),
      branchId: ui.branch, staffId: staff ? staff.id : '',
      customerId: b.customerId || '',
      lines: b.lines.map(function (l) { return { itemId: l.itemId, name: l.name, qty: l.qty, price: l.price, cost: l.cost, disc: r2(Number(l.disc) || 0), desc: String(l.desc || ''), imei: String(l.imei || ''), serial: String(l.serial || '') }; }),
      discount: b.discount,
      taxRate: (db.settings.taxOn !== false && ui.bill.taxOn === true ? (Number(db.settings.taxRate) || 0) : 0),
      charges: billChargesOn(),
      fields: (db.settings.billFields || [])
        .map(function (f) { return { label: f.label, value: String((b.fields || {})[f.id] || '').trim() }; })
        .filter(function (f) { return f.value; }),
      subtotal: t.subtotal, tax: t.tax, roundOff: r2(t.roundOff || 0), total: t.total,
      paid: paid,
      payments: payments,
      emi: emiFromPayments(),
      method: payments.map(function (p) { return p.method; }).join(' + ') || 'Credit',
      note: ''
    };
    inv.lines.forEach(function (l) {
      var it = itemById(l.itemId);
      if (it) S.addStock(it, ui.branch, -l.qty);
    });
    db.invoices.push(inv);
    logActivity('Saved bill ' + inv.no + ' for ' + (findCust(inv.customerId) ? findCust(inv.customerId).name : 'walk-in') + ' (' + money(inv.total) + ')', 'bill');
    save();
    ui.bill = null; newBill();
    render();
    toast('Bill ' + inv.no + ' saved');
    openBillPreview(inv);
  }

  /* An estimate quotes prices and terms only: no stock leaves the branch and
     nothing is added to invoices, dues, dashboards or reports. */
  function saveEstimate() {
    var b = ui.bill;
    var t = billTotals();
    var seq = nextEstSeq();
    var estNo = 'EST-' + seq;
    while ((db.estimates || []).some(function (x) { return x.no === estNo; })) { seq++; estNo = 'EST-' + seq; }
    db.ecounter = seq;
    var staff = S.currentStaff();
    var est = {
      id: uid(), no: estNo,
      date: (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) ? b.date : today(), created: Date.now(),
      branchId: ui.branch, staffId: staff ? staff.id : '',
      customerId: b.customerId || '',
      lines: b.lines.map(function (l) { return { itemId: l.itemId, name: l.name, qty: l.qty, price: l.price, cost: l.cost, disc: r2(Number(l.disc) || 0), desc: String(l.desc || ''), imei: String(l.imei || ''), serial: String(l.serial || '') }; }),
      discount: b.discount,
      taxRate: (db.settings.taxOn !== false && b.taxOn === true ? (Number(db.settings.taxRate) || 0) : 0),
      charges: billChargesOn(),
      fields: (db.settings.billFields || [])
        .map(function (f) { return { label: f.label, value: String((b.fields || {})[f.id] || '').trim() }; })
        .filter(function (f) { return f.value; }),
      subtotal: t.subtotal, tax: t.tax, roundOff: r2(t.roundOff || 0), total: t.total,
      note: '', convertedAt: 0, convertedNo: ''
    };
    db.estimates.push(est);
    logActivity('Saved estimate ' + est.no + ' for ' + (findCust(est.customerId) ? findCust(est.customerId).name : 'walk-in') + ' (' + money(est.total) + ')', 'bill');
    save();
    ui.bill = null; newBill();
    render();
    toast('Estimate ' + est.no + ' saved');
    estPreview(est.id);
  }

  /* An estimate is printed and shared with the very same document a bill
     uses, so the preview is the bill preview with quote wording and its own
     actions. */
  function estPreview(id) {
    var e = estById(id);
    if (!e) return toast('Estimate not found');
    var st = billStyle(ui.previewStyle || (db.settings && db.settings.receiptStyle));
    ui.previewStyle = st;
    ui.pdf = null;
    var c = findCust(e.customerId);
    openModal('Estimate ' + esc(e.no), `
      <div class="bp">
        <div class="bp-head">
          <div class="bp-info">
            <div class="bp-cust">${esc(c ? c.name : 'Walk-in customer')}</div>
            <div class="bp-meta">${esc(fmtDate(e.date))} · ${esc(branchName(e.branchId))}</div>
            ${e.convertedAt ? `<div class="bp-meta">Copied into ${esc(e.convertedNo || 'a bill')} — stock moves when that bill is saved.</div>` : ''}
          </div>
          <div class="bp-money">
            <div class="bp-total">${money(e.total)}</div>
            <div class="bp-status warn">Estimate · no stock moved</div>
          </div>
        </div>
        <div class="bill-preview" data-paper="${billPaper(st)}">
          <div class="paper-fit">
            <div class="paper"><div class="inv">${billDocHTML(estAsDoc(e), st)}</div></div>
          </div>
        </div>
        <div class="bp-actions">
          <div class="bp-group bp-primary">
            <label class="bp-layout bp-share-as">
              <span>Share as</span>
              <select class="inp" id="billLayoutSel" data-change="pdf-style" data-id="${e.id}" aria-label="PDF layout to share">
                ${BILL_LAYOUTS.map(function (l) {
                  return `<option value="${l.id}"${l.id === st ? ' selected' : ''}>${l.name}</option>`;
                }).join('')}
              </select>
            </label>
            <button class="btn primary" data-act="pdf-share" data-id="${e.id}">Share PDF · ${billShortName(st)}</button>
            <button class="btn" data-act="pdf-download" data-id="${e.id}">Download</button>
            <button class="btn" data-act="pdf-print" data-id="${e.id}">Print</button>
            <button class="btn" data-act="pdf-wa" data-id="${e.id}">WhatsApp</button>
          </div>
          <div class="bp-section bp-manage">
            <button class="btn sm primary-soft" data-act="est-to-bill" data-id="${e.id}">Convert to bill</button>
            ${canDeleteEntry('invoice') ? `<button class="btn sm danger ghost" data-act="est-del" data-id="${e.id}">Delete</button>` : ''}
            <button class="btn sm ghost" data-act="close-modal">Close</button>
          </div>
        </div>
      </div>`);
    fitPaper();
    pdfFor(e.id, st);
  }

  /* Fills a fresh bill with the estimate's items so it can be saved as a real
     sale — the stock is only deducted when that bill is saved. */
  function estToBill(id) {
    var e = estById(id);
    if (!e) return toast('Estimate not found');
    if (!can('bill')) return toast('No permission to bill');
    closeModal();
    newBill();
    ui.bill.customerId = e.customerId || '';
    ui.bill.customerChosen = true;
    ui.bill.lines = (e.lines || []).map(function (l) {
      return { itemId: l.itemId || '', name: l.name, qty: Number(l.qty) || 1, price: Number(l.price) || 0,
        cost: Number(l.cost) || 0, disc: Number(l.disc) || 0, desc: String(l.desc || ''),
        imei: String(l.imei || ''), serial: String(l.serial || '') };
    });
    ui.bill.discount = Number(e.discount) || 0;
    (e.charges || []).forEach(function (c) {
      var hit = (ui.bill.charges || []).filter(function (x) { return x.name === c.name; })[0];
      if (hit) { hit.on = true; hit.amount = Number(c.amount) || 0; }
      else ui.bill.charges.push({ name: c.name, amount: Number(c.amount) || 0, on: true });
    });
    e.convertedAt = Date.now();
    save();
    go('bill');
    toast('Estimate ' + e.no + ' copied into a bill — stock changes when you save it');
  }

  function deleteEstimate(id) {
    var e = estById(id);
    if (!e) return toast('Estimate not found');
    if (!canDeleteEntry('invoice')) return toast('You do not have permission to delete estimates');
    if (!confirm('Delete estimate ' + e.no + '? This cannot be undone.')) return;
    db.estimates = db.estimates.filter(function (x) { return x.id !== id; });
    logActivity('Deleted estimate ' + e.no, 'bill');
    closeModal();
    save(); render();
    toast('Estimate ' + e.no + ' deleted');
  }

  /* ---------------------------------------------------------------- invoices */
  /* ------------------------------------------------------------------ filters */
  /* dues only ever count bills of the branch being viewed, the same way the
     dashboard, invoices list and reports already do */
  function custDue(id) {
    return r2(branchInvoices().filter(function (i) { return i.customerId === id; })
      .reduce(function (s, i) { return s + Math.max(0, r2(i.total - i.paid)); }, 0));
  }
  function pairs(list) { return list.map(function (x) { return [x, x]; }); }

  /* sc may be 'all' for the all-branch reports, or a branch id; without it the
     current branch is used, as the dashboard and invoices list already do. */
  function custDues(sc) {
    var map = {};
    var list = sc === 'all' ? db.invoices : branchInvoices(sc);
    list.forEach(function (i) {
      var d = r2(i.total - i.paid);
      if (d <= 0.009) return;
      var k = i.customerId || 'walkin';
      if (!map[k]) map[k] = { id: i.customerId || '', name: '', phone: '', due: 0, bills: [], oldest: '' };
      map[k].due = r2(map[k].due + d);
      map[k].bills.push(i);
      if (!map[k].oldest || i.date < map[k].oldest) map[k].oldest = i.date;
    });
    return Object.keys(map).map(function (k) {
      var row = map[k];
      var c = row.id ? findCust(row.id) : null;
      row.name = c ? c.name : 'Walk-in customers';
      row.phone = c ? (c.phone || '') : '';
      row.bills.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
      return row;
    }).sort(function (a, b) { return b.due - a.due; });
  }
  function daysSince(date) {
    if (!date) return 0;
    var a = new Date(date + 'T00:00:00'), b = new Date(today() + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
  }
  function reminderText(c, due) {
    var s2 = db.settings;
    return 'Hello ' + (c ? c.name : '') + ', a gentle reminder from ' + (s2.business || 'our shop') +
      ': ' + money(due) + ' is still due on your account.' +
      (s2.phone ? ' You can call us on ' + s2.phone + '.' : '') + ' Thank you!';
  }
  function reminderLink(c, due) {
    var num2 = String((c && c.phone) || '').replace(/[^0-9]/g, '');
    var text = encodeURIComponent(c ? reminderText(c, due) : reminderText(null, due));
    return 'https://wa.me/' + (num2.length >= 8 ? num2 : '') + '?text=' + text;
  }

  function duesModal(custId) {
    var rows = custDues();
    var row = rows.filter(function (r) { return r.id === (custId || ''); })[0];
    if (!row) return toast('Nothing due for this customer');
    openModal('Money to collect', `
      <div class="card" style="margin:0 0 12px">
        <div class="row-actions" style="justify-content:space-between">
          <div><b>${esc(row.name)}</b><div class="sub">${esc(row.phone || 'No phone saved')} · oldest bill ${esc(fmtDate(row.oldest))} (${daysSince(row.oldest)} days)</div></div>
          <div style="text-align:right"><div class="sub">Total due</div><b style="color:#dc2626;font-size:18px">${money(row.due)}</b></div>
        </div>
      </div>
      <div class="row-list">${row.bills.map(function (i) {
        var d = r2(i.total - i.paid);
        return `<div class="rrow"><div class="grow"><div class="title">${esc(i.no)} · ${money(d)} due</div>
          <div class="sub">${esc(fmtDate(i.date))} · ${daysSince(i.date)} days old${i.paid > 0 ? ' · ' + money(i.paid) + ' already paid' : ''}</div></div>
          <div class="amt"><button class="btn sm primary" data-act="inv-pay-record" data-id="${i.id}">Receive</button></div></div>`;
      }).join('')}</div>
      <div class="row-actions" style="margin-top:12px">
        ${row.phone ? `<a class="btn" href="${reminderLink(findCust(row.id), row.due)}" target="_blank" rel="noopener">Send reminder</a>` : ''}
        ${row.id ? `<button class="btn" data-act="cust-open" data-id="${row.id}">Open customer</button>` : ''}
        <button class="btn" data-act="close-modal">Done</button>
      </div>`);
  }
  function anyOpt(label) { return [['', label]]; }
  function branchOpts() {
    return anyOpt('All branches').concat(S.visibleBranches().map(function (b) { return [b.id, b.name]; }));
  }

  var FILTERS = {
    invoices: {
      ph: 'Search bill no., customer, phone or amount…',
      fields: [
        { k: 'status', label: 'Payment', t: 'sel', opts: function () { return anyOpt('Any status').concat([['paid', 'Paid'], ['partial', 'Part paid'], ['unpaid', 'Unpaid']]); } },
        { k: 'method', label: 'Mode', t: 'sel', opts: function () { return anyOpt('Any mode').concat(pairs(PAY_METHODS)); } },
        { k: 'emi', label: 'EMI', t: 'sel', opts: function () { return [['', 'Any bill'], ['yes', 'Only EMI'], ['no', 'Without EMI']]; } },
        { k: 'branch', label: 'Branch', t: 'sel', opts: branchOpts },
        { k: 'from', label: 'From date', t: 'date' },
        { k: 'to', label: 'To date', t: 'date' },
        { k: 'min', label: 'Min amount', t: 'num', ph: '0' },
        { k: 'max', label: 'Max amount', t: 'num', ph: 'Any' }
      ],
      search: function (i) {
        var c = findCust(i.customerId);
        return [i.no, c ? c.name : 'walk in', c ? c.phone : '', i.method || '', num(i.total), num(i.paid),
          i.emi ? (i.emi.finance || '') : ''].join(' ');
      },
      vals: function (i) {
        var due = r2(i.total - i.paid);
        var modes = (i.payments || []).map(function (p) { return String((p && p.method) || '').trim(); }).filter(Boolean);
        if (!modes.length) modes = String(i.method || '').split('+').map(function (x) { return x.trim(); }).filter(Boolean);
        if (!modes.length) modes = ['Cash'];
        return { date: i.date, amount: i.total, branch: i.branchId, method: modes,
          emi: isEmiBill(i) ? 'yes' : 'no',
          status: due < 0.01 ? 'paid' : (i.paid > 0 ? 'partial' : 'unpaid') };
      }
    },
    purchases: {
      ph: 'Search purchase no., supplier or bill no.…',
      fields: [
        { k: 'status', label: 'Payment', t: 'sel', opts: function () { return anyOpt('Any status').concat([['paid', 'Paid'], ['partial', 'Part paid'], ['unpaid', 'Unpaid']]); } },
        { k: 'supplier', label: 'Supplier', t: 'sel', opts: function () { return anyOpt('Any supplier').concat(db.suppliers.map(function (x) { return [x.id, x.name]; })); } },
        { k: 'from', label: 'From date', t: 'date' },
        { k: 'to', label: 'To date', t: 'date' },
        { k: 'min', label: 'Min amount', t: 'num', ph: '0' },
        { k: 'max', label: 'Max amount', t: 'num', ph: 'Any' }
      ],
      search: function (p) {
        var sup = supplierById(p.supplierId);
        return [p.no, p.invoiceNo || '', sup ? sup.name : '', p.note || '', num(p.total)].join(' ');
      },
      vals: function (p) {
        var paidAmt = typeof p.paid === 'number' ? p.paid : (p.paid ? p.total : 0);
        var due = r2(p.total - paidAmt);
        return { date: p.date, amount: p.total, supplier: p.supplierId,
          status: due <= 0.009 ? 'paid' : (paidAmt > 0 ? 'partial' : 'unpaid') };
      }
    },
    returns: {
      ph: 'Search return no., bill no. or customer…',
      fields: [
        { k: 'method', label: 'Refund mode', t: 'sel', opts: function () { return anyOpt('Any mode').concat(pairs(['Cash', 'UPI', 'Card', 'Bank', 'Credit note'])); } },
        { k: 'from', label: 'From date', t: 'date' },
        { k: 'to', label: 'To date', t: 'date' },
        { k: 'min', label: 'Min refund', t: 'num', ph: '0' },
        { k: 'max', label: 'Max refund', t: 'num', ph: 'Any' }
      ],
      search: function (r) {
        var inv = invById(r.invoiceId), c = inv ? findCust(inv.customerId) : null;
        return [r.no, inv ? inv.no : '', c ? c.name : '', r.method || '', r.byName || ''].join(' ');
      },
      vals: function (r) {
        return { date: r.date, amount: r.total, method: r.method || 'Cash' };
      }
    },
    items: {
      ph: 'Search item name, SKU or category…',
      fields: [
        { k: 'category', label: 'Category', t: 'sel', opts: function () {
          var cats = [];
          if (typeof allCategories === 'function') cats = allCategories();
          else db.items.forEach(function (it) { if (it.category && cats.indexOf(it.category) < 0) cats.push(it.category); });
          return anyOpt('Any category').concat(pairs(cats.sort()));
        } },
        { k: 'status', label: 'Stock here', t: 'sel', opts: function () { return anyOpt('Any stock').concat([['low', 'Low or out'], ['ok', 'Healthy']]); } },
        { k: 'min', label: 'Min price', t: 'num', ph: '0' },
        { k: 'max', label: 'Max price', t: 'num', ph: 'Any' }
      ],
      search: function (it) { return [it.name, it.sku, it.category, it.brand || ''].join(' '); },
      vals: function (it) {
        var here = stockOf(it), re = Number(it.reorder) || 0;
        return { date: '', amount: it.price, category: it.category || '', status: here <= re ? 'low' : 'ok' };
      }
    },
    customers: {
      ph: 'Search name, phone, email or address…',
      fields: [
        { k: 'status', label: 'Dues', t: 'sel', opts: function () { return anyOpt('All customers').concat([['due', 'With due amount'], ['clear', 'Nothing due']]); } },
        { k: 'min', label: 'Min due', t: 'num', ph: '0' }
      ],
      search: function (c) { return [c.name, c.phone, c.email, c.address].join(' '); },
      vals: function (c) {
        var due = custDue(c.id);
        return { date: '', amount: due, status: due > 0.009 ? 'due' : 'clear' };
      }
    },
    expenses: {
      ph: 'Search category, note, mode or staff…',
      fields: [
        { k: 'category', label: 'Category', t: 'sel', opts: function () { return anyOpt('Any category').concat(pairs(EXP_CATS)); } },
        { k: 'method', label: 'Mode', t: 'sel', opts: function () { return anyOpt('Any mode').concat(pairs(['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque'])); } },
        { k: 'from', label: 'From date', t: 'date' },
        { k: 'to', label: 'To date', t: 'date' },
        { k: 'min', label: 'Min amount', t: 'num', ph: '0' },
        { k: 'max', label: 'Max amount', t: 'num', ph: 'Any' }
      ],
      search: function (x) {
        var st = staffById(x.staffId);
        return [x.category, x.note || '', x.method || '', st ? st.name : ''].join(' ');
      },
      vals: function (x) {
        return { date: x.date, amount: x.amount, category: x.category, method: x.method };
      }
    },
    damage: {
      ph: 'Search what happened, person or staff…',
      fields: [
        { k: 'status', label: 'Status', t: 'sel', opts: function () { return anyOpt('Any status').concat([['pending', 'Pending'], ['adjusted', 'Settled']]); } },
        { k: 'from', label: 'From date', t: 'date' },
        { k: 'to', label: 'To date', t: 'date' }
      ],
      search: function (d) { return [d.name, d.responsible, d.reason, d.byName].join(' '); },
      vals: function (d) {
        return { date: d.date, amount: d.costValue, status: d.adjusted ? 'adjusted' : 'pending' };
      }
    },
    ledgers: {
      ph: 'Search any account…',
      state: function () { return ledgerState(); },
      fields: [
        { k: 'bal', label: 'Balance', t: 'sel', opts: function () {
          return anyOpt('Any balance').concat([['due', 'Owes you'], ['advance', 'Advance / you owe'], ['clear', 'Settled']]);
        } }
      ],
      search: function (p) { return [p.name, p.sub].join(' '); },
      vals: function (p) {
        return { date: '', amount: p.balance,
          bal: p.balance > 0.009 ? 'due' : (p.balance < -0.009 ? 'advance' : 'clear') };
      }
    },
    ledgerEntries: {
      ph: 'Search entries, reference or amount…',
      qKey: 'eq',
      state: function () { return ledgerState(); },
      fields: function () {
        var f = [{ k: 'from', label: 'From date', t: 'date' }, { k: 'to', label: 'To date', t: 'date' }];
        if (ledgerState().type === 'staff') {
          f.push({ k: 'etype', label: 'Entry type', t: 'sel', opts: function () {
            return lgStaffTypes().map(function (o) { return [o.id, o.label]; });
          } });
        }
        return f;
      },
      search: function (e) {
        return [e.label, e.ref, kindName(e.kind), e.info != null ? String(e.info) : ''].join(' ');
      },
      vals: function (e) {
        return { date: e.date, amount: e.info || e.debit || e.credit || 0, etype: e.kind || '' };
      }
    }
  };

  function fFields(v) {
    var def = FILTERS[v];
    if (!def) return [];
    return typeof def.fields === 'function' ? def.fields() : def.fields;
  }
  function fQKey(v) {
    var def = FILTERS[v];
    return (def && def.qKey) || 'q';
  }
  function fState(v) {
    var def = FILTERS[v];
    if (def && def.state) return def.state();
    if (!ui.f) ui.f = {};
    if (!ui.f[v]) ui.f[v] = {};
    return ui.f[v];
  }
  function fcPageReset(v) {
    if (v === 'invoices') invState().page = 1;
    if (v === 'ledgers' || v === 'ledgerEntries') ledgerState().page = 1;
  }
  function fCount(v) {
    var st = fState(v), n = 0;
    fFields(v).forEach(function (f) {
      var x = st[f.k];
      if (x !== '' && x != null) n++;
    });
    return n;
  }
  function fOn(v) { return fCount(v) > 0 || !!fState(v)[fQKey(v)]; }
  function fMatch(v, row) {
    var st = fState(v), def = FILTERS[v];
    if (!def) return true;
    var qv = st[fQKey(v)];
    if (qv && !match(def.search(row), qv)) return false;
    var fields = fFields(v);
    for (var n = 0; n < fields.length; n++) {
      var f = fields[n], want = st[f.k];
      if (want === '' || want == null) continue;
      var d = def.vals(row);
      if (f.k === 'from') { if (String(d.date || '') < String(want)) return false; continue; }
      if (f.k === 'to') { if (String(d.date || '') > String(want)) return false; continue; }
      if (f.k === 'min') { if (Number(d.amount || 0) < Number(want)) return false; continue; }
      if (f.k === 'max') { if (Number(d.amount || 0) > Number(want)) return false; continue; }
      var dv = d[f.k];
      if (Array.isArray(dv)) { if (dv.indexOf(String(want)) < 0) return false; continue; }
      if (String(dv == null ? '' : dv) !== String(want)) return false;
    }
    return true;
  }
  function fApply(v, list) { return list.filter(function (r) { return fMatch(v, r); }); }

  function fLabel(v, f, val) {
    if (f.t === 'date') return fmtDate(val);
    if (f.t === 'num') return (f.k === 'min' ? '≥ ' : f.k === 'max' ? '≤ ' : '') + money(val);
    var hit = null;
    (f.opts() || []).forEach(function (o) { if (String(o[0]) === String(val)) hit = o[1]; });
    return hit == null ? val : hit;
  }

  function fFieldHTML(v, f) {
    var st = fState(v), val = st[f.k] == null ? '' : st[f.k];
    if (f.t === 'sel') {
      return `<label class="ff"><span>${esc(f.label)}</span>
        <select class="inp" data-change="f-set" data-view="${v}" data-k="${f.k}">${(f.opts() || []).map(function (o) {
          return `<option value="${esc(o[0])}"${String(val) === String(o[0]) ? ' selected' : ''}>${esc(o[1])}</option>`;
        }).join('')}</select></label>`;
    }
    if (f.t === 'date') {
      return `<label class="ff"><span>${esc(f.label)}</span>
        <input class="inp" type="date" data-input="f-date" data-view="${v}" data-k="${f.k}" value="${esc(val)}"></label>`;
    }
    return `<label class="ff"><span>${esc(f.label)}</span>
      <input class="inp" type="text" inputmode="decimal" min="0" step="0.01" inputmode="decimal" data-input="f-num"
        data-view="${v}" data-k="${f.k}" value="${esc(val)}" placeholder="${esc(f.ph || '')}"></label>`;
  }

  function fPanelHTML(v) {
    var fields = fFields(v), n = fCount(v);
    var hasRange = fields.some(function (f) { return f.k === 'from'; });
    return `<div class="fpanel">
      ${hasRange ? `<div class="fquick">
        <button type="button" data-act="f-range" data-view="${v}" data-days="today">Today</button>
        <button type="button" data-act="f-range" data-view="${v}" data-days="7">Last 7 days</button>
        <button type="button" data-act="f-range" data-view="${v}" data-days="30">Last 30 days</button>
        <button type="button" data-act="f-range" data-view="${v}" data-days="month">This month</button>
        <button type="button" data-act="f-range" data-view="${v}" data-days="all">All time</button>
      </div>` : ''}
      <div class="fgrid">${fields.map(function (f) { return fFieldHTML(v, f); }).join('')}</div>
      <div class="ffoot"><span class="sub">${n ? n + ' filter' + (n === 1 ? '' : 's') + ' on' : 'No filters — showing everything'}</span>
        <span class="frow">
          <button type="button" class="btn sm" data-act="f-clear" data-view="${v}">Reset</button>
          <button type="button" class="btn sm primary" data-act="f-open" data-view="${v}">Done</button>
        </span></div>
    </div>`;
  }

  function fBar(v) {
    var st = fState(v), def = FILTERS[v], n = fCount(v), qv = st[fQKey(v)];
    var active = (n || qv) && !def.quiet;
    var chips = '';
    if (n || qv) {
      chips = '<div class="fchips">' + fFields(v).filter(function (f) {
        var x = st[f.k];
        return x !== '' && x != null;
      }).map(function (f) {
        return `<button type="button" class="fchip" data-act="f-drop" data-view="${v}" data-k="${f.k}">
          <span>${esc(f.label)}: ${esc(fLabel(v, f, st[f.k]))}</span><b>×</b></button>`;
      }).join('') + `<button type="button" class="fchip x" data-act="f-clear" data-view="${v}">Clear all</button></div>`;
    }
    return `<div class="fwrap" data-fwrap="${v}">
      <div class="fbar">
        ${def.noSearch ? '' : `<div class="searchbox grow">${ico('search')}
          <input class="inp" data-input="f-q" data-view="${v}" placeholder="${esc(def.ph)}" value="${esc(qv || '')}"></div>`}
        <button type="button" class="fbtn${n ? ' on' : ''}" data-act="f-open" data-view="${v}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>
          <span>${def.quiet ? 'Dates' : 'Filters'}</span>${n && !def.quiet ? `<i>${n}</i>` : ''}</button>
      </div>
      ${st.open ? fPanelHTML(v) : ''}
      ${chips}
    </div>`;
  }


  function viewInvoices() {
    invState();
    var tab = invState().tab;
    var ests = branchEstimates();
    var st = fState('invoices'), n = fCount('invoices'), qv = st[fQKey('invoices')] || '';
    var tabsHTML = `<div class="seg inv-tabs" role="group" aria-label="Invoices or estimates">
      <button type="button" class="${tab === 'est' ? '' : 'on'}" data-act="inv-tab" data-id="bills">Invoices${branchInvoices().length ? ' · ' + branchInvoices().length : ''}</button>
      <button type="button" class="${tab === 'est' ? 'on' : ''}" data-act="inv-tab" data-id="est">Estimates${ests.length ? ' · ' + ests.length : ''}</button>
    </div>`;
    if (tab === 'est') return `<div class="cust-page inv-page">
      <div class="cust-top">
        <h2 class="cust-title">Estimates <span class="cust-count">${ests.length}</span></h2>
        <button type="button" class="cust-add" data-act="new-estimate">+ New estimate</button>
      </div>
      ${tabsHTML}
      <div id="invTable">${estListHTML()}</div>
    </div>`;
    return `<div class="cust-page inv-page">
      <div class="cust-top">
        <h2 class="cust-title">Invoices <span class="cust-count">${branchInvoices().length}</span></h2>
        <button type="button" class="cust-add" data-act="new-bill">+ New bill</button>
      </div>
      ${tabsHTML}
      <div class="cust-search">${ico('search')}
        <input class="inp" data-input="f-q" data-view="invoices" placeholder="Search bill no., customer or amount"
          value="${esc(qv)}" autocomplete="off" aria-label="Search invoices">
      </div>
      <div class="cust-chips">
        <button type="button" class="cust-chip${n ? ' on' : ''}" data-act="f-open" data-view="invoices">
          Filters${n ? ' · ' + n : ''}
        </button>
        ${(n || qv) ? `<button type="button" class="cust-chip" data-act="f-clear" data-view="invoices">Clear</button>` : ''}
      </div>
      ${st.open ? fPanelHTML('invoices') : ''}
      ${fChipsHTML('invoices')}
      <div id="invTable">${invoiceListHTML()}</div>
    </div>`;
  }

  function fChipsHTML(v) {
    var st = fState(v), n = fCount(v), qv = st[fQKey(v)];
    if (!n && !qv) return '';
    return '<div class="fchips">' + fFields(v).filter(function (f) {
      var x = st[f.k]; return x !== '' && x != null;
    }).map(function (f) {
      return `<button type="button" class="fchip" data-act="f-drop" data-view="${v}" data-k="${f.k}">
        <span>${esc(f.label)}: ${esc(fLabel(v, f, st[f.k]))}</span><b>×</b></button>`;
    }).join('') + '</div>';
  }

  function filteredInvoices() {
    return fApply('invoices', branchInvoices().slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); }));
  }
  function estListHTML() {
    var all = branchEstimates().slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    if (!all.length) return '<div class="empty"><b>No estimates yet</b>Quotes you save for this branch appear here. They never reduce stock.</div>';
    return `<div class="cust-list inv-list">${all.map(function (e) {
      var c = findCust(e.customerId);
      var items = (e.lines || []).reduce(function (s, l) { return s + (Number(l.qty) || 0); }, 0);
      return `<div class="cust-row inv-row" data-act="est-view" data-id="${e.id}" tabindex="0" role="button">
        <span class="cust-main">
          <span class="cust-name">${esc(e.no)}</span>
          <span class="cust-sub">${esc(c ? c.name : 'Walk-in customer')}</span>
        </span>
        <span class="inv-meta">
          <span class="inv-amt">${money(e.total)}</span>
          <span class="inv-subrow"><span class="inv-date">${esc(fmtDate(e.date))}</span>
            <span class="inv-st ${e.convertedAt ? 'ok' : 'warn'}">${e.convertedAt ? 'Billed' : 'Quote'}</span></span>
        </span>
        <button type="button" class="cust-dots" data-act="est-view" data-id="${e.id}" aria-label="Open estimate ${esc(e.no)}">⋮</button>
      </div>`;
    }).join('')}</div>`;
  }

  function invoiceListHTML() {
    var st = invState();
    var all = filteredInvoices();
    var total = all.length;
    var per = st.per || 12;
    var pages = Math.max(1, Math.ceil(total / per));
    if (st.page > pages) st.page = pages;
    if (st.page < 1) st.page = 1;
    var start = (st.page - 1) * per;
    var rows = all.slice(start, start + per);
    if (!rows.length) return '<div class="empty"><b>' + (fOn('invoices') ? 'No invoices match' : 'No invoices') + '</b>' + (fOn('invoices') ? 'Try clearing a filter.' : 'Bills you save in this branch appear here.') + '</div>';
    return `<div class="cust-list inv-list">${rows.map(function (i) {
      var c = findCust(i.customerId);
      var due = r2(i.total - i.paid);
      var stTxt = due < 0.01 ? 'Paid' : (i.paid > 0 ? 'Part paid' : 'Unpaid');
      var stCls = due < 0.01 ? 'ok' : (i.paid > 0 ? 'warn' : 'due');
      var amtCls = due < 0.01 ? '' : ' due';
      /* While money is still owed the row shows what is left to collect, not
         the bill total, so nobody reads a part-paid bill as a full amount. */
      var amtShown = due < 0.01 ? i.total : due;
      return `<div class="cust-row inv-row" data-act="inv-view" data-id="${i.id}" tabindex="0" role="button">
        <span class="cust-main">
          <span class="cust-name">${esc(i.no)}</span>
          <span class="cust-sub">${esc(c ? c.name : 'Walk-in customer')}</span>
        </span>
        <span class="inv-meta">
          <span class="inv-amt${amtCls}">${money(amtShown)}</span>
          <span class="inv-subrow"><span class="inv-date">${esc(fmtDate(i.date))}</span>
            ${isEmiBill(i) ? '<span class="inv-st emi">EMI</span>' : ''}
            <span class="inv-st ${stCls}">${stTxt}</span></span>
        </span>
        <button type="button" class="cust-dots" data-act="inv-more" data-id="${i.id}" aria-label="Actions for ${esc(i.no)}">⋮</button>
        ${ui.invMore === i.id ? `<div class="cust-menu cust-rowmenu">
          <button type="button" data-act="inv-view" data-id="${i.id}">View</button>
          <button type="button" data-act="inv-print" data-id="${i.id}">Print</button>
          ${can('invoice.delete') ? `<button type="button" data-act="inv-edit" data-id="${i.id}">Edit</button>` : ''}
        </div>` : ''}
      </div>`;
    }).join('')}</div>
    ${pagerHTML(total, st.page, pages, start, per, 'inv-page')}`;
  }

  /* ----------------------------------------------------------------- ledgers */
  function ledgerState() {
    if (!ui.ledger) ui.ledger = { type: 'customers', entityId: '', q: '', from: '', to: '', eq: '', etype: '', page: 1, per: 20 };
    if (ui.ledger.etype == null) ui.ledger.etype = '';
    return ui.ledger;
  }
  function lgTypes() {
    return [
      { id: 'customers', label: 'Customers' },
      { id: 'suppliers', label: 'Suppliers', need: 'profit.view' },
      { id: 'staff', label: 'Staff', need: 'profit.view' }
    ].filter(function (t) { return !t.need || can(t.need); });
  }
  function byDate(a, b) {
    return String(a.date || '').localeCompare(String(b.date || '')) || (a.created || 0) - (b.created || 0);
  }
  function signed(type, e) {
    return type === 'suppliers'
      ? (Number(e.credit) || 0) - (Number(e.debit) || 0)
      : (Number(e.debit) || 0) - (Number(e.credit) || 0);
  }
  function sumSigned(type, list) {
    var t = 0;
    list.forEach(function (e) { t += signed(type, e); });
    return r2(t);
  }

  function customerEntries(cid) {
    var out = [];
    db.invoices.forEach(function (inv) {
      if (inv.customerId !== cid) return;
      out.push({ date: inv.date, created: inv.created || 0, kind: 'bill', label: 'Bill ' + inv.no, ref: inv.no, debit: inv.total, credit: 0 });
      if (Number(inv.paid) > 0) {
        out.push({ date: inv.date, created: (inv.created || 0) + 1, kind: 'payment', label: 'Payment · ' + (inv.method || ''), ref: inv.no, debit: 0, credit: inv.paid });
      }
    });
    db.sreturns.forEach(function (r) {
      if (r.customerId !== cid) return;
      out.push({ date: r.date, created: r.created || 0, kind: 'return', label: 'Return ' + r.no, ref: r.no, debit: 0, credit: r.total });
    });
    return out.sort(byDate);
  }

  function supplierEntries(sid) {
    var out = [];
    db.purchases.forEach(function (p) {
      if (p.supplierId !== sid) return;
      out.push({ date: p.date, created: p.created || 0, kind: 'purchase', label: 'Purchase ' + p.no, ref: p.no, debit: 0, credit: p.total });
      var paidAmt = typeof p.paid === 'number' ? p.paid : (p.paid ? p.total : 0);
      if (paidAmt > 0) {
        out.push({ date: p.date, created: (p.created || 0) + 1, kind: 'payment', label: 'Payment · ' + (p.method || ''), ref: p.no, debit: paidAmt, credit: 0 });
      }
    });
    db.preturns.forEach(function (r) {
      if (r.supplierId !== sid) return;
      out.push({ date: r.date, created: r.created || 0, kind: 'return', label: 'Return ' + r.no, ref: r.no, debit: r.total, credit: 0 });
    });
    return out.sort(byDate);
  }

  function staffEntries(stid) {
    var out = [];
    var staff = staffById(stid);
    (db.staffLedger || []).forEach(function (e) {
      if (e.staffId !== stid) return;
      var kind = e.type === 'advance' ? 'advance' : e.type === 'repayment' ? 'repayment' : 'deduction';
      out.push({
        date: e.date, created: e.created || 0, kind: kind,
        label: e.note ? String(e.note) : kindName(kind),
        ref: e.id,
        debit: kind === 'advance' ? Number(e.amount) || 0 : 0,
        credit: kind === 'advance' ? 0 : Number(e.amount) || 0
      });
    });
    db.invoices.forEach(function (inv) {
      if (inv.staffId !== stid) return;
      var names = (inv.lines || []).map(function (l) { return l.name + (Number(l.qty) > 1 ? ' x' + num(l.qty) : ''); });
      var shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) + ' more' : '');
      out.push({
        date: inv.date, created: inv.created || 0, kind: 'sale',
        label: inv.no + (shown ? ' · ' + shown : ''),
        ref: inv.no, debit: 0, credit: 0, info: r2(inv.total)
      });
    });
    if (staff) {
      var bits = String(staff.name || '').toLowerCase().split(/\s+/).filter(function (b) { return b.length >= 3; });
      db.expenses.forEach(function (x) {
        if (String(x.category || '') !== 'Salary') return;
        var note = String(x.note || '').toLowerCase();
        var hit = note && bits.some(function (b) { return note.indexOf(b) > -1; });
        if (!hit) return;
        out.push({
          date: x.date, created: x.created || 0, kind: 'salary',
          label: (x.method || 'Cash') + (x.note ? ' · ' + x.note : ''),
          ref: '', debit: 0, credit: 0, info: r2(x.amount)
        });
      });
    }
    db.damages.forEach(function (d) {
      if (d.staffId !== stid) return;
      out.push({
        date: d.date, created: d.created || 0, kind: 'damage',
        label: d.name + ' x' + num(d.qty) + (d.adjusted ? '' : ' · not adjusted yet'),
        ref: '', debit: Number(d.costValue) || 0, credit: 0
      });
    });
    if (staff) {
      db.sreturns.forEach(function (r) {
        if (String(r.byName || '') !== String(staff.name)) return;
        out.push({
          date: r.date, created: r.created || 0, kind: 'return',
          label: r.no + ' · ' + (r.lines || []).slice(0, 3).map(function (l) { return l.name + ' x' + num(l.qty); }).join(', '),
          ref: r.no, debit: 0, credit: 0, info: r2(r.total)
        });
      });
    }
    return out.sort(byDate);
  }

  function kindName(kind) {
    var map = {
      sale: 'Sale', salary: 'Salary', advance: 'Advance', repayment: 'Repayment', deduction: 'Deduction',
      damage: 'Damage', return: 'Return', bill: 'Bill', payment: 'Payment', purchase: 'Purchase'
    };
    return map[kind] || 'Entry';
  }

  function lgStaffTypes() {
    return [
      { id: '', label: 'Everything' }, { id: 'sale', label: 'Sales' }, { id: 'salary', label: 'Salary' },
      { id: 'advance', label: 'Advance' }, { id: 'repayment', label: 'Repayment' }, { id: 'deduction', label: 'Deduction' },
      { id: 'damage', label: 'Damage' }, { id: 'return', label: 'Returns' }
    ];
  }

  function lgRangeEntries(type, id) {
    var st = ledgerState();
    return lgEntries(type, id).filter(function (e) {
      if (st.from && e.date < st.from) return false;
      if (st.to && e.date > st.to) return false;
      if (st.eq && !(match(e.label, st.eq) || match(e.ref, st.eq))) return false;
      return true;
    });
  }

  function lgKindOk(e) {
    var st = ledgerState();
    if (st.type !== 'staff' || !st.etype) return true;
    return e.kind === st.etype;
  }

  function lgFilterEntries(type, id) {
    return lgRangeEntries(type, id).filter(lgKindOk);
  }

  function balanceBadge(type, bal) {
    if (bal > 0.009) return '<span class="badge ' + (type === 'suppliers' ? 'warn' : 'bad') + '">' + money(bal) + '</span>';
    if (bal < -0.009) return '<span class="badge ok">' + (type === 'staff' ? 'You owe ' : 'Advance ') + money(-bal) + '</span>';
    return '<span class="badge ok">Settled</span>';
  }

  function downloadCsv(filename, rows) {
    var text = rows.map(function (r) {
      return r.map(function (v) {
        var t = String(v == null ? '' : v);
        return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
      }).join(',');
    }).join('\r\n');
    var url = '';
    try { url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })); } catch (e) { url = ''; }
    if (!url) return false;
    try {
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 2000);
      return true;
    } catch (e) { return false; }
  }

  /* --------------------------------------------------- whole-shop CSV export */
  function allDataCsvRows() {
    var rows = [['Type', 'Id', 'Date', 'Reference', 'Name', 'Amount', 'Full record']];
    var add = function (type, date, ref, name, amount, rec) {
      rows.push([type, rec && rec.id ? rec.id : '', date || '', ref || '', name || '',
        amount == null || amount === '' ? '' : amount, JSON.stringify(rec || {})]);
    };
    var branchName = function (id) {
      var b = (db.branches || []).filter(function (x) { return x.id === id; })[0];
      return b ? b.name : '';
    };
    var custName = function (id) { var c = findCust(id); return c ? c.name : ''; };
    var supName = function (id) { var s = supplierById(id); return s ? s.name : ''; };
    var staffName = function (id) {
      var s = (db.staff || []).filter(function (x) { return x.id === id; })[0];
      return s ? s.name : '';
    };

    add('Shop settings', '', '', db.settings.business, '', {
      settings: db.settings,
      counters: { bill: db.counter, transfer: db.tcounter, purchase: db.pcounter, return: db.rcounter }
    });
    (db.branches || []).forEach(function (b) { add('Branch', '', b.prefix || '', b.name, '', b); });
    (db.staff || []).forEach(function (s) { add('Staff', '', s.username || '', s.name, '', s); });
    (db.items || []).forEach(function (i) { add('Item', '', i.sku || '', i.name, i.price, i); });
    (db.customers || []).forEach(function (c) { add('Customer', '', c.phone || '', c.name, '', c); });
    (db.suppliers || []).forEach(function (s) { add('Supplier', '', s.phone || '', s.name, '', s); });
    (db.invoices || []).forEach(function (i) { add('Bill', i.date, i.no, custName(i.customerId), i.total, i); });
    (db.purchases || []).forEach(function (p) { add('Purchase', p.date, p.no, supName(p.supplierId), p.total, p); });
    (db.sreturns || []).forEach(function (r) { add('Sales return', r.date, r.no, custName(r.customerId), r.total, r); });
    (db.preturns || []).forEach(function (r) { add('Purchase return', r.date, r.no, supName(r.supplierId), r.total, r); });
    (db.transfers || []).forEach(function (t) {
      add('Transfer', t.date, t.no, branchName(t.fromId) + ' to ' + branchName(t.toId), '', t);
    });
    (db.damages || []).forEach(function (d) { add('Damage', d.date, d.responsible || '', d.name, d.costValue, d); });
    (db.expenses || []).forEach(function (x) { add('Expense', x.date, x.category || '', x.category || '', x.amount, x); });
    (db.staffLedger || []).forEach(function (e) { add('Staff entry', e.date, e.type || '', staffName(e.staffId), e.amount, e); });
    (db.complaints || []).forEach(function (c) {
      add('Complaint', c.date, c.no || '', c.customerName || c.itemName || '', '', c);
    });
    (db.activity || []).forEach(function (a) { add('Activity', a.date, a.type || '', a.text || '', '', a); });
    return rows;
  }

  function exportAllCsv() {
    var rows = allDataCsvRows();
    if (!downloadCsv('all-data-' + today() + '.csv', rows)) return false;
    toast('All ' + (rows.length - 1) + ' records downloaded as CSV');
    return true;
  }

  function exportLedgerCsv() {
    var st = ledgerState();
    var party = lgParty(st.type, st.entityId);
    if (!party) return;
    var all = lgEntries(st.type, st.entityId);
    var bal = 0;
    all.forEach(function (e) { if (st.from && e.date < st.from) bal += signed(st.type, e); });
    var rows = [[st.type === 'staff' ? 'Staff' : st.type === 'suppliers' ? 'Supplier' : 'Customer', party.name,
      'From ' + (st.from || 'start'), 'To ' + (st.to || 'today'),
      st.type === 'staff' && st.etype ? 'Type filter: ' + kindName(st.etype) : 'All entries']];
    rows.push(['Date', 'Type', 'Details', 'Reference', 'Debit', 'Credit', 'Amount', 'Balance']);
    if (st.from) rows.push([st.from, 'Opening', 'Opening balance', '', '', '', '', openingFor(st.type, all, st.from)]);
    lgRangeEntries(st.type, st.entityId).forEach(function (e) {
      bal = r2(bal + signed(st.type, e));
      if (!lgKindOk(e)) return;
      rows.push([e.date, kindName(e.kind), e.label, e.ref || '', e.debit || '', e.credit || '',
        e.info != null ? e.info : '', bal]);
    });
    var filename = 'ledger-' + st.type + '-' + String(party.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + today() + '.csv';
    if (!downloadCsv(filename, rows)) return toast('This browser cannot save the CSV');
    toast('Ledger exported as CSV');
  }

  function openingFor(type, list, from) {
    var t = 0;
    list.forEach(function (e) { if (from && e.date < from) t += signed(type, e); });
    return r2(t);
  }

  function lgEntries(type, id) {
    return type === 'suppliers' ? supplierEntries(id) : type === 'staff' ? staffEntries(id) : customerEntries(id);
  }
  function lgBalance(type, id) { return sumSigned(type, lgEntries(type, id)); }

  function lgParties(type) {
    if (type === 'customers') {
      return db.customers.map(function (c) {
        return { id: c.id, name: c.name, sub: c.phone || c.email || '', balance: lgBalance('customers', c.id) };
      });
    }
    if (type === 'suppliers') {
      return db.suppliers.map(function (s) {
        return { id: s.id, name: s.name, sub: s.phone || s.email || '', balance: lgBalance('suppliers', s.id) };
      });
    }
    return db.staff.map(function (s) {
      return {
        id: s.id, name: s.name,
        sub: (S.ROLE_LABEL[s.role] || s.role) + ' · ' + branchName(s.branchId),
        balance: lgBalance('staff', s.id)
      };
    });
  }
  function lgParty(type, id) { return lgParties(type).filter(function (p) { return p.id === id; })[0] || null; }

  function staffSales(staffId, from, to) {
    var a = from || S.monthStart(), b = to || today();
    return db.invoices.filter(function (i) {
      return i.staffId === staffId && i.date >= a && i.date <= b;
    }).reduce(function (s, i) { return s + i.total; }, 0);
  }

  function pagerHTML(total, page, pages, start, per, actName) {
    var from = total ? start + 1 : 0;
    var to = Math.min(start + per, total);
    return `<div class="row-actions" style="justify-content:space-between;margin-top:12px">
      <span class="sub">${total ? from + '–' + to + ' of ' + total : 'Nothing to show'}</span>
      <span class="row-actions">
        <button class="btn sm" type="button" data-act="${actName}" data-id="prev"${page <= 1 ? ' disabled' : ''}>Previous</button>
        <span class="sub">Page ${page} of ${pages}</span>
        <button class="btn sm" type="button" data-act="${actName}" data-id="next"${page >= pages ? ' disabled' : ''}>Next</button>
      </span></div>`;
  }

  function viewLedgers() {
    var st = ledgerState();
    var types = lgTypes();
    if (!types.length) return '<div class="empty"><b>No ledger access</b>Ask the owner for the Ledgers permission.</div>';
    if (!types.some(function (t) { return t.id === st.type; })) { st.type = types[0].id; st.entityId = ''; st.page = 1; }
    var seg = `<div class="seg" style="margin-bottom:10px">${types.map(function (t) {
      return `<button type="button" data-act="lg-type" data-id="${t.id}" class="${st.type === t.id ? 'on' : ''}">${t.label}</button>`;
    }).join('')}</div>`;
    return `<div class="cust-page lg-page">
      <div class="cust-top">
        <h2 class="cust-title">Ledgers</h2>
      </div>
      <div class="sub" style="margin-bottom:10px">Search any account, filter by date and export the statement.</div>
      ${seg}${st.entityId ? ledgerDetail() : ledgerList()}
    </div>`;
  }

  function ledgerList() {
    var st = ledgerState();
    var parties = lgParties(st.type);
    var rows = fApply('ledgers', parties)
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / st.per));
    if (st.page > pages) st.page = pages;
    var start = (st.page - 1) * st.per;
    var shown = rows.slice(start, start + st.per);
    var label = st.type === 'suppliers' ? 'You owe' : st.type === 'staff' ? 'Balance' : 'Owes you';

    return `
      ${fBar('ledgers')}
      <div id="lgList">${rows.length ? `<div class="cust-list lg-list">${shown.map(function (p) {
        return `<div class="cust-row lg-row" data-act="lg-open" data-id="${p.id}" tabindex="0" role="button">
          <span class="cust-main">
            <span class="cust-name">${esc(p.name)}</span>
            <span class="cust-sub">${esc(p.sub || label)}</span>
          </span>
          <span class="inv-meta">
            <span class="inv-amt">${balanceBadge(st.type, p.balance)}</span>
          </span>
          <span class="hist-go">Open</span>
        </div>`;
      }).join('')}</div>`
        : `<div class="empty"><b>Nothing found</b>${fOn('ledgers') ? 'Try clearing a filter.' : 'Try another search.'}</div>`}</div>
      ${pagerHTML(total, st.page, pages, start, st.per, 'lg-page')}`;
  }

  function ledgerDetail() {
    var st = ledgerState();
    var party = lgParty(st.type, st.entityId);
    if (!party) { st.entityId = ''; return ledgerList(); }
    var all = lgEntries(st.type, st.entityId);
    var opening = openingFor(st.type, all, st.from);
    var ranged = lgRangeEntries(st.type, st.entityId);
    var bal = opening;
    var withBal = [];
    ranged.forEach(function (e) {
      bal = r2(bal + signed(st.type, e));
      if (!lgKindOk(e)) return;
      withBal.push({
        date: e.date, created: e.created, kind: e.kind, label: e.label, ref: e.ref,
        debit: e.debit, credit: e.credit, info: e.info, balance: bal
      });
    });
    var total = withBal.length;
    var pages = Math.max(1, Math.ceil(total / st.per));
    if (st.page > pages) st.page = pages;
    var start = (st.page - 1) * st.per;
    var shown = withBal.slice(start, start + st.per);
    var label = st.type === 'suppliers' ? 'You owe' : 'Owes you';
    var side = party.balance < -0.009 ? (st.type === 'staff' ? 'You owe' : 'Advance') : label;
    var shownBal = party.balance < -0.009 ? -party.balance : party.balance;

    var targetBlock = '';
    if (st.type === 'staff') {
      var s = staffById(st.entityId);
      var tg = s ? Number(s.target) || 0 : 0;
      var sold = s ? staffSales(s.id) : 0;
      var pct = tg > 0 ? Math.min(100, Math.round(sold / tg * 100)) : 0;
      var sumSales = 0, sumSalary = 0, sumAdv = 0, sumDmg = 0, sumRet = 0;
      all.forEach(function (e) {
        if (st.from && e.date < st.from) return;
        if (st.to && e.date > st.to) return;
        if (e.kind === 'sale') sumSales += Number(e.info) || 0;
        else if (e.kind === 'salary') sumSalary += Number(e.info) || 0;
        else if (e.kind === 'advance') sumAdv += Number(e.debit) || 0;
        else if (e.kind === 'damage') sumDmg += Number(e.debit) || 0;
        else if (e.kind === 'return') sumRet += Number(e.info) || 0;
      });
      targetBlock = `<div class="card" style="margin-bottom:12px">
        <h3>This month</h3>
        <div class="tot"><span>Sales by ${esc(s ? s.name : '')}</span><b>${money(sold)}</b></div>
        <div class="tot"><span>Target</span><b>${tg > 0 ? money(tg) + ' · ' + pct + '%' : 'No target set'}</b></div>
        ${tg > 0 ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="card" style="margin-bottom:12px">
        <h3>Activity in this range</h3>
        <div class="tot"><span>Sales</span><b>${money(sumSales)}</b></div>
        <div class="tot"><span>Salary paid</span><b>${money(sumSalary)}</b></div>
        <div class="tot"><span>Advance given</span><b>${money(sumAdv)}</b></div>
        <div class="tot"><span>Damage</span><b>${money(sumDmg)}</b></div>
        <div class="tot"><span>Sales returns</span><b>${money(sumRet)}</b></div>
      </div>`;
    }

    /* what this customer is worth: their bills minus cost of goods and their
       share of any expenses linked to those bills */
    var custBlock = '';
    if (st.type === 'customers' && can('profit.view')) {
      var cp = customerProfit(st.entityId, st.from, st.to);
      custBlock = `<div class="card" style="margin-bottom:12px">
        <h3>Profit from this customer</h3>
        <div class="tot"><span>Bills</span><b>${num(cp.n)}</b></div>
        <div class="tot"><span>Sales (excl. tax)</span><b>${money(cp.sales)}</b></div>
        ${cp.linked > 0.009 ? `<div class="tot"><span>Linked expenses</span><b>${money(cp.linked)}</b></div>` : ''}
        <div class="tot"><span>Profit</span><b class="${cp.profit < 0 ? 'bad' : ''}">${money(cp.profit)}</b></div>
        <div class="hint" style="margin-top:6px">After cost of goods${cp.linked > 0.009 ? " and this customer's share of expenses linked to bills" : ''}${st.from || st.to ? ', for the dates selected' : ''}.</div>
      </div>`;
    }

    return `
      <div class="row-actions" style="margin-bottom:8px;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <button class="btn sm" type="button" data-act="lg-back">← All ${st.type}</button>
        <span class="row-actions" style="gap:6px;flex-wrap:wrap">
          ${st.type === 'staff' && can('staff') ? `<button class="btn sm" data-act="staff-entry-new" data-id="${st.entityId}">+ Entry</button>` : ''}
          <button class="btn sm" data-act="lg-csv">CSV</button>
          <button class="btn sm" data-act="lg-export">PDF</button>
        </span>
      </div>
      <div class="card" style="margin-bottom:10px;padding:12px">
        <div class="card-head" style="margin-bottom:4px"><h3 style="margin:0;font-size:16px">${esc(party.name)}</h3>
          ${balanceBadge(st.type, party.balance)}</div>
        <div class="sub">${esc(side)} ${money(shownBal)}${party.sub ? ' · ' + esc(party.sub) : ''}</div>
      </div>
      ${targetBlock}${custBlock}
      ${fBar('ledgerEntries')}
      <div id="lgEntries">${entriesTable(shown, label, total, pages, start)}</div>`;
  }

  function entriesTable(shown, label, total, pages, start) {
    var st = ledgerState();
    if (!total) return '<div class="empty"><b>No entries</b>Nothing matches this range.</div>';
    return `<div class="table-wrap"><table class="data"><thead><tr>
      <th>Date</th><th>Details</th><th>Ref</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
      </tr></thead><tbody>${shown.map(function (e) {
        var tag = e.kind ? `<span class="badge">${esc(kindName(e.kind))}</span> ` : '';
        var info = e.info != null ? ` <b>${money(e.info)}</b>` : '';
        return `<tr><td>${esc(fmtDate(e.date))}</td><td>${tag}${esc(e.label)}${info}</td><td>${esc(e.ref || '—')}</td>
          <td class="num">${e.debit ? money(e.debit) : '—'}</td>
          <td class="num">${e.credit ? money(e.credit) : '—'}</td>
          <td class="num"><b>${money(e.balance)}</b></td></tr>`;
      }).join('')}</tbody></table></div>
      ${pagerHTML(total, st.page, pages, start, st.per, 'lg-page')}`;
  }

  function exportLedger() {
    var st = ledgerState();
    var party = lgParty(st.type, st.entityId);
    if (!party) return;
    toast('Preparing PDF…');
    ensureJsPdf().then(function () {
      var all = lgEntries(st.type, st.entityId);
      var opening = openingFor(st.type, all, st.from);
      var filtered = lgRangeEntries(st.type, st.entityId);
      var bal = opening;
      var rows = [];
      filtered.forEach(function (e) {
        bal = r2(bal + signed(st.type, e));
        if (!lgKindOk(e)) return;
        var details = (e.info != null ? pdfMoney(e.info) + ' · ' : '') + String(e.label || '');
        rows.push([fmtDate(e.date), details, String(e.ref || ''),
          e.debit ? pdfMoney(e.debit) : '', e.credit ? pdfMoney(e.credit) : '', pdfMoney(bal)]);
      });

      var jspdfLib = window.jspdf || window.jsPDF || (window.jspdf && window.jspdf.jsPDF);
      var jsPDF = jspdfLib && (jspdfLib.jsPDF || jspdfLib);
      if (typeof jsPDF !== 'function') return toast('PDF export is not available right now');

      var doc = new jsPDF({ unit: 'pt', format: 'a4' });
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 36, y = 40;

      function ensure(h) {
        if (y + h > pageH - 40) { doc.addPage(); y = 40; }
      }

      doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text(String(party.name || 'Ledger'), margin, y); y += 16;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      var sub = (party.sub || '') + (st.from || st.to ? '  ·  ' + (st.from || 'start') + ' to ' + (st.to || 'today') : '')
        + (st.type === 'staff' && st.etype ? '  ·  ' + kindName(st.etype) + ' only' : '');
      doc.text(sub, margin, y); y += 12;
      doc.text('Exported ' + fmtDate(today()), margin, y); y += 14;

      var cols = [
        { h: 'Date', w: 58 }, { h: 'Details', w: 175 }, { h: 'Reference', w: 80 },
        { h: 'Debit', w: 60 }, { h: 'Credit', w: 60 }, { h: 'Balance', w: 70 }
      ];
      var x0 = margin;

      function drawRow(cells, head) {
        ensure(18);
        var x = x0;
        doc.setFont('helvetica', head ? 'bold' : 'normal'); doc.setFontSize(head ? 8.5 : 8);
        if (head) {
          doc.setFillColor(242, 244, 248);
          doc.rect(x0, y - 10, pageW - margin * 2, 14, 'F');
        }
        cols.forEach(function (c, i) {
          var txt = String(cells[i] == null ? '' : cells[i]);
          var right = i >= 3;
          if (i === 1 && txt.length > 34) txt = txt.slice(0, 33) + '…';
          if (i === 2 && txt.length > 14) txt = txt.slice(0, 13) + '…';
          if (right) doc.text(txt, x + c.w - 2, y, { align: 'right' });
          else doc.text(txt, x, y);
          x += c.w;
        });
        y += 14;
        doc.setDrawColor(225, 228, 234);
        doc.line(x0, y - 10, pageW - margin, y - 10);
      }

      drawRow(cols.map(function (c) { return c.h; }), true);
      if (st.from) drawRow([fmtDate(st.from), 'Opening balance', '', '', '', pdfMoney(opening)], false);
      rows.forEach(function (r) { drawRow(r, false); });
      if (!rows.length && !st.from) drawRow(['', 'No entries in this range', '', '', '', pdfMoney(0)], false);

      ensure(22);
      y += 4;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
      var label = ledgerState().type === 'suppliers' ? 'You owe' : (ledgerState().type === 'staff' ? 'Owes you' : 'Receivable');
      var closing = sumSigned(st.type, filtered);
      doc.text('Closing ' + label + ': ' + pdfMoney(closing), x0, y);

      var filename = 'ledger-' + st.type + '-' + String(party.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '-' + today() + '.pdf';
      doc.save(filename);
      toast('Ledger exported as PDF');
    }).catch(function () { toast('Could not create the PDF'); });
  }

  function staffEntryModal(staffId) {
    var s = staffById(staffId);
    openModal('Add entry · ' + (s ? s.name : ''), `<form data-form="staffentry">
      <input type="hidden" name="staffId" value="${staffId}">
      <div class="grid2">
        <div class="field"><label>Type</label><select class="inp" name="type">
          <option value="advance">Advance given (staff owes)</option>
          <option value="repayment">Repayment received</option>
          <option value="deduction">Deducted from salary</option>
        </select></div>
        <div class="field"><label>Date</label><input class="inp" type="date" name="date" value="${today()}"></div>
      </div>
      <div class="field"><label>Amount</label><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" name="amount" required></div>
      <div class="field"><label>Note</label><input class="inp" name="note" placeholder="Reason"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save entry</button>
      </div></form>`);
  }

  /* ---------------------------------------------------------------- returns */
  function returnedQty(invoiceId, itemId) {
    var n = 0;
    db.sreturns.forEach(function (r) {
      if (r.invoiceId !== invoiceId) return;
      r.lines.forEach(function (l) { if (l.itemId === itemId) n += Number(l.qty) || 0; });
    });
    return n;
  }


  function viewReturns() {
    var all = db.sreturns.filter(function (r) { return r.branchId === ui.branch; })
      .slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    var list = fApply('returns', all);
    var total = all.reduce(function (s, r) { return s + r.total; }, 0);
    var units = all.reduce(function (s, r) { return s + r.lines.reduce(function (n, l) { return n + l.qty; }, 0); }, 0);

    return `
      <div class="page-head"><div><h2>Sales returns</h2>
        <div class="sub">${esc(branchName(ui.branch))} · ${units} units returned · ${money(total)} refunded</div></div></div>
      ${fBar('returns')}
      <div class="note" style="margin:12px 0 14px">Start a return from <b>Invoices</b> — open a bill and choose “Return items”. The stock goes back to the branch that sold it.</div>
      ${list.length ? `<div class="table-wrap"><table class="data"><thead><tr>
        <th>Return</th><th>Date</th><th>Invoice</th><th>Items</th><th class="num">Refund</th><th>Method</th><th>By</th>
        </tr></thead><tbody>${list.map(function (r) {
          var inv = invById(r.invoiceId);
          return `<tr><td><b>${esc(r.no)}</b></td><td>${esc(fmtDate(r.date))}</td>
            <td>${esc(inv ? inv.no : '—')}</td>
            <td>${r.lines.map(function (l) { return esc(l.name) + ' × ' + num(l.qty); }).join('<br>')}</td>
            <td class="num">${money(r.total)}</td><td>${esc(r.method || 'Cash')}</td>
            <td>${esc(r.byName || '—')}</td></tr>`;
        }).join('')}</tbody></table></div>`
        : `<div class="empty"><b>${fOn('returns') ? 'No returns match' : 'No returns yet'}</b>${fOn('returns') ? 'Try clearing a filter.' : 'Returns show up here with the stock they put back.'}</div>`}`;
  }

  function sreturnModal(id) {
    var inv = invById(id);
    if (!inv) return;
    var c = findCust(inv.customerId);
    openModal('Return items · ' + inv.no, `<form data-form="sreturn">
      <input type="hidden" name="invoiceId" value="${inv.id}">
      <div class="sub" style="margin-bottom:10px">${esc(c ? c.name : 'Walk-in')} · ${esc(fmtDate(inv.date))} · ${esc(branchName(inv.branchId))}</div>
      ${inv.lines.map(function (l, i) {
        var rem = Math.max(0, Number(l.qty) - returnedQty(inv.id, l.itemId));
        return `<div class="ret-line"><div><div class="nm">${esc(l.name)}</div>
          <div class="meta">sold ${num(l.qty)} · returnable ${num(rem)} · ${money(l.price)}</div></div>
          <input class="inp" type="text" inputmode="decimal" min="0" max="${rem}" step="1" name="ret_${i}" value="0"${rem <= 0 ? ' disabled' : ''} aria-label="Return quantity"></div>`;
      }).join('')}
      <div class="field" style="margin-top:14px"><label>Refund method</label><select class="inp" name="method">
        ${['Cash', 'UPI', 'Card', 'Bank', 'Credit note'].map(function (m) { return `<option>${m}</option>`; }).join('')}</select></div>
      <div class="hint">Returned stock goes back to ${esc(branchName(inv.branchId))}.</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save return</button>
      </div></form>`);
  }

  /* -------------------------------------------------------------- purchases */
  function supplierById(id) { return db.suppliers.filter(function (s) { return s.id === id; })[0] || null; }
  function allocTotal(line) {
    var t = 0;
    Object.keys(line.alloc || {}).forEach(function (k) { t += Number(line.alloc[k]) || 0; });
    return t;
  }
  function purchaseBranches(line) {
    return Object.keys(line.alloc || {}).filter(function (b) { return Number(line.alloc[b]) > 0; });
  }
  function purchaseStatus(p) { return (p && p.status === 'pending') ? 'pending' : 'approved'; }
  function visiblePurchases() {
    var st = S.currentStaff();
    return db.purchases.filter(function (p) {
      if (!p) return false;
      if (st && !S.isOwner() && (st.role === 'manager' || st.role === 'cashier')) {
        return p.createdById === st.id;
      }
      if (purchaseStatus(p) === 'pending') return S.isOwner() || (st && p.createdById === st.id);
      if (S.canSeeAllBranches()) return true;
      return p.lines.some(function (l) { return Number(l.alloc && l.alloc[ui.branch]) > 0; });
    });
  }

  function viewPurchases() {
    if (typeof markPurchaseApprovalsSeen === 'function' && !S.isOwner()) markPurchaseApprovalsSeen();
    var st = S.currentStaff();
    var restricted = !!(st && !S.isOwner());
    var all = visiblePurchases().slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    var list = fApply('purchases', all);
    var approvedAll = all.filter(function (p) { return purchaseStatus(p) === 'approved'; });
    var pendingAll = all.filter(function (p) { return purchaseStatus(p) === 'pending'; });
    var total = approvedAll.reduce(function (s, p) { return s + Number(p.total || 0); }, 0);
    var dueTotal = approvedAll.reduce(function (s, p) {
      var pd = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
      return s + Math.max(0, Number(p.total || 0) - pd);
    }, 0);
    var rets = db.preturns.filter(function (r) { return r.branchId === ui.branch; });
    var retTotal = rets.reduce(function (s, r) { return s + Number(r.total || 0); }, 0);
          var canNew = canSubmitPurchase();
    var newLabel = restricted ? '+ Send purchase for approval' : '+ New purchase';

    return `
      <div class="page-head compact-head" style="align-items:flex-start">
        <div>
          <h2>Purchases</h2>
          <div class="sub">${esc(branchName(ui.branch))} · ${list.length} ${list.length === 1 ? 'entry' : 'entries'}${pendingAll.length ? ' · ' + pendingAll.length + ' pending approval' : ''}</div>
        </div>
        <div class="row-actions">${canNew ? '<button class="btn primary" data-act="purchase-new">' + newLabel + '</button>' : ''}</div>
      </div>

      ${!restricted ? `<div class="stats purchase-stats" style="margin-bottom:12px">
        <div class="stat purchase-stat"><div class="k">Total purchases</div><div class="v">${money(total)}</div></div>
        <div class="stat purchase-stat"><div class="k">To pay</div><div class="v"${dueTotal > 0.009 ? ' style="color:#dc2626"' : ''}>${money(dueTotal)}</div></div>
        <div class="stat purchase-stat"><div class="k">Supplier returns</div><div class="v">${money(retTotal)}</div></div>
      </div>` : (pendingAll.length ? `<div class="note" style="margin-bottom:12px">Purchases you send for approval appear here. After approval you can see the details, but not any purchase amounts.</div>` : '')}

      <div class="card sale-block" style="padding:14px">
        <div class="sale-block-head">Purchase bills</div>
        ${fBar('purchases')}
        ${list.length ? (function () {
          var lim = 5 + (Number(ui.purchMore) || 0);
          var shown = list.slice(0, lim);
          var rows = shown.map(function (p) {
            var sup = supplierById(p.supplierId);
            var isPending = purchaseStatus(p) === 'pending';
            var paidAmt = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
            var dueAmt = r2(Number(p.total || 0) - paidAmt);
            var state = isPending ? ''
              : dueAmt <= 0.009 ? 'Paid'
              : paidAmt > 0 ? 'Balance ' + money(dueAmt) : 'Unpaid';
            var stateCls = dueAmt > 0.009 && !isPending ? ' bad' : '';
            var pdate = new Date(p.date);
            var shortDate = isNaN(pdate.getTime()) ? fmtDate(p.date)
              : pdate.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: pdate.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
            var right = (restricted || isPending)
              ? (isPending ? '<span class="badge warn">Pending</span>' : '<span class="badge ok">Approved</span>')
              : `<b class="purch-amt">${money(p.total)}</b>`;
            var menuItems = [`<button type="button" data-act="purchase-view" data-id="${p.id}">View</button>`];
            if (!isPending && (S.isOwner() || can('purchase.edit'))) menuItems.push(`<button type="button" data-act="purchase-edit" data-id="${p.id}">Edit</button>`);
            if (S.isOwner() && isPending) menuItems.push(`<button type="button" data-act="purchase-approve-open" data-id="${p.id}">Review &amp; approve</button>`);
            if (canDeleteEntry('purchase')) menuItems.push(`<button type="button" class="danger" data-act="del-ask" data-kind="purchase" data-id="${p.id}">Delete</button>`);
            return `<div class="cust-row purch-row" data-act="purchase-view" data-id="${p.id}" tabindex="0" role="button">
              <span class="cust-main">
                <span class="cust-name">${esc(p.no)}</span>
                <span class="cust-sub purch-sub">${esc([sup ? sup.name : 'Supplier', shortDate, p.lines.length + ' item' + (p.lines.length === 1 ? '' : 's')].join(' · '))}</span>
                ${state ? `<span class="cust-sub purch-state${stateCls}">${state}</span>` : ''}
              </span>
              <span class="itm-meta">${right}</span>
              <button type="button" class="cust-dots" data-act="purch-menu" data-id="${p.id}" aria-label="Actions for ${esc(p.no)}">⋮</button>
              ${ui.purchMenu === p.id ? `<div class="cust-menu cust-rowmenu">${menuItems.join('')}</div>` : ''}
            </div>`;
          }).join('');
          return `<div class="cust-list purch-list" style="margin-top:8px">${rows}</div>` +
            (list.length > shown.length
              ? `<div class="purch-more-wrap"><button type="button" class="btn sm" data-act="purch-show-more">Show more (${list.length - shown.length})</button></div>`
              : '');
        })()
          : `<div class="empty"><b>${fOn('purchases') ? 'No purchases match' : 'No purchases yet'}</b>${fOn('purchases') ? 'Try clearing a filter.' : (restricted ? 'Tap "Send purchase for approval" to add products for the owner to approve.' : 'Tap New purchase to record what you bought from a supplier.')}</div>`}
      </div>

      ${restricted ? '' : `<div class="card sale-block" style="padding:14px;margin-top:12px">
        <div class="sale-block-head">Returns to supplier</div>
        <div class="row-actions" style="margin-bottom:10px;justify-content:space-between;align-items:center">
          <span class="sub">${rets.length} recorded · ${money(retTotal)}</span>
          ${can('purchases') ? '<button class="btn sm" data-act="pret-new">+ Record return</button>' : ''}
        </div>
        ${rets.length ? `<div class="table-wrap"><table class="data"><thead><tr>
          <th>Return</th><th>Date</th><th>Supplier</th><th>Item</th><th class="num">Qty</th><th class="num">Value</th></tr></thead><tbody>
          ${rets.map(function (r) { var sup = supplierById(r.supplierId);
            return `<tr><td><b>${esc(r.no)}</b></td><td>${esc(fmtDate(r.date))}</td>
              <td>${esc(sup ? sup.name : '—')}</td><td>${esc(r.name)}</td>
              <td class="num">${num(r.qty)}</td><td class="num">${money(r.total)}</td></tr>`; }).join('')}
          </tbody></table></div>` : '<div class="empty sm"><b>No supplier returns</b>Send damaged or wrong stock back to the supplier here.</div>'}
      </div>`}
    `;
  }

  var pDraft = null;

  function pNewDraft() {
    return {
      supplierId: '', invoiceNo: '', date: today(),
      discount: 0, shipping: 0, note: '', q: '', supQ: '',
      payments: [{ method: 'Cash', amount: 0 }], autoPay: true, lines: []
    };
  }
  function pLine(id) {
    if (!pDraft) return null;
    for (var i = 0; i < pDraft.lines.length; i++) if (pDraft.lines[i].uid === id) return pDraft.lines[i];
    return null;
  }
  function pLineAmount(l) {
    return r2(Math.max(0, (Number(l.qty) || 0) * (Number(l.cost) || 0) - (Number(l.disc) || 0)));
  }
  function pSubtotal() {
    return r2((pDraft ? pDraft.lines : []).reduce(function (s2, l) { return s2 + pLineAmount(l); }, 0));
  }
  function pTotal() {
    if (!pDraft) return 0;
    return r2(Math.max(0, pSubtotal() - (Number(pDraft.discount) || 0)) + (Number(pDraft.shipping) || 0));
  }
  function pPaid() {
    return r2(((pDraft && pDraft.payments) || []).reduce(function (s2, pm) { return s2 + (Number(pm.amount) || 0); }, 0));
  }
  function pBalance() { return r2(pTotal() - pPaid()); }
  function pSyncPayments() {
    if (!pDraft) return;
    if (!pDraft.payments || !pDraft.payments.length) pDraft.payments = [{ method: 'Cash', amount: 0 }];
    if (pDraft.autoPay === false) return;
    var total = pTotal();
    if (pDraft.payments.length === 1) { pDraft.payments[0].amount = total; return; }
    var n = pDraft.payments.length;
    var base = Math.floor((total / n) * 100) / 100;
    pDraft.payments.forEach(function (pm, i) { pm.amount = i === n - 1 ? r2(total - base * (n - 1)) : base; });
  }
  function pRecalc() { pSyncPayments(); pRefreshTotals(); }

  function pPickHTML() {
    var q = String((pDraft && pDraft.q) || '').trim();
    if (!q) return '';
    var list = db.items.filter(function (it) {
      return match(it.name, q) || match(it.sku, q) || match(it.category, q);
    }).slice(0, 7);
    if (!list.length) return '<div class="p-pick-empty">No item matches that. Check the spelling, or add the item in Items &amp; stock first.</div>';
    return list.map(function (it) {
      return `<button type="button" class="p-pick" data-act="p-add" data-id="${it.id}">
        <span class="grow"><span class="nm">${esc(it.name)}</span>
          <span class="meta">${esc(it.sku || '—')} · ${num(stockOf(it))} in stock</span></span>
        <span class="pr">${money(it.cost || 0)}</span></button>`;
    }).join('');
  }

  function pSuppPickHTML() {
    var q = String((pDraft && pDraft.supQ) || '').trim();
    if (!q) return '';
    var list = db.suppliers.filter(function (sp) { return match(sp.name, q) || match(sp.phone, q); }).slice(0, 6);
    var qAttr = esc(q).replace(/"/g, '&quot;');
    if (!list.length) return '<div class="p-pick-empty">No supplier matches. <button type="button" class="btn sm" data-act="supplier-new-from-purchase" data-name="' + qAttr + '">+ Add "' + esc(q) + '"</button></div>';
    return list.map(function (sp) {
      return `<button type="button" class="p-pick" data-act="p-supplier-pick" data-id="${sp.id}">
        <span class="grow"><span class="nm">${esc(sp.name)}</span>
          <span class="meta">${esc(sp.phone || 'no phone')}</span></span>
        <span class="pr">Pick</span></button>`;
    }).join('') + '<div class="p-pick-empty" style="margin-top:6px"><button type="button" class="btn sm" data-act="supplier-new-from-purchase" data-name="' + qAttr + '">+ Add new supplier</button></div>';
  }
  function pPayRowsHTML() {
    return pDraft.payments.map(function (pm, i) {
      return `<div class="p-pay-row">
        <select class="inp" data-change="p-pay-method" data-id="${i}" aria-label="Payment method">
          ${PAY_METHODS.map(function (m) { return `<option${pm.method === m ? ' selected' : ''}>${m}</option>`; }).join('')}
        </select>
        <input class="inp" type="text" inputmode="decimal" min="0" step="0.01" data-input="p-pay-amount" data-id="${i}" value="${Number(pm.amount) ? Number(pm.amount) : ''}" placeholder="0" aria-label="Amount">
        ${pDraft.payments.length > 1 ? `<button type="button" class="p-x" data-act="p-pay-remove" data-id="${i}" aria-label="Remove payment">✕</button>` : ''}
      </div>`;
    }).join('');
  }

  function pPickSupplier(id) {
    var sp = supplierById(id);
    if (!sp || !pDraft) return;
    pDraft.supplierId = sp.id;
    pDraft.supQ = '';
    var inp = document.querySelector('[data-input="p-sup-q"]');
    if (inp) inp.value = sp.name;
    var box = $('#pSuppPick'); if (box) box.innerHTML = '';
  }

  function pSplitNote(l) {
    var sum = 0;
    Object.keys(l.alloc || {}).forEach(function (b) { sum += Number(l.alloc[b]) || 0; });
    if (!sum) return 'Empty = all ' + num(l.qty) + ' in ' + branchName(ui.branch);
    if (sum !== Number(l.qty)) return 'Split ' + num(sum) + ' of ' + num(l.qty) + ' — must match';
    return 'Split ' + num(sum) + ' of ' + num(l.qty) + ' ✓';
  }

  function pLineHTML(l) {
    var multi = db.branches.length > 1;
    var extras = [l.quality ? 'Quality: ' + l.quality : '', l.brand ? 'Brand: ' + l.brand : '', l.color ? 'Colour: ' + l.color : '', l.size ? 'Size: ' + l.size : '', l.serial ? 'Serial: ' + l.serial : ''].filter(Boolean);
    var hideMoney = (typeof purchaseApprovalMode === 'function') && purchaseApprovalMode() && !(pDraft && (pDraft.approving || pDraft.editing));
    return `<div class="p-item p-item-compact" data-line="${l.uid}">
      <details class="p-item-details">
        <summary class="p-item-summary" aria-label="Edit ${esc(l.name)}">
          <div class="p-item-main">
            <div class="nm">${esc(l.name)}</div>
            <div class="meta">${hideMoney ? ('Qty ' + num(l.qty)) : (num(l.qty) + ' × ' + money(l.cost) + (Number(l.disc) ? ' · Disc ' + money(l.disc) : ''))}${extras.length ? ' · ' + esc(extras.join(' · ')) : ''}</div>
          </div>
          <div class="p-item-amt">${hideMoney ? `<b>Qty ${num(l.qty)}</b>` : `<b data-line-amt="${l.uid}">${money(pLineAmount(l))}</b>`}<span class="sub">Tap to edit</span></div>
        </summary>
        <div class="p-item-edit">
          <div class="p-item-fields">
            <label class="pf"><span>Qty</span><input class="inp" type="text" inputmode="numeric" min="1" step="1" data-input="p-qty" data-id="${l.uid}" value="${num(l.qty)}"></label>
            ${hideMoney ? '' : `<label class="pf"><span>Cost / unit</span><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" data-input="p-cost" data-id="${l.uid}" value="${l.cost}"></label>
            <label class="pf"><span>Discount</span><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" data-input="p-disc" data-id="${l.uid}" value="${Number(l.disc) || 0}"></label>
            <div class="pf amt"><span>Amount</span><b data-line-amt="${l.uid}">${money(pLineAmount(l))}</b></div>`}
          </div>
          <div class="p-extra-block">
            <div class="p-item-fields four">
              <label class="pf"><span>Quality</span><input class="inp" data-input="p-extra" data-field="quality" data-id="${l.uid}" value="${esc(l.quality || '')}" placeholder="New / A-grade"></label>
              <label class="pf"><span>Brand</span><input class="inp" data-input="p-extra" data-field="brand" data-id="${l.uid}" value="${esc(l.brand || '')}"></label>
              <label class="pf"><span>Colour</span><input class="inp" data-input="p-extra" data-field="color" data-id="${l.uid}" value="${esc(l.color || '')}"></label>
              <label class="pf"><span>Size</span><input class="inp" data-input="p-extra" data-field="size" data-id="${l.uid}" value="${esc(l.size || '')}"></label>
              <label class="pf wide"><span>Serial / batch no.</span><input class="inp" data-input="p-extra" data-field="serial" data-id="${l.uid}" value="${esc(l.serial || '')}"></label>
            </div>
            ${multi ? `<div class="p-split"><span class="p-split-label">Put the stock in</span>
              ${db.branches.map(function (b) {
                return `<label class="pf"><span>${esc(b.name)}</span><input class="inp" type="text" inputmode="numeric" min="0" step="1" data-input="p-alloc" data-branch="${b.id}" data-id="${l.uid}" value="${Number((l.alloc || {})[b.id]) || ''}" placeholder="0"></label>`;
              }).join('')}
              <span class="p-split-note" data-split-note="${l.uid}">${pSplitNote(l)}</span></div>` : ''}
          </div>
          <div class="row-actions" style="justify-content:flex-end;margin-top:8px">
            <button type="button" class="btn sm danger" data-act="p-remove-line" data-id="${l.uid}">Remove item</button>
          </div>
        </div>
      </details>
    </div>`;
  }

  function pTotalsHTML() {
    var hideMoney = (typeof purchaseApprovalMode === 'function') && purchaseApprovalMode() && !(pDraft && (pDraft.approving || pDraft.editing));
    if (hideMoney) {
      var qty = (pDraft ? pDraft.lines : []).reduce(function (s2, l) { return s2 + (Number(l.qty) || 0); }, 0);
      return `<div class="p-totals" id="pTotals"><div class="note">Add products and details, then send this purchase for the owner to approve. Prices and payment will be added by the owner.</div><div class="p-sum" style="margin-top:8px"><span>Total items</span><b>${num((pDraft && pDraft.lines ? pDraft.lines.length : 0))}</b></div><div class="p-sum"><span>Total quantity</span><b>${num(qty)}</b></div></div>`;
    }
    var bal = pBalance();
    return `<div class="p-totals" id="pTotals">
      <div class="p-sum"><span>Subtotal</span><b data-sum="sub">${money(pSubtotal())}</b></div>
      <label class="p-sum inp-row"><span>Discount</span><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" inputmode="decimal" data-input="p-discount" value="${Number(pDraft.discount) || 0}"></label>
      <label class="p-sum inp-row"><span>Shipping</span><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" inputmode="decimal" data-input="p-shipping" value="${Number(pDraft.shipping) || 0}"></label>
      <div class="p-sum total"><span>Total</span><b data-sum="total">${money(pTotal())}</b></div>
      <div class="p-pay">
        <div class="p-pay-head"><span>Payment</span>
          <span class="p-pay-tools">
            <button type="button" class="p-chip" data-act="p-pay-add">+ Split</button>
            <button type="button" class="p-chip" data-act="p-pay-full">Pay full</button>
          </span></div>
        <div id="pPayRows">${pPayRowsHTML()}</div>
      </div>
      <div class="p-sum"><span>Paid</span><b data-sum="paid">${money(pPaid())}</b></div>
      <div class="p-sum bal"><span data-bal-label">${bal > 0.009 ? 'Balance to pay later' : 'Settled'}</span><b data-sum="bal">${money(Math.max(0, bal))}</b></div>
      <div class="p-pay-chips">
        <button type="button" class="p-chip" data-act="p-paid" data-id="full">Paid in full</button>
        <button type="button" class="p-chip" data-act="p-paid" data-id="half">Half now</button>
        <button type="button" class="p-chip" data-act="p-paid" data-id="none">On credit</button>
      </div>
    </div>`;
  }

  function pRefreshTotals() {
    if (!pDraft) return;
    var hideMoney = (typeof purchaseApprovalMode === 'function') && purchaseApprovalMode() && !(pDraft && (pDraft.approving || pDraft.editing));
    if (hideMoney) {
      var host = $('#pTotals');
      if (host) host.outerHTML = pTotalsHTML();
      return;
    }
    function set(k, v) { var el = document.querySelector('[data-sum="' + k + '"]'); if (el) el.textContent = v; }
    set('sub', money(pSubtotal()));
    set('total', money(pTotal()));
    set('paid', money(pPaid()));
    var bal = pBalance();
    set('bal', money(Math.max(0, bal)));
    var lbl = document.querySelector('[data-bal-label]');
    if (lbl) lbl.textContent = bal > 0.009 ? 'Balance to pay later' : 'Settled';
    var wrap = document.querySelector('.p-sum.bal');
    if (wrap) { if (bal > 0.009) wrap.removeAttribute('data-zero'); else wrap.setAttribute('data-zero', '1'); }
  }

  function pRenderLines() {
    var host = $('#pLines');
    if (host) host.innerHTML = pDraft && pDraft.lines.length
      ? pDraft.lines.map(pLineHTML).join('')
      : '<div class="p-empty">Tap “Add items” to select items and set quantity.</div>';
    pRecalc();
  }

  function pAddItem(id) {
    var it = itemById(id);
    if (!it || !pDraft) return;
    var line = pDraft.lines.filter(function (l) { return l.itemId === id; })[0];
    if (line) line.qty = Math.max(1, (Number(line.qty) || 0) + 1);
    else pDraft.lines.push({
      uid: uid(), itemId: it.id, name: it.name, sku: it.sku || '', qty: 1,
      cost: r2(Number(it.cost) || 0), disc: 0,
      quality: '', brand: it.brand || '', color: '', size: '', serial: '', alloc: {}
    });
    pDraft.q = '';
    var srch = document.querySelector('[data-input="p-search"]');
    if (srch) srch.value = '';
    var pick = $('#pPick'); if (pick) pick.innerHTML = '';
    pRenderLines();
    var again = document.querySelector('[data-input="p-search"]');
    if (again) again.focus();
  }

  function pRemoveLine(uidv) {
    if (!pDraft) return;
    pDraft.lines = pDraft.lines.filter(function (l) { return l.uid !== uidv; });
    pRenderLines();
  }

  function pPickFirst() {
    var q = String((pDraft && pDraft.q) || '').trim();
    if (!q) return;
    var list = db.items.filter(function (it) {
      return match(it.name, q) || match(it.sku, q) || match(it.category, q);
    });
    if (!list.length) return toast('No item matches that name');
    pAddItem(list[0].id);
  }

  function purchaseModal(opts) {
    opts = opts || {};
    if (opts.editId) {
      var ed = db.purchases.filter(function (x) { return x.id === opts.editId; })[0];
      if (!ed) { toast('Purchase not found'); return; }
      if (!(S.isOwner() || can('purchase.edit'))) return toast('You cannot edit purchases');
      if (purchaseStatus(ed) !== 'approved') return toast('Only approved purchases can be edited');
      pDraft = {
        editing: true, editId: ed.id, editNo: ed.no,
        supplierId: ed.supplierId || '', invoiceNo: ed.invoiceNo || '', date: ed.date || today(),
        discount: Number(ed.discount) || 0, shipping: Number(ed.shipping) || 0, note: ed.note || '',
        q: '', supQ: '', autoPay: false,
        payments: (ed.payments && ed.payments.length ? ed.payments.map(function (pm) {
          return { method: pm.method || 'Cash', amount: Number(pm.amount) || 0 };
        }) : [{ method: 'Cash', amount: 0 }]),
        lines: (ed.lines || []).map(function (l) {
          return {
            uid: uid(), itemId: l.itemId, name: l.name, sku: '', qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
            cost: r2(Number(l.cost) || 0), disc: r2(Number(l.disc) || 0),
            quality: String(l.quality || ''), brand: String(l.brand || ''), color: String(l.color || ''),
            size: String(l.size || ''), serial: String(l.serial || ''), alloc: JSON.parse(JSON.stringify(l.alloc || {}))
          };
        })
      };
      ui.pItemSheet = { open: false, q: '', sel: {} };
    } else if (opts.approveId) {
      var ap = db.purchases.filter(function (x) { return x.id === opts.approveId; })[0];
      if (!ap) { toast('Purchase not found'); return; }
      pDraft = {
        approving: true, approveId: ap.id, approveNo: ap.no,
        supplierId: ap.supplierId || '', invoiceNo: ap.invoiceNo || '', date: ap.date || today(),
        discount: Number(ap.discount) || 0, shipping: Number(ap.shipping) || 0, note: ap.note || '', q: '', supQ: '',
        payments: (ap.payments && ap.payments.length ? ap.payments.map(function(pm){ return { method: pm.method || 'Cash', amount: Number(pm.amount) || 0 }; }) : [{ method: 'Cash', amount: 0 }]),
        autoPay: !(ap.payments && ap.payments.length && (Number(ap.paid) || 0) > 0 && r2(Number(ap.paid) || 0) !== r2(Number(ap.total) || 0)),
        lines: (ap.lines || []).map(function (l) {
          return {
            uid: uid(), itemId: l.itemId, name: l.name, sku: '', qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
            cost: r2(Number(l.cost) || 0), disc: r2(Number(l.disc) || 0),
            quality: String(l.quality || ''), brand: String(l.brand || ''), color: String(l.color || ''),
            size: String(l.size || ''), serial: String(l.serial || ''), alloc: JSON.parse(JSON.stringify(l.alloc || {}))
          };
        })
      };
      if (!pDraft.lines.length) { toast('This purchase has no items'); return; }
      opts.approve = true;
      ui.pItemSheet = { open: false, q: '', sel: {} };
    } else {
      var resuming = !!opts.resume && !!pDraft;
      if (!resuming) {
        pDraft = pNewDraft();
        ui.pItemSheet = { open: false, q: '', sel: {} };
      } else {
        if (!ui.pItemSheet) ui.pItemSheet = { open: false, q: '', sel: {} };
        ui.pItemSheet.open = !!opts.openItemSheet;
        ui.pItemSheet.q = ui.pItemSheet.q || '';
        ui.pItemSheet.sel = ui.pItemSheet.sel || {};
      }
    }
    pSyncPayments();
    var chosen = supplierById(pDraft.supplierId);
    var noSuppliersYet = !db.suppliers.length;
    var _pTitle = (pDraft && pDraft.editing) ? 'Edit purchase' : (pDraft && pDraft.approving) ? 'Approve purchase' : (((typeof purchaseApprovalMode === 'function') && purchaseApprovalMode()) ? 'Purchase request' : 'New purchase');
    openModal(_pTitle, `<form data-form="purchase" class="p-form purchase-form-ui">
      ${(pDraft && pDraft.editing) ? `<div class="note" style="margin-bottom:8px">Editing <b>${esc(pDraft.editNo || '')}</b> — stock and totals are corrected when you save.</div>` : ''}
      <div class="card sale-block p-details-card" style="padding:8px 10px;margin:0">
        <div class="p-head p-head-compact p-head-ultra">
          <label class="pf pf-compact"><span>Supplier</span>
            <input class="inp inp-compact" data-input="p-sup-q" placeholder="${noSuppliersYet ? 'Type a supplier name' : 'Select supplier'}" autocomplete="off" value="${esc(chosen ? chosen.name : (pDraft.supQ || ''))}"></label>
          <label class="pf pf-compact"><span>Invoice no.</span><input class="inp inp-compact" data-input="p-inv-no" placeholder="2456" autocomplete="off" value="${esc(pDraft.invoiceNo || '')}"></label>
          <label class="pf pf-compact pf-date"><span>Date</span><input class="inp inp-compact" type="date" data-change="p-date" value="${esc(pDraft.date || today())}"></label>
        </div>
        <div class="p-picks" id="pSuppPick"></div>
      </div>

      <div class="card sale-block" style="padding:12px;margin:0">
        <div class="sale-block-head">Items</div>
        <div style="margin-top:8px">
          <button class="btn add-items-btn" type="button" data-act="open-p-item-sheet" style="width:100%;justify-content:center"><span class="plus">+</span> Add items</button>
        </div>
        <div id="pLines" class="p-lines" style="margin-top:10px">${(pDraft.lines && pDraft.lines.length) ? pDraft.lines.map(pLineHTML).join('') : '<div class="p-empty">Tap “Add items” to select items and set quantity.</div>'}</div>
      </div>

      ${pTotalsHTML()}

      <label class="pf p-note"><span>Note</span><input class="inp" data-input="p-note" placeholder="Transport, packing, credit terms…" autocomplete="off" value="${esc(pDraft.note || '')}"></label>
      <div id="pSheetHost">${pItemSheetHTML()}</div>
      <div class="p-actions">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">${(pDraft && pDraft.editing) ? 'Save changes' : (((typeof purchaseApprovalMode === 'function') && purchaseApprovalMode() && !(pDraft && pDraft.approving)) ? 'Send for approval' : (pDraft && pDraft.approving ? 'Approve purchase' : 'Save purchase'))}</button>
      </div></form>`, { fullpage: true });
  }


  /* purchase item sheet (billing-style) */
  function pItemSheetState() {
    if (!ui.pItemSheet) ui.pItemSheet = { open: false, q: '', sel: {} };
    if (!ui.pItemSheet.sel) ui.pItemSheet.sel = {};
    return ui.pItemSheet;
  }
  function pItemSheetSelectedCount(sel) {
    return Object.keys(sel || {}).filter(function (k) { return Number(sel[k]) > 0; }).length;
  }
  function pItemSheetHTML() {
    var sh = pItemSheetState();
    if (!sh.open) return '';
    var q = sh.q || '';
    var list = db.items.filter(function (it) {
      return !q || match(it.name, q) || match(it.code, q) || match(it.cat, q) || match(it.sku, q) || match(it.category, q);
    });
    var selCount = pItemSheetSelectedCount(sh.sel);
    var hideMoney = (typeof purchaseApprovalMode === 'function') && purchaseApprovalMode() && !(pDraft && (pDraft.approving || pDraft.editing));
    var rows = list.length ? list.map(function (it) {
      var stockQty = (typeof S !== 'undefined' && S.stockOf) ? S.stockOf(it, ui.branch) : ((typeof stockOf === 'function') ? stockOf(it, ui.branch) : 0);
      var low = stockQty <= (Number(it.reorder) || 0);
      var selQty = Math.max(0, Math.floor(Number(sh.sel[it.id]) || 0));
      var checked = selQty > 0;
      return `<div class="sheet-item${checked ? ' sel' : ''}" data-act="p-item-sheet-toggle" data-id="${it.id}" role="button" tabindex="0">
        <span class="sheet-check">${checked ? '✓' : ''}</span>
        <span class="sheet-item-main">
          <span class="sheet-item-name">${esc(it.name)}</span>
          <span class="sheet-item-meta">${esc(it.sku || it.cat || 'Item')}${hideMoney ? '' : ' · Cost ' + money(it.cost || 0)} · <span class="${low ? 'badge warn' : 'sub'}">${num(stockQty)} in stock</span></span>
        </span>
        ${checked ? `<div class="sheet-qty" data-stop-sheet="1">
          <button class="btn sm icon" type="button" data-act="p-item-sheet-qty-down" data-id="${it.id}" aria-label="Less">−</button>
          <span class="sheet-qty-val">${selQty}</span>
          <button class="btn sm icon" type="button" data-act="p-item-sheet-qty-up" data-id="${it.id}" aria-label="More">+</button>
        </div>` : ''}
      </div>`;
    }).join('') : '<div class="empty" style="margin:8px 0"><b>' + (db.items.length ? 'No items found' : 'No items yet') + '</b>' + (db.items.length ? 'Try a different search.' : 'Tap “+ New item” below to add your first item.') + '</div>';
    return `<div class="sheet-overlay open" data-act="close-p-item-sheet">
      <div class="sheet-panel" data-stop-sheet="1">
        <div class="sheet-head">
          <div><b>Select items</b><div class="sub">${selCount} selected</div></div>
          <button class="icon-btn" type="button" data-act="close-p-item-sheet" aria-label="Close">✕</button>
        </div>
        <div class="sheet-search searchbox">${ico('search')}<input class="inp" data-input="p-item-sheet-q" placeholder="Search items…" value="${esc(q)}" autocomplete="off"></div>
        <div class="sheet-list">${rows}</div>
        <div class="sheet-foot">
          <button class="btn sheet-btn-light" type="button" data-act="item-new" data-ctx="purchase">+ New item</button>
          <span class="sheet-foot-spacer"></span>
          <button class="btn sheet-btn-light" type="button" data-act="close-p-item-sheet">Cancel</button>
          <button class="btn primary" type="button" data-act="p-item-sheet-add"${selCount ? '' : ' disabled'}>Add ${selCount ? selCount + ' item' + (selCount > 1 ? 's' : '') : 'items'}</button>
        </div>
      </div>
    </div>`;
  }
  function pRenderSheet(opts) {
    opts = opts || {};
    var host = $('#pSheetHost');
    var prevList = host ? host.querySelector('.sheet-list') : null;
    var scrollTop = (!opts.resetScroll && prevList) ? prevList.scrollTop : 0;
    var active = document.activeElement;
    var wasSearchFocus = active && active.getAttribute && active.getAttribute('data-input') === 'p-item-sheet-q';
    var keepSearchFocus = !!opts.focusSearch || wasSearchFocus;
    var selStart = null, selEnd = null;
    if (wasSearchFocus) { try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) {} }
    if (opts.caretEnd) { selStart = null; selEnd = null; }
    if (host) host.innerHTML = pItemSheetHTML();
    else if (pItemSheetState().open) {
      // fallback: rerender modal if host missing
      var sh = pItemSheetState();
      purchaseModal();
      if (sh.open) { ui.pItemSheet = sh; var h2 = $('#pSheetHost'); if (h2) h2.innerHTML = pItemSheetHTML(); host = h2; }
    }
    if (host) {
      var list = host.querySelector('.sheet-list');
      if (list && !opts.resetScroll) list.scrollTop = scrollTop;
      if (keepSearchFocus) {
        var inp = host.querySelector('[data-input="p-item-sheet-q"]');
        if (inp) {
          inp.focus();
          try {
            var vlen = (inp.value || '').length;
            if (opts.caretEnd || selStart == null) inp.setSelectionRange(vlen, vlen);
            else inp.setSelectionRange(selStart, selEnd);
          } catch (e) {}
        }
      }
    }
  }
  function pAddItemsFromSheet(items) {
    if (!pDraft) return;
    (items || []).forEach(function (x) {
      if (!x || !x.id) return;
      var it = itemById(x.id);
      if (!it) return;
      var addQty = Math.max(1, Math.floor(Number(x.qty) || 1));
      var line = pDraft.lines.filter(function (l) { return l.itemId === x.id; })[0];
      if (line) line.qty = Math.max(1, (Number(line.qty) || 0) + addQty);
      else pDraft.lines.push({
        uid: uid(), itemId: it.id, name: it.name, sku: it.sku || '', qty: addQty,
        cost: r2(Number(it.cost) || 0), disc: 0,
        quality: '', brand: it.brand || '', color: '', size: '', serial: '', alloc: {}
      });
    });
    pRenderLines();
  }


  function preTurnModal() {
    if (!db.suppliers.length) return toast('Add a supplier first');
    openModal('Purchase return', `<form data-form="preturn">
      <div class="grid2">
        <div class="field"><label>Supplier</label><select class="inp" name="supplierId">
          ${db.suppliers.map(function (s) { return `<option value="${s.id}">${esc(s.name)}</option>`; }).join('')}</select></div>
        <div class="field"><label>Date</label><input class="inp" type="date" name="date" value="${today()}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Item</label><select class="inp" name="itemId">
          ${db.items.map(function (it) { return `<option value="${it.id}">${esc(it.name)}</option>`; }).join('')}</select></div>
        <div class="field"><label>Take from branch</label><select class="inp" name="branchId">
          ${S.visibleBranches().map(function (b) { return `<option value="${b.id}"${b.id === ui.branch ? ' selected' : ''}>${esc(b.name)}</option>`; }).join('')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Quantity</label><input class="inp" type="text" inputmode="decimal" min="1" step="1" name="qty" value="1"></div>
        <div class="field"><label>Cost per unit</label><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" name="cost" value="0"></div>
      </div>
      <div class="field"><label>Reason</label><input class="inp" name="note" placeholder="Wrong item, damaged, expired…"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save return</button>
      </div></form>`);
  }

  /* While a supplier name is typed, show the suppliers that already exist
     under a similar name, phone or email, so the same business is not added
     twice. Mirrors the item name picker. */
  function supplierNamePickHTML(q, skipId) {
    var needle = String(q == null ? '' : q).trim().toLowerCase();
    if (needle.length < 2) return '';
    var words = needle.split(/\s+/).filter(Boolean);
    var digits = needle.replace(/[^0-9]/g, '');
    var list = db.suppliers.filter(function (s) {
      if (skipId && s.id === skipId) return false;
      var hay = [s.name || '', s.phone || '', s.email || '', s.address || ''].join(' ').toLowerCase();
      if (words.every(function (w) { return hay.indexOf(w) >= 0; })) return true;
      return digits.length >= 3 && String(s.phone || '').replace(/[^0-9]/g, '').indexOf(digits) >= 0;
    }).slice(0, 5);
    if (!list.length) return '';
    var exact = list.some(function (s) { return String(s.name || '').trim().toLowerCase() === needle; });
    var head = exact
      ? 'This supplier is already added — open it instead of adding it again.'
      : 'Similar suppliers already exist — check them before adding a new one.';
    return `<div class="name-pick-head">${head}</div>` + list.map(function (s) {
      var st = supplierStats(s);
      var meta = [s.phone || '', st.count ? st.count + (st.count === 1 ? ' purchase' : ' purchases') : 'No purchases',
        st.due > 0.009 ? money(st.due) + ' due' : ''].filter(Boolean).join(' · ');
      var isExact = String(s.name || '').trim().toLowerCase() === needle;
      return `<div class="name-pick-row${isExact ? ' exact' : ''}">
        <span class="grow"><span class="nm">${esc(s.name)}</span><span class="sub">${esc(meta)}</span></span>
        <button type="button" class="btn sm ghost" data-act="supplier-name-open" data-id="${s.id}">Open</button>
      </div>`;
    }).join('');
  }

  function supplierModal(id, prefill) {
    var s = id ? supplierById(id) : null;
    var preName = (!s && prefill && prefill.name) ? prefill.name : '';
    openModal(s ? 'Edit supplier' : 'Add supplier', `<form data-form="supplier">
      <input type="hidden" name="id" value="${s ? s.id : ''}">
      <div class="field"><label>Supplier name</label>
        <input class="inp" name="name" required autocomplete="off" data-input="sup-name" value="${esc(s ? s.name : preName)}">
        <div class="name-pick" id="supNamePick">${preName ? supplierNamePickHTML(preName, '') : ''}</div>
      </div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input class="inp" name="phone" value="${esc(s ? s.phone : '')}"></div>
        <div class="field"><label>Email</label><input class="inp" type="email" name="email" value="${esc(s ? s.email : '')}"></div>
      </div>
      <div class="field"><label>Address</label><input class="inp" name="address" value="${esc(s ? s.address : '')}"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save supplier</button>
      </div></form>`);
  }

  function purchaseView(id) {
    var p = db.purchases.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var sup = supplierById(p.supplierId);
    var isPending = purchaseStatus(p) === 'pending';
    var showMoney = S.isOwner() || can('purchase.edit') || can('purchase.pay');
    var paidAmt = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
    var dueAmt = r2(Number(p.total || 0) - paidAmt);
    var subAmt = p.subtotal != null ? p.subtotal : r2(Number(p.total || 0) - (Number(p.shipping) || 0) + (Number(p.discount) || 0));
    var statusLine = isPending ? '<span class="badge warn">Pending approval</span>' : '<span class="badge ok">Approved</span>';
    openModal(p.no, `
      <div class="p-view-head">
        <div><span>Supplier</span><b>${esc(sup ? sup.name : '—')}</b></div>
        <div><span>Invoice no.</span><b>${esc(p.invoiceNo || '—')}</b></div>
        <div><span>Date</span><b>${esc(fmtDate(p.date))}</b></div>
        <div><span>Status</span><b>${statusLine}</b></div>
      </div>
      ${(!showMoney && p.createdByName) ? `<div class="note" style="margin-bottom:10px">Sent by ${esc(p.createdByName)}${isPending ? ' · waiting for owner approval' : ' · approved'}.</div>` : ''}
      <div class="p-view-lines">${p.lines.map(function (l) {
        var extra = [];
        if (l.quality) extra.push('Quality: ' + l.quality);
        if (l.brand) extra.push('Brand: ' + l.brand);
        if (l.color) extra.push('Colour: ' + l.color);
        if (l.size) extra.push('Size: ' + l.size);
        if (l.serial) extra.push('Serial: ' + l.serial);
        var allocTxt = Object.keys(l.alloc || {}).filter(function (bx) { return Number(l.alloc[bx]) > 0; })
          .map(function (bx) { return branchName(bx) + ': ' + num(l.alloc[bx]); }).join(' · ');
        return `<div class="p-view-line">
          <div class="row1"><b>${esc(l.name)}</b>${showMoney ? `<span>${money(pLineAmount(l))}</span>` : `<span>Qty ${num(l.qty)}</span>`}</div>
          <div class="sub">${showMoney ? (num(l.qty) + ' × ' + money(l.cost) + (Number(l.disc) ? ' − ' + money(l.disc) + ' discount' : '')) : ('Quantity: ' + num(l.qty))}</div>
          ${extra.length ? `<div class="meta">${extra.map(esc).join(' · ')}</div>` : ''}
          <div class="meta">${esc(allocTxt || 'No branch split')}</div></div>`;
      }).join('')}</div>
      ${showMoney ? `<div class="p-view-tot">
        <div><span>Subtotal</span><b>${money(subAmt)}</b></div>
        ${Number(p.discount) ? `<div><span>Discount</span><b>− ${money(p.discount)}</b></div>` : ''}
        ${Number(p.shipping) ? `<div><span>Shipping</span><b>${money(p.shipping)}</b></div>` : ''}
        <div class="big"><span>Total</span><b>${money(p.total)}</b></div>
        <div><span>Paid now</span><b>${money(paidAmt)}</b></div>
        ${(p.payments || []).length ? `<div class="meta"><span>Paid by</span><b>${p.payments.map(function (pm) { return esc(pm.method) + ' ' + money(pm.amount); }).join(' · ')}</b></div>` : ''}
        ${dueAmt > 0.009 ? `<div class="due"><span>Balance to pay</span><b>${money(dueAmt)}</b></div>` : ''}
      </div>` : ''}
      ${p.note ? `<div class="p-view-note"><b>Note</b><br>${esc(p.note)}</div>` : ''}
      <div class="row-actions" style="justify-content:flex-end;margin-top:14px">
        ${S.isOwner() && isPending ? `<button class="btn primary" type="button" data-act="purchase-approve-open" data-id="${p.id}">Review & approve</button>` : ''}
        ${(!isPending && dueAmt > 0.009 && (S.isOwner() || canPayPurchase())) ? `<button class="btn primary" type="button" data-act="purchase-pay" data-id="${p.id}">Pay</button>` : ''}
        ${(!isPending && (S.isOwner() || can('purchase.edit'))) ? `<button class="btn${dueAmt > 0.009 ? '' : ' primary'}" type="button" data-act="purchase-edit" data-id="${p.id}">Edit purchase</button>` : ''}
        ${canDeleteEntry('purchase') ? `<button class="btn danger" type="button" data-act="del-ask" data-kind="purchase" data-id="${p.id}">Delete purchase</button>` : ''}
        <button class="btn" type="button" data-act="close-modal">Close</button></div>`);
  }

  /* Record a payment against an approved purchase */
  var payDraft = null;

  function payDueOf(p) {
    var paid = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
    return r2(Math.max(0, Number(p.total || 0) - paid));
  }

  function payRowsHTML() {
    return payDraft.rows.map(function (r, i) {
      return `<div class="p-pay-row">
        <select class="inp" name="pm${i}" aria-label="Payment method">
          ${PAY_METHODS.map(function (m) { return `<option${r.method === m ? ' selected' : ''}>${m}</option>`; }).join('')}
        </select>
        <input class="inp" type="text" inputmode="decimal" autocomplete="off" data-input="pay-amount" name="pa${i}" value="${r.amount === '' || r.amount == null ? '' : esc(String(r.amount))}" placeholder="0" aria-label="Amount">
        ${payDraft.rows.length > 1 ? `<button type="button" class="p-x" data-act="pay-row-del" data-id="${i}" aria-label="Remove payment">✕</button>` : '<span></span>'}
      </div>`;
    }).join('');
  }

  function payTotalsNow() {
    var form = document.querySelector('form[data-form="purchase-pay"]');
    var p = payDraft ? db.purchases.filter(function (x) { return x.id === payDraft.id; })[0] : null;
    var due = p ? payDueOf(p) : 0;
    var sum = 0;
    if (form && payDraft) {
      payDraft.rows.forEach(function (r, i) {
        var amt = form.querySelector('[name="pa' + i + '"]');
        if (amt) sum += Number(String(amt.value || '').replace(/[^0-9.]/g, '')) || 0;
      });
    } else if (payDraft) {
      payDraft.rows.forEach(function (r) {
        sum += Number(String(r.amount == null ? '' : r.amount).replace(/[^0-9.]/g, '')) || 0;
      });
    }
    return { sum: r2(sum), due: due };
  }

  function paySummaryHTML() {
    var t = payTotalsNow();
    var p = payDraft ? db.purchases.filter(function (x) { return x.id === payDraft.id; })[0] : null;
    var paidBefore = p ? r2(Number(p.total || 0) - t.due) : 0;
    var over = t.sum > t.due + 0.009;
    var after = r2(Math.max(0, t.due - t.sum));
    return `<div class="pay-sum" id="paySummary">Paying <b>${money(t.sum)}</b> now` +
      ` · Paid after <b>${money(r2(paidBefore + Math.min(t.sum, t.due)))}</b>` +
      (over
        ? ` · <span class="pay-sum-bad">${money(r2(t.sum - t.due))} more than the balance</span>`
        : ` · Balance after <b>${money(after)}</b>`) + `</div>`;
  }

  function payShellHTML() {
    var p = db.purchases.filter(function (x) { return x.id === payDraft.id; })[0];
    if (!p) return '';
    var sup = supplierById(p.supplierId);
    var dueAmt = payDueOf(p);
    var paidAmt = r2(Number(p.total || 0) - dueAmt);
    return `<form data-form="purchase-pay">
      <input type="hidden" name="id" value="${p.id}">
      <div class="note" style="margin-bottom:12px">
        <b>${esc(sup ? sup.name : 'Supplier')}</b><br>
        Total ${money(p.total)} · Paid ${money(paidAmt)} · Balance <b>${money(dueAmt)}</b>
      </div>
      <div class="field"><label>How you paid</label>
        <div id="payRows">${payRowsHTML()}</div>
        <button type="button" class="btn sm" data-act="pay-row-add" style="margin-top:8px">+ Add another method</button>
        <div class="sub" style="margin-top:6px">Split it if you like — part cash, part UPI, the rest on card.</div>
        ${paySummaryHTML()}
      </div>
      <div class="field"><label>Note (optional)</label><input class="inp" name="note" value="${esc(payDraft.note || '')}" placeholder="e.g. UPI reference"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Record payment</button></div></form>`;
  }

  function paySyncFromForm() {
    var form = document.querySelector('form[data-form="purchase-pay"]');
    if (!form || !payDraft) return;
    payDraft.rows.forEach(function (r, i) {
      var sel = form.querySelector('[name="pm' + i + '"]');
      var amt = form.querySelector('[name="pa' + i + '"]');
      if (sel) r.method = sel.value;
      if (amt) r.amount = amt.value;
    });
    var note = form.querySelector('[name="note"]');
    if (note) payDraft.note = note.value;
  }

  function payRowsRepaint() {
    var body = document.querySelector('#modalBody');
    if (!body || !payDraft) return;
    body.innerHTML = payShellHTML();
    var last = body.querySelector('[name="pa' + (payDraft.rows.length - 1) + '"]');
    if (last) { try { last.focus(); } catch (e) {} }
  }

  function payRowAdd() {
    paySyncFromForm();
    payDraft.rows.push({ method: PAY_METHODS[0], amount: '' });
    payRowsRepaint();
  }

  function payRowDel(i) {
    paySyncFromForm();
    if (payDraft.rows.length < 2) return;
    var removed = payDraft.rows.splice(i, 1)[0];
    payRowsRepaint();
    if (removed) toast(removed.method + ' line removed');
  }

  function purchasePayModal(id) {
    var p = db.purchases.filter(function (x) { return x.id === id; })[0];
    if (!p) return toast('Purchase not found');
    if (!(S.isOwner() || canPayPurchase())) return toast('You cannot record purchase payments');
    if (purchaseStatus(p) !== 'approved') return toast('Only approved purchases can be paid');
    var dueAmt = payDueOf(p);
    if (dueAmt <= 0.009) return toast('This purchase is already fully paid');
    payDraft = { id: p.id, rows: [{ method: 'Cash', amount: dueAmt }], note: '' };
    openModal('Pay ' + p.no, payShellHTML());
  }

  /* ----------------------------------------------------------------- damage */
  function viewDamage() {
    var all = db.damages.filter(function (d) { return d.branchId === ui.branch; })
      .slice().sort(function (a, b) {
        return String(b.date).localeCompare(String(a.date)) || (b.created || 0) - (a.created || 0);
      });
    var list = fApply('damage', all);
    var waiting = all.filter(function (d) { return !d.adjusted; });
    var loss = all.reduce(function (s, d) { return s + Number(d.costValue || 0); }, 0);
    var canSettle = can('damage.settle');
    return `<div class="dmg-page">
      <div class="page-head"><div><h2>Damage / loss</h2>
        <div class="sub">${esc(branchName(ui.branch))} · ${all.length} ${all.length === 1 ? 'entry' : 'entries'} · ${money(loss)} total${waiting.length ? ' · ' + waiting.length + ' not settled' : ''}</div></div>
        <div class="row-actions">${can('damage.entry') ? '<button class="btn primary" data-act="dmg-new">+ Record damage</button>' : ''}</div></div>
      ${fBar('damage')}
      ${waiting.length ? (canSettle
        ? `<div class="note dmg-note-bar" style="margin:12px 0">Tap <b>Settle</b> when the loss is sorted out — the quantity is then taken out of stock at that branch.</div>`
        : `<div class="note dmg-note-bar" style="margin:12px 0">Only the owner, or staff the owner has allowed, can settle a loss. Ask the owner to settle these.</div>`) : ''}
      ${list.length ? `<div class="table-wrap"><table class="data dmg-table"><thead><tr>
        <th>Date</th><th>What happened</th><th>Responsible</th><th class="num">Amount</th><th>Note</th><th>By</th><th>Status</th><th></th>
        </tr></thead><tbody>${list.map(function (d) {
          return `<tr><td class="dmg-date">${esc(fmtDate(d.date))}</td>
            <td class="dmg-what"><b>${esc(d.name || '—')}</b>${d.qty ? `<br><span class="sub">${d.adjust ? 'Change ' + (Number(d.stockMoved) > 0 ? '+' : '') + num(d.stockMoved) : 'Qty ' + num(d.qty)}</span>` : ''}</td>
            <td class="dmg-who${d.responsible ? '' : ' is-empty'}">${esc(d.responsible || '—')}</td>
            <td class="num dmg-amt">${money(d.costValue)}</td>
            <td class="dmg-note${d.reason ? '' : ' is-empty'}">${esc(d.reason || '—')}</td>
            <td class="dmg-by${d.byName ? '' : ' is-empty'}">${esc(d.byName || '—')}</td>
            <td class="dmg-st">${d.adjusted ? '<span class="badge ok">Settled</span>' : '<span class="badge warn">Pending</span>'}</td>
            <td class="dmg-acts" style="text-align:right;white-space:nowrap">${(!d.adjusted && canSettle)
              ? `<button class="btn sm primary" data-act="dmg-adjust" data-id="${d.id}">Settle</button> ` : ''}${canDeleteEntry('damage')
              ? `<button class="btn sm danger ghost" data-act="del-ask" data-kind="damage" data-id="${d.id}">Delete</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`
        : `<div class="empty"><b>${fOn('damage') ? 'No entries match' : 'No damage recorded'}</b>${fOn('damage') ? 'Try clearing a filter.' : 'Record a product damage or a service loss here — with who is responsible and the amount.'}</div>`}</div>`;
  }

  function damageItem(id, typed) {
    if (id) {
      var byId = itemById(id);
      if (byId) return byId;
    }
    var t = String(typed || '').trim().toLowerCase();
    if (!t) return null;
    var exact = db.items.filter(function (it) {
      return String(it.name || '').toLowerCase() === t || String(it.sku || '').toLowerCase() === t;
    })[0];
    if (exact) return exact;
    var fuzzy = db.items.filter(function (it) { return match(it.name, t) || match(it.sku, t); });
    return fuzzy.length === 1 ? fuzzy[0] : null;
  }

  function damageModal(prefill) {
    var pre = prefill || {};
    openModal('Record damage / loss', `<form data-form="damage">
      <div class="field"><label>What was damaged or lost</label>
        <input class="inp" name="itemName" placeholder="Product, transport, service…" autocomplete="off" required value="${esc(pre.name || '')}"></div>
      <div class="grid2">
        <div class="field"><label>Responsible person</label>
          <input class="inp" name="responsible" placeholder="Who is responsible" autocomplete="off" value="${esc(pre.responsible || '')}"></div>
        <div class="field"><label>Amount</label>
          <input class="inp" type="text" inputmode="decimal" name="amount" placeholder="0" value="${pre.amount != null && pre.amount !== '' ? pre.amount : ''}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Quantity (only if stock)</label>
          <input class="inp" type="text" inputmode="decimal" min="0" step="1" name="qty" value="1"></div>
        <div class="field"><label>Date</label><input class="inp" type="date" name="date" value="${today()}"></div>
      </div>
      <div class="field"><label>Branch</label><select class="inp" name="branchId">
        ${S.visibleBranches().map(function (b) { return `<option value="${b.id}"${b.id === ui.branch ? ' selected' : ''}>${esc(b.name)}</option>`; }).join('')}</select></div>
      <div class="field"><label>Note</label><input class="inp" name="reason" placeholder="What happened" value="${esc(pre.reason || '')}"></div>
      <div class="hint">Nothing is taken out of stock yet. Tap <b>Settle</b> on the list, once it is sorted out, and the quantity comes out of stock at that branch.</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div></form>`);
  }

  /* Stock adjustment: set the quantity actually counted at a branch with −1 /
     +1 or by typing it, and the item's stock moves by the difference. The
     change is kept as a settled entry, so the item history, the damage list
     and the cloud copy all show it, and deleting that entry puts the stock
     back the way it was. */
  function adjStockPreview() {
    var f = document.querySelector('form[data-form="stock-adjust"]');
    if (!f) return;
    var wasEl = f.querySelector('input[name="was"]');
    var cntEl = f.querySelector('input[name="counted"]');
    var hint = document.getElementById('adjStockHint');
    if (!wasEl || !cntEl || !hint) return;
    var was = Number(wasEl.value) || 0;
    var now = Number(cntEl.value);
    if (!isFinite(now) || now < 0) { hint.innerHTML = 'In stock now <b>' + num(was) + '</b>. Type 0 or more.'; return; }
    var d = r2(now - was);
    hint.innerHTML = 'In stock now <b>' + num(was) + '</b>. ' +
      (d ? 'Change ' + (d > 0 ? '+' : '−') + num(Math.abs(d)) + ' → <b>' + num(now) + '</b>' : 'Tap −1 or +1 to change it.');
  }

  function adjustStockModal(itemId) {
    var it = itemById(itemId);
    if (!it) return toast('Item not found');
    var branches = S.visibleBranches();
    if (!branches.length) return toast('No branch to adjust');
    var bid = ui.branch;
    if (!branches.some(function (b) { return b.id === bid; })) bid = branches[0].id;
    var have = r2(S.stockOf(it, bid));
    openModal('Adjust stock · ' + (it.name || 'Item'), `<form data-form="stock-adjust">
      <input type="hidden" name="id" value="${it.id}">
      <input type="hidden" name="was" value="${have}">
      <div class="field"><label>Branch</label><select class="inp" name="branchId">
        ${branches.map(function (b) { return `<option value="${b.id}"${b.id === bid ? ' selected' : ''}>${esc(b.name)} · ${num(S.stockOf(it, b.id))} in stock</option>`; }).join('')}</select></div>
      <div class="field"><label>Quantity in stock</label>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn" type="button" data-act="adj-step" data-val="-1" aria-label="One less">−1</button>
          <input class="inp" type="text" inputmode="numeric" step="1" min="0" name="counted" value="${have}" required autocomplete="off" data-input="adj-counted" style="flex:1;text-align:center">
          <button class="btn" type="button" data-act="adj-step" data-val="1" aria-label="One more">+1</button>
        </div>
      </div>
      <div class="hint" id="adjStockHint">${esc(branchName(bid))} has <b>${num(have)}</b> now. Tap −1 or +1, or type the count.</div>
      <div class="field"><label>Reason (optional)</label>
        <input class="inp" name="reason" placeholder="Stock count, damage, found stock…" autocomplete="off"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save adjustment</button>
      </div></form>`);
  }

  /* --------------------------------------------------------------- transfers */
  function otherBranches() { return db.branches.filter(function (b) { return b.id !== ui.branch; }); }

  function viewTransfers() {
    if (!ui.transfer) newTransfer();
    var tr = ui.transfer;
    if (!tr.to || !S.branchById(tr.to)) tr.to = (otherBranches()[0] || {}).id || '';
    var incoming = S.pendingTransfersFor(ui.branch);
    var history = db.transfers.slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
    var single = db.branches.length < 2;

    return `
      <div class="page-head"><div><h2>Stock transfers</h2>
        <div class="sub">Move stock between branches. Sending creates a request; the receiving branch accepts it.</div></div></div>

      <div class="section-title">Waiting to be accepted at ${esc(branchName(ui.branch))}</div>
      ${incoming.length ? `<div class="row-list">${incoming.map(function (t) {
        return `<div class="rrow">
          <div class="grow"><div class="title">${esc(t.no)} · from ${esc(branchName(t.from))}</div>
            <div class="sub">${t.lines.length} lines · requested by ${esc(t.byName || '—')} · ${esc(fmtDate(t.date))}</div></div>
          <div class="amt">
            <button class="btn sm" data-act="tr-view" data-id="${t.id}">Details</button>
            <button class="btn sm" data-act="tr-accept" data-id="${t.id}">Accept</button>
            <button class="btn sm danger" data-act="tr-reject" data-id="${t.id}">Reject</button>
          </div></div>`;
      }).join('')}</div>` : '<div class="empty"><b>Nothing pending</b>Transfers sent to this branch will appear here.</div>'}

      ${single ? '<div class="note" style="margin-top:16px">Add a second branch in Settings to move stock between branches.</div>' : `
      <div class="section-title">Send stock</div>
      <div class="card">
        <div class="grid2">
          <div class="field"><label>From</label><input class="inp" value="${esc(branchName(ui.branch))}" disabled></div>
          <div class="field"><label>To</label><select class="inp" data-change="tr-to">
            ${otherBranches().map(function (b) { return `<option value="${b.id}"${tr.to === b.id ? ' selected' : ''}>${esc(b.name)}</option>`; }).join('')}
          </select></div>
        </div>
        <div class="searchbox" style="margin-bottom:10px">${ico('search')}
          <input class="inp" data-input="tr-search" placeholder="Search items to send…" value="${esc(tr.q || '')}"></div>
        <div class="item-pick" id="trPick">${trPickHTML()}</div>
        ${tr.lines.length ? `<div style="margin-top:12px">${tr.lines.map(function (l, i) { return trLine(l, i); }).join('')}</div>` : ''}
        <div class="row-actions" style="margin-top:14px">
          <button class="btn" data-act="tr-clear">Clear</button>
          <button class="btn primary" data-act="tr-submit"${tr.lines.length ? '' : ' disabled'}>Send request</button>
        </div>
      </div>`}

      <div class="section-title">All transfers</div>
      ${history.length ? `<div class="table-wrap"><table class="data"><thead><tr>
        <th>Transfer</th><th>From</th><th>To</th><th>Date</th><th>Status</th><th>Accepted by</th><th></th>
        </tr></thead><tbody>${history.map(function (t) {
          var badge = t.status === 'accepted' ? '<span class="badge ok">Accepted</span>'
            : t.status === 'rejected' ? '<span class="badge bad">Rejected</span>' : '<span class="badge warn">Pending</span>';
          return `<tr><td><b>${esc(t.no)}</b><br><span class="sub">${t.lines.length} lines</span></td>
            <td>${esc(branchName(t.from))}</td><td>${esc(branchName(t.to))}</td>
            <td>${esc(fmtDate(t.date))}</td><td>${badge}</td>
            <td>${esc(t.acceptedBy || '—')}</td>
            <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-act="tr-view" data-id="${t.id}">Details</button>
              <button class="btn sm" data-act="tr-pdf" data-id="${t.id}">PDF</button></td></tr>`;
        }).join('')}</tbody></table></div>`
        : '<div class="empty"><b>No transfers yet</b>Requests you send will be listed here.</div>'}`;
  }

  function trPickHTML() {
    var q = String((ui.transfer && ui.transfer.q) || '').trim();
    if (!q) return '';
    var list = db.items.filter(function (it) {
      return stockOf(it) > 0 && (match(it.name, q) || match(it.sku, q) || match(it.category, q));
    }).slice(0, 20);
    if (!list.length) return '<div class="empty" style="border:0;background:transparent"><b>No match</b>Nothing in stock matches that search.</div>';
    return list.map(function (it) {
      return `<button type="button" data-act="tr-add-item" data-id="${it.id}">
        <span class="grow"><span class="nm">${esc(it.name)}</span><br>
        <span class="meta">${esc(it.sku || '—')} · ${num(stockOf(it))} available</span></span>
        <span class="pr">Add</span></button>`;
    }).join('');
  }
  function trLine(l, i) {
    var it = itemById(l.itemId);
    var max = it ? stockOf(it) + (l.qty || 0) : 0;
    return `<div class="tline"><div><div class="nm">${esc(l.name)}</div>
      <div class="meta">max ${num(max)} from ${esc(branchName(ui.branch))}</div></div>
      <div class="ctl"><input type="text" inputmode="decimal" min="1" step="1" data-input="tr-qty" data-id="${i}" value="${l.qty}">
        <button class="btn sm icon" data-act="tr-remove" data-id="${i}" aria-label="Remove">✕</button></div></div>`;
  }

  /* -------------------------------------------------------------------- items */

  /* -------------------------------------------------------------- complaints */
  /* A complaint is raised by staff against a product, usually with the customer
     bill attached. The owner links the supplier, marks it resolved and then
     settles it. Days pending is always visible. */

  function cmpById(id) { return (db.complaints || []).filter(function (c) { return c.id === id; })[0] || null; }

  function cmpDayDiff(from, to) {
    var a = new Date(String(from || '') + 'T00:00:00');
    var b = new Date(String(to || '') + 'T00:00:00');
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
    return Math.max(0, Math.round((b - a) / 86400000));
  }

  function cmpDays(c) {
    if (!c) return 0;
    if (c.resolvedDate) return cmpDayDiff(c.date, c.resolvedDate);
    if (c.status === 'settled' && c.settledDate) return cmpDayDiff(c.date, c.settledDate);
    return cmpDayDiff(c.date, today());
  }

  function cmpOpen(c) { return (c.status || 'open') === 'open'; }

  function cmpDaysText(c) {
    var d = cmpDays(c);
    var word = d === 1 ? 'day' : 'days';
    if (cmpOpen(c)) return d + ' ' + word + ' pending';
    return 'closed in ' + d + ' ' + word;
  }

  function cmpBadge(c) {
    if (c.status === 'settled') return '<span class="badge ok">Settled</span>';
    if (c.status === 'resolved') return '<span class="badge ok">Resolved</span>';
    return '<span class="badge warn">Pending</span>';
  }

  function cmpList() {
    var all = (db.complaints || []).slice();
    if (!S.canSeeAllBranches()) all = all.filter(function (c) { return c.branchId === ui.branch; });
    return all.sort(function (a, b) {
      var oa = cmpOpen(a) ? 0 : 1, ob = cmpOpen(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return String(b.date).localeCompare(String(a.date)) || (b.created || 0) - (a.created || 0);
    });
  }

  function viewComplaints() {
    var all = cmpList();
    var open = all.filter(cmpOpen);
    var oldest = open.reduce(function (m, c) { return Math.max(m, cmpDays(c)); }, 0);
    var f = ui.cmpFilter || 'all';
    var list = all.filter(function (c) {
      if (f === 'open') return cmpOpen(c);
      if (f === 'resolved') return c.status === 'resolved';
      if (f === 'settled') return c.status === 'settled';
      return true;
    });
    var chip = function (key, label, count) {
      return '<button type="button" class="' + (f === key ? 'on' : '') + '" data-act="cmp-filter" data-id="' + key + '">' +
        label + (count ? ' ' + count : '') + '</button>';
    };
    var head = open.length
      ? open.length + ' pending' + (oldest ? ' · oldest ' + oldest + ' ' + (oldest === 1 ? 'day' : 'days') : '')
      : 'Nothing pending';

    return `
      <div class="page-head"><div><h2>Complaints</h2>
        <div class="sub">${esc(head)} · ${all.length} in total</div></div>
        <div class="row-actions"><button class="btn primary" data-act="cmp-new">+ New complaint</button></div></div>
      <div class="rep-chips">
        ${chip('all', 'All', all.length)}${chip('open', 'Pending', open.length)}
        ${chip('resolved', 'Resolved')}${chip('settled', 'Settled')}
      </div>
      ${list.length ? `<div class="cmp-list">${list.map(function (c) {
        var openC = cmpOpen(c);
        var sub = [esc(c.no || ''), c.invoiceNo ? esc(c.invoiceNo) : '', esc(c.customerName || 'Walk-in')]
          .filter(Boolean).join(' · ');
        return `<button type="button" class="cmp-row" data-act="cmp-open" data-id="${c.id}">
          <span class="cmp-days${openC ? ' on' : ''}"><b>${cmpDays(c)}</b><i>${openC ? 'days' : 'closed'}</i></span>
          <span class="grow"><b>${esc(c.itemName || 'Product')}${c.qty ? ` <span class="q">× ${num(c.qty)}</span>` : ''}</b>
            <span class="sub">${sub}${c.supplierName ? ' · ' + esc(c.supplierName) : ''}</span></span>
          <span class="cmp-right">${cmpBadge(c)}<span class="cmp-date">${esc(fmtDate(c.date))}</span>${c.byName ? `<span class="cmp-by">by ${esc(c.byName)}</span>` : ''}</span>
          <span class="dash-go">›</span>
        </button>`;
      }).join('')}</div>`
        : `<div class="empty"><b>${f === 'all' ? 'No complaints yet' : 'Nothing in this list'}</b>${f === 'all'
          ? 'Staff can raise a complaint about a product and attach the customer bill.'
          : 'Try another filter.'}</div>`}`;
  }

  /* Search lists for the new-complaint form. Rows keep a hidden search text
     (name, phone, bill no) so the picker can be filtered by typing. */
  var cmpPick = { invoice: [], item: [] };

  function cmpPickRows(kind) {
    if (kind === 'invoice') {
      return db.invoices.filter(function (i) { return i.branchId === ui.branch; })
        .slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); }).slice(0, 200)
        .map(function (i) {
          var c = findCust(i.customerId);
          var nm = c ? c.name : 'Walk-in';
          var ph = c && c.phone ? String(c.phone) : '';
          return {
            id: i.id,
            label: i.no + ' · ' + nm + (ph ? ' · ' + ph : '') + ' · ' + money(i.total) + ' · ' + fmtDate(i.date),
            search: [i.no, nm, ph, c && c.email ? c.email : '', fmtDate(i.date), i.total].join(' ').toLowerCase()
          };
        });
    }
    return db.items.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
      .map(function (it) {
        return {
          id: it.id,
          label: it.name + (it.sku ? ' · ' + it.sku : ''),
          search: [it.name, it.sku || '', it.unit || ''].join(' ').toLowerCase()
        };
      });
  }

  function cmpMatches(row, term) {
    if (!term) return true;
    var parts = String(term).toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) if (row.search.indexOf(parts[i]) < 0) return false;
    return true;
  }

  function cmpOptionsHTML(kind, term, keep) {
    var rows = (cmpPick[kind] || []).filter(function (r) { return cmpMatches(r, term); });
    var html = kind === 'invoice' ? '<option value="">No bill linked</option>' : '';
    if (!rows.length) {
      return html + '<option value="">' + (kind === 'invoice' ? 'No bill matches that search' : 'No product matches that search') + '</option>';
    }
    return html + rows.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === keep ? ' selected' : '') + '>' + esc(r.label) + '</option>';
    }).join('');
  }

  /* A bill only knows the products it actually sold, so once a bill is picked
     the product list stays inside that bill. */
  function cmpItemsForBill(inv, keepId) {
    var all = cmpPickRows('item');
    var allowed = all;
    if (inv) {
      var ids = {};
      (inv.lines || []).forEach(function (l) { if (l.itemId) ids[l.itemId] = true; });
      var picked = all.filter(function (r) { return ids[r.id]; });
      if (picked.length) allowed = picked;
    }
    if (keepId && !allowed.some(function (r) { return r.id === keepId; })) {
      var keepRow = all.filter(function (r) { return r.id === keepId; })[0];
      if (keepRow) allowed = [keepRow].concat(allowed);
    }
    return { rows: allowed, all: all };
  }

  function cmpBillChanged(invoiceId) {
    var inv = invoiceId ? invById(invoiceId) : null;
    var pickedRows = cmpItemsForBill(inv);
    var allowed = pickedRows.rows;
    var all = pickedRows.all;
    cmpPick.item = allowed;
    var searchEl = document.querySelector('[data-input="cmp-q-item"]');
    if (searchEl) searchEl.value = '';
    var sel = document.querySelector('[data-cmp-sel="item"]');
    if (sel) sel.innerHTML = cmpOptionsHTML('item', '', allowed[0] ? allowed[0].id : '');
    var hint = document.querySelector('[data-cmp-hint="item"]');
    if (hint) {
      hint.textContent = (inv && allowed !== all)
        ? 'Showing ' + allowed.length + ' product' + (allowed.length === 1 ? '' : 's') + ' from ' + inv.no
        : 'Search by product name or code.';
    }
  }

  function cmpSearchInput(kind, term) {
    var k = kind === 'invoice' ? 'invoice' : 'item';
    var sel = document.querySelector('[data-cmp-sel="' + k + '"]');
    if (!sel) return;
    var t = String(term || '').trim();
    var rows = (cmpPick[k] || []).filter(function (r) { return cmpMatches(r, t); });
    var keep = sel.value;
    var keepOk = rows.some(function (r) { return r.id === keep; });
    if (!keepOk) keep = k === 'item' && rows.length ? rows[0].id : '';
    sel.innerHTML = cmpOptionsHTML(k, t, keep);
    var hint = document.querySelector('[data-cmp-hint="' + k + '"]');
    if (hint) {
      hint.textContent = t
        ? (rows.length ? rows.length + (rows.length === 1 ? ' result' : ' results') : 'Nothing found — try a shorter word')
        : (k === 'invoice' ? 'Optional. Search by customer name, phone or bill number.' : 'Search by product name or code.');
    }
  }

  function complaintModal() {
    if (!db.items.length) {
      openModal('New complaint', `<div class="empty" style="border:0;background:transparent">
          <b>No products yet</b>A complaint is always about a product, so your item list is empty.
          Add at least one product in <b>Items &amp; stock</b> and come back here.</div>
        <div class="row-actions" style="justify-content:flex-end;margin-top:12px">
          <button class="btn" type="button" data-act="close-modal">Close</button>
          <button class="btn primary" type="button" data-act="cmp-go-items">Open Items &amp; stock</button>
        </div>`);
      return;
    }
    cmpPick.invoice = cmpPickRows('invoice');
    cmpPick.item = cmpPickRows('item');
    openModal('New complaint', `<form data-form="complaint">
      <div class="field"><label>Customer bill</label>
        <input class="inp" type="search" data-input="cmp-q-inv" placeholder="Search customer name, phone or bill no." autocomplete="off">
        <select class="inp" name="invoiceId" data-cmp-sel="invoice" data-change="cmp-inv" style="margin-top:8px">${cmpOptionsHTML('invoice', '', '')}</select>
        <div class="hint" data-cmp-hint="invoice">Optional. Search by customer name, phone or bill number.</div></div>
      <div class="field"><label>Product</label>
        <input class="inp" type="search" data-input="cmp-q-item" placeholder="Search product name or code" autocomplete="off">
        <select class="inp" name="itemId" data-cmp-sel="item" required style="margin-top:8px">${cmpOptionsHTML('item', '', '')}</select>
        <div class="hint" data-cmp-hint="item">Search by product name or code.</div></div>
      <div class="grid2">
        <div class="field"><label>Quantity</label><input class="inp" type="text" inputmode="decimal" name="qty" value="1"></div>
        <div class="field"><label>Date raised</label><input class="inp" type="date" name="date" value="${today()}"></div>
      </div>
      <div class="field"><label>What is the problem?</label>
        <textarea class="inp" name="problem" rows="3" placeholder="Rice packet was wet / smell / customer returned it…" required></textarea></div>
      <div class="field"><label>Branch</label><select class="inp" name="branchId">
        ${S.visibleBranches().map(function (b) { return '<option value="' + b.id + '"' + (b.id === ui.branch ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('')}
      </select></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Raise complaint</button>
      </div></form>`);
  }

  function cmpCanEdit(c) {
    if (!c) return false;
    var me = S.currentStaff();
    return !!(S.isOwner() || (me && c.staffId === me.id));
  }

  function complaintEditModal(id) {
    var c = cmpById(id);
    if (!c) return;
    if (!cmpCanEdit(c)) return toast('Only the owner or the person who raised it can edit');
    if (c.status === 'settled') return toast('Settled complaints cannot be edited');
    if (!db.items.length) return toast('Add a product first');
    cmpPick.invoice = cmpPickRows('invoice');
    var inv = c.invoiceId ? invById(c.invoiceId) : null;
    var rows = cmpItemsForBill(inv, c.itemId);
    cmpPick.item = rows.rows;
    var filtered = !!inv && rows.rows.length !== rows.all.length;
    openModal('Edit complaint ' + (c.no || ''), `<form data-form="complaint-edit">
      <input type="hidden" name="cmpId" value="${c.id}">
      <div class="field"><label>Customer bill</label>
        <input class="inp" type="search" data-input="cmp-q-inv" placeholder="Search customer name, phone or bill no." autocomplete="off">
        <select class="inp" name="invoiceId" data-cmp-sel="invoice" data-change="cmp-inv" style="margin-top:8px">${cmpOptionsHTML('invoice', '', c.invoiceId)}</select>
        <div class="hint" data-cmp-hint="invoice">Optional. Search by customer name, phone or bill number.</div></div>
      <div class="field"><label>Product</label>
        <input class="inp" type="search" data-input="cmp-q-item" placeholder="Search product name or code" autocomplete="off">
        <select class="inp" name="itemId" data-cmp-sel="item" required style="margin-top:8px">${cmpOptionsHTML('item', '', c.itemId)}</select>
        <div class="hint" data-cmp-hint="item">${filtered ? 'Showing ' + rows.rows.length + ' product' + (rows.rows.length === 1 ? '' : 's') + ' from ' + esc(inv.no) : 'Search by product name or code.'}</div></div>
      <div class="grid2">
        <div class="field"><label>Quantity</label><input class="inp" type="text" inputmode="decimal" name="qty" value="${esc(String(Number(c.qty) || 1))}"></div>
        <div class="field"><label>Date raised</label><input class="inp" type="date" name="date" value="${esc(c.date || today())}"></div>
      </div>
      <div class="field"><label>What is the problem?</label>
        <textarea class="inp" name="problem" rows="3" required>${esc(c.problem || '')}</textarea></div>
      <div class="field"><label>Branch</label><select class="inp" name="branchId">
        ${S.visibleBranches().map(function (b) { return '<option value="' + b.id + '"' + (b.id === c.branchId ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('')}
      </select></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save changes</button>
      </div></form>`);
  }

  function complaintDetailModal(id) {
    var c = cmpById(id);
    if (!c) return;
    var owner = S.isOwner();
    var meDetail = S.currentStaff();
    var role = (S.currentStaff() || {}).role;
    var canResolve = owner || role === 'manager';
    var sup = db.suppliers.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    var supOpts = '<option value="">No supplier linked</option>' + sup.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === c.supplierId ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
    var line = function (k, v) {
      return `<div class="dash-row"><span class="grow">${esc(k)}</span><span class="val">${v}</span></div>`;
    };

    openModal('Complaint ' + (c.no || ''), `
      <div class="dash-list" style="margin-bottom:12px">
        ${line('Product', '<b>' + esc(c.itemName || '—') + '</b>' + (c.qty ? ' × ' + num(c.qty) : ''))}
        ${line('Customer', esc(c.customerName || 'Walk-in'))}
        ${line('Bill', esc(c.invoiceNo || '—'))}
        ${line('Raised on', esc(fmtDate(c.date)))}
        ${line(cmpOpen(c) ? 'Pending for' : 'Closed in', esc(cmpDaysText(c)))}
        ${line('Raised by', esc(c.byName || '—'))}
        ${c.editedAt ? line('Edited', esc(fmtDate(new Date(c.editedAt).toISOString().slice(0, 10))) + (c.editedByName ? ' · ' + esc(c.editedByName) : '')) : ''}
        ${line('Status', cmpBadge(c))}
        ${line('Supplier', esc(c.supplierName || '—'))}
        ${c.resolvedDate ? line('Resolved on', esc(fmtDate(c.resolvedDate)) + (c.resolvedByName ? ' · ' + esc(c.resolvedByName) : '')) : ''}
        ${c.settledDate ? line('Settled on', esc(fmtDate(c.settledDate)) + (c.settledByName ? ' · ' + esc(c.settledByName) : '')) : ''}
      </div>
      <div class="field"><label>Problem</label>
        <div class="note" style="white-space:pre-wrap">${esc(c.problem || '—')}</div></div>

      ${owner ? `<form data-form="complaint-supplier" style="margin-top:12px">
        <input type="hidden" name="cmpId" value="${c.id}">
        <div class="field"><label>Link a supplier</label>
          <select class="inp" name="supplierId">${supOpts}</select></div>
        <div class="grid2">
          <div class="field"><label>Supplier name (if not in list)</label>
            <input class="inp" name="supplierName" value="${esc(c.supplierId ? '' : (c.supplierName || ''))}" placeholder="Type a name"></div>
          <div class="field"><label>Note for the supplier</label>
            <input class="inp" name="supplierNote" value="${esc(c.supplierNote || '')}" placeholder="Replacement promised…"></div>
        </div>
        <div class="row-actions" style="justify-content:flex-end">
          <button class="btn" type="submit">Save supplier</button>
        </div></form>` : ''}

      <div class="row-actions" style="justify-content:flex-end;margin-top:16px;flex-wrap:wrap;gap:8px">
        <button class="btn" type="button" data-act="close-modal">Close</button>
        ${(owner || (meDetail && c.staffId === meDetail.id)) && c.status !== 'settled' ? `<button class="btn" type="button" data-act="cmp-edit" data-id="${c.id}">Edit</button>` : ''}
        ${cmpOpen(c) && canResolve ? `<button class="btn primary" type="button" data-act="cmp-resolve" data-id="${c.id}">Mark resolved</button>` : ''}
        ${c.status === 'resolved' && owner ? `<button class="btn primary" type="button" data-act="cmp-settle" data-id="${c.id}">Settle complaint</button>` : ''}
        ${!cmpOpen(c) && owner ? `<button class="btn" type="button" data-act="cmp-reopen" data-id="${c.id}">Reopen</button>` : ''}
        ${owner ? `<button class="btn danger" type="button" data-act="del-ask" data-kind="complaint" data-id="${c.id}">Delete</button>` : ''}
      </div>`);
  }

  function complaintSubmit(kind, data) {
    if (kind === 'complaint-edit') {
      var ce = cmpById(data.cmpId);
      if (!ce) return toast('Complaint not found');
      if (!cmpCanEdit(ce)) return toast('Only the owner or the person who raised it can edit');
      if (ce.status === 'settled') return toast('Settled complaints cannot be edited');
      var itE = itemById(data.itemId);
      if (!itE) return toast('Pick the product');
      var probE = String(data.problem || '').trim();
      if (!probE) return toast('Write what the problem is');
      var invE = data.invoiceId ? invById(data.invoiceId) : null;
      var custE = invE && invE.customerId ? findCust(invE.customerId) : null;
      var meE = S.currentStaff();
      ce.itemId = itE.id; ce.itemName = itE.name;
      ce.qty = Math.max(1, Number(data.qty) || 1);
      ce.date = data.date || ce.date;
      ce.problem = probE;
      ce.invoiceId = invE ? invE.id : ''; ce.invoiceNo = invE ? invE.no : '';
      ce.customerId = custE ? custE.id : ''; ce.customerName = custE ? custE.name : '';
      ce.branchId = data.branchId || ce.branchId;
      ce.editedAt = Date.now(); ce.editedByName = meE ? meE.name : '';
      logActivity('Complaint ' + ce.no + ' edited', 'complaint');
      save(); closeModal(); render();
      return toast('Complaint ' + ce.no + ' updated');
    }

    if (kind === 'complaint-supplier') {
      if (!S.isOwner()) return toast('Only the owner can link a supplier');
      var c0 = cmpById(data.cmpId);
      if (!c0) return toast('Complaint not found');
      var sup = data.supplierId ? supplierById(data.supplierId) : null;
      var typed = String(data.supplierName || '').trim();
      c0.supplierId = sup ? sup.id : '';
      c0.supplierName = sup ? sup.name : typed;
      c0.supplierNote = String(data.supplierNote || '').trim();
      logActivity('Complaint ' + c0.no + ' · supplier ' + (c0.supplierName || 'cleared'), 'complaint');
      save(); closeModal(); render();
      return toast(c0.supplierName ? 'Supplier linked' : 'Supplier cleared');
    }

    var it = itemById(data.itemId);
    if (!it) return toast('Pick the product');
    var problem = String(data.problem || '').trim();
    if (!problem) return toast('Write what the problem is');
    var qty = Math.max(1, Number(data.qty) || 1);
    var inv = data.invoiceId ? invById(data.invoiceId) : null;
    var cust = inv && inv.customerId ? findCust(inv.customerId) : null;
    var me = S.currentStaff();
    var n = Number(db.ccomp) || 1;
    db.ccomp = n + 1;
    var no = 'CMP-' + n;
    db.complaints.push({
      id: uid(), no: no, date: data.date || today(), created: Date.now(),
      branchId: data.branchId || ui.branch,
      staffId: me ? me.id : '', byName: me ? me.name : '',
      itemId: it.id, itemName: it.name, qty: qty,
      invoiceId: inv ? inv.id : '', invoiceNo: inv ? inv.no : '',
      customerId: cust ? cust.id : '', customerName: cust ? cust.name : '',
      problem: problem, status: 'open',
      supplierId: '', supplierName: '', supplierNote: '',
      resolvedDate: '', resolvedByName: '', settledDate: '', settledByName: '', settleNote: ''
    });
    logActivity('Complaint ' + no + ' · ' + it.name + (cust ? ' · ' + cust.name : '') + ' — ' + problem.slice(0, 60), 'complaint');
    save(); closeModal(); render();
    return toast('Complaint ' + no + ' raised');
  }

  function complaintAction(action, id) {
    if (!can('complaints')) { closeModal(); return toast('You do not have access to complaints'); }
    if (action === 'cmp-filter') {
      ui.cmpFilter = id;
      return render();
    }
    if (action === 'cmp-new') return complaintModal();
    if (action === 'cmp-go-items') { closeModal(); return go('items'); }
    if (action === 'cmp-open') return complaintDetailModal(id);
    if (action === 'cmp-edit') return complaintEditModal(id);

    var c = cmpById(id);
    if (!c) return;

    if (action === 'cmp-resolve') {
      var role = (S.currentStaff() || {}).role;
      if (!(S.isOwner() || role === 'manager')) return toast('Only the owner or manager can resolve');
      if (!cmpOpen(c)) return toast('Already resolved');
      if (!confirm('Mark complaint ' + c.no + ' as resolved?')) return;
      c.status = 'resolved';
      c.resolvedDate = today();
      c.resolvedByName = (S.currentStaff() || {}).name || '';
      logActivity('Complaint ' + c.no + ' resolved', 'complaint');
      save(); closeModal(); render();
      return toast('Resolved — ' + cmpDays(c) + ' days');
    }

    if (action === 'cmp-settle') {
      if (!S.isOwner()) return toast('Only the owner can settle');
      if (c.status !== 'resolved') return toast('Mark it resolved first');
      if (!confirm('Settle complaint ' + c.no + '?\n\nSupplier: ' + (c.supplierName || 'not linked') + '\nThis closes the complaint.')) return;
      c.status = 'settled';
      c.settledDate = today();
      c.settledByName = (S.currentStaff() || {}).name || '';
      logActivity('Complaint ' + c.no + ' settled', 'complaint');
      save(); closeModal(); render();
      return toast('Complaint settled');
    }

    if (action === 'cmp-reopen') {
      if (!S.isOwner()) return toast('Only the owner can reopen');
      c.status = 'open'; c.resolvedDate = ''; c.resolvedByName = '';
      c.settledDate = ''; c.settledByName = '';
      logActivity('Complaint ' + c.no + ' reopened', 'complaint');
      save(); closeModal(); render();
      return toast('Complaint reopened');
    }

    if (action === 'cmp-del') {
      return toast('Complaints cannot be deleted — settle the complaint instead');
    }
  }

  /* Owner can watch one branch or every branch here */
  function itmAllOn() { return S.isOwner() && !!ui.itmAll && db.branches.length > 1; }
  function itmScopeHTML() {
    if (!S.isOwner() || db.branches.length < 2) return '';
    return `<div class="cust-chips itm-scope">
      <button type="button" class="cust-chip${ui.itmAll ? ' on' : ''}" data-act="item-scope" data-id="all" aria-pressed="${ui.itmAll ? 'true' : 'false'}">All branches</button>
      <span class="itm-scope-note">${ui.itmAll ? 'Every branch combined' : esc(branchName(ui.branch)) + ' only'}</span>
    </div>`;
  }
  function itmTotalsHTML() {
    if (!S.isOwner()) return '';
    var totalQty = 0, totalAmt = 0;
    db.items.forEach(function (it) {
      var q = S.totalStock(it);
      totalQty = r2(totalQty + q);
      totalAmt = r2(totalAmt + r2(q * (Number(it.cost) || 0)));
    });
    return `<div class="itm-total-bar" aria-label="Total item values">
      <span class="itm-total-left">All branches Every branch combined</span>
      <span class="itm-total-right">${num(totalQty)} - ${money(totalAmt)}</span>
    </div>`;
  }

  function viewItems() {
    var open = ui.itemOpen ? itemById(ui.itemOpen) : null;
    if (open) return viewItemDetail(open);
    var st = fState('items'), n = fCount('items'), qv = st[fQKey('items')] || '';
    return `<div class="cust-page itm-page">
      <div class="cust-top">
        <h2 class="cust-title">Items <span class="cust-count">${db.items.length}</span></h2>
        <button type="button" class="cust-add" data-act="item-new">+ Add item</button>
      </div>
      <div class="cust-search">${ico('search')}
        <input class="inp" data-input="f-q" data-view="items" placeholder="Search name, SKU or category"
          value="${esc(qv)}" autocomplete="off" aria-label="Search items">
      </div>
      <div class="cust-chips">
        <button type="button" class="cust-chip${n ? ' on' : ''}" data-act="f-open" data-view="items">
          Filters${n ? ' · ' + n : ''}
        </button>
        ${(n || qv) ? `<button type="button" class="cust-chip" data-act="f-clear" data-view="items">Clear</button>` : ''}
      </div>
      ${st.open ? fPanelHTML('items') : ''}
      ${fChipsHTML('items')}
      ${itmScopeHTML()}
      ${itmTotalsHTML()}
      <div id="itemsList">${itemListHTML()}</div>
    </div>`;
  }

  function itemListHTML() {
    var list = fApply('items', db.items);
    if (!db.items.length) return `<div class="empty"><b>No items yet</b>Add your first item to start billing.</div>`;
    if (!list.length) return `<div class="empty"><b>No items match</b>Try another search or clear a filter.</div>`;
    return `<div class="cust-list itm-list">${list.map(function (it) {
      var scopeAll = itmAllOn();
      var here = scopeAll ? S.totalStock(it) : stockOf(it), re = Number(it.reorder) || 0, all = S.totalStock(it);
      var low = here <= re;
      var out = here <= 0;
      var sub = [it.sku, it.category].filter(Boolean).join(' · ') || 'No SKU';
      return `<div class="cust-row itm-row" data-act="item-open" data-id="${it.id}" tabindex="0" role="button">
        <span class="cust-main">
          <span class="cust-name">${esc(it.name)}</span>
          <span class="cust-sub">${esc(sub)}</span>
        </span>
        <span class="itm-meta">
          <span class="itm-stock${out ? ' out' : low ? ' low' : ''}">${num(here)} ${scopeAll ? 'total' : 'in stock'}</span>
          <span class="itm-price">${money(it.price)}</span>
        </span>
        <button type="button" class="cust-dots" data-act="item-more" data-id="${it.id}" aria-label="Actions for ${esc(it.name)}">⋮</button>
        ${ui.itemMore === it.id ? `<div class="cust-menu cust-rowmenu">
          <button type="button" data-act="item-edit" data-id="${it.id}">Edit</button>
          <button type="button" data-act="item-adjust" data-id="${it.id}">Adjust</button>
          <button type="button" class="danger" data-act="del-ask" data-kind="item" data-id="${it.id}">Delete</button>
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  /* Sortable time for a movement: the stored timestamp, or the date at midnight. */
  function evTime(date, created) {
    var t = Number(created) || 0;
    if (t) return t;
    var p = Date.parse(String(date || '') + 'T00:00:00');
    return isNaN(p) ? 0 : p;
  }

  function itemHistory(it) {
    var ev = [];
    (db.invoices || []).forEach(function (inv) {
      (inv.lines || []).forEach(function (l) {
        if (l.itemId !== it.id) return;
        var c = findCust(inv.customerId);
        var q = Number(l.qty || 0);
        ev.push({ date: inv.date, created: inv.created || 0, at: evTime(inv.date, inv.created), type: 'Sale', ref: inv.no,
          branches: [inv.branchId], moves: [{ branch: inv.branchId, delta: -q }],
          detail: (c ? c.name : 'Walk-in') + ' · ' + branchName(inv.branchId),
          qty: -q, amt: money(q * (Number(l.price)||0)) });
      });
    });
    (db.sreturns || []).forEach(function (r) {
      (r.lines || []).forEach(function (l) {
        if (l.itemId !== it.id) return;
        var c = findCust(r.customerId);
        var q = Number(l.qty || 0);
        ev.push({ date: r.date, created: r.created || 0, at: evTime(r.date, r.created), type: 'Sale return', ref: r.no,
          branches: [r.branchId], moves: [{ branch: r.branchId, delta: q }],
          detail: (c ? c.name : 'Walk-in') + ' · ' + branchName(r.branchId),
          qty: q, amt: money(q * (Number(l.price)||0)) });
      });
    });
    (db.purchases || []).forEach(function (p) {
      var pending = (typeof purchaseStatus === 'function') && purchaseStatus(p) === 'pending';
      (p.lines || []).forEach(function (l) {
        if (l.itemId !== it.id) return;
        var sup = supplierById(p.supplierId);
        var q = Number(l.qty || 0);
        /* Stock only lands on approval. Older records may have no per-branch alloc. */
        var alloc = (l.alloc && Object.keys(l.alloc).length) ? l.alloc
          : (p.branchId ? (function () { var o = {}; o[p.branchId] = q; return o; })() : {});
        var moves = [], brs = [];
        if (!pending) Object.keys(alloc).forEach(function (b) {
          moves.push({ branch: b, delta: Number(alloc[b]) || 0 }); brs.push(b);
        });
        ev.push({ date: p.date, created: p.created || 0, at: evTime(p.date, p.created), type: 'Purchase', ref: p.no, pid: p.id,
          branches: brs.length ? brs : [p.branchId], moves: moves,
          detail: (sup ? sup.name : 'Supplier') + (pending ? ' · waiting for approval' : ''),
          qty: q, amt: money(q * (Number(l.cost)||0)), pending: pending });
      });
    });
    (db.preturns || []).forEach(function (r) {
      if (r.itemId !== it.id) return;
      var sup = supplierById(r.supplierId);
      var q = Number(r.qty || 0);
      ev.push({ date: r.date, created: r.created || 0, at: evTime(r.date, r.created), type: 'Purchase return', ref: r.no,
        branches: [r.branchId], moves: [{ branch: r.branchId, delta: -q }],
        detail: (sup ? sup.name : 'Supplier') + ' · ' + branchName(r.branchId),
        qty: -q, amt: money(Number(r.total || 0)) });
    });
    (db.damages || []).forEach(function (d) {
      if (d.itemId !== it.id) return;
      var moved = (d.stockMoved != null) ? (Number(d.stockMoved) || 0) : (d.adjusted ? -Number(d.qty || 0) : 0);
      ev.push({ date: d.date, created: d.created || 0, at: evTime(d.date, d.created),
        type: d.adjust ? 'Stock adjustment' : (d.adjusted ? 'Damage (adjusted)' : 'Damage (pending)'),
        ref: d.reason || 'Damage', branches: [d.branchId],
        moves: moved ? [{ branch: d.branchId, delta: moved }] : [],
        detail: branchName(d.branchId) + (moved ? (moved < 0 ? ' · stock reduced' : ' · stock added') : (d.adjusted ? '' : ' · not adjusted yet')),
        qty: moved, amt: money(Number(d.costValue || 0)),
        note: d.adjusted ? '' : (num(d.qty) + ' recorded') });
    });
    (db.transfers || []).forEach(function (t) {
      if (t.status === 'rejected') return;
      var movedAt = Number(t.acceptedAt) || evTime(t.date, t.created);
      (t.lines || []).forEach(function (l) {
        if (l.itemId !== it.id) return;
        var q = Number(l.qty || 0);
        if (t.status === 'accepted') {
          /* Each side belongs to its own branch only, so a branch's stock
             history shows the movement that happened there (in at the
             receiving branch, out at the sending one) instead of both. */
          ev.push({ date: t.date, created: (t.created||0)+1, at: movedAt + 1, type: 'Transfer in', ref: t.no, trId: t.id,
            branches: [t.to], moves: [{ branch: t.to, delta: q }],
            detail: 'From ' + branchName(t.from) + ' to ' + branchName(t.to),
            qty: q, amt: '' });
          ev.push({ date: t.date, created: t.created||0, at: movedAt, type: 'Transfer out', ref: t.no, trId: t.id,
            branches: [t.from], moves: [{ branch: t.from, delta: -q }],
            detail: 'From ' + branchName(t.from) + ' to ' + branchName(t.to),
            qty: -q, amt: '' });
        } else if (t.status === 'pending') {
          ev.push({ date: t.date, created: t.created||0, at: movedAt, type: 'Transfer (pending)', ref: t.no, trId: t.id,
            branches: [t.from, t.to], moves: [], pendingQty: q,
            detail: 'From ' + branchName(t.from) + ' to ' + branchName(t.to),
            qty: 0, amt: '', note: num(l.qty) + ' requested' });
        }
      });
    });
    ev.sort(function (a,b) { return String(b.date||'').localeCompare(String(a.date||'')) || (b.created||0)-(a.created||0); });
    return ev;
  }

  /* Replays the item's stock movements oldest→newest and attaches the
     quantity held before and after each one. The balance is anchored on the
     stock held today, so the numbers always reconcile with the item page. */
  function applyStockFlow(it, events) {
    var net = {}, opening = {}, bal = {};
    db.branches.forEach(function (b) { net[b.id] = 0; });
    (events || []).forEach(function (e) {
      (e.moves || []).forEach(function (m) {
        net[m.branch] = r2((net[m.branch] || 0) + (Number(m.delta) || 0));
      });
    });
    db.branches.forEach(function (b) {
      opening[b.id] = r2(S.stockOf(it, b.id) - (net[b.id] || 0));
      bal[b.id] = opening[b.id];
    });
    (events || []).slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); })
      .forEach(function (e) {
        if (!e.moves || !e.moves.length) return;
        e.flow = {};
        e.moves.forEach(function (m) {
          var before = (bal[m.branch] == null) ? 0 : bal[m.branch];
          var after = r2(before + (Number(m.delta) || 0));
          if (e.flow[m.branch]) e.flow[m.branch].after = after;
          else e.flow[m.branch] = { before: before, after: after };
          bal[m.branch] = after;
        });
      });
    return events || [];
  }

  /* "12 → 9" for the branches this row affects, labelled when needed. */
  function flowText(flow, branchIds, forceLabel) {
    if (!flow) return '';
    var keys = Object.keys(flow).filter(function (b) { return branchIds.indexOf(b) >= 0; });
    return keys.map(function (b) {
      var fl = flow[b];
      var label = (forceLabel || keys.length > 1) ? esc(branchName(b)) + ' stock ' : '';
      return label + num(fl.before) + ' → ' + num(fl.after);
    }).join(' · ');
  }

  function viewItemDetail(it) {
    var showCost = can('profit.view');
    var scopeAll = itmAllOn();
    var here = scopeAll ? S.totalStock(it) : stockOf(it), all = S.totalStock(it), re = Number(it.reorder) || 0;
    var low = here <= re, out = here <= 0;
    var f = ui.itemHist || 'all';
    var hist = applyStockFlow(it, itemHistory(it)).filter(function (e) {
      return scopeAll || !e.branches || e.branches.indexOf(ui.branch) >= 0;
    });
    var histF = hist.filter(function (e) {
      if (f === 'all') return true;
      if (f === 'sale') return e.type === 'Sale' || e.type === 'Sale return';
      if (f === 'purchase') return e.type === 'Purchase' || e.type === 'Purchase return';
      if (f === 'damage') return e.type.indexOf('Damage') === 0 || e.type === 'Stock adjustment';
      if (f === 'transfer') return e.type.indexOf('Transfer') === 0;
      return true;
    });
    var chips = [['all','All'],['sale','Sales'],['purchase','Purchases'],['damage','Damage'],['transfer','Transfers']];
    return `<div class="cust-page itm-page">
      <div class="itm-detail-head">
        <button type="button" class="itm-head-btn itm-back-btn" data-act="item-back" aria-label="Back to items">
          <span class="itm-head-ic" aria-hidden="true">←</span><span>Back</span>
        </button>
        <div class="grow"></div>
        <div class="itm-head-actions">
          <button type="button" class="itm-head-btn itm-edit-btn" data-act="item-edit" data-id="${it.id}">
            <span class="itm-head-ic" aria-hidden="true">✎</span><span>Edit</span>
          </button>
          <button type="button" class="itm-head-btn itm-adjust-btn" data-act="item-adjust" data-id="${it.id}">
            <span class="itm-head-ic" aria-hidden="true">±</span><span>Adjust</span>
          </button>
        </div>
      </div>
      <div class="grid2" style="margin:10px 0">
        <div class="card">
          <div class="sub">Item name</div>
          <div class="itm-name">${esc(it.name)}</div>
          <div class="sub" style="margin-top:2px">${esc([it.sku, it.category].filter(Boolean).join(' · ') || 'No SKU or category')}</div>
          <div class="sub" style="margin-top:12px">Price</div>
          <div class="itm-stat">${money(it.price)}</div>
          ${showCost ? `<div class="sub" style="margin-top:6px">Cost ${money(it.cost||0)}</div>` : ''}
        </div>
        <div class="card"><div class="sub">${scopeAll ? 'Stock · all branches' : 'Stock here · ' + esc(branchName(ui.branch))}</div>
          <div class="itm-stat ${out ? 'bad' : low ? 'warn' : ''}">${num(here)} ${out ? '<span class="cust-tag" style="margin-left:6px">Out</span>' : low ? '<span class="cust-tag" style="margin-left:6px;color:#b45309">Low</span>' : ''}</div>
          <div class="sub" style="margin-top:6px">${scopeAll ? db.branches.length + ' branches · Reorder at ' + num(re) : 'All branches ' + num(all) + ' · Reorder at ' + num(re)}</div></div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="sub" style="margin-bottom:8px">Stock by branch</div>
        <div class="itm-branches">${db.branches.map(function(b){
          return `<div class="itm-br"><span>${esc(b.name)}</span><b>${num(S.stockOf(it,b.id))}</b></div>`;
        }).join('')}</div>
      </div>
      ${itmScopeHTML()}
      <div class="section-title">History${scopeAll ? ' · all branches' : ' · ' + esc(branchName(ui.branch))}</div>
      <div class="cust-chips" style="margin-bottom:10px">
        ${chips.map(function(c){
          return `<button type="button" class="cust-chip${f===c[0]?' on':''}" data-act="item-hist" data-val="${c[0]}">${c[1]}</button>`;
        }).join('')}
      </div>
      ${histF.length ? `<div class="cust-list itm-hist">${histF.map(function(e){
        var qcls = e.qty > 0 ? 'pos' : e.qty < 0 ? 'neg' : '';
        var qtxt = e.qty > 0 ? '+'+num(e.qty) : e.qty < 0 ? num(e.qty) : (e.note || '—');
        var openable = e.type === 'Purchase' && e.pid;
        var subBits = [esc(fmtDate(e.date))];
        if (scopeAll && e.type === 'Purchase' && e.branches && e.branches[0]) subBits.push(esc(branchName(e.branches[0])));
        if (e.detail) subBits.push(esc(e.detail));
        e.sub = subBits.join(' · ');
        /* Show the stock this movement started from and left behind, so a
           transfer or a stock inward reads as "12 → 9" not just "-3". */
        var showFlow = e.type === 'Transfer in' || e.type === 'Transfer out' ||
          e.type === 'Purchase' || e.type === 'Purchase return';
        var flTxt = showFlow ? flowText(e.flow, scopeAll ? (e.branches || []) : [ui.branch], true) : '';
        if (e.type === 'Transfer (pending)') {
          var pt = db.transfers.filter(function (x) { return x.id === e.trId; })[0];
          if (pt && S.branchById(pt.from) && S.branchById(pt.to)) {
            var pq = Number(e.pendingQty) || 0, pf = S.stockOf(it, pt.from), pto = S.stockOf(it, pt.to);
            e.flow = {};
            e.flow[pt.from] = { before: pf, after: r2(pf - pq) };
            e.flow[pt.to] = { before: pto, after: r2(pto + pq) };
            flTxt = flowText(e.flow, scopeAll ? [pt.from, pt.to] : [ui.branch], true) + ' after accept';
          }
        }
        return `<div class="cust-row itm-hrow${openable ? ' itm-hrow-link' : ''}"${openable ? ` data-act="purchase-view" data-id="${e.pid}" tabindex="0" role="button"` : ''}>
          <span class="cust-main">
            <span class="cust-name">${esc(e.type)}${e.ref ? ' · ' + esc(e.ref) : ''}</span>
            <span class="cust-sub">${e.sub}</span>
            ${flTxt ? `<span class="cust-sub itm-flow">${flTxt}</span>` : ''}
          </span>
          <span class="itm-meta">
            <span class="itm-qty ${qcls}">${esc(qtxt)}</span>
            ${e.amt ? `<span class="cust-sub">${esc(e.amt)}</span>` : ''}
          </span>
        </div>`;
      }).join('')}</div>` : `<div class="empty"><b>No history yet</b>${f==='all' ? (scopeAll ? 'Sales, purchases, returns, damage and transfers from every branch will appear here.' : 'Sales, purchases, returns, damage and transfers for ' + esc(branchName(ui.branch)) + ' will appear here.') : 'No entries in this filter.'}</div>`}
    </div>`;
  }

  /* ---------------------------------------------------------------- customers */
  /* Parties page: customers and suppliers live together under two tabs */
  function canSeeSuppliers() { return S.isOwner() || can('purchases'); }

  function partyTabsHTML(active) {
    if (!canSeeSuppliers()) return '';
    var tab = function (id, label, n) {
      return `<button type="button" class="party-tab${active === id ? ' on' : ''}" data-act="party-tab" data-val="${id}" role="tab" aria-selected="${active === id ? 'true' : 'false'}">${label} <b>${n}</b></button>`;
    };
    return `<div class="party-tabs" role="tablist">
      ${tab('customers', 'Customers', db.customers.length)}
      ${tab('suppliers', 'Suppliers', db.suppliers.length)}
    </div>`;
  }

  function supplierStats(s) {
    var list = (db.purchases || []).filter(function (p) {
      return p.supplierId === s.id && (typeof purchaseStatus !== 'function' || purchaseStatus(p) === 'approved');
    });
    var total = 0, paid = 0, todayHit = false, monthHit = false;
    var t0 = today(), m0 = t0.slice(0, 7);
    list.forEach(function (p) {
      total += Number(p.total || 0);
      var pd = typeof p.paid === 'number' ? p.paid : (p.paid ? Number(p.total || 0) : 0);
      paid += pd;
      if (p.date === t0) todayHit = true;
      if (String(p.date || '').slice(0, 7) === m0) monthHit = true;
    });
    return { total: r2(total), paid: r2(paid), due: r2(Math.max(0, total - paid)), count: list.length, today: todayHit, month: monthHit };
  }

  function supDigits(phone) {
    var dg = String(phone || '').replace(/[^0-9]/g, '');
    if (!dg) return '';
    if (dg.length === 10) return '91' + dg;
    if (dg.length === 11 && dg.charAt(0) === '0') return '91' + dg.slice(1);
    return dg;
  }

  function supplierListHTML() {
    var sq = String(ui.supQ || '').trim();
    var f = ui.supFilter || 'all';
    var rows = db.suppliers.filter(function (x) {
      return !sq || match(x.name, sq) || match(x.phone, sq) || match(x.email, sq) || match(x.address, sq);
    }).map(function (s) {
      return { s: s, st: supplierStats(s) };
    }).filter(function (r) {
      if (f === 'pending') return r.st.due > 0.009;
      if (f === 'paid') return r.st.count > 0 && r.st.due <= 0.009;
      if (f === 'today') return r.st.today;
      if (f === 'month') return r.st.month;
      return true;
    }).sort(function (a, b) { return String(a.s.name).localeCompare(String(b.s.name)); });
    if (!rows.length) {
      var msg = (sq || f !== 'all') ? 'No suppliers match' : 'No suppliers yet';
      var hint = (sq || f !== 'all') ? 'Try another name or filter.' : 'Add the businesses you buy stock from.';
      return `<div class="empty"><b>${msg}</b>${hint}</div>`;
    }
    return `<div class="cust-list sup-list">${rows.map(function (r) {
      var s = r.s, st = r.st;
      var sub = [s.phone, s.email].filter(Boolean).join(' · ') || 'No phone or email saved';
      var right = st.due > 0.009
        ? `<b class="purch-amt sup-due">${money(st.due)}</b><span class="cust-sub">due</span>`
        : (st.count ? '<span class="cust-sub">All paid</span>' : '<span class="cust-sub">No purchases</span>');
      return `<div class="cust-row" data-act="sup-ledger" data-id="${s.id}" tabindex="0" role="button">
        <span class="cust-main">
          <span class="cust-name">${esc(s.name)}</span>
          <span class="cust-sub">${esc(sub)}</span>
        </span>
        <span class="itm-meta">${right}</span>
        <button type="button" class="cust-dots" data-act="sup-menu" data-id="${s.id}" aria-label="Actions for ${esc(s.name)}">⋮</button>
        ${ui.supMenu === s.id ? `<div class="cust-menu cust-rowmenu">
          ${s.phone ? `<button type="button" data-act="sup-call" data-id="${s.id}">Call</button>` : ''}
          ${s.phone ? `<button type="button" data-act="sup-wa" data-id="${s.id}">WhatsApp</button>` : ''}
          <button type="button" data-act="supplier-edit" data-id="${s.id}">Edit</button>
          ${canDeleteEntry('supplier') ? `<button type="button" class="danger" data-act="del-ask" data-kind="supplier" data-id="${s.id}">Delete</button>` : ''}
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function viewSuppliers() {
    var f = ui.supFilter || 'all';
    var chips = [['all', 'All'], ['pending', 'Pending'], ['paid', 'Paid'], ['today', 'Today'], ['month', 'Month']];
    return `<div class="cust-page">
      ${partyTabsHTML('suppliers')}
      <div class="cust-top">
        <h2 class="cust-title">Suppliers <span class="cust-count">${db.suppliers.length}</span></h2>
        ${can('purchases') ? '<button type="button" class="cust-add" data-act="supplier-new">+ Add</button>' : ''}
      </div>
      <div class="cust-search">${ico('search')}
        <input class="inp" data-input="q-sup" placeholder="Search name, phone or email" value="${esc(ui.supQ || '')}"
          autocomplete="off" aria-label="Search suppliers">
      </div>
      <div class="cust-chips">
        ${chips.map(function (x) {
          return `<button type="button" class="cust-chip${f === x[0] ? ' on' : ''}" data-act="sup-filter" data-val="${x[0]}">${x[1]}</button>`;
        }).join('')}
      </div>
      <div style="margin-top:10px">${supplierListHTML()}</div>
    </div>`;
  }

  function viewCustomers() {
    var open = ui.custOpen ? findCust(ui.custOpen) : null;
    if (open) return viewCustomerDetail(open);
    if (ui.partyTab === 'suppliers' && canSeeSuppliers()) return viewSuppliers();
    var fst = fState('customers'), fn = fCount('customers');
    return `<div class="cust-page">
      ${partyTabsHTML('customers')}
      <div class="cust-top">
        <h2 class="cust-title">Customers <span class="cust-count">${db.customers.length}</span></h2>
        <button type="button" class="cust-add" data-act="cust-new">+ Add</button>
      </div>
      <div class="cust-search">${ico('search')}
        <input class="inp" data-input="q-cust" placeholder="Search name or number" value="${esc(ui.qCust || '')}"
          autocomplete="off" aria-label="Search customers">
      </div>
      <div class="cust-chips">
        ${[['all', 'All'], ['due', 'Due'], ['settled', 'Settled']].map(function (x) {
          var on = (ui.custFilter || 'all') === x[0];
          return `<button type="button" class="cust-chip${on ? ' on' : ''}" data-act="cust-filter" data-val="${x[0]}">${x[1]}</button>`;
        }).join('')}
        <button type="button" class="cust-chip${fn ? ' on' : ''}" data-act="f-open" data-view="customers">Filters${fn ? ' · ' + fn : ''}</button>
        ${fn ? `<button type="button" class="cust-chip" data-act="f-clear" data-view="customers">Clear</button>` : ''}
        <div class="cust-sortwrap">
          <button type="button" class="cust-sort" data-act="cust-sort-menu" aria-label="Sort customers" aria-expanded="${ui.custSortMenu ? 'true' : 'false'}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 12h10M10 17h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          ${ui.custSortMenu ? `<div class="cust-menu cust-sortmenu">
            ${[['name', 'Name (A–Z)'], ['due', 'Highest due'], ['bills', 'Most bills']].map(function (o) {
              var on = (ui.custSort || 'name') === o[0];
              return `<button type="button" class="${on ? 'on' : ''}" data-act="cust-sort" data-val="${o[0]}">
                <span>${o[1]}</span>${on ? '<b>✓</b>' : ''}</button>`;
            }).join('')}
          </div>` : ''}
        </div>
      </div>
      ${fst.open ? fPanelHTML('customers') : ''}
      ${fChipsHTML('customers')}
      <div id="custList">${custListHTML()}</div>
    </div>`;
  }

  function custList() {
    var q = String(ui.qCust || '').trim().toLowerCase();
    var f = ui.custFilter || 'all';
    var sort = ui.custSort || 'name';
    var bills = function (c) { return db.invoices.filter(function (i) { return i.customerId === c.id; }).length; };
    var list = fApply('customers', db.customers).filter(function (c) {
      var due = custDue(c.id);
      if (f === 'due' && due <= 0.009) return false;
      if (f === 'settled' && due > 0.009) return false;
      if (!q) return true;
      return [c.name, c.phone, c.email, c.address].join(' ').toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (sort === 'due') return custDue(b.id) - custDue(a.id) || String(a.name).localeCompare(String(b.name));
      if (sort === 'bills') return bills(b) - bills(a) || String(a.name).localeCompare(String(b.name));
      return String(a.name).localeCompare(String(b.name));
    });
    return list;
  }

  function custListHTML() {
    var list = custList();
    if (!db.customers.length) return `<div class="empty"><b>No customers</b>Add a customer to track bills and dues.</div>`;
    if (!list.length) return `<div class="empty"><b>No customers match</b>Try another name, number or filter.</div>`;
    return `<div class="cust-list">${list.map(function (c) {
      var due = custDue(c.id);
      var many = db.invoices.some(function (i) { return i.customerId === c.id; });
      var sub = c.phone || c.email || c.address || 'No phone saved';
      return `<div class="cust-row" data-act="cust-open" data-id="${c.id}" tabindex="0" role="button">
        <span class="cust-main">
          <span class="cust-name">${esc(c.name)}</span>
          <span class="cust-sub">${esc(sub)}</span>
        </span>
        <span class="cust-side">
          ${due > 0.009 ? `<span class="cust-amt">${money(due)}</span>`
            : (many ? '<span class="cust-tag">Settled</span>' : '')}
          <button type="button" class="cust-dots" data-act="cust-more" data-id="${c.id}"
            aria-label="Actions for ${esc(c.name)}">⋮</button>
        </span>
        ${ui.custMore === c.id ? `<div class="cust-menu cust-rowmenu">
          ${c.phone ? `<button type="button" data-act="cust-call" data-id="${c.id}">Call</button>
          <button type="button" data-act="cust-wa" data-id="${c.id}">WhatsApp</button>` : ''}
          <button type="button" data-act="cust-open" data-id="${c.id}">Bill history</button>
          <button type="button" data-act="cust-edit" data-id="${c.id}">Edit</button>
          <button type="button" class="danger" data-act="del-ask" data-kind="customer" data-id="${c.id}">Delete</button>
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  function viewCustomerDetail(c) {
    var byDate = function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || (b.created || 0) - (a.created || 0);
    };
    var bills = db.invoices.filter(function (i) { return i.customerId === c.id; }).slice().sort(byDate);
    var rets = db.sreturns.filter(function (r) { return r.customerId === c.id; }).slice().sort(byDate);
    var billed = bills.reduce(function (s2, i) { return s2 + Number(i.total || 0); }, 0);
    var paid = bills.reduce(function (s2, i) { return s2 + Number(i.paid || 0); }, 0);
    var due = r2(billed - paid);
    var retTotal = rets.reduce(function (s2, r) { return s2 + Number(r.total || 0); }, 0);
    var last = bills[0];
    var items = bills.reduce(function (s2, i) { return s2 + (i.lines || []).length; }, 0);

    return `
      <div class="page-head"><div>
        <button class="btn sm ghost" data-act="cust-back">← All customers</button>
        <h2 style="margin-top:10px">${esc(c.name)}</h2>
        <div class="sub">${esc(c.phone || 'no phone')}${c.email ? ' · ' + esc(c.email) : ''}${c.address ? ' · ' + esc(c.address) : ''}</div></div>
        <div class="row-actions">
          ${due > 0.009 ? `<button class="btn sm primary" data-act="dues-open" data-id="${c.id}">Receive payment</button>` : ''}
          ${due > 0.009 && c.phone ? `<a class="btn sm" href="${reminderLink(c, due)}" target="_blank" rel="noopener">Send reminder</a>` : ''}
          <button class="btn sm" data-act="cust-edit" data-id="${c.id}">Edit</button>
          <button class="btn sm danger" data-act="del-ask" data-kind="customer" data-id="${c.id}">Delete</button>
        </div></div>

      <div class="kpi-grid">
        <div class="kpi"><div class="k">Bills</div><div class="v">${bills.length}</div>
          <div class="sub">${last ? 'Last on ' + esc(fmtDate(last.date)) : 'No bills yet'}</div></div>
        <div class="kpi"><div class="k">Total billed</div><div class="v">${money(billed)}</div>
          <div class="sub">${items} item line${items === 1 ? '' : 's'}</div></div>
        <div class="kpi"><div class="k">Paid</div><div class="v ok">${money(paid)}</div>
          <div class="sub">Across all bills</div></div>
        <div class="kpi"><div class="k">Due</div><div class="v ${due > 0.009 ? 'bad' : ''}">${money(Math.max(0, due))}</div>
          <div class="sub">${due > 0.009 ? 'Open balance' : 'All settled'}</div></div>
      </div>

      ${rets.length ? `<div class="note" style="margin-top:12px">${rets.length} return${rets.length === 1 ? '' : 's'} recorded for this customer · ${money(retTotal)} credited back.</div>` : ''}

      <div class="section-title">Bill history</div>
      ${bills.length ? `<div class="hist-list">${bills.map(function (i) {
        var iDue = r2(i.total - i.paid);
        var badge = iDue <= 0.009 ? '<span class="badge ok">Paid</span>'
          : i.paid > 0 ? `<span class="badge warn">Due ${money(iDue)}</span>` : '<span class="badge bad">Unpaid</span>';
        return `<button type="button" class="hist-row" data-act="inv-view" data-id="${i.id}">
          <span class="hist-main"><b>${esc(i.no)}</b>
            <span class="sub">${esc(fmtDate(i.date))} · ${(i.lines || []).length} item${(i.lines || []).length === 1 ? '' : 's'} · ${esc(i.method || 'Cash')}</span></span>
          <span class="hist-amt"><b>${money(i.total)}</b>${badge}</span>
          <span class="hist-go">View PDF</span></button>`;
      }).join('')}</div>`
        : '<div class="empty"><b>No bills yet</b>Bills made for this customer will be listed here.</div>'}

      <div class="section-title">Returns</div>
      ${rets.length ? `<div class="hist-list">${rets.map(function (r) {
        var inv2 = invById(r.invoiceId);
        return `<button type="button" class="hist-row" data-act="${inv2 ? 'inv-view' : 'noop'}" data-id="${inv2 ? inv2.id : ''}">
          <span class="hist-main"><b>${esc(r.no)}</b>
            <span class="sub">${esc(fmtDate(r.date))}${inv2 ? ' · bill ' + esc(inv2.no) : ''} · ${(r.lines || []).map(function (l) { return esc(l.name) + ' ×' + num(l.qty); }).join(', ')}</span></span>
          <span class="hist-amt"><b>− ${money(r.total)}</b><span class="badge warn">Refunded</span></span>
          <span class="hist-go">${inv2 ? 'View bill' : ''}</span></button>`;
      }).join('')}</div>`
        : '<div class="empty"><b>No returns</b>Nothing has been sent back by this customer.</div>'}

      <div class="hint" style="margin-top:12px">Tap a bill to open it as a PDF-style preview — from there you can share the PDF, send it on WhatsApp, download or print it.</div>`;
  }

  /* ----------------------------------------------------------------- expenses */
  var EXP_CATS = ['Rent', 'Salary', 'Electricity', 'Water', 'Transport', 'Supplies', 'Maintenance', 'Marketing', 'Other'];
  function viewExpenses() {
    var all = branchExpenses().slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var list = fApply('expenses', all);
    var total = all.reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var monthTotal = all.filter(function (x) { return x.date >= S.monthStart(); })
      .reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var monthPaid = all.filter(function (x) { return x.date >= S.monthStart(); })
      .reduce(function (s, x) { return s + expPaidOf(x); }, 0);
    var monthDue = all.reduce(function (s, x) { return s + expDueOf(x); }, 0);
    return `<div class="cust-page exp-page">
      <div class="cust-top">
        <h2 class="cust-title">Expenses <span class="cust-count">${all.length}</span></h2>
        ${can('expense.edit') ? '<button type="button" class="cust-add" data-act="exp-new">+ Add expense</button>' : ''}
      </div>
      <div class="sub" style="margin-bottom:10px">${esc(branchName(ui.branch))} · ${money(monthPaid)} paid this month${monthDue > 0.009 ? ' · <b style="color:#dc2626">' + money(monthDue) + ' balance</b>' : ''} · ${money(total)} recorded</div>
      ${fBar('expenses')}
      <div id="expTable">${expTable(list)}</div>
    </div>`;
  }
  function expTable(list) {
    if (!list.length) return `<div class="empty"><b>${fOn('expenses') ? 'No expenses match' : 'No expenses'}</b>${fOn('expenses') ? 'Try clearing a filter.' : 'Record rent, salaries, bills and other costs here.'}</div>`;
    return `<div class="cust-list exp-list">${list.map(function (x) {
      var st = staffById(x.staffId);
      var paid = expPaidOf(x), due = expDueOf(x);
      var sub = esc(fmtDate(x.date)) + (paid > 0 && x.method ? ' · Paid by ' + esc(x.method) : '') + (st ? ' · ' + esc(st.name) : '');
      if (x.note) sub += ' · ' + esc(x.note);
      if (due > 0.009) sub += ' · Paid ' + money(paid);
      return `<div class="cust-row exp-row">
        <span class="cust-main">
          <span class="cust-name">${esc(x.category || 'Expense')}</span>
          <span class="cust-sub">${sub}</span>
        </span>
        <span class="inv-meta">
          <span class="inv-amt">${money(x.amount)}</span>
          ${due > 0.009 ? `<span class="inv-due due">Balance ${money(due)}</span>` : `<span class="inv-due paid">Paid</span>`}
        </span>
        ${can('expense.edit') ? `<button type="button" class="cust-dots" data-act="exp-more" data-id="${x.id}" aria-label="Actions for expense">⋮</button>
        ${ui.expMore === x.id ? `<div class="cust-menu cust-rowmenu">
          <button type="button" data-act="exp-edit" data-id="${x.id}">${due > 0.009 ? 'Pay / Edit' : 'Edit'}</button>
          <button type="button" data-act="del-ask" data-kind="expense" data-id="${x.id}">Delete</button>
        </div>` : ''}` : ''}
      </div>`;
    }).join('')}</div>`;
  }

  /* ------------------------------------------------------------------ reports */
  function viewReports() {
    var from = ui.rep.from || today(), to = ui.rep.to || today();
    /* the report reads one branch or, with All branches, every branch at once */
    if (ui.rep.branch == null) ui.rep.branch = 'all';
    var sc = ui.rep.branch;
    if (sc !== 'all' && !S.branchById(sc)) sc = 'all';
    ui.rep.branch = sc;
    var scopeName = sc === 'all' ? 'All branches' : branchName(sc);
    var scopeInvoices = function () { return sc === 'all' ? db.invoices.slice() : branchInvoices(sc); };
    var scopeExpenses = function () { return sc === 'all' ? db.expenses.slice() : branchExpenses(sc); };
    var inv = scopeInvoices().filter(function (i) { return i.date >= from && i.date <= to; });
    var sales = 0, tax = 0, cost = 0, disc = 0;
    inv.forEach(function (i) {
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      sales += t.taxable; tax += t.tax; cost += t.cost; disc += t.discount;
    });
    var gross = r2(sales - cost);
    var exp = scopeExpenses().filter(function (x) { return x.date >= from && x.date <= to; });
    var expTotal = exp.reduce(function (s, x) { return s + Number(x.amount || 0); }, 0);
    var purch = db.purchases.filter(function (p) { return p.date >= from && p.date <= to; })
      .reduce(function (s, p) {
        return s + p.lines.reduce(function (n, l) {
          var share = sc === 'all' ? allocTotal(l) : (Number(l.alloc && l.alloc[sc]) || 0);
          return n + share * (Number(l.cost) || 0);
        }, 0);
      }, 0);
    var sret = db.sreturns.filter(function (r) { return (sc === 'all' || r.branchId === sc) && r.date >= from && r.date <= to; })
      .reduce(function (s, r) { return s + r.total; }, 0);
    var dmgTotal = db.damages.filter(function (d) { return (sc === 'all' || d.branchId === sc) && d.date >= from && d.date <= to; })
      .reduce(function (s, d) { return s + Number(d.costValue || 0); }, 0);
    var net = r2(gross - expTotal - dmgTotal);
    var showProfit = can('profit.view');

    /* actual sale for a line = (price × qty − item discount) minus this line's
       share of the bill discount */
    var lineSale = function (t, l) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      var ld = Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
      var base = r2(ls - ld);
      if (!t) return base;
      var afterLine = Math.max(0, r2((t.subtotal || 0) - (t.lineDisc != null ? t.lineDisc : 0)));
      var billDisc = (t.billDisc != null ? t.billDisc : (t.discount || 0));
      if (!afterLine || !billDisc) return base;
      return r2(base - (billDisc * base / afterLine));
    };
    var lineCost = function (l) {
      var c = Number(l.cost) || 0;
      if (!c && l.itemId) {
        var it = itemById(l.itemId);
        c = (it && Number(it.cost)) || 0;
      }
      return r2((Number(l.qty) || 0) * c);
    };

    var byBill = inv.map(function (i) {
      var c = findCust(i.customerId);
      return { no: i.no, date: i.date, cust: c ? c.name : 'Walk-in', linked: linkedExpenseShare(i), profit: billProfit(i) };
    }).sort(function (a, b) { return b.profit - a.profit; }).slice(0, 10);

    var byDay = {};
    inv.forEach(function (i) {
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      if (!byDay[i.date]) byDay[i.date] = { n: 0, total: 0, profit: 0 };
      byDay[i.date].n++; byDay[i.date].total += i.total; byDay[i.date].profit += (t.taxable - t.cost);
    });
    var days = Object.keys(byDay).sort().reverse();

    var byItem = {};
    inv.forEach(function (i) {
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      i.lines.forEach(function (l) {
        var k = l.itemId || l.name;
        if (!byItem[k]) byItem[k] = { name: l.name, qty: 0, revenue: 0, profit: 0 };
        var sale = lineSale(t, l);
        byItem[k].qty += Number(l.qty) || 0;
        byItem[k].revenue += sale;
        byItem[k].profit += sale - lineCost(l);
      });
    });
    var allItems = Object.keys(byItem).map(function (k) { return byItem[k]; });
    var top = allItems.slice().sort(function (a, b) { return b.revenue - a.revenue; }).slice(0, 6);
    var byQty = allItems.slice().sort(function (a, b) { return b.qty - a.qty; }).slice(0, 5);
    var byProfit = allItems.slice().sort(function (a, b) { return b.profit - a.profit; }).slice(0, 5);
    var byItemCat = {};
    inv.forEach(function (i) {
      var t = S.compute(i.lines, i.discount, i.taxRate, invoiceCharges(i), { roundOff: (typeof i.roundOff === 'number' ? i.roundOff : 0) });
      i.lines.forEach(function (l) {
        var it = itemById(l.itemId);
        var cat = (it && it.category) || 'Uncategorised';
        if (!byItemCat[cat]) byItemCat[cat] = { revenue: 0, profit: 0, qty: 0 };
        var sale = lineSale(t, l);
        byItemCat[cat].revenue += sale;
        byItemCat[cat].profit += sale - lineCost(l);
        byItemCat[cat].qty += Number(l.qty) || 0;
      });
    });
    var catRows = Object.keys(byItemCat).map(function (k) {
      return { name: k, revenue: byItemCat[k].revenue, profit: byItemCat[k].profit, qty: byItemCat[k].qty };
    }).sort(function (a, b) { return b.revenue - a.revenue; });

    var soldIds = {};
    inv.forEach(function (i) { i.lines.forEach(function (l) { if (l.itemId) soldIds[l.itemId] = (soldIds[l.itemId] || 0) + Number(l.qty || 0); }); });
    var hereStock = function (it) { return sc === 'all' ? S.totalStock(it) : stockOf(it, sc); };
    var slow = db.items.filter(function (it) { return hereStock(it) > 0 && (soldIds[it.id] || 0) <= 1; })
      .map(function (it) { return { name: it.name, qty: hereStock(it), value: r2(hereStock(it) * (it.cost || 0)), sold: soldIds[it.id] || 0 }; })
      .sort(function (a, b) { return b.value - a.value; }).slice(0, 5);

    var mStart = S.monthStart();
    var lastStart = (function () {
      var d = new Date(mStart + 'T00:00:00'); d.setMonth(d.getMonth() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01';
    })();
    var lastEnd = (function () {
      var d = new Date(mStart + 'T00:00:00'); d.setDate(0);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    var thisM = scopeInvoices().filter(function (i) { return i.date >= mStart && i.date <= today(); });
    var lastM = scopeInvoices().filter(function (i) { return i.date >= lastStart && i.date <= lastEnd; });
    var sumOf = function (list) { return list.reduce(function (a, i) { return a + Number(i.total || 0); }, 0); };
    var thisSales = r2(sumOf(thisM)), lastSales = r2(sumOf(lastM));
    var delta = lastSales > 0 ? Math.round((thisSales - lastSales) / lastSales * 100) : (thisSales > 0 ? 100 : 0);
    var emiBills = inv.filter(isEmiBill);
    var emiSales = r2(emiBills.reduce(function (a, i) { return a + Number(i.total || 0); }, 0));
    var emiMonthly = r2(emiBills.reduce(function (a, i) { return a + Number((i.emi && i.emi.monthly) || 0); }, 0));
    var scDues = custDues(sc);
    var owed = r2(scDues.reduce(function (a, r) { return a + r.due; }, 0));
    var oweSup = r2(db.suppliers.reduce(function (a, sp) { return a + Math.max(0, lgBalance('suppliers', sp.id)); }, 0));
    var oweCount = scDues.length;

    var byCat = {};
    exp.forEach(function (x) { byCat[x.category] = (byCat[x.category] || 0) + Number(x.amount || 0); });

    var secHead = function (label, sub) {
      return '<div class="dash-sec"><h3>' + label + (sub ? ' <span class="dash-sec-sub">' + sub + '</span>' : '') + '</h3></div>';
    };
    var row = function (name, sub, val, cls) {
      return '<div class="dash-row rep-row"><span class="grow"><b>' + esc(name) + '</b>' +
        (sub ? '<span class="sub">' + sub + '</span>' : '') + '</span>' +
        '<span class="val ' + (cls || '') + '">' + val + '</span></div>';
    };
    var list = function (rows, empty) {
      return '<div class="dash-list">' + (rows || '<div class="dash-empty">' + empty + '</div>') + '</div>';
    };

    var backDate = function (n) {
      var x = new Date(); x.setDate(x.getDate() - n);
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    };
    var isToday = from === today() && to === today();
    var is7 = from === backDate(6) && to === today();
    var is30 = from === backDate(29) && to === today();
    var isMonth = from === S.monthStart() && to === today();
    var chip = function (days, label, on) {
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-act="rep-range" data-days="' + days + '">' + label + '</button>';
    };

    var strip = [
      { k: 'Sales', v: money(sales) },
      showProfit ? { k: 'Gross profit', v: money(gross), bad: gross < 0 } : null,
      { k: 'Expenses', v: money(expTotal), bad: expTotal > 0 },
      { k: 'Damage', v: money(dmgTotal), bad: dmgTotal > 0 }
    ].filter(Boolean);

    var headline = showProfit
      ? '<div class="k">Net profit</div><div class="v' + (net < 0 ? ' bad-v' : '') + '">' + money(net) + '</div>'
      : '<div class="k">Sales (excl. tax)</div><div class="v">' + money(sales) + '</div>';

    return `
      <div class="rep-top">
        <div><h2>Reports</h2>
          <div class="sub">${esc(scopeName)} · ${esc(fmtDate(from))} to ${esc(fmtDate(to))} · ${inv.length} bill${inv.length === 1 ? '' : 's'}</div></div>
      </div>
      <div class="rep-chips">
        ${chip('today', 'Today', isToday)}${chip('7', '7 days', is7)}${chip('30', '30 days', is30)}${chip('month', 'This month', isMonth)}
      </div>
      <div class="rep-dates">
        <label><span>Branch</span><select class="inp" data-change="rep-branch" aria-label="Report branch">
          <option value="all"${sc === 'all' ? ' selected' : ''}>All branches</option>
          ${S.visibleBranches().map(function (b) {
            return `<option value="${b.id}"${b.id === sc ? ' selected' : ''}>${esc(b.name)}</option>`;
          }).join('')}
        </select></label>
        <label><span>From</span><input class="inp" type="date" data-input="rep-from" value="${esc(from)}"></label>
        <label><span>To</span><input class="inp" type="date" data-input="rep-to" value="${esc(to)}"></label>
      </div>

      <div class="dash-hero" style="margin-top:10px">
        <div class="dash-hero-top"><div>${headline}</div>
          <div class="meta">${inv.length} bill${inv.length === 1 ? '' : 's'}</div></div>
        <div class="dash-strip">${strip.map(function (x) {
          return '<div><span>' + esc(x.k) + '</span><b' + (x.bad ? ' class="bad"' : '') + '>' + x.v + '</b></div>';
        }).join('')}</div>
      </div>
      <div class="rep-note">Tax ${money(tax)} · discounts ${money(disc)} · returns ${money(sret)}${showProfit ? ' · purchases ' + money(purch) : ''}</div>

      ${secHead('This month vs last month')}
      <div class="rep-compare">
        <div><span>This month</span><b>${money(thisSales)}</b><em>${thisM.length} bills</em></div>
        <div><span>Last month</span><b>${money(lastSales)}</b><em>${lastM.length} bills</em></div>
        <div><span>Change</span><b class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}%</b>
          <em>${delta >= 0 ? 'Ahead' : 'Behind'}</em></div>
      </div>

      ${secHead('Money in and out')}
      ${list(
        row('Customers owe you', oweCount + ' with a balance', money(owed), owed > 0 ? 'bad' : 'ok') +
        row('You owe suppliers', 'Open supplier balances', money(oweSup)),
        'Nothing to show')}

      ${secHead('EMI plans', emiBills.length ? emiBills.length + ' bill' + (emiBills.length === 1 ? '' : 's') : '')}
      ${list(emiBills.length
        ? row('EMI sales', emiBills.length + ' bill' + (emiBills.length === 1 ? '' : 's'), money(emiSales)) +
          row('Monthly EMI total', 'Across all finance plans', money(emiMonthly)) +
          emiBills.map(function (i) {
            var e = i.emi || {};
            var sub = esc(i.no) + (e.months ? ' · ' + num(e.months) + ' months' : '') + (e.date ? ' · from ' + esc(fmtDate(e.date)) : '')
              + (!e.finance ? ' · paid by ' + esc(i.method || 'EMI') : '');
            return row(e.finance || 'Finance plan', sub, e.monthly ? money(e.monthly) + '/mo' : money(i.total));
          }).join('')
        : '', 'No EMI bills in this period.')}

      ${secHead('Best sellers', top.length ? 'by revenue' : '')}
      ${list(top.map(function (t) {
        return row(t.name, num(t.qty) + ' sold' + (showProfit ? ' · profit ' + money(t.profit) : ''), money(t.revenue));
      }).join(''), 'No sales in this range — try a wider date range.')}

      ${secHead('Moving fast', byQty.length ? 'by quantity' : '')}
      ${list(byQty.map(function (t) {
        return row(t.name, num(t.qty) + ' sold', money(t.revenue));
      }).join(''), 'No sales in this range.')}

      ${secHead('Sitting still', slow.length ? 'stock not selling' : '')}
      ${list(slow.map(function (t) {
        return row(t.name, num(t.qty) + ' in stock · ' + num(t.sold) + ' sold', money(t.value), 'bad');
      }).join(''), 'Nothing stuck — everything in stock is moving.')}

      ${showProfit ? secHead('Profit by item') + list(byProfit.map(function (t) {
        return row(t.name, num(t.qty) + ' sold · ' + money(t.revenue), money(t.profit), t.profit < 0 ? 'bad' : 'ok');
      }).join(''), 'No sales in this range.') : ''}

      ${showProfit ? secHead('Profit by category') + list(catRows.map(function (t) {
        return row(t.name, num(t.qty) + ' sold · ' + money(t.revenue), money(t.profit), t.profit < 0 ? 'bad' : 'ok');
      }).join(''), 'No sales in this range.') : ''}

      ${showProfit ? secHead('Profit by bill', 'after linked expenses') + list(byBill.map(function (b) {
        return row(b.no, esc(fmtDate(b.date)) + ' · ' + esc(b.cust) + (b.linked > 0.009 ? ' · expenses ' + money(b.linked) : ''),
          money(b.profit), b.profit < 0 ? 'bad' : 'ok');
      }).join(''), 'No bills in this range.') : ''}

      ${secHead('Expenses by category')}
      ${list(Object.keys(byCat).sort().map(function (k) {
        return row(k, '', money(byCat[k]), 'bad');
      }).join(''), 'No expenses recorded in this range.')}

      ${secHead('Day by day', days.length > 10 ? 'latest 10 of ' + days.length + ' days' : '')}
      ${list(days.slice(0, 10).map(function (d) {
        return row(fmtDate(d), byDay[d].n + ' bill' + (byDay[d].n === 1 ? '' : 's') + (showProfit ? ' · profit ' + money(byDay[d].profit) : ''),
          money(byDay[d].total));
      }).join(''), 'No bills in this period.')}
    `;
  }


  /* -------------------------------------------------------------------- staff */
  function staffBranchesLabel(s) {
    if (!s) return '—';
    if (s.role === 'owner') return 'All branches';
    var ids = S.staffBranchIds(s);
    return ids.length ? ids.map(function (id) { return branchName(id); }).join(', ') : '—';
  }

  function viewStaff() {
    var open = ui.staffOpen ? staffById(ui.staffOpen) : null;
    if (open) return viewStaffDetail(open);
    var sq = ui.qStaff || '';
    var people = db.staff.filter(function (x) {
      return !sq || match(x.name, sq) || match(x.username, sq) || match(S.ROLE_LABEL[x.role] || x.role, sq) || match(branchName(x.branchId), sq);
    });
    return `<div class="cust-page staff-page">
      <div class="cust-top">
        <h2 class="cust-title">Staff &amp; access <span class="cust-count">${db.staff.length}</span></h2>
        <button type="button" class="cust-add" data-act="staff-new">+ Add staff</button>
      </div>
      <div class="sub" style="margin-bottom:10px">Each person signs in with their own ID and gets only the permissions you allow.</div>
      <div class="cust-search">${ico('search')}
        <input class="inp" data-input="q-staff" placeholder="Search name, ID, role or branch"
          value="${esc(sq)}" autocomplete="off" aria-label="Search staff">
      </div>
      ${!people.length ? '<div class="empty"><b>' + (sq ? 'No staff match' : 'No staff yet') + '</b>' + (sq ? 'Try another search.' : 'Add people so they can sign in.') + '</div>'
        : `<div class="cust-list staff-list">${people.map(function (s) {
          var bills = db.invoices.filter(function (i) { return i.staffId === s.id; }).length;
          var tg = Number(s.target) || 0;
          var sold = staffSales(s.id);
          var pct = tg > 0 ? Math.min(100, Math.round(sold / tg * 100)) : 0;
          var active = s.active !== false;
          var sub = esc(S.ROLE_LABEL[s.role] || s.role) + ' · ' + esc(staffBranchesLabel(s)) + ' · ' + bills + ' bills';
          if (tg > 0) sub += ' · ' + pct + '% of target';
          return `<div class="cust-row staff-row" data-act="staff-open" data-id="${s.id}" tabindex="0" role="button">
            <span class="cust-main">
              <span class="cust-name">${esc(s.name)}</span>
              <span class="cust-sub">${sub}</span>
            </span>
            <span class="inv-meta">
              <span class="inv-st ${active ? 'ok' : 'due'}">${active ? 'Active' : 'Disabled'}</span>
              ${tg > 0 ? `<span class="inv-date">${money(sold)} / ${money(tg)}</span>` : `<span class="inv-date">@${esc(s.username)}</span>`}
            </span>
            <button type="button" class="cust-dots" data-act="staff-more" data-id="${s.id}" aria-label="Actions for ${esc(s.name)}">⋮</button>
            ${ui.staffMore === s.id ? `<div class="cust-menu cust-rowmenu">
              <button type="button" data-act="staff-edit" data-id="${s.id}">Edit</button>
              ${can('profit.view') ? `<button type="button" data-act="lg-type" data-id="staff">Ledger</button>` : ''}
              <button type="button" data-act="staff-toggle" data-id="${s.id}">${active ? 'Disable' : 'Enable'}</button>
              <button type="button" data-act="del-ask" data-kind="staff" data-id="${s.id}">Remove</button>
            </div>` : ''}
          </div>`;
        }).join('')}</div>`}
      <div class="note" style="margin-top:14px">Owners always have full access. Managers and cashiers only get what is ticked in their permissions.</div>
    </div>`;
  }

  function viewStaffDetail(s) {
    var bills = db.invoices.filter(function (i) { return i.staffId === s.id; }).length;
    var tg = Number(s.target) || 0;
    var sold = staffSales(s.id);
    var pct = tg > 0 ? Math.min(100, Math.round(sold / tg * 100)) : 0;
    var active = s.active !== false;
    var perms = (s.perms || []).slice();
    var permList = !perms.length ? '<div class="sub">No permissions set.</div>'
      : S.PERM_GROUPS.map(function (g) {
          var keys = g.keys.filter(function (k) { return perms.indexOf(k) > -1; });
          if (!keys.length) return '';
          return `<div class="perm-group"><div class="t">${esc(g.title)}</div><div class="sub">${keys.map(function (k) { return esc(S.PERM_LABELS[k] || k); }).join(', ')}</div></div>`;
        }).join('') || '<div class="sub">No permissions set.</div>';
    return `<div class="page-head"><div>
        <button class="btn sm ghost" data-act="staff-back">← All staff</button>
        <h2 style="margin-top:10px">${esc(s.name)}</h2>
        <div class="sub">@${esc(s.username)} · ${esc(S.ROLE_LABEL[s.role] || s.role)} · ${esc(staffBranchesLabel(s))}</div>
      </div>
      <div class="row-actions">
        <button class="btn sm" data-act="staff-edit" data-id="${s.id}">Edit</button>
        ${can('profit.view') ? `<button class="btn sm" data-act="lg-type" data-id="staff">Ledger</button>` : ''}
        <button class="btn sm" data-act="staff-toggle" data-id="${s.id}">${active ? 'Disable' : 'Enable'}</button>
        <button class="btn sm danger" data-act="del-ask" data-kind="staff" data-id="${s.id}">Remove</button>
      </div></div>

      <div class="kpi-grid">
        <div class="kpi"><div class="k">Status</div><div class="v">${active ? '<span class="badge ok">Active</span>' : '<span class="badge bad">Disabled</span>'}</div>
          <div class="sub">Sign-in ${active ? 'allowed' : 'blocked'}</div></div>
        <div class="kpi"><div class="k">Bills</div><div class="v">${bills}</div>
          <div class="sub">Bills made by this person</div></div>
        <div class="kpi"><div class="k">Sales this month</div><div class="v">${money(sold)}</div>
          <div class="sub">${tg > 0 ? pct + '% of target' : 'No target set'}</div></div>
        <div class="kpi"><div class="k">Monthly target</div><div class="v">${tg > 0 ? money(tg) : '—'}</div>
          <div class="sub">${tg > 0 ? money(Math.max(0, tg - sold)) + ' remaining' : 'Set a target in edit'}</div></div>
      </div>
      ${tg > 0 ? `<div class="card" style="margin-top:12px"><div class="sub" style="margin-bottom:6px">Target progress · ${money(sold)} of ${money(tg)} (${pct}%)</div><div class="bar"><span style="width:${pct}%"></span></div></div>` : ''}

      <div class="section-title">Permissions</div>
      <div class="card">${permList}</div>
      <div class="note" style="margin-top:14px">Owners always have full access. Managers and cashiers only get what is ticked in their permissions.</div>`;
  }

  /* ----------------------------------------------------------------- settings */
  function viewSettings() {
    var s = db.settings;
    var tab = (ui.settingsTab === 'invoice' || ui.settingsTab === 'activity' || ui.settingsTab === 'cloud') ? ui.settingsTab : 'company';
    var tabBtn = function (id, label) {
      return `<button type="button" data-act="settings-tab" data-id="${id}" class="${tab === id ? 'on' : ''}">${label}</button>`;
    };
    var head = `
      <div class="page-head"><div><h2>Settings</h2><div class="sub">Company, appearance, bills, receipts and activity.</div></div></div>
      <div class="seg" style="margin-bottom:14px;flex-wrap:wrap">${tabBtn('company', 'Company')}${tabBtn('invoice', 'Invoice / billing')}${tabBtn('activity', 'Activity')}${tabBtn('cloud', 'Cloud')}</div>`;

    if (tab === 'activity') {
      var acts = (db.activity || []).slice(0, 80);
      return head + `
        <div class="card"><h3>Recent activity</h3>
          <div class="sub" style="margin-bottom:10px">A simple record of who did what, newest first.</div>
          ${acts.length ? `<div class="row-list">${acts.map(function (a) {
            return `<div class="rrow">
              <div class="grow"><div class="title">${esc(a.text)}</div>
                <div class="sub">${esc(a.who || 'Someone')}${a.branch ? ' · ' + esc(a.branch) : ''} · ${esc(fmtDate(a.date || today()))}${a.at ? ' ' + new Date(a.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''}</div></div>
              <div class="amt"><span class="badge">${esc(a.type || 'info')}</span></div></div>`;
          }).join('')}</div>` : '<div class="empty"><b>No activity yet</b>Changes you make will be listed here.</div>'}
        </div>`;
    }

    if (tab === 'cloud') {
      var cc = cloudConf();
      return head + `
        <div class="card"><h3>Cloud sync</h3>
          <div class="sub" style="margin-bottom:10px">Keep a copy of this shop in Supabase. Your device still works offline; changes go up when there is internet, and another phone can load the same shop.</div>
          <div id="cloudStatus" style="margin-bottom:12px">${cloudStatusHTML()}</div>
          <form data-form="cloud">
            <div class="field"><label>Project URL</label>
              <input class="inp" name="url" value="${esc(cc.url || 'https://rkdrivwtycggzoojydzf.supabase.co')}" placeholder="https://your-project.supabase.co" autocomplete="off" spellcheck="false"></div>
            <div class="field" style="margin-top:10px"><label>Public key (publishable or anon)</label>
              <input class="inp" name="key" value="${esc(cc.key || 'sb_publishable_6OpmrjyxuHFbuU-z9Xn1cQ_7nIphWto')}" placeholder="sb_publishable_… or eyJhbGciOi…" autocomplete="off" spellcheck="false">
              <div class="hint">Supabase dashboard → Settings → API Keys. Use the publishable key (new) or the legacy anon key — never the secret / service_role key.</div></div>
            <div class="field" style="margin-top:10px"><label>Shop code</label>
              <input class="inp" name="shop" value="${esc(cc.shop || 'rkdrivwtycggzoojydzf')}" placeholder="sharma-store-7f2k9x" autocomplete="off" spellcheck="false">
              <div class="hint">Any long private word. Use exactly the same code on every device — it works like a password.</div></div>
            <label class="check" style="margin-top:10px"><input type="checkbox" name="auto"${cc.auto !== false ? ' checked' : ''}> Sync automatically after every change</label>
            <div class="row-actions" style="margin-top:12px">
              <button class="btn primary" type="submit">Save &amp; test</button>
              <button class="btn" type="button" data-act="cloud-push">Upload now</button>
              <button class="btn" type="button" data-act="cloud-pull">Load from cloud</button>
              <button class="btn" type="button" data-act="cloud-verify">Check data</button>
            </div>
            <div id="cloudCheck" style="margin-top:12px"></div>
          </form>
        </div>

        <div class="card"><h3>One-time setup in Supabase</h3>
          <div class="sub">In your Supabase project open <b>SQL Editor</b>, paste the box below and press Run. Only needed once.</div>
          <pre class="cloud-sql" id="cloudSql">${esc(CLOUD_SQL)}</pre>
          <div class="row-actions" style="margin-top:8px"><button class="btn sm" type="button" data-act="cloud-sql-copy">Copy setup SQL</button></div>
          <div class="note" style="margin-top:12px">The anon key is meant to be public, and the shop code is what keeps your data private — so make it long. Anyone with the project URL, the key and the shop code can read this shop. Separate logins per person need Supabase sign-in, which can be added later.</div>
        </div>
`;
    }

    if (tab === 'company') {
      return head + `
      <div class="card"><h3>Business logo</h3>
        <div class="logo-edit">
          ${s.logo ? `<img class="logo-prev" src="${s.logo}" alt="Business logo">` : '<div class="logo-empty">No logo</div>'}
          <div class="grow">
            <div class="sub">Used on invoices and printed bills. A square or wide image works best.</div>
            <div class="row-actions" style="margin-top:8px">
              <label class="btn" style="cursor:pointer">${s.logo ? 'Change logo' : 'Upload logo'}
                <input type="file" accept="image/*" data-change="logo-upload" hidden></label>
              ${s.logo ? '<button class="btn danger" type="button" data-act="logo-remove">Remove logo</button>' : ''}
            </div>
          </div>
        </div>
      </div>

      <div class="card"><h3>Appearance</h3>
        <div class="sub" style="margin-bottom:10px">Choose how the app looks on this device.</div>
        <div class="field"><label>Mode</label>
          <div class="row-actions" style="margin-top:4px">
            <button class="btn sm${(s.appearance&&s.appearance.mode)!=='dark'?' primary':''}" type="button" data-act="set-mode" data-id="light">Light</button>
            <button class="btn sm${(s.appearance&&s.appearance.mode)==='dark'?' primary':''}" type="button" data-act="set-mode" data-id="dark">Dark</button>
          </div>
        </div>
        <div class="field" style="margin-top:10px"><label>Color theme</label>
          <div class="row-actions" style="margin-top:4px;flex-wrap:wrap;gap:8px">
            ${(function(){
              var cur=(s.appearance&&s.appearance.color)||'red';
              var opts=[{id:'red',label:'Indigo'},{id:'blue',label:'Blue'},{id:'green',label:'Green'},{id:'purple',label:'Purple'},{id:'orange',label:'Orange'},{id:'teal',label:'Teal'}];
              return opts.map(function(o){ return '<button class="btn sm'+(cur===o.id?' primary':'')+'" type="button" data-act="set-color" data-id="'+o.id+'">'+o.label+'</button>'; }).join('');
            })()}
          </div>
        </div>
      </div>

      <div class="card"><h3>Business details</h3><form data-form="settings">
        <div class="grid2">
          <div class="field"><label>Business name</label><input class="inp" name="business" value="${esc(s.business)}" required></div>
          <div class="field"><label>Phone</label><input class="inp" name="phone" value="${esc(s.phone)}"></div>
        </div>
        <div class="field"><label>Address</label><input class="inp" name="address" value="${esc(s.address)}"></div>
        <div class="grid2">
          <div class="field"><label>Email</label><input class="inp" name="email" value="${esc(s.email)}"></div>
          <div class="field"><label>Currency symbol</label><input class="inp" name="currency" maxlength="3" value="${esc(s.currency)}"></div>
        </div>
        <div class="row-actions"><button class="btn primary" type="submit">Save company details</button></div>
      </form></div>

      <div class="card"><h3>Branches</h3>
        <div class="row-list">${db.branches.map(function (b) {
          var staffCount = db.staff.filter(function (x) { return x.branchId === b.id; }).length;
          var billsCount = db.invoices.filter(function (i) { return i.branchId === b.id; }).length;
          var addrText = esc(b.address || 'No address');
          return `<div class="rrow br-row"><div class="grow"><div class="title">${esc(b.name)}</div>
            <div class="sub br-sub"><span class="br-addr" title="${addrText}">${addrText}</span><span class="br-meta">${staffCount} staff · ${billsCount} bills · ${esc((b.prefix || db.settings.prefix || 'INV').toUpperCase())}</span></div></div>
            <div class="amt"><button class="btn sm" data-act="branch-edit" data-id="${b.id}">Edit</button>
            <button class="btn sm danger" data-act="branch-del" data-id="${b.id}">Delete</button></div></div>`;
        }).join('')}</div>
        <div class="row-actions" style="margin-top:12px"><button class="btn" data-act="branch-add">+ Add branch</button></div>
        <div class="sub" style="margin-top:10px">Open Edit on a branch to set its monthly sales and profit targets.</div>
      </div>

      ${safetyNetHTML()}

      <div class="card"><h3>Backup &amp; restore</h3>
        <div class="sub" style="margin-bottom:12px">Everything (including staff accounts) is stored in this browser. Download a backup before clearing browser data or moving device.</div>
        <div class="row-actions">
          <button class="btn" data-act="backup">Download backup</button>
          <label class="btn" style="cursor:pointer">Restore backup<input type="file" accept="application/json,.json" data-change="restore" hidden></label>
        </div></div>

      <div class="card"><h3>App version</h3>
        <div class="sub" style="margin-bottom:10px">The copy of the app running on this device. Mention this if something looks wrong.</div>
        <div class="row-list">
          <div class="rrow"><div class="grow"><div class="title">Version</div>
            <div class="sub">Bill &amp; Inventory build ${esc(APP_VERSION)}</div></div>
            <div class="amt"><span class="badge">${esc(APP_VERSION)}</span></div></div>
          <div class="rrow"><div class="grow"><div class="title">Code branch</div>
            <div class="sub">${esc(APP_BRANCH)}${APP_BRANCH === 'main' ? ' · released build' : ' · test build, not main'}</div></div>
            <div class="amt"><span class="badge${APP_BRANCH === 'main' ? ' ok' : ' warn'}">${APP_BRANCH === 'main' ? 'main' : 'branch'}</span></div></div>
        </div>
      </div>

      ${S.isOwner() ? `<div class="card"><h3>Download or delete all data</h3>
        <div class="sub" style="margin-bottom:12px">Download saves everything as one CSV file — bills, stock, customers, suppliers, purchases, returns, transfers, damage, expenses, staff entries, complaints and the activity log — for your accountant or your own records. Delete removes those records from this device and from Supabase. Your shop details, branches and staff logins stay.</div>
        <div class="row-actions">
          <button class="btn" data-act="all-csv">Download all data (CSV)</button>
          <button class="btn danger" data-act="all-delete">Delete all data</button>
        </div></div>` : ''}

      `;
    }

    var drafts = settingsDrafts();
    var charges = drafts.charges, terms = drafts.terms, fields = drafts.fields;
    var rstyle = billStyle(s.receiptStyle);
    var on = function(k, d){ return (s[k] == null ? d !== false : !!s[k]); };
    var opt = function(val, cur, label){ return `<option value="${val}"${cur===val?' selected':''}>${label}</option>`; };
    return head + `
      <form data-form="invoicesettings">
        <div class="card pset-card"><div class="pset-head">Billing behaviour</div>
          <div class="pset-row"><label>When billing more than stock</label>
            <select class="inp sm" name="stockPolicy">
              ${opt('warn', s.stockPolicy || 'warn', 'Warn, but allow')}
              ${opt('block', s.stockPolicy || 'warn', 'Block the save')}
            </select></div>
          <div class="hint">A warning shows how much is in the branch and asks before the bill goes negative. Block stops the save until the quantity is fixed.</div>
        </div>
        <div class="card pset-card"><div class="pset-head">Themes</div>
          <div class="pset-row"><label>Default layout</label>
            <select class="inp sm" name="receiptStyle">${BILL_LAYOUTS.map(function(l){return `<option value="${l.id}"${rstyle===l.id?' selected':''}>${l.name}</option>`;}).join('')}</select></div>
          <div class="pset-row"><label>Invoice theme</label>
            <select class="inp sm" name="billTheme">${['default','blue','green','dark','mono'].map(function(v){return opt(v,s.billTheme||'default',v.charAt(0).toUpperCase()+v.slice(1));}).join('')}</select></div>
          <div class="pset-row"><label>Print text size</label>
            <select class="inp sm" name="printTextSize">${opt('small',s.printTextSize||'small','Small')}${opt('medium',s.printTextSize||'small','Medium')}${opt('large',s.printTextSize||'small','Large')}</select></div>
          <div class="pset-row"><label>Page size</label>
            <select class="inp sm" name="pageSize">${opt('auto',s.pageSize||'auto','Auto (by layout)')}${opt('a5',s.pageSize||'auto','A5 (148 x 210 mm)')}${opt('a4',s.pageSize||'auto','A4')}${opt('receipt',s.pageSize||'auto','Receipt (80 mm)')}</select></div>
          <div class="pset-row"><label>Orientation</label>
            <select class="inp sm" name="orientation">${opt('auto',s.orientation||'auto','Auto (by layout)')}${opt('landscape',s.orientation||'auto','Landscape')}${opt('portrait',s.orientation||'auto','Portrait')}</select></div>
          <div class="hint">Page size and print/PDF follow the layout by default. "Auto" keeps each layout’s usual size.</div>
        </div>

        <div class="card pset-card"><div class="pset-head">Print Company Info/Header</div>
          <label class="pset-toggle"><span>Print repeat header in all pages</span><input type="checkbox" name="printRepeatHeader"${on('printRepeatHeader',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Company Name</span><input type="checkbox" name="printCompanyName"${on('printCompanyName',1)?' checked':''}></label>
          <div class="pset-row"><label>Company Name Text Size</label>
            <select class="inp sm" name="companyNameSize">${opt('small',s.companyNameSize||'medium','Small')}${opt('medium',s.companyNameSize||'medium','Medium')}${opt('large',s.companyNameSize||'medium','Large')}</select></div>
          <label class="pset-toggle"><span>Company logo</span><input type="checkbox" name="printLogo"${on('printLogo',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Address</span><input type="checkbox" name="printAddress"${on('printAddress',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Email</span><input type="checkbox" name="printEmail"${on('printEmail',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Phone number</span><input type="checkbox" name="printPhone"${on('printPhone',1)?' checked':''}></label>
          <div class="pset-row"><label>GSTIN on Sale</label><div class="pset-inline"><input type="checkbox" name="printGstin"${on('printGstin',0)?' checked':''}> <input class="inp sm" name="gstin" value="${esc(s.gstin||'')}" placeholder="GSTIN" style="max-width:170px"></div></div>
          <label class="pset-toggle"><span>Print Bill of Supply for non tax invoices</span><input type="checkbox" name="printBillOfSupply"${on('printBillOfSupply',0)?' checked':''}></label>
          <div class="pset-row"><label>Extra spaces on top of PDF</label><input class="inp sm" type="text" inputmode="numeric" min="0" max="30" step="1" name="extraTopSpace" value="${Number(s.extraTopSpace)||0}" style="width:90px"></div>
          <label class="pset-toggle"><span>Print Original/Duplicate</span><input type="checkbox" name="printOriginalDuplicate"${on('printOriginalDuplicate',0)?' checked':''}></label>
          <div class="pset-row"><label>Sale name on bill</label><input class="inp sm" name="txnSaleName" value="${esc(s.txnSaleName||'Invoice')}" placeholder="Invoice"></div>
          <div class="field" style="margin-top:8px"><label>Address on invoice</label><input class="inp" name="invoiceAddress" value="${esc(s.invoiceAddress || '')}" placeholder="${esc(s.address || '')}"><div class="hint">Leave blank to use the branch address.</div></div>
        </div>

        <div class="card pset-card"><div class="pset-head">Invoice numbering &amp; tax</div>
          <div class="grid3">
            <div class="field"><label>Invoice prefix</label><input class="inp" name="prefix" value="${esc(s.prefix)}" required></div>
            <div class="field"><label>Tax rate (%)</label><input class="inp" type="text" inputmode="decimal" min="0" max="100" step="0.01" name="taxRate" value="${esc(s.taxRate)}"${s.taxOn === false ? ' disabled' : ''}></div>
            <label class="check" style="align-self:end;margin-bottom:14px"><input type="checkbox" name="taxOn"${s.taxOn !== false ? ' checked' : ''}> Charge tax on bills</label>
          </div>
          <div class="pset-row" style="margin-top:10px"><label>Discount type</label>
            <select class="inp sm" name="discountType">
              <option value="amount"${(s.discountType !== 'percent') ? ' selected' : ''}>Amount (₹)</option>
              <option value="percent"${s.discountType === 'percent' ? ' selected' : ''}>Percentage (%)</option>
            </select>
          </div>
          <div class="sub" style="margin-top:6px">A branch with its own prefix overrides this one. Next bill number in <b>${esc(branchName(ui.branch))}</b>: <b>${esc(branchPrefix(ui.branch))}-${nextBillSeq()}</b></div>
        </div>

        <div class="card pset-card"><div class="pset-head">Totals &amp; Taxes</div>
          <label class="pset-toggle"><span>Expand table to print on whole page</span><input type="checkbox" name="expandTable"${on('expandTable',0)?' checked':''}></label>
          <div class="pset-row"><label>Min. No. of rows in Item Table</label><input class="inp sm" type="text" inputmode="numeric" min="0" max="30" step="1" name="minRows" value="${Number(s.minRows)||0}" style="width:90px"></div>
          <label class="pset-toggle"><span>Total Item Quantity</span><input type="checkbox" name="printTotalQty"${on('printTotalQty',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Amount with Decimal (eg 0.00)</span><input type="checkbox" name="printDecimals"${on('printDecimals',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Received amount</span><input type="checkbox" name="printReceived"${on('printReceived',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Balance amount</span><input type="checkbox" name="printBalance"${on('printBalance',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Current Balance of Party</span><input type="checkbox" name="printCurrentBalance"${on('printCurrentBalance',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Tax details</span><input type="checkbox" name="printTaxDetails"${on('printTaxDetails',0)?' checked':''}></label>
          <label class="pset-toggle"><span>Amount Grouping</span><input type="checkbox" name="amountGrouping"${on('amountGrouping',1)?' checked':''}></label>
          <div class="pset-row"><label>Amount in words format</label>
            <select class="inp sm" name="amountWordsFormat">${opt('indian',s.amountWordsFormat||'indian','Indian (1,00,00,000)')}${opt('intl',s.amountWordsFormat||'indian','International (100,000,000)')}</select></div>
          <label class="pset-toggle"><span>You Saved</span><input type="checkbox" name="printYouSaved"${on('printYouSaved',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Round off total to nearest rupee</span><input type="checkbox" name="roundOffOn"${on("roundOffOn",0)?" checked":""}></label>
        </div>

        <div class="card pset-card"><div class="pset-head">Footer</div>
          <label class="pset-toggle"><span>Print description / notes</span><input type="checkbox" name="printDescription"${on('printDescription',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Terms &amp; Conditions</span><input type="checkbox" name="printTerms"${on('printTerms',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Received by details</span><input type="checkbox" name="printReceivedBy"${on('printReceivedBy',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Delivered by details</span><input type="checkbox" name="printDeliveredBy"${on('printDeliveredBy',0)?' checked':''}></label>
          <label class="pset-toggle"><span>Authorised signatory on invoice print</span><input type="checkbox" name="printSignature"${on('printSignature',0)?' checked':''}></label>
          <div class="pset-row"><label>Custom Signature Text</label><input class="inp sm" name="signatureText" value="${esc(s.signatureText||'')}" placeholder="Authorised signatory"></div>
          <label class="pset-toggle"><span>Payment mode</span><input type="checkbox" name="printPaymentMode"${on('printPaymentMode',1)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Acknowledgement</span><input type="checkbox" name="printAcknowledgement"${on('printAcknowledgement',0)?' checked':''}></label>
          <label class="pset-toggle"><span>Print Page Numbers</span><input type="checkbox" name="printPageNumbers"${on('printPageNumbers',1)?' checked':''}></label>
        </div>

        <div class="card"><h3>Extra charges</h3>
          <div class="sub" style="margin-bottom:10px">Charges you can turn on for a bill, like delivery or packing.</div>
          <div id="chargeRows">${charges.length ? charges.map(function (c, i) {
            return `<div class="charge-row">
              <input class="inp" data-input="sc-charge-name" data-id="${i}" value="${esc(c.name || '')}" placeholder="Charge name">
              <input class="inp" type="text" inputmode="decimal" min="0" step="0.01" data-input="sc-charge-amount" data-id="${i}" value="${c.amount || 0}" placeholder="0">
              <button class="icon-btn danger" type="button" data-act="sc-charge-del" data-id="${i}" aria-label="Remove charge">✕</button>
            </div>`;
          }).join('') : '<div class="empty compact"><b>No extra charges</b>Add delivery, packing or any fee you charge.</div>'}</div>
          <div class="row-actions" style="margin-top:10px"><button class="btn sm" type="button" data-act="sc-charge-add">+ Add charge</button></div>
        </div>

        <div class="card"><h3>Extra bill fields</h3>
          <div class="sub" style="margin-bottom:10px">Fields staff can fill in on each bill and that print on the bill.</div>
          <div id="fieldRows">${fields.length ? fields.map(function (f, i) {
            return `<div class="term-row">
              <span class="term-no">${i + 1}</span>
              <input class="inp" data-input="sc-field" data-id="${i}" value="${esc(f.label || '')}" placeholder="Field name">
              <button class="icon-btn danger" type="button" data-act="sc-field-del" data-id="${i}" aria-label="Remove field">✕</button>
            </div>`;
          }).join('') : '<div class="empty compact"><b>No extra fields</b>Add a field to collect more details on each bill.</div>'}</div>
          <div class="row-actions" style="margin-top:10px"><button class="btn sm" type="button" data-act="sc-field-add">+ Add field</button></div>
        </div>

        <div class="card"><h3>Payment details &amp; QR code</h3>
          <div class="grid2">
            <div class="field"><label>Bank name</label><input class="inp" name="bankName" value="${esc(s.bankName || '')}"></div>
            <div class="field"><label>Account name</label><input class="inp" name="bankAccountName" value="${esc(s.bankAccountName || '')}"></div>
          </div>
          <div class="grid3">
            <div class="field"><label>Account number</label><input class="inp" name="bankAccount" value="${esc(s.bankAccount || '')}"></div>
            <div class="field"><label>IFSC / branch code</label><input class="inp" name="bankIfsc" value="${esc(s.bankIfsc || '')}"></div>
            <div class="field"><label>UPI ID</label><input class="inp" name="upiId" value="${esc(s.upiId || '')}"></div>
          </div>
          <label class="check"><input type="checkbox" name="showBankOnInvoice"${s.showBankOnInvoice !== false ? ' checked' : ''}> Print bank &amp; UPI details on bills</label>
          <label class="check"><input type="checkbox" name="showUpiQrOnInvoice"${s.showUpiQrOnInvoice !== false ? ' checked' : ''}> Print a UPI QR code on bills</label>
        </div>

        <div class="card" id="setTermsCard"><h3>Terms &amp; conditions</h3>
          <div class="sub" style="margin-bottom:10px">Printed as numbered points when "Terms &amp; Conditions" is on.</div>
          <div id="termRows">${terms.length ? terms.map(function (t, i) {
            return `<div class="term-row">
              <span class="term-no">${i + 1}</span>
              <input class="inp" data-input="sc-term" data-id="${i}" value="${esc(t)}" aria-label="Term ${i + 1}">
              <button class="icon-btn danger" type="button" data-act="sc-term-del" data-id="${i}" aria-label="Remove term">✕</button>
            </div>`;
          }).join('') : '<div class="empty compact"><b>No terms yet</b>Add the rules you want printed on every bill.</div>'}</div>
          <div class="row-actions" style="margin-top:10px"><button class="btn sm" type="button" data-act="sc-term-add">+ Add term</button></div>
        </div>

        <div class="row-actions" style="margin-bottom:20px"><button class="btn primary" type="submit">Save invoice settings</button></div>
      </form>`;

  }

  function handleLogoUpload(file) {
    if (!S.isOwner()) return toast('Only the owner can change settings');
    if (!file) return;
    if (!/^image\//.test(file.type || '')) return toast('Choose an image file');
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 260;
        var scale = Math.min(1, max / Math.max(img.width || max, img.height || max));
        var w = Math.max(1, Math.round((img.width || max) * scale));
        var h = Math.max(1, Math.round((img.height || max) * scale));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        try {
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          db.settings.logo = cv.toDataURL('image/png');
        } catch (e) {
          db.settings.logo = String(reader.result || '');
        }
        save(); render(); toast('Logo saved');
      };
      img.onerror = function () {
        db.settings.logo = String(reader.result || '');
        save(); render(); toast('Logo saved');
      };
      img.src = String(reader.result || '');
    };
    reader.onerror = function () { toast('Could not read that image'); };
    reader.readAsDataURL(file);
  }

  function settingsDrafts() {
    if (!ui.scCharges) {
      ui.scCharges = (db.settings.extraCharges || []).map(function (c) { return { name: c.name || '', amount: Number(c.amount) || 0 }; });
    }
    if (!ui.scTerms) ui.scTerms = termsList().slice();
    if (!ui.scFields) {
      ui.scFields = (db.settings.billFields || []).map(function (f) { return { id: f.id, label: f.label || '' }; });
    }
    return { charges: ui.scCharges, terms: ui.scTerms, fields: ui.scFields };
  }

  /* ------------------------------------------------------------------- modal */
  function openModal(title, html, opts) {
    opts = opts || {};
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    var dlg = $('#modal');
    if (dlg) {
      dlg.classList.remove('modal-fullpage');
      if (opts.fullpage) dlg.classList.add('modal-fullpage');
    }
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }
  function invPaymentModal(invId) {
    var inv = invById(invId);
    if (!inv) return;
    var left = r2(inv.total - inv.paid);
    var c = findCust(inv.customerId);
    openModal('Record payment', `
      <form data-form="invpayment">
        <input type="hidden" name="invId" value="${inv.id}">
        <div class="card" style="margin:0 0 12px">
          <div class="sub">Bill ${esc(inv.no)} · ${esc(c ? c.name : 'Walk-in customer')}</div>
          <div class="tot"><span>Bill total</span><b>${money(inv.total)}</b></div>
          <div class="tot"><span>Already paid</span><b>${money(inv.paid)}</b></div>
          <div class="tot"><span>Balance</span><b style="color:#dc2626">${money(left)}</b></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Amount received</label><input class="inp" name="amount" type="text" inputmode="decimal" step="0.01" min="0" max="${left}" value="${left}" required></div>
          <div class="field"><label>Method</label><select class="inp" name="method">${['Cash', 'UPI', 'Card', 'Bank transfer', 'Credit'].map(function (m) {
            return `<option>${m}</option>`;
          }).join('')}</select></div>
        </div>
        <div class="row-actions"><button class="btn primary" type="submit">Save payment</button>
          <button class="btn" type="button" data-act="close-modal">Cancel</button></div>
      </form>`);
  }

  function closeModal() {
    var dlg = $('#modal');
    if (dlg) dlg.classList.remove('modal-fullpage');
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  /* every category the shop knows: ones saved on items plus ones the user
     added by hand, so a new name keeps showing up in the list */
  function allCategories() {
    var out = [];
    function add(v) {
      v = String(v == null ? '' : v).trim();
      if (!v) return;
      var low = v.toLowerCase();
      for (var i = 0; i < out.length; i++) if (out[i].toLowerCase() === low) return;
      out.push(v);
    }
    (db.cats || []).forEach(add);
    db.items.forEach(function (x) { add(x.category); });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  /* suggestions stay hidden until the user types, then show only matching ones */
  function itemCatPickHTML(q) {
    var needle = String(q == null ? '' : q).trim();
    if (!needle) return '';
    var low = needle.toLowerCase();
    var cats = allCategories();
    var exact = cats.some(function (c) { return c.toLowerCase() === low; });
    var chips = cats.filter(function (c) { return c.toLowerCase().indexOf(low) >= 0; }).slice(0, 8).map(function (c) {
      var on = c.toLowerCase() === low;
      return `<button type="button" class="btn sm cat-chip${on ? ' on' : ''}" data-act="item-cat-pick" data-name="${esc(c)}">${esc(c)}</button>`;
    }).join('');
    var addBtn = exact ? ''
      : `<button type="button" class="btn sm primary cat-chip" data-act="item-cat-add" data-name="${esc(needle)}">+ Add “${esc(needle)}”</button>`;
    return `<span class="cat-chip-row">${chips}${addBtn}</span>`;
  }

  /* While a name is typed, show the items that already exist under a similar
     name, so staff can see the product is already added before making a
     duplicate. */
  function itemNamePickHTML(q, skipId) {
    var needle = String(q == null ? '' : q).trim().toLowerCase();
    if (needle.length < 2) return '';
    var words = needle.split(/\s+/).filter(Boolean);
    var list = db.items.filter(function (i) {
      if (skipId && i.id === skipId) return false;
      var hay = [i.name || '', i.sku || '', i.category || ''].join(' ').toLowerCase();
      return words.every(function (w) { return hay.indexOf(w) >= 0; });
    }).slice(0, 5);
    if (!list.length) return '';
    var exact = list.some(function (i) { return String(i.name || '').trim().toLowerCase() === needle; });
    var head = exact
      ? 'This item is already added — open it instead of adding it again.'
      : 'Similar items already exist — check them before adding a new one.';
    return `<div class="name-pick-head">${head}</div>` + list.map(function (i) {
      var qty = Number((i.stock || {})[ui.branch]) || 0;
      var meta = [i.category || '', money(i.price), num(qty) + ' in ' + branchName(ui.branch)].filter(Boolean).join(' · ');
      var isExact = String(i.name || '').trim().toLowerCase() === needle;
      return `<div class="name-pick-row${isExact ? ' exact' : ''}">
        <span class="grow"><span class="nm">${esc(i.name)}</span><span class="sub">${esc(meta)}</span></span>
        <button type="button" class="btn sm ghost" data-act="item-name-open" data-id="${i.id}">Open</button>
      </div>`;
    }).join('');
  }

  function itemModal(id) {
    var it = id ? itemById(id) : null;
    var priceLock = !can('price.edit');
    var stockLock = !can('stock.edit');
    var costField = can('profit.view')
      ? `<div class="field"><label>Cost price</label><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" name="cost" value="${it ? it.cost : ''}"${priceLock ? ' disabled' : ''}></div>`
      : '';
    openModal(it ? 'Edit item' : 'Add item', `<form data-form="item">
      <input type="hidden" name="id" value="${it ? it.id : ''}">
      <div class="field"><label>Item name</label>
        <input class="inp" name="name" required autocomplete="off" data-input="item-name" value="${esc(it ? it.name : '')}">
        <div class="name-pick" id="itemNamePick"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>SKU / code</label><input class="inp" name="sku" value="${esc(it ? it.sku : '')}"></div>
        <div class="field"><label>Category</label>
          <input class="inp" name="category" data-input="item-cat" autocomplete="off" placeholder="Search or type a new one, e.g. Chair" value="${esc(it ? it.category : '')}">
          <div class="cat-pick" id="itemCatPick">${itemCatPickHTML(it ? it.category : '')}</div>
        </div>
      </div>
      <div class="grid3">
        <div class="field"><label>Selling price</label><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" name="price" required value="${it ? it.price : ''}"${priceLock ? ' disabled' : ''}></div>
        ${costField}
        <div class="field"><label>Reorder level</label><input class="inp" type="text" inputmode="numeric" min="0" step="1" name="reorder" value="${it ? it.reorder : 0}"${stockLock ? ' disabled' : ''}></div>
      </div>
      <div class="section-title" style="margin-top:0">Stock per branch</div>
      <div class="grid3">${db.branches.map(function (b) {
        var val = it ? (it.stock[b.id] || 0) : 0;
        return `<div class="field"><label>${esc(b.name)}</label>
          <input class="inp" type="text" inputmode="numeric" step="1" name="stock_${b.id}" value="${val}"${stockLock ? ' disabled' : ''}></div>`;
      }).join('')}</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save item</button>
      </div></form>`);
  }

  function customerModal(id) {
    var c = id ? findCust(id) : null;
    openModal(c ? 'Edit customer' : 'Add customer', `<form data-form="customer">
      <input type="hidden" name="id" value="${c ? c.id : ''}">
      <div class="field"><label>Name</label><input class="inp" name="name" required value="${esc(c ? c.name : '')}"></div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input class="inp" name="phone" value="${esc(c ? c.phone : '')}"></div>
        <div class="field"><label>Email</label><input class="inp" type="email" name="email" value="${esc(c ? c.email : '')}"></div>
      </div>
      <div class="field"><label>Address</label><input class="inp" name="address" value="${esc(c ? c.address : '')}"></div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save customer</button>
      </div></form>`);
  }

  function expPaidOf(x) {
    if (!x) return 0;
    if (typeof x.paid === 'number') return r2(Math.max(0, Math.min(Number(x.amount) || 0, x.paid)));
    return r2(Number(x.amount) || 0);
  }
  function expDueOf(x) {
    return r2(Math.max(0, (Number(x && x.amount) || 0) - expPaidOf(x)));
  }

  /* bills available to link to an expense — searched by bill number, customer
     name or amount, so nobody has to scroll a list of every bill */
  function expLinkBills(q) {
    var term = String(q || '').trim().toLowerCase();
    if (!term) return [];
    return db.invoices.filter(function (i) { return i.branchId === ui.branch; }).filter(function (i) {
      var c = findCust(i.customerId);
      var hay = [i.no || '', c ? c.name : 'Walk-in', money(i.total), String(Number(i.total) || 0)].join(' ').toLowerCase();
      return hay.indexOf(term) > -1;
    }).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || (b.created || 0) - (a.created || 0);
    }).slice(0, 8);
  }
  function expLinkHiddenHTML() {
    var picked = (ui.expLink && ui.expLink.ids) || [];
    return '<select id="expLinkSel" name="linkedBills" multiple hidden aria-hidden="true" tabindex="-1">' +
      db.invoices.map(function (i) {
        return '<option value="' + i.id + '"' + (picked.indexOf(i.id) > -1 ? ' selected' : '') + '>' + esc(i.no) + '</option>';
      }).join('') + '</select>';
  }
  function expLinkChipsHTML() {
    var picked = (ui.expLink && ui.expLink.ids) || [];
    if (!picked.length) return '<div class="hint" style="margin:0">No bills linked yet.</div>';
    return '<div class="fchips" style="margin:0">' + picked.map(function (id) {
      var i = invById(id);
      if (!i) return '';
      var c = findCust(i.customerId);
      return '<button type="button" class="fchip" data-act="exp-link-remove" data-id="' + i.id + '"' +
        ' title="Remove this bill link"><span>' + esc(i.no) + ' · ' + esc(c ? c.name : 'Walk-in') + ' · ' + money(i.total) + '</span><b>\u00d7</b></button>';
    }).join('') + '</div>';
  }
  function expLinkResultsHTML() {
    var q = (ui.expLink && ui.expLink.q) || '';
    if (!String(q).trim()) return '<div class="hint">Type a bill number or customer name to find a bill.</div>';
    var hits = expLinkBills(q);
    if (!hits.length) return '<div class="hint">No bill matches \u201c' + esc(q) + '\u201d.</div>';
    var picked = (ui.expLink && ui.expLink.ids) || [];
    return hits.map(function (i) {
      var c = findCust(i.customerId);
      var on = picked.indexOf(i.id) > -1;
      return '<button type="button" class="dash-row" data-act="exp-link-add" data-id="' + i.id + '"' + (on ? ' disabled' : '') + '>' +
        '<span class="grow"><b>' + esc(i.no) + ' \u00b7 ' + esc(c ? c.name : 'Walk-in') + '</b>' +
        '<span class="sub">' + esc(fmtDate(i.date)) + ' \u00b7 ' + money(i.total) + '</span></span>' +
        '<span class="val">' + (on ? 'Linked' : '+ Link') + '</span></button>';
    }).join('');
  }
  function expLinkRepaint() {
    var chips = document.getElementById('expLinkChips');
    if (chips) chips.innerHTML = expLinkChipsHTML();
    var res = document.getElementById('expLinkResults');
    if (res) res.innerHTML = expLinkResultsHTML();
    var sel = document.getElementById('expLinkSel');
    if (sel) sel.outerHTML = expLinkHiddenHTML();
  }

  function expenseModal(id) {
    var x = id ? db.expenses.filter(function (e) { return e.id === id; })[0] : null;
    var amt = x ? Number(x.amount) || 0 : 0;
    var isPaid = x ? expDueOf(x) <= 0.009 : true;
    var balNow = isPaid ? 0 : (x ? expDueOf(x) : amt);
    var linkedSel = (x && x.linkedBills ? x.linkedBills.slice() : []);
    ui.expLink = { q: '', ids: linkedSel };
    var hasBills = db.invoices.some(function (i) { return i.branchId === ui.branch; });
    openModal(x ? 'Edit expense' : 'Add expense', `<form data-form="expense">
      <input type="hidden" name="id" value="${x ? x.id : ''}">
      <div class="grid2">
        <div class="field"><label>Date</label><input class="inp" type="date" name="date" value="${x ? x.date : today()}" required></div>
        <div class="field"><label>Category</label><select class="inp" name="category">${EXP_CATS.map(function (c) {
          return `<option${x && x.category === c ? ' selected' : ''}>${c}</option>`;
        }).join('')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Total amount</label><input class="inp" type="text" inputmode="decimal" min="0" step="0.01" name="amount" id="expAmount" data-input="exp-amount" value="${amt || ''}" required></div>
        <div class="field"><label>Payment</label><label class="check" style="margin-top:12px"><input type="checkbox" name="paidFull" id="expPaidFull" data-change="exp-paid-flag"${isPaid ? ' checked' : ''}> Paid — money already given</label></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Paid by</label><select class="inp" name="method">${['Cash', 'UPI', 'Card', 'Bank'].map(function (m) {
          return `<option${x && x.method === m ? ' selected' : ''}>${m}</option>`;
        }).join('')}</select></div>
        <div class="field"><label>Balance to pay</label><div class="hint" id="expBalHint">${money(balNow)} left to pay${balNow <= 0.009 ? (amt > 0 ? ' — fully paid' : '') : ''}</div></div>
      </div>
      <div class="field"><label>Note</label><input class="inp" name="note" value="${esc(x ? x.note : '')}" placeholder="What was this for?"></div>
      <details style="margin:2px 0 10px"${linkedSel.length ? ' open' : ''}>
        <summary style="cursor:pointer;font-weight:600;font-size:13px">Link this expense to bills (optional)</summary>
        <div class="hint" style="margin:6px 0 8px">Search a bill by number or customer name and tap it to link — transport for two orders, for example. The amount is split across the linked bills by bill value, so profit per bill and on each customer's ledger includes its share.</div>
        ${hasBills ? `
        <input class="inp" data-input="exp-bill-q" placeholder="Search bill no., customer name or amount" value="${esc(ui.expLink.q)}" autocomplete="off" aria-label="Search bills to link">
        <div id="expLinkChips" style="margin-top:8px">${expLinkChipsHTML()}</div>
        <div id="expLinkResults" style="margin-top:6px">${expLinkResultsHTML()}</div>
        ${expLinkHiddenHTML()}` : '<div class="hint">No bills in this branch yet.</div>'}
      </details>
      <div class="hint">Recorded against ${esc(branchName(ui.branch))}. Tick “Paid” if you have already paid this expense. Leave it unticked and the whole amount is kept as balance to pay.</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save expense</button>
      </div></form>`);
  }

  function staffModal(id) {
    var s = id ? staffById(id) : null;
    var perms = s ? s.perms : S.ROLE_PERMS.cashier.slice();
    openModal(s ? 'Edit staff' : 'Add staff', `<form data-form="staff">
      <input type="hidden" name="id" value="${s ? s.id : ''}">
      <div class="grid2">
        <div class="field"><label>Full name</label><input class="inp" name="name" required value="${esc(s ? s.name : '')}"></div>
        <div class="field"><label>Role</label><select class="inp" name="role" data-change="staff-role">
          ${['owner', 'manager', 'cashier'].map(function (r) {
            return `<option value="${r}"${(s ? s.role : 'cashier') === r ? ' selected' : ''}>${S.ROLE_LABEL[r]}</option>`;
          }).join('')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>User ID</label><input class="inp" name="username" required value="${esc(s ? s.username : '')}" autocomplete="off"></div>
        <div class="field"><label>Password</label><input class="inp" name="password" value="" autocomplete="new-password" placeholder="${s ? 'Leave blank to keep the current one' : 'At least 4 characters'}"${s ? '' : ' required'}></div>
      </div>
      <div class="field"><label>Monthly sales target</label><input class="inp" type="text" inputmode="numeric" min="0" step="1" name="target" value="${s ? (s.target || 0) : 0}" placeholder="0 = no target"></div>
      <div class="section-title" style="margin-top:0">Branch access</div>
      <div class="hint" style="margin-bottom:8px">Tick every branch this login can use. They pick the active branch from the branch menu at the top, and bills, stock and reports follow it.</div>
      <div class="perm-grid" style="margin-bottom:14px">
        ${db.branches.map(function (b) {
          var on = s ? S.staffBranchIds(s).indexOf(b.id) > -1 : b.id === db.branches[0].id;
          return `<label class="check"><input type="checkbox" name="branch_${b.id}"${on ? ' checked' : ''}> ${esc(b.name)}</label>`;
        }).join('')}
      </div>
      <label class="check" style="margin:4px 0 14px"><input type="checkbox" name="active"${!s || s.active !== false ? ' checked' : ''}> Account is active</label>
      <div class="section-title" style="margin-top:0">Permissions</div>
      <div id="permBox">${permHTML(perms, s && s.role === 'owner')}</div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save staff</button>
      </div></form>`);
  }
  /* an owner role always has everything, so its boxes are shown locked —
     otherwise unticking them looks like it should remove access but cannot */
  function permHTML(perms, ownerRole) {
    var lock = !!ownerRole;
    var note = lock
      ? '<div class="note" style="margin-bottom:10px">Owner / Admin always has every permission. To limit this login, choose <b>Manager</b> or <b>Cashier</b> in the role above, then tick only what they need.</div>'
      : '';
    return note + S.PERM_GROUPS.map(function (g) {
      return `<div class="perm-group"><div class="t">${g.title}</div><div class="perm-grid">
        ${g.keys.map(function (k) {
          return `<label class="check"><input type="checkbox" name="perm_${k}"${perms.indexOf(k) > -1 ? ' checked' : ''}${lock ? ' disabled' : ''}> ${S.PERM_LABELS[k]}</label>`;
        }).join('')}</div></div>`;
    }).join('');
  }

  function branchModal(id) {
    var b = id ? S.branchById(id) : null;
    var pref = b && b.prefix ? b.prefix : (db.settings.prefix || 'INV');
    var tg = (b && branchTarget(b.id)) || { sales: 0, profit: 0 };
    openModal(b ? 'Edit branch' : 'Add branch', `<form data-form="branch">
      <input type="hidden" name="id" value="${b ? b.id : ''}">
      <div class="field"><label>Branch name</label><input class="inp" name="name" required value="${esc(b ? b.name : '')}"></div>
      <div class="field"><label>Address</label><input class="inp" name="address" value="${esc(b ? b.address : '')}"></div>
      <div class="grid2">
        <div class="field"><label>Phone</label><input class="inp" name="phone" value="${esc(b ? b.phone : '')}"></div>
        <div class="field"><label>Invoice prefix</label><input class="inp" name="prefix" value="${esc(pref)}" placeholder="INV"></div>
      </div>
      <div class="hint" style="margin-bottom:12px">Bills in this branch will use this prefix (e.g. ${esc(String(pref||'INV').toUpperCase())}-${nextBillSeq()}).</div>
      <div class="section-title" style="margin-top:0">Monthly targets</div>
      <div class="hint" style="margin-bottom:8px">Measured against this month's sales. Staff see the sales target; the profit target is yours only. Profit is what is left after cost, expenses and damage. Leave a box empty for no target.</div>
      <div class="grid2">
        <div class="field"><label>Sales target</label><input class="inp" type="text" inputmode="numeric" min="0" step="1" name="targetSales" value="${tg.sales || ''}" placeholder="0" autocomplete="off"></div>
        <div class="field"><label>Profit target</label><input class="inp" type="text" inputmode="numeric" min="0" step="1" name="targetProfit" value="${tg.profit || ''}" placeholder="0" autocomplete="off"></div>
      </div>
      <div class="row-actions" style="justify-content:flex-end;margin-top:16px">
        <button class="btn" type="button" data-act="close-modal">Cancel</button>
        <button class="btn primary" type="submit">Save branch</button>
      </div></form>`);
  }

  function branchDeleteModal(id) {
    var b = S.branchById(id);
    if (!b) return;
    var bills = db.invoices.filter(function (i) { return i.branchId === id; }).length;
    var exp = db.expenses.filter(function (x) { return x.branchId === id; }).length;
    var movers = db.staff.filter(function (x) { return x.branchId === id; });
    var tr = db.transfers.filter(function (t) { return t.from === id || t.to === id; }).length;
    var moveTo = db.branches.filter(function (x) { return x.id !== id; })[0];
    var bits = [];
    if (bills) bits.push(bills + (bills === 1 ? ' bill' : ' bills'));
    if (exp) bits.push(exp + (exp === 1 ? ' expense' : ' expenses'));
    if (movers.length) bits.push(movers.length + (movers.length === 1 ? ' staff login' : ' staff logins'));
    if (tr) bits.push(tr + (tr === 1 ? ' stock transfer' : ' stock transfers'));
    openModal('Delete branch', `
      <div class="card" style="margin:0 0 12px">
        <div class="title" style="font-weight:600">${esc(b.name)}</div>
        <div class="sub">${esc(b.address || 'No address')}</div>
      </div>
      ${bits.length ? `<div class="sub" style="margin-bottom:10px">This branch is used by <b>${esc(bits.join(', '))}</b>.</div>
      <div class="sub" style="margin-bottom:10px">Its bills and expenses stay in your reports under this name, so past totals do not change.${movers.length && moveTo ? ' ' + movers.length + (movers.length === 1 ? ' staff login moves' : ' staff logins move') + ' to ' + esc(moveTo.name) + '.' : ''}</div>`
      : '<div class="sub" style="margin-bottom:10px">Nothing is recorded in this branch yet.</div>'}
      <div class="sub" style="margin-bottom:14px;color:#dc2626">This cannot be undone.</div>
      <div class="row-actions" style="justify-content:flex-end">
        <button class="btn" type="button" data-act="close-modal">Keep branch</button>
        <button class="btn danger" type="button" data-act="branch-del-yes" data-id="${b.id}">Delete branch</button>
      </div>`);
  }

  /* ------------------------------------------------------ delete any entry */
  var DEL_KINDS = {
    invoice: { perm: 'invoice.delete', title: 'Delete bill' },
    purchase: { perm: 'purchase.edit', title: 'Delete purchase' },
    item: { perm: 'items', title: 'Delete item' },
    customer: { perm: 'customers', title: 'Delete customer' },
    supplier: { perm: 'purchases', title: 'Delete supplier' },
    expense: { perm: 'expenses', title: 'Delete expense' },
    staff: { perm: 'staff', title: 'Remove staff login' },
    damage: { perm: 'damage.delete', title: 'Delete damage entry' },
    transfer: { perm: 'transfer', title: 'Delete stock transfer' },
    complaint: { perm: 'complaints', title: 'Delete complaint', ownerOnly: true }
  };

  /* the owner can delete anything; everyone else needs the matching permission */
  function canDeleteEntry(kind) {
    var k = DEL_KINDS[kind];
    if (!k) return false;
    if (S.isOwner()) return true;
    if (k.ownerOnly) return false;
    return can(k.perm);
  }

  function deleteEntryInfo(kind, id) {
    if (kind === 'invoice') {
      var i = db.invoices.filter(function (x) { return x.id === id; })[0];
      if (!i) return null;
      var c = findCust(i.customerId);
      var n = (i.lines || []).length;
      return { name: i.no,
        sub: (c ? c.name : 'Walk-in customer') + ' · ' + fmtDate(i.date) + ' · ' + money(i.total),
        effects: [(n === 1 ? 'Its item goes back into stock at ' + branchName(i.branchId) + '.' : n ? n + ' item lines go back into stock at ' + branchName(i.branchId) + '.' : 'It has no item lines.')]
      };
    }
    if (kind === 'purchase') {
      var p = db.purchases.filter(function (x) { return x.id === id; })[0];
      if (!p) return null;
      var sup = supplierById(p.supplierId);
      var pend = purchaseStatus(p) === 'pending';
      return { name: p.no,
        sub: (sup ? sup.name : 'No supplier') + ' · ' + fmtDate(p.date) + ' · ' + (pend ? 'pending approval' : money(p.total)),
        effects: pend
          ? ['It was never approved, so stock and supplier balances are not touched.']
          : ['Stock goes back down by the quantities this purchase added to each branch.',
             'Its ' + money(p.total) + ' is no longer owed to ' + (sup ? sup.name : 'the supplier') + '.'] };
    }
    if (kind === 'item') {
      var it = itemById(id);
      if (!it) return null;
      return { name: it.name, sub: (it.sku ? it.sku + ' · ' : '') + money(it.price),
        effects: ['Past bills keep their lines and totals.'] };
    }
    if (kind === 'customer') {
      var cu = findCust(id);
      if (!cu) return null;
      var dueC = 0;
      db.invoices.forEach(function (x) { if (x.customerId === id) dueC += (Number(x.total) || 0) - (Number(x.paid) || 0); });
      dueC = r2(dueC);
      return { name: cu.name, sub: [cu.phone, cu.email].filter(Boolean).join(' · ') || 'No phone or email saved',
        effects: ['Their bills stay in history and reports.'].concat(dueC > 0.009 ? ['They still owe ' + money(dueC) + ' — that balance disappears with them.'] : []) };
    }
    if (kind === 'supplier') {
      var sp = supplierById(id);
      if (!sp) return null;
      var dueS = 0;
      (db.purchases || []).forEach(function (x) {
        if (x.supplierId !== id || purchaseStatus(x) !== 'approved') return;
        dueS += (Number(x.total) || 0) - (typeof x.paid === 'number' ? x.paid : (x.paid ? Number(x.total) || 0 : 0));
      });
      dueS = r2(dueS);
      return { name: sp.name, sub: [sp.phone, sp.email].filter(Boolean).join(' · ') || 'No phone or email saved',
        effects: ['Their purchases stay in your records and reports.'].concat(dueS > 0.009 ? ['They are still owed ' + money(dueS) + ' — that balance disappears with them.'] : []) };
    }
    if (kind === 'expense') {
      var ex = db.expenses.filter(function (x) { return x.id === id; })[0];
      if (!ex) return null;
      return { name: ex.category || 'Expense', sub: fmtDate(ex.date) + ' · ' + money(ex.amount),
        effects: ['It is removed from expenses and from your reports.'] };
    }
    if (kind === 'staff') {
      var st = staffById(id);
      if (!st) return null;
      return { name: st.name, sub: String(st.username || '') + ' · ' + String(st.role || '') ,
        effects: ['They can no longer sign in.', 'Their bills and activity stay in history.'] };
    }
    if (kind === 'damage') {
      var d = db.damages.filter(function (x) { return x.id === id; })[0];
      if (!d) return null;
      return { name: d.name || 'Damage entry', sub: fmtDate(d.date) + ' · ' + num(d.qty) + ' pcs',
        effects: d.adjusted
          ? (d.stockMoved ? [num(Math.abs(Number(d.stockMoved) || 0)) + ' go back into stock at ' + branchName(d.branchId) + '.']
            : ['It was settled, so stock is not touched.'])
          : ['It was never settled, so stock is not touched.'] };
    }
    if (kind === 'transfer') {
      var t = db.transfers.filter(function (x) { return x.id === id; })[0];
      if (!t) return null;
      return { name: t.no, sub: branchName(t.from) + ' → ' + branchName(t.to) + ' · ' + String(t.status || 'pending'),
        effects: t.status === 'accepted'
          ? ['The stock moves back from ' + branchName(t.to) + ' to ' + branchName(t.from) + '.']
          : ['It was never accepted, so stock is not touched.'] };
    }
    if (kind === 'complaint') {
      var cp = db.complaints.filter(function (x) { return x.id === id; })[0];
      if (!cp) return null;
      return { name: cp.no || 'Complaint', sub: [cp.itemName, cp.customerName || cp.supplierName].filter(Boolean).join(' · ') || 'No details',
        effects: ['It is removed from complaints and from the cloud copy.'] };
    }
    return null;
  }

  function deleteEntryModal(kind, id) {
    if (!canDeleteEntry(kind)) return toast('You do not have permission to delete this');
    var info = deleteEntryInfo(kind, id);
    if (!info) return toast('That entry is already gone');
    ui.delDraft = { kind: kind, id: id };
    openModal(DEL_KINDS[kind].title, `
      <div class="card" style="margin:0 0 12px">
        <div class="title" style="font-weight:600">${esc(info.name)}</div>
        <div class="sub">${esc(info.sub)}</div>
      </div>
      ${info.effects.length ? `<div class="sub" style="margin-bottom:10px">${info.effects.map(function (t) { return '• ' + esc(t); }).join('<br>')}</div>` : ''}
      <div class="sub" style="margin-bottom:14px;color:#dc2626">It is removed from here and from the cloud copy. Bills, items, parties and expenses wait in the bin for 7 days, so this can still be undone.</div>
      <div class="row-actions" style="justify-content:flex-end">
        <button class="btn" type="button" data-act="close-modal">Keep it</button>
        <button class="btn danger" type="button" data-act="del-yes">Delete</button>
      </div>`);
  }

  function transferPdf(id) {
    var t = db.transfers.filter(function (x) { return x.id === id; })[0];
    if (!t) return null;
    var C = pdfCtor();
    if (!C) return null;
    var doc = new C({ unit: 'pt', format: 'a4' });
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    var m = 36, y = 46;
    function ensure(h) { if (y + h > H - 46) { doc.addPage(); y = 46; } }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(String(db.settings.business || 'My Store'), m, y); y += 20;
    doc.setFontSize(11);
    doc.text('Stock transfer · ' + t.no, m, y); y += 16;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Date: ' + fmtDate(t.date) + '     Status: ' + String(t.status || '').toUpperCase(), m, y); y += 16;
    doc.setDrawColor(220, 224, 230);
    doc.line(m, y, W - m, y); y += 18;
    doc.setFontSize(10);
    doc.text('From: ' + branchName(t.from), m, y);
    doc.text('To: ' + branchName(t.to), W / 2, y); y += 14;
    doc.setFontSize(9);
    if (t.byName) { doc.text('Requested by: ' + t.byName, m, y); y += 12; }
    if (t.acceptedBy) { doc.text('Handled by: ' + t.acceptedBy, m, y); y += 12; }
    if (t.note) { doc.text('Note: ' + String(t.note).slice(0, 80), m, y); y += 12; }
    y += 8;

    doc.setFillColor(242, 244, 248);
    doc.rect(m, y - 10, W - m * 2, 16, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('Item', m + 6, y + 1);
    doc.text('Qty', W - m - 10, y + 1, { align: 'right' });
    y += 20;

    doc.setFont('helvetica', 'normal');
    var totalQty = 0;
    (t.lines || []).forEach(function (l, i) {
      ensure(16);
      if (i % 2) { doc.setFillColor(250, 251, 253); doc.rect(m, y - 10, W - m * 2, 15, 'F'); }
      doc.text(String(l.name || '').slice(0, 68), m + 6, y);
      doc.text(String(l.qty), W - m - 10, y, { align: 'right' });
      totalQty += Number(l.qty) || 0;
      y += 15;
    });

    ensure(24); y += 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Total lines: ' + (t.lines || []).length + '     Total quantity: ' + num(totalQty), m, y);
    y += 18;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
    doc.text('Generated on ' + fmtDate(today()), m, y);

    var blob = doc.output('blob');
    var url = '';
    try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
    return { url: url, blob: blob, name: pdfSafeName('Stock transfer ' + t.no + ' ' + t.date) };
  }

  function shareTransferPdf(id) {
    var p = transferPdf(id);
    if (!p) return toast('Could not create the PDF');
    try {
      if (navigator.share && typeof File === 'function' && p.blob) {
        var file = new File([p.blob], p.name + '.pdf', { type: 'application/pdf' });
        if (!navigator.canShare || navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: p.name, text: 'Stock transfer' }).catch(function () {});
          return;
        }
      }
    } catch (e) {}
    if (savePdfFile(p)) toast('PDF downloaded · ' + p.name + '.pdf');
    else toast('This browser cannot share the PDF');
  }

  function downloadTransferPdf(id) {
    var p = transferPdf(id);
    if (!p) return toast('Could not create the PDF');
    if (!savePdfFile(p)) return toast('This browser cannot save the PDF');
    toast('PDF downloaded · ' + p.name + '.pdf');
  }

  /* Stock at each branch before and after a transfer's units move. Pending
     requests show what accepting would do; accepted ones show what happened. */
  function transferFlow(t) {
    var map = {};
    (t.lines || []).forEach(function (l) {
      var it = itemById(l.itemId);
      var q = Number(l.qty) || 0;
      if (!it || !S.branchById(t.from) || !S.branchById(t.to)) { map[l.itemId] = null; return; }
      if (t.status === 'accepted') {
        var evs = applyStockFlow(it, itemHistory(it));
        var out = evs.filter(function (e) { return e.type === 'Transfer out' && e.trId === t.id; })[0];
        var inn = evs.filter(function (e) { return e.type === 'Transfer in' && e.trId === t.id; })[0];
        map[l.itemId] = {
          from: (out && out.flow && out.flow[t.from]) || null,
          to: (inn && inn.flow && inn.flow[t.to]) || null
        };
      } else if (t.status === 'pending') {
        var f0 = S.stockOf(it, t.from), t0 = S.stockOf(it, t.to);
        map[l.itemId] = {
          from: { before: f0, after: r2(f0 - q) },
          to: { before: t0, after: r2(t0 + q) }
        };
      } else {
        map[l.itemId] = null;
      }
    });
    return map;
  }

  function transferModal(id) {
    var t = db.transfers.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var badge = t.status === 'accepted' ? '<span class="badge ok">Accepted</span>'
      : t.status === 'rejected' ? '<span class="badge bad">Rejected</span>' : '<span class="badge warn">Pending</span>';
    var flow = transferFlow(t);
    var cell = function (fl) {
      return fl ? `${num(fl.before)} → <b>${num(fl.after)}</b>` : '<span class="sub">—</span>';
    };
    openModal(t.no, `
      <div class="grid2" style="margin-bottom:12px">
        <div><div class="sub">From</div><div style="font-weight:600">${esc(branchName(t.from))}</div></div>
        <div style="text-align:right"><div class="sub">To</div><div style="font-weight:600">${esc(branchName(t.to))}</div></div>
      </div>
      <div style="margin-bottom:12px">${badge} <span class="sub">Requested by ${esc(t.byName || '—')} on ${esc(fmtDate(t.date))}${t.acceptedBy ? ' · handled by ' + esc(t.acceptedBy) : ''}</span></div>
      <div class="table-wrap"><table class="data" style="min-width:0"><thead><tr><th>Item</th><th class="num">Qty</th><th>${esc(branchName(t.from))} stock</th><th>${esc(branchName(t.to))} stock</th></tr></thead>
      <tbody>${t.lines.map(function (l) {
        var f = flow[l.itemId] || {};
        return `<tr><td>${esc(l.name)}</td><td class="num">${num(l.qty)}</td>
          <td>${cell(f.from)}</td><td>${cell(f.to)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <div class="sub" style="margin-top:6px">Stock before → after ${t.status === 'pending' ? 'accepting' : t.status === 'accepted' ? 'this transfer' : 'the request'}.</div>
      <div class="row-actions" style="margin-top:16px">
        <button class="btn" data-act="tr-pdf-save" data-id="${t.id}">Download PDF</button>
        <button class="btn primary" data-act="tr-pdf" data-id="${t.id}">Share PDF</button>
        ${canDeleteEntry('transfer') ? `<button class="btn danger" data-act="del-ask" data-kind="transfer" data-id="${t.id}">Delete</button>` : ''}
      </div>
      ${t.status === 'pending' && t.to === ui.branch ? `<div class="row-actions" style="margin-top:10px">
        <button class="btn" data-act="tr-reject" data-id="${t.id}">Reject</button>
        <button class="btn primary" data-act="tr-accept" data-id="${t.id}">Accept transfer</button></div>` : ''}`);
  }

  /* ------------------------------------------------------------------ print */
  /* --------------------------------------------------------------- bill pdf */
  function pdfMoney(n) { return String(money(n)).replace(/\u20b9\s?/g, 'Rs '); }
  function pdfSafeName(t) {
    return String(t || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Bill';
  }

  function billPdfName(inv) {
    var c = findCust(inv.customerId);
    return pdfSafeName((c ? c.name : 'Walk-in customer') + ' - ' + inv.no + ' - ' + inv.date);
  }
  function pdfCtor() {
    var lib = window.jspdf || window.jsPDF;
    var C = lib && (lib.jsPDF || lib);
    return typeof C === 'function' ? C : null;
  }
  function drawQr(doc, text, x, y, size) {
    if (!window.qrcode || !text) return;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(String(text));
      qr.make();
      var n = qr.getModuleCount();
      var m = size / (n + 2);
      doc.setFillColor(255, 255, 255);
      doc.rect(x, y, size, size, 'F');
      doc.setFillColor(15, 23, 42);
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (qr.isDark(r, c)) doc.rect(x + m * (c + 1), y + m * (r + 1), m + 0.02, m + 0.02, 'F');
        }
      }
      return true;
    } catch (e) { return false; }
  }

  var BILL_LAYOUTS = [
    { id: 'a5', name: 'Sales invoice (A5 landscape)', paper: 'a5' },
    { id: 'modern', name: 'Modern band (A4)', paper: 'full' },
    { id: 'gst', name: 'Detailed tax invoice (A4)', paper: 'full' },
    { id: 'receipt', name: 'Small receipt (80 mm)', paper: 'receipt' }
  ];
  function billStyle(style) {
    for (var i = 0; i < BILL_LAYOUTS.length; i++) if (BILL_LAYOUTS[i].id === style) return style;
    return 'a5';
  }
  function billIsReceipt(style) { return billStyle(style) === 'receipt'; }
  function billPaper(style) {
    var id = billStyle(style);
    for (var i = 0; i < BILL_LAYOUTS.length; i++) if (BILL_LAYOUTS[i].id === id) return BILL_LAYOUTS[i].paper;
    return 'full';
  }
  function billLayoutName(style) {
    var id = billStyle(style);
    for (var i = 0; i < BILL_LAYOUTS.length; i++) if (BILL_LAYOUTS[i].id === id) return BILL_LAYOUTS[i].name;
    return 'Sales invoice (A5 landscape)';
  }
  /* short page name shown on the Share PDF button, so the button always says
     which page it will send */
  function billShortName(style) {
    var id = billStyle(style);
    if (id === 'a5') return 'A5';
    if (id === 'receipt') return '80 mm';
    if (id === 'gst') return 'A4 tax';
    return 'A4';
  }
  function billPdfName(inv, style) {
    var c = findCust(inv.customerId);
    var base = pdfSafeName((c ? c.name : 'Walk-in customer') + ' - ' + inv.no + ' - ' + inv.date);
    var st = billStyle(style);
    if (st === 'a5') return base;
    return base + ' - ' + pdfSafeName(st);
  }

  function payMixText(inv) {
    var pays = (inv.payments || []).filter(function (p) { return Number(p.amount) > 0; });
    if (!pays.length) {
      var amt = r2(Number(inv.paid) || 0);
      return amt > 0 ? (inv.method || 'Cash') + ' ' + money(amt) : (inv.method || 'Cash');
    }
    return pays.map(function (p) { return (p.method || 'Cash') + ' ' + money(p.amount); }).join(' · ');
  }

  function billDiscParts(inv) {
    var dtype = (db.settings && db.settings.discountType === 'percent') ? 'percent' : 'amount';
    var sub = 0, lineDisc = 0;
    (inv.lines || []).forEach(function (l) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      sub += ls;
      lineDisc += Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
    });
    sub = r2(sub); lineDisc = r2(lineDisc);
    var afterLine = r2(Math.max(0, sub - lineDisc));
    var billIn = Math.max(0, Number(inv.discount) || 0);
    var billDisc = dtype === 'percent' ? r2(afterLine * billIn / 100) : r2(billIn);
    billDisc = Math.min(afterLine, billDisc);
    return { lineDisc: lineDisc, billDisc: r2(billDisc) };
  }

  function billData(inv) {
    var s = db.settings;
    var est = !!inv.isEstimate;
    var t = S.compute(inv.lines, inv.discount, inv.taxRate, invoiceCharges(inv), { roundOff: (typeof inv.roundOff === 'number' ? inv.roundOff : 0) });
    var discParts = billDiscParts(inv);
    var c = findCust(inv.customerId), st = staffById(inv.staffId), br = S.branchById(inv.branchId);
    var due = est ? 0 : r2(inv.total - inv.paid);
    var pays = est ? [] : (inv.payments || []).filter(function (x) { return Number(x.amount) > 0; });
    var addr = s.invoiceAddress || ((br ? br.name : '') + (br && br.address ? ' · ' + br.address : ''));
    var terms = s.printTerms !== false ? termsList() : [];
    var charges = invoiceCharges(inv);
    /* a quote asks for nothing yet, so no amount-due QR or bank block */
    var bank = (est || s.showBankOnInvoice === false) ? [] : [
      s.bankName ? 'Bank ' + s.bankName : '',
      s.bankAccountName ? 'A/c name ' + s.bankAccountName : '',
      s.bankAccount ? 'A/c ' + s.bankAccount : '',
      s.bankIfsc ? 'IFSC ' + s.bankIfsc : '',
      s.upiId ? 'UPI ' + s.upiId : ''
    ].filter(Boolean);
    var status = est ? { cls: 'unpaid', txt: 'Estimate · not a sale' }
      : due <= 0.009 ? { cls: 'paid', txt: 'Paid in full' }
      : inv.paid > 0.009 ? { cls: 'part', txt: 'Balance ' + money(due) }
      : { cls: 'unpaid', txt: 'Unpaid' };
    var contact = [s.phone, s.email].filter(Boolean).join(' · ');
    return {
      s: s, t: t, lineDisc: discParts.lineDisc, billDisc: discParts.billDisc,
      c: c, st: st, br: br, due: due, pays: pays, addr: addr, terms: terms,
      charges: charges, bank: bank, status: status, contact: contact
    };
  }

  function billRowsHTML(inv) {
    var s = db.settings || {}, showDesc = s.printDescription !== false;
    var dec = s.printDecimals !== false, grp = s.amountGrouping !== false;
    return (inv.lines || []).map(function (l, n) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      var ld = Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
      var la = r2(ls - ld);
      var extraParts = [showDesc ? l.desc : '', l.imei ? 'IMEI ' + l.imei : '', l.serial ? 'S/N ' + l.serial : '', ld > 0 ? 'Item disc ' + billMoney(ld, s) : ''].filter(Boolean);
      var extra = extraParts.map(esc).join(' · ');
      return `<tr><td class="idx">${n + 1}</td>
        <td class="item"><span class="inv-item">${esc(l.name)}</span>${extra ? `<span class="inv-item-sub">${extra}</span>` : ''}</td>
        <td class="num">${num(l.qty)}</td><td class="num">${billNumFmt(l.price, dec, grp)}</td><td class="num amt">${billNumFmt(la, dec, grp)}</td></tr>`;
    }).join('');
  }

  function billSumHTML(inv, d) {
    var s = db.settings || {}, bmon = function(n){ return billMoney(n,s); };
    var sum = function (label, val, cls) {
      return `<div class="inv-sum-row${cls ? ' ' + cls : ''}"><span>${label}</span><span>${val}</span></div>`;
    };
    var received = Number(inv.paid);
    if (!(received > 0) && d.pays.length) received = r2(d.pays.reduce(function(a,x){return a+(Number(x.amount)||0);},0));
    var prev = 0;
    if (inv.customerId && s.printCurrentBalance !== false) {
      db.invoices.forEach(function (i) {
        if (i.id === inv.id || (i.customerId || '') !== inv.customerId) return;
        var dd = r2(i.total - i.paid);
        if (dd > 0.009) prev = r2(prev + dd);
      });
    }
    var out = sum('Sub Total', bmon(d.t.subtotal));
    if ((Number(d.lineDisc) || 0) > 0) out += sum('Item discounts', '− ' + bmon(d.lineDisc));
    if ((Number(d.billDisc) || 0) > 0) out += sum('Bill discount', '− ' + bmon(d.billDisc));
    if (s.printTaxDetails === false ? false : Number(inv.taxRate)) out += sum('Tax ' + num(inv.taxRate) + '%', bmon(d.t.tax));
    out += d.charges.map(function (ch) { return sum(esc(ch.name), bmon(ch.amount)); }).join('');
    if (d.t.roundOff) out += sum('Round off', (d.t.roundOff > 0 ? '+ ' : '− ') + bmon(Math.abs(d.t.roundOff)));
    out += sum('Total', bmon(d.t.total) + ' (' + esc(amountInWords(d.t.total, s.amountWordsFormat || 'indian')) + ')', 'total');
    if (s.printReceived !== false) {
      out += d.pays.length
        ? d.pays.map(function (x) { return sum(esc(x.method), bmon(x.amount), 'paid'); }).join('')
        : (Number(inv.paid) > 0 ? sum('Paid', bmon(inv.paid), 'paid') : '');
    }
    var emi = inv.emi;
    if (emi && (emi.finance || emi.monthly || emi.months || emi.date)) {
      if (emi.finance) out += sum('Finance', esc(emi.finance));
      if (emi.monthly) out += sum('Monthly EMI', bmon(emi.monthly));
      if (emi.date) out += sum('EMI starts', esc(fmtDate(emi.date)));
      if (emi.months) out += sum('Tenure', num(emi.months) + (emi.months === 1 ? ' month' : ' months'));
    }
    if (s.printBalance !== false && d.due > 0.009) out += sum('Balance due', bmon(d.due), 'due');
    if (s.printCurrentBalance !== false && !inv.isEstimate) out += sum('Current balance', bmon(r2(prev + d.due)), 'due');
    var saved = r2((Number(d.lineDisc)||0) + (Number(d.billDisc)||0));
    if (s.printYouSaved !== false && saved > 0) out += sum('You saved', bmon(saved));
    return out;
  }

  function billNotesHTML(inv, d) {
    var qr = qrHTML(inv.isEstimate ? d.t.total : (d.due > 0 ? d.due : d.t.total), inv.no, 'inv-qr');
    var hasPay = qr || d.bank.length;
    var s = db.settings || {};
    return `
      <div class="inv-notes">
        ${hasPay ? `<div class="inv-pay-row${qr && d.bank.length ? '' : ' single'}">
          ${qr ? `<div class="inv-block inv-block-qr">${qr}</div>` : ''}
          ${d.bank.length ? `<div class="inv-block inv-block-bank"><div class="inv-kicker">Bank details</div>
            <div class="inv-lines">${d.bank.map(function (x) { return `<span>${esc(x)}</span>`; }).join('')}</div></div>` : ''}
        </div>` : ''}
        ${s.printDescription !== false && inv.note ? `<div class="inv-block"><div class="inv-kicker">Note</div><div class="inv-line">${esc(inv.note)}</div></div>` : ''}
        ${s.printTerms !== false && d.terms.length ? `<div class="inv-block"><div class="inv-kicker">Terms</div>
          <div class="inv-terms">${d.terms.slice(0, 6).map(function (x, i) {
            return `<div class="inv-term"><b>${i + 1}.</b><span>${esc(x)}</span></div>`;
          }).join('')}</div></div>` : ''}
      </div>`;
  }

  function billFieldsHTML(inv) {
    if (!(inv.fields || []).length) return '';
    return `<div class="inv-tags">${inv.fields.map(function (f) {
      return `<span class="inv-tag"><i>${esc(f.label)}</i>${esc(f.value)}</span>`;
    }).join('')}</div>`;
  }

  function billFullHTML(inv, layout) {
    layout = billStyle(layout);
    if (layout === 'receipt') return billReceiptHTML(inv);
    if (layout === 'a5') return billA5HTML(inv);
    var d = billData(inv);
    var s = d.s;
    var logo = (s.printLogo !== false && s.logo) ? `<img class="inv-logo" src="${s.logo}" alt="">` : '';
    var parts = [];
    if (s.printPhone !== false && s.phone) parts.push(s.phone);
    if (s.printEmail !== false && s.email) parts.push(s.email);
    if (s.printGstin && s.gstin) parts.push('GSTIN: ' + s.gstin);
    var contactLine = parts.filter(Boolean).join(' · ');
    var showName = s.printCompanyName !== false;
    var showAddr = s.printAddress !== false && d.addr;
    var ttl = billTitle(layout, inv) + (s.printOriginalDuplicate ? ' (Original)' : '');
    var head = '';

    if (layout === 'modern') {
      head = `<header class="inv-band">
        <div class="inv-band-brand">
          ${logo}
          ${showName ? `<div class="inv-biz">${esc(s.business)}</div>` : ''}
          ${showAddr ? `<div class="inv-line">${esc(d.addr)}</div>` : ''}
          ${contactLine ? `<div class="inv-line">${esc(contactLine)}</div>` : ''}
        </div>
        <div class="inv-band-id">
          <div class="inv-kicker">${esc(ttl)}</div>
          <div class="inv-no">${esc(inv.no)}</div>
          <div class="inv-line">${esc(fmtDate(inv.date))}</div>
          <div class="inv-pill ${d.status.cls}">${d.status.txt}</div>
        </div>
      </header>
      <div class="inv-strip">
        <div class="inv-cell"><div class="inv-kicker">Billed to</div>
          <div class="inv-strong">${esc(d.c ? d.c.name : 'Walk-in customer')}</div>
          ${d.c && d.c.phone ? `<div class="inv-line">${esc(d.c.phone)}</div>` : ''}</div>
        <div class="inv-cell"><div class="inv-kicker">Branch</div><div class="inv-strong">${esc(d.br ? d.br.name : '—')}</div></div>
        <div class="inv-cell"><div class="inv-kicker">Billed by</div><div class="inv-strong">${esc(d.st ? d.st.name : '—')}</div></div>
        ${inv.isEstimate ? '' : `<div class="inv-cell"><div class="inv-kicker">Payment</div><div class="inv-strong">${esc(payMixText(inv))}</div></div>`}
      </div>`;
    } else if (layout === 'gst') {
      head = `<header class="inv-gst-head">
        ${logo ? `<div class="inv-gst-logo">${logo}</div>` : ''}
        ${showName ? `<div class="inv-biz">${esc(s.business)}</div>` : ''}
        ${showAddr ? `<div class="inv-line">${esc(d.addr)}</div>` : ''}
        ${contactLine ? `<div class="inv-line">${esc(contactLine)}</div>` : ''}
        <div class="inv-gst-title">${esc(ttl)}</div>
      </header>
      <div class="inv-gst-meta">
        <div><span>${inv.isEstimate ? 'Estimate no.' : 'Invoice no.'}</span><b>${esc(inv.no)}</b></div>
        <div><span>Date</span><b>${esc(fmtDate(inv.date))}</b></div>
        <div><span>Branch</span><b>${esc(d.br ? d.br.name : '—')}</b></div>
        ${inv.isEstimate ? '' : `<div><span>Payment</span><b>${esc(payMixText(inv))}</b></div>`}
      </div>
      <div class="inv-gst-parties">
        <div class="inv-gst-party"><span>Billed to</span>
          <b>${esc(d.c ? d.c.name : 'Walk-in customer')}</b>
          ${d.c && d.c.phone ? `<div class="inv-line">${esc(d.c.phone)}</div>` : ''}
          ${d.c && d.c.address ? `<div class="inv-line">${esc(d.c.address)}</div>` : ''}</div>
        <div class="inv-gst-party"><span>Billed by</span>
          <b>${esc(d.st ? d.st.name : '—')}</b>
          <div class="inv-line">${esc(d.br ? d.br.name : '—')}</div></div>
      </div>`;
    }

    var sigParts = [];
    /* obey the setting for every layout, including GST, so it can be turned off */
    if (s.printSignature) sigParts.push(`<div class="inv-sign-box"><div class="inv-line">For ${esc(s.business)}</div><div class="inv-sign-line"></div><div class="inv-kicker">${esc(s.signatureText || 'Authorised signatory')}</div></div>`);
    if (s.printReceivedBy) sigParts.push(`<div class="inv-sign-box"><div class="inv-sign-line"></div><div class="inv-kicker">Received by</div></div>`);
    if (s.printDeliveredBy) sigParts.push(`<div class="inv-sign-box"><div class="inv-sign-line"></div><div class="inv-kicker">Delivered by</div></div>`);
    var signature = sigParts.length ? `<div class="inv-sign">${sigParts.join('')}</div>` : '';

    return `
      <div class="${invDocClass(layout)}">
        ${head}
        ${billFieldsHTML(inv)}
        <table class="inv-table">
          <thead><tr><th class="idx">#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
          <tbody>${billRowsHTML(inv)}</tbody>
        </table>
        <div class="inv-lower">
          ${billNotesHTML(inv, d)}
          <div class="inv-sum">${billSumHTML(inv, d)}</div>
        </div>
        ${signature}
        ${s.printAcknowledgement ? `<div class="inv-block" style="margin-top:6px"><div class="inv-line"><b>Acknowledgement:</b> Received with thanks.</div></div>` : ''}
        <footer class="inv-foot">
          <span>${inv.isEstimate ? 'Estimate only — not a tax invoice.' : (d.due > 0.009 ? 'Please pay the balance by the due date.' : 'Paid in full — thank you.')}</span>
          <span>${showName ? esc(s.business) : ''}${showName && s.printPhone!==false && s.phone ? ' · ' : ''}${s.printPhone!==false && s.phone ? esc(s.phone) : ''}</span>
        </footer>
      </div>
    `;
  }

  /* ---- words for the total ---- */
  var IN_W1 = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var IN_W2 = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function inTwo(n) {
    if (n < 20) return IN_W1[n];
    return IN_W2[Math.floor(n / 10)] + (n % 10 ? ' ' + IN_W1[n % 10] : '');
  }
  function inThree(n) {
    var h = Math.floor(n / 100), r = n % 100;
    return (h ? IN_W1[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? inTwo(r) : '');
  }
  function inIndian(n) {
    if (!n) return 'Zero';
    var parts = [], cr = Math.floor(n / 10000000), lk, th;
    n = n % 10000000;
    lk = Math.floor(n / 100000); n = n % 100000;
    th = Math.floor(n / 1000); n = n % 1000;
    if (cr) parts.push(inIndian(cr) + ' Crore');
    if (lk) parts.push(inTwo(lk) + ' Lakh');
    if (th) parts.push(inTwo(th) + ' Thousand');
    if (n) parts.push(inThree(n));
    return parts.join(' ');
  }
  function inIntl(n) {
    if (!n) return 'Zero';
    var parts = [], b = Math.floor(n / 1000000000), m, th;
    n = n % 1000000000;
    m = Math.floor(n / 1000000); n = n % 1000000;
    th = Math.floor(n / 1000); n = n % 1000;
    if (b) parts.push(inIntl(b) + ' Billion');
    if (m) parts.push(inThree(m) + ' Million');
    if (th) parts.push(inThree(th) + ' Thousand');
    if (n) parts.push(inThree(n));
    return parts.join(' ');
  }
  function amountInWords(amount, fmt) {
    var v = Math.round((Number(amount) || 0) * 100);
    var rupees = Math.floor(v / 100), paise = v % 100;
    var words = (fmt === 'intl') ? inIntl(rupees) : inIndian(rupees);
    var out = words + ' Rupees';
    if (paise) out += ' and ' + inTwo(paise) + ' Paise';
    return out + ' Only';
  }

  function psOn(k, def) {
    var s = db.settings || {};
    return s[k] == null ? (def !== false) : !!s[k];
  }
  function billNumFmt(n, dec, group) {
    var v = Number(n) || 0;
    var d = dec === false ? 0 : 2;
    return v.toLocaleString(group === false ? 'en-US' : undefined, {
      useGrouping: group !== false, minimumFractionDigits: d, maximumFractionDigits: d
    });
  }
  function billMoney(n, s) {
    s = s || db.settings || {};
    var sym = s.currency || '\u20B9';
    var dec = s.printDecimals !== false;
    var grp = s.amountGrouping !== false;
    return sym + ' ' + billNumFmt(n, dec, grp);
  }
  function a5Num(n) { return billNumFmt(n, (db.settings||{}).printDecimals !== false, (db.settings||{}).amountGrouping !== false); }
  function billTitle(st, inv) {
    if (inv && inv.isEstimate) return 'Estimate';
    var s = db.settings || {}, name = String(s.txnSaleName || 'Invoice').trim() || 'Invoice';
    if (st === 'a5') return name === 'Invoice' ? 'Sales Invoice' : name;
    if (st === 'gst') return s.printBillOfSupply && s.taxOn === false ? 'Bill of Supply' : (name === 'Invoice' ? 'Tax invoice' : name);
    return name;
  }
  function invDocClass(st) {
    var s = db.settings || {}, cls = 'inv-doc layout-' + st;
    if (s.printTextSize === 'medium') cls += ' ptxt-md';
    else if (s.printTextSize === 'large') cls += ' ptxt-lg';
    if (s.expandTable) cls += ' p-expand';
    return cls;
  }

  /* A5 landscape "sales invoice" form */
  function billA5HTML(inv) {
    var d = billData(inv), s = d.s;
    var dec = s.printDecimals !== false, grp = s.amountGrouping !== false;
    var bmon = function(n){ return billMoney(n,s); };
    var bnum = function(n){ return billNumFmt(n, dec, grp); };
    var qr = qrHTML(inv.isEstimate ? d.t.total : (d.due > 0 ? d.due : d.t.total), inv.no, 'a5-qr');
    var delivery = ((inv.fields || []).filter(function (f) {
      return f && f.value && /(deliver|ship|address)/i.test(f.label || '');
    })[0] || {}).value || (d.c && d.c.address) || '';
    var received = Number(inv.paid);
    if (!(received > 0) && d.pays.length) {
      received = r2(d.pays.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0));
    }
    received = r2(received);
    var balance = d.due > 0.009 ? d.due : 0;
    var prev = 0;
    if (inv.customerId) {
      db.invoices.forEach(function (i) {
        if (i.id === inv.id || (i.customerId || '') !== inv.customerId) return;
        var dd = r2(i.total - i.paid);
        if (dd > 0.009) prev = r2(prev + dd);
      });
    }
    var gross = r2((inv.lines || []).reduce(function (a, l) { return a + (Number(l.qty) || 0) * (Number(l.price) || 0); }, 0));
    var disc = r2(d.t.discount || 0);
    var qtyTot = r2((inv.lines || []).reduce(function (a, l) { return a + (Number(l.qty) || 0); }, 0));
    var showDesc = s.printDescription !== false;
    var minRows = Math.max(0, Math.min(30, Math.floor(Number(s.minRows) || 0)));
    var rowsArr = (inv.lines || []).map(function (l, i) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      var ld = Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
      var amt = r2(ls - ld);
      return `<tr>
        <td class="c">${i + 1}</td>
        <td class="name">${esc(l.name)}${showDesc && l.desc ? `<span class="sub2">${esc(l.desc)}</span>` : ''}${ld > 0 ? `<span class="sub2">Item disc − ${bmon(ld)}</span>` : ''}</td>
        <td>${esc(l.color || '—')}</td>
        <td class="n">${num(l.qty)}</td>
        <td class="n">${bnum(l.price)}</td>
        <td class="n">${bnum(amt)}</td>
      </tr>`;
    });
    while (rowsArr.length < minRows) rowsArr.push('<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>');
    var rows = rowsArr.join('');
    var logo = (s.printLogo !== false && s.logo) ? `<img class="a5-logo" src="${s.logo}" alt="">` : '';
    var showName = s.printCompanyName !== false;
    var showAddr = s.printAddress !== false && d.addr;
    var showPhone = s.printPhone !== false && s.phone;
    var showEmail = s.printEmail !== false && s.email;
    var showGstin = !!(s.printGstin && s.gstin);
    var title = billTitle('a5', inv) + (s.printOriginalDuplicate ? ' (Original)' : '');
    var topSpace = s.extraTopSpace ? `<div style="height:${Math.max(0,Math.min(30,s.extraTopSpace|0))}mm"></div>` : '';
    var showQty = s.printTotalQty !== false;
    var showRecv = s.printReceived !== false;
    var showBal = s.printBalance !== false;
    var showCurBal = s.printCurrentBalance !== false;
    var showYouSaved = s.printYouSaved !== false;
    var showPayMode = s.printPaymentMode !== false;
    var showTerms = s.printTerms !== false && d.terms.length;
    var amtRow = `<div>Total: <b>${bmon(d.t.total)}</b><span class="a5-words">(${esc(amountInWords(d.t.total, s.amountWordsFormat || 'indian'))})</span></div>`;
    var strip5 = [];
    if (showRecv && !inv.isEstimate) strip5.push(`<div>Received: <b>${bmon(received)}</b></div>`);
    if (showBal && !inv.isEstimate) strip5.push(`<div>Balance: <b>${bmon(balance)}</b></div>`);
    if (showCurBal && !inv.isEstimate) strip5.push(`<div>Previous Balance: <b>${bmon(prev)}</b></div>`);
    if (showCurBal && !inv.isEstimate) strip5.push(`<div>Current Balance: <b>${bmon(r2(prev + balance))}</b></div>`);
    var _savedA5 = r2((Number(d.lineDisc)||0) + (Number(d.billDisc)||0));
    if (showYouSaved && _savedA5 > 0) strip5.push(`<div>You Saved: <b>${bmon(_savedA5)}</b></div>`);
    var footBits = [];
    if (s.printSignature) footBits.push(`<div class="a5-sign"><div class="inv-sign-line"></div><div>${esc(s.signatureText || 'Authorised signatory')}</div></div>`);
    if (s.printReceivedBy) footBits.push(`<div class="a5-sign"><div class="inv-sign-line"></div><div>Received by</div></div>`);
    if (s.printDeliveredBy) footBits.push(`<div class="a5-sign"><div class="inv-sign-line"></div><div>Delivered by</div></div>`);
    return `
      <div class="${invDocClass('a5')}">
        ${topSpace}
        <div class="a5-title">${esc(title)}</div>
        <div class="a5-head${s.printRepeatHeader ? ' p-repeat' : ''}">
          <div class="a5-head-left">
            ${logo}
            <div class="a5-biz">
              ${showName ? `<div class="a5-biz-name ${s.companyNameSize==='large'?'cn-lg':s.companyNameSize==='small'?'cn-sm':''}">${esc(s.business)}${d.br ? ' - ' + esc(d.br.name) : ''}</div>` : ''}
              ${showAddr ? `<div class="a5-line">${esc(d.addr)}</div>` : ''}
              ${showPhone ? `<div class="a5-line">Phone: ${esc(s.phone)}</div>` : ''}
              ${showEmail ? `<div class="a5-line">${esc(s.email)}</div>` : ''}
              ${showGstin ? `<div class="a5-line">GSTIN: ${esc(s.gstin)}</div>` : ''}
            </div>
          </div>
          <div class="a5-head-right">
            <div>${inv.isEstimate ? 'Estimate No' : 'Invoice No'}: <b>${esc(inv.no)}</b></div>
            <div>Date: <b>${esc(fmtDate(inv.date))}</b></div>
            ${d.br ? `<div>Place of Supply: <b>${esc(d.br.name)}</b></div>` : ''}
          </div>
        </div>
        <div class="a5-billto">
          <div class="a5-billto-l">
            <div class="a5-k">Bill To:</div>
            <div class="a5-strong">${esc(d.c ? d.c.name : 'Walk-in customer')}</div>
            ${d.c && d.c.phone ? `<div>Contact No: ${esc(d.c.phone)}</div>` : ''}
          </div>
          ${delivery ? `<div class="a5-billto-r">
            <div class="a5-k">Delivery Address:</div>
            <div>${esc(delivery)}</div>
          </div>` : ''}
        </div>
        <table class="a5-table">
          <thead>
            <tr>
              <th class="c">#</th><th>Item Name</th><th>Colour</th>
              <th class="n">Quantity</th>
              <th class="n">Price / Unit (${esc(s.currency || '\u20B9')})</th>
              <th class="n">Amount (${esc(s.currency || '\u20B9')})</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
            <tr class="a5-total">
              <td colspan="3" class="a5-k">Total</td>
              <td class="n">${showQty ? num(qtyTot) : ''}</td>
              <td></td>
              <td class="n">${bnum(r2(d.t.subtotal - (Number(d.lineDisc) || 0)))}</td>
            </tr>
          </tbody>
        </table>
        <div class="a5-strip a5-strip-boxes" style="display:flex;flex-wrap:wrap;padding:0">
          <div style="padding:4px 8px;border-right:1px solid #111827">Sub Total: <b>${bmon(d.t.subtotal)}</b></div>
          ${d.lineDisc > 0 ? `<div style="padding:4px 8px;border-right:1px solid #111827">Item discounts: <b>− ${bmon(d.lineDisc)}</b></div>` : ''}
          ${d.billDisc > 0 ? `<div style="padding:4px 8px;border-right:1px solid #111827">Bill discount: <b>− ${bmon(d.billDisc)}</b></div>` : ''}
          ${d.t.roundOff ? `<div style="padding:4px 8px;border-right:1px solid #111827">Round off: <b>${d.t.roundOff > 0 ? '+ ' : '− '}${bmon(Math.abs(d.t.roundOff))}</b></div>` : ''}
          <div style="padding:4px 8px">Total: <b>${bmon(d.t.total)}</b> (${esc(amountInWords(d.t.total, s.amountWordsFormat || 'indian'))})</div>
        </div>
        ${strip5.length ? `<div class="a5-strip a5-strip-5">${strip5.join('')}</div>` : ''}
        ${showPayMode && !inv.isEstimate ? `<div class="a5-strip">Payment Mode: <b>${esc(payMixText(inv))}</b></div>` : ''}
        ${inv.emi && (inv.emi.finance || inv.emi.monthly || inv.emi.months) ? `<div class="a5-strip">EMI${inv.emi.finance ? `: <b>${esc(inv.emi.finance)}</b>` : ''}${inv.emi.monthly ? ` · <b>${bmon(inv.emi.monthly)}</b>/month` : ''}${inv.emi.months ? ` × ${num(inv.emi.months)} months` : ''}${inv.emi.date ? ` from ${esc(fmtDate(inv.emi.date))}` : ''}</div>` : ''}
        ${(qr || d.bank.length || showTerms) ? `<div class="a5-paybox">
          <div class="a5-pay-left">
            ${qr ? `<div class="a5-qr">${qr}</div>` : ''}
            ${inv.isEstimate ? `<div class="a5-bank"><div><b>Estimate only.</b></div><div>Not a sale and no stock issued. Scan the code to pay ${bmon(d.t.total)}.</div></div>` : ''}
            ${d.bank.length ? `<div class="a5-bank">
              ${s.bankName ? `<div>Bank Name: <b>${esc(s.bankName)}</b></div>` : ''}
              ${s.bankAccount ? `<div>Account No: <b>${esc(s.bankAccount)}</b></div>` : ''}
              ${s.bankIfsc ? `<div>IFSC code: <b>${esc(s.bankIfsc)}</b></div>` : ''}
              ${s.bankAccountName ? `<div>Account Holder's Name: <b>${esc(s.bankAccountName)}</b></div>` : ''}
              ${s.upiId ? `<div>UPI ID: <b>${esc(s.upiId)}</b></div>` : ''}
            </div>` : ''}
          </div>
          <div class="a5-pay-right">
            ${showTerms ? `<div class="a5-terms">
              <div class="a5-k">Terms And Conditions:</div>
              ${d.terms.slice(0, 4).map(function (x, i) { return `<div>${i + 1}. ${esc(x)}</div>`; }).join('')}
            </div>` : ''}
          </div>
        </div>` : ''}
        ${s.printAcknowledgement ? `<div class="a5-strip"><b>Acknowledgement:</b> Received with thanks.</div>` : ''}
        ${footBits.length ? `<div class="a5-signs">${footBits.join('')}</div>` : ''}
      </div>`;
  }

  function billDocHTML(inv, style) {
    var layout = billStyle(style);
    if (layout === 'receipt') return billReceiptHTML(inv);
    return billFullHTML(inv, layout);
  }

  function billReceiptHTML(inv) {
    var s = db.settings, t = S.compute(inv.lines, inv.discount, inv.taxRate, invoiceCharges(inv));
    var c = findCust(inv.customerId), st = staffById(inv.staffId), br = S.branchById(inv.branchId);
    var due = inv.isEstimate ? 0 : r2(inv.total - inv.paid);
    var pays = inv.isEstimate ? [] : (inv.payments || []).filter(function (x) { return Number(x.amount) > 0; });
    var addr = s.invoiceAddress || ((br ? br.name : '') + (br && br.address ? ', ' + br.address : ''));
    var terms = s.printTerms !== false ? termsList() : [];
    var charges = invoiceCharges(inv);
    /* the thermal receipt has no bank details block, so it keeps the UPI ID
       under the QR; the invoice layouts print the ID with the bank details. */
    var qr = qrHTML(inv.isEstimate ? t.total : (due > 0 ? due : t.total), inv.no, 'rcpt-qr', true);
    var bmon = function(n){ return billMoney(n,s); };
    var sum = function (label, val, cls) {
      return `<div class="rcpt-row${cls ? ' ' + cls : ''}"><span>${label}</span><span>${val}</span></div>`;
    };
    var contact = [s.printPhone!==false?s.phone:'', s.printEmail!==false?s.email:''].filter(Boolean).join(' · ');
    return `
      <div class="${invDocClass('receipt')}">
        ${s.printLogo!==false && s.logo ? `<div class="rcpt-center"><img class="rcpt-logo" src="${s.logo}" alt=""></div>` : ''}
        ${s.printCompanyName!==false ? `<div class="rcpt-center rcpt-biz">${esc(s.business)}</div>` : ''}
        ${s.printAddress!==false && addr ? `<div class="rcpt-center rcpt-sub">${esc(addr)}</div>` : ''}
        ${contact ? `<div class="rcpt-center rcpt-sub">${esc(contact)}</div>` : ''}
        <div class="rcpt-rule"></div>
        <div class="rcpt-center rcpt-strong">${esc(billTitle('receipt', inv) + ' ' + inv.no)}${s.printOriginalDuplicate ? ' (Original)' : ''}</div>
        <div class="rcpt-center rcpt-sub">${esc(fmtDate(inv.date))}${st ? ' · ' + esc(st.name) : ''}</div>
        <div class="rcpt-sub" style="margin-top:4px">${esc(c ? c.name : 'Walk-in customer')}${c && c.phone ? ' · ' + esc(c.phone) : ''}</div>
        <div class="rcpt-rule"></div>
        ${inv.lines.map(function (l) {
          var ls = r2((Number(l.qty)||0)*(Number(l.price)||0));
          var ld = Math.min(ls, Math.max(0, r2(Number(l.disc)||0)));
          var la = r2(ls - ld);
          var extra = [s.printDescription!==false?l.desc:'', l.imei ? 'IMEI ' + l.imei : '', l.serial ? 'S/N ' + l.serial : '', ld>0 ? 'Item disc ' + bmon(ld) : ''].filter(Boolean).map(esc).join(' · ');
          return `<div class="rcpt-item">
            <div class="rcpt-name">${esc(l.name)}</div>
            ${extra ? `<div class="rcpt-sub">${extra}</div>` : ''}
            <div class="rcpt-row"><span>${num(l.qty)} × ${bmon(l.price)}</span><span>${bmon(la)}</span></div>
          </div>`;
        }).join('')}
        <div class="rcpt-rule"></div>
        ${sum('Sub Total', bmon(t.subtotal))}
        ${((function(){var p=billDiscParts(inv); return p.lineDisc>0 ? sum('Item discounts', '− ' + bmon(p.lineDisc)) : ''; })())}
        ${((function(){var p=billDiscParts(inv); return p.billDisc>0 ? sum('Bill discount', '− ' + bmon(p.billDisc)) : ''; })())}
        ${(s.printTaxDetails && Number(inv.taxRate)) ? sum('Tax ' + num(inv.taxRate) + '%', bmon(t.tax)) : ''}
        ${charges.map(function (ch) { return sum(esc(ch.name), bmon(ch.amount)); }).join('')}
        ${t.roundOff ? sum('Round off', (t.roundOff > 0 ? '+ ' : '− ') + bmon(Math.abs(t.roundOff))) : ''}
        ${sum('Total', bmon(t.total) + ' (' + esc(amountInWords(t.total, s.amountWordsFormat || 'indian')) + ')', 'strong')}
        ${s.printReceived!==false ? (pays.length ? pays.map(function (x) { return sum(esc(x.method), bmon(x.amount)); }).join('') : (Number(inv.paid) > 0 ? sum('Paid', bmon(inv.paid)) : '')) : ''}
        ${s.printBalance!==false && due > 0.009 ? sum('Balance due', bmon(due), 'due') : ''}
        ${s.printPaymentMode!==false && !inv.isEstimate ? sum('Payment mode', esc(payMixText(inv))) : ''}
        ${inv.emi && inv.emi.finance ? sum('Finance', esc(inv.emi.finance)) : ''}
        ${inv.emi && inv.emi.monthly ? sum('Monthly EMI', bmon(inv.emi.monthly)) : ''}
        ${inv.emi && inv.emi.months ? sum('Tenure', num(inv.emi.months) + ' months') : ''}
        ${inv.emi && inv.emi.date ? sum('EMI starts', esc(fmtDate(inv.emi.date))) : ''}
        <div class="rcpt-rule"></div>
        ${qr ? `<div class="rcpt-center" style="margin:6px 0">${qr}</div>` : ''}
        ${s.printTerms!==false && terms.length ? `<div class="rcpt-sub" style="margin-top:4px">${terms.slice(0,4).map(function (x,i){ return (i+1)+'. '+esc(x); }).join('<br>')}</div>` : ''}
        ${s.printAcknowledgement ? `<div class="rcpt-center rcpt-sub" style="margin-top:4px">Received with thanks.</div>` : ''}
        <div class="rcpt-center rcpt-sub" style="margin-top:8px">${inv.isEstimate ? 'Estimate only — not a tax invoice.' : (due > 0.009 ? 'Balance due — please pay.' : 'Paid in full — thank you.')}</div>
      </div>`;
  }

  /* ---- PDF: rendered from the very same HTML the preview shows ---- */
  function docWidthPx(style) { return billStyle(style) === 'receipt' ? 302 : 703; }

  /* --------------------------------------------------- printed-page PDF (text)
     A5 / GST / Modern pages are drawn as real text and rules, so the file stays
     small, the words can be searched and nothing is blurry when zoomed. Only the
     80mm receipt still needs a picture, because it is a narrow layout with
     wrapped item names. */
  function pdfMoney(n) {
    var v = Number(n) || 0;
    var neg = v < 0;
    v = Math.abs(v);
    var s = v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '-Rs ' : 'Rs ') + s;
  }
  function pdfQty(n) {
    var v = Number(n) || 0;
    return (Math.round(v * 1000) / 1000).toLocaleString('en-IN');
  }

  function buildTextPdf(inv, style) {
    var C = pdfCtor();
    if (!C) return null;
    var st = billStyle(style);
    var d = billData(inv);
    var s = d.s || {};
    var a5 = st === 'a5';
    var doc = a5
      ? new C({ unit: 'mm', format: 'a5', orientation: 'landscape' })
      : new C({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    var W = doc.internal.pageSize.getWidth();
    var H = doc.internal.pageSize.getHeight();
    var m = a5 ? 10 : 15;
    var right = W - m;
    var y = m;
    var small = a5 ? 7.2 : 8.2;
    var body = a5 ? 8.4 : 9.4;
    var head = a5 ? 12 : 15;
    var ink = function (r, g, b) { doc.setTextColor(r, g, b); };
    var rule = function (yy, faint) {
      doc.setDrawColor(faint ? 226 : 205, faint ? 230 : 210, faint ? 236 : 216);
      doc.setLineWidth(faint ? 0.15 : 0.25);
      doc.line(m, yy, right, yy);
    };
    var ensure = function (h) {
      if (y + h <= H - m) return;
      doc.addPage();
      y = m;
    };

    /* --------------------------------------------------------------- heading */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(head);
    ink(17, 24, 39);
    doc.text(String(s.business || 'My Store'), m, y + 4);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(small + 1);
    ink(90, 100, 115);
    doc.text(inv.isEstimate ? 'ESTIMATE' : (s.gstin ? 'TAX INVOICE' : 'INVOICE'), right, y + 4, { align: 'right' });

    y += 9;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(small);
    ink(75, 85, 99);
    var linesA = [];
    if (d.br) linesA.push(d.br.name + (d.br.address ? ' · ' + d.br.address : ''));
    else if (d.addr) linesA.push(String(d.addr));
    if (d.contact) linesA.push(String(d.contact));
    if (s.gstin) linesA.push('GSTIN ' + s.gstin);
    linesA.forEach(function (t) {
      var wrapped = doc.splitTextToSize(String(t), right - m - 55);
      wrapped.forEach(function (ln) { doc.text(ln, m, y); y += small * 0.52 + 1.1; });
    });

    /* meta block sits on the right, level with the shop block */
    var metaY = m + 9;
    var meta = [
      ['No', String(inv.no)],
      ['Date', fmtDate(inv.date)],
      ['Branch', branchName(inv.branchId)]
    ];
    if (d.st) meta.push(['By', String(d.st.name)]);
    meta.forEach(function (row) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small);
      ink(120, 128, 140);
      doc.text(row[0], right - 42, metaY, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      ink(17, 24, 39);
      doc.text(String(row[1]), right, metaY, { align: 'right' });
      metaY += small * 0.52 + 1.3;
    });

    y = Math.max(y, metaY) + 1.5;
    rule(y);
    y += 5;

    /* ------------------------------------------------------------- bill to */
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(small);
    ink(120, 128, 140);
    doc.text(inv.isEstimate ? 'QUOTE FOR' : 'BILL TO', m, y);
    y += small * 0.52 + 1.4;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(body);
    ink(17, 24, 39);
    doc.text(String(d.c ? d.c.name : 'Walk-in customer'), m, y);
    y += body * 0.46 + 1.2;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(small);
    ink(75, 85, 99);
    var who = [];
    if (d.c) {
      if (d.c.phone) who.push('Phone ' + d.c.phone);
      if (d.c.gstin) who.push('GSTIN ' + d.c.gstin);
      if (d.c.address) who.push(String(d.c.address));
    }
    if (!who.length) who.push('No phone or address saved');
    who.forEach(function (t) {
      doc.splitTextToSize(String(t), right - m).forEach(function (ln) { doc.text(ln, m, y); y += small * 0.52 + 1.1; });
    });

    /* status chip on the right */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(small);
    ink(d.status.cls === 'paid' ? 16 : d.status.cls === 'part' ? 180 : 190,
        d.status.cls === 'paid' ? 122 : d.status.cls === 'part' ? 120 : 30,
        d.status.cls === 'paid' ? 87 : 20);
    doc.text(String(d.status.txt), right, y - (who.length * (small * 0.52 + 1.1)) - body * 0.46 - 1.2 + (who.length ? 0 : 0), { align: 'right' });

    y += 3;
    rule(y, true);
    y += 2;

    /* --------------------------------------------------------------- table */
    var cols = a5
      ? { idx: 8, item: 0, qty: 16, rate: 26, amt: 30 }
      : { idx: 9, item: 0, qty: 18, rate: 30, amt: 34 };
    var xAmt = right - cols.amt;
    var xRate = xAmt - cols.rate;
    var xQty = xRate - cols.qty;
    var xIdx = m;
    var xItem = xIdx + cols.idx + 2;
    var itemW = xQty - xItem - 2;

    var tableHead = function () {
      doc.setFillColor(244, 246, 249);
      doc.rect(m, y - 3.6, right - m, 6.4, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(small);
      ink(90, 100, 115);
      doc.text('#', xIdx + 1, y);
      doc.text('ITEM', xItem, y);
      doc.text('QTY', xQty + cols.qty - 2, y, { align: 'right' });
      doc.text('RATE', xRate + cols.rate - 2, y, { align: 'right' });
      doc.text('AMOUNT', xAmt + cols.amt, y, { align: 'right' });
      y += 5;
      rule(y - 1.4, true);
    };
    tableHead();

    var showDesc = s.printDescription !== false;
    (inv.lines || []).forEach(function (l, n) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      var ld = Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
      var la = r2(ls - ld);
      var bits = [];
      if (showDesc && l.desc) bits.push(String(l.desc));
      if (l.imei) bits.push('IMEI ' + l.imei);
      if (l.serial) bits.push('S/N ' + l.serial);
      if (ld > 0) bits.push('Item discount ' + pdfMoney(ld));
      var nameLines = doc.splitTextToSize(String(l.name || ''), itemW);
      var bitLines = [];
      bits.forEach(function (b) {
        doc.setFontSize(small - 0.6);
        bitLines = bitLines.concat(doc.splitTextToSize(b, itemW));
      });
      var rowH = nameLines.length * (body * 0.46 + 1.1) + bitLines.length * (small * 0.5 + 0.9) + 2.4;
      if (y + rowH > H - m - 24) { doc.addPage(); y = m; tableHead(); }
      var firstY = y;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small);
      ink(120, 128, 140);
      doc.text(String(n + 1), xIdx + 1, firstY);
      doc.setFontSize(body);
      ink(17, 24, 39);
      nameLines.forEach(function (ln) { doc.text(ln, xItem, y); y += body * 0.46 + 1.1; });
      if (bitLines.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(small - 0.6);
        ink(120, 128, 140);
        bitLines.forEach(function (ln) { doc.text(ln, xItem, y); y += small * 0.5 + 0.9; });
      }
      var lineY = firstY; /* the numbers ride the first line of the row */
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small + 0.4);
      ink(17, 24, 39);
      doc.text(pdfQty(l.qty), xQty + cols.qty - 2, lineY, { align: 'right' });
      doc.text(pdfMoney(l.price), xRate + cols.rate - 2, lineY, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      doc.text(pdfMoney(la), xAmt + cols.amt, lineY, { align: 'right' });
      y += 1.6;
      rule(y - 0.8, true);
      y += 1;
    });
    y += 2;

    /* -------------------------------------------------------------- totals */
    var paidNow = Number(inv.paid) || 0;
    if (!(paidNow > 0) && d.pays.length) {
      paidNow = r2(d.pays.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0));
    }
    var rows = [['Sub total', pdfMoney(d.t.subtotal)]];
    if ((Number(d.lineDisc) || 0) > 0) rows.push(['Item discounts', '- ' + pdfMoney(d.lineDisc)]);
    if ((Number(d.billDisc) || 0) > 0) rows.push(['Bill discount', '- ' + pdfMoney(d.billDisc)]);
    if (s.printTaxDetails !== false && Number(inv.taxRate)) rows.push(['Tax ' + num(inv.taxRate) + '%', pdfMoney(d.t.tax)]);
    d.charges.forEach(function (ch) { rows.push([String(ch.name), pdfMoney(ch.amount)]); });
    if (d.t.roundOff) rows.push(['Round off', (d.t.roundOff > 0 ? '+ ' : '- ') + pdfMoney(Math.abs(d.t.roundOff))]);
    var showPaid = s.printReceived !== false;
    if (showPaid) {
      d.pays.forEach(function (p) { rows.push([String(p.method || 'Paid'), pdfMoney(p.amount)]); });
      if (paidNow > 0.009) rows.push(['Received', pdfMoney(paidNow)]);
      if (!inv.isEstimate) rows.push(['Balance due', pdfMoney(d.due)]);
    }

    var boxW = a5 ? 72 : 80;
    var boxX = right - boxW;
    var step = small * 0.52 + 2.6;
    var need = rows.length * step + 14;
    ensure(need);
    var blockTop = y;
    var ty = blockTop;
    rows.forEach(function (r) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small);
      ink(75, 85, 99);
      doc.text(String(r[0]), boxX, ty);
      doc.setFont('helvetica', 'bold');
      ink(17, 24, 39);
      doc.text(String(r[1]), right, ty, { align: 'right' });
      ty += step;
    });
    ty += 1;
    doc.setFillColor(17, 24, 39);
    doc.rect(boxX - 3, ty - 4.2, boxW + 3, 8.6, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(body + 1);
    doc.text('TOTAL', boxX, ty + 1.6);
    doc.text(pdfMoney(d.t.total), right - 1.5, ty + 1.6, { align: 'right' });
    var blockBottom = ty + 9;

    /* the left column carries the words, the bank details and the terms, so a
       normal bill stays on one sheet instead of pushing a half-empty page */
    var leftW = boxX - m - 8;
    var lh = a5 ? small * 0.52 + 0.7 : small * 0.52 + 1.3;
    var lf = a5 ? small - 1.2 : small;
    var ly = blockTop;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(lf);
    ink(75, 85, 99);
    var words = doc.splitTextToSize((inv.isEstimate ? 'Quoted: ' : 'Amount in words: ') +
      amountInWords(d.t.total, s.amountWordsFormat || 'indian'), leftW);
    words.forEach(function (ln) { doc.text(ln, m, ly); ly += lh; });

    var section = function (title, list, bullet) {
      if (!list.length) return;
      ly += a5 ? 2.4 : 3.5;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(lf);
      ink(90, 100, 115);
      doc.text(title, m, ly);
      ly += lh + 0.6;
      doc.setFont('helvetica', 'normal');
      ink(75, 85, 99);
      list.forEach(function (t) {
        doc.splitTextToSize((bullet || '') + String(t), leftW).forEach(function (ln) {
          if (ly > H - m - 4) return;
          doc.text(ln, m, ly);
          ly += lh;
        });
      });
    };
    /* an 80mm-wide page has no room for one line per bank field, so A5 keeps it
       as one wrapped sentence */
    if (!inv.isEstimate && s.showBankOnInvoice !== false) {
      section('PAYMENT DETAILS', a5 ? [d.bank.join(' · ')] : d.bank);
    }
    section('TERMS', a5 ? [d.terms.slice(0, 4).join(' · ')] : d.terms.slice(0, 6), a5 ? '' : '• ');

    y = Math.max(blockBottom, ly) + 4;

    /* signature: sit it near the foot of the page, and let it go rather than
       spilling a whole second sheet for one line */
    if (y <= H - m - 12) {
      var sigY = Math.max(y + 6, H - m - 15);
      doc.setDrawColor(205, 210, 216);
      doc.setLineWidth(0.2);
      doc.line(right - 48, sigY + 8, right, sigY + 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small);
      ink(120, 128, 140);
      doc.text('For ' + String(s.business || ''), right, sigY + 12.5, { align: 'right' });
    }

    var pages = doc.internal.getNumberOfPages();
    for (var p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(small - 1.2);
      ink(150, 158, 170);
      doc.text(billLayoutName(st) + ' · ' + String(inv.no) + ' · page ' + p + ' of ' + pages, m, H - 5);
      doc.text(String(s.business || ''), right, H - 5, { align: 'right' });
    }
    return doc;
  }

  function buildDocCanvas(inv, style) {
    return ensureHtml2Canvas().then(function () {
      return new Promise(function (resolve, reject) {
        if (typeof window.html2canvas !== 'function') return reject(new Error('html2canvas not loaded'));
        var st = billStyle(style);
        var w = docWidthPx(st);
        var host = document.createElement('div');
        host.className = 'pdf-render';
        host.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + w + 'px;background:#fff;padding:0;margin:0;';
        host.innerHTML = `<div class="inv" style="width:${w}px;max-width:none">${billDocHTML(inv, st)}</div>`;
        document.body.appendChild(host);
        var imgs = Array.prototype.slice.call(host.querySelectorAll('img'));
        var loaded = imgs.map(function (im) {
          if (im.complete && im.naturalWidth) return Promise.resolve();
          return new Promise(function (res) {
            im.onload = res; im.onerror = res;
            setTimeout(res, 1500);
          });
        });
        var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        Promise.all(loaded.concat([fonts])).then(function () {
          return window.html2canvas(host.querySelector('.inv'), {
            backgroundColor: '#ffffff',
            scale: st === 'receipt' ? 4 : 2.5,
            useCORS: true,
            logging: false,
            windowWidth: 1280,
            windowHeight: 1600
          });
        }).then(function (canvas) {
          if (host.parentNode) host.parentNode.removeChild(host);
          resolve(canvas);
        }).catch(function (e) {
          if (host.parentNode) host.parentNode.removeChild(host);
          reject(e);
        });
      });
    });
  }

  /* look up from the bottom of a page for a row that is blank, a rule line, or
     just cell borders, so a page break never lands on top of table text */
  function cleanRowBefore(canvas, from, limit) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    for (var y = Math.round(from); y > limit; y -= 1) {
      var data;
      try { data = ctx.getImageData(0, y, w, 1).data; } catch (e) { return -1; }
      var dark = 0;
      for (var i = 0; i < data.length; i += 4) {
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 200) dark++;
      }
      var frac = dark / (data.length / 4);
      if (frac <= 0.05 || frac >= 0.9) return y;
    }
    return -1;
  }

  function sliceCanvasInto(doc, canvas, pxPerMm, contentW, marginX, marginY, pageContentH) {
    var pageHpx = pageContentH * pxPerMm;
    var y = 0;
    var first = true;
    while (y < canvas.height - 2) {
      var end = Math.min(canvas.height, y + pageHpx);
      if (end < canvas.height) {
        var floorY = y + pageHpx * 0.55;
        var cut = cleanRowBefore(canvas, end, floorY);
        if (cut > floorY) end = cut;
      }
      var hPx = Math.max(1, end - y);
      var tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = Math.ceil(hPx);
      var ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, y, canvas.width, hPx, 0, 0, canvas.width, hPx);
      if (!first) doc.addPage();
      doc.addImage(tmp.toDataURL('image/jpeg', 0.96), 'JPEG', marginX, marginY, contentW, hPx / pxPerMm);
      first = false;
      y = end;
    }
  }

  function pdfFromCanvas(canvas, style) {
    var C = pdfCtor();
    if (!C) return null;
    var receipt = billStyle(style) === 'receipt';
    var pxPerMm = canvas.width / (receipt ? 80 : 186);
    if (receipt) {
      var hMm = canvas.height / pxPerMm;
      if (hMm <= 292) {
        var d0 = new C({ unit: 'mm', format: [80, Math.max(60, r2(hMm))] });
        d0.addImage(canvas.toDataURL('image/jpeg', 0.96), 'JPEG', 0, 0, 80, hMm);
        return d0;
      }
      var d1 = new C({ unit: 'mm', format: [80, 292] });
      sliceCanvasInto(d1, canvas, pxPerMm, 80, 0, 0, 292);
      return d1;
    }
    if (billPaper(style) === 'a5') {
      var a5 = new C({ unit: 'mm', format: 'a5', orientation: 'landscape' });
      sliceCanvasInto(a5, canvas, pxPerMm, 186, 12, 8, 132);
      return a5;
    }
    var doc = new C({ unit: 'mm', format: 'a4' });
    sliceCanvasInto(doc, canvas, pxPerMm, 186, 12, 12, 268);
    return doc;
  }

  function buildBillPdf(inv, style) {
    var st = billStyle(style);
    /* A5, GST and Modern are real text pages; only the 80mm receipt is a picture */
    if (st !== 'receipt') {
      return ensureJsPdf().then(function () {
        var textDoc = null;
        try { textDoc = buildTextPdf(inv, st); } catch (e) { textDoc = null; }
        if (textDoc) return textDoc;
        return buildDocCanvas(inv, st).then(function (canvas) { return pdfFromCanvas(canvas, st); });
      });
    }
    return Promise.all([ensureJsPdf(), buildDocCanvas(inv, st)]).then(function (res) {
      return pdfFromCanvas(res[1], st);
    });
  }

  function pdfFor(invId, style) {
    var inv = docById(invId);
    if (!inv) return Promise.resolve(null);
    var st = billStyle(style || ui.previewStyle || (db.settings && db.settings.receiptStyle));
    if (ui.pdf && ui.pdf.id === invId && ui.pdf.style === st && ui.pdf.promise) return ui.pdf.promise;
    var promise = buildBillPdf(inv, st).then(function (doc) {
      if (!doc) return null;
      var blob = doc.output('blob');
      var url = '';
      try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
      return { url: url, blob: blob, name: billPdfName(inv, st), no: inv.no, id: inv.id, style: st };
    }).catch(function () { return null; });
    ui.pdf = { id: invId, style: st, promise: promise };
    return promise;
  }

  /* --------------------------------------------------------- delete an entry */
  function deleteEntry(kind, id) {
    if (!canDeleteEntry(kind)) { toast('You do not have permission to delete this'); return null; }
    var snapshot = JSON.stringify(db);
    var label = 'Deleted';
    /* keep what is being removed so the bin can hand it back for 7 days */
    var DEL_ARRAYS = { invoice: 'invoices', item: 'items', customer: 'customers', supplier: 'suppliers',
      expense: 'expenses', purchase: 'purchases', damage: 'damages', transfer: 'transfers', complaint: 'complaints' };
    var delArr = DEL_ARRAYS[kind];
    var delRec = delArr ? JSON.parse(JSON.stringify(((db[delArr] || []).filter(function (x) { return x.id === id; })[0]) || null)) : null;
    var delInfo = deleteEntryInfo(kind, id) || { name: label, sub: '' };
    var stockBack = [];
    /* every stock move the delete makes is recorded, so a restore can undo it */
    var moveStock = function (it, br, qty) {
      S.addStock(it, br, qty);
      stockBack.push({ itemId: it.id, branchId: br, qty: r2(qty) });
    };

    if (kind === 'invoice') {
      var inv = db.invoices.filter(function (x) { return x.id === id; })[0];
      if (!inv) return null;
      (inv.lines || []).forEach(function (l) {
        var it = itemById(l.itemId);
        if (it) moveStock(it, inv.branchId, Number(l.qty) || 0);
      });
      db.invoices = db.invoices.filter(function (x) { return x.id !== id; });
      logActivity('Deleted bill ' + inv.no + ' (' + money(inv.total) + ')', 'delete');
      label = 'Bill ' + inv.no + ' deleted';

    } else if (kind === 'purchase') {
      var p = db.purchases.filter(function (x) { return x.id === id; })[0];
      if (!p) return null;
      if (purchaseStatus(p) !== 'pending') {
        (p.lines || []).forEach(function (l) {
          var pit = itemById(l.itemId);
          if (!pit || !pit.stock) return;
          Object.keys(l.alloc || {}).forEach(function (b) {
            var took = Number(l.alloc[b]) || 0;
            pit.stock[b] = Math.max(0, r2((Number(pit.stock[b]) || 0) - took));
            if (took) stockBack.push({ itemId: pit.id, branchId: b, qty: -r2(took) });
          });
        });
      }
      db.purchases = db.purchases.filter(function (x) { return x.id !== id; });
      logActivity('Deleted purchase ' + p.no + ' (' + money(p.total) + ')', 'delete');
      label = 'Purchase ' + p.no + ' deleted';

    } else if (kind === 'item') {
      var delIt = itemById(id);
      if (!delIt) return null;
      db.items = db.items.filter(function (x) { return x.id !== id; });
      if (ui.itemOpen === id) ui.itemOpen = '';
      logActivity('Deleted item ' + delIt.name, 'delete');
      label = 'Item ' + delIt.name + ' deleted';

    } else if (kind === 'customer') {
      var cu = findCust(id);
      if (!cu) return null;
      db.customers = db.customers.filter(function (x) { return x.id !== id; });
      if (ui.custOpen === id) ui.custOpen = '';
      logActivity('Deleted customer ' + cu.name, 'delete');
      label = 'Customer ' + cu.name + ' deleted';

    } else if (kind === 'supplier') {
      var sp = supplierById(id);
      if (!sp) return null;
      db.suppliers = db.suppliers.filter(function (x) { return x.id !== id; });
      if (ui.supOpen === id) ui.supOpen = '';
      logActivity('Deleted supplier ' + sp.name, 'delete');
      label = 'Supplier ' + sp.name + ' deleted';

    } else if (kind === 'expense') {
      var ex = db.expenses.filter(function (x) { return x.id === id; })[0];
      if (!ex) return null;
      db.expenses = db.expenses.filter(function (x) { return x.id !== id; });
      logActivity('Deleted ' + ex.category + ' expense (' + money(ex.amount) + ')', 'delete');
      label = 'Expense deleted';

    } else if (kind === 'staff') {
      var st = staffById(id);
      if (!st) return null;
      if (st.id === (S.currentStaff() || {}).id) { toast('You cannot delete your own account'); return null; }
      if (st.role === 'owner' && db.staff.filter(function (x) { return x.role === 'owner'; }).length === 1) {
        toast('At least one owner is required'); return null;
      }
      db.staff = db.staff.filter(function (x) { return x.id !== id; });
      logActivity('Removed staff ' + st.name, 'delete');
      label = st.name + ' removed';

    } else if (kind === 'damage') {
      var dmg = db.damages.filter(function (x) { return x.id === id; })[0];
      if (!dmg) return null;
      if (dmg.adjusted) {
        var dit = itemById(dmg.itemId);
        /* only give stock back when this entry actually took stock out */
        var dback = (dmg.stockMoved != null) ? -(Number(dmg.stockMoved) || 0) : 0;
        if (dit && dback) moveStock(dit, dmg.branchId, dback);
      }
      db.damages = db.damages.filter(function (x) { return x.id !== id; });
      logActivity('Deleted damage entry ' + (dmg.name || ''), 'delete');
      label = 'Damage entry deleted';

    } else if (kind === 'transfer') {
      var tr = db.transfers.filter(function (x) { return x.id === id; })[0];
      if (!tr) return null;
      if (tr.status === 'accepted') {
        (tr.lines || []).forEach(function (l) {
          var tit = itemById(l.itemId);
          if (!tit || !tit.stock) return;
          moveStock(tit, tr.from, Number(l.qty) || 0);
          tit.stock[tr.to] = Math.max(0, r2((Number(tit.stock[tr.to]) || 0) - (Number(l.qty) || 0)));
          stockBack.push({ itemId: tit.id, branchId: tr.to, qty: -r2(Number(l.qty) || 0) });
        });
      }
      db.transfers = db.transfers.filter(function (x) { return x.id !== id; });
      logActivity('Deleted stock transfer ' + tr.no, 'delete');
      label = 'Transfer ' + tr.no + ' deleted';

    } else if (kind === 'complaint') {
      var cp = db.complaints.filter(function (x) { return x.id === id; })[0];
      if (!cp) return null;
      db.complaints = db.complaints.filter(function (x) { return x.id !== id; });
      logActivity('Deleted complaint ' + (cp.no || ''), 'delete');
      label = 'Complaint deleted';

    } else {
      return null;
    }

    if (delRec && delArr) {
      trashAdd({ kind: kind, recId: id, name: delInfo.name || label, sub: delInfo.sub || '', rec: delRec, stockBack: stockBack });
    }
    return { label: label, undo: { label: 'Restored', run: function () {
      db = S.importData(JSON.parse(snapshot));
      ui.branch = startBranchId();
    } } };
  }

  function savePdfFile(p) {
    if (!p || !p.url) return false;
    try {
      var a = document.createElement('a');
      a.href = p.url; a.download = p.name + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      return true;
    } catch (e) { return false; }
  }

  function canvasToImage(canvas, nameBase) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(function (blob) {
          if (!blob) return resolve(null);
          var url = '';
          try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
          resolve({ blob: blob, url: url, name: nameBase || 'image' });
        }, 'image/jpeg', 0.95);
      } catch (e) { resolve(null); }
    });
  }

  function saveImageFile(img) {
    if (!img || !img.url) return false;
    try {
      var a = document.createElement('a');
      a.href = img.url; a.download = img.name + '.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      return true;
    } catch (e) { return false; }
  }

  function billImageFor(invId, style) {
    var inv = docById(invId);
    if (!inv) return Promise.resolve(null);
    var st = billStyle(style || ui.previewStyle || (db.settings && db.settings.receiptStyle));
    return buildDocCanvas(inv, st).then(function (canvas) {
      return canvasToImage(canvas, billPdfName(inv, st));
    }).then(function (img) {
      if (!img) return null;
      img.id = inv.id; img.style = st; img.no = inv.no;
      return img;
    }).catch(function () { return null; });
  }

  function docKindName(invId, style) {
    var doc = docById(invId);
    if (doc && doc.isEstimate) return 'Estimate';
    return billIsReceipt(style) ? 'Receipt' : 'Bill';
  }

  function downloadPdf(invId, style) {
    var p0 = pdfFor(invId, style);
    toast('Preparing PDF…');
    p0.then(function (p) {
      if (!p) return toast('Could not create the PDF');
      if (!savePdfFile(p)) return toast('This browser cannot save the PDF');
      toast(docKindName(invId, p.style) + ' downloaded');
    });
  }

  function sharePdf(invId, style) {
    pdfFor(invId, style).then(function (p) {
      if (!p) return toast('Could not create the PDF');
      try {
        if (navigator.share && typeof File === 'function' && p.blob) {
          var file = new File([p.blob], p.name + '.pdf', { type: 'application/pdf' });
          if (!navigator.canShare || navigator.canShare({ files: [file] })) {
            navigator.share({ files: [file], title: p.name, text: (billIsReceipt(p.style) ? 'Receipt ' : 'Bill ') + p.no }).catch(function () {});
            return;
          }
        }
      } catch (e) {}
      if (savePdfFile(p)) toast(docKindName(invId, p.style) + ' downloaded');
      else toast('This browser cannot share the PDF');
    });
  }

  function shareWhatsApp(invId, style) {
    toast('Preparing image…');
    billImageFor(invId, style).then(function (img) {
      if (!img) return toast('Could not create the image');
      var inv = docById(invId);
      var c = inv ? findCust(inv.customerId) : null;
      var due = inv ? r2(inv.total - inv.paid) : 0;
      var st = img.style || billStyle(style);
      var head = (inv && inv.isEstimate) ? 'Estimate ' : (billIsReceipt(st) ? 'Receipt ' : 'Bill ');
      var msg = head + (img.no || '') + (c ? ' for ' + c.name : '') +
        (inv ? ' — ' + pdfMoney(inv.total) + (inv.isEstimate ? '' : (due > 0.009 ? ' (' + pdfMoney(due) + ' due)' : ' — paid')) : '');
      try {
        if (navigator.share && typeof File === 'function' && img.blob) {
          var file = new File([img.blob], img.name + '.jpg', { type: 'image/jpeg' });
          if (!navigator.canShare || navigator.canShare({ files: [file] })) {
            return navigator.share({ files: [file], title: img.name, text: msg }).catch(function () {});
          }
        }
      } catch (e) {}
      var saved = saveImageFile(img);
      try { window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank', 'noopener'); } catch (e) {}
      toast(saved ? 'Image downloaded · attach it in WhatsApp' : 'Opening WhatsApp');
    });
  }

  function openBillPreview(inv) {
    if (!inv) return;
    ui.pdf = null;
    ui.previewStyle = billStyle(db.settings && db.settings.receiptStyle);
    renderBillPreview(inv);
  }

  function fitPaper() {
    var box = document.querySelector('.bill-preview');
    if (!box) return;
    var fit = box.querySelector('.paper-fit');
    var paper = box.querySelector('.paper');
    if (!fit || !paper) return;
    var w = paper.offsetWidth || 703;
    var avail = box.clientWidth;
    var s = Math.min(1, avail / w);
    paper.style.transform = 'scale(' + s + ')';
    fit.style.height = Math.ceil(paper.offsetHeight * s) + 'px';
  }
  window.addEventListener('resize', function () { fitPaper(); });

  function renderBillPreview(inv) {
    if (!inv) return;
    var st = billStyle(ui.previewStyle);
    var due = r2(inv.total - inv.paid);
    var c = findCust(inv.customerId);
    var paid = due <= 0.009;
    var part = !paid && Number(inv.paid) > 0.009;
    var statusTxt = paid ? 'Paid' : (part ? 'Balance due' : 'Unpaid');
    var statusCls = paid ? 'ok' : (part ? 'warn' : 'due');
    var canDel = can('invoice.delete');
    openModal('Invoice ' + esc(inv.no), `
      <div class="bp">
        <div class="bp-head">
          <div class="bp-info">
            <div class="bp-cust">${esc(c ? c.name : 'Walk-in customer')}</div>
            <div class="bp-meta">${esc(fmtDate(inv.date))} · ${esc(payMixText(inv))}</div>
            ${inv.emi && (inv.emi.finance || inv.emi.monthly || inv.emi.months) ? `<div class="bp-meta bp-emi">EMI${inv.emi.finance ? ' · ' + esc(inv.emi.finance) : ''}${inv.emi.monthly ? ' · ' + money(inv.emi.monthly) + '/month' : ''}${inv.emi.months ? ' × ' + num(inv.emi.months) + ' months' : ''}${inv.emi.date ? ' from ' + esc(fmtDate(inv.emi.date)) : ''}</div>` : ''}
          </div>
          <div class="bp-money">
            <div class="bp-total">${money(inv.total)}</div>
            <div class="bp-status ${statusCls}">${statusTxt}${!paid ? ' · ' + money(due) : ''}</div>
          </div>
        </div>
        <div class="bill-preview" data-paper="${billPaper(st)}">
          <div class="paper-fit">
            <div class="paper"><div class="inv">${billDocHTML(inv, st)}</div></div>
          </div>
        </div>
        <div class="bp-actions">
          <div class="bp-group bp-primary">
            <label class="bp-layout bp-share-as">
              <span>Share as</span>
              <select class="inp" id="billLayoutSel" data-change="pdf-style" data-id="${inv.id}" aria-label="PDF layout to share">
                ${BILL_LAYOUTS.map(function (l) {
                  return `<option value="${l.id}"${l.id === st ? ' selected' : ''}>${l.name}</option>`;
                }).join('')}
              </select>
            </label>
            <button class="btn primary" data-act="pdf-share" data-id="${inv.id}">Share PDF · ${billShortName(st)}</button>
            <button class="btn" data-act="pdf-download" data-id="${inv.id}">Download</button>
            <button class="btn" data-act="pdf-print" data-id="${inv.id}">Print</button>
            <button class="btn" data-act="pdf-wa" data-id="${inv.id}">WhatsApp</button>
          </div>
          ${!paid ? `<div class="bp-section">
            <button class="btn sm" data-act="inv-pay-record" data-id="${inv.id}">Record payment</button>
            <button class="btn sm primary-soft" data-act="inv-pay" data-id="${inv.id}">Mark fully paid</button>
          </div>` : ''}
          <div class="bp-section bp-manage">
            <button class="btn sm ghost" data-act="sr-start" data-id="${inv.id}">Return items</button>
            ${canDel ? `<button class="btn sm ghost" data-act="inv-edit" data-id="${inv.id}">Edit bill</button>` : ''}
            ${canDeleteEntry('invoice') ? `<button class="btn sm danger ghost" data-act="del-ask" data-kind="invoice" data-id="${inv.id}">Delete</button>` : ''}
          </div>
        </div>
      </div>`);
    fitPaper();
    pdfFor(inv.id, st);
  }

  function printInvoice(id, style) {
    var inv = docById(id);
    if (!inv) return;
    var st = billStyle(style || ui.previewStyle || (db.settings && db.settings.receiptStyle));
    var page = document.getElementById('printPage');
    if (!page) {
      page = document.createElement('style');
      page.id = 'printPage';
      document.head.appendChild(page);
    }
    page.textContent = st === 'receipt' ? '@page{size:80mm auto;margin:0}'
      : billPaper(st) === 'a5' ? '@page{size:A5 landscape;margin:8mm 12mm}'
      : '@page{size:A4;margin:12mm}';
    $('#print').className = st === 'receipt' ? 'print-receipt'
      : billPaper(st) === 'a5' ? 'print-full print-a5' : 'print-full';
    $('#print').innerHTML = `<div class="inv">${billDocHTML(inv, st)}</div>`;
    window.print();
    setTimeout(function () { $('#print').className = ''; }, 500);
  }

  /* ----------------------------------------------------------------- actions */
  function act(action, id, el) {
    if (action.indexOf('cmp-') === 0) return complaintAction(action, id);
    if (action === 'do-undo') {
      if (!lastUndo || typeof lastUndo.run !== 'function') return;
      var fn = lastUndo.run, label = lastUndo.label || 'undone';
      lastUndo = null; $('#toast').classList.remove('show');
      try { fn(); } catch (e) { return toast('Could not undo that'); }
      save(); render(); return toast(label);
    }
    if (action === 'tab') return go(id);
    if (action === 'new-bill') { newBill(); return go('bill'); }
    if (action === 'new-estimate') { newBill({ kind: 'estimate' }); return go('bill'); }
    if (action === 'bill-kind') {
      if (!ui.bill || ui.bill.editId) return;
      ui.bill.kind = id === 'estimate' ? 'estimate' : 'sale';
      return render();
    }
    if (action === 'inv-tab') {
      invState().tab = id === 'est' ? 'est' : 'bills';
      invState().page = 1;
      return render();
    }
    if (action === 'est-view') return estPreview(id);
    if (action === 'est-to-bill') return estToBill(id);
    if (action === 'est-del') return deleteEstimate(id);
    if (action === 'tr-new') { newTransfer(); return render(); }
    if (action === 'dash-more') {
      ui.dashMore = ui.dashMore || { complaints: 0, recent: 0 };
      if (id === 'complaints') ui.dashMore.complaints = Math.max(0, Number(ui.dashMore.complaints) || 0) + 5;
      else ui.dashMore.recent = Math.max(0, Number(ui.dashMore.recent) || 0) + 40;
      return render();
    }
    if (action === 'close-modal') {
      if (ui.resumePurchaseAfterItem && typeof pDraft !== 'undefined' && pDraft && typeof purchaseModal === 'function') {
        ui.resumePurchaseAfterItem = false;
        closeModal();
        return purchaseModal({ resume: true, openItemSheet: true });
      }
      if (ui.resumePurchaseAfterSupplier && typeof pDraft !== 'undefined' && pDraft && typeof purchaseModal === 'function') {
        ui.resumePurchaseAfterSupplier = false;
        closeModal();
        return purchaseModal({ resume: true });
      }
      ui.resumePurchaseAfterItem = false;
      ui.resumePurchaseAfterSupplier = false;
      return closeModal();
    }
    if (action === 'clear-cart') {
      if (ui.bill && ui.bill.editId && !confirm('Stop editing this bill and start a new one? Changes are not saved.')) return;
      newBill(); return render();
    }
    if (action === 'inv-more') {
      ui.invMore = ui.invMore === id ? '' : id;
      var it = $('#invTable'); if (it) it.innerHTML = invoiceListHTML();
      return;
    }
    if (action === 'staff-more') {
      ui.staffMore = ui.staffMore === id ? '' : id;
      return render();
    }
    if (action === 'exp-more') {
      ui.expMore = ui.expMore === id ? '' : id;
      return render();
    }
    if (action === 'staff-open') {
      ui.staffOpen = id;
      ui.staffMore = '';
      return render();
    }
    if (action === 'staff-back') {
      ui.staffOpen = '';
      ui.staffMore = '';
      return render();
    }
    if (action === 'inv-edit') { ui.invMore = ''; return editInvoice(id); }
    if (action === 'edit-cancel') return cancelEdit();

    if (action === 'f-open') {
      var fv = el && el.getAttribute('data-view');
      if (!fv) return;
      fState(fv).open = !fState(fv).open;
      return render();
    }
    if (action === 'f-clear') {
      var fc = el && el.getAttribute('data-view');
      if (!fc) return;
      var defc = FILTERS[fc], stc = fState(fc);
      if (defc && defc.state) {
        fFields(fc).forEach(function (x) { stc[x.k] = ''; });
        stc[fQKey(fc)] = '';
      } else {
        ui.f[fc] = { open: stc.open };
      }
      fcPageReset(fc);
      return render();
    }
    if (action === 'f-drop') {
      var fd = el && el.getAttribute('data-view'), fdk = el && el.getAttribute('data-k');
      if (!fd || !fdk) return;
      fState(fd)[fdk] = '';
      fcPageReset(fd);
      return render();
    }
    if (action === 'f-range') {
      var fr = el && el.getAttribute('data-view'), days = el && el.getAttribute('data-days');
      if (!fr) return;
      var st2 = fState(fr);
      var back = function (n) {
        var x = new Date(); x.setDate(x.getDate() - n);
        return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      };
      if (days === 'today') { st2.from = today(); st2.to = today(); }
      else if (days === '7') { st2.from = back(6); st2.to = today(); }
      else if (days === '30') { st2.from = back(29); st2.to = today(); }
      else if (days === 'month') { st2.from = S.monthStart(); st2.to = today(); }
      else { st2.from = ''; st2.to = ''; }
      fcPageReset(fr);
      return render();
    }
    if (action === 'rep-range') {
      var rd = el && el.getAttribute('data-days');
      var back2 = function (n) {
        var x = new Date(); x.setDate(x.getDate() - n);
        return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      };
      if (rd === 'today') { ui.rep.from = today(); ui.rep.to = today(); }
      else if (rd === '7') { ui.rep.from = back2(6); ui.rep.to = today(); }
      else if (rd === '30') { ui.rep.from = back2(29); ui.rep.to = today(); }
      else if (rd === 'month') { ui.rep.from = S.monthStart(); ui.rep.to = today(); }
      else { ui.rep.from = today(); ui.rep.to = today(); }
      return render();
    }

    if (action === 'pick-cust') {
      if (id) {
        ui.bill.customerId = id;
        ui.bill.customerChosen = true;
      } else {
        ui.bill.customerId = '';
        ui.bill.customerChosen = false;
      }
      ui.custQ = '';
      return render();
    }
    if (action === 'cust-walkin') {
      ui.bill.customerId = '';
      ui.bill.customerChosen = true;
      ui.custQ = '';
      return render();
    }
    if (action === 'cust-quick-new') {
      ui.pickNewCustomer = true;
      return customerModal(null);
    }
    if (action === 'settings-tab') {
      ui.settingsTab = (id === 'invoice' || id === 'activity' || id === 'cloud') ? id : 'company';
      ui.scCharges = null; ui.scTerms = null; ui.scFields = null;
      return render();
    }
    if (action === 'set-mode') {
      if (!db.settings.appearance) db.settings.appearance = { mode:'light', color:'red' };
      db.settings.appearance.mode = (id === 'dark') ? 'dark' : 'light';
      save();
      try { S.setTheme(db.settings.appearance.mode); } catch(e){}
      document.documentElement.setAttribute('data-theme', db.settings.appearance.mode);
      document.documentElement.setAttribute('data-color', db.settings.appearance.color || 'red');
      var tb = document.getElementById('themeBtn'); if (tb) tb.textContent = db.settings.appearance.mode === 'dark' ? 'Light mode' : 'Dark mode';
      render();
      return toast('Saved');
    }
    if (action === 'set-color') {
      var colors = ['red','blue','green','purple','orange','teal'];
      if (!db.settings.appearance) db.settings.appearance = { mode:'light', color:'red' };
      db.settings.appearance.color = colors.indexOf(id) > -1 ? id : 'red';
      save();
      document.documentElement.setAttribute('data-theme', db.settings.appearance.mode || 'light');
      document.documentElement.setAttribute('data-color', db.settings.appearance.color);
      render();
      return toast('Saved');
    }
    if (action === 'sc-charge-add') {
      var dc = settingsDrafts();
      dc.charges.push({ name: '', amount: 0 });
      return render();
    }
    if (action === 'sc-charge-del') {
      var dcd = settingsDrafts();
      dcd.charges.splice(Number(id), 1);
      return render();
    }
    if (action === 'sc-term-add') {
      var dt = settingsDrafts();
      dt.terms.push('');
      return render();
    }
    if (action === 'sc-term-del') {
      var dtd = settingsDrafts();
      dtd.terms.splice(Number(id), 1);
      return render();
    }
    if (action === 'sc-field-add') {
      var df = settingsDrafts();
      df.fields.push({ id: '', label: '' });
      return render();
    }
    if (action === 'sc-field-del') {
      var dfd = settingsDrafts();
      dfd.fields.splice(Number(id), 1);
      return render();
    }
    if (action === 'logo-remove') {
      if (!S.isOwner()) return toast('Only the owner can change settings');
      db.settings.logo = '';
      save(); render(); return toast('Logo removed');
    }
    if (action === 'pay-add') {
      if (!ui.bill.payments || !ui.bill.payments.length) ui.bill.payments = [{ method: 'Cash', amount: 0 }];
      ui.bill.payments.push({ method: 'UPI', amount: 0 });
      ui.bill.autoPay = false;
      return render();
    }
    if (action === 'pay-remove') {
      ui.bill.payments.splice(Number(id), 1);
      if (!ui.bill.payments.length) ui.bill.payments = [{ method: 'Cash', amount: 0 }];
      ui.bill.autoPay = false;
      return render();
    }
    if (action === 'pay-full') {
      var firstPay = ui.bill.payments[0] || { method: 'Cash' };
      ui.bill.payments = [{ method: firstPay.method, amount: billTotals().total }];
      ui.bill.autoPay = true;
      return render();
    }

    if (action === 'open-item-sheet') {
      var sh = itemSheetState();
      sh.open = true; sh.q = ''; sh.sel = {};
      return render();
    }
    if (action === 'close-item-sheet') {
      // ignore clicks inside panel bubbled to overlay
      if (el && el.classList && el.classList.contains('sheet-overlay')) {
        // act() doesn't receive event target details; allow close only when overlay element itself triggered action
      }
      var shc = itemSheetState();
      if (!shc.open) return;
      shc.open = false;
      return render();
    }
    if (action === 'item-sheet-toggle') {
      var sht = itemSheetState();
      if (!id) return;
      var cur = Math.max(0, Math.floor(Number(sht.sel[id]) || 0));
      sht.sel[id] = cur > 0 ? 0 : 1;
      return render();
    }
    if (action === 'item-sheet-qty-up') {
      var shu = itemSheetState();
      if (!id) return;
      shu.sel[id] = Math.max(0, Math.floor(Number(shu.sel[id]) || 0)) + 1;
      return render();
    }
    if (action === 'item-sheet-qty-down') {
      var shd = itemSheetState();
      if (!id) return;
      var nq = Math.max(0, Math.floor(Number(shd.sel[id]) || 0) - 1);
      shd.sel[id] = nq;
      return render();
    }
    if (action === 'item-sheet-add') {
      var sha = itemSheetState();
      var items = Object.keys(sha.sel).filter(function (k) { return Number(sha.sel[k]) > 0; }).map(function (k) { return { id: k, qty: Number(sha.sel[k]) }; });
      if (items.length) addItemsToCart(items);
      sha.open = false; sha.sel = {}; sha.q = '';
      return render();
    }

    if (action === 'open-p-item-sheet') {
      if (!pDraft) return;
      var psh = (typeof pItemSheetState === 'function') ? pItemSheetState() : (ui.pItemSheet || (ui.pItemSheet = { open:false,q:'',sel:{} }));
      psh.open = true; psh.q = ''; psh.sel = {};
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'close-p-item-sheet') {
      var pshc = (typeof pItemSheetState === 'function') ? pItemSheetState() : ui.pItemSheet;
      if (!pshc || !pshc.open) return;
      pshc.open = false;
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'p-item-sheet-toggle') {
      var psht = (typeof pItemSheetState === 'function') ? pItemSheetState() : ui.pItemSheet;
      if (!psht || !id) return;
      var pcur = Math.max(0, Math.floor(Number(psht.sel[id]) || 0));
      psht.sel[id] = pcur > 0 ? 0 : 1;
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'p-item-sheet-qty-up') {
      var pshu = (typeof pItemSheetState === 'function') ? pItemSheetState() : ui.pItemSheet;
      if (!pshu || !id) return;
      pshu.sel[id] = Math.max(0, Math.floor(Number(pshu.sel[id]) || 0)) + 1;
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'p-item-sheet-qty-down') {
      var pshd = (typeof pItemSheetState === 'function') ? pItemSheetState() : ui.pItemSheet;
      if (!pshd || !id) return;
      var pnq = Math.max(0, Math.floor(Number(pshd.sel[id]) || 0) - 1);
      pshd.sel[id] = pnq;
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'p-item-sheet-add') {
      var psha = (typeof pItemSheetState === 'function') ? pItemSheetState() : ui.pItemSheet;
      if (!psha) return;
      var pitems = Object.keys(psha.sel).filter(function (k) { return Number(psha.sel[k]) > 0; }).map(function (k) { return { id: k, qty: Number(psha.sel[k]) }; });
      if (pitems.length && typeof pAddItemsFromSheet === 'function') pAddItemsFromSheet(pitems);
      psha.open = false; psha.sel = {}; psha.q = '';
      if (typeof pRenderSheet === 'function') return pRenderSheet();
      return render();
    }
    if (action === 'focus-item-search') {
      var is = document.getElementById('itemSearch');
      if (is) { is.focus(); try { is.scrollIntoView({block:'center'}); } catch(e){} }
      return;
    }
    if (action === 'add-item') return addToCart(id);
    if (action === 'line-more') return lineDetailsModal(Number(id));
    if (action === 'qty-up' || action === 'qty-down' || action === 'line-remove') {
      var i = Number(id);
      if (!ui.bill || !ui.bill.lines[i]) return;
      if (action === 'line-remove') { ui.bill.lines.splice(i, 1); closeModal(); }
      else ui.bill.lines[i].qty = Math.max(1, Number(ui.bill.lines[i].qty) + (action === 'qty-up' ? 1 : -1));
      if (typeof syncPayments === 'function') syncPayments();
      return render();
    }
    if (action === 'save-bill') return billSaveModal(el.getAttribute('data-mode'));
    if (action === 'bill-save-cancel') return billSaveCancel();
    if (action === 'bill-save-edit') return billSaveEdit();
    if (action === 'bill-save-yes') { closeModal(); return saveBill(el.getAttribute('data-mode')); }
    if (action === 'pdf-share' || action === 'pdf-wa' || action === 'pdf-download' || action === 'pdf-print') {
      /* the picker next to the buttons is the truth: take the layout straight
         from it, so a share can never fall back to another page */
      var pdfSel = document.getElementById('billLayoutSel');
      if (pdfSel) { ui.previewStyle = billStyle(pdfSel.value); ui.pdf = null; }
    }
    if (action === 'pdf-share') return sharePdf(id, ui.previewStyle);
    if (action === 'pdf-wa') return shareWhatsApp(id, ui.previewStyle);
    if (action === 'pdf-download') return downloadPdf(id, ui.previewStyle);
    if (action === 'pdf-print') return printInvoice(id, ui.previewStyle);
    if (action === 'pdf-style') {
      ui.previewStyle = billStyle(el && el.getAttribute('data-val'));
      ui.pdf = null;
      return invById(id) ? renderBillPreview(invById(id)) : estPreview(id);
    }

    if (action === 'dues-open') return duesModal(id);
    if (action === 'inv-view') { ui.invMore = ''; return openBillPreview(invById(id)); }
    if (action === 'inv-print') { ui.invMore = ''; closeModal(); return printInvoice(id, db.settings.receiptStyle); }
    if (action === 'inv-pay-record') return invPaymentModal(id);
    if (action === 'inv-pay') {
      var inv = invById(id);
      if (inv) {
        var before = r2(inv.paid);
        var left = r2(inv.total - inv.paid);
        if (left <= 0.009) return toast('This bill is already paid');
        inv.paid = inv.total;
        inv.payments = (inv.payments || []).concat([{ method: 'Cash', amount: left, at: Date.now(), full: true }]);
        logActivity('Marked bill ' + inv.no + ' fully paid (' + money(inv.total) + ')', 'payment');
        save(); closeModal(); render();
        toast('Bill marked paid', { undo: { label: 'Payment undone', run: function () { inv.paid = before; inv.payments = (inv.payments || []).filter(function (x) { return !x.full; }); } } });
      }
      return;
    }
    if (action === 'inv-del') {
      if (!can('invoice.delete')) return toast('No permission to delete bills');
      var d = invById(id);
      if (!d) return;
      var c0 = findCust(d.customerId);
      var lineN = d.lines.length;
      var msg = 'Delete bill ' + d.no + ' for ' + (c0 ? c0.name : 'a walk-in customer') + '?\n\n' +
        lineN + ' item' + (lineN === 1 ? '' : 's') + ' will go back into stock. This cannot be undone from the bill list.';
      if (!confirm(msg)) return;
      if (!confirm('Last check: permanently delete ' + d.no + ' worth ' + money(d.total) + '?')) return;
      var snapshot = JSON.parse(JSON.stringify(d));
      var stockBack = d.lines.map(function (l) {
        var it = itemById(l.itemId);
        if (!it) return null;
        S.addStock(it, d.branchId, Number(l.qty));
        return { id: it.id, branchId: d.branchId, qty: Number(l.qty) };
      });
      db.invoices = db.invoices.filter(function (x) { return x.id !== id; });
      logActivity('Deleted bill ' + d.no + ' (' + money(d.total) + ')', 'delete');
      save(); closeModal(); render();
      toast('Bill ' + d.no + ' deleted', { undo: { label: 'Bill restored', run: function () {
        stockBack.forEach(function (b) {
          var it = itemById(b.id);
          if (it && it.stock && it.stock[b.branchId] != null) it.stock[b.branchId] = Math.max(0, Number(it.stock[b.branchId]) - b.qty);
        });
        db.invoices.push(snapshot);
      } } });
      return;
    }

    if (action === 'lg-type') {
      ui.staffMore = '';
      ui.staffOpen = '';
      var lst = ledgerState(); lst.type = id; lst.entityId = ''; lst.page = 1; lst.q = ''; lst.eq = ''; lst.etype = '';
      ui.tab = 'ledgers';
      return render();
    }
    if (action === 'lg-open') {
      var lod = ledgerState(); lod.entityId = id; lod.page = 1; lod.from = ''; lod.to = ''; lod.eq = ''; lod.etype = '';
      return render();
    }
    if (action === 'lg-back') { ledgerState().entityId = ''; ledgerState().page = 1; return render(); }
    if (action === 'lg-clear') {
      var lc = ledgerState(); lc.from = ''; lc.to = ''; lc.eq = ''; lc.etype = ''; lc.page = 1; return render();
    }
    if (action === 'inv-page') {
      var ist = invState();
      var itotal = filteredInvoices().length;
      var ipages = Math.max(1, Math.ceil(itotal / (ist.per || 12)));
      if (id === 'prev') ist.page = Math.max(1, ist.page - 1);
      else if (id === 'next') ist.page = Math.min(ipages, ist.page + 1);
      var it = $('#invTable'); if (it) it.innerHTML = invoiceListHTML(); else render();
      return;
    }
    if (action === 'lg-page') {
      var lp = ledgerState();
      lp.page = Math.max(1, lp.page + (id === 'next' ? 1 : -1));
      return render();
    }
    if (action === 'lg-export') return exportLedger();
    if (action === 'lg-csv') return exportLedgerCsv();
    if (action === 'staff-entry-new') return staffEntryModal(id);

    if (action === 'purchase-new') {
      if (!canSubmitPurchase()) return toast('You do not have permission to enter purchases');
      if (typeof pDraft !== 'undefined') { try { pDraft = null; } catch(e){} }
      ui.pItemSheet = { open:false,q:'',sel:{} };
      return purchaseModal({ fresh: true });
    }
    if (action === 'sup-ledger') {
      ui.supMenu = '';
      if (!can('ledgers')) return supplierModal(id);
      var sls = ledgerState();
      sls.type = 'suppliers'; sls.entityId = id; sls.page = 1;
      sls.q = ''; sls.eq = ''; sls.etype = ''; sls.from = ''; sls.to = '';
      ui.tab = 'ledgers';
      return render();
    }
    if (action === 'sup-filter') {
      ui.supFilter = el.getAttribute('data-val') || 'all';
      ui.supMenu = '';
      return render();
    }
    if (action === 'sup-menu') {
      ui.supMenu = ui.supMenu === id ? '' : id;
      return render();
    }
    if (action === 'sup-call' || action === 'sup-wa') {
      var sup = db.suppliers.filter(function (x) { return x.id === id; })[0];
      ui.supMenu = '';
      if (!sup || !sup.phone) { toast('No phone number saved'); return render(); }
      if (action === 'sup-call') { window.location.href = 'tel:' + String(sup.phone).replace(/[^0-9+]/g, ''); return; }
      var wnum = supDigits(sup.phone);
      if (!wnum) { toast('No phone number saved'); return render(); }
      window.open('https://wa.me/' + wnum, '_blank', 'noopener');
      return render();
    }
    if (action === 'party-tab') {
      ui.partyTab = el.getAttribute('data-val') === 'suppliers' ? 'suppliers' : 'customers';
      ui.custOpen = '';
      return render();
    }
    if (action === 'purch-menu') {
      ui.purchMenu = ui.purchMenu === id ? '' : id;
      return render();
    }
    if (action === 'purch-show-more') {
      ui.purchMore = (Number(ui.purchMore) || 0) + 10;
      return render();
    }
    if (action === 'purchase-view') { ui.purchMenu = ''; return purchaseView(id); }
    if (action === 'purchase-pay') return purchasePayModal(id);
    if (action === 'pay-row-add') return payRowAdd();
    if (action === 'pay-row-del') return payRowDel(Number(id) || 0);
    if (action === 'purchase-edit') {
      ui.purchMenu = '';
      if (!(S.isOwner() || can('purchase.edit'))) return toast('You cannot edit purchases');
      return purchaseModal({ editId: id });
    }
    if (action === 'purchase-approve-open') { if (typeof S !== 'undefined' && !S.isOwner()) return toast('Only the owner can approve purchases'); closeModal(); return purchaseModal({ approveId: id }); }
    if (action === 'p-add') return pAddItem(id);
    if (action === 'p-remove-line') return pRemoveLine(id);
    if (action === 'p-supplier-pick') return pPickSupplier(id);
    if (action === 'p-pay-add') {
      if (!pDraft) return;
      if (!pDraft.payments.length) pDraft.payments = [{ method: 'Cash', amount: 0 }];
      pDraft.payments.push({ method: 'UPI', amount: 0 });
      pDraft.autoPay = false;
      var payHost = $('#pPayRows');
      if (payHost) { payHost.innerHTML = pPayRowsHTML(); pRefreshTotals(); } else render();
      return;
    }
    if (action === 'p-pay-remove') {
      if (!pDraft) return;
      pDraft.payments.splice(Number(id), 1);
      if (!pDraft.payments.length) pDraft.payments = [{ method: 'Cash', amount: 0 }];
      pDraft.autoPay = false;
      var payHost2 = $('#pPayRows');
      if (payHost2) { payHost2.innerHTML = pPayRowsHTML(); pRefreshTotals(); } else render();
      return;
    }
    if (action === 'p-pay-full') {
      if (!pDraft) return;
      var keep = (pDraft.payments[0] || { method: 'Cash' }).method;
      pDraft.payments = [{ method: keep, amount: pTotal() }];
      pDraft.autoPay = true;
      var payHost3 = $('#pPayRows');
      if (payHost3) { payHost3.innerHTML = pPayRowsHTML(); pRefreshTotals(); } else render();
      return;
    }
    if (action === 'p-paid') {
      if (!pDraft) return;
      var ptot = pTotal();
      var keepM = (pDraft.payments[0] || { method: 'Cash' }).method;
      if (id === 'none') { pDraft.payments.forEach(function (pm) { pm.amount = 0; }); pDraft.autoPay = false; }
      else if (id === 'half') { pDraft.payments = [{ method: keepM, amount: r2(ptot / 2) }]; pDraft.autoPay = false; }
      else { pDraft.payments = [{ method: keepM, amount: ptot }]; pDraft.autoPay = true; }
      var payHost4 = $('#pPayRows');
      if (payHost4) { payHost4.innerHTML = pPayRowsHTML(); pRefreshTotals(); } else render();
      return;
    }
    if (action === 'pret-new') return preTurnModal();
    if (action === 'supplier-new-from-purchase') {
      ui.resumePurchaseAfterSupplier = !!(typeof pDraft !== 'undefined' && pDraft);
      return supplierModal(null, { name: (el && el.getAttribute('data-name')) || '' });
    }
    if (action === 'supplier-new') { ui.resumePurchaseAfterSupplier = false; return supplierModal(null); }
    if (action === 'supplier-edit') return supplierModal(id);
    if (action === 'supplier-del') {
      if (!can('purchases')) return toast('No permission');
      var sup = db.suppliers.filter(function (x) { return x.id === id; })[0];
      if (!sup) return;
      var supBal = r2(lgBalance('suppliers', sup.id));
      if (!confirm('Delete supplier ' + sup.name + '?' + (Math.abs(supBal) > 0.009 ? '\n\nThey still have a balance of ' + money(Math.abs(supBal)) + '.' : ''))) return;
      var supSnap = JSON.parse(JSON.stringify(sup));
      db.suppliers = db.suppliers.filter(function (x) { return x.id !== id; });
      logActivity('Deleted supplier ' + sup.name, 'delete');
      save(); render();
      return toast('Supplier deleted', { undo: { label: 'Supplier restored', run: function () { db.suppliers.push(supSnap); } } });
    }
    if (action === 'sr-start') { closeModal(); return sreturnModal(id); }
    if (action === 'dmg-new') {
      if (!can('damage.entry')) return toast('You do not have permission to record damage');
      return damageModal();
    }
    if (action === 'dmg-adjust') {
      if (!can('damage.settle')) return toast('Only the owner can settle — ask the owner for permission');
      var dj = db.damages.filter(function (x) { return x.id === id; })[0];
      if (!dj || dj.adjusted) return;
      dj.adjusted = true; dj.adjustedAt = Date.now();
      dj.adjustedByName = (S.currentStaff() || {}).name || '';
      /* settling a recorded loss now actually takes the units out of stock */
      var moved = 0, djQty = Number(dj.qty) || 0;
      var djItem = dj.itemId ? itemById(dj.itemId) : null;
      if (djItem && djQty > 0) {
        moved = -Math.min(djQty, S.stockOf(djItem, dj.branchId));
        S.addStock(djItem, dj.branchId, moved);
        dj.stockMoved = moved;
      }
      logActivity('Settled damage ' + (dj.name || '') + ' (' + money(Number(dj.costValue) || 0) + ')' + (moved ? ' — took ' + num(-moved) + ' out of stock' : ''), 'damage');
      save(); render();
      return toast(moved ? 'Settled — ' + num(-moved) + ' taken out of stock' : 'Marked settled');
    }
    if (action === 'dmg-del') {
      if (!can('damage.delete')) return toast('You do not have permission to delete damage entries');
      var dmg = db.damages.filter(function (x) { return x.id === id; })[0];
      if (!dmg) return;
      if (!confirm('Delete this entry?')) return;
      var dmgSnap = JSON.parse(JSON.stringify(dmg));
      db.damages = db.damages.filter(function (x) { return x.id !== id; });
      logActivity('Removed damage entry ' + dmg.name, 'delete');
      save(); render();
      return toast('Entry removed', { undo: { label: 'Damage entry restored', run: function () {
        db.damages.push(dmgSnap);
      } } });
    }

    if (action === 'tr-add-item') {
      var it2 = itemById(id);
      if (!it2) return;
      if (!ui.transfer) newTransfer();
      var line = ui.transfer.lines.filter(function (l) { return l.itemId === id; })[0];
      var available = S.stockOf(it2, ui.branch);
      if (line) { if (line.qty < available) line.qty++; }
      else ui.transfer.lines.push({ itemId: id, name: it2.name, qty: 1 });
      return render();
    }
    if (action === 'tr-remove') {
      ui.transfer.lines.splice(Number(id), 1); return render();
    }
    if (action === 'tr-clear') { newTransfer(); return render(); }
    if (action === 'tr-submit') {
      var tr = ui.transfer;
      if (!tr.lines.length) return toast('Add items to send');
      if (!tr.to) return toast('Choose a destination branch');
      for (var k = 0; k < tr.lines.length; k++) {
        var it3 = itemById(tr.lines[k].itemId);
        if (!it3 || S.stockOf(it3, ui.branch) < tr.lines[k].qty) {
          return toast('Not enough ' + tr.lines[k].name + ' in this branch');
        }
      }
      var me = S.currentStaff();
      db.tcounter = (Number(db.tcounter) || 100) + 1;
      db.transfers.push({
        id: uid(), no: 'TRF-' + db.tcounter, date: today(), created: Date.now(),
        from: ui.branch, to: tr.to, status: 'pending', note: '',
        lines: tr.lines.map(function (l) { return { itemId: l.itemId, name: l.name, qty: l.qty }; }),
        by: me ? me.id : '', byName: me ? me.name : '', acceptedBy: '', acceptedAt: 0
      });
      save(); newTransfer(); render();
      return toast('Transfer request sent to ' + branchName(tr.to));
    }
    if (action === 'tr-accept') {
      var res = S.acceptTransfer(id);
      if (res.error) return toast(res.error);
      render(); return toast('Transfer accepted — stock moved');
    }
    if (action === 'tr-reject') {
      var r2res = S.rejectTransfer(id);
      if (r2res.error) return toast(r2res.error);
      closeModal(); render(); return toast('Transfer rejected');
    }
    if (action === 'tr-view') return transferModal(id);
    if (action === 'tr-pdf') return shareTransferPdf(id);
    if (action === 'tr-pdf-save') return downloadTransferPdf(id);

    if (action === 'item-open') { ui.itemOpen = id; ui.itemMore = ''; ui.itemHist = 'all'; return render(); }
    if (action === 'item-back') { ui.itemOpen = ''; ui.itemMore = ''; return render(); }
    if (action === 'item-more') {
      ui.itemMore = ui.itemMore === id ? '' : id;
      var il = $('#itemsList'); if (il) il.innerHTML = itemListHTML();
      return;
    }
    if (action === 'item-scope') {
      ui.itemMore = '';
      ui.itmAll = !ui.itmAll;
      return render();
    }
    if (action === 'item-hist') { ui.itemHist = el.getAttribute('data-val') || 'all'; return render(); }
    if (action === 'adj-step') {
      var sf = document.querySelector('form[data-form="stock-adjust"]');
      if (!sf) return;
      var sIn = sf.querySelector('input[name="counted"]');
      if (!sIn) return;
      var by = Number(el && el.getAttribute('data-val')) || 0;
      sIn.value = String(Math.max(0, r2((Number(sIn.value) || 0) + by)));
      adjStockPreview();
      return;
    }
    if (action === 'item-adjust') {
      ui.itemMore = '';
      if (!can('stock.edit') && !can('damage')) return toast('No permission');
      return adjustStockModal(id);
    }
    if (action === 'item-new') { ui.resumePurchaseAfterItem = (el && el.getAttribute('data-ctx') === 'purchase') || !!(typeof pDraft !== 'undefined' && pDraft && typeof purchaseModal === 'function' && document.querySelector('.p-form')); return itemModal(null); }
    if (action === 'item-cat-pick' || action === 'item-cat-add') {
      var catName = String((el && el.getAttribute('data-name')) || '').trim();
      if (!catName) return;
      if (action === 'item-cat-add') {
        if (!Array.isArray(db.cats)) db.cats = [];
        var catKnown = db.cats.some(function (c) { return String(c).toLowerCase() === catName.toLowerCase(); });
        if (!catKnown) { db.cats.push(catName); save(); }
      }
      var catField = document.querySelector('form[data-form="item"] input[name="category"]');
      if (catField) catField.value = catName;
      var catPick = document.getElementById('itemCatPick');
      if (catPick) catPick.innerHTML = itemCatPickHTML(catName);
      if (action === 'item-cat-add') toast('Category “' + catName + '” added');
      return;
    }
    if (action === 'global-search') { return openGlobalSearch(); }
    if (action === 'item-name-open') { ui.itemMore = ''; return itemModal(id); }
    if (action === 'supplier-name-open') { return supplierModal(id); }
    if (action === 'gsearch-bill') { closeModal(); return openBillPreview(invById(id)); }
    if (action === 'gsearch-item') { closeModal(); return itemModal(id); }
    if (action === 'gsearch-customer') {
      closeModal();
      ui.custMore = id || '';
      ui.tab = 'customers';
      render();
      return;
    }

    if (action === 'item-edit') { ui.itemMore = ''; return itemModal(id); }
    if (action === 'item-del') {
      ui.itemMore = '';
      var delIt = itemById(id);
      if (!delIt) return;
      var here = stockOf(delIt);
      var soldOn = db.invoices.some(function (i) { return (i.lines || []).some(function (l) { return l.itemId === id; }); });
      var warn = 'Delete ' + delIt.name + '?' +
        (here > 0 ? '\n\n' + num(here) + ' still in stock at ' + branchName(ui.branch) + '.' : '') +
        (soldOn ? '\n\nIt appears on past bills — those bills keep their history.' : '');
      if (!confirm(warn)) return;
      if (!confirm('Last check: remove this item from your list?')) return;
      var itSnap = JSON.parse(JSON.stringify(delIt));
      db.items = db.items.filter(function (x) { return x.id !== id; });
      if (ui.itemOpen === id) ui.itemOpen = '';
      logActivity('Deleted item ' + delIt.name, 'delete');
      save(); render();
      return toast('Item deleted', { undo: { label: 'Item restored', run: function () { db.items.push(itSnap); } } });
    }

    if (action === 'cust-open') {
      ui.custOpen = id;
      ui.custMore = '';
      ui.custSortMenu = false;
      ui.tab = 'customers';
      ui.custQ = '';
      closeModal();
      render();
      try { window.scrollTo(0, 0); } catch (e) {}
      return;
    }
    if (action === 'cust-filter') {
      ui.custFilter = el.getAttribute('data-val') || 'all';
      ui.custMore = '';
      return render();
    }
    if (action === 'cust-sort-menu') {
      ui.custSortMenu = !ui.custSortMenu;
      ui.custMore = '';
      return render();
    }
    if (action === 'cust-sort') {
      ui.custSort = el.getAttribute('data-val') || 'name';
      ui.custSortMenu = false;
      ui.custMore = '';
      return render();
    }
    if (action === 'cust-more') {
      ui.custMore = ui.custMore === id ? '' : id;
      ui.custSortMenu = false;
      var cl = $('#custList');
      if (cl) { cl.innerHTML = custListHTML(); }
      return;
    }
    if (action === 'cust-call') {
      var ccall = findCust(id);
      ui.custMore = '';
      if (ccall && ccall.phone) { try { window.location.href = 'tel:' + String(ccall.phone).replace(/\s+/g, ''); } catch (e) {} }
      var clc = $('#custList'); if (clc) clc.innerHTML = custListHTML();
      return;
    }
    if (action === 'cust-wa') {
      var cwa = findCust(id);
      ui.custMore = '';
      if (cwa && cwa.phone) {
        var digits = String(cwa.phone).replace(/\D/g, '');
        if (digits.length === 10) digits = '91' + digits;
        try { window.open('https://wa.me/' + digits, '_blank', 'noopener'); } catch (e) {}
      }
      var clw = $('#custList'); if (clw) clw.innerHTML = custListHTML();
      return;
    }
    if (action === 'cust-back') { ui.custOpen = ''; ui.custMore = ''; return render(); }
    if (action === 'cust-new') return customerModal(null);
    if (action === 'cust-edit') return customerModal(id);
    if (action === 'cust-del') {
      var dc = findCust(id);
      if (!dc) return;
      var dueC = custDue(id);
      if (!confirm('Delete customer ' + dc.name + '?' + (dueC > 0.009
        ? '\n\nThey still owe ' + money(dueC) + ' — you will lose this reminder from the customer list.' : '') +
        '\n\nTheir bills stay in history.')) return;
      var cSnap = JSON.parse(JSON.stringify(dc));
      db.customers = db.customers.filter(function (x) { return x.id !== id; });
      if (ui.custOpen === id) ui.custOpen = '';
      logActivity('Deleted customer ' + dc.name, 'delete');
      save(); render();
      return toast('Customer deleted', { undo: { label: 'Customer restored', run: function () { db.customers.push(cSnap); } } });
    }

    if (action === 'exp-link-add') {
      if (!ui.expLink) return;
      if (ui.expLink.ids.indexOf(id) < 0) ui.expLink.ids.push(id);
      expLinkRepaint();
      return;
    }
    if (action === 'exp-link-remove') {
      if (!ui.expLink) return;
      ui.expLink.ids = ui.expLink.ids.filter(function (v) { return v !== id; });
      expLinkRepaint();
      return;
    }

    if (action === 'exp-new') { ui.expMore = ''; return expenseModal(null); }
    if (action === 'exp-edit') { ui.expMore = ''; return expenseModal(id); }
    if (action === 'exp-del') {
      ui.expMore = '';
      if (!can('expense.edit')) return toast('No permission');
      var de = db.expenses.filter(function (x) { return x.id === id; })[0];
      if (!de) return;
      if (!confirm('Delete ' + de.category + ' expense of ' + money(de.amount) + '?')) return;
      var eSnap = JSON.parse(JSON.stringify(de));
      db.expenses = db.expenses.filter(function (x) { return x.id !== id; });
      logActivity('Deleted expense ' + de.category + ' (' + money(de.amount) + ')', 'delete');
      save(); render();
      return toast('Expense deleted', { undo: { label: 'Expense restored', run: function () { db.expenses.push(eSnap); } } });
    }

    if (action === 'staff-new') { ui.staffMore = ''; return staffModal(null); }
    if (action === 'staff-edit') { ui.staffMore = ''; return staffModal(id); }
    if (action === 'staff-toggle') {
      ui.staffMore = '';
      var st = staffById(id);
      if (!st) return;
      if (st.id === (S.currentStaff() || {}).id) return toast('You cannot disable your own account');
      if (st.role === 'owner' && st.active !== false &&
          db.staff.filter(function (x) { return x.role === 'owner' && x.active !== false; }).length === 1) {
        return toast('At least one owner must stay active');
      }
      st.active = st.active === false;
      logActivity((st.active ? 'Enabled' : 'Disabled') + ' account for ' + st.name, 'staff');
      save(); render(); return toast(st.active ? 'Account enabled' : 'Account disabled');
    }
    if (action === 'staff-del') {
      ui.staffMore = '';
      var sd = staffById(id);
      if (!sd) return;
      if (sd.id === (S.currentStaff() || {}).id) return toast('You cannot delete your own account');
      if (sd.role === 'owner' && db.staff.filter(function (x) { return x.role === 'owner'; }).length === 1) {
        return toast('At least one owner is required');
      }
      if (!confirm('Delete ' + sd.name + '?' + '\n\nThey will not be able to sign in. Their bills stay in history.')) return;
      var stSnap = JSON.parse(JSON.stringify(sd));
      db.staff = db.staff.filter(function (x) { return x.id !== id; });
      logActivity('Removed staff ' + sd.name, 'delete');
      save(); render();
      return toast('Staff removed', { undo: { label: 'Staff restored', run: function () { db.staff.push(stSnap); } } });
    }

    if (action === 'branch-add') return branchModal(null);
    if (action === 'branch-edit') return branchModal(id);
    if (action === 'branch-del') {
      if (!S.isOwner()) return toast('Only the owner can delete branches');
      if (db.branches.length < 2) return toast('Keep at least one branch — add another before deleting this one');
      return branchDeleteModal(id);
    }

    if (action === 'branch-del-yes') {
      if (!S.isOwner()) return toast('Only the owner can delete branches');
      var brGone = S.branchById(id);
      if (!brGone || brGone.removed) { closeModal(); return toast('That branch is already gone'); }
      var keep = db.branches.filter(function (b) { return b.id !== id; })[0];
      if (!keep) { closeModal(); return toast('Keep at least one branch'); }
      db.branchArchive = db.branchArchive || {};
      db.branchArchive[id] = { id: id, name: brGone.name };
      var moved = 0;
      db.staff.forEach(function (s2) {
        /* a login can be allowed into several branches; drop the deleted one */
        if (!Array.isArray(s2.branchIds) || !s2.branchIds.length) {
          s2.branchIds = s2.branchId ? [s2.branchId] : [];
        }
        var wasIn = s2.branchIds.indexOf(id) > -1;
        s2.branchIds = s2.branchIds.filter(function (x) { return x !== id; });
        if (s2.branchId === id) s2.branchId = s2.branchIds[0] || keep.id;
        if (wasIn && !s2.branchIds.length) s2.branchIds = [s2.branchId];
        if (wasIn && s2.branchId === keep.id) moved++;
      });
      db.branches = db.branches.filter(function (b) { return b.id !== id; });
      db.items.forEach(function (it) { if (it.stock) delete it.stock[id]; });
      /* its monthly targets go with the branch */
      delete branchTargets()[id];
      if (ui.branch === id) { ui.branch = keep.id; rememberBranch(keep.id); }
      logActivity('Deleted branch ' + brGone.name, 'delete');
      closeModal(); save(); render();
      return toast('Branch deleted' + (moved ? ' · ' + moved + (moved === 1 ? ' login moved' : ' logins moved') + ' to ' + keep.name : ''));
    }

    /* one delete dialog for every kind of record */
    if (action === 'del-ask') {
      var delKind = String((el && el.getAttribute('data-kind')) || '');
      ui.purchMenu = ''; ui.itemMore = ''; ui.staffMore = ''; ui.supMenu = '';
      return deleteEntryModal(delKind, id);
    }
    if (action === 'del-yes') {
      var dd = ui.delDraft;
      ui.delDraft = null;
      closeModal();
      if (!dd) return;
      /* the permission may have changed while this confirmation was open */
      if (!canDeleteEntry(dd.kind)) { render(); return toast('You do not have permission to delete this'); }
      var done = deleteEntry(dd.kind, dd.id);
      if (!done) { render(); return; }
      save(); render();
      return toast(done.label, { undo: done.undo });
    }

    if (action === 'eod-open') return openEodReport();
    if (action === 'eod-pdf-preview') return eodPdfPreview();
    if (action === 'eod-wa') return eodShareWhatsApp();

    if (action === 'pdf-share' || action === 'pdf-download' || action === 'pdf-print' || action === 'inv-print' || action === 'pdf-wa') {
      var exInv = invById(id);
      var how = (action === 'pdf-print' || action === 'inv-print') ? 'printed'
        : action === 'pdf-wa' ? 'shared on WhatsApp'
        : action === 'pdf-share' ? 'shared' : 'downloaded';
    }
    if (action === 'cloud-verify') {
      if (!cloudReady()) return toast('Add your Supabase details first');
      return cloudVerify();
    }
    if (action === 'cloud-push') {
      if (!cloudReady()) return toast('Add your Supabase details first');
      return cloudPush(false);
    }
    if (action === 'cloud-check') {
      if (!cloudReady()) return toast('Add your Supabase details first');
      return cloudCheck();
    }
    if (action === 'cloud-pull') {
      if (!cloudReady()) return toast('Add your Supabase details first');
      if (!confirm('Load the cloud copy? What is on this device will be replaced by what is in the cloud.')) return;
      return cloudPull();
    }
    if (action === 'cloud-sql-copy') {
      try {
        navigator.clipboard.writeText(CLOUD_SQL);
        return toast('Setup SQL copied');
      } catch (e) {
        return toast('Select the box and copy it by hand');
      }
    }
    if (action === 'snapshot-now') {
      if (!captureDailySnapshot(true)) return toast('Could not save a copy — browser storage is full');
      snapDayDone = today();
      render();
      return toast('Copy of today saved');
    }
    if (action === 'restore-yesterday') {
      if (!S.isOwner()) return toast('Only the owner can restore a copy');
      var old = snapshots().filter(function (x) { return x.day < today(); });
      var pick = old[old.length - 1];
      if (!pick) return toast('There is no earlier copy yet');
      if (!confirm('Bring everything back to how it was on ' + fmtDate(pick.day) + '?\n\nBills, stock, parties and expenses saved after that day are replaced by that copy. Staff and shop settings stay as they are now.')) return;
      try {
        db = S.importData(JSON.parse(pick.data));
      } catch (e) { return toast('That copy could not be read'); }
      ui.branch = startBranchId(); newBill(); render();
      save();
      return toast('Restored the copy from ' + fmtDate(pick.day));
    }
    if (action === 'bin-filter') { binState().kind = id || 'all'; return render(); }
    if (action === 'trash-restore') { return trashRestore(id); }
    if (action === 'trash-empty') {
      if (!confirm('Throw away everything in the bin? It cannot come back after this.')) return;
      return trashEmpty();
    }
    if (action === 'backup') {
      var blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'billing-backup-' + today() + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      return toast('Backup downloaded');
    }
    if (action === 'seed-demo') {
      if (!S.isOwner()) return toast('Only the owner can reset data');
      if (!confirm('Replace all data with the demo shop?')) return;
      db = S.reset(true); ui.branch = startBranchId(); newBill(); render();
      return toast('Demo data loaded');
    }
    if (action === 'reset-all') {
      if (!S.isOwner()) return toast('Only the owner can erase data');
      if (!confirm('Erase ALL data — on this device and in Supabase?\n\nBills, stock, customers, purchases, expenses, staff accounts (except the owner) and the activity log are deleted. The owner login and the shop settings stay. This cannot be undone.')) return;
      db = S.reset(false); ui.branch = startBranchId(); newBill(); render();
      toast('Erased on this device — emptying Supabase…');
      cloudWipeAll().then(function (r) {
        toast(r.ok ? 'All data erased, here and in Supabase' : 'Erased here. Supabase said: ' + r.error);
        render();
      });
      return;
    }
    if (action === 'all-csv') {
      if (!S.isOwner()) return toast('Only the owner can download all data');
      if (!exportAllCsv()) return toast('This browser cannot save the CSV');
      return;
    }
    if (action === 'all-delete') {
      if (!S.isOwner()) return toast('Only the owner can delete all data');
      if (!confirm('Delete all data?\n\nA CSV copy is saved to this device first, then every bill, item, customer, supplier, purchase, return, transfer, damage, expense, staff entry, complaint and the activity log is removed from this device and from Supabase. Your shop details, branches and staff logins stay.\n\nThis cannot be undone.')) return;
      if (!exportAllCsv()) return toast('Could not save the CSV, so nothing was deleted');
      db.invoices = []; db.items = []; db.customers = []; db.suppliers = [];
      db.purchases = []; db.sreturns = []; db.preturns = []; db.transfers = [];
      db.damages = []; db.expenses = []; db.staffLedger = []; db.complaints = []; db.activity = [];
      db.ccomp = 1;
      S.save();
      newBill();
      render();
      toast('CSV saved. Deleting everything…');
      cloudWipeAll().then(function (r) {
        toast(r.ok ? 'All data deleted, here and in Supabase' : 'Deleted on this device. Supabase said: ' + r.error);
        render();
      });
      return;
    }


  /* ---------------------------------------------------------------- EOD report */
  var eodPdfCache = null;
  function eodData() {
    var d = today();
    var invs = branchInvoices().filter(function (i) { return i.date === d; })
      .slice().sort(function (a, b) { return (a.created || 0) - (b.created || 0); });
    var rows = invs.map(function (i) {
      var c = findCust(i.customerId);
      var prods = (i.lines || []).map(function (l) { return (l.name || 'Item') + ' × ' + num(l.qty); }).join(', ');
      var qty = (i.lines || []).reduce(function (s, l) { return s + (Number(l.qty) || 0); }, 0);
      var recv = r2(Math.min(Number(i.paid) || 0, Number(i.total) || 0));
      var pays = (i.payments || []).filter(function (p) { return Number(p.amount) > 0; })
        .map(function (p) { return { method: p.method || 'Cash', amount: r2(Number(p.amount) || 0) }; });
      var cash = 0, online = 0;
      if (pays.length) {
        pays.forEach(function (p) {
          if (String(p.method).toLowerCase() === 'cash') cash += p.amount;
          else online += p.amount;
        });
      } else {
        var m = String(i.method || '').toLowerCase();
        if (m === 'cash') cash = recv; else online = recv;
      }
      var mix = pays.length
        ? pays.map(function (p) { return p.method + ' ' + money(p.amount); }).join(' · ')
        : (i.method || 'Cash');
      return { no: i.no, cust: c ? c.name : 'Walk-in', prod: prods || '—', qty: qty, recv: recv,
        cash: r2(cash), online: r2(online), pays: pays, mix: mix };
    });
    var exps = branchExpenses().filter(function (x) { return x.date === d; })
      .slice().sort(function (a, b) { return (a.created || 0) - (b.created || 0); })
      .map(function (x) {
        var amt = r2(Number(x.amount) || 0);
        var paid = (typeof x.paid === 'number') ? r2(Math.max(0, Math.min(amt, x.paid))) : amt;
        var bal = r2(Math.max(0, amt - paid));
        return { cat: x.category || 'Expense', note: x.note || '', method: x.method || '', amt: amt, paid: paid, bal: bal };
      });
    var totRecv = r2(rows.reduce(function (s, r) { return s + r.recv; }, 0));
    var totCash = r2(rows.reduce(function (s, r) { return s + r.cash; }, 0));
    var totOnline = r2(rows.reduce(function (s, r) { return s + r.online; }, 0));
    var totQty = rows.reduce(function (s, r) { return s + r.qty; }, 0);
    var totExp = r2(exps.reduce(function (s, e) { return s + e.amt; }, 0));
    var totExpPaid = r2(exps.reduce(function (s, e) { return s + e.paid; }, 0));
    var totExpBal = r2(exps.reduce(function (s, e) { return s + e.bal; }, 0));
    var cashExp = r2(exps.reduce(function (s, e) { return s + (String(e.method || '').toLowerCase() === 'cash' ? e.paid : 0); }, 0));
    var cashInHand = r2(totCash - cashExp);
    var byMethod = [];
    (function () {
      var map = {};
      invs.forEach(function (i) {
        var pays = (i.payments || []).filter(function (p) { return Number(p.amount) > 0; });
        if (pays.length) {
          pays.forEach(function (p) {
            var k = p.method || 'Cash';
            map[k] = r2((map[k] || 0) + (Number(p.amount) || 0));
          });
        } else {
          var recv = r2(Math.min(Number(i.paid) || 0, Number(i.total) || 0));
          if (recv > 0) {
            var k2 = i.method || 'Cash';
            map[k2] = r2((map[k2] || 0) + recv);
          }
        }
      });
      byMethod = Object.keys(map).map(function (k) { return { method: k, amount: map[k] }; })
        .sort(function (a, b) { return b.amount - a.amount; });
    })();
    return { date: d, branch: branchName(ui.branch), rows: rows, exps: exps, byMethod: byMethod,
      totRecv: totRecv, totCash: totCash, totOnline: totOnline, totQty: totQty, totExp: totExp, totExpPaid: totExpPaid, totExpBal: totExpBal, cashExp: cashExp, cashInHand: cashInHand };
  }

  function eodReportHtml(d) {
    var invRows = d.rows.length ? d.rows.map(function (r) {
      return '<tr><td><b>' + esc(r.no) + '</b></td><td>' + esc(r.cust) + '</td><td>' + esc(r.prod) + '</td>' +
        '<td class="num">' + num(r.qty) + '</td><td class="num">' + money(r.recv) + '</td>' +
        '<td style="padding:5px 4px;font-size:10px;color:#374151">' + esc(r.mix) + '</td>' +
        '<td class="num">' + money(r.cash) + '</td><td class="num">' + money(r.online) + '</td></tr>';
    }).join('') + '<tr style="font-weight:700;background:#f8fafc"><td colspan="3">Total (' + d.rows.length + ' bills)</td>' +
      '<td class="num">' + num(d.totQty) + '</td><td class="num">' + money(d.totRecv) + '</td><td></td>' +
      '<td class="num">' + money(d.totCash) + '</td><td class="num">' + money(d.totOnline) + '</td></tr>'
      : '<tr><td colspan="8" class="sub">No invoices today.</td></tr>';
    var methodRows = (d.byMethod || []).length
      ? '<div style="margin-top:12px"><div style="font-weight:700;margin:0 0 5px;font-size:13px">Collected by method</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        d.byMethod.map(function (m) {
          return '<tr><td style="padding:4px 4px;border-bottom:1px solid #f1f5f9">' + esc(m.method) + '</td>' +
            '<td style="padding:4px 4px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:700">' + money(m.amount) + '</td></tr>';
        }).join('') +
        '</table></div>'
      : '';
    var expRows = d.exps.length ? d.exps.map(function (e) {
      return '<tr><td>' + esc(e.cat) + '</td><td>' + esc(e.note || '—') + '</td><td>' + esc(e.method || '—') + '</td><td class="num">' + money(e.amt) + '</td><td class="num">' + money(e.paid) + '</td><td class="num">' + (e.bal > 0.009 ? money(e.bal) : '—') + '</td></tr>';
    }).join('') + '<tr style="font-weight:700;background:#f8fafc"><td colspan="3">Total expense</td><td class="num">' + money(d.totExp) + '</td><td class="num">' + money(d.totExpPaid) + '</td><td class="num">' + (d.totExpBal > 0.009 ? money(d.totExpBal) : '—') + '</td></tr>'
      : '<tr><td colspan="6" class="sub">No expenses today.</td></tr>';
    return '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;padding:18px 18px 22px;font-size:12px;line-height:1.35">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">' +
        '<div><div style="font-size:18px;font-weight:700">End of Day Report</div><div style="color:#6b7280;margin-top:2px">' + esc(d.branch) + ' · ' + esc(fmtDate(d.date)) + '</div></div>' +
        '<div style="text-align:right;color:#6b7280;font-size:11px">Generated ' + esc(fmtDate(d.date)) + '</div></div>' +
      '<div style="font-weight:700;margin:8px 0 6px;font-size:13px">Today\'s invoices</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Invoice</th>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Customer</th>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Product</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Qty</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Received</th>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Payments</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Cash</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Online</th>' +
      '</tr></thead><tbody>' + invRows.replace(/class="num"/g, 'style="text-align:right;border-bottom:1px solid #f1f5f9;padding:5px 4px"').replace(/<td><b>/g,'<td style="border-bottom:1px solid #f1f5f9;padding:5px 4px"><b>').replace(/<td>/g,'<td style="border-bottom:1px solid #f1f5f9;padding:5px 4px">').replace(/<td colspan/g,'<td style="border-bottom:1px solid #f1f5f9;padding:5px 4px;color:#6b7280" colspan') + '</tbody></table>' +
      '<div style="font-weight:700;margin:14px 0 6px;font-size:13px">Today\'s expenses</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:11px"><thead><tr>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Category</th>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Note</th>' +
        '<th style="text-align:left;border-bottom:1px solid #e5e7eb;padding:6px 4px">Method</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Amount</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Paid</th>' +
        '<th style="text-align:right;border-bottom:1px solid #e5e7eb;padding:6px 4px">Balance</th>' +
      '</tr></thead><tbody>' + expRows.replace(/class="num"/g, 'style="text-align:right;border-bottom:1px solid #f1f5f9;padding:5px 4px"').replace(/<td>/g,'<td style="border-bottom:1px solid #f1f5f9;padding:5px 4px">').replace(/<td colspan/g,'<td style="border-bottom:1px solid #f1f5f9;padding:5px 4px;color:#6b7280" colspan') + '</tbody></table>' +
      methodRows +
      '<div style="margin-top:16px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">' +
        '<div style="padding:14px 16px;background:#ecfdf5;border:2px solid #10b981;border-radius:10px"><span style="color:#065f46;font-size:14px;font-weight:800">Cash received</span><br><b style="font-size:40px;line-height:1.05;display:inline-block;margin-top:6px;color:#047857">' + money(d.totCash) + '</b></div>' +
        '<div style="padding:14px 16px;background:#eff6ff;border:2px solid #3b82f6;border-radius:10px"><span style="color:#1e3a8a;font-size:14px;font-weight:800">Online received</span><br><b style="font-size:40px;line-height:1.05;display:inline-block;margin-top:6px;color:#1d4ed8">' + money(d.totOnline) + '</b></div>' +
        '<div style="padding:14px 16px;background:#f5f3ff;border:2px solid #8b5cf6;border-radius:10px"><span style="color:#4c1d95;font-size:14px;font-weight:800">Total received</span><br><b style="font-size:40px;line-height:1.05;display:inline-block;margin-top:6px;color:#6d28d9">' + money(d.totRecv) + '</b></div>' +
        '<div style="padding:14px 16px;background:#fef2f2;border:2px solid #ef4444;border-radius:10px"><span style="color:#7f1d1d;font-size:14px;font-weight:800">Total expense</span><br><b style="font-size:40px;line-height:1.05;display:inline-block;margin-top:6px;color:#b91c1c">' + money(d.totExp) + '</b></div>' +
      '</div>' +
      '<div style="margin-top:12px;padding:18px 20px;background:#fff7ed;border:3px solid #f59e0b;border-radius:10px">' +
        '<span style="color:#92400e;font-size:16px;font-weight:900">Final Total Cash in Hand</span><br>' +
        '<b style="font-size:56px;line-height:1.05;display:inline-block;margin-top:8px;color:#b45309">' + money(d.cashInHand) + '</b>' +
        '<div style="margin-top:6px;color:#92400e;font-size:13px">Cash received minus cash expenses</div>' +
      '</div></div>';
  }

  function eodModalHtml(d) {
    var invRows = d.rows.length ? d.rows.map(function (r) {
      return '<tr><td style="padding:4px 6px"><b>' + esc(r.no) + '</b><div class="sub" style="font-size:10px;margin-top:1px">' + esc(r.cust) + '</div></td>' +
        '<td style="padding:4px 6px">' + esc(r.prod) + '</td><td class="num" style="padding:4px 6px">' + num(r.qty) + '</td>' +
        '<td class="num" style="padding:4px 6px">' + money(r.recv) + '</td>' +
        '<td style="padding:4px 6px;font-size:10px;color:#4b5563">' + esc(r.mix) + '</td>' +
        '<td class="num" style="padding:4px 6px">' + money(r.cash) + '</td><td class="num" style="padding:4px 6px">' + money(r.online) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="sub" style="padding:6px">No invoices today.</td></tr>';
    var methodList = (d.byMethod || []).length
      ? '<div class="kpi eod-methods" style="padding:8px 10px"><div class="k">Collected by method</div>' +
        d.byMethod.map(function (m) {
          return '<div class="row-between" style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:2px 0">' +
            '<span>' + esc(m.method) + '</span><b>' + money(m.amount) + '</b></div>';
        }).join('') + '</div>'
      : '';
    var expRows = d.exps.length ? d.exps.map(function (e) {
      return '<tr><td style="padding:4px 6px"><b>' + esc(e.cat) + '</b><div class="sub" style="font-size:10px;margin-top:1px">' + esc(e.note || '—') + '</div></td><td style="padding:4px 6px">' + esc(e.method || '—') + '</td><td class="num" style="padding:4px 6px">' + money(e.amt) + '</td><td class="num" style="padding:4px 6px">' + money(e.paid) + '</td><td class="num" style="padding:4px 6px">' + (e.bal > 0.009 ? money(e.bal) : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="sub" style="padding:6px">No expenses today.</td></tr>';
    return '<div class="eod" style="display:flex;flex-direction:column;gap:8px">' +
      '<div class="row-actions eod-top" style="justify-content:space-between;align-items:center;gap:8px">' +
        '<div class="sub">' + esc(d.branch) + ' · ' + esc(fmtDate(d.date)) + '</div>' +
        '<button class="btn sm primary" data-act="eod-wa">Share on WhatsApp</button>' +
      '</div>' +
      '<div class="kpi-grid eod-kpis" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">' +
        '<div class="kpi eod-kpi" style="padding:8px 10px"><div class="k">Cash received</div><div class="v" style="font-size:17px">' + money(d.totCash) + '</div></div>' +
        '<div class="kpi eod-kpi" style="padding:8px 10px"><div class="k">Online received</div><div class="v" style="font-size:17px">' + money(d.totOnline) + '</div></div>' +
        '<div class="kpi eod-kpi" style="padding:8px 10px"><div class="k">Total received</div><div class="v" style="font-size:17px">' + money(d.totRecv) + '</div></div>' +
        '<div class="kpi eod-kpi" style="padding:8px 10px"><div class="k">Total expense</div><div class="v bad" style="font-size:17px">' + money(d.totExp) + '</div></div>' +
      '</div>' +
      '<div class="kpi eod-cash" style="padding:8px 10px">' +
        '<div class="k">Final Total Cash in Hand</div>' +
        '<div class="v" style="font-size:20px;font-weight:800">' + money(d.cashInHand) + '</div>' +
        '<div class="sub">Cash received minus cash expenses</div>' +
      '</div>' +
      methodList +
      '<div class="section-title eod-title" style="margin:0;font-size:11px">Today\'s invoices</div>' +
      '<div class="table-wrap eod-table" style="margin:0"><table class="data" style="font-size:11px;line-height:1.25"><thead><tr><th style="padding:4px 6px">Invoice / Customer</th><th style="padding:4px 6px">Product</th><th class="num" style="padding:4px 6px">Qty</th><th class="num" style="padding:4px 6px">Received</th><th style="padding:4px 6px">Payments</th><th class="num" style="padding:4px 6px">Cash</th><th class="num" style="padding:4px 6px">Online</th></tr></thead><tbody>' + invRows + '</tbody></table></div>' +
      '<div class="section-title eod-title" style="margin:0;font-size:11px">Today\'s expenses</div>' +
      '<div class="table-wrap eod-table" style="margin:0"><table class="data" style="font-size:11px;line-height:1.25"><thead><tr><th style="padding:4px 6px">Category / Note</th><th style="padding:4px 6px">Method</th><th class="num" style="padding:4px 6px">Amount</th><th class="num" style="padding:4px 6px">Paid</th><th class="num" style="padding:4px 6px">Balance</th></tr></thead><tbody>' + expRows + '</tbody></table></div>' +
    '</div>';
  }

  function openEodReport() {
    eodPdfCache = null;
    var d = eodData();
    openModal('EOD Report', eodModalHtml(d));
  }

  function buildEodCanvas() {
    var d = eodData();
    var key = d.date + '|' + (ui.branch || '') + '|' + d.rows.length + '|' + d.exps.length + '|' + d.totRecv + '|' + d.totExp;
    if (eodPdfCache && eodPdfCache.key === key && eodPdfCache.canvasPromise) return eodPdfCache.canvasPromise;
    var promise = ensureHtml2Canvas().then(function () {
      return new Promise(function (resolve) {
        if (typeof window.html2canvas !== 'function') return resolve(null);
        var host = document.createElement('div');
        host.className = 'pdf-render';
        host.style.cssText = 'position:fixed;left:-20000px;top:0;width:794px;background:#fff;padding:0;margin:0;';
        host.innerHTML = eodReportHtml(d);
        document.body.appendChild(host);
        var imgs = Array.prototype.slice.call(host.querySelectorAll('img'));
        var loaded = imgs.map(function (im) {
          if (im.complete && im.naturalWidth) return Promise.resolve();
          return new Promise(function (res) { im.onload = res; im.onerror = res; setTimeout(res, 1500); });
        });
        var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
        Promise.all(loaded.concat([fonts])).then(function () {
          return window.html2canvas(host.firstChild, { backgroundColor:'#ffffff', scale:2, useCORS:true, logging:false, windowWidth:794 });
        }).then(function (canvas) {
          if (host.parentNode) host.parentNode.removeChild(host);
          resolve({ canvas: canvas, d: d });
        }).catch(function () {
          if (host.parentNode) host.parentNode.removeChild(host);
          resolve(null);
        });
      });
    }).catch(function(){ return null; });
    eodPdfCache = { key: key, canvasPromise: promise };
    return promise;
  }

  function buildEodPdf() {
    return Promise.all([ensureJsPdf(), buildEodCanvas()]).then(function (resArr) {
      var res = resArr[1];
      if (!res || !res.canvas) return null;
      var C = pdfCtor(); if (!C) return null;
      var canvas = res.canvas, d = res.d;
      var pxPerMm = canvas.width / 186;
      var doc = new C({ unit:'mm', format:'a4' });
      sliceCanvasInto(doc, canvas, pxPerMm, 186, 12, 12, 268);
      var blob = doc.output('blob');
      var url = ''; try { url = URL.createObjectURL(blob); } catch (e) { url = ''; }
      var name = pdfSafeName('EOD Report - ' + d.branch + ' - ' + d.date);
      return { url:url, blob:blob, name:name, date:d.date, branch:d.branch };
    });
  }

  function eodPdfPreview() {
    toast('Preparing PDF…');
    buildEodPdf().then(function (p) {
      if (!p || !p.url) return toast('Could not create the PDF');
      try { window.open(p.url, '_blank', 'noopener'); } catch (e) { toast('Could not open preview'); }
    });
  }

  function eodShareWhatsApp() {
    toast('Preparing image…');
    buildEodCanvas().then(function (res) {
      if (!res || !res.canvas) return toast('Could not create the image');
      var d = res.d;
      var name = pdfSafeName('EOD Report - ' + d.branch + ' - ' + d.date);
      return canvasToImage(res.canvas, name).then(function (img) {
        if (!img) return toast('Could not create the image');
        var msg = "Today's store report - " + (d.branch || '') + ' (' + (d.date || '') + ')';
        try {
          if (navigator.share && typeof File === 'function' && img.blob) {
            var file = new File([img.blob], img.name + '.jpg', { type: 'image/jpeg' });
            if (!navigator.canShare || navigator.canShare({ files: [file] })) {
              return navigator.share({ files: [file], title: img.name, text: msg }).catch(function () {});
            }
          }
        } catch (e) {}
        var saved = saveImageFile(img);
        try { window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank', 'noopener'); } catch (e) {}
        toast(saved ? 'Image downloaded · attach it in WhatsApp' : 'Opening WhatsApp');
      });
    });
  }

  }

  /* ------------------------------------------------------------------- forms */

  function submit(kind, data) {
    if (kind === 'item') {
      var name = String(data.name || '').trim();
      if (!name) return toast('Item name is required');
      var existing = data.id ? itemById(data.id) : null;
      var payload = {
        name: name,
        sku: String(data.sku || '').trim(),
        category: String(data.category || '').trim()
      };
      if (payload.category) {
        if (!Array.isArray(db.cats)) db.cats = [];
        var catSeen = db.cats.some(function (c) { return String(c).toLowerCase() === payload.category.toLowerCase(); });
        if (!catSeen) db.cats.push(payload.category);
      }
      if (can('price.edit')) { payload.price = r2(Number(data.price) || 0); payload.cost = r2(Number(data.cost) || 0); }
      if (can('stock.edit')) payload.reorder = Number(data.reorder) || 0;
      if (existing) {
        Object.keys(payload).forEach(function (k) { existing[k] = payload[k]; });
        if (can('stock.edit')) {
          db.branches.forEach(function (b) {
            var key = 'stock_' + b.id;
            if (data[key] != null) existing.stock[b.id] = Number(data[key]) || 0;
          });
        }
      } else {
        var it = {
          id: uid(), name: name, sku: payload.sku, category: payload.category,
          price: can('price.edit') ? r2(Number(data.price) || 0) : 0,
          cost: can('price.edit') ? r2(Number(data.cost) || 0) : 0,
          reorder: Number(data.reorder) || 0, stock: {}
        };
        db.branches.forEach(function (b) {
          it.stock[b.id] = can('stock.edit') ? (Number(data['stock_' + b.id]) || 0) : 0;
        });
        db.items.push(it);
      }
      logActivity((existing ? 'Edited item ' : 'Added item ') + name, 'item');
      if (ui.resumePurchaseAfterItem && typeof pDraft !== 'undefined' && pDraft && typeof purchaseModal === 'function') {
        ui.resumePurchaseAfterItem = false;
        save(); render(); closeModal();
        purchaseModal({ resume: true, openItemSheet: true });
        return toast('Item saved — back to purchase');
      }
      ui.resumePurchaseAfterItem = false;
      save(); closeModal(); render(); return toast('Item saved');
    }

    if (kind === 'customer') {
      var cname = String(data.name || '').trim();
      if (!cname) return toast('Customer name is required');
      var c = { name: cname, phone: String(data.phone || '').trim(), email: String(data.email || '').trim(), address: String(data.address || '').trim() };
      if (data.id) {
        var ec = findCust(data.id);
        if (ec) Object.keys(c).forEach(function (k) { ec[k] = c[k]; });
      } else {
        c.id = uid();
        db.customers.push(c);
        if (ui.pickNewCustomer && ui.bill) {
          ui.bill.customerId = c.id;
          ui.bill.customerChosen = true;
        }
      }
      ui.pickNewCustomer = false;
      logActivity((data.id ? 'Edited customer ' : 'Added customer ') + cname, 'customer');
      save(); closeModal(); render(); return toast('Customer saved');
    }

    if (kind === 'expense') {
      if (!can('expense.edit')) return toast('No permission to edit expenses');
      var amount = r2(Number(data.amount) || 0);
      if (!amount) return toast('Enter an amount');
      /* the “Paid” tick means the whole amount is settled; unticked means the
         whole amount is carried as balance to pay */
      var paid = data.paidFull ? amount : 0;
      var me = S.currentStaff();
      var linkedBills = Array.isArray(data.linkedBills) ? data.linkedBills.filter(Boolean) : [];
      var payload = {
        date: data.date || today(), category: data.category || 'Other',
        amount: amount, paid: paid, method: data.method || 'Cash', note: String(data.note || '').trim(),
        branchId: ui.branch, staffId: me ? me.id : '', linkedBills: linkedBills
      };
      if (data.id) {
        var ex = db.expenses.filter(function (x) { return x.id === data.id; })[0];
        if (ex) Object.keys(payload).forEach(function (k) { ex[k] = payload[k]; });
      } else { payload.id = uid(); db.expenses.push(payload); }
      var bal = r2(amount - paid);
      logActivity((data.id ? 'Edited expense ' : 'Added expense ') + payload.category + ' (' + money(amount) + (bal > 0.009 ? ', balance ' + money(bal) : '') + ')', 'expense');
      save(); closeModal(); render(); return toast(bal > 0.009 ? ('Expense saved · balance ' + money(bal)) : 'Expense saved');
    }

    if (kind === 'staff') {
      if (!S.isOwner()) return toast('Only the owner can manage staff');
      var uname = String(data.username || '').trim();
      var pass = String(data.password || '');
      var sname = String(data.name || '').trim();
      if (!sname || !uname) return toast('Name and user ID are required');
      if (!data.id && !pass) return toast('Choose a password for this login');
      var clash = db.staff.filter(function (s) {
        return s.username.toLowerCase() === uname.toLowerCase() && s.id !== data.id;
      })[0];
      if (clash) return toast('That user ID is already taken');
      var perms = S.ALL_PERMS.filter(function (k) { return data['perm_' + k]; });
      if (data.role === 'owner') perms = S.ALL_PERMS.slice();
      /* one login can be allowed into several branches */
      var branchIds = Object.keys(data).filter(function (k) {
        return k.indexOf('branch_') === 0 && data[k];
      }).map(function (k) { return k.slice('branch_'.length); })
        .filter(function (id) { return !!S.branchById(id); });
      if (!branchIds.length) return toast('Tick at least one branch for this login');
      var mainBranch = branchIds.indexOf(data.id ? (staffById(data.id) || {}).branchId : '') > -1
        ? staffById(data.id).branchId : branchIds[0];
      var sp = {
        name: sname, username: uname,
        role: data.role || 'cashier', branchId: mainBranch, branchIds: branchIds,
        active: !!data.active, perms: perms,
        /* the ticked boxes are the whole truth from now on — without this the
           old-permission upgrade would tick entry/delete again on next load */
        permsSplit: true,
        target: Math.max(0, Number(data.target) || 0)
      };
      var targetStaff = data.id ? staffById(data.id) : null;
      if (data.id) {
        var es = targetStaff;
        if (!es) return;
        if (es.role === 'owner' && sp.role !== 'owner' &&
            db.staff.filter(function (x) { return x.role === 'owner'; }).length === 1) {
          return toast('At least one owner is required');
        }
        Object.keys(sp).forEach(function (k) { es[k] = sp[k]; });
      } else {
        sp.id = uid(); sp.created = Date.now(); db.staff.push(sp);
        targetStaff = sp;
      }
      var afterSave = function () {
        save(); closeModal(); render();
        return toast(sp.role === 'owner'
          ? 'Saved — an owner keeps full access, use Manager or Cashier to limit this login'
          : 'Staff saved');
      };
      if (!pass) return afterSave();
      /* only the salted hash is stored — the typed password is never kept */
      return S.setPassword(targetStaff, pass).then(afterSave).catch(function (err) {
        toast(String((err && err.message) || 'Could not save the password'));
      });

    if (kind === 'force-password') {
      var me = S.currentStaff();
      if (!me) return toast('Sign in again');
      var p1 = String(data.pass1 || '');
      var p2 = String(data.pass2 || '');
      if (p1.length < 4) return toast('Use at least 4 characters');
      if (p1 !== p2) return toast('The two passwords do not match');
      if (p1 === '1234') return toast('1234 is the factory code — pick something else');
      return S.setPassword(me, p1).then(function () {
        save(); closeModal(); render();
        toast('Password saved');
      }).catch(function (err) {
        toast(String((err && err.message) || 'Could not save the password'));
      });
    }
    }

    if (kind === 'branch') {
      if (!S.isOwner()) return toast('Only the owner can manage branches');
      var bname = String(data.name || '').trim();
      if (!bname) return toast('Branch name is required');
      var bpref = String(data.prefix || db.settings.prefix || 'INV').trim().toUpperCase() || 'INV';
      if (data.id) {
        var eb = S.branchById(data.id);
        if (eb) { eb.name = bname; eb.address = String(data.address || '').trim(); eb.phone = String(data.phone || '').trim(); eb.prefix = bpref; }
      } else {
        var nb = { id: uid(), name: bname, address: String(data.address || '').trim(), phone: String(data.phone || '').trim(), prefix: bpref };
        db.branches.push(nb);
        db.items.forEach(function (it) { it.stock[nb.id] = 0; });
      }
      /* monthly targets live with the branch they belong to */
      var tgtId = data.id ? data.id : nb.id;
      var ts = Math.max(0, r2(Number(data.targetSales) || 0));
      var tp = Math.max(0, r2(Number(data.targetProfit) || 0));
      var bt = branchTargets();
      if (ts || tp) bt[tgtId] = { sales: ts, profit: tp }; else delete bt[tgtId];
      logActivity('Updated branch targets', 'settings');
      save(); closeModal(); render(); return toast('Branch saved');
    }

    if (kind === 'purchase') {
      var st = S.currentStaff();
      var canSubmit = canSubmitPurchase();
      if (!canSubmit) return toast('No permission to record purchases');
      if (!pDraft) return;
      if (!pDraft.supplierId) return toast('Choose a supplier');
      if (!pDraft.lines.length) return toast('Add at least one item');
      var problem = '';
      pDraft.lines.forEach(function (l) {
        var sum = 0;
        Object.keys(l.alloc || {}).forEach(function (b) { sum += Number(l.alloc[b]) || 0; });
        if (sum && sum !== Number(l.qty)) problem = 'Branch split for ' + l.name + ' adds up to ' + sum + ' but quantity is ' + l.qty;
      });
      if (problem) return toast(problem);

      var plines = pDraft.lines.map(function (l) {
        var alloc = {}, sum2 = 0;
        Object.keys(l.alloc || {}).forEach(function (b) {
          var v = Math.max(0, Math.floor(Number(l.alloc[b]) || 0));
          if (v > 0) { alloc[b] = v; sum2 += v; }
        });
        var qty = Math.max(1, Math.floor(Number(l.qty) || 1));
        if (!sum2) alloc[ui.branch] = qty;
        return {
          itemId: l.itemId, name: l.name, qty: qty, cost: r2(Number(l.cost) || 0),
          disc: r2(Number(l.disc) || 0), quality: String(l.quality || ''), brand: String(l.brand || ''),
          color: String(l.color || ''), size: String(l.size || ''), serial: String(l.serial || ''),
          alloc: alloc
        };
      });

      // Editing an already approved purchase: undo the old stock, apply the new
      if (pDraft.editing && pDraft.editId) {
        if (!(S.isOwner() || can('purchase.edit'))) return toast('You cannot edit purchases');
        var ep = db.purchases.filter(function (x) { return x.id === pDraft.editId; })[0];
        if (!ep) return toast('Purchase not found');
        if (purchaseStatus(ep) !== 'approved') return toast('Only approved purchases can be edited');
        (ep.lines || []).forEach(function (l) {
          var oldIt = itemById(l.itemId);
          if (!oldIt) return;
          Object.keys(l.alloc || {}).forEach(function (b) { S.addStock(oldIt, b, -(Number(l.alloc[b]) || 0)); });
        });
        var esub = pSubtotal();
        var edisc = r2(Math.max(0, Number(pDraft.discount) || 0));
        var eship = r2(Math.max(0, Number(pDraft.shipping) || 0));
        var etotal = pTotal();
        var epays = (pDraft.payments || []).filter(function (pm) { return Number(pm.amount) > 0; })
          .map(function (pm) { return { method: pm.method || 'Cash', amount: r2(Number(pm.amount) || 0) }; });
        var epaid = r2(epays.reduce(function (s4, pm) { return s4 + pm.amount; }, 0));
        var emethod = epays.map(function (pm) { return pm.method; })
          .filter(function (m, i4, arr) { return arr.indexOf(m) === i4; }).join(' + ') || 'Credit';
        ep.supplierId = pDraft.supplierId;
        ep.invoiceNo = String(pDraft.invoiceNo || '').trim();
        ep.date = pDraft.date || ep.date || today();
        ep.note = String(pDraft.note || '');
        ep.lines = plines;
        ep.subtotal = esub; ep.discount = edisc; ep.shipping = eship; ep.total = r2(etotal);
        ep.payments = epays; ep.paid = epaid; ep.due = r2(Math.max(0, etotal - epaid)); ep.method = emethod;
        ep.editedAt = Date.now(); ep.editedByName = st ? st.name : '';
        plines.forEach(function (l) {
          var it2 = itemById(l.itemId);
          if (!it2) return;
          Object.keys(l.alloc).forEach(function (b) { S.addStock(it2, b, l.alloc[b]); });
          if (Number(l.cost) > 0) it2.cost = r2(Number(l.cost) || 0);
        });
        logActivity('Edited purchase ' + ep.no + ' (' + money(etotal) + ')', 'purchase');
        pDraft = null;
        save(); closeModal(); render();
        return toast('Purchase updated — stock corrected');
      }

      // Owner approving a pending purchase
      if (pDraft.approving && pDraft.approveId) {
        if (!S.isOwner()) return toast('Only the owner can approve purchases');
        var ap = db.purchases.filter(function (x) { return x.id === pDraft.approveId; })[0];
        if (!ap) return toast('Purchase not found');
        if (ap.status !== 'pending') return toast('This purchase is not waiting for approval');
        var psubA = pSubtotal();
        var pdiscA = r2(Math.max(0, Number(pDraft.discount) || 0));
        var pshipA = r2(Math.max(0, Number(pDraft.shipping) || 0));
        var ptotalA = pTotal();
        var ppaysA = (pDraft.payments || []).filter(function (pm) { return Number(pm.amount) > 0; })
          .map(function (pm) { return { method: pm.method || 'Cash', amount: r2(Number(pm.amount) || 0) }; });
        var ppaidA = r2(ppaysA.reduce(function (s3, pm) { return s3 + pm.amount; }, 0));
        var pmethodA = ppaysA.map(function (pm) { return pm.method; })
          .filter(function (m, i3, arr) { return arr.indexOf(m) === i3; }).join(' + ') || 'Credit';
        ap.invoiceNo = String(pDraft.invoiceNo || '').trim();
        ap.date = pDraft.date || ap.date || today();
        ap.supplierId = pDraft.supplierId;
        ap.method = pmethodA; ap.payments = ppaysA; ap.paid = ppaidA; ap.due = r2(Math.max(0, ptotalA - ppaidA));
        ap.subtotal = psubA; ap.discount = pdiscA; ap.shipping = pshipA; ap.total = r2(ptotalA);
        ap.note = String(pDraft.note || ''); ap.lines = plines;
        ap.status = 'approved'; ap.approvedAt = Date.now(); ap.approvedByName = st ? st.name : '';
        ap.approvalSeenBy = [];
        plines.forEach(function (l) {
          var it = itemById(l.itemId);
          if (!it) return;
          Object.keys(l.alloc).forEach(function (b) { S.addStock(it, b, l.alloc[b]); });
          // update item cost to latest purchase cost if provided
          if (Number(l.cost) > 0) it.cost = r2(Number(l.cost) || 0);
        });
        logActivity('Approved purchase ' + ap.no + ' (' + money(ptotalA) + ')', 'purchase');
        pDraft = null;
        save(); closeModal(); render();
        return toast('Purchase approved — stock added');
      }

      // Non-owner: send for approval (no prices, no stock)
      var approvalRequest = (typeof purchaseApprovalMode === 'function') && purchaseApprovalMode();
      if (approvalRequest) {
        db.pcounter = (Number(db.pcounter) || 200) + 1;
        var preqLines = plines.map(function (l) {
          return {
            itemId: l.itemId, name: l.name, qty: l.qty, cost: 0, disc: 0,
            quality: l.quality, brand: l.brand, color: l.color, size: l.size, serial: l.serial, alloc: l.alloc
          };
        });
        db.purchases.push({
          id: uid(), no: 'PUR-' + db.pcounter, invoiceNo: String(pDraft.invoiceNo || '').trim(),
          date: pDraft.date || today(), created: Date.now(), supplierId: pDraft.supplierId,
          method: 'Pending', payments: [], paid: 0, due: 0,
          subtotal: 0, discount: 0, shipping: 0, total: 0,
          note: String(pDraft.note || ''), lines: preqLines,
          byName: st ? st.name : '', createdById: st ? st.id : '', createdByRole: st ? st.role : '',
          status: 'pending', approvalSeenBy: []
        });
        logActivity('Sent purchase PUR-' + db.pcounter + ' for approval', 'purchase');
        pDraft = null;
        save(); closeModal(); render();
        return toast('Purchase sent for approval');
      }

      // Owner direct save (existing behavior)
      var psub = pSubtotal();
      var pdisc = r2(Math.max(0, Number(pDraft.discount) || 0));
      var pship = r2(Math.max(0, Number(pDraft.shipping) || 0));
      var ptotal = pTotal();
      var ppays = (pDraft.payments || []).filter(function (pm) { return Number(pm.amount) > 0; })
        .map(function (pm) { return { method: pm.method || 'Cash', amount: r2(Number(pm.amount) || 0) }; });
      var ppaid = r2(ppays.reduce(function (s3, pm) { return s3 + pm.amount; }, 0));
      var pmethod = ppays.map(function (pm) { return pm.method; })
        .filter(function (m, i3, arr) { return arr.indexOf(m) === i3; }).join(' + ') || 'Credit';
      db.pcounter = (Number(db.pcounter) || 200) + 1;
      db.purchases.push({
        id: uid(), no: 'PUR-' + db.pcounter, invoiceNo: String(pDraft.invoiceNo || '').trim(),
        date: pDraft.date || today(), created: Date.now(), supplierId: pDraft.supplierId,
        method: pmethod, payments: ppays, paid: ppaid, due: r2(Math.max(0, ptotal - ppaid)),
        subtotal: psub, discount: pdisc, shipping: pship, total: r2(ptotal),
        note: String(pDraft.note || ''), lines: plines,
        byName: st ? st.name : '', createdById: st ? st.id : '', createdByRole: st ? st.role : '',
        status: 'approved'
      });
      plines.forEach(function (l) {
        var it = itemById(l.itemId);
        if (!it) return;
        Object.keys(l.alloc).forEach(function (b) { S.addStock(it, b, l.alloc[b]); });
        if (Number(l.cost) > 0) it.cost = r2(Number(l.cost) || 0);
      });
      logActivity('Recorded purchase PUR-' + db.pcounter + ' (' + money(ptotal) + ')', 'purchase');
      pDraft = null;
      save(); closeModal(); render();
      return toast('Purchase saved — stock added to ' + plines.length + ' item(s)');
    }

    if (kind === 'preturn') {
      if (!can('purchases')) return toast('No permission');
      var pit = itemById(data.itemId);
      if (!pit) return toast('Choose an item');
      var pqty = Math.max(1, Math.floor(Number(data.qty) || 1));
      var pb = data.branchId || ui.branch;
      if (S.stockOf(pit, pb) < pqty) return toast('Only ' + S.stockOf(pit, pb) + ' in ' + branchName(pb));
      var pcost = r2(Number(data.cost) || 0) || r2(Number(pit.cost) || 0);
      db.rcounter = (Number(db.rcounter) || 300) + 1;
      db.preturns.push({
        id: uid(), no: 'PR-' + db.rcounter, date: data.date || today(), created: Date.now(),
        supplierId: data.supplierId, itemId: pit.id, name: pit.name, qty: pqty, cost: pcost,
        total: r2(pqty * pcost), branchId: pb, note: String(data.note || ''),
        byName: (S.currentStaff() || {}).name || ''
      });
      S.addStock(pit, pb, -pqty);
      save(); closeModal(); render(); return toast('Purchase return saved');
    }

    if (kind === 'sreturn') {
      var inv = invById(data.invoiceId);
      if (!inv) return toast('Invoice not found');
      var slines = [], stotal = 0;
      inv.lines.forEach(function (l, i) {
        var rem = Math.max(0, Number(l.qty) - returnedQty(inv.id, l.itemId));
        var q = Math.min(rem, Math.max(0, Math.floor(Number(data['ret_' + i]) || 0)));
        if (q > 0) { slines.push({ itemId: l.itemId, name: l.name, qty: q, price: l.price }); stotal += q * l.price; }
      });
      if (!slines.length) return toast('Enter a quantity to return');
      db.rcounter = (Number(db.rcounter) || 300) + 1;
      db.sreturns.push({
        id: uid(), no: 'SR-' + db.rcounter, date: today(), created: Date.now(),
        invoiceId: inv.id, branchId: inv.branchId, customerId: inv.customerId,
        lines: slines, total: r2(stotal), method: data.method || 'Cash',
        byName: (S.currentStaff() || {}).name || ''
      });
      slines.forEach(function (l) {
        var it = itemById(l.itemId);
        if (it) S.addStock(it, inv.branchId, l.qty);
      });
      save(); closeModal(); render(); return toast('Return saved — stock back in ' + branchName(inv.branchId));
    }

    if (kind === 'complaint' || kind === 'complaint-edit' || kind === 'complaint-supplier') return complaintSubmit(kind, data);

    if (kind === 'purchase-pay') {
      if (!(S.isOwner() || canPayPurchase())) return toast('You cannot record purchase payments');
      var pp = db.purchases.filter(function (x) { return x.id === String(data.id || ''); })[0];
      if (!pp) return toast('Purchase not found');
      if (purchaseStatus(pp) !== 'approved') return toast('Only approved purchases can be paid');
      var pdue = r2(Math.max(0, Number(pp.total || 0) - (typeof pp.paid === 'number' ? pp.paid : (pp.paid ? Number(pp.total || 0) : 0))));
      var payRows = [];
      Object.keys(data).forEach(function (k) {
        var mk = /^pm(\d+)$/.exec(k);
        if (!mk) return;
        var ri = mk[1];
        var ramt = r2(Number(String(data['pa' + ri] || '').replace(/,/g, '')) || 0);
        if (!(ramt > 0)) return;
        payRows.push({ method: String(data[k] || 'Cash'), amount: ramt });
      });
      var payAmt = r2(payRows.reduce(function (a, x) { return a + x.amount; }, 0));
      if (!payRows.length) return toast('Enter the amount you paid');
      if (payAmt > pdue + 0.009) return toast('That is more than the balance ' + money(pdue) + ' by ' + money(r2(payAmt - pdue)));
      pp.payments = (pp.payments || []).concat(payRows);
      var newPaid = r2((typeof pp.paid === 'number' ? pp.paid : (pp.paid ? Number(pp.total || 0) : 0)) + payAmt);
      pp.paid = newPaid;
      pp.due = r2(Math.max(0, Number(pp.total || 0) - newPaid));
      pp.method = pp.payments.map(function (x) { return x.method; })
        .filter(function (m, i2, arr) { return arr.indexOf(m) === i2; }).join(' + ');
      if (String(data.note || '').trim()) pp.note = [pp.note, String(data.note).trim()].filter(Boolean).join(' · ');
      var paySup = supplierById(pp.supplierId);
      var payDesc = payRows.map(function (x) { return x.method + ' ' + money(x.amount); }).join(' + ');
      logActivity('Paid ' + money(payAmt) + ' to ' + (paySup ? paySup.name : 'supplier') + ' for ' + pp.no + ' (' + payDesc + ')', 'purchase');
      payDraft = null;
      save(); closeModal(); render();
      return toast('Payment of ' + money(payAmt) + ' recorded');
    }

    if (kind === 'stock-adjust') {
      if (!can('stock.edit') && !can('damage')) return toast('No permission');
      var ait = itemById(data.id);
      if (!ait) return toast('Item not found');
      var abranch = data.branchId || ui.branch;
      if (!S.branchById(abranch)) return toast('Choose a branch');
      var rawCounted = String(data.counted == null ? '' : data.counted).trim();
      if (rawCounted === '') return toast('Type the quantity actually in stock');
      var counted = r2(Number(rawCounted));
      if (!isFinite(counted) || counted < 0) return toast('Quantity must be zero or more');
      var before = r2(S.stockOf(ait, abranch));
      var delta = r2(counted - before);
      if (!delta) return toast('Stock is already ' + num(before) + ' at ' + branchName(abranch));
      S.addStock(ait, abranch, delta);
      var ame = S.currentStaff();
      var areason = String(data.reason || '').trim() || 'Stock adjustment';
      db.damages.push({
        id: uid(), date: today(), created: Date.now(), branchId: abranch,
        itemId: ait.id, name: ait.name, qty: Math.abs(delta),
        costValue: r2((delta < 0 ? -delta : 0) * (Number(ait.cost) || 0)),
        responsible: '', reason: areason,
        byName: ame ? ame.name : '', staffId: ame ? ame.id : '',
        adjusted: true, adjustedAt: Date.now(), adjustedByName: ame ? ame.name : '',
        adjust: true, stockMoved: delta
      });
      logActivity('Adjusted ' + ait.name + ' at ' + branchName(abranch) + ': ' + num(before) + ' → ' + num(counted) + ' (' + (delta > 0 ? '+' : '') + num(delta) + ')', 'stock');
      save(); closeModal(); render();
      return toast('Stock adjusted: ' + num(before) + ' → ' + num(counted));
    }

    if (kind === 'damage') {
      if (!can('damage.entry')) return toast('You do not have permission to record damage');
      var dname = String(data.itemName || '').trim();
      if (!dname) return toast('Type what was damaged or lost');
      var damount = r2(Number(data.amount) || 0);
      if (!(damount > 0)) return toast('Enter the amount');
      var dit = damageItem('', dname);
      var dqty = Math.max(0, Number(data.qty) || 0);
      var dbranch = data.branchId || ui.branch;
      var meStaff = S.currentStaff();
      db.damages.push({
        id: uid(), date: data.date || today(), created: Date.now(), branchId: dbranch,
        itemId: dit ? dit.id : '', name: dname, qty: dqty, costValue: damount,
        responsible: String(data.responsible || '').trim(),
        reason: String(data.reason || ''), byName: meStaff ? meStaff.name : '', staffId: meStaff ? meStaff.id : '',
        adjusted: false, adjustedAt: 0, adjustedByName: ''
      });
      save(); closeModal(); render(); return toast('Damage recorded');
    }

    if (kind === 'supplier') {
      if (!can('purchases')) return toast('No permission');
      var sname2 = String(data.name || '').trim();
      if (!sname2) return toast('Supplier name is required');
      var sup = {
        name: sname2, phone: String(data.phone || '').trim(),
        email: String(data.email || '').trim(), address: String(data.address || '').trim()
      };
      var savedSupId = data.id || '';
      if (data.id) {
        var esup = supplierById(data.id);
        if (esup) Object.keys(sup).forEach(function (k) { esup[k] = sup[k]; });
        savedSupId = esup ? esup.id : data.id;
      } else { sup.id = uid(); db.suppliers.push(sup); savedSupId = sup.id; }
      if (ui.resumePurchaseAfterSupplier && typeof pDraft !== 'undefined' && pDraft && typeof purchaseModal === 'function') {
        ui.resumePurchaseAfterSupplier = false;
        pDraft.supplierId = savedSupId;
        pDraft.supQ = '';
        save(); render(); closeModal();
        purchaseModal({ resume: true });
        return toast('Supplier saved — back to purchase');
      }
      ui.resumePurchaseAfterSupplier = false;
      save(); closeModal(); render(); return toast('Supplier saved');
    }

    if (kind === 'lg-filter') {
      var lf = ledgerState();
      lf.from = data.from || ''; lf.to = data.to || '';
      lf.etype = data.etype == null ? '' : data.etype;
      lf.page = 1;
      return render();
    }

        if (kind === 'linedetails') {
      var idx = Number(data.idx);
      if (!ui.bill || !ui.bill.lines[idx]) return closeModal();
      var nq = Math.max(1, Number(data.qty) || 1);
      var ndisc = Math.max(0, r2(Number(data.disc) || 0));
      var ndesc = String(data.desc || '').trim();
      var nimei = String(data.imei || '').trim();
      var nserial = String(data.serial || '').trim();
      if (ui.bill.kind !== 'estimate') {
        var brId = billBranchId();
        var next = ui.bill.lines.map(function (l, i) { return { itemId: l.itemId, qty: i === idx ? nq : l.qty }; });
        var over = stockOverLines(next, brId);
        if (over.length && !allowOversell(over, brId)) return;
      }
      ui.bill.lines[idx].qty = nq;
      ui.bill.lines[idx].disc = ndisc;
      ui.bill.lines[idx].desc = ndesc;
      ui.bill.lines[idx].imei = nimei;
      ui.bill.lines[idx].serial = nserial;
      closeModal(); render(); return;
    }

    if (kind === 'staffentry') {
      if (!can('staff')) return toast('Only the owner can add staff entries');
      var amt = r2(Number(data.amount) || 0);
      if (!amt) return toast('Enter an amount');
      if (!db.staffLedger) db.staffLedger = [];
      db.staffLedger.push({
        id: uid(), staffId: data.staffId, date: data.date || today(), created: Date.now(),
        type: data.type || 'advance', amount: amt, note: String(data.note || ''),
        byName: (S.currentStaff() || {}).name || ''
      });
      save(); closeModal(); render(); return toast('Entry added');
    }

    if (kind === 'settings') {
      if (!S.isOwner()) return toast('Only the owner can change settings');
      var s = db.settings;
      s.business = String(data.business || '').trim() || 'My Store';
      s.phone = String(data.phone || '').trim();
      s.address = String(data.address || '').trim();
      s.email = String(data.email || '').trim();
      s.currency = String(data.currency || '\u20B9').trim().slice(0, 3) || '\u20B9';
      logActivity('Updated business details', 'settings');
      save(); render(); return toast('Saved');
    }

    if (kind === 'invpayment') {
      var ip = invById(data.invId);
      if (!ip) return toast('Bill not found');
      var amount = r2(Number(data.amount) || 0);
      var left = r2(ip.total - ip.paid);
      if (amount <= 0) return toast('Enter an amount greater than zero');
      if (amount > left + 0.009) return toast('That is more than the balance of ' + money(left));
      var method = String(data.method || 'Cash');
      ip.payments = (ip.payments || []).concat([{ method: method, amount: amount, at: Date.now() }]);
      ip.paid = r2(ip.paid + amount);
      ip.method = method;
      logActivity('Received ' + money(amount) + ' (' + method + ') on bill ' + ip.no, 'payment');
      save(); closeModal(); render();
      toast(money(amount) + ' recorded on ' + ip.no);
      return;
    }

    if (kind === 'invoicesettings') {
      if (!S.isOwner()) return toast('Only the owner can change invoice settings');
      var is = db.settings;
      is.prefix = String(data.prefix || 'INV').trim().toUpperCase() || 'INV';
      db.branches.forEach(function (b) { b.prefix = is.prefix; });
      is.taxOn = !!data.taxOn;
      is.taxRate = Math.max(0, Math.min(100, Number(data.taxRate) || 0));
      is.discountType = (data.discountType === 'percent') ? 'percent' : 'amount';
      is.bankName = String(data.bankName || '').trim();
      is.bankAccountName = String(data.bankAccountName || '').trim();
      is.bankAccount = String(data.bankAccount || '').trim();
      is.bankIfsc = String(data.bankIfsc || '').trim();
      is.upiId = String(data.upiId || '').trim();
      is.showBankOnInvoice = !!data.showBankOnInvoice;
      is.showUpiQrOnInvoice = !!data.showUpiQrOnInvoice;
      is.invoiceAddress = String(data.invoiceAddress || '').trim();
      is.receiptStyle = billStyle(data.receiptStyle);
      is.billTheme = String(data.billTheme || 'default');
      is.printTextSize = String(data.printTextSize || 'small');
      is.pageSize = String(data.pageSize || 'auto');
      is.orientation = String(data.orientation || 'auto');
      is.printRepeatHeader = !!data.printRepeatHeader;
      is.printCompanyName = !!data.printCompanyName;
      is.companyNameSize = String(data.companyNameSize || 'medium');
      is.printLogo = !!data.printLogo;
      is.printAddress = !!data.printAddress;
      is.printEmail = !!data.printEmail;
      is.printPhone = !!data.printPhone;
      is.printGstin = !!data.printGstin;
      is.gstin = String(data.gstin || '').trim();
      is.printBillOfSupply = !!data.printBillOfSupply;
      is.extraTopSpace = Math.max(0, Math.min(30, Math.floor(Number(data.extraTopSpace) || 0)));
      is.printOriginalDuplicate = !!data.printOriginalDuplicate;
      is.txnSaleName = String(data.txnSaleName || 'Invoice').trim() || 'Invoice';
      is.expandTable = !!data.expandTable;
      is.minRows = Math.max(0, Math.min(30, Math.floor(Number(data.minRows) || 0)));
      is.printTotalQty = !!data.printTotalQty;
      is.printDecimals = !!data.printDecimals;
      is.printReceived = !!data.printReceived;
      is.printBalance = !!data.printBalance;
      is.printCurrentBalance = !!data.printCurrentBalance;
      is.printTaxDetails = !!data.printTaxDetails;
      is.amountGrouping = !!data.amountGrouping;
      is.amountWordsFormat = (data.amountWordsFormat === 'intl') ? 'intl' : 'indian';
      is.printYouSaved = !!data.printYouSaved;
      is.roundOffOn = !!data.roundOffOn;
      is.stockPolicy = data.stockPolicy === 'block' ? 'block' : 'warn';
      is.printDescription = !!data.printDescription;
      is.printTerms = !!data.printTerms;
      is.printReceivedBy = !!data.printReceivedBy;
      is.printDeliveredBy = !!data.printDeliveredBy;
      is.printSignature = !!data.printSignature;
      is.signatureText = String(data.signatureText || '').trim();
      is.printPaymentMode = !!data.printPaymentMode;
      is.printAcknowledgement = !!data.printAcknowledgement;
      is.printPageNumbers = !!data.printPageNumbers;
      var dsave = settingsDrafts();
      is.extraCharges = dsave.charges
        .map(function (c) { return { id: uid(), name: String(c.name || '').trim(), amount: r2(Number(c.amount) || 0) }; })
        .filter(function (c) { return c.name; });
      is.termsList = dsave.terms.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
      is.terms = is.termsList.join(' ');
      is.billFields = dsave.fields
        .map(function (f) { return { id: f.id || uid(), label: String(f.label || '').trim() }; })
        .filter(function (f) { return f.label; });
      ui.scCharges = null; ui.scTerms = null; ui.scFields = null;
      if (ui.bill) {
        (ui.bill.charges || []).forEach(function (c) {
          var match2 = is.extraCharges.filter(function (x) { return x.name === c.name; })[0];
          if (match2 && c.on && c.amount === 0) c.amount = match2.amount;
        });
        ui.bill.charges = is.extraCharges.map(function (c) {
          var oldc = (ui.bill.charges || []).filter(function (x) { return x.name === c.name; })[0];
          return { name: c.name, amount: oldc && oldc.on ? oldc.amount : c.amount, on: oldc ? oldc.on : false };
        });
        syncPayments();
      }
      logActivity('Updated bill and receipt settings', 'settings');
      save(); render(); return toast('Saved');
    }

    if (kind === 'cloud') {
      var cc = cloudConf();
      var curl = String(data.url || '').trim().replace(/\/+$/, '');
      var ckey = String(data.key || '').trim();
      var cshop = String(data.shop || '').trim();
      if (!curl || !ckey || !cshop) return toast('Fill the project URL, the anon key and a shop code');
      if (!/^https?:\/\//i.test(curl)) return toast('The project URL should start with https://');
      cc.url = curl; cc.key = ckey; cc.shop = cshop; cc.auto = !!data.auto;
      db.settings.cloud = cc;
      S.save();
      render();
      toast('Saved');
      if (cloudReady()) { cloudSetStatus('busy', 'Testing the connection…'); cloudPush(false); }
      return;
    }

    if (kind === 'report') {
      ui.rep.from = data.from || S.monthStart();
      ui.rep.to = data.to || today();
      return render();
    }
  }

  function onInput(el) {
    var kind = el.getAttribute('data-input');
    if (!kind) return;
    if (kind === 'adj-counted') { adjStockPreview(); return; }
    if (kind === 'exp-amount') {
      updateExpBalHint();
      return;
    }
    if (kind === 'exp-bill-q') {
      if (!ui.expLink) ui.expLink = { q: '', ids: [] };
      ui.expLink.q = el.value;
      var res = document.getElementById('expLinkResults');
      if (res) res.innerHTML = expLinkResultsHTML();
      return;
    }
    if (kind === 'pay-amount' && el.getAttribute('data-id') == null) {
      var ps = document.getElementById('paySummary');
      if (ps && typeof paySummaryHTML === 'function') ps.outerHTML = paySummaryHTML();
      return;
    }
    if (kind === 'cmp-q-inv' || kind === 'cmp-q-item') {
      return cmpSearchInput(kind === 'cmp-q-inv' ? 'invoice' : 'item', el.value);
    }
    if (kind === 'item-sheet-q') {
      var sh = itemSheetState ? itemSheetState() : (ui.itemSheet || (ui.itemSheet = { open: false, q: '', sel: {} }));
      sh.q = el.value;
      // re-render sheet only? full render is fine and simple
      var listEl = document.querySelector('.sheet-list');
      var headSub = document.querySelector('.sheet-head .sub');
      var footBtn = document.querySelector('.sheet-foot .btn.primary');
      if (listEl) {
        render();
        var again = document.querySelector('[data-input="item-sheet-q"]');
        if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch(e){} }
        if (typeof syncViewportHeight === 'function') syncViewportHeight();
      } else {
        render();
      }
      return;
    }
    if (kind === 'p-item-sheet-q') {
      var psh = (typeof pItemSheetState === 'function') ? pItemSheetState() : (ui.pItemSheet || (ui.pItemSheet = { open: false, q: '', sel: {} }));
      psh.q = el.value;
      if (typeof pRenderSheet === 'function') {
        pRenderSheet({ resetScroll: true, focusSearch: true, caretEnd: true });
        if (typeof syncViewportHeight === 'function') syncViewportHeight();
      }
      return;
    }
    if (kind === 'search') {
      ui.q = el.value;
      var pick = $('#pickList'); if (pick) pick.innerHTML = pickListHTML();
      var c = $('#pickCount'); if (c) c.textContent = countPickText();
      return;
    }
    if (kind === 'f-q' || kind === 'f-num' || kind === 'f-date') {
      var fv2 = el.getAttribute('data-view');
      if (!fv2) return;
      var fs2 = fState(fv2);
      if (kind === 'f-q') {
        fs2[fQKey(fv2)] = el.value;
        fcPageReset(fv2);
        return render();
      }
      var fk2 = el.getAttribute('data-k');
      if (!fk2) return;
      fs2[fk2] = el.value;
      fcPageReset(fv2);
      return render();
    }
    if (kind === 'q-staff') { ui.qStaff = el.value; return render(); }
    if (kind === 'q-sup') { ui.supQ = el.value; return render(); }
    if (kind === 'q-bin') { binState().q = el.value; return render(); }
    if (kind === 'rep-from') { ui.rep.from = el.value; return render(); }
    if (kind === 'rep-to') { ui.rep.to = el.value; return render(); }
    if (kind === 'q-inv') { ui.qInv = el.value; invState().page = 1; var t1 = $('#invTable'); if (t1) t1.innerHTML = invoiceTable(); return; }
    if (kind === 'q-items') { ui.qItems = el.value; var t2 = $('#itemsTable'); if (t2) t2.innerHTML = itemsTable(); return; }
    if (kind === 'q-cust') { ui.qCust = el.value; var t3 = $('#custList'); if (t3) t3.innerHTML = custListHTML(); return; }
    if (kind === 'tr-search') {
      if (!ui.transfer) newTransfer();
      ui.transfer.q = el.value;
      var tp = $('#trPick'); if (tp) tp.innerHTML = trPickHTML();
      return;
    }
    if (kind === 'lg-q' || kind === 'lg-eq') {
      var ls = ledgerState();
      if (kind === 'lg-q') ls.q = el.value; else ls.eq = el.value;
      ls.page = 1;
      var view = $('#view');
      if (view) view.innerHTML = viewLedgers();
      var again = $('[data-input="' + kind + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(again.value.length, again.value.length); } catch (e) {}
      }
      return;
    }
    if (kind === 'p-search') {
      if (!pDraft) return;
      pDraft.q = el.value;
      var ppick = $('#pPick'); if (ppick) ppick.innerHTML = pPickHTML();
      return;
    }
    if (kind === 'p-qty' || kind === 'p-cost' || kind === 'p-disc') {
      var pln = pLine(el.getAttribute('data-id'));
      if (!pln) return;
      var fld = kind === 'p-qty' ? 'qty' : kind === 'p-cost' ? 'cost' : 'disc';
      pln[fld] = Math.max(0, Number(el.value) || 0);
      if (fld === 'qty') pln.qty = Math.max(1, Math.floor(pln.qty));
      var amtEl = document.querySelector('[data-line-amt="' + pln.uid + '"]');
      if (amtEl) amtEl.textContent = money(pLineAmount(pln));
      var noteEl = document.querySelector('[data-split-note="' + pln.uid + '"]');
      if (noteEl) noteEl.textContent = pSplitNote(pln);
      pRecalc();
      return;
    }
    if (kind === 'p-extra') {
      var plx = pLine(el.getAttribute('data-id'));
      if (plx) plx[el.getAttribute('data-field')] = el.value;
      return;
    }
    if (kind === 'p-alloc') {
      var pla = pLine(el.getAttribute('data-id'));
      if (pla) {
        if (!pla.alloc) pla.alloc = {};
        pla.alloc[el.getAttribute('data-branch')] = Math.max(0, Math.floor(Number(el.value) || 0));
        var pnote = document.querySelector('[data-split-note="' + pla.uid + '"]');
        if (pnote) pnote.textContent = pSplitNote(pla);
      }
      return;
    }
    if (kind === 'p-discount') { if (pDraft) { pDraft.discount = Math.max(0, Number(el.value) || 0); pRecalc(); } return; }
    if (kind === 'p-shipping') { if (pDraft) { pDraft.shipping = Math.max(0, Number(el.value) || 0); pRecalc(); } return; }
    if (kind === 'p-sup-q') {
      if (!pDraft) return;
      pDraft.supQ = el.value;
      var cur = supplierById(pDraft.supplierId);
      if (!cur || cur.name !== el.value) pDraft.supplierId = '';
      var spBox = $('#pSuppPick'); if (spBox) spBox.innerHTML = pSuppPickHTML();
      return;
    }
    if (kind === 'p-pay-amount') {
      if (!pDraft) return;
      var payRow = pDraft.payments[Number(el.getAttribute('data-id'))];
      if (payRow) { payRow.amount = Math.max(0, Number(el.value) || 0); pDraft.autoPay = false; }
      pRefreshTotals();
      return;
    }
    if (kind === 'item-cat') {
      var catHost2 = document.getElementById('itemCatPick');
      if (catHost2) catHost2.innerHTML = itemCatPickHTML(el.value);
      return;
    }
    if (kind === 'g-search') {
      var go = document.getElementById('gSearchOut');
      if (go) go.innerHTML = globalSearchHTML(el.value);
      return;
    }
    if (kind === 'item-name') {
      var nmHost = document.getElementById('itemNamePick');
      if (!nmHost) return;
      var idField = document.querySelector('form[data-form="item"] input[name="id"]');
      nmHost.innerHTML = itemNamePickHTML(el.value, idField ? idField.value : '');
      return;
    }
    if (kind === 'sup-name') {
      var supHost = document.getElementById('supNamePick');
      if (!supHost) return;
      var supIdField = document.querySelector('form[data-form="supplier"] input[name="id"]');
      supHost.innerHTML = supplierNamePickHTML(el.value, supIdField ? supIdField.value : '');
      return;
    }
    if (kind === 'p-inv-no') { if (pDraft) pDraft.invoiceNo = el.value; return; }
    if (kind === 'p-note') { if (pDraft) pDraft.note = el.value; return; }
    if (kind === 'discount') {
      var dRaw = String(el.value || '');
      var dCaret = el.selectionStart;
      ui.bill.discount = Math.max(0, Number(dRaw.replace(/[^0-9.]/g, '')) || 0);
      syncPayments();
      render();
      var dAgain = document.querySelector('[data-input="discount"]');
      if (dAgain) {
        dAgain.value = dRaw;
        dAgain.focus();
        try {
          var dPos = Math.min(dCaret == null ? dRaw.length : dCaret, dRaw.length);
          dAgain.setSelectionRange(dPos, dPos);
        } catch (e) {}
      }
      return;
    }
    if (kind === 'bill-charge-amount') {
      var ci = Number(el.getAttribute('data-id'));
      var chg = (ui.bill.charges || [])[ci];
      if (chg) { chg.amount = Math.max(0, Number(el.value) || 0); chg.on = true; syncPayments(); }
      render();
      var againChg = $('[data-input="bill-charge-amount"][data-id="' + ci + '"]');
      if (againChg) {
        againChg.focus();
        try { againChg.setSelectionRange(againChg.value.length, againChg.value.length); } catch (e) {}
      }
      return;
    }
    if (kind === 'sc-charge-name' || kind === 'sc-charge-amount') {
      var scd = settingsDrafts();
      var row = scd.charges[Number(el.getAttribute('data-id'))];
      if (row) {
        if (kind === 'sc-charge-name') row.name = el.value;
        else row.amount = Math.max(0, Number(el.value) || 0);
      }
      return;
    }
    if (kind === 'sc-term') {
      var std = settingsDrafts();
      std.terms[Number(el.getAttribute('data-id'))] = el.value;
      return;
    }
    if (kind === 'sc-field') {
      var sfd = settingsDrafts();
      var frow = sfd.fields[Number(el.getAttribute('data-id'))];
      if (frow) frow.label = el.value;
      return;
    }
    if (kind === 'bill-field') {
      if (!ui.bill.fields) ui.bill.fields = {};
      ui.bill.fields[el.getAttribute('data-id')] = el.value;
      return;
    }
    if (kind === 'bill-date') {
      if (!ui.bill) return;
      if (ui.bill.editId) ui.bill.editDate = el.value || ui.bill.editDate;
      else ui.bill.date = el.value || ui.bill.date;
      return;
    }
    if (kind === 'cust-search') {
      ui.custQ = el.value;
      var cp = $('#custPick');
      if (cp) cp.innerHTML = custPickHTML();
      return;
    }
    if (kind === 'emi-finance' || kind === 'emi-monthly' || kind === 'emi-date' || kind === 'emi-months') {
      var emiI = Number(el.getAttribute('data-id'));
      var emiPay = ui.bill && ui.bill.payments[emiI];
      if (!emiPay) return;
      emiPay.emi = emiPay.emi || {};
      if (kind === 'emi-finance') emiPay.emi.finance = el.value;
      else if (kind === 'emi-monthly') emiPay.emi.monthly = Math.max(0, Number(el.value) || 0);
      else if (kind === 'emi-date') emiPay.emi.date = el.value;
      else emiPay.emi.months = Math.max(0, parseInt(el.value, 10) || 0);
      return;
    }
    if (kind === 'pay-amount') {
      var pi = Number(el.getAttribute('data-id'));
      var pay = ui.bill.payments[pi];
      if (pay) { pay.amount = Math.max(0, Number(el.value) || 0); ui.bill.autoPay = false; }
      render();
      var againPay = $('[data-input="pay-amount"][data-id="' + pi + '"]');
      if (againPay) {
        againPay.focus();
        try { againPay.setSelectionRange(againPay.value.length, againPay.value.length); } catch (e) {}
      }
      return;
    }
    if (kind === 'qty') {
      var idx = Number(el.getAttribute('data-id'));
      if (ui.bill.lines[idx]) { ui.bill.lines[idx].qty = Math.max(1, Math.floor(Number(el.value) || 1)); render(); }
      return;
    }
    if (kind === 'price') {
      var pidx = Number(el.getAttribute('data-id'));
      if (ui.bill && ui.bill.lines[pidx]) { ui.bill.lines[pidx].price = Math.max(0, Number(el.value) || 0); syncPayments(); render(); }
      return;
    }
    if (kind === 'tr-qty') {
      var i2 = Number(el.getAttribute('data-id'));
      var line = ui.transfer.lines[i2];
      if (!line) return;
      var it = itemById(line.itemId);
      var max = S.stockOf(it, ui.branch);
      line.qty = Math.max(1, Math.min(max, Math.floor(Number(el.value) || 1)));
      return render();
    }
  }

  function updateExpBalHint() {
    var expAmt = document.getElementById('expAmount');
    var expFlag = document.getElementById('expPaidFull');
    var expHint = document.getElementById('expBalHint');
    if (!expAmt || !expHint) return;
    var expTotal = Math.max(0, Number(expAmt.value) || 0);
    var expDue = (expFlag && expFlag.checked) ? 0 : r2(expTotal);
    expHint.innerHTML = money(expDue) + ' left to pay' + (expDue <= 0.009 ? (expTotal > 0 ? ' — fully paid' : '') : '');
  }

  function onChange(el) {
    var kind = el.getAttribute('data-change');
    if (!kind) return;
    if (kind === 'bin-kind') { binState().kind = el.value || 'all'; return render(); }
    if (kind === 'bin-sort') { binState().sort = el.value || 'new'; return render(); }
    if (kind === 'exp-paid-flag') { updateExpBalHint(); return; }
    if (kind === 'cmp-inv') return cmpBillChanged(el.value);
    if (kind === 'pdf-style') {
      ui.previewStyle = billStyle(el.value);
      ui.pdf = null;
      var pid = el.getAttribute('data-id');
      return invById(pid) ? renderBillPreview(invById(pid)) : estPreview(pid);
    }
    if (kind === 'customer') { ui.bill.customerId = el.value; return; }
    if (kind === 'rep-branch') { ui.rep.branch = el.value || 'all'; return render(); }
    if (kind === 'f-set') {
      var fv3 = el.getAttribute('data-view'), fk3 = el.getAttribute('data-k');
      if (!fv3 || !fk3) return;
      fState(fv3)[fk3] = el.value;
      fcPageReset(fv3);
      return render();
    }
    if (kind === 'inv-status') { invState().status = el.value || 'all'; invState().page = 1; var it = $('#invTable'); if (it) it.innerHTML = invoiceTable(); return; }
    if (kind === 'logo-upload') { handleLogoUpload(el.files && el.files[0]); return; }
    if (kind === 'bill-charge') {
      var bc = (ui.bill.charges || [])[Number(el.getAttribute('data-id'))];
      if (bc) bc.on = !!el.checked;
      syncPayments();
      return render();
    }
    if (kind === 'bill-tax') {
      if (ui.bill) ui.bill.taxOn = !!el.checked;
      syncPayments();
      return render();
    }
    if (kind === 'pay-method') {
      var pmi = Number(el.getAttribute('data-id'));
      var pm = ui.bill.payments[pmi];
      if (!pm) return;
      var dup = (ui.bill.payments || []).some(function (x, j) { return j !== pmi && x.method === el.value; });
      if (dup) {
        el.value = pm.method;
        toast('This payment method is already selected');
        return;
      }
      pm.method = el.value;
      if (pm.method === 'EMI' && !pm.emi) pm.emi = { finance: '', monthly: 0, date: '', months: 0 };
      render();
      return;
    }
    if (kind === 'tr-to') { ui.transfer.to = el.value; return; }
    if (kind === 'p-pay-method') {
      var pmi2 = Number(el.getAttribute('data-id'));
      var payM = pDraft && pDraft.payments[pmi2];
      if (!payM) return;
      var dup2 = (pDraft.payments || []).some(function (x, j) { return j !== pmi2 && x.method === el.value; });
      if (dup2) {
        el.value = payM.method;
        toast('This payment method is already selected');
        return;
      }
      payM.method = el.value;
      return;
    }
    if (kind === 'p-date') { if (pDraft) pDraft.date = el.value; return; }
    if (kind === 'staff-role') {
      var perms = el.value === 'owner' ? S.ALL_PERMS.slice() : (S.ROLE_PERMS[el.value] || []);
      var box = $('#permBox');
      if (box) box.innerHTML = permHTML(perms, el.value === 'owner');
      return;
    }
    if (kind === 'restore') {
      var file = el.files && el.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          db = S.importData(JSON.parse(String(reader.result || '{}')));
          ui.branch = startBranchId(); newBill(); render();
          toast('Backup restored');
        } catch (e) { toast('That file is not a valid backup'); }
      };
      reader.readAsText(file);
      el.value = '';
    }
  }

  /* ----------------------------------------------------------------- sidebar */
  function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }

  /* -------------------------------------------------------------------- boot */
  function syncViewportHeight() {
    try {
      var h = (window.visualViewport && window.visualViewport.height) ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--vvh', h + 'px');
      var ov = document.querySelector('.sheet-overlay.open');
      if (ov && window.visualViewport) {
        var offset = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
        ov.style.bottom = offset + 'px';
      } else if (ov) {
        ov.style.bottom = '0px';
      }
    } catch (e) {}
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
  window.addEventListener('resize', syncViewportHeight);
  window.addEventListener('resize', function () {
    clearTimeout(window.__createBtnTimer);
    window.__createBtnTimer = setTimeout(function () {
      if (typeof syncCreateButtons === 'function') syncCreateButtons();
    }, 120);
  });
  document.addEventListener('focusin', function () { setTimeout(syncViewportHeight, 50); setTimeout(syncViewportHeight, 300); });
  document.addEventListener('focusout', function () { setTimeout(syncViewportHeight, 50); });

  function applyTheme(mode, color) {
    var m = mode || (db && db.settings && db.settings.appearance && db.settings.appearance.mode) || S.getTheme() || 'light';
    var c = color || (db && db.settings && db.settings.appearance && db.settings.appearance.color) || 'red';
    document.documentElement.setAttribute('data-theme', m);
    document.documentElement.setAttribute('data-color', c);
    var btn = $('#themeBtn');
    if (btn) btn.textContent = m === 'dark' ? 'Light mode' : 'Dark mode';
    S.setTheme(m);
    if (db && db.settings) {
      if (!db.settings.appearance) db.settings.appearance = { mode: m, color: c };
      db.settings.appearance.mode = m;
      db.settings.appearance.color = c;
    }
  }

  function boot() {
    db = S.load();
    if (db && db.settings) { try { snapDayDone = captureDailySnapshot() ? today() : today(); } catch (e) {} }
    var ap = (db.settings && db.settings.appearance) || {};
    var mode = ap.mode || S.getTheme() || 'light';
    var color = ap.color || 'red';
    applyTheme(mode, color);
    ui.rep.from = today();
    ui.rep.to = today();
    if (S.currentStaff()) { ui.branch = startBranchId(); restoreTab(); }
    newBill();
    newTransfer();

    window.addEventListener('online', function () {
      var oc = cloudConf();
      if (oc.auto && cloudReady() && oc.lastError) cloudPush(true);
    });

    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var el = t.closest('[data-act]');
      if (el) {
        var a = el.getAttribute('data-act');
        if (a === 'close-item-sheet' && el.classList && el.classList.contains('sheet-overlay') && t.closest('.sheet-panel')) return;
        if (a === 'close-p-item-sheet' && el.classList && el.classList.contains('sheet-overlay') && t.closest('.sheet-panel')) return;
        if (a === 'item-sheet-toggle' && t.closest('.sheet-qty')) return;
        if (a === 'p-item-sheet-toggle' && t.closest('.sheet-qty')) return;
        act(a, el.getAttribute('data-id'), el); return;
      }
      if (t.closest('#menuBtn')) return openSidebar();
      if (t.closest('#bnavMore')) return openSidebar();
      if (t.closest('#scrim')) return closeSidebar();
      if (t.closest('#newBillBtn') || t.closest('#fabBill')) { newBill(); return go('bill'); }
      if (t.closest('#logoutBtn')) return doLogout();
      if (t.closest('#themeBtn')) { var nm = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; applyTheme(nm, (db.settings.appearance && db.settings.appearance.color) || 'red'); save(); toast('Saved'); return; }
    });

    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var kind = el.getAttribute('data-input') || '';
      var pos = null;
      try { pos = el.selectionStart; } catch (err) {}
      onInput(el);
      /* The app redraws the view while typing. If that replaced the field the
         user is in, the browser leaves the caret at position 0 and the next
         digit is inserted in front of the others (123 → 321). Put the caret
         back where it was, at the end when it is not known. */
      if (!kind || el.isConnected) return;
      var sel = '[data-input="' + kind + '"]';
      var id = el.getAttribute('data-id');
      if (id != null && id !== '') sel += '[data-id="' + id + '"]';
      var fk = el.getAttribute('data-k');
      if (fk != null) sel += '[data-k="' + fk + '"]';
      var next = $(sel);
      if (!next || !next.focus) return;
      setCaret(next, pos == null ? next.value.length : pos);
    });
    document.addEventListener('change', function (e) {
      if (!e.target || !e.target.getAttribute) return;
      if (e.target.id === 'branchSel') {
        ui.branch = e.target.value;
        rememberBranch(ui.branch);
        ui.itmAll = false;
        newBill(); newTransfer(); closeSidebar(); render(); return;
      }
      onChange(e.target);
    });
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || f.tagName !== 'FORM') return;
      if (f.id === 'loginForm') return doLogin(e);
      if (!f.getAttribute('data-form')) return;
      e.preventDefault();
      var data = {};
      Array.prototype.forEach.call(f.elements, function (field) {
        if (!field.name) return;
        if (field.multiple) {
          data[field.name] = Array.prototype.filter.call(field.options, function (o) { return o.selected; })
            .map(function (o) { return o.value; });
          return;
        }
        data[field.name] = field.type === 'checkbox' ? field.checked : field.value;
      });
      submit(f.getAttribute('data-form'), data);
    });
        document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSidebar();
      if (e.key === 'F2') {
        if (ui.view === 'bill' && ui.bill && ui.bill.lines && ui.bill.lines.length) {
          e.preventDefault();
          lineDetailsModal(ui.bill.lines.length - 1);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key || '').toLowerCase() === 'k') {
        e.preventDefault();
        openGlobalSearch();
        return;
      }
      if (e.key === 'Enter' && e.target && e.target.getAttribute) {
        if (e.target.getAttribute('data-input') === 'sup-name') {
          var supEnter = document.getElementById('supNamePick');
          if (supEnter) {
            var supOpenBtn = supEnter.querySelector('[data-act="supplier-name-open"]');
            if (supOpenBtn) {
              e.preventDefault();
              var supOpenId = supOpenBtn.getAttribute('data-id');
              if (supOpenId) supplierModal(supOpenId);
              return;
            }
          }
        }
        if (e.target.getAttribute('data-input') === 'item-name') {
          var nmHost = document.getElementById('itemNamePick');
          if (nmHost) {
            var openBtn = nmHost.querySelector('[data-act="item-name-open"]');
            if (openBtn) {
              e.preventDefault();
              var oid = openBtn.getAttribute('data-id');
              if (oid) itemModal(oid);
              return;
            }
          }
        }
        if (e.target.getAttribute('data-input') === 'p-search') {
          e.preventDefault();
          pPickFirst();
          return;
        }
        if (e.target.getAttribute('data-input') === 'p-sup-q') {
          e.preventDefault();
          var sq = String((pDraft && pDraft.supQ) || '').trim();
          var hit = db.suppliers.filter(function (sp) { return match(sp.name, sq) || match(sp.phone, sq); })[0];
          if (hit) pPickSupplier(hit.id);
          return;
        }
        if (e.target.closest && e.target.closest('.p-form') && e.target.type !== 'submit') {
          e.preventDefault();
          return;
        }
      }
    });
    if (S.currentStaff()) {
      $('#login').hidden = true;
      $('#app').style.display = '';
      render();
    } else {
      showLogin();
    }

    /* a brand-new browser (new device, cleared storage, reopened copy of the
       app) starts empty — bring the shop back from the cloud automatically */
    cloudAutoRestore().then(function (restored) {
      if (!restored) return;
      var ap2 = (db.settings && db.settings.appearance) || {};
      applyTheme(ap2.mode, ap2.color);
      ui.rep.from = today();
      ui.rep.to = today();
      ui.branch = startBranchId();
      if (S.currentStaff()) {
        $('#login').hidden = true;
        $('#app').style.display = '';
        restoreTab();
        newBill();
        newTransfer();
        render();
        toast('Your saved data was restored from the cloud');
      } else {
        showLogin();
        toast('Your saved data was restored from the cloud');
      }
    });
  }

  /* Offline support: the whole app is saved on this device, so it opens without internet. */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
