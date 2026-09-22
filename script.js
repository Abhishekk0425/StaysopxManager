/* ============================================================
 * Stayopx Manager — frontend application
 * Vanilla JS single-page app · Google Apps Script backend
 * ============================================================ */

var CONFIG = {
  // Paste your Apps Script Web App URL here (ends in /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbyhbU_YmsETzJxY5YWoie5tGGvCSx-hpjUpd6MwDBTUzqJyUvfl3SyS8M7lxj_90MXVnQ/exec'
};

var state = {
  token: localStorage.getItem('od_token') || null,
  user: JSON.parse(localStorage.getItem('od_user') || 'null'),
  settings: JSON.parse(localStorage.getItem('od_settings') || '{}'),
  users: [],           // admin only
  tickets: [],         // last loaded ticket list
  view: 'dashboard',
  viewArg: null,
  charts: [],
  notifs: [],
  notifSeen: JSON.parse(localStorage.getItem('od_notif_seen') || '{}')
};

/* ============================================================
 * API CLIENT
 * ============================================================ */
/* ============================================================
 * THEME — change DEFAULT_THEME to 'light' if you want new visitors to start in the light look
 * ============================================================ */
var DEFAULT_THEME = 'dark';
function currentTheme() {
  try { return localStorage.getItem('od_theme') || DEFAULT_THEME; } catch (e) { return DEFAULT_THEME; }
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var btn = document.getElementById('themeBtn');
  if (btn) {
    btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 19);
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }
}
function toggleTheme() {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('od_theme', next); } catch (e) {}
  applyTheme(next);
  if (state.charts.length) renderView(true);   // charts read their colours from the theme
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* thin loading bar at the very top + spinning refresh icon while any request is running */
var _inflight = 0;
function setLoading(on) {
  _inflight = Math.max(0, _inflight + (on ? 1 : -1));
  document.body.classList.toggle('is-loading', _inflight > 0);
}
/* spinner inside a button while it is working */
function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
  if (label) btn.textContent = label;
}

function apiError(code, message) { var e = new Error(message); e.code = code; return e; }

/* under a connection error on the login screen: a link that opens the backend directly, so anyone can see what it says */
function serverCheckHtml() {
  return ' <a href="' + esc(CONFIG.API_URL) + '" target="_blank" rel="noopener">Test the backend</a>' +
    '<span class="login-hint">A working backend shows: “Stayopx Manager API is running”. Anything else (a Google sign-in page, ' +
    '“Authorization is required”, or an error) means the Apps Script has to be fixed, not this page.</span>';
}

/* Give up on a request after this long instead of leaving the page "loading" forever */
var API_TIMEOUT_MS = 45000;
/* Read-only actions: safe to retry once, and identical calls made at the same moment share one request */
var READ_ACTIONS = { dashboard: 1, listTickets: 1, getTicket: 1, listRecurring: 1, listUsers: 1, myEOD: 1, listAllEOD: 1, reportData: 1, bootstrap: 1, adminKPIs: 1, employeeKPIs: 1 };
var _pending = {};

async function api(action, payload) {
  if (CONFIG.API_URL.indexOf('http') !== 0) {
    throw new Error('Backend not configured. Paste your Apps Script URL into CONFIG.API_URL in script.js.');
  }
  var isRead = !!READ_ACTIONS[action];
  var key = isRead ? action + ':' + JSON.stringify(payload || {}) : null;
  if (key && _pending[key]) return _pending[key];          // same read already running — reuse it

  var run = (async function() {
    try {
      var data = await apiOnce(action, payload);
      if (!isRead) state.dash = null;                      // a write happened: never repaint from the old dashboard reply
      return data;
    } catch (e) {
      // one quiet retry for reads when Google stumbled (busy, cold start, network blip)
      if (isRead && (e.code === 'NO_SERVER' || e.code === 'BAD_REPLY' || e.code === 'BUSY' || e.code === 'TIMEOUT')) {
        await new Promise(function(r) { setTimeout(r, 1500); });
        return await apiOnce(action, payload);
      }
      throw e;
    }
  })();
  if (key) {
    _pending[key] = run;
    run.then(function() { delete _pending[key]; }, function() { delete _pending[key]; });
  }
  return run;
}

async function apiOnce(action, payload) {
  var out, res, text, t0 = Date.now();
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, API_TIMEOUT_MS) : null;
  setLoading(true);
  try {
    try {
      res = await fetch(CONFIG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
        body: JSON.stringify({ action: action, token: state.token, payload: payload || {} }),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw apiError('TIMEOUT', 'The backend took too long to answer. Please try again in a moment.');
      }
      // Either there is no internet, or Google answered with an error page instead of the app
      // (the usual reason: the Apps Script was changed but not authorized / redeployed).
      throw apiError('NO_SERVER', navigator.onLine === false ?
        'You appear to be offline. Check your internet connection and try again.' :
        'The backend is not responding. If your internet is working, the Apps Script needs to be authorized or redeployed.');
    }
    text = await res.text();
    try {
      out = JSON.parse(text);
    } catch (e) {
      // Google sends an HTML page instead of JSON when the script itself failed — say why when we can tell
      var low = String(text || '').toLowerCase();
      if (low.indexOf('simultaneous') !== -1 || low.indexOf('too many') !== -1) {
        throw apiError('BUSY', 'The backend is busy — too many people loading at the same time. Please wait a moment and try again.');
      }
      if (low.indexOf('exceeded maximum execution time') !== -1) {
        throw apiError('BUSY', 'The backend ran out of time building this page. Try again; if it keeps happening, run archiveOldTickets in the Apps Script editor.');
      }
      if (low.indexOf('authorization') !== -1 || low.indexOf('sign in') !== -1) {
        throw apiError('BAD_REPLY', 'The backend is asking for authorization. Open the Apps Script, run any function once to authorize it, then deploy a new version.');
      }
      throw apiError('BAD_REPLY', 'The backend replied with an error page instead of data. The Apps Script needs to be authorized or redeployed.');
    }
  } finally {
    if (timer) clearTimeout(timer);
    setLoading(false);
  }
  state.lastCall = { action: action, total: Date.now() - t0, server: out.meta ? out.meta.ms : null,
    cached: !!(out.meta && out.meta.cached), version: out.meta ? out.meta.v : null };
  if (!out.ok) {
    if (out.error === 'SESSION_EXPIRED' && state.token) { logout(true); }
    var err = new Error(out.message || 'Request failed. Please try again.');
    err.code = out.error;
    throw err;
  }
  return out.data;
}

/* ============================================================
 * AUTH
 * ============================================================ */
async function doLogin() {
  var btn = document.getElementById('loginBtn');
  var err = document.getElementById('loginError');
  err.textContent = ''; err.classList.remove('ok');
  setBusy(btn, true, 'Signing in…');
  try {
    var data = await api('login', {
      email: document.getElementById('loginEmail').value,
      code: document.getElementById('loginCode').value
    });
    state.token = data.token; state.user = data.user; state.settings = data.settings;
    localStorage.setItem('od_token', data.token);
    localStorage.setItem('od_user', JSON.stringify(data.user));
    localStorage.setItem('od_settings', JSON.stringify(data.settings));
    document.getElementById('loginCode').value = '';
    setCodeVisible('loginCode', 'pwToggle', false);
    enterApp();
  } catch (e) {
    err.textContent = e.message;
    if (e.code === 'NO_SERVER' || e.code === 'BAD_REPLY') err.innerHTML = esc(e.message) + serverCheckHtml();
  } finally {
    setBusy(btn, false, 'Sign in');
  }
}

function logout(expired) {
  ['od_token', 'od_user', 'od_settings', 'od_dash'].forEach(function(k) { localStorage.removeItem(k); });
  state.token = null; state.user = null;
  state.users = []; state.tickets = []; state.dash = null;
  closeProfile();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  if (expired) toast('Your session expired. Please sign in again.', 'error');
}

/* show / hide an access-code field (eye button) */
function setCodeVisible(inputId, btnId, show) {
  var input = document.getElementById(inputId);
  var btn = document.getElementById(btnId);
  input.type = show ? 'text' : 'password';
  btn.classList.toggle('on', show);
  btn.setAttribute('aria-pressed', show ? 'true' : 'false');
  btn.setAttribute('aria-label', show ? 'Hide access code' : 'Show access code');
  btn.title = show ? 'Hide access code' : 'Show access code';
}
function toggleCode(inputId, btnId) {
  setCodeVisible(inputId, btnId, document.getElementById(inputId).type === 'password');
  document.getElementById(inputId).focus();
}

/* ============================================================
 * FORGOT ACCESS CODE
 * Step 1: email a 6-digit code · Step 2: enter it and choose a new access code
 * ============================================================ */
var resetStep = 1;

function showReset() {
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('resetForm').classList.remove('hidden');
  document.getElementById('resetEmail').value = document.getElementById('loginEmail').value.trim();
  setResetStep(1);
  resetMsg('');
  document.getElementById('resetEmail').focus();
}

function showLogin(okMsg) {
  document.getElementById('resetForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('resetOtp').value = '';
  document.getElementById('resetNewCode').value = '';
  setCodeVisible('resetNewCode', 'resetToggle', false);
  var note = document.getElementById('loginError');
  note.textContent = okMsg || '';
  note.classList.toggle('ok', !!okMsg);
}

function setResetStep(n) {
  resetStep = n;
  document.getElementById('resetStep2').classList.toggle('hidden', n !== 2);
  document.getElementById('resendBtn').classList.toggle('hidden', n !== 2);
  document.getElementById('resetEmail').readOnly = n === 2;
  document.getElementById('resetBtn').textContent = n === 1 ? 'Email me a reset code' : 'Save new access code';
  document.getElementById('resetIntro').textContent = n === 1 ?
    'Enter your work email and we will send you a 6-digit code.' :
    'If that email is registered, a 6-digit code is on its way. It is valid for 10 minutes. Check spam if you do not see it.';
}

function resetMsg(text, ok) {
  var el = document.getElementById('resetMsg');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function doReset() { return resetStep === 1 ? sendResetCode() : saveNewCode(); }

async function sendResetCode() {
  var email = document.getElementById('resetEmail').value.trim();
  if (!email) { resetMsg('Enter your work email.'); return; }
  var btn = document.getElementById('resetBtn');
  var label = btn.textContent;
  resetMsg('');
  setBusy(btn, true, 'Sending…');
  try {
    await api('requestReset', { email: email });
    var again = resetStep === 2;
    setResetStep(2);
    if (again) resetMsg('A new code has been sent.', true);
    document.getElementById('resetOtp').focus();
  } catch (e) {
    btn.textContent = label;
    resetMsg(e.code === 'SESSION_EXPIRED' ?
      'Reset is not switched on yet. Ask your admin to deploy the latest Code.gs.' : e.message);
  } finally {
    setBusy(btn, false);
    if (btn.textContent === 'Sending…') btn.textContent = resetStep === 1 ? 'Email me a reset code' : 'Save new access code';
  }
}

async function saveNewCode() {
  var email = document.getElementById('resetEmail').value.trim();
  var otp = document.getElementById('resetOtp').value.trim();
  var code = document.getElementById('resetNewCode').value.trim();
  if (!otp) { resetMsg('Enter the 6-digit code from the email.'); return; }
  if (code.length < 6) { resetMsg('Your new access code must be at least 6 characters.'); return; }
  var btn = document.getElementById('resetBtn');
  resetMsg('');
  setBusy(btn, true, 'Saving…');
  try {
    await api('resetPassword', { email: email, otp: otp, newCode: code });
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginCode').value = '';
    showLogin('Access code updated. Sign in with your new code.');
    document.getElementById('loginCode').focus();
  } catch (e) {
    resetMsg(e.message);
  } finally {
    setBusy(btn, false, 'Save new access code');
  }
}

/* profile menu (top right) */
function toggleProfile() {
  var panel = document.getElementById('profilePanel');
  var opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  document.getElementById('profileBtn').setAttribute('aria-expanded', opening ? 'true' : 'false');
  if (opening) document.getElementById('notifPanel').classList.add('hidden');
}
function closeProfile() {
  document.getElementById('profilePanel').classList.add('hidden');
  document.getElementById('profileBtn').setAttribute('aria-expanded', 'false');
}

async function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  // profile menu (top right)
  document.getElementById('userName').textContent = state.user.name;
  document.getElementById('userFirstName').textContent = String(state.user.name || '').split(/\s+/)[0];
  document.getElementById('userEmail').textContent = state.user.email || '';
  document.getElementById('userRole').textContent = state.user.role;
  document.getElementById('userDept').textContent = state.user.department || '—';
  document.getElementById('userAvatar').textContent = initials(state.user.name);
  document.getElementById('userAvatarLg').textContent = initials(state.user.name);
  buildSidebar();
  // One request only: the dashboard reply also carries the settings and (for admins) the user list.
  navigate('dashboard');
}

/* ============================================================
 * NAVIGATION
 * ============================================================ */
/* One consistent line-icon set (replaces the emoji, which look different on every device) */
var ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  ticket: '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M14 5v3M14 11v2M14 16v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-4M12 16V7M17 16v-6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  dot: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  wand: '<path d="M5 19L16 8"/><path d="M14 6l4 4"/><path d="M18 3v3M16.5 4.5h3M6 5v2M5 6h2M19 14v2M18 15h2"/>'
};
function icon(name, size) {
  var s = size || 18;
  return '<svg class="ico" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
}

