/* ==========================================================================
   Billing & Inventory — data store
   Branches, staff accounts, permissions, per-branch stock, transfers, expenses.
   All data lives in this browser (localStorage).
   ========================================================================== */
window.Store = (function () {
  'use strict';

  var KEY = 'billing.app.v2';
  var THEME_KEY = 'billing.theme.v1';
  var SESSION_KEY = 'billing.session.v2';

  var db = null;
  var sessionStaffId = '';
  var loadedEmpty = false;

  var ALL_PERMS = [
    'dashboard', 'bill', 'invoices', 'returns', 'purchases', 'damage', 'complaints', 'transfer', 'items', 'customers',
    'ledgers', 'expenses', 'reports', 'staff', 'settings',
    'price.edit', 'discount', 'invoice.delete', 'stock.edit', 'expense.edit', 'purchase.edit', 'profit.view',
    'damage.settle', 'damage.entry', 'damage.delete',
    'purchase.entry', 'purchase.pay'
  ];

  var PERM_LABELS = {
    dashboard: 'View dashboard',
    bill: 'Create bills',
    invoices: 'View invoices & print',
    returns: 'Sales returns',
    purchases: 'View purchases & suppliers',
    damage: 'View damage / loss',
    complaints: 'Complaints',
    transfer: 'Stock transfers',
    items: 'Items & stock',
    customers: 'Customers',
    ledgers: 'Ledgers',
    expenses: 'Expenses',
    reports: 'Reports',
    staff: 'Staff & access',
    settings: 'Settings',
    'price.edit': 'Edit prices',
    discount: 'Give discounts',
    'invoice.delete': 'Edit or delete bills',
    'stock.edit': 'Edit stock levels',
    'expense.edit': 'Add / edit expenses',
    'purchase.edit': 'Edit purchases',
    'profit.view': 'See cost, profit & purchase prices',
    'damage.settle': 'Settle damage / loss',
    'damage.entry': 'Record damage / loss entry',
    'damage.delete': 'Delete damage / loss entry',
    'purchase.entry': 'Purchase entry',
    'purchase.pay': 'Enter purchase amount / payment'
  };

  var PERM_GROUPS = [
    { title: 'Dashboard', keys: ['dashboard'] },
    { title: 'Billing & invoices', keys: ['bill', 'invoices', 'price.edit', 'discount', 'invoice.delete'] },
    { title: 'Sales returns', keys: ['returns'] },
    { title: 'Purchases & suppliers', keys: ['purchases', 'purchase.entry', 'purchase.edit', 'purchase.pay'] },
    { title: 'Damage / loss', keys: ['damage', 'damage.entry', 'damage.settle', 'damage.delete'] },
    { title: 'Complaints', keys: ['complaints'] },
    { title: 'Stock transfers', keys: ['transfer'] },
    { title: 'Items & stock', keys: ['items', 'stock.edit'] },
    { title: 'Customers', keys: ['customers'] },
    { title: 'Ledgers', keys: ['ledgers'] },
    { title: 'Expenses', keys: ['expenses', 'expense.edit'] },
    { title: 'Reports & profit', keys: ['reports', 'profit.view'] },
    { title: 'Staff & settings', keys: ['staff', 'settings'] }
  ];

  var ROLE_LABEL = { owner: 'Owner / Admin', manager: 'Manager', cashier: 'Cashier' };
  var ROLE_PERMS = {
    owner: ALL_PERMS.slice(),
    manager: ['dashboard', 'bill', 'invoices', 'returns', 'purchases', 'damage', 'complaints', 'transfer', 'items', 'customers', 'ledgers', 'expenses', 'reports',
      'price.edit', 'discount', 'invoice.delete', 'stock.edit', 'expense.edit',
      'damage.entry', 'damage.delete', 'purchase.entry'],
    cashier: ['dashboard', 'bill', 'invoices', 'returns', 'purchases', 'damage', 'complaints', 'transfer', 'items', 'customers',
      'damage.entry', 'purchase.entry']
  };

  /* ------------------------------------------------------------- utilities */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  /* counts and quantities: no forced decimals */
  function num(n) {
    return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  /* money: always two decimals */
  function money(n) {
    var sym = (db && db.settings && db.settings.currency) || '\u20B9';
    return sym + ' ' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function monthStart() { return today().slice(0, 8) + '01'; }
  function fmtDate(iso) {
    var d = new Date(String(iso) + 'T00:00:00');
    if (isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function match(hay, needle) {
    return String(hay || '').toLowerCase().indexOf(String(needle || '').toLowerCase()) > -1;
  }

  /* --------------------------------------------------------------- seeding */
  function defaults() {
    var b1 = uid(), b2 = uid();
    return {
      settings: {
        business: 'My Store', address: '12 Market Road, Bengaluru 560001',
        phone: '+91 98765 43210', email: 'hello@mystore.test',
        currency: '\u20B9', taxRate: 5, prefix: 'INV', taxOn: true, discountType: 'amount',
        bankName: '', bankAccountName: '', bankAccount: '', bankIfsc: '', upiId: '',
        showBankOnInvoice: true, showUpiQrOnInvoice: true,
        receiptStyle: 'a5',
        terms: 'Thank you for your business. Goods once sold are exchangeable within 7 days with this bill.',
        termsList: ['Thank you for your business.', 'Goods once sold are exchangeable within 7 days with this bill.'],
        extraCharges: [], billFields: [], logo: '',
        printTextSize: 'small', pageSize: 'auto', orientation: 'auto', billTheme: 'default',
        printRepeatHeader: true, printCompanyName: true, companyNameSize: 'medium',
        printLogo: true, printAddress: true, printEmail: true, printPhone: true,
        printGstin: false, gstin: '', printBillOfSupply: false, extraTopSpace: 0,
        printOriginalDuplicate: false, txnSaleName: 'Invoice', txnPurchaseName: 'Purchase',
        expandTable: false, minRows: 0, printTotalQty: true, printDecimals: true,
        printReceived: true, printBalance: true, printCurrentBalance: true,
        printTaxDetails: false, amountGrouping: true, amountWordsFormat: 'indian',
        roundOffOn: false,
        stockPolicy: 'warn',
        printYouSaved: true, printDescription: true, printTerms: true,
        printReceivedBy: true, printDeliveredBy: false, printSignature: false,
        signatureText: '', printPaymentMode: true, printAcknowledgement: false,
        printPageNumbers: true,
        dashboard: {
          view: 'comfortable',
          cards: { salesToday: true, salesMonth: true, expensesMonth: true, unpaid: true, myTarget: true },
          sections: [
            { id: 'eod', on: true },
            { id: 'kpis', on: true },
            { id: 'target', on: true },
            { id: 'attention', on: true },
            { id: 'complaints', on: true },
            { id: 'collect', on: true },
            { id: 'recent', on: true },
            { id: 'low', on: true }
          ],
          limits: { recent: 40, low: 6, collect: 4 }
        },
        appearance: { mode: 'light', color: 'red' },
        cloud: {
          url: '',
          key: '',
          shop: '',
          auto: true, syncedAt: 0, lastError: ''
        }
      },
      branches: [
        { id: b1, name: 'Main Store', address: '12 Market Road', phone: '+91 98765 43210' },
        { id: b2, name: 'Second Branch', address: '44 Ring Road', phone: '+91 98765 43211' }
      ],
      staff: [{
        id: uid(), name: 'Owner', username: 'owner', password: '1234', pin: '1234',
        role: 'owner', branchId: b1, active: true, perms: ALL_PERMS.slice(), created: Date.now()
      }],
      items: [], customers: [], invoices: [], transfers: [], expenses: [], cats: [],
      suppliers: [], purchases: [], preturns: [], sreturns: [], damages: [], complaints: [], staffLedger: [], activity: [],
      estimates: [],
      counter: 1040, ecounter: 100, tcounter: 100, pcounter: 200, rcounter: 300, ccomp: 1, seeded: true
    };
  }

  function demo() {
    var d = defaults();
    var b1 = d.branches[0].id, b2 = d.branches[1].id;
    d.settings.bankName = 'State Bank of India';
    d.settings.bankAccountName = 'My Store';
    d.settings.bankAccount = '3210 4455 6677';
    d.settings.bankIfsc = 'SBIN0001234';
    d.settings.upiId = 'mystore@upi';
    d.settings.showUpiQrOnInvoice = true;
    d.settings.extraCharges = [
      { id: uid(), name: 'Delivery charge', amount: 40 },
      { id: uid(), name: 'Packing charge', amount: 20 }
    ];
    d.settings.termsList = ['Thank you for your business.', 'Goods once sold are exchangeable within 7 days with this bill.'];
    d.settings.billFields = [
      { id: uid(), label: 'Delivery address' },
      { id: uid(), label: 'Vehicle number' }
    ];

    d.staff.push(
      { id: uid(), name: 'Meena Rao', username: 'manager', password: '1234', pin: '1234',
        role: 'manager', branchId: b2, active: true, perms: ROLE_PERMS.manager.slice(), created: Date.now(), target: 400000 },
      { id: uid(), name: 'Ravi Kumar', username: 'cashier', password: '1234', pin: '1234',
        role: 'cashier', branchId: b1, active: true, perms: ROLE_PERMS.cashier.slice(), created: Date.now(), target: 250000 }
    );

    var catalogue = [
      ['Basmati Rice 5 kg', 'RICE-5', 520, 430, 10, 'Grocery', 18, 6],
      ['Sunflower Oil 1 L', 'OIL-1', 145, 118, 12, 'Grocery', 20, 4],
      ['Wheat Flour 10 kg', 'ATTA-10', 410, 340, 6, 'Grocery', 9, 3],
      ['Toor Dal 1 kg', 'DAL-1', 165, 132, 15, 'Grocery', 30, 10],
      ['Sugar 1 kg', 'SUG-1', 46, 39, 25, 'Grocery', 60, 20],
      ['Tea Powder 500 g', 'TEA-500', 240, 190, 8, 'Beverages', 14, 4],
      ['Milk 1 L', 'MILK-1', 62, 52, 20, 'Dairy', 30, 0],
      ['Soap Bar 125 g', 'SOAP-125', 38, 29, 30, 'Household', 90, 30],
      ['Detergent 2 kg', 'DET-2', 320, 265, 8, 'Household', 12, 2],
      ['Notebook A5 200p', 'NOTE-A5', 55, 38, 20, 'Stationery', 45, 15]
    ];
    d.items = catalogue.map(function (c) {
      var stock = {};
      stock[b1] = c[6];
      stock[b2] = c[7];
      return {
        id: uid(), name: c[0], sku: c[1], price: c[2], cost: c[3],
        reorder: c[4], category: c[5], stock: stock
      };
    });

    d.customers = [
      { id: uid(), name: 'Ravi Kumar', phone: '98450 11223', email: 'ravi@example.com', address: '' },
      { id: uid(), name: 'Meena Traders', phone: '98450 44556', email: 'meena@example.com', address: '5th Cross, Jayanagar' },
      { id: uid(), name: 'Anil Stores', phone: '98450 77889', email: '', address: '' }
    ];

    function mkBill(daysAgo, branchId, staffId, custIdx, picks, paid) {
      var dt = new Date(); dt.setDate(dt.getDate() - daysAgo);
      var iso = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
      var lines = picks.map(function (p) {
        var it = d.items.filter(function (x) { return x.sku === p[0]; })[0];
        return { itemId: it.id, name: it.name, qty: p[1], price: it.price, cost: it.cost };
      });
      var t = computeRaw(lines, 0, d.settings.taxRate);
      return {
        id: uid(), no: 'INV-' + (++d.counter), date: iso, created: dt.getTime(),
        branchId: branchId, staffId: staffId,
        customerId: custIdx == null ? '' : d.customers[custIdx].id,
        lines: lines, discount: 0, taxRate: d.settings.taxRate,
        subtotal: t.subtotal, tax: t.tax, total: t.total,
        paid: paid ? t.total : r2(t.total / 2), method: paid ? 'Cash' : 'Card',
        payments: paid ? [{ method: 'Cash', amount: t.total }] : [{ method: 'Card', amount: r2(t.total / 2) }], note: ''
      };
    }
    var owner = d.staff[0], mgr = d.staff[1], cash = d.staff[2];
    d.invoices = [
      mkBill(0, b1, owner.id, 0, [['RICE-5', 2], ['OIL-1', 4]], true),
      mkBill(1, b1, cash.id, null, [['SUG-1', 5], ['TEA-500', 1]], true),
      mkBill(2, b2, mgr.id, 1, [['DET-2', 2], ['SOAP-125', 3]], true),
      mkBill(4, b1, owner.id, 2, [['ATTA-10', 1]], false)
    ];
    d.invoices.forEach(function (inv) {
      inv.lines.forEach(function (l) {
        var it = d.items.filter(function (x) { return x.id === l.itemId; })[0];
        if (it) it.stock[inv.branchId] = Math.max(0, (it.stock[inv.branchId] || 0) - l.qty);
      });
    });

    d.expenses = [
      { id: uid(), date: today(), category: 'Rent', amount: 18000, method: 'Bank', note: 'Shop rent', branchId: b1, staffId: owner.id },
      { id: uid(), date: today(), category: 'Electricity', amount: 2400, method: 'UPI', note: 'Monthly bill', branchId: b1, staffId: owner.id },
      { id: uid(), date: today(), category: 'Salary', amount: 15000, method: 'Bank', note: 'Ravi — salary', branchId: b2, staffId: mgr.id }
    ];

    var tea = d.items.filter(function (x) { return x.sku === 'TEA-500'; })[0];
    var sugar = d.items.filter(function (x) { return x.sku === 'SUG-1'; })[0];
    d.transfers = [{
      id: uid(), no: 'TRF-' + (++d.tcounter), date: today(), created: Date.now() - 3600000,
      from: b1, to: b2, status: 'pending', note: 'Weekly top-up',
      lines: [
        { itemId: tea.id, name: tea.name, qty: 4 },
        { itemId: sugar.id, name: sugar.name, qty: 10 }
      ],
      by: owner.id, byName: owner.name, acceptedBy: '', acceptedAt: 0
    }];

    d.suppliers = [
      { id: uid(), name: 'Sharma Wholesale', phone: '98860 10101', email: 'orders@sharma.test', address: 'APMC Yard' },
      { id: uid(), name: 'Sunrise Distributors', phone: '98860 20202', email: 'sales@sunrise.test', address: 'Industrial Area' }
    ];

    var rice = d.items.filter(function (x) { return x.sku === 'RICE-5'; })[0];
    var sugar2 = d.items.filter(function (x) { return x.sku === 'SUG-1'; })[0];
    var milk = d.items.filter(function (x) { return x.sku === 'MILK-1'; })[0];
    var alloc1 = {}, alloc2 = {};
    alloc1[b1] = 6; alloc1[b2] = 4;
    alloc2[b1] = 10; alloc2[b2] = 10;
    d.purchases = [{
      id: uid(), no: 'PUR-' + (++d.pcounter), date: today(), created: Date.now() - 7200000,
      supplierId: d.suppliers[0].id, method: 'Bank', paid: true,
      lines: [
        { itemId: rice.id, name: rice.name, qty: 10, cost: rice.cost, alloc: alloc1 },
        { itemId: sugar2.id, name: sugar2.name, qty: 20, cost: sugar2.cost, alloc: alloc2 }
      ],
      total: r2(10 * rice.cost + 20 * sugar2.cost), byName: owner.name
    }];
    d.damages = [{
      id: uid(), date: today(), created: Date.now(), branchId: b1, itemId: milk.id, name: milk.name,
      qty: 2, costValue: r2(2 * milk.cost), reason: 'Expired', byName: cash.name, staffId: cash.id,
      adjusted: true, adjustedByName: owner.name
    }];
    d.preturns = [];
    d.sreturns = [];
    d.staffLedger = [
      { id: uid(), staffId: cash.id, date: today(), created: Date.now(), type: 'advance', amount: 5000, note: 'Salary advance', byName: owner.name },
      { id: uid(), staffId: cash.id, date: today(), created: Date.now() + 1, type: 'repayment', amount: 2000, note: 'Recovered from salary', byName: owner.name },
      { id: uid(), staffId: mgr.id, date: today(), created: Date.now(), type: 'advance', amount: 3000, note: 'Travel advance', byName: owner.name }
    ];

    return d;
  }

  function computeRaw(lines, discount, taxRate, extraCharges, discountType, roundOffOpt) {
    var sub = 0, cost = 0, lineDisc = 0;
    (lines || []).forEach(function (l) {
      var ls = r2((Number(l.qty) || 0) * (Number(l.price) || 0));
      var ld = Math.min(ls, Math.max(0, r2(Number(l.disc) || 0)));
      sub += ls;
      lineDisc += ld;
      cost += (Number(l.qty) || 0) * (Number(l.cost) || 0);
    });
    sub = r2(sub);
    lineDisc = r2(lineDisc);
    var afterLine = r2(Math.max(0, sub - lineDisc));
    var dtype = discountType === 'percent' ? 'percent' : 'amount';
    var billIn = Math.max(0, Number(discount) || 0);
    var billDiscount = dtype === 'percent' ? r2(afterLine * billIn / 100) : r2(billIn);
    billDiscount = Math.min(afterLine, billDiscount);
    var discountAmt = r2(lineDisc + billDiscount);
    var taxable = Math.max(0, r2(afterLine - billDiscount));
    var rate = Number(taxRate) || 0;
    var tax = r2(taxable * rate / 100);
    var charges = r2((extraCharges || []).reduce(function (s, c) { return s + (Number(c.amount) || 0); }, 0));
    var raw = r2(taxable + tax + charges);
    var roundOff = 0;
    if (typeof roundOffOpt === 'number') roundOff = r2(roundOffOpt);
    else if (roundOffOpt === true || roundOffOpt === 'nearest') roundOff = r2(Math.round(raw) - raw);
    var total = r2(raw + roundOff);
    return { subtotal: sub, lineDisc: lineDisc, billDisc: r2(billDiscount), discount: discountAmt, taxable: taxable, cost: r2(cost), tax: tax, charges: charges, roundOff: roundOff, total: total };
  }

  /* ------------------------------------------------------------- persistence */
  function normalize(obj) {
    var base = defaults();
    obj = obj || {};
    obj.settings = Object.assign(base.settings, obj.settings || {});
    obj.branches = Array.isArray(obj.branches) && obj.branches.length ? obj.branches : base.branches;
    obj.branchArchive = obj.branchArchive && typeof obj.branchArchive === 'object' ? obj.branchArchive : {};
    obj.staff = Array.isArray(obj.staff) && obj.staff.length ? obj.staff : base.staff;
    ['items', 'customers', 'invoices', 'estimates', 'transfers', 'expenses', 'suppliers', 'purchases', 'preturns', 'sreturns', 'damages', 'staffLedger', 'activity', 'cats'].forEach(function (k) {
      obj[k] = Array.isArray(obj[k]) ? obj[k] : [];
    });
    /* older seeded bills stored their rows as `items`; normalise so every
       report and list can rely on `lines` */
    obj.invoices.forEach(function (inv) {
      if (!Array.isArray(inv.lines)) inv.lines = Array.isArray(inv.items) ? inv.items : [];
    });
    if (['modern', 'gst', 'a5', 'receipt'].indexOf(obj.settings.receiptStyle) < 0) {
      obj.settings.receiptStyle = 'a5';
    }
    obj.settings.discountType = (obj.settings.discountType === 'percent') ? 'percent' : 'amount';
    var ps = obj.settings, pdefs = {
      printTextSize:'small', pageSize:'auto', orientation:'auto', billTheme:'default',
      printRepeatHeader:true, printCompanyName:true, companyNameSize:'medium',
      printLogo:true, printAddress:true, printEmail:true, printPhone:true,
      printGstin:false, gstin:'', printBillOfSupply:false, extraTopSpace:0,
      printOriginalDuplicate:false, txnSaleName:'Invoice', txnPurchaseName:'Purchase',
      expandTable:false, minRows:0, printTotalQty:true, printDecimals:true,
      printReceived:true, printBalance:true, printCurrentBalance:true,
      printTaxDetails:false, amountGrouping:true, amountWordsFormat:'indian',
      printYouSaved:true, printDescription:true, printTerms:true,
      printReceivedBy:true, printDeliveredBy:false, printSignature:false,
      signatureText:'', printPaymentMode:true, printAcknowledgement:false,
      printPageNumbers:true
    };
    Object.keys(pdefs).forEach(function(k){ if (ps[k] == null) ps[k] = pdefs[k]; });
    if (ps.roundOffOn == null) ps.roundOffOn = false;
    ps.stockPolicy = (ps.stockPolicy === 'block') ? 'block' : 'warn';
    ps.extraTopSpace = Math.max(0, Math.min(30, Math.floor(Number(ps.extraTopSpace) || 0)));
    ps.minRows = Math.max(0, Math.min(30, Math.floor(Number(ps.minRows) || 0)));
    var ddef = (base.settings && base.settings.dashboard) || { view:'comfortable', cards:{salesToday:true,salesMonth:true,expensesMonth:true,unpaid:true,myTarget:true}, sections:[{id:'eod',on:true},{id:'kpis',on:true},{id:'target',on:true},{id:'attention',on:true},{id:'complaints',on:true},{id:'collect',on:true},{id:'recent',on:true},{id:'low',on:true}], limits:{recent:40,low:6,collect:4} };
    var dc = ps.dashboard && typeof ps.dashboard === 'object' ? ps.dashboard : {};
    dc.view = (dc.view === 'compact') ? 'compact' : 'comfortable';
    var cdef = ddef.cards || {};
    dc.cards = dc.cards && typeof dc.cards === 'object' ? dc.cards : {};
    Object.keys(cdef).forEach(function(k){ dc.cards[k] = (dc.cards[k] == null) ? cdef[k] : !!dc.cards[k]; });
    var sdef = ddef.sections || [];
    var sids = sdef.map(function(x){ return x.id; });
    var cur = Array.isArray(dc.sections) ? dc.sections.slice() : [];
    var normSecs = [];
    cur.forEach(function(x){
      if (!x || sids.indexOf(x.id) < 0) return;
      if (normSecs.some(function(y){ return y.id === x.id; })) return;
      normSecs.push({ id: x.id, on: x.on !== false });
    });
    sdef.forEach(function(x){ if (!normSecs.some(function(y){ return y.id === x.id; })) normSecs.push({ id:x.id, on:x.on !== false }); });
    dc.sections = normSecs;
    dc.limits = dc.limits && typeof dc.limits === 'object' ? dc.limits : {};
    var ldef = ddef.limits || {recent:5,low:6,collect:4};
    Object.keys(ldef).forEach(function(k){
      var v = parseInt(dc.limits[k], 10);
      dc.limits[k] = (v >= 1 && v <= 20) ? v : ldef[k];
    });
    ps.dashboard = dc;
    var ap = ps.appearance && typeof ps.appearance === 'object' ? ps.appearance : {};
    ap.mode = (ap.mode === 'dark') ? 'dark' : 'light';
    var colors = ['red','blue','green','purple','orange','teal'];
    ap.color = colors.indexOf(ap.color) > -1 ? ap.color : 'red';
    ps.appearance = ap;

    /* cloud sync defaults — never ship credentials in code; configure from Settings */
    if (!ps.cloud || typeof ps.cloud !== 'object') ps.cloud = {};
    if (ps.cloud.url == null) ps.cloud.url = '';
    if (ps.cloud.key == null) ps.cloud.key = '';
    if (ps.cloud.shop == null) ps.cloud.shop = '';
    if (ps.cloud.auto == null) ps.cloud.auto = true;
    if (ps.cloud.syncedAt == null) ps.cloud.syncedAt = 0;
    if (ps.cloud.lastError == null) ps.cloud.lastError = '';
    obj.items.forEach(function (it) {
      if (!it.stock || typeof it.stock !== 'object' || Array.isArray(it.stock)) {
        var flat = Number(it.stock) || 0;
        it.stock = {};
        obj.branches.forEach(function (b) { it.stock[b.id] = 0; });
        it.stock[obj.branches[0].id] = flat;
      }
      // Batch system: each purchase creates a batch with its own cost.
      // Older items without batches get a single legacy batch so stock/cost stay consistent.
      if (!Array.isArray(it.batches)) {
        it.batches = [];
        var hasStock = obj.branches.some(function (b) { return (Number(it.stock[b.id]) || 0) > 0; });
        var legacyCost = r2(Number(it.cost) || 0);
        if (hasStock) {
          var bstock = {};
          obj.branches.forEach(function (b) { bstock[b.id] = r2(Math.max(0, Number(it.stock[b.id]) || 0)); });
          it.batches.push({
            id: uid(), no: 1, label: 'Batch 1', cost: legacyCost,
            created: Number(it.created) || Date.now(), purchaseId: '', purchaseNo: '', supplierId: '',
            stock: bstock
          });
        }
      }
      // Keep item.stock in sync with batches when batches exist.
      if (it.batches.length) {
        obj.branches.forEach(function (b) {
          var s = 0;
          it.batches.forEach(function (bt) { s += Number(bt.stock && bt.stock[b.id]) || 0; });
          it.stock[b.id] = r2(s);
        });
      }
      obj.branches.forEach(function (b) { if (it.stock[b.id] == null) it.stock[b.id] = 0; });
    });
    obj.staff.forEach(function (s) {
      s.perms = Array.isArray(s.perms) ? s.perms : (ROLE_PERMS[s.role] || ROLE_PERMS.cashier).slice();
      if (s.active == null) s.active = true;
    });
    /* entries saved before the adjust step already had their stock reduced */
    obj.damages.forEach(function (d) {
      if (d.adjusted == null) d.adjusted = true;
    });
    if (!Array.isArray(obj.complaints)) obj.complaints = [];
    obj.complaints.forEach(function (c) {
      if (!c.status) c.status = c.resolvedDate ? 'resolved' : 'open';
      if (!c.no) c.no = 'CMP';
    });
    obj.ccomp = Number(obj.ccomp) || ((obj.complaints || []).length + 1);
    obj.counter = Number(obj.counter) || 1040;
    /* estimates are quotes: they live apart from invoices and never move stock */
    obj.ecounter = Number(obj.ecounter) || 100;
    obj.tcounter = Number(obj.tcounter) || 100;
    obj.pcounter = Number(obj.pcounter) || 200;
    obj.rcounter = Number(obj.rcounter) || 300;
    return obj;
  }

  function load() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    loadedEmpty = !raw;
    db = raw ? normalize(raw) : defaults();
    if (!raw) save();
    try { sessionStaffId = sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { sessionStaffId = ''; }
    if (sessionStaffId && !db.staff.some(function (s) { return s.id === sessionStaffId && s.active; })) {
      sessionStaffId = '';
    }
    migrateStaffPerms();
    return db;
  }

  var saveFailure = null;

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      saveFailure = null;
      return true;
    } catch (e) {
      saveFailure = e || new Error('Browser storage refused the save');
      /* the change is still in memory but is not written to this device —
         announce it so the app can warn instead of losing it silently */
      try {
        window.dispatchEvent(new CustomEvent('store-save-error', {
          detail: { message: String((saveFailure && saveFailure.message) || saveFailure) }
        }));
      } catch (e2) {}
      return false;
    }
  }

  /* message from the last failed save, or '' when the last save worked */
  function saveError() {
    return saveFailure ? String((saveFailure && saveFailure.message) || saveFailure) : '';
  }

  /* true when this browser had nothing stored at all when the app started —
     a fresh device, a cleared browser or a newly opened copy of the app */
  function wasEmpty() { return loadedEmpty; }

  function reset(seed) {
    db = seed ? demo() : defaults();
    save();
    return db;
  }

  function importData(obj) {
    if (!obj || !Array.isArray(obj.items) || !Array.isArray(obj.staff)) throw new Error('bad backup');
    db = normalize(obj);
    save();
    return db;
  }

  /* ------------------------------------------------------------------- auth */
  /* bring older saved permission lists up to date with newer, split-out perms */
  function migratePerms(perms) {
    var p = (perms || []).slice();
    function add(k) { if (p.indexOf(k) === -1) p.push(k); }
    /* damage used to cover entry + delete; settle stayed separate */
    if (p.indexOf('damage') > -1) { add('damage.entry'); add('damage.delete'); }
    /* purchases screen implied creating entries; payment was tied to purchase.edit */
    if (p.indexOf('purchases') > -1) { add('purchase.entry'); }
    if (p.indexOf('purchase.edit') > -1) { add('purchase.pay'); }
    return p;
  }
  function migrateStaffPerms() {
    if (!db || !db.staff) return;
    db.staff.forEach(function (st) {
      if (!st) return;
      /* an owner always has everything, so keep the saved list in step */
      if (st.role === 'owner') { st.perms = ALL_PERMS.slice(); st.permsSplit = true; return; }
      if (st.perms && !st.permsSplit) { st.perms = migratePerms(st.perms); st.permsSplit = true; }
      /* multi-branch access: normalise branchIds from legacy single branchId */
      if (!Array.isArray(st.branchIds)) {
        st.branchIds = st.branchId ? [st.branchId] : [];
      }
      if (!st.branchIds.length && st.branchId) st.branchIds = [st.branchId];
      if (st.branchIds.length && !st.branchId) st.branchId = st.branchIds[0];
    });
  }

  /* ------------------------------------------------------------- passwords
     Passwords are never kept in clear text. Each one is salted and stretched
     with PBKDF2-SHA256 through WebCrypto, and only the salt + hash are stored.
     Old records that still hold a plain `password` are checked once and then
     upgraded in place, so an existing shop keeps working after the update. */
  var PBKDF2_ITER = 150000;

  function hexOf(buf) {
    var bytes = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2);
    return out;
  }
  function newSalt() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return hexOf(a.buffer);
  }
  function subtleCrypto() {
    var c = window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle);
    return c || null;
  }
  function pbkdf2(password, saltHex, iterations) {
    var c = subtleCrypto();
    if (!c) return Promise.reject(new Error('This browser cannot secure passwords'));
    var pairs = String(saltHex || '').match(/.{2}/g) || [];
    var salt = new Uint8Array(pairs.map(function (h) { return parseInt(h, 16); }));
    var enc = new TextEncoder();
    return c.importKey('raw', enc.encode(String(password)), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (key) {
        return c.deriveBits({ name: 'PBKDF2', salt: salt, iterations: iterations || PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
      })
      .then(function (bits) { return hexOf(bits); });
  }
  function hashPassword(password) {
    var salt = newSalt();
    return pbkdf2(password, salt, PBKDF2_ITER).then(function (hash) {
      return { passHash: hash, passSalt: salt, passIter: PBKDF2_ITER };
    });
  }
  function isHashed(staff) { return !!(staff && staff.passHash && staff.passSalt); }
  function legacyPassword(staff) {
    return String(staff && (staff.password != null ? staff.password : staff.pin) || '');
  }
  /* compare against whatever form the record is in; never returns the secret */
  function verifyPassword(password, staff) {
    if (!staff) return Promise.resolve(false);
    var p = String(password || '');
    if (!p) return Promise.resolve(false);
    if (isHashed(staff)) {
      return pbkdf2(p, staff.passSalt, staff.passIter || PBKDF2_ITER)
        .then(function (hash) { return hash === staff.passHash; });
    }
    return Promise.resolve(legacyPassword(staff) === p);
  }
  function setPassword(staff, password) {
    var p = String(password || '');
    if (!staff) return Promise.reject(new Error('No staff account'));
    if (p.length < 4) return Promise.reject(new Error('Use at least 4 characters'));
    return hashPassword(p).then(function (rec) {
      staff.passHash = rec.passHash;
      staff.passSalt = rec.passSalt;
      staff.passIter = rec.passIter;
      staff.passWeak = p === '1234';
      delete staff.password;
      delete staff.pin;
      return staff;
    });
  }
  /* a login still carrying the seeded 1234 has to be changed before it is used */
  function needsPasswordChange(staff) {
    if (!staff) return false;
    if (staff.passWeak) return true;
    if (!isHashed(staff)) return legacyPassword(staff) === '1234';
    return false;
  }
  function staffHashedCopy(staff) {
    if (!staff) return null;
    var c = {};
    Object.keys(staff).forEach(function (k) { if (k !== 'password' && k !== 'pin') c[k] = staff[k]; });
    return c;
  }

  function login(username, password) {
    var u = String(username || '').trim().toLowerCase();
    var p = String(password || '');
    var s = db.staff.filter(function (x) {
      return String(x.username || '').toLowerCase() === u && x.active !== false;
    })[0];
    if (!s) return Promise.resolve({ error: 'No staff account with that user ID' });
    return verifyPassword(p, s).then(function (ok) {
      if (!ok) return { error: 'Incorrect password' };
      /* first sign-in on an old record: store the salted hash from now on */
      if (!isHashed(s)) {
        var wasWeak = legacyPassword(s) === '1234';
        return hashPassword(p).then(function (rec) {
          s.passHash = rec.passHash;
          s.passSalt = rec.passSalt;
          s.passIter = rec.passIter;
          if (wasWeak) s.passWeak = true;
          delete s.password;
          delete s.pin;
          try { save(); } catch (e) {}
          sessionStaffId = s.id;
          try { sessionStorage.setItem(SESSION_KEY, s.id); } catch (e) {}
          return { staff: s, changedDefault: needsPasswordChange(s) };
        });
      }
      sessionStaffId = s.id;
      try { sessionStorage.setItem(SESSION_KEY, s.id); } catch (e) {}
      return { staff: s, changedDefault: needsPasswordChange(s) };
    });
  }

  function logout() {
    sessionStaffId = '';
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function currentStaff() {
    if (!db || !sessionStaffId) return null;
    return db.staff.filter(function (s) { return s.id === sessionStaffId; })[0] || null;
  }

  function isOwner() {
    var s = currentStaff();
    return !!s && s.role === 'owner';
  }

  function can(perm) {
    var s = currentStaff();
    if (!s) return false;
    if (s.role === 'owner') return true;
    if (!s.perms) return false;
    return s.perms.indexOf(perm) > -1;
  }

  /* ---------------------------------------------------------------- branches */
  function branchById(id) {
    var live = db.branches.filter(function (b) { return b.id === id; })[0];
    if (live) return live;
    var gone = db.branchArchive && db.branchArchive[id];
    return gone ? { id: gone.id, name: gone.name, removed: true } : null;
  }
  function branchName(id) { var b = branchById(id); return b ? b.name : '—'; }
  function staffBranchIds(s) {
    s = s || currentStaff();
    if (!s) return [];
    var ids = Array.isArray(s.branchIds) ? s.branchIds.slice() : [];
    if (!ids.length && s.branchId) ids = [s.branchId];
    /* keep only live branches, but never drop everything */
    var live = ids.filter(function (id) { var b = branchById(id); return b && !b.removed; });
    return live.length ? live : ids;
  }
  function myBranchId() {
    var s = currentStaff();
    if (s && s.role !== 'owner') {
      var ids = staffBranchIds(s);
      if (ids.length) {
        var cur = s.branchId;
        if (cur && ids.indexOf(cur) > -1) return cur;
        return ids[0];
      }
      return (db.branches[0] && db.branches[0].id) || '';
    }
    var own = (s && s.branchId) || '';
    if (branchById(own) && !branchById(own).removed) return own;
    return (db.branches[0] && db.branches[0].id) || '';
  }
  function canSeeAllBranches() { return isOwner(); }
  function canSwitchBranches() {
    if (isOwner()) return db.branches.length > 1;
    return staffBranchIds().length > 1;
  }
  function visibleBranches() {
    if (canSeeAllBranches()) return db.branches;
    var ids = staffBranchIds();
    var list = db.branches.filter(function (b) { return ids.indexOf(b.id) > -1; });
    return list.length ? list : db.branches.filter(function (b) { return b.id === myBranchId(); });
  }

  /* ------------------------------------------------------------------- stock / batches */
  function itemBatches(item) {
    if (!item) return [];
    if (!Array.isArray(item.batches)) item.batches = [];
    return item.batches;
  }
  function batchStock(bt, branchId) {
    if (!bt || !bt.stock) return 0;
    return r2(Number(bt.stock[branchId]) || 0);
  }
  function batchTotalStock(bt) {
    var t = 0;
    if (!bt || !bt.stock) return 0;
    db.branches.forEach(function (b) { t += Math.max(0, Number(bt.stock[b.id]) || 0); });
    return r2(t);
  }
  function syncItemStock(item) {
    if (!item) return;
    if (!item.stock || typeof item.stock !== 'object') item.stock = {};
    var batches = Array.isArray(item.batches) ? item.batches : [];
    if (batches.length) {
      db.branches.forEach(function (b) {
        var s = 0;
        batches.forEach(function (bt) { s += Number(bt.stock && bt.stock[b.id]) || 0; });
        item.stock[b.id] = Math.max(0, r2(s));
      });
    } else {
      db.branches.forEach(function (b) { if (item.stock[b.id] == null) item.stock[b.id] = 0; });
    }
  }
  function nextBatchNo(item) {
    var max = 0;
    itemBatches(item).forEach(function (bt) {
      var n = Number(bt.no) || 0;
      if (n > max) max = n;
    });
    return max + 1;
  }
  function ensureLegacyBatch(item) {
    if (!item) return null;
    var batches = itemBatches(item);
    if (batches.length) return batches[0];
    var hasStock = db.branches.some(function (b) { return (Number(item.stock && item.stock[b.id]) || 0) > 0; });
    var cost = r2(Number(item.cost) || 0);
    if (!hasStock) return null;
    var bstock = {};
    db.branches.forEach(function (b) { bstock[b.id] = r2(Math.max(0, Number(item.stock && item.stock[b.id]) || 0)); });
    var bt = { id: uid(), no: 1, label: 'Batch 1', cost: cost, created: Date.now(), purchaseId: '', purchaseNo: '', supplierId: '', stock: bstock };
    batches.push(bt);
    syncItemStock(item);
    return bt;
  }
  function createBatch(item, opts) {
    opts = opts || {};
    ensureLegacyBatch(item);
    var batches = itemBatches(item);
    var no = nextBatchNo(item);
    var bt = {
      id: uid(),
      no: no,
      label: 'Batch ' + no,
      cost: r2(Math.max(0, Number(opts.cost) || 0)),
      created: opts.created || Date.now(),
      purchaseId: opts.purchaseId || '',
      purchaseNo: opts.purchaseNo || '',
      supplierId: opts.supplierId || '',
      stock: {}
    };
    db.branches.forEach(function (b) { bt.stock[b.id] = 0; });
    batches.push(bt);
    return bt;
  }
  function batchById(item, batchId) {
    if (!item || !batchId) return null;
    var batches = itemBatches(item);
    for (var i = 0; i < batches.length; i++) if (batches[i].id === batchId) return batches[i];
    return null;
  }
  function pickSaleBatch(item, branchId) {
    var batches = itemBatches(item).filter(function (bt) { return batchStock(bt, branchId) > 0; });
    if (!batches.length) return null;
    batches.sort(function (a, b) { return (Number(a.created) || 0) - (Number(b.created) || 0) || (Number(a.no) || 0) - (Number(b.no) || 0); });
    return batches[0];
  }
  function stockOf(item, branchId) {
    if (!item) return 0;
    if (Array.isArray(item.batches) && item.batches.length) {
      var s = 0;
      item.batches.forEach(function (bt) { s += Number(bt.stock && bt.stock[branchId]) || 0; });
      return Math.max(0, r2(s));
    }
    if (!item.stock) return 0;
    return Math.max(0, Number(item.stock[branchId]) || 0);
  }
  function totalStock(item) {
    if (!item) return 0;
    var t = 0;
    db.branches.forEach(function (b) { t += Number(stockOf(item, b.id)) || 0; });
    return r2(t);
  }
  function addStock(item, branchId, delta, opts) {
    if (!item) return;
    opts = opts || {};
    if (!item.stock || typeof item.stock !== 'object') item.stock = {};
    var d = r2(Number(delta) || 0);
    if (!d) return;
    var batches = itemBatches(item);
    var batchId = opts.batchId || '';
    if (batchId || batches.length) {
      if (!batches.length) ensureLegacyBatch(item);
      batches = itemBatches(item);
      if (d > 0) {
        var bt = batchId ? batchById(item, batchId) : null;
        if (!bt) bt = batches[batches.length - 1];
        if (!bt) bt = createBatch(item, { cost: Number(item.cost) || 0 });
        if (!bt.stock) bt.stock = {};
        bt.stock[branchId] = r2((Number(bt.stock[branchId]) || 0) + d);
      } else {
        var left = Math.abs(d);
        var bt0 = batchId ? batchById(item, batchId) : null;
        var queue = bt0 ? [bt0] : batches.slice().sort(function (a, b) { return (Number(a.created) || 0) - (Number(b.created) || 0) || (Number(a.no) || 0) - (Number(b.no) || 0); });
        queue.forEach(function (btx) {
          if (left <= 0) return;
          var have = Math.max(0, Number(btx.stock && btx.stock[branchId]) || 0);
          if (!have) return;
          var take = Math.min(have, left);
          btx.stock[branchId] = r2(have - take);
          left = r2(left - take);
        });
        /* Oversold: put the remainder on the chosen (or newest) batch so the shortfall stays visible. */
        if (left > 0) {
          var last = bt0 || batches[batches.length - 1];
          if (last) { if (!last.stock) last.stock = {}; last.stock[branchId] = r2((Number(last.stock[branchId]) || 0) - left); }
        }
      }
      syncItemStock(item);
      return;
    }
    item.stock[branchId] = r2((Number(item.stock[branchId]) || 0) + d);
  }

  /* --------------------------------------------------------------- transfers */
  function pendingTransfersFor(branchId) {
    return db.transfers.filter(function (t) { return t.status === 'pending' && t.to === branchId; });
  }
  function acceptTransfer(id) {
    var t = db.transfers.filter(function (x) { return x.id === id; })[0];
    if (!t || t.status !== 'pending') return { error: 'Transfer not found' };
    for (var i = 0; i < t.lines.length; i++) {
      var it = db.items.filter(function (x) { return x.id === t.lines[i].itemId; })[0];
      if (!it || stockOf(it, t.from) < t.lines[i].qty) {
        return { error: 'Not enough stock in ' + branchName(t.from) + ' for ' + t.lines[i].name };
      }
    }
    t.lines.forEach(function (l) {
      var it = db.items.filter(function (x) { return x.id === l.itemId; })[0];
      if (!it) return;
      var left = Number(l.qty) || 0;
      /* move the stock batch by batch, oldest first, so cost follows the goods */
      var batches = itemBatches(it).slice().sort(function (a, b) { return (Number(a.created) || 0) - (Number(b.created) || 0) || (Number(a.no) || 0) - (Number(b.no) || 0); });
      if (!batches.length) { addStock(it, t.from, -left); addStock(it, t.to, left); return; }
      batches.forEach(function (bt) {
        if (left <= 0) return;
        var have = Math.max(0, Number(bt.stock && bt.stock[t.from]) || 0);
        if (!have) return;
        var take = Math.min(have, left);
        addStock(it, t.from, -take, { batchId: bt.id });
        addStock(it, t.to, take, { batchId: bt.id });
        left = r2(left - take);
      });
      if (left > 0) {
        var lastB = batches[batches.length - 1];
        addStock(it, t.from, -left, { batchId: lastB.id });
        addStock(it, t.to, left, { batchId: lastB.id });
      }
    });
    var s = currentStaff();
    t.status = 'accepted';
    t.acceptedBy = s ? s.name : '';
    t.acceptedAt = Date.now();
    save();
    return { transfer: t };
  }
  function rejectTransfer(id) {
    var t = db.transfers.filter(function (x) { return x.id === id; })[0];
    if (!t || t.status !== 'pending') return { error: 'Transfer not found' };
    var s = currentStaff();
    t.status = 'rejected';
    t.acceptedBy = s ? s.name : '';
    t.acceptedAt = Date.now();
    save();
    return { transfer: t };
  }

  /* ------------------------------------------------------------------- theme */
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; }
  }
  function setTheme(mode) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  }

  return {
    KEY: KEY, ALL_PERMS: ALL_PERMS, PERM_LABELS: PERM_LABELS, PERM_GROUPS: PERM_GROUPS,
    ROLE_LABEL: ROLE_LABEL, ROLE_PERMS: ROLE_PERMS,
    load: load, save: save, saveError: saveError, reset: reset, importData: importData, wasEmpty: wasEmpty,
    get: function () { return db; },
    login: login, logout: logout, currentStaff: currentStaff, isOwner: isOwner, can: can,
    hashPassword: hashPassword, verifyPassword: verifyPassword, setPassword: setPassword,
    needsPasswordChange: needsPasswordChange, staffHashedCopy: staffHashedCopy, isHashed: isHashed,
    branchById: branchById, branchName: branchName, myBranchId: myBranchId, staffBranchIds: staffBranchIds,
    canSeeAllBranches: canSeeAllBranches, canSwitchBranches: canSwitchBranches, visibleBranches: visibleBranches,
    migratePerms: migratePerms, migrateStaffPerms: migrateStaffPerms,
    stockOf: stockOf, totalStock: totalStock, addStock: addStock,
    itemBatches: itemBatches, batchStock: batchStock, batchTotalStock: batchTotalStock,
    batchById: batchById, createBatch: createBatch, nextBatchNo: nextBatchNo,
    ensureLegacyBatch: ensureLegacyBatch, pickSaleBatch: pickSaleBatch, syncItemStock: syncItemStock,
    pendingTransfersFor: pendingTransfersFor,
    acceptTransfer: acceptTransfer, rejectTransfer: rejectTransfer,
    compute: function (lines, discount, taxRate, extraCharges, opts) {
      opts = opts || {};
      var dtype = opts.discountType || (db && db.settings ? db.settings.discountType : 'amount');
      var ro = opts.roundOff;
      if (ro === undefined) ro = (db && db.settings && db.settings.roundOffOn) ? true : false;
      return computeRaw(lines, discount, taxRate == null && db ? db.settings.taxRate : taxRate, extraCharges, dtype, ro);
    },
    money: money, num: num, r2: r2, today: today, monthStart: monthStart, fmtDate: fmtDate,
    esc: esc, uid: uid, match: match,
    getTheme: getTheme, setTheme: setTheme
  };
})();
