/**
 * Stayopx Manager — Ticketing & Daily Work Log System
 * Google Apps Script backend (API layer over Google Sheets)
 *
 * SETUP (see SETUP.md):
 *  1. Create a blank Google Spreadsheet, open Extensions → Apps Script, paste this file.
 *  2. Run setupDatabase() once (authorize when prompted). It creates all tabs + a default admin.
 *  3. Deploy → New deployment → Web app → Execute as: Me, Access: Anyone. Copy the /exec URL.
 *  4. Paste the URL into CONFIG.API_URL at the top of script.js.
 *  5. Add time-driven triggers for dailyScheduler (daily, early morning) and markOverdueTickets (hourly).
 *  6. Run authorizeEmail() once so the "Forgot access code?" emails can be sent.
 */

var DB = {
  USERS: 'Users',
  TICKETS: 'Tickets',
  RECURRING: 'Recurring Tickets',
  ACTIVITY: 'Ticket Activity',
  EOD: 'EOD Logs',
  SETTINGS: 'Settings'
};

var HEADERS = {};
HEADERS[DB.USERS] = ['User ID','Name','Email','Role','Department','Status','Created Date','Access Code'];
HEADERS[DB.TICKETS] = ['Ticket ID','Parent Ticket ID','Title','Description','Assigned To','Created By','Department','Priority','Ticket Type','Scheduled Date','Scheduled Time','Due Date','Status','Created Date','Updated Date','Completed Date'];
HEADERS[DB.RECURRING] = ['Recurring ID','Title','Description','Assigned To','Frequency','Day','Time','Start Date','End Date','Status','Created By','Department','Priority'];
HEADERS[DB.ACTIVITY] = ['Activity ID','Ticket ID','User','Previous Status','New Status','Comment','Date','Time'];
HEADERS[DB.EOD] = ['Log ID','Employee ID','Employee Name','Date','Tickets Assigned','Tickets Completed','Tickets Pending','Work Completed','Challenges','Pending Work','Tomorrow Plan','Remarks','Submitted At'];
HEADERS[DB.SETTINGS] = ['Key','Value','Description'];

var TZ = Session.getScriptTimeZone();

/* ============================================================
 * ONE-TIME SETUP
 * ============================================================ */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(DB).forEach(function(k) {
    var name = DB[k];
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold').setBackground('#EEF1F4');
      sh.setFrozenRows(1);
    }
  });
  // Force date-sensitive columns to plain text so values round-trip as strings
  var tk = ss.getSheetByName(DB.TICKETS);
  tk.getRange('J:L').setNumberFormat('@'); tk.getRange('N:P').setNumberFormat('@');
  ss.getSheetByName(DB.ACTIVITY).getRange('G:H').setNumberFormat('@');
  ss.getSheetByName(DB.EOD).getRange('D:D').setNumberFormat('@');
  ss.getSheetByName(DB.EOD).getRange('M:M').setNumberFormat('@');
  ss.getSheetByName(DB.RECURRING).getRange('G:I').setNumberFormat('@');
  ss.getSheetByName(DB.USERS).getRange('G:H').setNumberFormat('@');

  var settings = ss.getSheetByName(DB.SETTINGS);
  if (settings.getLastRow() < 2) {
    var rows = [
      ['EOD_CUTOFF', '23:00', 'Employees can edit their EOD log until this time (HH:mm, 24h)'],
      ['STATUSES', 'Open,In Progress,Completed,On Hold,Overdue', 'Ticket statuses'],
      ['PRIORITIES', 'Low,Medium,High,Critical', 'Ticket priorities'],
      ['DEPARTMENTS', 'Operations,Housekeeping,F&B,Maintenance,Finance,Sales,Tech', 'Departments'],
      ['FREQUENCIES', 'One-Time,Daily,Weekly,Monthly', 'Ticket types'],
      ['APP_NAME', 'Stayopx Manager', 'Application display name']
    ];
    settings.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  var users = ss.getSheetByName(DB.USERS);
  if (users.getLastRow() < 2) {
    users.appendRow(['USR-1001', 'Admin', 'admin@company.com', 'Admin', 'Operations', 'Active', today(), 'admin123']);
  }
  return 'Database ready';
}

/* ============================================================
 * HTTP ENTRY POINTS
 * ============================================================ */
