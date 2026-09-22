/**
 * Stayopx Manager — Ticketing & Daily Work Log System
 * Google Apps Script backend (API layer over Google Sheets)
 *
 * v2 — PERFORMANCE RELEASE. What changed and why:
 *  • dashboard()          one request returns everything the dashboard needs (was 3–4 parallel requests,
 *                         each re-reading the whole Tickets sheet). Only unfinished + today's tickets are sent.
 *  • response cache       read results are cached for CACHE_SECONDS and thrown away the moment anything is
 *                         written, so a team opening the app at the same time hits the sheet once, not 20 times.
 *  • indexed lookups      finding one ticket / one ticket's activity uses the sheet's own text search instead
 *                         of downloading the whole tab (status clicks, comments and ticket modals are ~10x faster).
 *  • batched triggers     markOverdueTickets / dailyScheduler write in a handful of calls instead of 5 per ticket.
 *  • windowed lists       ticket / EOD lists return the last N days by default; the app can still ask for all.
 *  • archiveOldTickets    optional monthly job that moves old finished tickets to an archive tab so the live
 *                         tab stays small forever (Reports still include the archive).
 *
 * SETUP (see SETUP.md):
 *  1. Create a blank Google Spreadsheet, open Extensions → Apps Script, paste this file.
 *  2. Run setupDatabase() once (authorize when prompted). It creates all tabs + a default admin.
 *  3. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone. Copy the /exec URL.
 *  4. Paste the URL into CONFIG.API_URL at the top of script.js.
 *  5. Add time-driven triggers: dailyScheduler (daily, 5–6 AM), markOverdueTickets (hourly),
 *     and optionally archiveOldTickets (monthly).
 *  6. Run authorizeEmail() once so the "Forgot access code?" emails can be sent.
 *
 * UPGRADING from v1: paste this file over the old one, run setupDatabase() once more (it only adds what is
 * missing), then Deploy → Manage deployments → edit → New version → Deploy.
 */

var DB = {
  USERS: 'Users',
  TICKETS: 'Tickets',
  RECURRING: 'Recurring Tickets',
  ACTIVITY: 'Ticket Activity',
  EOD: 'EOD Logs',
  SETTINGS: 'Settings',
  ARCHIVE: 'Tickets Archive'
};

var HEADERS = {};
HEADERS[DB.USERS] = ['User ID','Name','Email','Role','Department','Status','Created Date','Access Code'];
HEADERS[DB.TICKETS] = ['Ticket ID','Parent Ticket ID','Title','Description','Assigned To','Created By','Department','Priority','Ticket Type','Scheduled Date','Scheduled Time','Due Date','Status','Created Date','Updated Date','Completed Date'];
HEADERS[DB.RECURRING] = ['Recurring ID','Title','Description','Assigned To','Frequency','Day','Time','Start Date','End Date','Status','Created By','Department','Priority'];
HEADERS[DB.ACTIVITY] = ['Activity ID','Ticket ID','User','Previous Status','New Status','Comment','Date','Time'];
HEADERS[DB.EOD] = ['Log ID','Employee ID','Employee Name','Date','Tickets Assigned','Tickets Completed','Tickets Pending','Work Completed','Challenges','Pending Work','Tomorrow Plan','Remarks','Submitted At'];
HEADERS[DB.SETTINGS] = ['Key','Value','Description'];
HEADERS[DB.ARCHIVE] = HEADERS[DB.TICKETS];

var TZ = Session.getScriptTimeZone();
var APP_VERSION = 'v2.3';
var _cacheHits = 0, _cacheMisses = 0, _t0 = Date.now();   // per-request timing, reported back to the app

/* How long a read result may be served from cache while nothing has been written (any write through the app
 * makes it obsolete). This only limits how long a change made DIRECTLY in the Google Sheet takes to show up. */
var CACHE_SECONDS = 120;
/* A result may still be served for this long after a write by SOMEONE ELSE, so a busy team shares one sheet
 * read instead of each person triggering a full read. A person's own writes always show immediately. */
var STALE_OK_MS = 30 * 1000;
var WRITE_ACTIONS = { createTicket: 1, updateTicket: 1, updateStatus: 1, addComment: 1, cancelTicket: 1, createRecurring: 1,
  updateRecurring: 1, submitEOD: 1, addUser: 1, updateUser: 1, updateSetting: 1, maintenance: 1 };
var _reqUser = null;

/* Statuses that mean "still to be done" */
var ACTIVE = { 'Open': 1, 'In Progress': 1, 'On Hold': 1, 'Overdue': 1 };

/* Long text in ticket LISTS is trimmed to this many characters; the ticket modal always loads the full text */
var LIST_DESC_CHARS = 240;

var DEFAULT_SETTINGS = [
  ['EOD_CUTOFF', '23:00', 'Employees can edit their EOD log until this time (HH:mm, 24h)'],
  ['STATUSES', 'Open,In Progress,Completed,On Hold,Overdue', 'Ticket statuses'],
  ['PRIORITIES', 'Low,Medium,High,Critical', 'Ticket priorities'],
  ['DEPARTMENTS', 'Operations,Housekeeping,F&B,Maintenance,Finance,Sales,Tech', 'Departments'],
  ['FREQUENCIES', 'One-Time,Daily,Weekly,Monthly', 'Ticket types'],
  ['APP_NAME', 'Stayopx Manager', 'Application display name'],
  ['ARCHIVE_AFTER_DAYS', '60', 'archiveOldTickets moves Completed/Cancelled tickets older than this many days to the archive tab'],
  ['EXPIRE_AFTER_DAYS', '14', 'expireOverdueRecurring marks recurring tickets still Overdue this many days after their due date as Expired']
];

/* ============================================================
 * ONE-TIME SETUP (safe to run again — it only adds what is missing)
 * ============================================================ */
function setupDatabase() {
  var s = ss();
  Object.keys(DB).forEach(function(k) {
    var name = DB[k];
    var sh = s.getSheetByName(name);
    if (!sh) sh = s.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold').setBackground('#EEF1F4');
      sh.setFrozenRows(1);
    }
  });
  // Force date-sensitive columns to plain text so values round-trip as strings
  [DB.TICKETS, DB.ARCHIVE].forEach(function(n) {
    var tk = s.getSheetByName(n);
    tk.getRange('J:L').setNumberFormat('@'); tk.getRange('N:P').setNumberFormat('@');
  });
  s.getSheetByName(DB.ACTIVITY).getRange('G:H').setNumberFormat('@');
  s.getSheetByName(DB.EOD).getRange('D:D').setNumberFormat('@');
  s.getSheetByName(DB.EOD).getRange('M:M').setNumberFormat('@');
  s.getSheetByName(DB.RECURRING).getRange('G:I').setNumberFormat('@');
  s.getSheetByName(DB.USERS).getRange('G:H').setNumberFormat('@');

  // Settings: add any key that is not there yet, keep existing values
  var have = {};
  rows(DB.SETTINGS).forEach(function(r) { have[r['Key']] = true; });
  var missing = DEFAULT_SETTINGS.filter(function(r) { return !have[r[0]]; });
  if (missing.length) {
    var st = s.getSheetByName(DB.SETTINGS);
    st.getRange(st.getLastRow() + 1, 1, missing.length, 3).setValues(missing);
  }

  var users = s.getSheetByName(DB.USERS);
  if (users.getLastRow() < 2) {
    users.appendRow(['USR-1001', 'Admin', 'admin@company.com', 'Admin', 'Operations', 'Active', today(), 'admin123']);
  }
  bumpVersion();
  return 'Database ready';
}

/* ============================================================
 * HTTP ENTRY POINTS
 * ============================================================ */
function doGet() {
  return json({ ok: true, data: 'Stayopx Manager API ' + APP_VERSION + ' is running' });
}

