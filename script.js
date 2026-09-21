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
async function api(action, payload) {
  if (CONFIG.API_URL.indexOf('http') !== 0) {
    throw new Error('Backend not configured. Paste your Apps Script URL into CONFIG.API_URL in script.js.');
  }
  var res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
    body: JSON.stringify({ action: action, token: state.token, payload: payload || {} })
  });
  var out = await res.json();
  if (!out.ok) {
    if (out.error === 'SESSION_EXPIRED') { logout(true); }
    throw new Error(out.message || 'Request failed. Please try again.');
  }
  return out.data;
}

/* ============================================================
 * AUTH
 * ============================================================ */
async function doLogin() {
  var btn = document.getElementById('loginBtn');
  var err = document.getElementById('loginError');
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    var data = await api('login', {
      email: document.getElementById('loginEmail').value,
      code: document.getElementById('loginCode').value
    });
    state.token = data.token; state.user = data.user; state.settings = data.settings;
    localStorage.setItem('od_token', data.token);
    localStorage.setItem('od_user', JSON.stringify(data.user));
    localStorage.setItem('od_settings', JSON.stringify(data.settings));
    enterApp();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

function logout(expired) {
  ['od_token', 'od_user', 'od_settings'].forEach(function(k) { localStorage.removeItem(k); });
  state.token = null; state.user = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  if (expired) toast('Your session expired. Please sign in again.', 'error');
}

async function enterApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('userName').textContent = state.user.name;
  document.getElementById('userRole').textContent = state.user.role + (state.user.department ? ' · ' + state.user.department : '');
  document.getElementById('userAvatar').textContent = initials(state.user.name);
  buildSidebar();
  navigate('dashboard');
  try {
    var boot = await api('bootstrap');
    state.settings = boot.settings;
    if (boot.users) state.users = boot.users;
  } catch (e) { /* non-fatal */ }
}

/* ============================================================
 * NAVIGATION
 * ============================================================ */
var NAV = {
  Admin: [
    ['dashboard', '▦', 'Dashboard'],
    ['tickets', '🎫', 'All Tickets'],
    ['createTicket', '＋', 'Create Ticket'],
    ['recurring', '↻', 'Recurring Tickets'],
    ['employees', '👥', 'Employees'],
    ['eodAdmin', '📝', 'EOD Logs'],
    ['reports', '📊', 'Reports'],
    ['settings', '⚙', 'Settings']
  ],
  Employee: [
    ['dashboard', '▦', 'Dashboard'],
    ['tickets', '🎫', 'My Tickets'],
    ['today', '☀', "Today's Tasks"],
    ['upcoming', '⏭', 'Upcoming Tasks'],
    ['completed', '✓', 'Completed'],
    ['eod', '📝', 'EOD Work Log'],
    ['history', '🕘', 'My History']
  ]
};

var VIEW_TITLES = {
  dashboard: 'Dashboard', tickets: 'Tickets', createTicket: 'Create Ticket',
  recurring: 'Recurring Tickets', employees: 'Employees', eodAdmin: 'EOD Logs',
  reports: 'Reports', settings: 'Settings', today: "Today's Tasks",
  upcoming: 'Upcoming Tasks', completed: 'Completed Tickets',
  eod: 'EOD Work Log', history: 'My History'
};