function doGet() {
  return json({ ok: true, data: 'Stayopx Manager API is running' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var action = req.action;
    var p = req.payload || {};
    var user = null;

    var publicActions = ['login', 'requestReset', 'resetPassword'];   // usable before signing in
    if (publicActions.indexOf(action) === -1) {
      user = validateToken(req.token);
      if (!user) return json({ ok: false, error: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' });
    }

    var adminOnly = ['updateTicket','createRecurring','updateRecurring','listUsers','addUser','updateUser','adminKPIs','listAllEOD','updateSetting','reportData'];
    if (adminOnly.indexOf(action) !== -1 && user.role !== 'Admin') {
      return json({ ok: false, error: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
    }

    var out;
    switch (action) {
      case 'login':            out = login(p); break;
      case 'requestReset':     out = requestReset(p); break;
      case 'resetPassword':    out = resetPassword(p); break;
      case 'bootstrap':        out = bootstrap(user); break;
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
      default: return json({ ok: false, error: 'UNKNOWN_ACTION', message: 'Unknown action: ' + action });
    }
    return json({ ok: true, data: out });
  } catch (err) {
    return json({ ok: false, error: 'SERVER_ERROR', message: friendlyError(err) });
  }
}

function friendlyError(err) {
  var m = String(err && err.message || err);
  // Known, user-safe messages start with "!"
  if (m.indexOf('!') === 0) return m.substring(1);
  console.error(m);
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
  var u = rows(DB.USERS).filter(function(r) {
    return String(r['Email']).trim().toLowerCase() === email;
  })[0];
  if (!u || String(u['Access Code']).trim() !== code) throw new Error('!Invalid email or access code.');
  if (String(u['Status']) !== 'Active') throw new Error('!This account is inactive. Contact your admin.');

  var user = { id: u['User ID'], name: u['Name'], email: u['Email'], role: u['Role'], department: u['Department'] };
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token, JSON.stringify(user), 21600); // 6 hours
  return { token: token, user: user, settings: settingsMap() };
}

function validateToken(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('tok_' + token);
  if (!raw) return null;
  CacheService.getScriptCache().put('tok_' + token, raw, 21600); // sliding expiry
  return JSON.parse(raw);
}

/* ------------------------------------------------------------
 * FORGOT ACCESS CODE — emailed 6-digit code
 *   requestReset  : emails a one-time code to the address on file
 *   resetPassword : checks the code and saves the new access code
 * The code lives in the script cache only (never in the sheet), is valid for
 * 10 minutes, and is thrown away after 5 wrong tries.
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

  var cache = CacheService.getScriptCache();
  if (cache.get('rst_wait_' + email)) throw new Error('!A code was just sent. Wait a minute before asking for another.');
  cache.put('rst_wait_' + email, '1', 60);

  // Same reply whether or not the email is registered, so this screen can't be used to find out who has an account.
  var reply = { sent: true, minutes: RESET_MINUTES };
  var u = findUserByEmail(email);
  if (!u || String(u['Status']) !== 'Active') return reply;

  var otp = ('000000' + (parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000)).slice(-6);
  cache.put('rst_' + email, JSON.stringify({ otp: otp, tries: 0, exp: Date.now() + RESET_MINUTES * 60000 }), RESET_MINUTES * 60);

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
    cache.remove('rst_' + email);
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
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get('rst_' + email);
    if (!raw) throw new Error(wrong);
    var rec = JSON.parse(raw);
    if (Date.now() > rec.exp) { cache.remove('rst_' + email); throw new Error(wrong); }

    if (rec.otp !== otp) {
      rec.tries++;
      if (rec.tries >= RESET_MAX_TRIES) cache.remove('rst_' + email);
      else cache.put('rst_' + email, JSON.stringify(rec), Math.max(1, Math.ceil((rec.exp - Date.now()) / 1000)));
      throw new Error(wrong);
    }

    var u = findUserByEmail(email);
    if (!u || String(u['Status']) !== 'Active') { cache.remove('rst_' + email); throw new Error(wrong); }
    updateRowObj(DB.USERS, u._row, { 'Access Code': newCode });
    cache.remove('rst_' + email);
    return { done: true };
  } finally {
    lock.releaseLock();
  }
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
function sheet(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

function rows(name) {
  var sh = sheet(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var head = HEADERS[name];
  var data = sh.getRange(2, 1, last - 1, head.length).getValues();
  return data.map(function(r, i) {
    var o = { _row: i + 2 };
    head.forEach(function(h, c) { o[h] = normalize(r[c]); });
    return o;
  }).filter(function(o) { return o[head[0]] !== ''; });
}

function normalize(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function appendRowObj(name, obj) {
  var head = HEADERS[name];
  sheet(name).appendRow(head.map(function(h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function updateRowObj(name, rowIndex, patch) {
  var head = HEADERS[name];
  var sh = sheet(name);
  var current = sh.getRange(rowIndex, 1, 1, head.length).getValues()[0];
  head.forEach(function(h, c) { if (patch[h] !== undefined) current[c] = patch[h]; });
  sh.getRange(rowIndex, 1, 1, head.length).setValues([current]);
}

function nextId(prefix, key, start) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var n = Number(props.getProperty(key) || start);
    props.setProperty(key, String(n + 1));
    return prefix + n;
  } finally {
    lock.releaseLock();
  }
}

function settingsMap() {
  var map = {};
  rows(DB.SETTINGS).forEach(function(r) { map[r['Key']] = r['Value']; });
  return map;
}

function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowTime() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function nowStamp() { return today() + ' ' + Utilities.formatDate(new Date(), TZ, 'HH:mm:ss'); }

/* ============================================================
 * ACTIVITY LOG
 * ============================================================ */
function logActivity(ticketId, userName, prevStatus, newStatus, comment) {
  appendRowObj(DB.ACTIVITY, {
    'Activity ID': nextId('ACT-', 'seq_activity', 50001),
    'Ticket ID': ticketId,
    'User': userName,
    'Previous Status': prevStatus || '',
    'New Status': newStatus || '',
    'Comment': comment || '',
    'Date': today(),
    'Time': Utilities.formatDate(new Date(), TZ, 'HH:mm:ss')
  });
}

/* ============================================================
 * TICKETS
 * ============================================================ */
function scopeTickets(user) {
  var all = rows(DB.TICKETS);
  if (user.role === 'Admin') return all;
  return all.filter(function(t) { return t['Assigned To'] === user.id; });
}

function listTickets(user, p) {
  var list = scopeTickets(user);
  if (p && p.status) list = list.filter(function(t) { return t['Status'] === p.status; });
  list.sort(function(a, b) {
    return (b['Scheduled Date'] + b['Scheduled Time']).localeCompare(a['Scheduled Date'] + a['Scheduled Time']);
  });
  return list.map(publicTicket);
}

function publicTicket(t) {
  var o = {};
  HEADERS[DB.TICKETS].forEach(function(h) { o[h] = t[h]; });
  return o;
}

function getTicket(user, p) {
  var t = findTicket(p.id);
  if (user.role !== 'Admin' && t['Assigned To'] !== user.id) throw new Error('!You do not have access to this ticket.');
  var activity = rows(DB.ACTIVITY).filter(function(a) { return a['Ticket ID'] === p.id; });
  return { ticket: publicTicket(t), activity: activity };
}

function findTicket(id) {
  var t = rows(DB.TICKETS).filter(function(r) { return r['Ticket ID'] === id; })[0];
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
  var valid = settingsMap()['STATUSES'].split(',');
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
  return rows(DB.RECURRING).map(function(r) { var o = {}; HEADERS[DB.RECURRING].forEach(function(h) { o[h] = r[h]; }); return o; });
}

function updateRecurring(user, p) {
  var r = rows(DB.RECURRING).filter(function(x) { return x['Recurring ID'] === p.id; })[0];
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
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var d = parseDate(dateStr);
    var weekday = Utilities.formatDate(d, TZ, 'EEEE'); // Monday...
    var dom = d.getDate();
    var lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

    var existing = {};
    rows(DB.TICKETS).forEach(function(t) {
      if (t['Parent Ticket ID']) existing[t['Parent Ticket ID'] + '|' + t['Scheduled Date']] = true;
    });

    var users = rows(DB.USERS);
    var created = 0;
    rows(DB.RECURRING).forEach(function(r) {
      if (r['Status'] !== 'Active') return;
      if (r['Start Date'] && dateStr < r['Start Date']) return;
      if (r['End Date'] && dateStr > r['End Date']) return;

      var due = false;
      if (r['Frequency'] === 'Daily') due = true;
      else if (r['Frequency'] === 'Weekly') due = (r['Day'] === weekday);
      else if (r['Frequency'] === 'Monthly') {
        var target = Math.min(Number(r['Day']) || 1, lastDom); // clamp e.g. 31st in Feb
        due = (dom === target);
      }
      if (!due) return;
      if (existing[r['Recurring ID'] + '|' + dateStr]) return; // duplicate prevention

      var id = nextId('TKT-', 'seq_ticket', 10001);
      appendRowObj(DB.TICKETS, {
        'Ticket ID': id,
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
        'Created Date': nowStamp(),
        'Updated Date': nowStamp(),
        'Completed Date': ''
      });
      logActivity(id, 'Scheduler', '', 'Open', 'Auto-generated from recurring template ' + r['Recurring ID']);
      created++;
    });
    return created;
  } finally {
    lock.releaseLock();
  }
}

/**
 * TIME-DRIVEN TRIGGER — run hourly.
 * Marks Open / In Progress / On Hold tickets as Overdue once past their due date + scheduled time.
 */
function markOverdueTickets() {
  var now = new Date();
  rows(DB.TICKETS).forEach(function(t) {
    if (['Open', 'In Progress', 'On Hold'].indexOf(t['Status']) === -1) return;
    if (!t['Due Date']) return;
    var due = parseDate(t['Due Date']);
    var tm = (t['Scheduled Time'] || '23:59').split(':');
    due.setHours(Number(tm[0]) || 23, Number(tm[1]) || 59, 0, 0);
    if (now > due) {
      updateRowObj(DB.TICKETS, t._row, { 'Status': 'Overdue', 'Updated Date': nowStamp() });
      logActivity(t['Ticket ID'], 'Scheduler', t['Status'], 'Overdue', 'Ticket passed its due date without completion');
    }
  });
}

function parseDate(s) {
  var p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2] || 1));
}

