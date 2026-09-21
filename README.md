# Stayopx Manager

UniLiv's internal ticketing and daily work-log system. Managers assign and schedule work, employees update their tasks and submit an end-of-day log, and the dashboard shows what needs attention today.

Live app: _add your link here_

## What it does

**For managers (Admin)**

- Create and assign tickets with priority, department, scheduled date and time, and due date
- Set up recurring tickets (daily, weekly, monthly) that are generated automatically every morning
- Dashboard with today's progress, overdue tickets (oldest first), team workload per person, and who has not submitted their EOD log
- Click any dashboard card or team member to open the matching ticket list
- Review EOD logs by date and employee
- Reports by employee and department, with CSV export
- Add, deactivate and reactivate team members
- Change statuses, priorities, departments and the EOD cutoff time from Settings

**For employees**

- Dashboard with today's tasks, progress, and unfinished work carried over from earlier days
- Start and complete tickets in one click, change status, add comments
- Submit one end-of-day work log per day, editable until the cutoff (default 11:00 PM)
- In-app alerts for new tickets, tasks due within the hour, overdue tickets and a pending EOD log

**Built in**

- Every status change and comment is kept in an activity timeline that is never overwritten
- Tickets past their due date and time are marked Overdue automatically, every hour
- Employees can only see and update their own tickets; this is checked on the server, not only on screen

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

## Updating the app

**Front end** (`index.html`, `script.js`, `style.css`): upload the new files to this repository with **Add file → Upload files** and commit. The site republishes in a minute or two. Press Ctrl+F5 in the browser to load the new version.

**Backend** (`Code.gs`): paste the new code into the Apps Script editor, then **Deploy → Manage deployments → edit → New version → Deploy**. The URL stays the same. Without a new version, the change does not go live.

## Google Sheet tabs

| Tab | Holds |
|---|---|
| Users | Accounts, roles, status and access codes |
| Tickets | Every ticket, including those generated from recurring templates |
| Recurring Tickets | Templates only |
| Ticket Activity | The audit trail |
| EOD Logs | One row per employee per day |
| Settings | App configuration |

Ticket IDs look like `TKT-10001`, recurring templates `RT-1`, EOD logs `EOD-70001`. Dates are stored as `yyyy-MM-dd` text and times as `HH:mm`, so they never shift with time zones.

## Security notes

- Access codes are stored as plain text in the Users tab. Share the Google Sheet only with people who should be able to see them.
- Sessions expire after about 6 hours without activity.
- Deactivated users cannot sign in.
- If this repository is public, keep `Code.gs` and the setup guide out of it.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Backend not configured" | Paste the `/exec` URL into `CONFIG.API_URL` in `script.js` |
| A valid user cannot sign in | Check that Status is `Active` and the Access Code is filled in the Users tab |
| Recurring tickets are not appearing | Check that the `dailyScheduler` trigger exists, the template is Active, and today is within its start and end dates |
| Times look wrong | Set the Apps Script project time zone and deploy a new version |
| Changes to `Code.gs` have no effect | Deploy a **New version** |
| The dashboard looks unchanged after an update | Press Ctrl+F5 |

## About

Internal tool built for UniLiv operations. Not intended for public distribution.