function buildSidebar() {
  var nav = document.getElementById('sidebarNav');
  nav.innerHTML = NAV[state.user.role].map(function(item) {
    return '<button class="nav-item" data-view="' + item[0] + '" onclick="navigate(\'' + item[0] + '\')">' +
      '<span class="n-ico">' + item[1] + '</span>' + item[2] + '</button>';
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

async function renderView() {
  var c = document.getElementById('viewContainer');
  destroyCharts();
  c.innerHTML = '<div class="skeleton tall"></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div>';
  try {
    var v = state.view;
    if (v === 'dashboard') return state.user.role === 'Admin' ? renderAdminDashboard(c) : renderEmployeeDashboard(c);
    if (v === 'tickets') return renderTickets(c, state.viewArg || {});
    if (v === 'today') return renderTickets(c, { preset: 'today' });
    if (v === 'upcoming') return renderTickets(c, { preset: 'upcoming' });
    if (v === 'completed') return renderTickets(c, { preset: 'completed' });
    if (v === 'history') return renderTickets(c, { preset: 'history' });
    if (v === 'createTicket') return renderCreateTicket(c);
    if (v === 'recurring') return renderRecurring(c);
    if (v === 'employees') return renderEmployees(c);
    if (v === 'eod') return renderEmployeeEOD(c);
    if (v === 'eodAdmin') return renderAdminEOD(c);
    if (v === 'reports') return renderReports(c);
    if (v === 'settings') return renderSettings(c);
  } catch (e) {
    c.innerHTML = errorState(e.message);
  }
}

function errorState(msg) {
  return '<div class="empty-state"><div class="e-ico">⚠</div><p>' + esc(msg) + '</p>' +
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
  return u ? u.name : id;
}
function statusBadge(s) {
  var map = { 'Open': 'b-open', 'In Progress': 'b-progress', 'Completed': 'b-done', 'On Hold': 'b-hold', 'Overdue': 'b-late', 'Cancelled': 'b-cancel' };
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
  el.textContent = msg;
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
      notifs.push({ id: 'ovd_' + tk['Ticket ID'], ico: '⏰', text: tk['Ticket ID'] + ' "' + tk['Title'] + '" is overdue.' });
    } else if (tk['Scheduled Date'] === t && tk['Status'] !== 'Completed' && tk['Scheduled Time']) {
      var p = tk['Scheduled Time'].split(':');
      var due = new Date(); due.setHours(Number(p[0]) || 0, Number(p[1]) || 0, 0, 0);
      var mins = Math.round((due - now) / 60000);
      if (mins > 0 && mins <= 60) {
        notifs.push({ id: 'due_' + tk['Ticket ID'], ico: '🕐', text: tk['Ticket ID'] + ' "' + tk['Title'] + '" is due in ' + mins + ' min.' });
      }
    }
    if (tk['Status'] === 'Open' && String(tk['Created Date']).slice(0, 10) === t) {
      notifs.push({ id: 'new_' + tk['Ticket ID'], ico: '🎫', text: 'New ticket: ' + tk['Ticket ID'] + ' "' + tk['Title'] + '".' });
    }
  });
  if (state.user.role === 'Employee' && eodSubmitted === false && now.getHours() >= 17) {
    notifs.push({ id: 'eod_' + t, ico: '📝', text: "Your EOD work log for today hasn't been submitted yet." });
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
  if (!state.notifs.length) {
    panel.innerHTML = '<div class="notif-empty">You\'re all caught up.</div>';
  } else {
    panel.innerHTML = state.notifs.map(function(n) {
      return '<div class="notif-item"><span class="n-ico">' + n.ico + '</span><span>' + esc(n.text) + '</span></div>';
    }).join('');
    state.notifs.forEach(function(n) { state.notifSeen[n.id] = 1; });
    localStorage.setItem('od_notif_seen', JSON.stringify(state.notifSeen));
    document.getElementById('notifDot').classList.add('hidden');
  }
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('.notif-wrap')) document.getElementById('notifPanel').classList.add('hidden');
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
function kpiCard(label, num, cls, sub, key, value) {
  return '<button class="kpi ' + cls + '" onclick="goTickets(\'' + key + '\',\'' + esc(value) + '\')">' +
    '<div class="k-num">' + num + '</div><div class="k-label">' + esc(label) + '</div>' +
    (sub ? '<div class="k-sub">' + esc(sub) + '</div>' : '') + '</button>';
}
function progressBar(done, total, small) {
  return '<div class="bar' + (small ? ' bar-sm' : '') + '"><span style="width:' + pctOf(done, total) + '%"></span></div>';
}

/* ============================================================
 * VIEW — ADMIN DASHBOARD
 * Today strip · clickable KPIs · overdue list · team workload · 7-day trend
 * ============================================================ */
async function renderAdminDashboard(c) {
  var results = await Promise.all([
    api('adminKPIs'), api('listTickets'),
    state.users.length ? state.users : api('listUsers')
  ]);
  var k = results[0];
  state.tickets = results[1];
  state.users = results[2];

  var t = todayStr();
  var live = state.tickets.filter(function(x) { return x['Status'] !== 'Cancelled'; });
  var count = function(s) { return live.filter(function(x) { return x['Status'] === s; }).length; };
  var overdue = live.filter(function(x) { return x['Status'] === 'Overdue'; }).sort(oldestFirst);
  computeNotifs(overdue);

  var todays = live.filter(function(x) { return x['Scheduled Date'] === t; });
  var todayDone = todays.filter(function(x) { return x['Status'] === 'Completed'; }).length;
  var completed = count('Completed');
  var urgent = overdue.filter(function(x) { return x['Priority'] === 'High' || x['Priority'] === 'Critical'; }).length;

  /* --- EOD today --- */
  var eodTotal = k.eodSubmitted + k.eodPending.length;
  var waiting = k.eodPending.slice(0, 8).map(esc).join(', ') +
    (k.eodPending.length > 8 ? ' +' + (k.eodPending.length - 8) + ' more' : '');

  /* --- team workload, per person --- */
  var team = {};
  state.users.forEach(function(u) {
    if (u.role === 'Employee' && u.status === 'Active') {
      team[u.id] = { id: u.id, name: u.name, isEmp: true, today: 0, todayDone: 0, pending: 0, overdue: 0 };
    }
  });
  live.forEach(function(x) {
    var id = x['Assigned To'];
    var active = isPendingStatus(x['Status']) || x['Status'] === 'Overdue';
    if (!team[id]) {
      if (!active && x['Scheduled Date'] !== t) return;      // nothing current for this person
      team[id] = { id: id, name: userName(id), isEmp: false, today: 0, todayDone: 0, pending: 0, overdue: 0 };
    }
    var m = team[id];
    if (x['Scheduled Date'] === t) { m.today++; if (x['Status'] === 'Completed') m.todayDone++; }
    if (isPendingStatus(x['Status'])) m.pending++;
    if (x['Status'] === 'Overdue') m.overdue++;
  });
  var teamRows = Object.keys(team).map(function(id) { return team[id]; }).sort(function(a, b) {
    return (b.overdue - a.overdue) || (b.pending - a.pending) || a.name.localeCompare(b.name);
  });

  c.innerHTML =
    /* today strip */
    '<div class="two-col">' +
      '<div class="panel"><div class="panel-head"><h3>Today\'s tickets</h3>' +
        '<span class="muted small">' + fmtDate(t) + ' · updated ' + nowClock() + '</span></div>' +
        '<div class="progress-num">' + todayDone + ' <small>of ' + todays.length + ' done</small></div>' +
        progressBar(todayDone, todays.length) +
        '<p class="muted small">' + (todays.length ? (todays.length - todayDone) + ' still to finish today.' : 'Nothing is scheduled for today.') + '</p></div>' +

      '<div class="panel"><div class="panel-head"><h3>EOD logs today</h3>' +
        '<button class="btn btn-ghost btn-sm" onclick="navigate(\'eodAdmin\')">View logs</button></div>' +
        '<div class="progress-num">' + k.eodSubmitted + ' <small>of ' + eodTotal + ' submitted</small></div>' +
        progressBar(k.eodSubmitted, eodTotal) +
        '<p class="muted small">' + (k.eodPending.length ? 'Waiting on: ' + waiting : 'Everyone has submitted.') + '</p></div>' +
    '</div>' +

    /* KPIs — click any card to open that list */
    '<div class="kpi-grid kpi-fit">' +
      kpiCard('Overdue', overdue.length, 'k-late k-accent', urgent ? urgent + ' high or critical' : '', 'status', 'Overdue') +
      kpiCard('Open', count('Open'), 'k-open', 'Not started', 'status', 'Open') +
      kpiCard('In progress', count('In Progress'), 'k-progress', '', 'status', 'In Progress') +
      kpiCard('On hold', count('On Hold'), '', '', 'status', 'On Hold') +
      kpiCard('Completion rate', pctOf(completed, live.length) + '%', 'k-done', completed + ' of ' + live.length + ' tickets', 'status', 'Completed') +
    '</div>' +

    '<div class="dash-split">' +
      /* overdue list */
      '<div class="panel"><div class="panel-head"><h3>Overdue tickets</h3>' +
        (overdue.length > 8 ? '<button class="btn btn-ghost btn-sm" onclick="goTickets(\'status\',\'Overdue\')">View all ' + overdue.length + '</button>' :
          '<span class="muted small">Oldest first</span>') + '</div>' +
        (overdue.length ?
          '<div class="table-wrap scroll-y"><table class="compact"><tbody>' + overdue.slice(0, 8).map(function(x) {
            return '<tr class="clickable" onclick="openTicket(\'' + esc(x['Ticket ID']) + '\')">' +
              '<td><div class="t-title">' + esc(x['Title']) + '</div><div class="t-sub">' + esc(x['Ticket ID']) + ' · ' + esc(userName(x['Assigned To'])) + '</div></td>' +
              '<td>' + priorityBadge(x['Priority']) + '</td>' +
              '<td class="small num-late" style="white-space:nowrap">' + lateLabel(x) + '</td></tr>';
          }).join('') + '</tbody></table></div>' :
          '<div class="empty-state" style="padding:28px 20px"><p>No overdue tickets right now.</p></div>') +
      '</div>' +

      /* team workload */
      '<div class="panel"><div class="panel-head"><h3>Team workload</h3><span class="muted small">Click a name to see their tickets</span></div>' +
        (teamRows.length ?
          '<div class="table-wrap scroll-y"><table class="compact"><thead><tr><th>Employee</th><th>Today</th><th>Pending</th><th>Overdue</th><th>EOD</th></tr></thead><tbody>' +
          teamRows.map(function(m) {
            var eod = !m.isEmp ? '<span class="muted small">—</span>' :
              (k.eodPending.indexOf(m.name) === -1 ? '<span class="badge b-done">Submitted</span>' : '<span class="badge b-progress">Pending</span>');
            return '<tr class="clickable" onclick="goTickets(\'employee\',\'' + esc(m.id) + '\')">' +
              '<td class="t-title">' + esc(m.name) + '</td>' +
              '<td class="small">' + (m.today ? m.todayDone + '/' + m.today + progressBar(m.todayDone, m.today, true) : '<span class="muted">—</span>') + '</td>' +
              '<td>' + (m.pending || '<span class="num-zero">0</span>') + '</td>' +
              '<td>' + (m.overdue ? '<span class="num-late">' + m.overdue + '</span>' : '<span class="num-zero">0</span>') + '</td>' +
              '<td>' + eod + '</td></tr>';
          }).join('') + '</tbody></table></div>' :
          '<div class="empty-state" style="padding:28px 20px"><p>Add team members under Employees to see their workload here.</p></div>') +
      '</div>' +
    '</div>' +

    '<div class="panel"><div class="panel-head"><h3>Last 7 days</h3><span class="muted small">How much of each day\'s scheduled work got done</span></div>' +
      '<div class="chart-box" style="height:220px"><canvas id="chWeek"></canvas></div></div>';

  makeChart('chWeek', {
    type: 'bar',
    data: {
      labels: k.weekSeries.map(function(d) { return d.date; }),
      datasets: [
        { label: 'Completed', data: k.weekSeries.map(function(d) { return d.completed; }), backgroundColor: '#187A3C', maxBarThickness: 44 },
        { label: 'Not completed', data: k.weekSeries.map(function(d) { return d.total - d.completed; }), backgroundColor: '#D5DAE1', maxBarThickness: 44 }
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
 * Today strip · clickable KPIs · carried-over work · today's tasks
 * ============================================================ */
async function renderEmployeeDashboard(c) {
  var results = await Promise.all([api('employeeKPIs'), api('listTickets')]);
  var k = results[0];
  state.tickets = results[1];
  computeNotifs(state.tickets, k.eodSubmittedToday);

  var t = todayStr();
  var mine = state.tickets.filter(function(x) { return x['Status'] !== 'Cancelled'; });
  var count = function(s) { return mine.filter(function(x) { return x['Status'] === s; }).length; };

  var todays = mine.filter(function(x) { return x['Scheduled Date'] === t; });
  todays.sort(function(a, b) { return (a['Scheduled Time'] || '99').localeCompare(b['Scheduled Time'] || '99'); });
  var todayDone = todays.filter(function(x) { return x['Status'] === 'Completed'; }).length;

  /* unfinished work from earlier days — overdue first, then oldest */
  var carried = mine.filter(function(x) {
    return x['Scheduled Date'] < t && (isPendingStatus(x['Status']) || x['Status'] === 'Overdue');
  }).sort(function(a, b) {
    return ((b['Status'] === 'Overdue') - (a['Status'] === 'Overdue')) || oldestFirst(a, b);
  });

  var cutoff = fmtTime(state.settings.EOD_CUTOFF || '23:00');

  c.innerHTML =
    '<div class="two-col">' +
      '<div class="panel"><div class="panel-head"><h3>Today\'s tasks</h3>' +
        '<span class="muted small">' + fmtDate(t) + ' · updated ' + nowClock() + '</span></div>' +
        '<div class="progress-num">' + todayDone + ' <small>of ' + todays.length + ' done</small></div>' +
        progressBar(todayDone, todays.length) +
        '<p class="muted small">' + (todays.length ? (todays.length === todayDone ? 'All of today\'s tasks are done.' : (todays.length - todayDone) + ' still to finish today.') : 'Nothing is scheduled for you today.') + '</p></div>' +

      '<div class="panel" style="border-left:3px solid var(--' + (k.eodSubmittedToday ? 'done' : 'progress') + ')">' +
        '<div class="panel-head"><h3>EOD work log</h3>' +
        '<button class="btn ' + (k.eodSubmittedToday ? 'btn-ghost' : 'btn-primary') + ' btn-sm" onclick="navigate(\'eod\')">' +
          (k.eodSubmittedToday ? 'View or edit log' : 'Submit EOD log') + '</button></div>' +
        '<div class="progress-num" style="font-size:1.25rem">' + (k.eodSubmittedToday ? 'Submitted for today' : 'Not submitted yet') + '</div>' +
        '<p class="muted small" style="margin-top:8px">' + (k.eodSubmittedToday ? 'You can edit it until ' + cutoff + '.' : 'Submit your end-of-day work log before ' + cutoff + '.') + '</p></div>' +
    '</div>' +

    '<div class="kpi-grid kpi-fit">' +
      kpiCard('Overdue', count('Overdue'), 'k-late k-accent', '', 'status', 'Overdue') +
      kpiCard('Open', count('Open'), 'k-open', 'Not started', 'status', 'Open') +
      kpiCard('In progress', count('In Progress'), 'k-progress', '', 'status', 'In Progress') +
      kpiCard('Completed', count('Completed'), 'k-done', 'of ' + mine.length + ' assigned', 'status', 'Completed') +
    '</div>' +

    (carried.length ?
      '<div class="panel" style="border-left:3px solid var(--late)"><div class="panel-head"><h3>Finish these first</h3>' +
      '<span class="muted small">Carried over from earlier days</span></div>' + ticketsTable(carried, true) + '</div>' : '') +

    '<div class="panel"><div class="panel-head"><h3>Today\'s tasks</h3><span class="muted small">' + fmtDate(t) + '</span></div>' +
    ticketsTable(todays, true) + '</div>';
}

/* ============================================================
 * VIEW — TICKETS (shared list w/ search + filters)
 * ============================================================ */
async function renderTickets(c, opts) {
  state.tickets = await api('listTickets');
  var isAdmin = state.user.role === 'Admin';
  if (isAdmin && !state.users.length) {
    try { state.users = await api('listUsers'); } catch (e) {}
  }
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
    '<div class="panel"><div id="ticketListBox"></div></div>';

  // presets for employee sub-views
  var preset = opts && opts.preset;
  if (preset === 'today') document.getElementById('fDate').value = todayStr();
  if (preset === 'completed') document.getElementById('fStatus').value = 'Completed';
  state._preset = preset || '';

  // filters passed in from a dashboard card or team row
  var o = opts || {};
  presetSelect('fStatus', o.status);
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
  document.getElementById('ticketListBox').innerHTML = ticketsTable(list, state.user.role !== 'Admin');
}

function ticketsTable(list, quickActions) {
  if (!list.length) {
    return '<div class="empty-state"><div class="e-ico">🗂</div><p>No tickets here yet.</p></div>';
  }
  var isAdmin = state.user.role === 'Admin';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>Ticket</th>' + (isAdmin ? '<th>Assigned to</th>' : '') +
    '<th>Priority</th><th>Scheduled</th><th>Status</th><th>Action</th>' +
    '</tr></thead><tbody>' +
    list.map(function(x) {
      var sched = fmtDate(x['Scheduled Date']) + (x['Scheduled Time'] ? ' · ' + fmtTime(x['Scheduled Time']) : '');
      return '<tr class="clickable" onclick="openTicket(\'' + x['Ticket ID'] + '\')">' +
        '<td><div class="t-title">' + esc(x['Title']) + '</div><div class="t-sub">' + esc(x['Ticket ID']) +
          ' · ' + esc(x['Ticket Type']) + '</div></td>' +
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
    '<p class="muted small">' + esc(t['Ticket ID']) +
    (t['Parent Ticket ID'] ? ' · from ' + esc(t['Parent Ticket ID']) : '') + '</p></div>' +
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
      (isAdmin ? '<button class="btn btn-danger" onclick="cancelTicketUI(\'' + t['Ticket ID'] + '\')">Cancel ticket</button>' : '') +
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
    : '<div class="panel-head"><h3>Create a ticket</h3><p class="muted small">One-time tasks. For repeating tasks, use Recurring Tickets.</p></div>') +
    '<div class="form-grid">' +
    '<label class="field span-2">Title<input id="cTitle" value="' + esc(t['Title'] || '') + '" placeholder="e.g., Prepare monthly electricity report"></label>' +
    '<label class="field span-2">Description<textarea id="cDesc" placeholder="What needs to be done, and any context.">' + esc(t['Description'] || '') + '</textarea></label>' +
    '<label class="field">Assign to<select id="cAssign">' + userOptions(t['Assigned To']) + '</select></label>' +
    '<label class="field">Department<select id="cDept">' + optionsHtml(depts, t['Department']) + '</select></label>' +
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
    assignedTo: document.getElementById('cAssign').value,
    department: document.getElementById('cDept').value,
    priority: document.getElementById('cPriority').value,
    scheduledDate: document.getElementById('cSchedDate').value,
    scheduledTime: document.getElementById('cSchedTime').value,
    dueDate: document.getElementById('cDueDate').value
  };
  if (!p.title) { toast('Add a title for the ticket.', 'error'); return; }
  if (!p.scheduledDate) { toast('Pick a scheduled date.', 'error'); return; }
  btn.disabled = true;
  try {
    if (editId) {
      p.id = editId;
      await api('updateTicket', p);
      toast('Ticket updated.', 'success');
      closeModal(); renderView();
    } else {
      var out = await api('createTicket', p);
      toast('Ticket ' + out.id + ' created and assigned.', 'success');
      navigate('tickets');
    }
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
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
      : '<div class="empty-state"><div class="e-ico">↻</div><p>No recurring templates yet. Create one to auto-generate daily, weekly or monthly tickets.</p></div>') +
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
  var logs = await api('myEOD');
  var t = todayStr();
  var todayLog = logs.filter(function(l) { return l['Date'] === t; })[0] || {};
  var cutoff = state.settings.EOD_CUTOFF || '23:00';

  c.innerHTML =
    '<div class="panel eod-card"><div class="panel-head"><h3>Today\'s EOD work log — ' + fmtDate(t) + '</h3>' +
    (todayLog['Log ID'] ? '<span class="badge b-done">Submitted ' + esc(String(todayLog['Submitted At']).slice(11, 16)) + '</span>' : '<span class="badge b-progress">Not submitted</span>') +
    '</div>' +
    '<p class="muted small" style="margin-bottom:14px">Ticket counts are filled automatically from today\'s tickets. You can edit this log until ' + fmtTime(cutoff) + '.</p>' +
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
      '<div class="empty-state"><div class="e-ico">📝</div><p>No EOD logs yet. Your first one will appear here.</p></div>') +
    '</div>';
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
async function renderAdminEOD(c) {
  loadUsersThen(async function() {
    try {
      var logs = await api('listAllEOD', {});
      state._eodLogs = logs;
      c.innerHTML =
        '<div class="filter-bar">' +
        '<input type="date" id="eodDate" onchange="filterAdminEOD()">' +
        '<select id="eodEmp" onchange="filterAdminEOD()"><option value="">Employee: All</option>' + userOptions() + '</select>' +
        '</div><div id="eodListBox"></div>';
      filterAdminEOD();
    } catch (e) { c.innerHTML = errorState(e.message); }
  }, c);
}

function filterAdminEOD() {
  var d = document.getElementById('eodDate').value;
  var emp = document.getElementById('eodEmp').value;
  var list = state._eodLogs.filter(function(l) {
    if (d && l['Date'] !== d) return false;
    if (emp && l['Employee ID'] !== emp) return false;
    return true;
  });
  var box = document.getElementById('eodListBox');
  if (!list.length) {
    box.innerHTML = '<div class="panel"><div class="empty-state"><div class="e-ico">📝</div><p>No EOD logs match these filters.</p></div></div>';
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
    '<p class="muted small" style="margin-top:14px">Changing statuses or priorities updates dropdowns across the app. Existing tickets keep their current values.</p></div>';
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
if (state.token && state.user) enterApp();