var NAV = {
  Admin: [
    ['dashboard', 'dashboard', 'Dashboard'],
    ['tickets', 'ticket', 'All Tickets'],
    ['createTicket', 'plus', 'Create Ticket'],
    ['recurring', 'repeat', 'Recurring Tickets'],
    ['employees', 'users', 'Employees'],
    ['eodAdmin', 'note', 'Team EOD Logs'],
    ['eod', 'check', 'My EOD Log'],
    ['reports', 'chart', 'Reports'],
    ['settings', 'sliders', 'Settings']
  ],
  Employee: [
    ['dashboard', 'dashboard', 'Dashboard'],
    ['tickets', 'ticket', 'My Tickets'],
    ['createTicket', 'plus', 'New Ticket'],
    ['today', 'sun', "Today's Tasks"],
    ['upcoming', 'calendar', 'Upcoming Tasks'],
    ['completed', 'check', 'Completed'],
    ['eod', 'note', 'EOD Work Log'],
    ['history', 'clock', 'My History']
  ]
};

var VIEW_TITLES = {
  dashboard: 'Dashboard', tickets: 'Tickets', createTicket: 'Create Ticket',
  recurring: 'Recurring Tickets', employees: 'Employees', eodAdmin: 'Team EOD Logs',
  reports: 'Reports', settings: 'Settings', today: "Today's Tasks",
  upcoming: 'Upcoming Tasks', completed: 'Completed Tickets',
  eod: 'EOD Work Log', history: 'My History'
};

function buildSidebar() {
  var nav = document.getElementById('sidebarNav');
  nav.innerHTML = NAV[state.user.role].map(function(item) {
    return '<button class="nav-item" data-view="' + item[0] + '" onclick="navigate(\'' + item[0] + '\')">' +
      '<span class="n-ico">' + icon(item[1]) + '</span>' + item[2] + '</button>';
  }).join('');
}

function navigate(view, arg) {
  state.view = view; state.viewArg = arg || null;
  document.querySelectorAll('.nav-item').forEach(function(b) {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.getElementById('viewTitle').textContent = VIEW_TITLES[view] || 'Stayopx Manager';
  toggleSidebar(false);
  renderView();
}

function refreshView() { renderView(); }

function toggleSidebar(open) {
  document.getElementById('sidebar').classList.toggle('open', !!open);
}

async function renderView(silent) {
  var c = document.getElementById('viewContainer');
  silent = silent === true;
  var oldCharts = [];
  if (silent) { oldCharts = state.charts; state.charts = []; }      // keep the page as it is until fresh data arrives
  else { destroyCharts(); c.innerHTML = skeletonFor(state.view); }
  c.classList.toggle('no-anim', silent);
  try {
    var v = state.view;
    if (v === 'dashboard') await (state.user.role === 'Admin' ? renderAdminDashboard(c, silent) : renderEmployeeDashboard(c, silent));
    else if (v === 'tickets') await renderTickets(c, state.viewArg || {});
    else if (v === 'today') await renderTickets(c, Object.assign({ preset: 'today' }, state.viewArg || {}));
    else if (v === 'upcoming') await renderTickets(c, Object.assign({ preset: 'upcoming' }, state.viewArg || {}));
    else if (v === 'completed') await renderTickets(c, Object.assign({ preset: 'completed' }, state.viewArg || {}));
    else if (v === 'history') await renderTickets(c, Object.assign({ preset: 'history' }, state.viewArg || {}));
    else if (v === 'createTicket') await renderCreateTicket(c);
    else if (v === 'recurring') await renderRecurring(c);
    else if (v === 'employees') await renderEmployees(c);
    else if (v === 'eod') await renderEmployeeEOD(c);
    else if (v === 'eodAdmin') await renderAdminEOD(c);
    else if (v === 'reports') await renderReports(c);
    else if (v === 'settings') await renderSettings(c);
    if (!silent) animateCounts(c);
  } catch (e) {
    if (!silent) c.innerHTML = errorState(e.message);
    else { state.charts = state.charts.concat(oldCharts); oldCharts = []; }   // failed quietly: leave the old page alone
  }
  oldCharts.forEach(function(ch) { try { ch.destroy(); } catch (e) {} });
}

/* the dashboard quietly refreshes itself every 5 minutes while it is open and visible */
var AUTO_REFRESH_MS = 5 * 60 * 1000;
setInterval(function() {
  if (!state.token || state.view !== 'dashboard' || document.hidden || _inflight > 0) return;
  if (!document.getElementById('modalBackdrop').classList.contains('hidden')) return;
  renderView(true);
}, AUTO_REFRESH_MS);

/* loading placeholders shaped like the page that is about to appear */
function skeletonFor(view) {
  var block = function(h) { return '<div class="sk" style="height:' + h + 'px"></div>'; };
  var many = function(n, h) { var s = ''; for (var i = 0; i < n; i++) s += block(h); return s; };
  if (view === 'dashboard') {
    return '<div class="sk-wrap" aria-busy="true" aria-label="Loading">' +
      block(128) + '<div class="two-col">' + many(2, 132) + '</div>' +
      '<div class="kpi-grid kpi-fit">' + many(state.user && state.user.role === 'Admin' ? 5 : 4, 92) + '</div>' +
      '<div class="dash-split">' + many(2, 250) + '</div></div>';
  }
  if (view === 'createTicket' || view === 'settings' || view === 'eod') {
    return '<div class="sk-wrap" aria-busy="true" aria-label="Loading">' + block(320) + '</div>';
  }
  return '<div class="sk-wrap" aria-busy="true" aria-label="Loading">' +
    '<div class="sk-row">' + many(4, 38) + '</div>' +
    '<div class="panel">' + many(6, 44).replace(/class="sk"/g, 'class="sk sk-line"') + '</div></div>';
}

/* numbers marked data-count tick up from zero once, when a page appears */
function animateCounts(root) {
  var els = root.querySelectorAll('[data-count]');
  if (!els.length) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var start = null, dur = 650;
  function frame(ts) {
    if (start === null) start = ts;
    var p = Math.min(1, (ts - start) / dur);
    var eased = 1 - Math.pow(1 - p, 3);
    els.forEach(function(el) {
      el.textContent = Math.round(Number(el.dataset.count) * eased) + (el.dataset.suffix || '');
    });
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function errorState(msg) {
  return '<div class="empty-state"><div class="e-ico e-warn">' + icon('alert', 24) + '</div><p>' + esc(msg) + '</p>' +
    '<button class="btn btn-ghost" style="margin-top:12px" onclick="renderView()">Try again</button></div>';
}

/* ============================================================
 * HELPERS
 * ============================================================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function initials(name) {
  return String(name || '?').split(/\s+/).map(function(w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
}
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(s) {
  if (!s) return '—';
  var ds = String(s).slice(0, 10).split('-');
  if (ds.length !== 3) return esc(s);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return Number(ds[2]) + ' ' + months[Number(ds[1]) - 1] + ' ' + ds[0];
}
function fmtTime(t) {
  if (!t) return '';
  var p = String(t).split(':');
  var h = Number(p[0]), m = p[1] || '00';
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(m).slice(0, 2) + ' ' + ap;
}
function userName(id) {
  var u = state.users.filter(function(x) { return x.id === id; })[0];
  if (u) return u.name;
  return state.user && id === state.user.id ? state.user.name : id;
}
function statusBadge(s) {
  var map = { 'Open': 'b-open', 'In Progress': 'b-progress', 'Completed': 'b-done', 'On Hold': 'b-hold', 'Overdue': 'b-late', 'Cancelled': 'b-cancel', 'Expired': 'b-cancel' };
  return '<span class="badge ' + (map[s] || 'b-neutral') + '">' + esc(s) + '</span>';
}
function priorityBadge(p) {
  var map = { 'Low': 'b-low', 'Medium': 'b-medium', 'High': 'b-high', 'Critical': 'b-critical' };
  return '<span class="badge ' + (map[p] || 'b-neutral') + '">' + esc(p) + '</span>';
}
function settingList(key, fallback) {
  return (state.settings[key] || fallback).split(',').map(function(s) { return s.trim(); });
}
function optionsHtml(list, selected) {
  return list.map(function(v) {
    return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>';
  }).join('');
}
function userOptions(selected) {
  return state.users.filter(function(u) { return u.status === 'Active'; }).map(function(u) {
    return '<option value="' + esc(u.id) + '"' + (u.id === selected ? ' selected' : '') + '>' + esc(u.name) + '</option>';
  }).join('');
}

/* toasts */
function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' t-error' : type === 'success' ? ' t-success' : '');
  el.innerHTML = icon(type === 'error' ? 'xcircle' : type === 'success' ? 'check' : 'info', 18) + '<span>' + esc(msg) + '</span>';
  document.getElementById('toastStack').appendChild(el);
  setTimeout(function() { el.remove(); }, 3800);
}

/* confirm dialog */
var _confirmResolver = null;
function confirmDialog(title, text, okLabel) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmText').textContent = text || '';
  document.getElementById('confirmOkBtn').textContent = okLabel || 'Confirm';
  document.getElementById('confirmBackdrop').classList.remove('hidden');
  return new Promise(function(res) { _confirmResolver = res; });
}
function resolveConfirm(v) {
  document.getElementById('confirmBackdrop').classList.add('hidden');
  if (_confirmResolver) _confirmResolver(v);
  _confirmResolver = null;
}

/* modal */
function openModal(html, large) {
  var box = document.getElementById('modalBox');
  box.className = 'modal' + (large ? ' modal-lg' : '');
  box.innerHTML = html;
  document.getElementById('modalBackdrop').classList.remove('hidden');
}
function closeModal() { document.getElementById('modalBackdrop').classList.add('hidden'); }

/* charts */
function destroyCharts() {
  state.charts.forEach(function(ch) { try { ch.destroy(); } catch (e) {} });
  state.charts = [];
}
function makeChart(canvasId, cfg) {
  var el = document.getElementById(canvasId);
  if (!el || typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Instrument Sans', system-ui, sans-serif";
  Chart.defaults.color = cssVar('--ink-2') || '#55606E';
  Chart.defaults.borderColor = cssVar('--line') || '#E3E7EC';
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false }, cfg.options || {});
  state.charts.push(new Chart(el, cfg));
}
var CHART_COLORS = ['#E53E3E', '#2458C5', '#A05A00', '#B42323', '#5B6472', '#7C4DB8', '#187A3C', '#C05299'];

/* ============================================================
 * NOTIFICATIONS (derived client-side from ticket + EOD data)
 * ============================================================ */