/* ============================================================
 * EOD WORK LOGS
 * ============================================================ */
function submitEOD(user, p) {
  requireFields(p, ['workCompleted']);
  var date = p.date || today();
  var cutoff = settingsMap()['EOD_CUTOFF'] || '23:00';
  var existing = rows(DB.EOD).filter(function(r) {
    return r['Employee ID'] === user.id && r['Date'] === date;
  })[0];

  var mine = rows(DB.TICKETS).filter(function(t) {
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

function myEOD(user) {
  var list = rows(DB.EOD).filter(function(r) { return r['Employee ID'] === user.id; });
  list.sort(function(a, b) { return b['Date'].localeCompare(a['Date']); });
  return list.map(cleanRow(DB.EOD));
}

function listAllEOD(user, p) {
  var list = rows(DB.EOD);
  if (p && p.date) list = list.filter(function(r) { return r['Date'] === p.date; });
  if (p && p.employee) list = list.filter(function(r) { return r['Employee ID'] === p.employee; });
  list.sort(function(a, b) { return b['Date'].localeCompare(a['Date']); });
  return list.map(cleanRow(DB.EOD));
}

function cleanRow(sheetName) {
  return function(r) { var o = {}; HEADERS[sheetName].forEach(function(h) { o[h] = r[h]; }); return o; };
}

/* ============================================================
 * KPIs & REPORTS
 * ============================================================ */
function countBy(list, field) {
  var m = {};
  list.forEach(function(t) { var k = t[field] || '—'; m[k] = (m[k] || 0) + 1; });
  return m;
}

function adminKPIs(user) {
  var all = rows(DB.TICKETS).filter(function(t) { return t['Status'] !== 'Cancelled'; });
  var t = today();
  var todays = all.filter(function(x) { return x['Scheduled Date'] === t; });
  var completed = all.filter(function(x) { return x['Status'] === 'Completed'; }).length;
  var users = rows(DB.USERS).filter(function(u) { return u['Role'] === 'Employee' && u['Status'] === 'Active'; });
  var eodToday = rows(DB.EOD).filter(function(r) { return r['Date'] === t; });
  var submittedIds = eodToday.map(function(r) { return r['Employee ID']; });

  // last 7 days completion series
  var series = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    var ds = Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
    var day = all.filter(function(x) { return x['Scheduled Date'] === ds; });
    series.push({
      date: Utilities.formatDate(d, TZ, 'dd MMM'),
      total: day.length,
      completed: day.filter(function(x) { return x['Status'] === 'Completed'; }).length
    });
  }

  var userNames = {};
  rows(DB.USERS).forEach(function(u) { userNames[u['User ID']] = u['Name']; });
  var byEmp = {};
  all.forEach(function(x) {
    var n = userNames[x['Assigned To']] || x['Assigned To'];
    byEmp[n] = (byEmp[n] || 0) + 1;
  });

  return {
    total: all.length,
    open: all.filter(function(x) { return x['Status'] === 'Open'; }).length,
    inProgress: all.filter(function(x) { return x['Status'] === 'In Progress'; }).length,
    completed: completed,
    overdue: all.filter(function(x) { return x['Status'] === 'Overdue'; }).length,
    onHold: all.filter(function(x) { return x['Status'] === 'On Hold'; }).length,
    todayTotal: todays.length,
    pending: all.length - completed,
    completionRate: all.length ? Math.round(completed / all.length * 100) : 0,
    byStatus: countBy(all, 'Status'),
    byPriority: countBy(all, 'Priority'),
    byEmployee: byEmp,
    weekSeries: series,
    eodSubmitted: submittedIds.length,
    eodSubmittedToday: !!user && submittedIds.indexOf(user.id) !== -1,
    eodPending: users.filter(function(u) { return submittedIds.indexOf(u['User ID']) === -1; }).map(function(u) { return u['Name']; })
  };
}

function employeeKPIs(user) {
  var mine = scopeTickets(user).filter(function(t) { return t['Status'] !== 'Cancelled'; });
  var t = today();
  var eod = rows(DB.EOD).filter(function(r) { return r['Employee ID'] === user.id && r['Date'] === t; })[0];
  return {
    total: mine.length,
    open: mine.filter(function(x) { return x['Status'] === 'Open'; }).length,
    inProgress: mine.filter(function(x) { return x['Status'] === 'In Progress'; }).length,
    completed: mine.filter(function(x) { return x['Status'] === 'Completed'; }).length,
    overdue: mine.filter(function(x) { return x['Status'] === 'Overdue'; }).length,
    dueToday: mine.filter(function(x) { return x['Scheduled Date'] === t && x['Status'] !== 'Completed'; }).length,
    eodSubmittedToday: !!eod
  };
}

function reportData(p) {
  var from = p.from || '0000-00-00';
  var to = p.to || '9999-12-31';
  var all = rows(DB.TICKETS).filter(function(t) {
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
    else if (t['Status'] === 'Overdue') perEmp[id].overdue++;
    else perEmp[id].pending++;
  });

  var perDept = {};
  all.forEach(function(t) {
    var d = t['Department'] || '—';
    if (!perDept[d]) perDept[d] = { total: 0, completed: 0 };
    perDept[d].total++;
    if (t['Status'] === 'Completed') perDept[d].completed++;
  });

  var eod = rows(DB.EOD).filter(function(r) { return r['Date'] >= from && r['Date'] <= to; });
  var activeEmp = users.filter(function(u) { return u['Role'] === 'Employee' && u['Status'] === 'Active'; });

  var completed = all.filter(function(t) { return t['Status'] === 'Completed'; }).length;
  return {
    tickets: {
      total: all.length,
      completed: completed,
      overdue: all.filter(function(t) { return t['Status'] === 'Overdue'; }).length,
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
      perEmployee: activeEmp.map(function(u) {
        return { name: u['Name'], submitted: eod.filter(function(r) { return r['Employee ID'] === u['User ID']; }).length };
      })
    }
  };
}

/* ============================================================
 * USERS & SETTINGS (Admin)
 * ============================================================ */
function listUsers() {
  return rows(DB.USERS).map(function(u) {
    return { id: u['User ID'], name: u['Name'], email: u['Email'], role: u['Role'], department: u['Department'], status: u['Status'], created: u['Created Date'] };
  });
}

function addUser(p) {
  requireFields(p, ['name', 'email', 'role', 'code']);
  var email = String(p.email).trim().toLowerCase();
  var dup = rows(DB.USERS).filter(function(u) { return String(u['Email']).trim().toLowerCase() === email; })[0];
  if (dup) throw new Error('!A user with this email already exists.');
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
