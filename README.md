# FEWA Beauty & Fashion College System

Student admissions, student portal, staff management, settings and reports for FEWA Beauty & Fashion College.
The pages run in the browser; `server.mjs` serves them and keeps all data in PostgreSQL (Supabase), with an
optional two-way synced copy on a local PostgreSQL. Logins are checked on the server, and each person only
gets the data they may see, so the system can be put online.

## Online (Render.com)

`render.yaml` sets the system up on Render, deployed from this GitHub repository; every push updates it.
In Render: **New > Blueprint**, choose this repository, and enter `DATABASE_URL` when asked:

```
postgresql://postgres.<project-ref>:<database-password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
```

Create the first administrator account on the office computer first (setting up is never allowed online).

## On the office computer

1. Install [Node.js](https://nodejs.org).
2. Copy `db-config.example.json` to `db-config.json` and fill in the database details and passwords.
   (`db-config.json` is never uploaded to GitHub.)
3. Double-click `start-server.bat`. It installs what it needs the first time, starts the server and opens
   http://localhost:5600/. Keep its window open while using the system.

## Who can see what

| Logged in as | Can |
|---|---|
| Administrator | everything |
| Other staff | all student data and settings; not staff accounts or role rights |
| Student (AdmNo) | their own record, documents and deferrals; change their own password |
| Not logged in | the login page only |

## Layout

| Path | What it is |
|---|---|
| `server.mjs` | Web server, logins and data API; creates the tables, syncs the local copy |
| `database/*.sql` | Table definitions, one file per schema (students, settings, finance, staff, files) |
| `db.js` | Data access used by every page (talks to the server) |
| `auth.js` | Logins, staff rights, shared page parts |
| `StudentAdmissions.html` | Student Hub, documents, queries, finance, reports, settings |
| `Dashboard.html`, `NewStudents.html`, `Staff.html`, `StudentPortal.html`, `login.html`, `ChangePassword.html` | The other pages |
| `start-server.bat` | Starts the system on Windows |
| `render.yaml` | Online hosting on Render.com |