function doPost(e) {
  _t0 = Date.now(); _memo = {}; _cacheHits = 0; _cacheMisses = 0; _reqUser = null;   // fresh per request
  try {
    if (!e || !e.postData || !e.postData.contents) return json({ ok: false, error: 'BAD_REQUEST', message: 'Empty request.' });
    var req = JSON.parse(e.postData.contents);
    var action = req.action;
    var p = req.payload || {};
    var user = null;

    var publicActions = ['login', 'requestReset', 'resetPassword'];   // usable before signing in
    if (publicActions.indexOf(action) === -1) {
      user = validateToken(req.token);
      if (!user) return json({ ok: false, error: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' });
      _reqUser = user;
    }

    var adminOnly = ['updateTicket','createRecurring','updateRecurring','listUsers','addUser','updateUser','adminKPIs','listAllEOD','updateSetting','reportData','diagnose','maintenance'];
    if (adminOnly.indexOf(action) !== -1 && user.role !== 'Admin') {
      return json({ ok: false, error: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
    }

    var out;
    switch (action) {
      case 'login':            out = login(p); break;
      case 'requestReset':     out = requestReset(p); break;
      case 'resetPassword':    out = resetPassword(p); break;
      case 'bootstrap':        out = bootstrap(user); break;
      case 'dashboard':        out = dashboard(user); break;
      case 'listTickets':      out = listTickets(user, p); break;
      case 'getTicket':        out = getTicket(user, p); break;
      case 'createTicket':     out = createTicket(user, p); break;
      case 'updateTicket':     out = updateTicket(user, p); break;
      case 'updateStatus':     out = updateStatus(user, p); break;
      case 'addComment':       out = addComment(user, p); break;
      case 'cancelTicket':     out = cancelTicket(user, p); break;
      case 'createRecurring':  out = createRecurring(user, p); break;
      case 'listRecurring':    out = listRecurring(user); break;
      case 'updateRecurring':  out = updateRecurring(user, p); break;
      case 'submitEOD':        out = submitEOD(user, p); break;
      case 'myEOD':            out = myEOD(user); break;
      case 'listAllEOD':       out = listAllEOD(user, p); break;
      case 'adminKPIs':        out = adminKPIs(user); break;
      case 'employeeKPIs':     out = employeeKPIs(user); break;
      case 'reportData':       out = reportData(p); break;
      case 'listUsers':        out = listUsers(); break;
      case 'addUser':          out = addUser(p); break;
      case 'updateUser':       out = updateUser(p); break;
      case 'updateSetting':    out = updateSetting(p); break;
      case 'diagnose':         out = { report: diagnose() }; break;
      case 'maintenance':      out = maintenance(p); break;
      default: return json({ ok: false, error: 'UNKNOWN_ACTION', message: 'Unknown action: ' + action });
    }
    if (user && WRITE_ACTIONS[action]) { try { cache().put('dirty_' + user.id, '1', 60); } catch (e2) {} }   // their next read must be fresh
    return json({ ok: true, data: out, meta: meta() });
  } catch (err) {
    return json({ ok: false, error: 'SERVER_ERROR', message: friendlyError(err), meta: meta() });
  }
}

/* How long this request spent inside the script, and whether it was answered from cache. The app shows it on the dashboard. */
function meta() {
  return { v: APP_VERSION, ms: Date.now() - _t0, cached: _cacheHits > 0 && _cacheMisses === 0 };
}

function friendlyError(err) {
  var m = String(err && err.message || err);
  // Known, user-safe messages start with "!"
  if (m.indexOf('!') === 0) return m.substring(1);
  console.error(m + (err && err.stack ? '\n' + err.stack : ''));
  if (/lock/i.test(m)) return 'The system is busy right now. Please try again in a few seconds.';
  return 'Something went wrong. Please try again.';
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * AUTH
 * ============================================================ */
function login(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var code = String(p.code || '').trim();
  if (!email || !code) throw new Error('!Enter your email and access code.');
  var u = findUserByEmail(email);
  if (!u || String(u['Access Code']).trim() !== code) throw new Error('!Invalid email or access code.');
  if (String(u['Status']) !== 'Active') throw new Error('!This account is inactive. Contact your admin.');

  var user = { id: u['User ID'], name: u['Name'], email: u['Email'], role: u['Role'], department: u['Department'] };
  var token = Utilities.getUuid();
  user._t = Date.now();
  cache().put('tok_' + token, JSON.stringify(user), 21600); // 6 hours
  delete user._t;
  return { token: token, user: user, settings: settingsMap() };
}

/* Sliding 6-hour session. The expiry is pushed forward at most once every 30 minutes,
 * so validating a token is normally a single cache read. */
function validateToken(token) {
  if (!token) return null;
  var c = cache();
  var raw = c.get('tok_' + token);
  if (!raw) return null;
  var user = JSON.parse(raw);
  if (!user._t || Date.now() - user._t > 30 * 60 * 1000) {
    user._t = Date.now();
    c.put('tok_' + token, JSON.stringify(user), 21600);
  }
  delete user._t;
  return user;
}

/* ------------------------------------------------------------
 * FORGOT ACCESS CODE — emailed 6-digit code
 * ------------------------------------------------------------ */
var RESET_MINUTES = 10;
var RESET_MAX_TRIES = 5;
var RESET_MIN_LENGTH = 6;

function findUserByEmail(email) {
  return rows(DB.USERS).filter(function(r) {
    return String(r['Email']).trim().toLowerCase() === email;
  })[0];
}

function requestReset(p) {
  var email = String(p.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('!Enter your work email.');

  var c = cache();
  if (c.get('rst_wait_' + email)) throw new Error('!A code was just sent. Wait a minute before asking for another.');
  c.put('rst_wait_' + email, '1', 60);

  // Same reply whether or not the email is registered, so this screen can't be used to find out who has an account.
  var reply = { sent: true, minutes: RESET_MINUTES };
  var u = findUserByEmail(email);
  if (!u || String(u['Status']) !== 'Active') return reply;

  var otp = ('000000' + (parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000)).slice(-6);
  c.put('rst_' + email, JSON.stringify({ otp: otp, tries: 0, exp: Date.now() + RESET_MINUTES * 60000 }), RESET_MINUTES * 60);

  var app = settingsMap()['APP_NAME'] || 'Stayopx Manager';
  try {
    MailApp.sendEmail({
      to: String(u['Email']).trim(),
      name: app,
      subject: 'Your ' + app + ' reset code: ' + otp,
      body: 'Hi ' + u['Name'] + ',\n\nUse this code to set a new access code for ' + app + ':\n\n    ' + otp +
        '\n\nIt is valid for ' + RESET_MINUTES + ' minutes and can be used once.\n' +
        'If you did not ask for this, you can ignore this email. Your access code has not changed.\n',
      htmlBody: '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1B2430;line-height:1.5">' +
        '<p>Hi ' + htmlEsc(u['Name']) + ',</p><p>Use this code to set a new access code for ' + htmlEsc(app) + ':</p>' +
        '<p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:18px 0">' + otp + '</p>' +
        '<p>It is valid for ' + RESET_MINUTES + ' minutes and can be used once.</p>' +
        '<p style="color:#55606E">If you did not ask for this, you can ignore this email. Your access code has not changed.</p></div>'
    });
  } catch (err) {
    console.error('Reset email failed: ' + err);
    c.remove('rst_' + email);
    throw new Error('!We could not send the email right now. Ask your admin to set a new access code for you.');
  }
  return reply;
}

function resetPassword(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var otp = String(p.otp || '').replace(/\s/g, '');
  var newCode = String(p.newCode || '').trim();
  if (!email || !otp) throw new Error('!Enter the 6-digit code from the email.');
  if (newCode.length < RESET_MIN_LENGTH) throw new Error('!Your new access code must be at least ' + RESET_MIN_LENGTH + ' characters.');

  var wrong = '!That code is wrong or has expired. Ask for a new one.';
  return withLock(10000, function() {
    var c = cache();
    var raw = c.get('rst_' + email);
    if (!raw) throw new Error(wrong);
    var rec = JSON.parse(raw);
    if (Date.now() > rec.exp) { c.remove('rst_' + email); throw new Error(wrong); }

    if (rec.otp !== otp) {
      rec.tries++;
      if (rec.tries >= RESET_MAX_TRIES) c.remove('rst_' + email);
      else c.put('rst_' + email, JSON.stringify(rec), Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000)));
      throw new Error(wrong);
    }

    var u = findUserByEmail(email);
    if (!u || String(u['Status']) !== 'Active') { c.remove('rst_' + email); throw new Error(wrong); }
    updateRowObj(DB.USERS, u._row, { 'Access Code': newCode });
    c.remove('rst_' + email);
    return { done: true };
  });
}

function htmlEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Run this ONCE from the Apps Script editor after pasting this version.
 * Google will ask for permission to send email on your behalf. Nothing is sent.
 */
function authorizeEmail() {
  var left = MailApp.getRemainingDailyQuota();
  console.log('Email is authorized. Emails left today: ' + left);
  return left;
}

function bootstrap(user) {
  var out = { settings: settingsMap(), user: user };
  if (user.role === 'Admin') out.users = listUsers();
  return out;
}

/* ============================================================
 * SHEET HELPERS
 * ============================================================ */
var _ss = null;
function ss() { return _ss || (_ss = SpreadsheetApp.getActiveSpreadsheet()); }
function sheet(name) { return ss().getSheetByName(name); }

/* Each tab is read at most once per request; writes clear the copy so the next read is fresh. */
var _memo = {};
function forget(name) {
  Object.keys(_memo).forEach(function(k) { if (k === name || k.indexOf(name + '#') === 0) delete _memo[k]; });
}

/* rows(name, LITE) reads everything except the Description column — the bulk of the text in the Tickets tab.
 * Every screen except the ticket list and the ticket modal uses it. */
var LITE = { skip: ['Description'] };

function rows(name, opts) {
  var skip = (opts && opts.skip) || [];
  var key = name + (skip.length ? '#' + skip.join(',') : '');
  if (_memo[key]) return _memo[key];
  var sh = sheet(name);
  var out = [];
  if (sh) {
    var last = sh.getLastRow();
    if (last >= 2) {
      var head = HEADERS[name];
      var data = skip.length ? readSkipping(sh, last, head, skip) : sh.getRange(2, 1, last - 1, head.length).getValues();
      out = toObjects(name, data, 2);
    }
  }
  _memo[key] = out;
  return out;
}

/* Reads the wanted columns in contiguous blocks and leaves '' in the skipped ones. */
function readSkipping(sh, last, head, skip) {
  var n = head.length, rowsN = last - 1, c = 0, blocks = [];
  while (c < n) {
    if (skip.indexOf(head[c]) !== -1) { c++; continue; }
    var start = c;
    while (c < n && skip.indexOf(head[c]) === -1) c++;
    blocks.push([start, c - start]);
  }
  var data = new Array(rowsN);
  for (var i = 0; i < rowsN; i++) { var r = new Array(n); for (var j = 0; j < n; j++) r[j] = ''; data[i] = r; }
  blocks.forEach(function(b) {
    var vals = sh.getRange(2, b[0] + 1, rowsN, b[1]).getValues();
    for (var i2 = 0; i2 < rowsN; i2++) for (var j2 = 0; j2 < b[1]; j2++) data[i2][b[0] + j2] = vals[i2][j2];
  });
  return data;
}

/* The last `count` data rows of a tab. Used for append-mostly tabs (EOD logs) where today's rows are always at the bottom. */
function rowsTail(name, count) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - count + 1);
  return toObjects(name, sh.getRange(start, 1, last - start + 1, HEADERS[name].length).getValues(), start);
}

function toObjects(name, data, firstRow) {
  var head = HEADERS[name], n = head.length, out = [];
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    if (r[0] === '' || r[0] === null || r[0] === undefined) continue;
    var o = { _row: firstRow + i };
    for (var c = 0; c < n; c++) o[head[c]] = normalize(r[c]);
    out.push(o);
  }
  return out;
}

/* Cells should all be text (setupDatabase formats the date/time columns that way). If a cell is a real Date
 * anyway, it is converted here with plain arithmetic — Utilities.formatDate costs ~1 ms per cell, which on a
 * big tab turned into minutes. Run fixDateFormats() once to convert such cells to text for good. */
function normalize(v) {
  if (v instanceof Date) {
    if (v.getFullYear() < 1900) return pad2(v.getHours()) + ':' + pad2(v.getMinutes());        // a time-only cell like 09:00
    var s = v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    if (v.getHours() || v.getMinutes() || v.getSeconds()) s += ' ' + pad2(v.getHours()) + ':' + pad2(v.getMinutes()) + ':' + pad2(v.getSeconds());
    return s;
  }
  return v === null || v === undefined ? '' : String(v);
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }

/* Find the rows of one tab where `header` equals `value`, using the sheet's own text search
 * instead of downloading the whole tab. Falls back to a full scan if the search is unavailable. */
function findRowsByKey(name, header, value) {
  var sh = sheet(name), head = HEADERS[name];
  var col = head.indexOf(header) + 1;
  var last = sh.getLastRow();
  if (last < 2 || !value) return [];
  var found = null;
  try {
    found = sh.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findAll();
  } catch (e) { found = null; }
  if (!found) return rows(name).filter(function(r) { return r[header] === value; });
  if (!found.length) return [];

  var rowNums = found.map(function(r) { return r.getRow(); }).sort(function(a, b) { return a - b; });
  var out = [];
  // read nearby hits in one block instead of one call per row
  var i = 0;
  while (i < rowNums.length) {
    var j = i;
    while (j + 1 < rowNums.length && rowNums[j + 1] - rowNums[i] <= 400) j++;
    var start = rowNums[i], stop = rowNums[j];
    var block = toObjects(name, sh.getRange(start, 1, stop - start + 1, head.length).getValues(), start);
    for (var k = 0; k < block.length; k++) if (block[k][header] === String(value)) out.push(block[k]);
    i = j + 1;
  }
  return out;
}

/* ---------- writes (all serialised through the script lock, and every write clears the read cache) ---------- */
var _lockDepth = 0;
function withLock(ms, fn) {
  if (_lockDepth > 0) return fn();                    // already held by this execution
  var lock = LockService.getScriptLock();
  try { lock.waitLock(ms || 10000); }
  catch (e) { throw new Error('!The system is busy right now. Please try again in a few seconds.'); }
  _lockDepth = 1;
  try { return fn(); } finally { _lockDepth = 0; lock.releaseLock(); }
}

function rowArray(name, obj) {
  return HEADERS[name].map(function(h) { return obj[h] !== undefined ? obj[h] : ''; });
}

function appendRowObj(name, obj) {
  var row = rowArray(name, obj);
  withLock(10000, function() { sheet(name).appendRow(row); });
  forget(name); bumpVersion();
}

function appendRowsObj(name, objs) {
  if (!objs || !objs.length) return;
  var data = objs.map(function(o) { return rowArray(name, o); });
  withLock(30000, function() {
    var sh = sheet(name);
    sh.getRange(sh.getLastRow() + 1, 1, data.length, data[0].length).setValues(data);
  });
  forget(name); bumpVersion();
}

/* Writes only the cells named in `patch` (grouped into as few calls as possible) — nothing else in the row is touched. */
function updateRowObj(name, rowIndex, patch) {
  var head = HEADERS[name], sh = sheet(name);
  var cols = [];
  head.forEach(function(h, c) { if (patch[h] !== undefined) cols.push(c); });
  if (!cols.length) return;
  withLock(10000, function() {
    var i = 0;
    while (i < cols.length) {
      var j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      var vals = cols.slice(i, j + 1).map(function(c) { return patch[head[c]]; });
      sh.getRange(rowIndex, cols[i] + 1, 1, vals.length).setValues([vals]);
      i = j + 1;
    }
  });
  forget(name); bumpVersion();
}

function nextIds(prefix, key, start, n) {
  return withLock(10000, function() {
    var props = PropertiesService.getScriptProperties();
    var cur = Number(props.getProperty(key) || start);
    props.setProperty(key, String(cur + n));
    var out = [];
    for (var i = 0; i < n; i++) out.push(prefix + (cur + i));
    return out;
  });
}
function nextId(prefix, key, start) { return nextIds(prefix, key, start, 1)[0]; }

function colLetter(col) {
  var s = '';
  while (col > 0) { var m = (col - 1) % 26; s = String.fromCharCode(65 + m) + s; col = (col - m - 1) / 26; }
  return s;
}

function settingsMap() {
  var map = {};
  rows(DB.SETTINGS).forEach(function(r) { map[r['Key']] = r['Value']; });
  return map;
}

function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowTime() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function nowStamp() { return today() + ' ' + Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'); }
function dateMinus(days) {
  var d = new Date(); d.setDate(d.getDate() - days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}
function parseDate(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2] || 1));
}

