# OpsDesk — Setup & Operations Guide

A ticketing and daily work-log system built on HTML/CSS/JS + Google Sheets (database) + Google Apps Script (backend API).

---

## 1. Google Sheet structure

One spreadsheet, six tabs. **You do not create these by hand — `setupDatabase()` creates them** (step 2 below). For reference:

| Tab | Purpose | Columns |
|---|---|---|
| **Users** | All accounts | User ID, Name, Email, Role, Department, Status, Created Date, **Access Code** |
| **Tickets** | Every ticket (one-time + generated recurring instances) | Ticket ID, Parent Ticket ID, Title, Description, Assigned To, Created By, Department, Priority, Ticket Type, Scheduled Date, Scheduled Time, Due Date, Status, Created Date, Updated Date, Completed Date |
| **Recurring Tickets** | Templates only — never shown as tasks themselves | Recurring ID, Title, Description, Assigned To, Frequency, Day, Time, Start Date, End Date, Status, Created By, Department, Priority |
| **Ticket Activity** | Full audit trail; never overwritten | Activity ID, Ticket ID, User, Previous Status, New Status, Comment, Date, Time |
| **EOD Logs** | One row per employee per date | Log ID, Employee ID, Employee Name, Date, Tickets Assigned, Tickets Completed, Tickets Pending, Work Completed, Challenges, Pending Work, Tomorrow Plan, Remarks, Submitted At |
| **Settings** | App configuration | Key, Value, Description |

Notes:
- **Access Code** is one column beyond the base spec — it's what users sign in with. Treat the sheet as confidential.
- Dates are stored as plain text `yyyy-MM-dd` and times as `HH:mm` so values never shift with timezone.
- ID sequences (TKT-10001…, RT-1…, EOD-70001…) are held in Script Properties with a lock, so IDs are always unique even under concurrent use.

## 2. Apps Script setup

1. Create a **blank Google Spreadsheet** (name it e.g. "OpsDesk DB").
2. In the sheet: **Extensions → Apps Script**. Delete the placeholder code and paste the full contents of `Code.gs`.
3. Set the timezone: in the Apps Script editor, **Project Settings → Time zone** → your local timezone (e.g., `Asia/Kolkata`). All scheduling depends on this.
4. In the editor, select the function **`setupDatabase`** and click **Run**. Authorize when prompted. This creates all six tabs, seeds the Settings, and adds a default admin:
   - Email: `admin@company.com` · Access code: `admin123`
   - **Change both immediately** in the Users tab (row 2).

## 3. Deployment

1. In the Apps Script editor: **Deploy → New deployment → Web app**.
2. Settings: **Execute as: Me** · **Who has access: Anyone**. ("Anyone" is required so the frontend can call it without a Google login — the app enforces its own login and tokens.)
3. Copy the Web App URL (ends in `/exec`).
4. Open `script.js` and paste it at the top:
   ```js
   var CONFIG = { API_URL: 'https://script.google.com/macros/s/XXXX/exec' };
   ```
5. Host `index.html`, `style.css`, `script.js` anywhere static — Vercel, Netlify, GitHub Pages — or just open `index.html` locally to test.
6. **After any change to Code.gs**, redeploy: Deploy → Manage deployments → edit (pencil) → New version → Deploy. The URL stays the same.

## 4. Trigger setup (automated scheduling)

In the Apps Script editor, open **Triggers (clock icon) → Add Trigger**, twice:

| Function | Event source | Interval |
|---|---|---|
| `dailyScheduler` | Time-driven | Day timer · **5am–6am** |
| `markOverdueTickets` | Time-driven | Hour timer · **Every hour** |

- `dailyScheduler` reads every **Active** recurring template, generates today's tickets, and skips anything already generated (duplicate-proof).
- `markOverdueTickets` flips Open / In Progress / On Hold tickets to **Overdue** once past their due date + scheduled time, and logs the change to Ticket Activity.

## 5. User management

**Preferred (in-app):** Sign in as Admin → **Employees** → "Add a team member". Set name, email, role, department, and an access code. Share the email + code with them. Deactivate/reactivate from the same page — inactive users cannot sign in.

**Directly in the sheet:** Add a row to Users with a unique User ID (`USR-…`), Role = `Admin` or `Employee`, Status = `Active`, and an Access Code.

Sessions last ~6 hours of inactivity, then users sign in again.

## 6. How recurring tickets work

1. Admin creates a template in **Recurring Tickets** (frequency: Daily / Weekly + weekday / Monthly + day-of-month, plus time, start date, optional end date). It gets an `RT-…` ID.
2. Each morning `dailyScheduler` checks every Active template: is today inside its start/end window, and does today match its frequency rule? (Monthly days beyond a month's length clamp to the last day — a "31st" template fires on 28 Feb.)
3. Matching templates produce a real ticket (`TKT-…`) with `Parent Ticket ID = RT-…`, today's Scheduled Date, the template's time, Status `Open`. Generation is guarded by a lock and a parent+date duplicate check, so a re-run never creates duplicates.
4. Creating a template also generates today's instance immediately if today qualifies.
5. **Pause/Resume** a template from the Recurring Tickets page; paused templates generate nothing.

## 7. How EOD logs work

- One log per employee per date, enforced by the backend.
- Ticket counts (assigned/completed/pending for the day) are computed automatically at submit time.
- Employees can edit today's log until the cutoff time (`EOD_CUTOFF` setting, default 23:00). Past logs are locked.
- Admin → **EOD Logs** shows all logs, filterable by date and employee, and lists who hasn't submitted for a selected date.

## 8. Modifying settings

Admin → **Settings** in the app, or edit the Settings tab directly:

| Key | What it controls |
|---|---|
| `EOD_CUTOFF` | Time (HH:mm 24h) after which today's EOD can't be edited |
| `STATUSES` | Comma-separated ticket statuses shown in dropdowns |
| `PRIORITIES` | Comma-separated priorities |
| `DEPARTMENTS` | Comma-separated departments |
| `FREQUENCIES` | Ticket types |
| `APP_NAME` | Display name |

## 9. Security model

- The spreadsheet ID never reaches the browser — the frontend only knows the Web App URL.
- Every request (except login) carries a session token validated server-side; expired tokens force re-login.
- Role checks happen **in Apps Script**, not just in the UI: employee accounts can only read/update their own tickets; admin-only actions are rejected for employees.
- Input validation runs on the backend; user-facing errors are friendly, technical errors are logged, not exposed.

## 10. Extending notifications (email / WhatsApp later)

In-app notifications (new ticket, due soon, overdue, EOD pending) are derived automatically. To add email later, drop a `MailApp.sendEmail(...)` call inside `createTicket`, `generateForDate`, or `markOverdueTickets` in `Code.gs` — user emails are already in the Users sheet. For WhatsApp, call a provider API (e.g., a WhatsApp Business API vendor) with `UrlFetchApp` from the same places.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| "Backend not configured" | Paste your `/exec` URL into `CONFIG.API_URL` in script.js |
| Login fails for a valid user | Check Status = `Active` and the Access Code column; emails are case-insensitive |
| Recurring tickets not appearing | Confirm the `dailyScheduler` trigger exists, the template is `Active`, and today is inside its start/end window |
| Times look wrong | Set the Apps Script project timezone (step 2.3) and redeploy |
| Changes to Code.gs not taking effect | You must deploy a **New version** (step 3.6) |
