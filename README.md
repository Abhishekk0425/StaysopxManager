# Stayopx Manager

UniLiv's internal ticketing and daily work-log system. Managers assign and schedule work, employees update their tasks and submit an end-of-day log, and the dashboard shows what needs attention today.

Live app: _add your link here_

## What it does

**For managers (Admin)**

- Create and assign tickets with priority, department, scheduled date and time, and due date
- Set up recurring tickets (daily, weekly, monthly) that are generated automatically every morning
- Dashboard with a one-line summary of the day, today's progress, overdue tickets (oldest first), active work by priority, team workload per person, what is coming up today, and who has not submitted their EOD log
- Click any dashboard card or team member to open the matching ticket list
- Review the team's EOD logs by date and employee, and submit their own EOD log
- Reports by employee and department, with CSV export
- Add, deactivate and reactivate team members
- Change statuses, priorities, departments and the EOD cutoff time from Settings; run the performance check and maintenance jobs (archive, expire, fix dates) from the same page

**For employees**

- Dashboard with today's progress, the next task to work on, and unfinished work carried over from earlier days
- Create tickets for themselves for work nobody assigned (marked "Self-created" so managers can see it), and cancel those tickets if raised by mistake
- Start and complete tickets in one click, change status, add comments
- Submit one end-of-day work log per day, editable until the cutoff (default 11:00 PM), with a button that fills in today's ticket titles
- In-app alerts for new tickets, tasks due within the hour, overdue tickets and a pending EOD log
- Reset a forgotten access code from the login screen, using a 6-digit code sent to their work email

**Built in**

- Every status change and comment is kept in an activity timeline that is never overwritten
- Tickets past their due date and time are marked Overdue automatically, every hour
- Employees can only see and update their own tickets, and tickets they create are always assigned to themselves; this is checked on the server, not only on screen
- Dark and light themes (dark by default, switch from the top bar; to change the default, edit `DEFAULT_THEME` at the top of `script.js` and the matching word in the small script near the top of `index.html`)
- The dashboard refreshes itself every 5 minutes while it is open

## How it works

```
Browser (index.html, script.js, style.css)
        │  signed-in requests
        ▼
Google Apps Script web app (Code.gs)
        │
        ▼
Google Sheet (the database)
```

There is no separate server or SQL database. The front end is three static files that can be hosted anywhere. The Google Sheet ID never reaches the browser; the front end only knows the Apps Script web app URL.

**Keeping it fast**

- The dashboard is a single request. The reply carries only unfinished tickets and today's tickets (no descriptions), plus totals computed on the server.
- Read results are cached on the server for up to 2 minutes and thrown away the moment anything is written through the app, so a whole team opening the dashboard at 9am reads the sheet once.
- Ticket and EOD lists load the last 45 / 30 days by default, with a "Show older" link for everything else. Long lists are shown 150 rows at a time.
- Opening a ticket, changing a status or adding a comment looks the row up directly instead of downloading the whole tab.
- Coming back to the dashboard paints instantly from the last reply, then refreshes quietly in the background.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell: login screen, sidebar, top bar, modals |
| `script.js` | The whole front-end app. The Apps Script URL is set in `CONFIG.API_URL` at the top |
| `style.css` | Design tokens and all styling |
| `Code.gs` | Backend. It lives in the Apps Script editor attached to the Google Sheet. Keep it in this repository only if the repository is private |

## Setup

1. Create a blank Google Sheet. Open **Extensions → Apps Script** and paste in `Code.gs`.
2. In **Project Settings**, set the time zone to `Asia/Kolkata`. All scheduling depends on it.
3. Run the function `setupDatabase` once and authorize it. It creates the six tabs, the default settings and a first admin account.
4. Open the **Users** tab. The first admin's email and access code are in row 2. Change both before sharing the app.
5. **Deploy → New deployment → Web app**, with Execute as **Me** and access **Anyone**. Copy the URL ending in `/exec`.
6. Paste that URL into `CONFIG.API_URL` at the top of `script.js`.
7. Host `index.html`, `script.js` and `style.css` on GitHub Pages, Vercel or Netlify.
8. In Apps Script, open **Triggers** and add two time-driven triggers:

| Function | Runs | Purpose |
|---|---|---|
| `dailyScheduler` | Every day, 5am to 6am | Creates today's tickets from active recurring templates |
| `markOverdueTickets` | Every hour | Marks late tickets as Overdue |
| `expireOverdueRecurring` | Daily (optional) | Marks recurring tickets still Overdue more than `EXPIRE_AFTER_DAYS` (default 14) after their due date as **Expired** so they stop piling up; Reports count them as missed |
| `archiveOldTickets` | Weekly (recommended) | Moves Completed/Cancelled tickets older than `ARCHIVE_AFTER_DAYS` (default 60) to the **Tickets Archive** tab so the live tab stays small. Reports still include archived tickets |

## Updating the app

**Front end** (`index.html`, `script.js`, `style.css`): upload the new files to this repository with **Add file → Upload files** and commit. Always upload `index.html` together with `script.js`: it references `script.js?v=…`, and that version number is what makes browsers and GitHub Pages fetch the new file instead of a cached copy. The login screen shows the page version ("app v2.3.1") and the dashboard shows both page and backend versions.

**Backend** (`Code.gs`): paste the new code into the Apps Script editor, run `setupDatabase` once (it only adds anything that is missing, such as new settings or the archive tab), then **Deploy → Manage deployments → edit → New version → Deploy**. The URL stays the same. Without a new version, the change does not go live.

If the new `Code.gs` uses a Google service the old one did not (the access code reset sends email, for example), run the function `authorizeEmail` once from the editor and accept the permission prompt before deploying the new version.

## Google Sheet tabs

| Tab | Holds |
|---|---|
| Users | Accounts, roles, status and access codes |
| Tickets | Every ticket, including those generated from recurring templates |
| Recurring Tickets | Templates only |
| Ticket Activity | The audit trail |
| EOD Logs | One row per employee per day |
| Settings | App configuration |
| Tickets Archive | Old finished tickets moved out of the live tab by `archiveOldTickets` (created on first run) |

Ticket IDs look like `TKT-10001`, recurring templates `RT-1`, EOD logs `EOD-70001`. Dates are stored as `yyyy-MM-dd` text and times as `HH:mm`, so they never shift with time zones.

## Security notes

- Access codes are stored as plain text in the Users tab. Share the Google Sheet only with people who should be able to see them.
- Reset codes are emailed only to the address already on file, last 10 minutes, work once, and are discarded after 5 wrong tries. They are never written to the sheet.
- Sessions expire after about 6 hours without activity.
- Deactivated users cannot sign in.
- If this repository is public, keep `Code.gs` and the setup guide out of it.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Backend not configured" | Paste the `/exec` URL into `CONFIG.API_URL` in `script.js` |
| A valid user cannot sign in | Check that Status is `Active` and the Access Code is filled in the Users tab |
| Recurring tickets are not appearing | Check that the `dailyScheduler` trigger exists, the template is Active, and today is within its start and end dates |
| The reset email does not arrive | Check the person's email in the Users tab is a real inbox and their Status is `Active`, look in spam, and confirm `authorizeEmail` was run and a new version deployed. Reset emails are sent from the Google account that owns the script |
| Times look wrong | Set the Apps Script project time zone and deploy a new version |
| Changes to `Code.gs` have no effect | Deploy a **New version** |
| The dashboard looks unchanged after an update | Press Ctrl+F5 |
| The dashboard is slow, or shows "The backend is busy" | Admin → Settings → **Run performance check**. The report says which button fixes it: *Archive old finished tickets* (large tab), *Expire stale recurring tickets* (thousands of overdue recurring tickets), or *Fix date formats* (date-typed cells) |
| A change made directly in the Google Sheet does not show | Read results are cached for 2 minutes. Changes made through the app show immediately; edits made by hand in the sheet take up to 2 minutes |

## About

Internal tool built for UniLiv operations. Not intended for public distribution.