/* ============================================================
 * RESPONSE CACHE
 * Read results are cached (gzipped) in the script cache. `data_ver` changes on every write,
 * and it is part of every cache key, so a write makes all cached reads obsolete instantly.
 * ============================================================ */
function cache() { return CacheService.getScriptCache(); }
function dataVersion() { return cache().get('data_ver') || '0'; }
function bumpVersion() { try { cache().put('data_ver', String(Date.now()), 21600); } catch (e) {} }

function cacheGetObj(key) {
  var raw = cache().get(key);
  if (!raw) return null;
  try {
    var bytes = Utilities.base64Decode(raw);
    var text = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString();
    return JSON.parse(text);
  } catch (e) { return null; }
}
function cachePutObj(key, obj, seconds) {
  try {
    var gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json'));
    var b64 = Utilities.base64Encode(gz.getBytes());
    if (b64.length > 95000) return false;             // the cache holds at most 100 KB per key
    cache().put(key, b64, seconds);
    return true;
  } catch (e) { return false; }
}
function cached(key, fn) {
  if (key.length > 240) return fn();                   // key too long to cache — just compute
  var ver = dataVersion();
  var dirtyKey = _reqUser ? 'dirty_' + _reqUser.id : null;
  var dirty = dirtyKey ? cache().get(dirtyKey) : null;
  if (!dirty) {
    var hit = cacheGetObj(key);
    if (hit && hit.v !== undefined && hit.at) {
      var age = Date.now() - hit.at;
      if ((hit.ver === ver && age < CACHE_SECONDS * 1000) || age < STALE_OK_MS) { _cacheHits++; return hit.v; }
    }
  }
  _cacheMisses++;
  var v = fn();
  cachePutObj(key, { v: v, ver: ver, at: Date.now() }, CACHE_SECONDS);
  if (dirty) { try { cache().remove(dirtyKey); } catch (e) {} }
  return v;
}