function computeNotifs(tickets, eodSubmitted) {
  var t = todayStr();
  var now = new Date();
  var notifs = [];
  (tickets || []).forEach(function(tk) {
    if (tk['Status'] === 'Overdue') {
      notifs.push({ id: 'ovd_' + tk['Ticket ID'], ico: 'alert', tone: 'late', text: tk['Ticket ID'] + ' "' + tk['Title'] + '" is overdue.' });
    } else if (tk['Scheduled Date'] === t && tk['Status'] !== 'Completed' && tk['Scheduled Time']) {
      var p = tk['Scheduled Time'].split(':');
      var due = new Date(); due.setHours(Number(p[0]) || 0, Number(p[1]) || 0, 0, 0);
      var mins = Math.round((due - now) / 60000);
      if (mins > 0 && mins <= 60) {
        notifs.push({ id: 'due_' + tk['Ticket ID'], ico: 'clock', tone: 'progress', text: tk['Ticket ID'] + ' "' + tk['Title'] + '" is due in ' + mins + ' min.' });
      }
    }
    if (tk['Status'] === 'Open' && String(tk['Created Date']).slice(0, 10) === t) {
      notifs.push({ id: 'new_' + tk['Ticket ID'], ico: 'ticket', tone: 'open', text: 'New ticket: ' + tk['Ticket ID'] + ' "' + tk['Title'] + '".' });
    }
  });
  if (state.user.role === 'Employee' && eodSubmitted === false && now.getHours() >= 17) {
    notifs.push({ id: 'eod_' + t, ico: 'note', tone: 'progress', text: "Your EOD work log for today hasn't been submitted yet." });
  }
  state.notifs = notifs;
  var unseen = notifs.some(function(n) { return !state.notifSeen[n.id]; });
  document.getElementById('notifDot').classList.toggle('hidden', !unseen);
}

function toggleNotifs() {
  var panel = document.getElementById('notifPanel');
  var opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (!opening) return;
  closeProfile();
  if (!state.notifs.length) {
    panel.innerHTML = '<div class="notif-empty"><div class="e-ico e-ok">' + icon('check', 22) + '</div>You\'re all caught up.</div>';
  } else {
    panel.innerHTML = state.notifs.map(function(n) {
      return '<div class="notif-item"><span class="n-ico chip chip-' + n.tone + '">' + icon(n.ico, 16) + '</span><span>' + esc(n.text) + '</span></div>';
    }).join('');
    state.notifs.forEach(function(n) { state.notifSeen[n.id] = 1; });
    localStorage.setItem('od_notif_seen', JSON.stringify(state.notifSeen));
    document.getElementById('notifDot').classList.add('hidden');
  }
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('.notif-wrap')) document.getElementById('notifPanel').classList.add('hidden');
  if (!e.target.closest('.profile-wrap')) closeProfile();
});
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  document.getElementById('notifPanel').classList.add('hidden');
  closeProfile();
});

/* ============================================================
 * DASHBOARD HELPERS
 * ============================================================ */