/* ============================================================
 * ACTIVITY LOG
 * ============================================================ */
function activityRow(id, ticketId, userName, prevStatus, newStatus, comment) {
  return {
    'Activity ID': id,
    'Ticket ID': ticketId,
    'User': userName,
    'Previous Status': prevStatus || '',
    'New Status': newStatus || '',
    'Comment': comment || '',
    'Date': today(),
    'Time': Utilities.formatDate(new Date(), TZ, 'HH:mm:ss')
  };
}
function logActivity(ticketId, userName, prevStatus, newStatus, comment) {
  appendRowObj(DB.ACTIVITY, activityRow(nextId('ACT-', 'seq_activity', 50001), ticketId, userName, prevStatus, newStatus, comment));
}

/* ============================================================
 * TICKETS
 * ============================================================ */
function scopeTickets(user, opts) {
  var all = rows(DB.TICKETS, opts);
  if (user.role === 'Admin') return all;
  return all.filter(function(t) { return t['Assigned To'] === user.id; });
}

function bySchedule(a, b) {
  return (b['Scheduled Date'] + b['Scheduled Time']).localeCompare(a['Scheduled Date'] + a['Scheduled Time']);
}

/* Ticket as sent in lists: full text is trimmed (the modal loads the full ticket) */
function listTicket(t) {
  var o = publicTicket(t);
  if (o['Description'] && o['Description'].length > LIST_DESC_CHARS) o['Description'] = o['Description'].slice(0, LIST_DESC_CHARS) + '…';
  return o;
}
/* Ticket as sent to the dashboard: no description at all */
function slimTicket(t) {
  var o = publicTicket(t);
  delete o['Description'];
  return o;
}
function publicTicket(t) {
  var o = {};
  HEADERS[DB.TICKETS].forEach(function(h) { o[h] = t[h]; });
  return o;
}

/**
 * Ticket list. Options:
 *   status, employee (admin), date  — exact filters
 *   days   — only tickets scheduled in the last N days (or later), PLUS every unfinished ticket
 *   all    — everything (ignores days)
 * With no options the full list is returned, as before.
 */
function listTickets(user, p) {
  p = p || {};
  var isAdmin = user.role === 'Admin';
  var key = 'tk|' + (isAdmin ? 'admin' : user.id) + '|' + today() + '|' +
    JSON.stringify({ s: p.status || '', e: p.employee || '', d: p.date || '', n: Number(p.days) || 0, a: !!p.all });
  return cached(key, function() {
    var list = scopeTickets(user);
    if (p.status) list = list.filter(function(t) { return t['Status'] === p.status; });
    if (p.employee && isAdmin) list = list.filter(function(t) { return t['Assigned To'] === p.employee; });
    if (p.date) list = list.filter(function(t) { return t['Scheduled Date'] === p.date; });
    if (!p.all && !p.date && Number(p.days) > 0) {
      var from = dateMinus(Number(p.days));
      list = list.filter(function(t) { return t['Scheduled Date'] >= from || ACTIVE[t['Status']]; });
    }
    list.sort(bySchedule);
    return list.map(listTicket);
  });
}

function getTicket(user, p) {
  var t = findTicket(p.id);
  if (user.role !== 'Admin' && t['Assigned To'] !== user.id) throw new Error('!You do not have access to this ticket.');
  var activity = findRowsByKey(DB.ACTIVITY, 'Ticket ID', p.id).map(cleanRow(DB.ACTIVITY));
  return { ticket: publicTicket(t), activity: activity };
}

function findTicket(id) {
  var t = findRowsByKey(DB.TICKETS, 'Ticket ID', id)[0];
  if (!t) throw new Error('!Ticket not found.');
  return t;
}

function requireFields(p, fields) {
  fields.forEach(function(f) {
    if (!p[f] || String(p[f]).trim() === '') throw new Error('!Missing required field: ' + f);
  });
}

function createTicket(user, p) {
  // Employees can raise tickets, but only for themselves, and only one-time ones.
  var self = user.role !== 'Admin';
  if (self) {
    p.assignedTo = user.id;
    p.parentId = '';
    p.ticketType = 'One-Time';
    if (!p.department) p.department = user.department || '';
  }
  requireFields(p, ['title', 'assignedTo', 'priority', 'scheduledDate']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.scheduledDate))) throw new Error('!Pick a valid scheduled date.');
  if (p.dueDate && String(p.dueDate) < String(p.scheduledDate)) throw new Error('!The due date cannot be before the scheduled date.');
  if (String(p.title).length > 200) throw new Error('!Keep the title under 200 characters.');
  return withLock(10000, function() {
    var id = nextId('TKT-', 'seq_ticket', 10001);
    appendRowObj(DB.TICKETS, {
      'Ticket ID': id,
      'Parent Ticket ID': p.parentId || '',
      'Title': p.title,
      'Description': p.description || '',
      'Assigned To': p.assignedTo,
      'Created By': user.id,
      'Department': p.department || '',
      'Priority': p.priority,
      'Ticket Type': p.ticketType || 'One-Time',
      'Scheduled Date': p.scheduledDate,
      'Scheduled Time': p.scheduledTime || '',
      'Due Date': p.dueDate || p.scheduledDate,
      'Status': 'Open',
      'Created Date': nowStamp(),
      'Updated Date': nowStamp(),
      'Completed Date': ''
    });
    logActivity(id, user.name, '', 'Open', (p.assignedTo === user.id ? 'Self-created by ' : 'Ticket created by ') + user.name);
    return { id: id };
  });
}

function updateTicket(user, p) {
  var t = findTicket(p.id);
  var patch = { 'Updated Date': nowStamp() };
  ['Title','Description','Assigned To','Department','Priority','Scheduled Date','Scheduled Time','Due Date'].forEach(function(h) {
    var key = h.replace(/ (\w)/g, function(m, c) { return c.toUpperCase(); });
    key = key.charAt(0).toLowerCase() + key.slice(1);
    if (p[key] !== undefined) patch[h] = p[key];
  });
  updateRowObj(DB.TICKETS, t._row, patch);
  logActivity(p.id, user.name, t['Status'], t['Status'], 'Ticket details updated by ' + user.name);
  return { id: p.id };
}

function updateStatus(user, p) {
  requireFields(p, ['id', 'status']);
  var t = findTicket(p.id);
  if (user.role !== 'Admin' && t['Assigned To'] !== user.id) throw new Error('!You can only update your own tickets.');
  var valid = String(settingsMap()['STATUSES'] || 'Open,In Progress,Completed,On Hold,Overdue').split(',');
  if (valid.indexOf(p.status) === -1) throw new Error('!Invalid status.');
  var patch = { 'Status': p.status, 'Updated Date': nowStamp() };
  if (p.status === 'Completed') patch['Completed Date'] = nowStamp();
  updateRowObj(DB.TICKETS, t._row, patch);
  logActivity(p.id, user.name, t['Status'], p.status, p.comment || 'Status changed to ' + p.status);
  return { id: p.id, status: p.status };
}

function addComment(user, p) {
  requireFields(p, ['id', 'comment']);
  var t = findTicket(p.id);
  if (user.role !== 'Admin' && t['Assigned To'] !== user.id) throw new Error('!You can only comment on your own tickets.');
  updateRowObj(DB.TICKETS, t._row, { 'Updated Date': nowStamp() });
  logActivity(p.id, user.name, t['Status'], t['Status'], p.comment);
  return { id: p.id };
}

function cancelTicket(user, p) {
  var t = findTicket(p.id);
  if (user.role !== 'Admin') {
    // an employee may withdraw only a ticket they raised for themselves, and only before it is completed
    if (t['Created By'] !== user.id || t['Assigned To'] !== user.id) throw new Error('!You can only cancel tickets you created yourself.');
    if (t['Status'] === 'Completed') throw new Error('!A completed ticket cannot be cancelled.');
  }
  updateRowObj(DB.TICKETS, t._row, { 'Status': 'Cancelled', 'Updated Date': nowStamp() });
  logActivity(p.id, user.name, t['Status'], 'Cancelled', 'Ticket cancelled by ' + user.name);
  return { id: p.id };
}

/* ============================================================
 * RECURRING TICKETS
 * ============================================================ */
function createRecurring(user, p) {
  requireFields(p, ['title', 'assignedTo', 'frequency', 'time', 'startDate']);
  if (['Daily','Weekly','Monthly'].indexOf(p.frequency) === -1) throw new Error('!Invalid recurrence frequency.');
  if (p.frequency === 'Weekly' && !p.day) throw new Error('!Select a day of the week.');
  if (p.frequency === 'Monthly' && !p.day) throw new Error('!Select a day of the month.');
  var id = nextId('RT-', 'seq_recurring', 1);
  appendRowObj(DB.RECURRING, {
    'Recurring ID': id,
    'Title': p.title,
    'Description': p.description || '',
    'Assigned To': p.assignedTo,
    'Frequency': p.frequency,
    'Day': p.day || '',
    'Time': p.time,
    'Start Date': p.startDate,
    'End Date': p.endDate || '',
    'Status': 'Active',
    'Created By': user.id,
    'Department': p.department || '',
    'Priority': p.priority || 'Medium'
  });
  // Generate today's instance immediately if it applies
  generateForDate(today());
  return { id: id };
}

function listRecurring() {
  return rows(DB.RECURRING).map(cleanRow(DB.RECURRING));
}

function updateRecurring(user, p) {
  var r = findRowsByKey(DB.RECURRING, 'Recurring ID', p.id)[0];
  if (!r) throw new Error('!Recurring ticket not found.');
  var patch = {};
  if (p.status) patch['Status'] = p.status; // Active / Paused
  ['Title','Description','Assigned To','Frequency','Day','Time','Start Date','End Date','Department','Priority'].forEach(function(h) {
    if (p[h] !== undefined) patch[h] = p[h];
  });
  updateRowObj(DB.RECURRING, r._row, patch);
  return { id: p.id };
}

/**
 * TIME-DRIVEN TRIGGER — run daily (e.g., 5–6 AM).
 * Generates today's tickets from recurring templates and flags overdue tickets.
 */
function dailyScheduler() {
  generateForDate(today());
  markOverdueTickets();
}

function generateForDate(dateStr) {
  return withLock(30000, function() {
    var d = parseDate(dateStr);
    var weekday = Utilities.formatDate(d, TZ, 'EEEE'); // Monday...
    var dom = d.getDate();
    var lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

    var existing = {};
    rows(DB.TICKETS, LITE).forEach(function(t) {
      if (t['Parent Ticket ID'] && t['Scheduled Date'] === dateStr) existing[t['Parent Ticket ID']] = true;
    });

    var due = rows(DB.RECURRING).filter(function(r) {
      if (r['Status'] !== 'Active') return false;
      if (r['Start Date'] && dateStr < r['Start Date']) return false;
      if (r['End Date'] && dateStr > r['End Date']) return false;
      if (existing[r['Recurring ID']]) return false;        // duplicate prevention
      if (r['Frequency'] === 'Daily') return true;
      if (r['Frequency'] === 'Weekly') return r['Day'] === weekday;
      if (r['Frequency'] === 'Monthly') return dom === Math.min(Number(r['Day']) || 1, lastDom); // clamp e.g. 31st in Feb
      return false;
    });
    if (!due.length) return 0;

    var ids = nextIds('TKT-', 'seq_ticket', 10001, due.length);
    var actIds = nextIds('ACT-', 'seq_activity', 50001, due.length);
    var stamp = nowStamp();
    var tickets = [], acts = [];
    due.forEach(function(r, i) {
      tickets.push({
        'Ticket ID': ids[i],
        'Parent Ticket ID': r['Recurring ID'],
        'Title': r['Title'],
        'Description': r['Description'],
        'Assigned To': r['Assigned To'],
        'Created By': r['Created By'],
        'Department': r['Department'],
        'Priority': r['Priority'] || 'Medium',
        'Ticket Type': r['Frequency'],
        'Scheduled Date': dateStr,
        'Scheduled Time': r['Time'],
        'Due Date': dateStr,
        'Status': 'Open',
        'Created Date': stamp,
        'Updated Date': stamp,
        'Completed Date': ''
      });
      acts.push(activityRow(actIds[i], ids[i], 'Scheduler', '', 'Open', 'Auto-generated from recurring template ' + r['Recurring ID']));
    });
    appendRowsObj(DB.TICKETS, tickets);
    appendRowsObj(DB.ACTIVITY, acts);
    return due.length;
  });
}

/**
 * TIME-DRIVEN TRIGGER — run hourly.
 * Marks Open / In Progress / On Hold tickets as Overdue once past their due date + scheduled time.
 * Writes all changed cells in a few calls (was 5 sheet calls per ticket).
 */
function markOverdueTickets() {
  return withLock(30000, function() {
    var now = new Date();
    var hits = [];
    rows(DB.TICKETS, LITE).forEach(function(t) {
      if (['Open', 'In Progress', 'On Hold'].indexOf(t['Status']) === -1) return;
      if (!t['Due Date']) return;
      var due = parseDate(t['Due Date']);
      var tm = (t['Scheduled Time'] || '23:59').split(':');
      due.setHours(Number(tm[0]) || 23, Number(tm[1]) || 59, 0, 0);
      if (now > due) hits.push(t);
    });
    if (!hits.length) return 0;

    var sh = sheet(DB.TICKETS), head = HEADERS[DB.TICKETS];
    var statusCol = colLetter(head.indexOf('Status') + 1), updCol = colLetter(head.indexOf('Updated Date') + 1);
    var stamp = nowStamp();
    for (var i = 0; i < hits.length; i += 200) {
      var part = hits.slice(i, i + 200);
      sh.getRangeList(part.map(function(t) { return statusCol + t._row; })).setValue('Overdue');
      sh.getRangeList(part.map(function(t) { return updCol + t._row; })).setValue(stamp);
    }
    var actIds = nextIds('ACT-', 'seq_activity', 50001, hits.length);
    appendRowsObj(DB.ACTIVITY, hits.map(function(t, i) {
      return activityRow(actIds[i], t['Ticket ID'], 'Scheduler', t['Status'], 'Overdue', 'Ticket passed its due date without completion');
    }));
    forget(DB.TICKETS); bumpVersion();
    return hits.length;
  });
}

/**
 * OPTIONAL TIME-DRIVEN TRIGGER — run monthly (or by hand).
 * Moves Completed / Cancelled tickets scheduled more than ARCHIVE_AFTER_DAYS ago to the "Tickets Archive" tab,
 * so the live Tickets tab stays small and every screen stays fast. Reports still include archived tickets.
 * The activity log is left untouched.
 */
function archiveOldTickets() {
  var days = Number(settingsMap()['ARCHIVE_AFTER_DAYS']) || 60;
  var cutoff = dateMinus(days);
  var head = HEADERS[DB.TICKETS];
  return withLock(120000, function() {
    var sh = sheet(DB.TICKETS);
    var arch = sheet(DB.ARCHIVE);
    if (!arch) {
      arch = ss().insertSheet(DB.ARCHIVE);
      arch.appendRow(head);
      arch.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#EEF1F4');
      arch.setFrozenRows(1);
      arch.getRange('J:L').setNumberFormat('@'); arch.getRange('N:P').setNumberFormat('@');
    }
    var last = sh.getLastRow();
    if (last < 2) return 0;
    var data = sh.getRange(2, 1, last - 1, head.length).getValues();
    var sCol = head.indexOf('Status'), dCol = head.indexOf('Scheduled Date');
    var keep = [], move = [];
    for (var i = 0; i < data.length; i++) {
      var r = data[i];
      if (r[0] === '') continue;
      var st = String(r[sCol]), sd = normalize(r[dCol]);
      if ((st === 'Completed' || st === 'Cancelled') && sd && sd < cutoff) move.push(r); else keep.push(r);
    }
    if (!move.length) return 0;
    // 1) copy to the archive first, 2) rewrite the live tab, 3) clear the leftover rows — data is never only "in flight"
    arch.getRange(arch.getLastRow() + 1, 1, move.length, head.length).setValues(move);
    if (keep.length) sh.getRange(2, 1, keep.length, head.length).setValues(keep);
    if (last - 1 > keep.length) sh.getRange(keep.length + 2, 1, last - 1 - keep.length, head.length).clearContent();
    forget(DB.TICKETS); forget(DB.ARCHIVE); bumpVersion();
    console.log('Archived ' + move.length + ' tickets scheduled before ' + cutoff);
    return move.length;
  });
}