function goTickets(key, value) {
  var f = {}; f[key] = value;
  navigate('tickets', f);
}
function pctOf(part, whole) { return whole ? Math.round(part / whole * 100) : 0; }
function nowClock() {
  var d = new Date();
  return fmtTime(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'));
}
function isPendingStatus(s) { return s === 'Open' || s === 'In Progress' || s === 'On Hold'; }

/* days between a ticket's due date and today (0 = due today) */
function daysLate(tk) {
  var due = String(tk['Due Date'] || tk['Scheduled Date'] || '').slice(0, 10).split('-');
  if (due.length !== 3) return 0;
  var a = new Date(Number(due[0]), Number(due[1]) - 1, Number(due[2]));
  var n = new Date(); var b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
}
function lateLabel(tk) {
  var d = daysLate(tk);
  return d === 0 ? 'Due today' : d + (d === 1 ? ' day late' : ' days late');
}
function oldestFirst(a, b) {
  return String(a['Due Date'] || a['Scheduled Date']).localeCompare(String(b['Due Date'] || b['Scheduled Date']));
}

/* clickable KPI card — opens the ticket list already filtered */
function kpiCard(label, num, cls, sub, key, value, ico) {
  var n = parseFloat(num), suffix = String(num).indexOf('%') !== -1 ? '%' : '';
  return '<button class="kpi ' + cls + '" onclick="goTickets(\'' + key + '\',\'' + esc(value) + '\')">' +
    (ico ? '<span class="k-chip">' + icon(ico, 17) + '</span>' : '') +
    '<div class="k-num" data-count="' + n + '" data-suffix="' + suffix + '">' + num + '</div><div class="k-label">' + esc(label) + '</div>' +
    (sub ? '<div class="k-sub">' + esc(sub) + '</div>' : '') + '</button>';
}
/* progress ring with the percentage in the middle */
function progressRing(done, total) {
  var pct = pctOf(done, total), len = 2 * Math.PI * 26;
  return '<svg class="ring" viewBox="0 0 64 64" width="76" height="76" role="img" aria-label="' + pct + ' percent">' +
    '<circle class="ring-track" cx="32" cy="32" r="26"/>' +
    (pct ? '<circle class="ring-fill" cx="32" cy="32" r="26" stroke-dasharray="' + len.toFixed(1) + '" stroke-dashoffset="' +
      (len * (1 - pct / 100)).toFixed(1) + '" style="--ring-len:' + len.toFixed(1) + '"/>' : '') +
    '<text class="ring-text" x="32" y="37" text-anchor="middle">' + pct + '%</text></svg>';
}
function progressBar(done, total, small) {
  return '<div class="bar' + (small ? ' bar-sm' : '') + '"><span style="width:' + pctOf(done, total) + '%"></span></div>';
}

/* ============================================================
 * DASHBOARD BUILDING BLOCKS
 * ============================================================ */
function greeting() {
  var h = new Date().getHours();
  return (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', ' + String(state.user.name || '').split(/\s+/)[0];
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

/* minutes from now until a ticket's scheduled time today (negative = already past); null if it has no time */
function minutesUntil(tk) {
  var tm = String(tk['Scheduled Time'] || '');
  if (!/^\d{1,2}:\d{2}/.test(tm)) return null;
  var p = tm.split(':'), now = new Date();
  return (Number(p[0]) * 60 + Number(p[1])) - (now.getHours() * 60 + now.getMinutes());
}
function spanLabel(mins) {
  var m = Math.abs(mins);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}
function whenLabel(tk) {
  if (tk['Status'] === 'In Progress') return '<span class="when when-now">In progress</span>';
  var m = minutesUntil(tk);
  if (m === null) return '<span class="when">Any time today</span>';
  if (m >= 0) return '<span class="when' + (m <= 60 ? ' when-soon' : '') + '">in ' + spanLabel(m) + '</span>';
  return '<span class="when when-past">' + spanLabel(m) + ' ago</span>';
}
function byTimeToday(a, b) {
  return ((b['Status'] === 'In Progress') - (a['Status'] === 'In Progress')) ||
    (a['Scheduled Time'] || '99').localeCompare(b['Scheduled Time'] || '99');
}

/* the dark band at the top: greeting, one-line summary, quick actions */
function heroBand(summary, actions) {
  return '<section class="hero">' +
    '<div class="hero-main">' +
      '<p class="hero-eyebrow">' + eyebrowHtml() + '</p>' +
      '<h2>' + esc(greeting()) + '</h2>' +
      '<p class="hero-sum">' + summary + '</p>' +
    '</div>' +
    '<div class="hero-actions">' + actions + '</div>' +
  '</section>';
}
/* "Live · Tue, 22 Sep 2026 · updated 10:24 · loaded in 3.1 s (server 0.4 s, cached)" — the timing tells you where the
 * wait is: "server" is time inside the Google script (big = the Tickets tab is large); the rest is Google's own
 * overhead per request, which no code change can remove. */
function eyebrowHtml() {
  var d = new Date();
  var day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  var s = '<span class="live-dot" aria-hidden="true"></span>Live · ' + day + ', ' + fmtDate(todayStr()) + ' · updated ' + nowClock();
  if (state.dashPending) return s + ' · updating…';
  var c = state.lastCall;
  if (c && c.action === 'dashboard') {
    s += ' · loaded in ' + (c.total / 1000).toFixed(1) + ' s';
    if (c.server != null) s += ' (server ' + (c.server / 1000).toFixed(1) + ' s' + (c.cached ? ', cached' : '') + (c.version ? ', ' + esc(c.version) : '') + ')';
  }
  return s;
}
function eodActionBtn(submitted) {
  if (submitted === true) return '<button class="btn hero-btn" onclick="navigate(\'eod\')">' + icon('check', 16) + 'EOD submitted</button>';
  return '<button class="btn hero-btn" onclick="navigate(\'eod\')">' + icon('note', 16) + (submitted === false ? 'Submit my EOD' : 'My EOD log') + '</button>';
}
function isAfterFive() { return new Date().getHours() >= 17; }

/* ============================================================
 * VIEW — ADMIN DASHBOARD
 * Summary band · today rings · clickable KPIs · priority mix · overdue · team · coming up · 7-day trend
 * ============================================================ */
/* The dashboard is ONE request ('dashboard'). The reply holds only what the page shows:
 *   counts   — totals by status (over every ticket, computed on the server)
 *   tickets  — unfinished tickets + everything scheduled today (no descriptions, no old completed work)
 *   eod      — today's EOD status · weekSeries — last 7 days · users, settings — kept fresh for free
 * The last reply is kept for 5 minutes, so coming back to the dashboard paints instantly and then refreshes quietly. */
var DASH_CACHE_MS = 5 * 60 * 1000;

function dashCache() {
  var d = state.dash;
  if (!d) {                                                     // after a reload: the last dashboard is kept in the browser
    try { d = JSON.parse(localStorage.getItem('od_dash') || 'null'); } catch (e) { d = null; }
    if (d && d.data && d.data.today !== todayStr()) d = null;   // never paint another day's data as today
    state.dash = d;
  }
  if (!d || d.role !== state.user.role || d.userId !== state.user.id) return null;
  return (Date.now() - d.at) < DASH_CACHE_MS || !state.lastCall ? d.data : null;   // anything is fine as a first paint on reload
}
function applyDashData(d) {
  if (d.settings) {
    state.settings = d.settings;
    try { localStorage.setItem('od_settings', JSON.stringify(d.settings)); } catch (e) {}
  }
  if (d.users) state.users = d.users;
  state.tickets = d.tickets || [];
  state.dash = { role: state.user.role, userId: state.user.id, at: Date.now(), data: d };
  try {
    var packed = JSON.stringify(state.dash);
    if (packed.length < 2000000) localStorage.setItem('od_dash', packed);   // keep it for the next reload
  } catch (e) {}
}
async function loadDashboard(c, silent, paint) {
  var cachedData = silent ? null : dashCache();
  if (cachedData) { state.dashPending = true; paint(c, cachedData); }   // instant paint from the last load
  var d;
  try { d = await api('dashboard'); }
  finally { state.dashPending = false; }
  var unchanged = cachedData && JSON.stringify(d) === JSON.stringify(cachedData);
  applyDashData(d);
  if (!unchanged) paint(c, d);
  else { var eb = c.querySelector('.hero-eyebrow'); if (eb) eb.innerHTML = eyebrowHtml(); }   // just refresh the timing line
}
async function renderAdminDashboard(c, silent) { await loadDashboard(c, silent, paintAdminDashboard); }
async function renderEmployeeDashboard(c, silent) { await loadDashboard(c, silent, paintEmployeeDashboard); }

function needsNewBackend(d) {
  if (d && d.overdue && d.counts) return;
  throw new Error('The backend is running an older version than this page. Paste the new Code.gs into Apps Script and deploy a New version.');
}

function paintAdminDashboard(c, d) {
  destroyCharts();
  needsNewBackend(d);
  var k = d.counts, e = d.eod, ov = d.overdue, cu = d.comingUp, ts = d.todayStats;
  var t = d.today || todayStr();
  var overdueTop = ov.top || [];
  computeNotifs(overdueTop);
  var completed = k.completed;

  /* --- EOD today --- */
  var eodTotal = e.submitted + e.pending.length;
  var waiting = e.pending.slice(0, 8).map(esc).join(', ') +
    (e.pending.length > 8 ? ' +' + (e.pending.length - 8) + ' more' : '');

  /* --- one-line summary --- */
  var bits = [];
  bits.push(ov.count ? '<strong>' + plural(ov.count, 'ticket is', 'tickets are') + ' overdue</strong>' +
    (ov.urgent ? ' (' + ov.urgent + ' high or critical)' : '') : 'Nothing is overdue');
  bits.push(ts.total ? ts.done + ' of ' + ts.total + ' scheduled today ' + (ts.done === 1 && ts.total === 1 ? 'is' : 'are') + ' done' : 'nothing is scheduled today');
  if (isAfterFive() && e.pending.length) bits.push(plural(e.pending.length, 'EOD log is', 'EOD logs are') + ' still pending');
  var summary = bits.join(' · ') + '.';

  /* --- active work by priority (counted on the server) --- */
  var prios = [['Critical', 'late'], ['High', 'progress'], ['Medium', 'open'], ['Low', 'hold']].map(function(p) {
    return { name: p[0], tone: p[1], n: (d.prio && d.prio[p[0]]) || 0 };
  });
  var teamRows = d.team || [];

  c.innerHTML =
    heroBand(summary,
      '<button class="btn btn-primary" onclick="navigate(\'createTicket\')">' + icon('plus', 16) + 'New ticket</button>' +
      eodActionBtn(e.submittedToday)) +

    /* today strip */
    '<div class="two-col">' +
      '<div class="panel"><div class="panel-head"><h3>Today\'s tickets</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="goTickets(\'date\',\'' + t + '\')">View today</button></div>' +
        '<div class="ring-row">' + progressRing(ts.done, ts.total) + '<div>' +
        '<div class="progress-num"><span data-count="' + ts.done + '">' + ts.done + '</span> <small>of ' + ts.total + ' done</small></div>' +
        '<p class="muted small">' + (ts.total ? (ts.total - ts.done) + ' still to finish today.' : 'Nothing is scheduled for today.') + '</p></div></div></div>' +

      '<div class="panel"><div class="panel-head"><h3>EOD logs today</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigate(\'eodAdmin\')">View logs</button></div>' +
        '<div class="ring-row">' + progressRing(e.submitted, eodTotal) + '<div>' +
        '<div class="progress-num"><span data-count="' + e.submitted + '">' + e.submitted + '</span> <small>of ' + eodTotal + ' submitted</small></div>' +
        '<p class="muted small">' + (e.pending.length ? 'Waiting on: ' + waiting : 'Everyone has submitted.') + '</p></div></div></div>' +
    '</div>' +

    /* KPIs — click any card to open that list */
    '<div class="kpi-grid kpi-fit">' +
      kpiCard('Overdue', ov.count, 'k-late k-accent', ov.urgent ? ov.urgent + ' high or critical' : '', 'status', 'Overdue', 'alert') +
      kpiCard('Open', k.open, 'k-open', 'Not started', 'status', 'Open', 'dot') +
      kpiCard('In progress', k.inProgress, 'k-progress', '', 'status', 'In Progress', 'activity') +
      kpiCard('On hold', k.onHold, 'k-hold', '', 'status', 'On Hold', 'pause') +
      kpiCard('Completion rate', pctOf(completed, k.total) + '%', 'k-done', completed + ' of ' + k.total + ' tickets', 'status', 'Completed', 'target') +
    '</div>' +

    /* priority mix of everything still active */
    (d.active ?
      '<div class="panel prio-panel"><div class="prio-head"><h3>Active work by priority</h3><span class="muted small">' + plural(d.active, 'ticket', 'tickets') + ' not finished yet</span></div>' +
      '<div class="prio-bar" role="img" aria-label="Priority mix">' + prios.map(function(p) {
        return p.n ? '<span class="tone-' + p.tone + '" style="flex:' + p.n + '" title="' + p.name + ': ' + p.n + '"></span>' : '';
      }).join('') + '</div>' +
      '<div class="prio-legend">' + prios.map(function(p) {
        return '<span><i class="tone-' + p.tone + '"></i>' + p.name + ' <strong>' + p.n + '</strong></span>';
      }).join('') + '</div></div>' : '') +

    '<div class="dash-split">' +
      /* overdue list */
      '<div class="panel"><div class="panel-head"><h3>Overdue tickets</h3>' +
        (ov.count > overdueTop.length ? '<button class="btn btn-ghost btn-sm" onclick="goTickets(\'status\',\'Overdue\')">View all ' + ov.count + '</button>' :
          '<span class="muted small">Oldest first</span>') + '</div>' +
        (overdueTop.length ?
          '<div class="table-wrap scroll-y"><table class="compact"><tbody>' + overdueTop.map(function(x) {
            return '<tr class="clickable" onclick="openTicket(\'' + esc(x['Ticket ID']) + '\')">' +
              '<td><div class="t-title">' + esc(x['Title']) + '</div><div class="t-sub"><span class="mono">' + esc(x['Ticket ID']) + '</span> · ' + esc(userName(x['Assigned To'])) + '</div></td>' +
              '<td>' + priorityBadge(x['Priority']) + '</td>' +
              '<td class="small num-late" style="white-space:nowrap">' + lateLabel(x) + '</td></tr>';
          }).join('') + '</tbody></table></div>' :
          '<div class="empty-state" style="padding:28px 20px"><div class="e-ico e-ok">' + icon('check', 24) + '</div><p>No overdue tickets right now.</p></div>') +
      '</div>' +

      /* team workload */
      '<div class="panel"><div class="panel-head"><h3>Team workload</h3><span class="muted small">Click a name to see their tickets</span></div>' +
        (teamRows.length ?
          '<div class="table-wrap scroll-y"><table class="compact"><thead><tr><th>Employee</th><th>Today</th><th>Pending</th><th>Overdue</th><th>EOD</th></tr></thead><tbody>' +
          teamRows.map(function(m) {
            var eod = !m.isEmp ? '<span class="muted small">—</span>' :
              (e.pending.indexOf(m.name) === -1 ? '<span class="badge b-done">Submitted</span>' : '<span class="badge b-progress">Pending</span>');
            return '<tr class="clickable" onclick="goTickets(\'employee\',\'' + esc(m.id) + '\')">' +
              '<td class="t-title">' + esc(m.name) + '</td>' +
              '<td class="small mono">' + (m.today ? m.todayDone + '/' + m.today + progressBar(m.todayDone, m.today, true) : '<span class="muted">—</span>') + '</td>' +
              '<td class="mono">' + (m.pending || '<span class="num-zero">0</span>') + '</td>' +
              '<td class="mono">' + (m.overdue ? '<span class="num-late">' + m.overdue + '</span>' : '<span class="num-zero">0</span>') + '</td>' +
              '<td>' + eod + '</td></tr>';
          }).join('') + '</tbody></table></div>' :
          '<div class="empty-state" style="padding:28px 20px"><div class="e-ico">' + icon('users', 24) + '</div><p>Add team members under Employees to see their workload here.</p></div>') +
      '</div>' +
    '</div>' +

    '<div class="dash-split dash-split-rev">' +
      /* coming up today */
      '<div class="panel"><div class="panel-head"><h3>Coming up today</h3>' +
        (cu.count > cu.top.length ? '<button class="btn btn-ghost btn-sm" onclick="goTickets(\'date\',\'' + t + '\')">View all ' + cu.count + '</button>' :
          '<span class="muted small">By scheduled time</span>') + '</div>' +
        (cu.top.length ?
          '<div class="upnext-list">' + cu.top.map(function(x) {
            return '<button class="upnext" onclick="openTicket(\'' + esc(x['Ticket ID']) + '\')">' +
              '<span class="upnext-time mono">' + (x['Scheduled Time'] ? fmtTime(x['Scheduled Time']) : '—') + '</span>' +
              '<span class="upnext-body"><span class="t-title">' + esc(x['Title']) + '</span><span class="t-sub">' + esc(userName(x['Assigned To'])) + '</span></span>' +
              whenLabel(x) + '</button>';
          }).join('') + '</div>' :
          '<div class="empty-state" style="padding:28px 20px"><div class="e-ico e-ok">' + icon('check', 24) + '</div><p>' +
            (ts.total ? 'Everything scheduled for today is done.' : 'Nothing is scheduled for today.') + '</p></div>') +
      '</div>' +

      '<div class="panel"><div class="panel-head"><h3>Last 7 days</h3><span class="muted small">How much of each day\'s scheduled work got done</span></div>' +
        '<div class="chart-box" style="height:250px"><canvas id="chWeek"></canvas></div></div>' +
    '</div>';

  makeChart('chWeek', {
    type: 'bar',
    data: {
      labels: (d.weekSeries || []).map(function(w) { return w.date; }),
      datasets: [
        { label: 'Completed', data: (d.weekSeries || []).map(function(w) { return w.completed; }), backgroundColor: cssVar('--done'), maxBarThickness: 40, borderRadius: 4 },
        { label: 'Not completed', data: (d.weekSeries || []).map(function(w) { return w.total - w.completed; }), backgroundColor: cssVar('--bar-rest'), maxBarThickness: 40, borderRadius: 4 }
      ]
    },
    options: {
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

/* ============================================================
 * VIEW — EMPLOYEE DASHBOARD
 * Summary band · today ring + next up · clickable KPIs · carried-over work · today's tasks
 * ============================================================ */
function paintEmployeeDashboard(c, d) {
  destroyCharts();
  needsNewBackend(d);
  var k = d.counts, e = d.eod, ts = d.todayStats;
  var t = d.today || todayStr();
  var todays = d.todays || [];                                  // sorted by time on the server
  var carried = (d.carried && d.carried.top) || [];             // overdue first, then oldest
  var carriedCount = d.carried ? d.carried.count : carried.length;
  computeNotifs(todays.concat(carried), e.submittedToday);

  var todayDone = ts.done;
  var left = ts.total - todayDone;

  /* what to do next: whatever is in progress, else the earliest unfinished task today, else the oldest carried-over one */
  var queue = todays.filter(function(x) { return x['Status'] !== 'Completed'; }).sort(byTimeToday);
  var next = queue[0] || carried[0] || null;
  var nextIsToday = !!queue[0];

  var cutoff = fmtTime(state.settings.EOD_CUTOFF || '23:00');
  var bits = [];
  bits.push(ts.total ? (left ? '<strong>' + plural(left, 'task', 'tasks') + ' left today</strong>' : '<strong>All of today\'s tasks are done</strong>') : 'Nothing is scheduled for you today');
  if (carriedCount) bits.push(plural(carriedCount, 'task', 'tasks') + ' carried over from earlier days');
  if (!e.submittedToday && isAfterFive()) bits.push('your EOD log is due by ' + cutoff);
  var summary = bits.join(' · ') + '.';

  c.innerHTML =
    heroBand(summary,
      '<button class="btn btn-primary" onclick="navigate(\'createTicket\')">' + icon('plus', 16) + 'New ticket</button>' +
      eodActionBtn(!!e.submittedToday)) +

    '<div class="two-col">' +
      '<div class="panel"><div class="panel-head"><h3>Today\'s tasks</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigate(\'today\')">View today</button></div>' +
        '<div class="ring-row">' + progressRing(todayDone, ts.total) + '<div>' +
        '<div class="progress-num"><span data-count="' + todayDone + '">' + todayDone + '</span> <small>of ' + ts.total + ' done</small></div>' +
        '<p class="muted small">' + (ts.total ? (left ? left + ' still to finish today.' : 'All of today\'s tasks are done.') : 'Nothing is scheduled for you today.') + '</p></div></div></div>' +

      '<div class="panel next-up">' +
        (next ?
          '<div class="panel-head"><h3>Next up</h3>' + (nextIsToday ? whenLabel(next) : '<span class="when when-past">' + lateLabel(next) + '</span>') + '</div>' +
          '<button class="next-title" onclick="openTicket(\'' + esc(next['Ticket ID']) + '\')">' + esc(next['Title']) + '</button>' +
          '<p class="t-sub"><span class="mono">' + esc(next['Ticket ID']) + '</span> · ' +
            fmtDate(next['Scheduled Date']) + (next['Scheduled Time'] ? ' · ' + fmtTime(next['Scheduled Time']) : '') + '</p>' +
          '<div class="next-actions">' + priorityBadge(next['Priority']) + statusBadge(next['Status']) +
            '<span class="next-btn">' + quickActionBtn(next) + '</span></div>'
          :
          '<div class="panel-head"><h3>Next up</h3></div>' +
          '<div class="ring-row"><span class="chip chip-xl chip-done">' + icon('check', 30) + '</span><div>' +
          '<div class="progress-num" style="font-size:1.2rem">You\'re clear</div>' +
          '<p class="muted small">Working on something that isn\'t listed? Add it as a ticket so it counts.</p></div></div>') +
      '</div>' +
    '</div>' +

    '<div class="kpi-grid kpi-fit">' +
      kpiCard('Overdue', k.overdue, 'k-late k-accent', '', 'status', 'Overdue', 'alert') +
      kpiCard('Open', k.open, 'k-open', 'Not started', 'status', 'Open', 'dot') +
      kpiCard('In progress', k.inProgress, 'k-progress', '', 'status', 'In Progress', 'activity') +
      kpiCard('Completed', k.completed, 'k-done', 'of ' + k.total + ' assigned', 'status', 'Completed', 'check') +
    '</div>' +

    (carried.length ?
      '<div class="panel" style="border-left:3px solid var(--late)"><div class="panel-head"><h3>Finish these first</h3>' +
      '<span class="muted small">Carried over from earlier days' +
      (carriedCount > carried.length ? ' · showing the ' + carried.length + ' oldest of ' + carriedCount : '') + '</span></div>' + ticketsTable(carried, true) +
      (carriedCount > carried.length ? '<div style="text-align:center;padding:12px 0 4px"><button class="btn btn-ghost btn-sm" onclick="goTickets(\'status\',\'Overdue\')">View all overdue</button></div>' : '') +
      '</div>' : '') +

    '<div class="panel"><div class="panel-head"><h3>Today\'s tasks</h3><span class="muted small">' + fmtDate(t) + '</span></div>' +
    ticketsTable(todays, true) +
    (ts.total > todays.length ? '<p class="muted small" style="margin-top:10px">Showing ' + todays.length + ' of ' + ts.total + '. <button type="button" class="link-btn" onclick="navigate(\'today\')">View all</button></p>' : '') +
    '</div>';
}

/* ============================================================
 * VIEW — TICKETS (shared list w/ search + filters)
 * ============================================================ */
/* The list loads every unfinished ticket plus anything scheduled in the last TICKET_WINDOW_DAYS days.
 * "Show older tickets" loads everything. Long lists are shown TICKET_PAGE rows at a time. */
var TICKET_WINDOW_DAYS = 45;
var TICKET_PAGE = 150;

async function renderTickets(c, opts) {
  var o = opts || {};
  var isAdmin = state.user.role === 'Admin';
  var req = o.all ? { all: true } : { days: TICKET_WINDOW_DAYS };
  var wait = [api('listTickets', req)];
  if (isAdmin && !state.users.length) wait.push(api('listUsers').catch(function() { return []; }));
  var got = await Promise.all(wait);
  state.tickets = got[0];
  if (got[1] && got[1].length) state.users = got[1];
  state._ticketsAll = !!o.all;
  state._ticketLimit = TICKET_PAGE;
  computeNotifs(state.tickets);

  var statuses = settingList('STATUSES', 'Open,In Progress,Completed,On Hold,Overdue');
  var priorities = settingList('PRIORITIES', 'Low,Medium,High,Critical');
  var depts = settingList('DEPARTMENTS', 'Operations');
  var types = settingList('FREQUENCIES', 'One-Time,Daily,Weekly,Monthly');

  c.innerHTML =
    '<div class="filter-bar">' +
      '<input type="search" id="fSearch" placeholder="Search ID, title, description' + (isAdmin ? ', employee' : '') + '…" oninput="applyFilters()">' +
      '<select id="fStatus" onchange="applyFilters()"><option value="">Status: All</option>' + optionsHtml(statuses) + '</select>' +
      '<select id="fPriority" onchange="applyFilters()"><option value="">Priority: All</option>' + optionsHtml(priorities) + '</select>' +
      '<select id="fType" onchange="applyFilters()"><option value="">Type: All</option>' + optionsHtml(types) + '</select>' +
      (isAdmin ? '<select id="fEmployee" onchange="applyFilters()"><option value="">Employee: All</option>' + userOptions() + '</select>' : '') +
      (isAdmin ? '<select id="fDept" onchange="applyFilters()"><option value="">Dept: All</option>' + optionsHtml(depts) + '</select>' : '') +
      '<input type="date" id="fDate" onchange="applyFilters()" title="Scheduled date">' +
      (isAdmin ? '<button class="btn btn-primary" onclick="navigate(\'createTicket\')">+ New ticket</button>' : '') +
    '</div>' +
    '<div class="panel"><div id="ticketListBox"></div>' +
    '<p class="muted small" style="margin-top:12px">' + (state._ticketsAll ? 'Showing all tickets.' :
      'Showing unfinished tickets and everything scheduled in the last ' + TICKET_WINDOW_DAYS + ' days. ' +
      '<button type="button" class="link-btn" onclick="loadAllTickets()">Show older tickets</button>') + '</p></div>';

  // presets for employee sub-views
  var preset = opts && opts.preset;
  if (preset === 'today') document.getElementById('fDate').value = todayStr();
  if (preset === 'completed') document.getElementById('fStatus').value = 'Completed';
  state._preset = preset || '';

  // filters passed in from a dashboard card or team row
  var o = opts || {};
  presetSelect('fStatus', o.status);
  presetSelect('fPriority', o.priority);
  presetSelect('fEmployee', o.employee, o.employee ? userName(o.employee) : '');
  if (o.date) document.getElementById('fDate').value = o.date;
  applyFilters();
}

/* set a filter dropdown, adding the option first if the list doesn't have it */
function presetSelect(id, value, label) {
  var el = document.getElementById(id);
  if (!el || !value) return;
  var has = Array.prototype.some.call(el.options, function(op) { return op.value === value; });
  if (!has) {
    var op = document.createElement('option');
    op.value = value; op.textContent = label || value;
    el.appendChild(op);
  }
  el.value = value;
}

function applyFilters() {
  var q = (document.getElementById('fSearch') || {}).value || '';
  q = q.toLowerCase();
  var st = (document.getElementById('fStatus') || {}).value || '';
  var pr = (document.getElementById('fPriority') || {}).value || '';
  var ty = (document.getElementById('fType') || {}).value || '';
  var em = (document.getElementById('fEmployee') || {}).value || '';
  var dp = (document.getElementById('fDept') || {}).value || '';
  var dt = (document.getElementById('fDate') || {}).value || '';
  var t = todayStr();

  var list = state.tickets.filter(function(x) {
    if (state._preset === 'upcoming' && !(x['Scheduled Date'] > t && x['Status'] !== 'Completed' && x['Status'] !== 'Cancelled')) return false;
    if (st && x['Status'] !== st) return false;
    if (pr && x['Priority'] !== pr) return false;
    if (ty && x['Ticket Type'] !== ty) return false;
    if (em && x['Assigned To'] !== em) return false;
    if (dp && x['Department'] !== dp) return false;
    if (dt && x['Scheduled Date'] !== dt) return false;
    if (q) {
      var hay = (x['Ticket ID'] + ' ' + x['Title'] + ' ' + x['Description'] + ' ' + userName(x['Assigned To'])).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  var limit = state._ticketLimit || TICKET_PAGE;
  document.getElementById('ticketListBox').innerHTML = ticketsTable(list.slice(0, limit), state.user.role !== 'Admin') +
    (list.length > limit ?
      '<div style="text-align:center;padding:14px 0 4px"><button class="btn btn-ghost btn-sm" onclick="moreTickets()">Show ' +
      Math.min(TICKET_PAGE, list.length - limit) + ' more (' + (list.length - limit) + ' remaining)</button></div>' : '');
}
function moreTickets() {
  state._ticketLimit = (state._ticketLimit || TICKET_PAGE) + TICKET_PAGE;
  applyFilters();
}
function loadAllTickets() {
  state.viewArg = Object.assign({}, state.viewArg || {}, { all: true });
  renderView();
}

function ticketsTable(list, quickActions) {
  if (!list.length) {
    return '<div class="empty-state"><div class="e-ico">' + icon('folder', 24) + '</div><p>No tickets here yet.</p></div>';
  }
  var isAdmin = state.user.role === 'Admin';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>Ticket</th>' + (isAdmin ? '<th>Assigned to</th>' : '') +
    '<th>Priority</th><th>Scheduled</th><th>Status</th><th>Action</th>' +
    '</tr></thead><tbody>' +
    list.map(function(x) {
      var sched = fmtDate(x['Scheduled Date']) + (x['Scheduled Time'] ? ' · ' + fmtTime(x['Scheduled Time']) : '');
      return '<tr class="clickable" onclick="openTicket(\'' + x['Ticket ID'] + '\')">' +
        '<td><div class="t-title">' + esc(x['Title']) + '</div><div class="t-sub"><span class="mono">' + esc(x['Ticket ID']) +
          '</span> · ' + esc(x['Ticket Type']) + (x['Created By'] && x['Created By'] === x['Assigned To'] ? ' · <span class="tag-self">Self-created</span>' : '') + '</div></td>' +
        (isAdmin ? '<td>' + esc(userName(x['Assigned To'])) + '</td>' : '') +
        '<td>' + priorityBadge(x['Priority']) + '</td>' +
        '<td class="small">' + sched + '</td>' +
        '<td>' + statusBadge(x['Status']) + '</td>' +
        '<td onclick="event.stopPropagation()">' + quickActionBtn(x) + '</td>' +
        '</tr>';
    }).join('') + '</tbody></table></div>';
}

function quickActionBtn(x) {
  var s = x['Status'];
  if (s === 'Open' || s === 'Overdue' || s === 'On Hold') {
    return '<button class="btn btn-ghost btn-sm" onclick="quickStatus(\'' + x['Ticket ID'] + '\',\'In Progress\')">Start</button>';
  }
  if (s === 'In Progress') {
    return '<button class="btn btn-primary btn-sm" onclick="quickStatus(\'' + x['Ticket ID'] + '\',\'Completed\')">Complete</button>';
  }
  return '<span class="muted small">—</span>';
}

async function quickStatus(id, status) {
  try {
    await api('updateStatus', { id: id, status: status });
    toast('Ticket ' + id + ' marked ' + status + '.', 'success');
    renderView();
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================================================
 * TICKET DETAIL MODAL
 * ============================================================ */
async function openTicket(id) {
  openModal('<div class="skeleton tall"></div><div class="skeleton"></div>', true);
  try {
    var data = await api('getTicket', { id: id });
    renderTicketModal(data.ticket, data.activity);
  } catch (e) {
    openModal('<p>' + esc(e.message) + '</p><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>');
  }
}

function renderTicketModal(t, activity) {
  var isAdmin = state.user.role === 'Admin';
  var statuses = settingList('STATUSES', 'Open,In Progress,Completed,On Hold,Overdue');
  var canAct = t['Status'] !== 'Cancelled';

  var timeline = activity.length ?
    '<div class="timeline">' + activity.map(function(a) {
      var change = a['Previous Status'] !== a['New Status'] && a['New Status'] ?
        '<strong>' + esc(a['Previous Status'] || 'New') + ' → ' + esc(a['New Status']) + '</strong> · ' : '';
      return '<div class="tl-item"><div class="tl-time">' + fmtDate(a['Date']) + ' · ' + esc(String(a['Time']).slice(0, 5)) +
        ' — ' + esc(a['User']) + '</div><div class="tl-body">' + change + esc(a['Comment']) + '</div></div>';
    }).join('') + '</div>' :
    '<p class="muted small">No activity yet.</p>';

  openModal(
    '<div class="modal-head"><div><h3>' + esc(t['Title']) + '</h3>' +
    '<p class="muted small"><span class="mono">' + esc(t['Ticket ID']) + '</span>' +
    (t['Parent Ticket ID'] ? ' · from <span class="mono">' + esc(t['Parent Ticket ID']) + '</span>' : '') +
    (t['Created By'] && t['Created By'] === t['Assigned To'] ? ' · <span class="tag-self">Self-created</span>' : '') + '</p></div>' +
    '<button class="icon-btn" onclick="closeModal()" aria-label="Close">&times;</button></div>' +

    statusBadge(t['Status']) + ' ' + priorityBadge(t['Priority']) +

    '<div class="detail-grid">' +
      dItem('Assigned to', userName(t['Assigned To'])) +
      dItem('Created by', userName(t['Created By'])) +
      dItem('Department', t['Department'] || '—') +
      dItem('Type', t['Ticket Type']) +
      dItem('Scheduled', fmtDate(t['Scheduled Date']) + (t['Scheduled Time'] ? ' · ' + fmtTime(t['Scheduled Time']) : '')) +
      dItem('Due date', fmtDate(t['Due Date'])) +
      dItem('Created', fmtDate(t['Created Date'])) +
      dItem('Completed', t['Completed Date'] ? fmtDate(t['Completed Date']) : '—') +
    '</div>' +

    (t['Description'] ? '<p class="small" style="white-space:pre-wrap;margin-bottom:14px">' + esc(t['Description']) + '</p>' : '') +

    (canAct ?
      '<div class="panel" style="margin-bottom:14px"><div class="form-grid">' +
      '<label class="field">Update status<select id="tStatus">' + optionsHtml(statuses, t['Status']) + '</select></label>' +
      '<label class="field span-2">Add a comment / update<textarea id="tComment" placeholder="e.g., Report prepared and shared with the concerned team."></textarea></label>' +
      '</div><div class="modal-actions">' +
      (isAdmin || (t['Created By'] === state.user.id && t['Assigned To'] === state.user.id && t['Status'] !== 'Completed') ?
        '<button class="btn btn-danger" onclick="cancelTicketUI(\'' + t['Ticket ID'] + '\')">Cancel ticket</button>' : '') +
      (isAdmin ? '<button class="btn btn-ghost" onclick="editTicketUI(\'' + t['Ticket ID'] + '\')">Edit details</button>' : '') +
      '<button class="btn btn-primary" onclick="saveTicketUpdate(\'' + t['Ticket ID'] + '\',\'' + esc(t['Status']) + '\')">Save update</button>' +
      '</div></div>' : '') +

    '<h4 style="margin-bottom:6px">Activity timeline</h4>' + timeline,
    true
  );
}

function dItem(label, value) {
  return '<div class="d-item"><span>' + label + '</span><strong>' + esc(value) + '</strong></div>';
}

async function saveTicketUpdate(id, oldStatus) {
  var status = document.getElementById('tStatus').value;
  var comment = document.getElementById('tComment').value.trim();
  try {
    if (status !== oldStatus) {
      await api('updateStatus', { id: id, status: status, comment: comment || undefined });
      toast('Status updated to ' + status + '.', 'success');
    } else if (comment) {
      await api('addComment', { id: id, comment: comment });
      toast('Comment added.', 'success');
    } else {
      toast('Nothing to save — change the status or write a comment.');
      return;
    }
    closeModal(); renderView();
  } catch (e) { toast(e.message, 'error'); }
}

async function cancelTicketUI(id) {
  var ok = await confirmDialog('Cancel this ticket?', 'The ticket will be marked Cancelled. This is recorded in the activity log.', 'Cancel ticket');
  if (!ok) return;
  try {
    await api('cancelTicket', { id: id });
    toast('Ticket cancelled.', 'success');
    closeModal(); renderView();
  } catch (e) { toast(e.message, 'error'); }
}

function editTicketUI(id) {
  var t = state.tickets.filter(function(x) { return x['Ticket ID'] === id; })[0];
  if (!t) { toast('Reopen the ticket list and try again.'); return; }
  openModal(ticketFormHtml(t), true);
}

/* ============================================================
 * VIEW — CREATE TICKET (Admin)
 * ============================================================ */
function renderCreateTicket(c) {
  if (state.user.role !== 'Admin') {          // employees don't need (and can't load) the user list
    c.innerHTML = '<div class="panel" style="max-width:760px">' + ticketFormHtml(null) + '</div>';
    return;
  }
  loadUsersThen(function() {
    c.innerHTML = '<div class="panel" style="max-width:760px">' + ticketFormHtml(null) + '</div>';
  }, c);
}

function loadUsersThen(fn, c) {
  if (state.users.length) return fn();
  api('listUsers').then(function(u) { state.users = u; fn(); })
    .catch(function(e) { if (c) c.innerHTML = errorState(e.message); });
}

function ticketFormHtml(t) {
  var edit = !!t;
  t = t || {};
  var priorities = settingList('PRIORITIES', 'Low,Medium,High,Critical');
  var depts = settingList('DEPARTMENTS', 'Operations');
  return (edit ? '<div class="modal-head"><h3>Edit ' + esc(t['Ticket ID']) + '</h3>' +
      '<button class="icon-btn" onclick="closeModal()" aria-label="Close">&times;</button></div>'
    : (state.user.role === 'Admin' ?
        '<div class="panel-head"><h3>Create a ticket</h3><p class="muted small">One-time tasks. For repeating tasks, use Recurring Tickets.</p></div>' :
        '<div class="panel-head"><h3>Create a ticket for yourself</h3><p class="muted small">For work you picked up that nobody assigned. It is assigned to you and your manager can see it.</p></div>')) +
    '<div class="form-grid">' +
    '<label class="field span-2">Title<input id="cTitle" value="' + esc(t['Title'] || '') + '" placeholder="e.g., Prepare monthly electricity report"></label>' +
    '<label class="field span-2">Description<textarea id="cDesc" placeholder="What needs to be done, and any context.">' + esc(t['Description'] || '') + '</textarea></label>' +
    (state.user.role === 'Admin' ?
      '<label class="field">Assign to<select id="cAssign">' + userOptions(t['Assigned To']) + '</select></label>' :
      '<label class="field">Assigned to<input value="' + esc(state.user.name) + ' (you)" readonly></label>') +
    '<label class="field">Department<select id="cDept">' + optionsHtml(depts, t['Department'] || (edit ? '' : state.user.department)) + '</select></label>' +
    '<label class="field">Priority<select id="cPriority">' + optionsHtml(priorities, t['Priority'] || 'Medium') + '</select></label>' +
    '<label class="field">Scheduled date<input type="date" id="cSchedDate" value="' + esc(t['Scheduled Date'] || todayStr()) + '"></label>' +
    '<label class="field">Scheduled time<input type="time" id="cSchedTime" value="' + esc(t['Scheduled Time'] || '') + '"></label>' +
    '<label class="field">Due date<input type="date" id="cDueDate" value="' + esc(t['Due Date'] || '') + '"></label>' +
    '</div>' +
    '<div class="modal-actions">' +
    (edit ? '<button class="btn btn-ghost" onclick="closeModal()">Discard</button>' : '') +
    '<button class="btn btn-primary" id="cSaveBtn" onclick="saveTicketForm(' + (edit ? '\'' + t['Ticket ID'] + '\'' : 'null') + ')">' +
    (edit ? 'Save changes' : 'Create ticket') + '</button></div>';
}

async function saveTicketForm(editId) {
  var btn = document.getElementById('cSaveBtn');
  var p = {
    title: document.getElementById('cTitle').value.trim(),
    description: document.getElementById('cDesc').value.trim(),
    assignedTo: (document.getElementById('cAssign') || {}).value || state.user.id,
    department: document.getElementById('cDept').value,
    priority: document.getElementById('cPriority').value,
    scheduledDate: document.getElementById('cSchedDate').value,
    scheduledTime: document.getElementById('cSchedTime').value,
    dueDate: document.getElementById('cDueDate').value
  };
  if (!p.title) { toast('Add a title for the ticket.', 'error'); return; }
  if (!p.scheduledDate) { toast('Pick a scheduled date.', 'error'); return; }
  if (p.dueDate && p.dueDate < p.scheduledDate) { toast('The due date cannot be before the scheduled date.', 'error'); return; }
  setBusy(btn, true);
  try {
    if (editId) {
      p.id = editId;
      await api('updateTicket', p);
      toast('Ticket updated.', 'success');
      closeModal(); renderView();
    } else {
      var out = await api('createTicket', p);
      toast(state.user.role === 'Admin' ? 'Ticket ' + out.id + ' created and assigned.' : 'Ticket ' + out.id + ' added to your list.', 'success');
      navigate('tickets');
    }
  } catch (e) { toast(e.code === 'FORBIDDEN' ? 'Creating your own tickets is not switched on yet. Ask your admin to deploy the latest Code.gs.' : e.message, 'error'); }
  finally { setBusy(btn, false); }
}

/* ============================================================
 * VIEW — RECURRING TICKETS (Admin)
 * ============================================================ */
async function renderRecurring(c) {
  var results = await Promise.all([api('listRecurring'), state.users.length ? Promise.resolve(state.users) : api('listUsers')]);
  var list = results[0];
  state.users = results[1];

  c.innerHTML =
    '<div class="filter-bar"><p class="muted small" style="flex:1">Templates that automatically generate tickets on schedule. Instances appear under All Tickets with their parent ID.</p>' +
    '<button class="btn btn-primary" onclick="openRecurringForm()">+ New recurring ticket</button></div>' +
    '<div class="panel">' +
    (list.length ?
      '<div class="table-wrap"><table><thead><tr><th>Template</th><th>Assigned to</th><th>Schedule</th><th>Window</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      list.map(function(r) {
        var sched = r['Frequency'] === 'Daily' ? 'Every day' :
          r['Frequency'] === 'Weekly' ? 'Every ' + esc(r['Day']) :
          'Every ' + esc(r['Day']) + ordinal(r['Day']) + ' of the month';
        var active = r['Status'] === 'Active';
        return '<tr><td><div class="t-title">' + esc(r['Title']) + '</div><div class="t-sub">' + esc(r['Recurring ID']) + ' · ' + esc(r['Frequency']) + '</div></td>' +
          '<td>' + esc(userName(r['Assigned To'])) + '</td>' +
          '<td class="small">' + sched + ' · ' + fmtTime(r['Time']) + '</td>' +
          '<td class="small">' + fmtDate(r['Start Date']) + ' → ' + (r['End Date'] ? fmtDate(r['End Date']) : 'no end') + '</td>' +
          '<td><span class="badge ' + (active ? 'b-done' : 'b-hold') + '">' + esc(r['Status']) + '</span></td>' +
          '<td><button class="btn btn-ghost btn-sm" onclick="toggleRecurring(\'' + r['Recurring ID'] + '\',\'' + (active ? 'Paused' : 'Active') + '\')">' + (active ? 'Pause' : 'Resume') + '</button></td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<div class="empty-state"><div class="e-ico">' + icon('repeat', 24) + '</div><p>No recurring templates yet. Create one to auto-generate daily, weekly or monthly tickets.</p></div>') +
    '</div>';
}

function ordinal(d) {
  var n = Number(d);
  if (!n) return '';
  var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function openRecurringForm() {
  var priorities = settingList('PRIORITIES', 'Low,Medium,High,Critical');
  var depts = settingList('DEPARTMENTS', 'Operations');
  openModal(
    '<div class="modal-head"><h3>New recurring ticket</h3><button class="icon-btn" onclick="closeModal()" aria-label="Close">&times;</button></div>' +
    '<div class="form-grid">' +
    '<label class="field span-2">Title<input id="rTitle" placeholder="e.g., Daily occupancy report"></label>' +
    '<label class="field span-2">Description<textarea id="rDesc"></textarea></label>' +
    '<label class="field">Assign to<select id="rAssign">' + userOptions() + '</select></label>' +
    '<label class="field">Priority<select id="rPriority">' + optionsHtml(priorities, 'Medium') + '</select></label>' +
    '<label class="field">Department<select id="rDept">' + optionsHtml(depts) + '</select></label>' +
    '<label class="field">Frequency<select id="rFreq" onchange="recurringDayField()"><option>Daily</option><option>Weekly</option><option>Monthly</option></select></label>' +
    '<div id="rDayWrap"></div>' +
    '<label class="field">Time<input type="time" id="rTime" value="10:00"></label>' +
    '<label class="field">Start date<input type="date" id="rStart" value="' + todayStr() + '"></label>' +
    '<label class="field">End date <span style="font-weight:400">(optional)</span><input type="date" id="rEnd"></label>' +
    '</div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Discard</button>' +
    '<button class="btn btn-primary" id="rSaveBtn" onclick="saveRecurring()">Create template</button></div>'
  );
  recurringDayField();
}

function recurringDayField() {
  var f = document.getElementById('rFreq').value;
  var wrap = document.getElementById('rDayWrap');
  if (f === 'Weekly') {
    wrap.innerHTML = '<label class="field">Day of week<select id="rDay">' +
      optionsHtml(['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], 'Monday') + '</select></label>';
  } else if (f === 'Monthly') {
    var opts = '';
    for (var i = 1; i <= 31; i++) opts += '<option value="' + i + '">' + i + ordinal(i) + '</option>';
    wrap.innerHTML = '<label class="field">Day of month<select id="rDay">' + opts + '</select></label>';
  } else {
    wrap.innerHTML = '<label class="field muted">Runs every day<input disabled value="No day selection needed"></label>';
  }
}

async function saveRecurring() {
  var btn = document.getElementById('rSaveBtn');
  var freq = document.getElementById('rFreq').value;
  var p = {
    title: document.getElementById('rTitle').value.trim(),
    description: document.getElementById('rDesc').value.trim(),
    assignedTo: document.getElementById('rAssign').value,
    priority: document.getElementById('rPriority').value,
    department: document.getElementById('rDept').value,
    frequency: freq,
    day: freq === 'Daily' ? '' : document.getElementById('rDay').value,
    time: document.getElementById('rTime').value,
    startDate: document.getElementById('rStart').value,
    endDate: document.getElementById('rEnd').value
  };
  if (!p.title) { toast('Add a title.', 'error'); return; }
  btn.disabled = true;
  try {
    var out = await api('createRecurring', p);
    toast('Recurring template ' + out.id + ' created. Tickets will be generated on schedule.', 'success');
    closeModal(); renderView();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function toggleRecurring(id, status) {
  try {
    await api('updateRecurring', { id: id, status: status });
    toast('Template ' + (status === 'Active' ? 'resumed' : 'paused') + '.', 'success');
    renderView();
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================================================
 * VIEW — EMPLOYEES (Admin)
 * ============================================================ */
async function renderEmployees(c) {
  state.users = await api('listUsers');
  var depts = settingList('DEPARTMENTS', 'Operations');
  c.innerHTML =
    '<div class="two-col">' +
    '<div class="panel"><div class="panel-head"><h3>Team members</h3></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Status</th><th></th></tr></thead><tbody>' +
    state.users.map(function(u) {
      var active = u.status === 'Active';
      return '<tr><td><div class="t-title">' + esc(u.name) + '</div><div class="t-sub">' + esc(u.email) + ' · ' + esc(u.id) + '</div></td>' +
        '<td>' + esc(u.role) + '</td><td>' + esc(u.department || '—') + '</td>' +
        '<td><span class="badge ' + (active ? 'b-done' : 'b-hold') + '">' + esc(u.status) + '</span></td>' +
        '<td><button class="btn btn-ghost btn-sm" onclick="toggleUser(\'' + u.id + '\',\'' + (active ? 'Inactive' : 'Active') + '\')">' + (active ? 'Deactivate' : 'Activate') + '</button></td></tr>';
    }).join('') + '</tbody></table></div></div>' +

    '<div class="panel"><div class="panel-head"><h3>Add a team member</h3></div>' +
    '<div class="form-grid">' +
    '<label class="field">Name<input id="uName"></label>' +
    '<label class="field">Email<input type="email" id="uEmail"></label>' +
    '<label class="field">Role<select id="uRole"><option>Employee</option><option>Admin</option></select></label>' +
    '<label class="field">Department<select id="uDept">' + optionsHtml(depts) + '</select></label>' +
    '<label class="field span-2">Access code<input id="uCode" placeholder="Code they will sign in with"></label>' +
    '</div>' +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="saveUser()">Add member</button></div></div>' +
    '</div>';
}

async function saveUser() {
  var p = {
    name: document.getElementById('uName').value.trim(),
    email: document.getElementById('uEmail').value.trim(),
    role: document.getElementById('uRole').value,
    department: document.getElementById('uDept').value,
    code: document.getElementById('uCode').value.trim()
  };
  if (!p.name || !p.email || !p.code) { toast('Name, email and access code are required.', 'error'); return; }
  try {
    await api('addUser', p);
    toast(p.name + ' added. Share their email + access code with them.', 'success');
    renderView();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleUser(id, status) {
  try {
    await api('updateUser', { id: id, 'Status': status });
    toast('User ' + (status === 'Active' ? 'activated' : 'deactivated') + '.', 'success');
    renderView();
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================================================
 * VIEW — EOD (Employee)
 * ============================================================ */
async function renderEmployeeEOD(c) {
  var t = todayStr();
  var both = await Promise.all([api('myEOD'), api('listTickets', { date: t })]);   // only today's tickets are needed here
  var logs = both[0];
  // my own tickets for today (an admin's list holds everyone's, so filter to me)
  state._eodToday = both[1].filter(function(x) {
    return x['Assigned To'] === state.user.id && x['Scheduled Date'] === t && x['Status'] !== 'Cancelled';
  });
  var doneToday = state._eodToday.filter(function(x) { return x['Status'] === 'Completed'; }).length;
  var todayLog = logs.filter(function(l) { return l['Date'] === t; })[0] || {};
  var cutoff = state.settings.EOD_CUTOFF || '23:00';

  c.innerHTML =
    '<div class="panel eod-card"><div class="panel-head"><h3>Today\'s EOD work log — ' + fmtDate(t) + '</h3>' +
    (todayLog['Log ID'] ? '<span class="badge b-done">Submitted ' + esc(String(todayLog['Submitted At']).slice(11, 16)) + '</span>' : '<span class="badge b-progress">Not submitted</span>') +
    '</div>' +
    '<p class="muted small" style="margin-bottom:12px">Ticket counts are filled automatically from today\'s tickets. You can edit this log until ' + fmtTime(cutoff) + '.</p>' +
    '<div class="eod-today"><span class="mono"><strong>' + state._eodToday.length + '</strong> assigned</span><span class="mono"><strong>' + doneToday + '</strong> completed</span>' +
    '<span class="mono"><strong>' + (state._eodToday.length - doneToday) + '</strong> pending</span>' +
    (state._eodToday.length ? '<button class="btn btn-ghost btn-sm" onclick="fillEODFromTickets()">' + icon('wand', 15) + 'Fill from today\'s tickets</button>' : '') + '</div>' +
    '<div class="form-grid">' +
    '<label class="field span-2">Work completed today<textarea id="eWork" placeholder="e.g., Electricity complaints report; housekeeping dashboard update">' + esc(todayLog['Work Completed'] || '') + '</textarea></label>' +
    '<label class="field">Challenges / blockers<textarea id="eChallenges" placeholder="e.g., Waiting for data from operations team">' + esc(todayLog['Challenges'] || '') + '</textarea></label>' +
    '<label class="field">Pending work<textarea id="ePending" placeholder="e.g., Monthly report automation">' + esc(todayLog['Pending Work'] || '') + '</textarea></label>' +
    '<label class="field">Tomorrow\'s plan<textarea id="eTomorrow" placeholder="e.g., Complete dashboard automation">' + esc(todayLog['Tomorrow Plan'] || '') + '</textarea></label>' +
    '<label class="field">Additional remarks<textarea id="eRemarks">' + esc(todayLog['Remarks'] || '') + '</textarea></label>' +
    '</div>' +
    '<div class="modal-actions"><button class="btn btn-primary" id="eSaveBtn" onclick="saveEOD()">' +
    (todayLog['Log ID'] ? 'Update today\'s log' : 'Submit EOD log') + '</button></div></div>' +

    '<div class="panel"><div class="panel-head"><h3>Previous logs</h3></div>' +
    (logs.length ? logs.map(eodCard).join('') :
      '<div class="empty-state"><div class="e-ico">' + icon('note', 24) + '</div><p>No EOD logs yet. Your first one will appear here.</p></div>') +
    '</div>';
}

/* drop today's ticket titles into the form so nobody retypes them; never overwrites what is already written */
function fillEODFromTickets() {
  var list = state._eodToday || [];
  var line = function(x) { return '• ' + x['Title'] + ' (' + x['Ticket ID'] + ')'; };
  var done = list.filter(function(x) { return x['Status'] === 'Completed'; }).map(line).join('\n');
  var open = list.filter(function(x) { return x['Status'] !== 'Completed'; }).map(line).join('\n');
  var add = function(id, text) {
    var el = document.getElementById(id);
    if (!text || el.value.indexOf(text) !== -1) return;
    el.value = (el.value.trim() ? el.value.trim() + '\n' : '') + text;
  };
  add('eWork', done); add('ePending', open);
  toast(done || open ? 'Added today\'s tickets. Edit the text as you like.' : 'No tickets to add.', 'success');
}

function eodCard(l) {
  return '<div class="panel eod-card" style="margin-bottom:12px">' +
    '<div class="panel-head"><h4>' + fmtDate(l['Date']) + (l['Employee Name'] && state.user.role === 'Admin' ? ' — ' + esc(l['Employee Name']) : '') + '</h4>' +
    '<span class="muted small">' + esc(l['Log ID']) + '</span></div>' +
    '<div class="eod-meta"><span>Assigned: <strong>' + esc(l['Tickets Assigned']) + '</strong></span>' +
    '<span>Completed: <strong>' + esc(l['Tickets Completed']) + '</strong></span>' +
    '<span>Pending: <strong>' + esc(l['Tickets Pending']) + '</strong></span>' +
    '<span>Submitted: ' + esc(String(l['Submitted At']).slice(0, 16)) + '</span></div>' +
    eodSection('Work completed', l['Work Completed']) +
    eodSection('Challenges', l['Challenges']) +
    eodSection('Pending work', l['Pending Work']) +
    eodSection('Tomorrow\'s plan', l['Tomorrow Plan']) +
    eodSection('Remarks', l['Remarks']) +
    '</div>';
}

function eodSection(label, val) {
  if (!val) return '';
  return '<div class="eod-section"><span>' + label + '</span><p>' + esc(val) + '</p></div>';
}

async function saveEOD() {
  var btn = document.getElementById('eSaveBtn');
  var p = {
    workCompleted: document.getElementById('eWork').value.trim(),
    challenges: document.getElementById('eChallenges').value.trim(),
    pendingWork: document.getElementById('ePending').value.trim(),
    tomorrowPlan: document.getElementById('eTomorrow').value.trim(),
    remarks: document.getElementById('eRemarks').value.trim()
  };
  if (!p.workCompleted) { toast('Describe the work you completed today.', 'error'); return; }
  btn.disabled = true;
  try {
    var out = await api('submitEOD', p);
    toast(out.updated ? 'EOD log updated.' : 'EOD log submitted. Have a good evening!', 'success');
    renderView();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

/* ============================================================
 * VIEW — EOD LOGS (Admin)
 * ============================================================ */
/* Loads the last EOD_WINDOW_DAYS days. Picking an older date fetches just that day; "Show all logs" loads everything. */
var EOD_WINDOW_DAYS = 30;

async function renderAdminEOD(c) {
  loadUsersThen(async function() {
    try {
      var logs = await api('listAllEOD', { days: EOD_WINDOW_DAYS });
      state._eodLogs = logs;
      state._eodAll = false;
      state._eodFetched = {};
      c.innerHTML =
        '<div class="filter-bar">' +
        '<input type="date" id="eodDate" onchange="filterAdminEOD()">' +
        '<select id="eodEmp" onchange="filterAdminEOD()"><option value="">Employee: All</option>' + userOptions() + '</select>' +
        '<span class="muted small" id="eodScope" style="flex:1">Showing the last ' + EOD_WINDOW_DAYS + ' days. ' +
        '<button type="button" class="link-btn" onclick="loadAllEOD()">Show all logs</button></span>' +
        '</div><div id="eodListBox"></div>';
      filterAdminEOD();
    } catch (e) { c.innerHTML = errorState(e.message); }
  }, c);
}

async function loadAllEOD() {
  var box = document.getElementById('eodListBox');
  box.innerHTML = '<div class="skeleton tall"></div>';
  try {
    state._eodLogs = await api('listAllEOD', { all: true });
    state._eodAll = true;
    document.getElementById('eodScope').textContent = 'Showing all logs.';
    filterAdminEOD();
  } catch (e) { box.innerHTML = errorState(e.message); }
}

function daysAgoStr(n) {
  var d = new Date(); d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function filterAdminEOD() {
  var d = document.getElementById('eodDate').value;
  var emp = document.getElementById('eodEmp').value;
  // a date outside the loaded window: fetch that one day and merge it in
  if (d && !state._eodAll && d < daysAgoStr(EOD_WINDOW_DAYS) && !state._eodFetched[d]) {
    state._eodFetched[d] = true;
    try {
      var extra = await api('listAllEOD', { date: d });
      var have = {};
      state._eodLogs.forEach(function(l) { have[l['Log ID']] = true; });
      extra.forEach(function(l) { if (!have[l['Log ID']]) state._eodLogs.push(l); });
    } catch (e) { toast(e.message, 'error'); }
    if (document.getElementById('eodDate').value !== d) return;      // the user moved on while we were loading
  }
  var list = state._eodLogs.filter(function(l) {
    if (d && l['Date'] !== d) return false;
    if (emp && l['Employee ID'] !== emp) return false;
    return true;
  });
  var box = document.getElementById('eodListBox');
  if (!list.length) {
    box.innerHTML = '<div class="panel"><div class="empty-state"><div class="e-ico">' + icon('note', 24) + '</div><p>No EOD logs match these filters.</p></div></div>';
    return;
  }
  // who hasn't submitted for the selected date
  var missing = '';
  if (d) {
    var submitted = list.map(function(l) { return l['Employee ID']; });
    var pending = state.users.filter(function(u) {
      return u.role === 'Employee' && u.status === 'Active' && submitted.indexOf(u.id) === -1;
    }).map(function(u) { return u.name; });
    if (pending.length) {
      missing = '<div class="panel" style="border-left:3px solid var(--late)"><h4>Not submitted on ' + fmtDate(d) + '</h4>' +
        '<p class="muted small">' + pending.map(esc).join(', ') + '</p></div>';
    }
  }
  box.innerHTML = missing + list.map(eodCard).join('');
}

/* ============================================================
 * VIEW — REPORTS (Admin)
 * ============================================================ */
async function renderReports(c) {
  loadUsersThen(async function() {
    var depts = settingList('DEPARTMENTS', 'Operations');
    var monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
    var from = monthAgo.toISOString().slice(0, 10);
    c.innerHTML =
      '<div class="filter-bar">' +
      '<label class="small muted">From <input type="date" id="repFrom" value="' + from + '"></label>' +
      '<label class="small muted">To <input type="date" id="repTo" value="' + todayStr() + '"></label>' +
      '<select id="repEmp"><option value="">Employee: All</option>' + userOptions() + '</select>' +
      '<select id="repDept"><option value="">Dept: All</option>' + optionsHtml(depts) + '</select>' +
      '<button class="btn btn-primary" onclick="runReport()">Run report</button>' +
      '</div><div id="reportBox"></div>';
    runReport();
  }, c);
}

async function runReport() {
  var box = document.getElementById('reportBox');
  box.innerHTML = '<div class="skeleton tall"></div>';
  try {
    var r = await api('reportData', {
      from: document.getElementById('repFrom').value,
      to: document.getElementById('repTo').value,
      employee: document.getElementById('repEmp').value,
      department: document.getElementById('repDept').value
    });
    state._report = r;
    var tk = r.tickets;
    box.innerHTML =
      '<div class="kpi-grid">' +
      [['Total tickets', tk.total, 'k-accent'], ['Completed', tk.completed, 'k-done'], ['Pending', tk.pending, ''],
       ['Overdue', tk.overdue, 'k-late'], ['Completion', tk.completionRate + '%', 'k-done'],
       ['EOD logs in period', r.eod.logsSubmitted, '']].map(function(x) {
        return '<div class="kpi ' + x[2] + '"><div class="k-num">' + x[1] + '</div><div class="k-label">' + x[0] + '</div></div>';
      }).join('') + '</div>' +

      '<div class="two-col">' +
      '<div class="panel"><div class="panel-head"><h3>Employee performance</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="exportCSV(\'employee\')">Export CSV</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Total</th><th>Completed</th><th>Pending</th><th>Overdue</th></tr></thead><tbody>' +
      r.perEmployee.map(function(e) {
        return '<tr><td>' + esc(e.name) + '</td><td>' + e.total + '</td><td>' + e.completed + '</td><td>' + e.pending + '</td><td>' + e.overdue + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +

      '<div class="panel"><div class="panel-head"><h3>Department performance</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="exportCSV(\'department\')">Export CSV</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Department</th><th>Total</th><th>Completed</th><th>Rate</th></tr></thead><tbody>' +
      r.perDepartment.map(function(d) {
        return '<tr><td>' + esc(d.department) + '</td><td>' + d.total + '</td><td>' + d.completed + '</td><td>' + d.rate + '%</td></tr>';
      }).join('') + '</tbody></table></div></div>' +

      '<div class="panel"><div class="panel-head"><h3>EOD submissions</h3>' +
      '<button class="btn btn-ghost btn-sm" onclick="exportCSV(\'eod\')">Export CSV</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Logs submitted</th></tr></thead><tbody>' +
      r.eod.perEmployee.map(function(e) {
        return '<tr><td>' + esc(e.name) + '</td><td>' + e.submitted + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '</div>';
  } catch (e) { box.innerHTML = errorState(e.message); }
}

function exportCSV(kind) {
  var r = state._report;
  if (!r) return;
  var rows, name;
  if (kind === 'employee') {
    name = 'employee-performance.csv';
    rows = [['Employee', 'Total', 'Completed', 'Pending', 'Overdue']].concat(
      r.perEmployee.map(function(e) { return [e.name, e.total, e.completed, e.pending, e.overdue]; }));
  } else if (kind === 'department') {
    name = 'department-performance.csv';
    rows = [['Department', 'Total', 'Completed', 'Completion %']].concat(
      r.perDepartment.map(function(d) { return [d.department, d.total, d.completed, d.rate]; }));
  } else {
    name = 'eod-submissions.csv';
    rows = [['Employee', 'Logs submitted']].concat(
      r.eod.perEmployee.map(function(e) { return [e.name, e.submitted]; }));
  }
  var csv = rows.map(function(row) {
    return row.map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  toast('CSV downloaded.', 'success');
}

/* ============================================================
 * VIEW — SETTINGS (Admin)
 * ============================================================ */
async function renderSettings(c) {
  var editable = [
    ['EOD_CUTOFF', 'EOD edit cutoff time (HH:mm, 24h)'],
    ['STATUSES', 'Ticket statuses (comma-separated)'],
    ['PRIORITIES', 'Priorities (comma-separated)'],
    ['DEPARTMENTS', 'Departments (comma-separated)'],
    ['APP_NAME', 'Application name']
  ];
  c.innerHTML = '<div class="panel" style="max-width:640px"><div class="panel-head"><h3>Application settings</h3></div>' +
    editable.map(function(s) {
      return '<label class="field" style="margin-bottom:14px">' + esc(s[1]) +
        '<input id="set_' + s[0] + '" value="' + esc(state.settings[s[0]] || '') + '"></label>';
    }).join('') +
    '<div class="modal-actions"><button class="btn btn-primary" onclick="saveSettings()">Save settings</button></div>' +
    '<p class="muted small" style="margin-top:14px">Changing statuses or priorities updates dropdowns across the app. Existing tickets keep their current values.</p></div>' +

    '<div class="panel" style="max-width:640px"><div class="panel-head"><h3>Maintenance &amp; performance</h3></div>' +
    '<p class="muted small" style="margin-bottom:12px">If the app feels slow, run the check first — it tells you which of the other buttons will help.</p>' +
    '<div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap;gap:8px">' +
      '<button class="btn btn-primary" id="mtDiag" onclick="runDiagnose()">Run performance check</button>' +
      '<button class="btn btn-ghost" onclick="runMaintenance(\'archive\', this, \'Archive old finished tickets\', \'Moves Completed and Cancelled tickets older than the ARCHIVE_AFTER_DAYS setting to the Tickets Archive tab. Reports still include them.\')">Archive old finished tickets</button>' +
      '<button class="btn btn-ghost" onclick="runMaintenance(\'expire\', this, \'Expire stale recurring tickets\', \'Recurring tickets still Overdue more than EXPIRE_AFTER_DAYS days after their due date are marked Expired. They stop cluttering dashboards and still count as missed in Reports.\')">Expire stale recurring tickets</button>' +
      '<button class="btn btn-ghost" onclick="runMaintenance(\'fixDates\', this, \'Fix date formats\', \'Converts any date-typed cells in the sheet to plain text so reads are fast. Safe to run any time.\')">Fix date formats</button>' +
    '</div>' +
    '<pre id="mtReport" class="muted small" style="white-space:pre-wrap;margin-top:14px;display:none"></pre></div>';
}

async function runDiagnose() {
  var btn = document.getElementById('mtDiag'), box = document.getElementById('mtReport');
  setBusy(btn, true, 'Checking… (can take a minute)');
  box.style.display = 'block'; box.textContent = 'Reading the sheet and timing each step…';
  try {
    var r = await api('diagnose');
    box.textContent = r.report;
  } catch (e) { box.textContent = e.message; }
  finally { setBusy(btn, false, 'Run performance check'); }
}

async function runMaintenance(task, btn, title, text) {
  if (!(await confirmDialog(title, text, 'Run now'))) return;
  var label = btn.textContent;
  setBusy(btn, true, 'Working…');
  try {
    var r = await api('maintenance', { task: task });
    toast(r.message, 'success');
    var box = document.getElementById('mtReport');
    if (box) { box.style.display = 'block'; box.textContent = r.message; }
  } catch (e) { toast(e.message, 'error'); }
  finally { setBusy(btn, false, label); }
}

async function saveSettings() {
  var keys = ['EOD_CUTOFF', 'STATUSES', 'PRIORITIES', 'DEPARTMENTS', 'APP_NAME'];
  try {
    for (var i = 0; i < keys.length; i++) {
      var val = document.getElementById('set_' + keys[i]).value.trim();
      if (val !== (state.settings[keys[i]] || '')) {
        state.settings = await api('updateSetting', { key: keys[i], value: val });
      }
    }
    localStorage.setItem('od_settings', JSON.stringify(state.settings));
    toast('Settings saved.', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

/* ============================================================
 * BOOT
 * ============================================================ */
document.getElementById('loginCode').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});
['resetEmail', 'resetOtp', 'resetNewCode'].forEach(function(id) {
  document.getElementById(id).addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doReset();
  });
});
applyTheme(currentTheme());
if (state.token && state.user) enterApp();