/* ============================================================
 * EOD WORK LOGS
 * The EOD tab is append-mostly and holds long text, so it is read from the bottom up.
 * ============================================================ */
function activeEmployeeCount() {
  return rows(DB.USERS).filter(function(u) { return u['Status'] === 'Active'; }).length || 1;
}

/* All EOD rows dated on/after `fromDate`, reading only the bottom of the tab whenever that is enough. */
function eodRows(fromDate) {
  var days = Math.max(1, Math.round((parseDate(today()) - parseDate(fromDate)) / 86400000) + 1);
  var tail = rowsTail(DB.EOD, Math.max(300, activeEmployeeCount() * days * 2));
  if (tail.length && tail[0]._row > 2 && tail[0]['Date'] >= fromDate) return rows(DB.EOD);   // tail did not reach back far enough
  return tail.filter(function(r) { return r['Date'] >= fromDate; });
}

/* Light index of EOD logs (who + date only, no text). `tailCount` limits it to the bottom rows. */
function eodIndex(tailCount) {
  var sh = sheet(DB.EOD);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = tailCount ? Math.max(2, last - tailCount + 1) : 2;
  var data = sh.getRange(start, 2, last - start + 1, 3).getValues();      // Employee ID, Employee Name, Date
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] === '') continue;
    out.push({ id: String(data[i][0]), name: String(data[i][1]), date: normalize(data[i][2]) });
  }
  return out;
}

function submitEOD(user, p) {
  requireFields(p, ['workCompleted']);
  var date = p.date || today();
  var cutoff = settingsMap()['EOD_CUTOFF'] || '23:00';
  var existing = eodRows(date).filter(function(r) {
    return r['Employee ID'] === user.id && r['Date'] === date;
  })[0];

  var mine = rows(DB.TICKETS, LITE).filter(function(t) {
    return t['Assigned To'] === user.id && t['Scheduled Date'] === date && t['Status'] !== 'Cancelled';
  });
  var completed = mine.filter(function(t) { return t['Status'] === 'Completed'; }).length;

  var record = {
    'Employee ID': user.id,
    'Employee Name': user.name,
    'Date': date,
    'Tickets Assigned': mine.length,
    'Tickets Completed': completed,
    'Tickets Pending': mine.length - completed,
    'Work Completed': p.workCompleted,
    'Challenges': p.challenges || '',
    'Pending Work': p.pendingWork || '',
    'Tomorrow Plan': p.tomorrowPlan || '',
    'Remarks': p.remarks || '',
    'Submitted At': nowStamp()
  };

  if (existing) {
    if (date === today() && nowTime() > cutoff) throw new Error('!The EOD edit window closed at ' + cutoff + '. Contact your admin for changes.');
    if (date < today()) throw new Error('!Past EOD logs can no longer be edited.');
    updateRowObj(DB.EOD, existing._row, record);
    return { id: existing['Log ID'], updated: true };
  }
  record['Log ID'] = nextId('EOD-', 'seq_eod', 70001);
  appendRowObj(DB.EOD, record);
  return { id: record['Log ID'], updated: false };
}

var MY_EOD_LIMIT = 60;
function myEOD(user) {
  return cached('eod|' + user.id + '|' + today(), function() {
    var list = rowsTail(DB.EOD, Math.max(400, activeEmployeeCount() * (MY_EOD_LIMIT + 10)))
      .filter(function(r) { return r['Employee ID'] === user.id; });
    list.sort(function(a, b) { return b['Date'].localeCompare(a['Date']); });
    return list.slice(0, MY_EOD_LIMIT).map(cleanRow(DB.EOD));
  });
}

/**
 * Team EOD logs (admin). Options: date (one day) · employee · days (default 30) · all
 */
function listAllEOD(user, p) {
  p = p || {};
  var key = 'eodall|' + today() + '|' + JSON.stringify({ d: p.date || '', e: p.employee || '', n: Number(p.days) || 0, a: !!p.all });
  return cached(key, function() {
    var list;
    if (p.date) list = eodRows(p.date).filter(function(r) { return r['Date'] === p.date; });
    else if (p.all) list = rows(DB.EOD);
    else list = eodRows(dateMinus(Number(p.days) || 30));
    if (p.employee) list = list.filter(function(r) { return r['Employee ID'] === p.employee; });
    list.sort(function(a, b) { return b['Date'].localeCompare(a['Date']); });
    return list.map(cleanRow(DB.EOD));
  });
}

function cleanRow(sheetName) {
  return function(r) { var o = {}; HEADERS[sheetName].forEach(function(h) { o[h] = r[h]; }); return o; };
}

/* ============================================================
 * DASHBOARD — one call, everything the dashboard shows.
 * Totals, priority mix and team workload are computed here; only the rows that are actually drawn are sent
 * (8 oldest overdue, 6 coming up, an employee's today + 50 oldest carried-over), so the reply stays a few KB
 * however large the backlog gets — which also means it always fits in the cache.
 * ============================================================ */
var TOP_OVERDUE = 8, TOP_COMING = 6, TOP_CARRIED = 50, TOP_TODAY = 200;

function oldestFirst(a, b) { return String(a['Due Date'] || a['Scheduled Date']).localeCompare(String(b['Due Date'] || b['Scheduled Date'])); }
function byTimeToday(a, b) {
  return ((b['Status'] === 'In Progress') - (a['Status'] === 'In Progress')) || (a['Scheduled Time'] || '99').localeCompare(b['Scheduled Time'] || '99');
}
function isPending(s) { return s === 'Open' || s === 'In Progress' || s === 'On Hold'; }

function dashboard(user) {
  var isAdmin = user.role === 'Admin';
  var t = today();
  return cached('dash|' + (isAdmin ? 'admin' : user.id) + '|' + t, function() {
    var live = scopeTickets(user, LITE).filter(function(x) { return x['Status'] !== 'Cancelled'; });
    var users = rows(DB.USERS);
    var names = {};
    users.forEach(function(u) { names[u['User ID']] = u['Name']; });

    var counts = { total: live.length, open: 0, inProgress: 0, onHold: 0, overdue: 0, completed: 0 };
    var overdue = [], todays = [], carried = [], week = {}, team = {};
    var prio = { Critical: 0, High: 0, Medium: 0, Low: 0 }, active = 0;
    var weekFrom = dateMinus(6);
    if (isAdmin) users.forEach(function(u) {
      if (u['Role'] === 'Employee' && u['Status'] === 'Active') {
        team[u['User ID']] = { id: u['User ID'], name: u['Name'], isEmp: true, today: 0, todayDone: 0, pending: 0, overdue: 0 };
      }
    });

    for (var i = 0; i < live.length; i++) {
      var x = live[i], s = x['Status'], sd = x['Scheduled Date'], act = !!ACTIVE[s];
      if (s === 'Open') counts.open++;
      else if (s === 'In Progress') counts.inProgress++;
      else if (s === 'On Hold') counts.onHold++;
      else if (s === 'Overdue') counts.overdue++;
      else if (s === 'Completed') counts.completed++;
      if (s === 'Overdue') overdue.push(x);
      if (sd === t) todays.push(x);
      else if (!isAdmin && act && sd < t) carried.push(x);
      if (act) { active++; prio[x['Priority']] = (prio[x['Priority']] || 0) + 1; }
      if (isAdmin) {
        if (sd >= weekFrom && sd <= t) {
          var w = week[sd] || (week[sd] = { total: 0, completed: 0 });
          w.total++;
          if (s === 'Completed') w.completed++;
        }
        if (act || sd === t) {
          var id = x['Assigned To'];
          var m = team[id] || (team[id] = { id: id, name: names[id] || id, isEmp: false, today: 0, todayDone: 0, pending: 0, overdue: 0 });
          if (sd === t) { m.today++; if (s === 'Completed') m.todayDone++; }
          if (isPending(s)) m.pending++;
          if (s === 'Overdue') m.overdue++;
        }
      }
    }
    overdue.sort(oldestFirst);
    todays.sort(byTimeToday);
    var todayDone = todays.filter(function(x) { return x['Status'] === 'Completed'; }).length;
    var comingUp = todays.filter(function(x) { return isPending(x['Status']); });
    var urgent = overdue.filter(function(x) { return x['Priority'] === 'High' || x['Priority'] === 'Critical'; }).length;

    var out = {
      today: t, settings: settingsMap(), counts: counts,
      todayStats: { total: todays.length, done: todayDone },
      overdue: { count: overdue.length, urgent: urgent, top: overdue.slice(0, TOP_OVERDUE).map(slimTicket) },
      comingUp: { count: comingUp.length, top: comingUp.slice(0, TOP_COMING).map(slimTicket) },
      active: active, prio: prio
    };

    var todayLogs = eodIndex(Math.max(300, users.length * 3)).filter(function(r) { return r.date === t; });
    var submitted = {};
    todayLogs.forEach(function(r) { submitted[r.id] = 1; });

    if (isAdmin) {
      out.users = users.map(publicUser);
      out.team = Object.keys(team).map(function(k) { return team[k]; }).sort(function(a, b) {
        return (b.overdue - a.overdue) || (b.pending - a.pending) || a.name.localeCompare(b.name);
      });
      out.eod = {
        submitted: todayLogs.length,
        submittedToday: !!submitted[user.id],
        pending: users.filter(function(u) { return u['Role'] === 'Employee' && u['Status'] === 'Active' && !submitted[u['User ID']]; })
          .map(function(u) { return u['Name']; })
      };
      out.weekSeries = [];
      for (var k = 6; k >= 0; k--) {
        var d = new Date(); d.setDate(d.getDate() - k);
        var ds = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
        var w2 = week[ds] || { total: 0, completed: 0 };
        out.weekSeries.push({ date: Utilities.formatDate(d, TZ, 'dd MMM'), total: w2.total, completed: w2.completed });
      }
    } else {
      carried.sort(function(a, b) { return ((b['Status'] === 'Overdue') - (a['Status'] === 'Overdue')) || oldestFirst(a, b); });
      out.todays = todays.slice(0, TOP_TODAY).map(slimTicket);
      out.carried = { count: carried.length, top: carried.slice(0, TOP_CARRIED).map(slimTicket) };
      out.eod = { submittedToday: !!submitted[user.id] };
    }
    return out;
  });
}

/* ============================================================
 * KPIs & REPORTS (adminKPIs / employeeKPIs are kept for older front-ends; the app now uses `dashboard`)
 * ============================================================ */
function countBy(list, field) {
  var m = {};
  list.forEach(function(t) { var k = t[field] || '—'; m[k] = (m[k] || 0) + 1; });
  return m;
}

function adminKPIs(user) {
  var d = dashboard(user), c = d.counts;
  var all = rows(DB.TICKETS, LITE).filter(function(t) { return t['Status'] !== 'Cancelled'; });
  var names = {};
  rows(DB.USERS).forEach(function(u) { names[u['User ID']] = u['Name']; });
  var byEmp = {};
  all.forEach(function(x) { var n = names[x['Assigned To']] || x['Assigned To']; byEmp[n] = (byEmp[n] || 0) + 1; });
  return {
    total: c.total, open: c.open, inProgress: c.inProgress, completed: c.completed, overdue: c.overdue, onHold: c.onHold,
    todayTotal: d.todayStats.total,
    pending: c.total - c.completed,
    completionRate: c.total ? Math.round(c.completed / c.total * 100) : 0,
    byStatus: countBy(all, 'Status'), byPriority: countBy(all, 'Priority'), byEmployee: byEmp,
    weekSeries: d.weekSeries,
    eodSubmitted: d.eod.submitted, eodSubmittedToday: d.eod.submittedToday, eodPending: d.eod.pending
  };
}

function employeeKPIs(user) {
  var d = dashboard(user), c = d.counts;
  return {
    total: c.total, open: c.open, inProgress: c.inProgress, completed: c.completed, overdue: c.overdue,
    dueToday: d.todayStats.total - d.todayStats.done,
    eodSubmittedToday: d.eod.submittedToday
  };
}

function reportData(p) {
  var from = p.from || '0000-00-00';
  var to = p.to || '9999-12-31';
  var source = rows(DB.TICKETS, LITE);
  // include archived tickets when the period reaches back into the archive
  if (sheet(DB.ARCHIVE) && from < dateMinus(Number(settingsMap()['ARCHIVE_AFTER_DAYS']) || 60)) source = source.concat(rows(DB.ARCHIVE, LITE));
  var all = source.filter(function(t) {
    return t['Status'] !== 'Cancelled' && t['Scheduled Date'] >= from && t['Scheduled Date'] <= to;
  });
  if (p.department) all = all.filter(function(t) { return t['Department'] === p.department; });
  if (p.employee) all = all.filter(function(t) { return t['Assigned To'] === p.employee; });

  var users = rows(DB.USERS);
  var names = {}; users.forEach(function(u) { names[u['User ID']] = u['Name']; });

  var perEmp = {};
  all.forEach(function(t) {
    var id = t['Assigned To'];
    if (!perEmp[id]) perEmp[id] = { name: names[id] || id, total: 0, completed: 0, overdue: 0, pending: 0 };
    perEmp[id].total++;
    if (t['Status'] === 'Completed') perEmp[id].completed++;
    else if (t['Status'] === 'Overdue' || t['Status'] === 'Expired') perEmp[id].overdue++;
    else perEmp[id].pending++;
  });

  var perDept = {};
  all.forEach(function(t) {
    var d = t['Department'] || '—';
    if (!perDept[d]) perDept[d] = { total: 0, completed: 0 };
    perDept[d].total++;
    if (t['Status'] === 'Completed') perDept[d].completed++;
  });

  var eod = eodIndex().filter(function(r) { return r.date >= from && r.date <= to; });
  var eodCount = {};
  eod.forEach(function(r) { eodCount[r.id] = (eodCount[r.id] || 0) + 1; });
  var activeEmp = users.filter(function(u) { return u['Role'] === 'Employee' && u['Status'] === 'Active'; });

  var completed = all.filter(function(t) { return t['Status'] === 'Completed'; }).length;
  return {
    tickets: {
      total: all.length,
      completed: completed,
      overdue: all.filter(function(t) { return t['Status'] === 'Overdue' || t['Status'] === 'Expired'; }).length,
      pending: all.length - completed,
      completionRate: all.length ? Math.round(completed / all.length * 100) : 0
    },
    perEmployee: Object.keys(perEmp).map(function(k) { return perEmp[k]; }),
    perDepartment: Object.keys(perDept).map(function(k) {
      var d = perDept[k];
      return { department: k, total: d.total, completed: d.completed, rate: d.total ? Math.round(d.completed / d.total * 100) : 0 };
    }),
    eod: {
      totalEmployees: activeEmp.length,
      logsSubmitted: eod.length,
      perEmployee: activeEmp.map(function(u) { return { name: u['Name'], submitted: eodCount[u['User ID']] || 0 }; })
    }
  };
}

/* ============================================================
 * USERS & SETTINGS (Admin)
 * ============================================================ */
function publicUser(u) {
  return { id: u['User ID'], name: u['Name'], email: u['Email'], role: u['Role'], department: u['Department'], status: u['Status'], created: u['Created Date'] };
}

function listUsers() {
  return rows(DB.USERS).map(publicUser);
}

function addUser(p) {
  requireFields(p, ['name', 'email', 'role', 'code']);
  var email = String(p.email).trim().toLowerCase();
  if (findUserByEmail(email)) throw new Error('!A user with this email already exists.');
  var id = nextId('USR-', 'seq_user', 1002);
  appendRowObj(DB.USERS, {
    'User ID': id, 'Name': p.name, 'Email': p.email, 'Role': p.role,
    'Department': p.department || '', 'Status': 'Active', 'Created Date': today(), 'Access Code': p.code
  });
  return { id: id };
}

function updateUser(p) {
  var u = rows(DB.USERS).filter(function(x) { return x['User ID'] === p.id; })[0];
  if (!u) throw new Error('!User not found.');
  var patch = {};
  ['Name','Email','Role','Department','Status','Access Code'].forEach(function(h) {
    if (p[h] !== undefined) patch[h] = p[h];
  });
  updateRowObj(DB.USERS, u._row, patch);
  return { id: p.id };
}

function updateSetting(p) {
  requireFields(p, ['key']);
  var r = rows(DB.SETTINGS).filter(function(x) { return x['Key'] === p.key; })[0];
  if (r) updateRowObj(DB.SETTINGS, r._row, { 'Value': p.value });
  else appendRowObj(DB.SETTINGS, { 'Key': p.key, 'Value': p.value, 'Description': p.description || '' });
  return settingsMap();
}

/* ============================================================
 * MAINTENANCE — from the app (Admin → Settings → Maintenance) or from the Apps Script editor
 * (select the function, press Run; the report also lands in the "Diagnostics" tab of the sheet)
 * ============================================================ */
function maintenance(p) {
  var task = String(p.task || '');
  if (task === 'archive') { var n = archiveOldTickets(); return { message: n ? 'Moved ' + n + ' finished tickets to the archive tab.' : 'Nothing old enough to archive yet.' }; }
  if (task === 'fixDates') { var f = fixDateFormats(); return { message: f ? 'Converted ' + f + ' date cells to text.' : 'No date-typed cells found — nothing to fix.' }; }
  if (task === 'expire') { var x = expireOverdueRecurring(); return { message: x ? 'Marked ' + x + ' stale recurring tickets as Expired.' : 'No recurring tickets are stale enough to expire.' }; }
  throw new Error('!Unknown maintenance task.');
}

/**
 * Measures where the time goes. Returns the report, prints it to the Execution log, and appends it to the
 * "Diagnostics" tab of the spreadsheet.
 */
function diagnose() {
  var out = [], t0 = Date.now();
  function lap(label, fn) { var s = Date.now(); var r = fn(); out.push(label + ': ' + (Date.now() - s) + ' ms'); return r; }
  out.push('Stayopx Manager ' + APP_VERSION + ' — diagnose ' + nowStamp() + ' (' + TZ + ')');
  [DB.TICKETS, DB.ACTIVITY, DB.EOD, DB.USERS, DB.RECURRING, DB.ARCHIVE].forEach(function(n) {
    var sh = sheet(n);
    out.push('Rows in ' + n + ': ' + (sh ? Math.max(0, sh.getLastRow() - 1) : '(tab missing — run setupDatabase)'));
  });
  var sh = sheet(DB.TICKETS), last = sh.getLastRow(), dateCells = 0, chars = 0, descChars = 0;
  if (last >= 2) {
    var vals = lap('Read Tickets tab (all columns)', function() { return sh.getRange(2, 1, last - 1, HEADERS[DB.TICKETS].length).getValues(); });
    for (var i = 0; i < vals.length; i++) for (var c = 0; c < vals[i].length; c++) {
      if (vals[i][c] instanceof Date) dateCells++;
      else if (typeof vals[i][c] === 'string') { chars += vals[i][c].length; if (c === 3) descChars += vals[i][c].length; }
    }
    out.push('Date-typed cells in Tickets: ' + dateCells + (dateCells ? '   <-- run "Fix date formats"' : ' (good)'));
    out.push('Text in Tickets tab: ' + Math.round(chars / 1024) + ' KB, of which descriptions ' + Math.round(descChars / 1024) + ' KB');
  }
  _memo = {};
  var lite = lap('Read Tickets tab (without descriptions) + parse', function() { return rows(DB.TICKETS, LITE); });
  var st = {}, staleRecurring = 0, cutoff = dateMinus(Number(settingsMap()['EXPIRE_AFTER_DAYS']) || 14), oldest = '';
  lite.forEach(function(x) {
    st[x['Status']] = (st[x['Status']] || 0) + 1;
    if (x['Status'] === 'Overdue') {
      if (!oldest || x['Scheduled Date'] < oldest) oldest = x['Scheduled Date'];
      if (x['Parent Ticket ID'] && (x['Due Date'] || x['Scheduled Date']) < cutoff) staleRecurring++;
    }
  });
  out.push('Tickets by status: ' + Object.keys(st).map(function(k) { return k + ' ' + st[k]; }).join(', '));
  if (st['Overdue']) out.push('Oldest overdue ticket: ' + oldest + '. Recurring tickets overdue for more than ' + (Number(settingsMap()['EXPIRE_AFTER_DAYS']) || 14) + ' days: ' + staleRecurring + (staleRecurring ? '   <-- run "Expire stale recurring tickets"' : ''));
  var ok = cachePutObj('diag_probe', { v: 'x' }, 60) && (cacheGetObj('diag_probe') || {}).v === 'x';
  out.push('Cache working: ' + (ok ? 'yes' : 'NO — every request is recomputing'));
  var admin = rows(DB.USERS).filter(function(u) { return u['Role'] === 'Admin' && u['Status'] === 'Active'; })[0];
  if (admin) {
    var u = { id: admin['User ID'], name: admin['Name'], role: 'Admin' };
    var savedUser = _reqUser; _reqUser = null;
    bumpVersion(); _memo = {};
    var d = lap('Admin dashboard, cold (full sheet read)', function() { return dashboard(u); });
    _memo = {};
    lap('Admin dashboard, from cache', function() { return dashboard(u); });
    out.push('Dashboard reply size: ' + Math.round(JSON.stringify(d).length / 1024) + ' KB');
    _reqUser = savedUser;
  }
  out.push('Settings: ARCHIVE_AFTER_DAYS=' + (settingsMap()['ARCHIVE_AFTER_DAYS'] || '(missing)') + ', EXPIRE_AFTER_DAYS=' + (settingsMap()['EXPIRE_AFTER_DAYS'] || '(missing)'));
  out.push('Total: ' + (Date.now() - t0) + ' ms inside the script. Google adds roughly 1.5–3 s of its own to every request on top of this.');
  var report = out.join('\n');
  console.log(report);
  try {
    var dg = sheet('Diagnostics') || ss().insertSheet('Diagnostics');
    dg.appendRow([nowStamp(), report]);
  } catch (e) {}
  return report;
}

/**
 * OPTIONAL DAILY JOB — recurring tickets that are still Overdue more than EXPIRE_AFTER_DAYS (default 14) after their
 * due date are marked "Expired" so they stop piling up on the dashboard. They still count as missed in Reports.
 * Run from Admin → Settings → Maintenance, from the editor, or add a daily trigger.
 */
function expireOverdueRecurring() {
  var days = Number(settingsMap()['EXPIRE_AFTER_DAYS']) || 14;
  var cutoff = dateMinus(days);
  return withLock(60000, function() {
    var hits = rows(DB.TICKETS, LITE).filter(function(t) {
      return t['Status'] === 'Overdue' && t['Parent Ticket ID'] && (t['Due Date'] || t['Scheduled Date']) < cutoff;
    });
    if (!hits.length) return 0;
    var sh = sheet(DB.TICKETS), head = HEADERS[DB.TICKETS];
    var statusCol = colLetter(head.indexOf('Status') + 1), updCol = colLetter(head.indexOf('Updated Date') + 1);
    var stamp = nowStamp();
    for (var i = 0; i < hits.length; i += 200) {
      var part = hits.slice(i, i + 200);
      sh.getRangeList(part.map(function(t) { return statusCol + t._row; })).setValue('Expired');
      sh.getRangeList(part.map(function(t) { return updCol + t._row; })).setValue(stamp);
    }
    var actIds = nextIds('ACT-', 'seq_activity', 50001, hits.length);
    appendRowsObj(DB.ACTIVITY, hits.map(function(t, i) {
      return activityRow(actIds[i], t['Ticket ID'], 'Scheduler', 'Overdue', 'Expired', 'Expired: not completed within ' + days + ' days of its due date');
    }));
    forget(DB.TICKETS); bumpVersion();
    return hits.length;
  });
}

/**
 * One-time repair: converts any real Date/Time cells in the data tabs to plain text (yyyy-MM-dd / HH:mm)
 * and sets those columns to text format, so reads never have to convert dates again.
 */
function fixDateFormats() {
  var fixed = 0;
  withLock(120000, function() {
    Object.keys(DB).forEach(function(k) {
      var name = DB[k], sh = sheet(name);
      if (!sh || name === DB.SETTINGS) return;
      var last = sh.getLastRow(), cols = HEADERS[name].length;
      if (last < 2) return;
      var range = sh.getRange(2, 1, last - 1, cols);
      var vals = range.getValues(), changed = false;
      for (var i = 0; i < vals.length; i++) for (var c = 0; c < cols; c++) {
        if (vals[i][c] instanceof Date) { vals[i][c] = normalize(vals[i][c]); changed = true; fixed++; }
      }
      if (changed) { range.setNumberFormat('@'); range.setValues(vals); forget(name); }
    });
  });
  bumpVersion();
  console.log('Converted ' + fixed + ' date cells to text.');
  return fixed;
}
