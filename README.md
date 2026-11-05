# FEWA Beauty & Fashion College System

Student admissions, student portal, staff management, settings and reports for FEWA Beauty & Fashion College.
The pages run in the browser; `server.mjs` serves them at http://localhost:5600/ and keeps all data in
PostgreSQL (Supabase), with an optional two-way synced copy on a local PostgreSQL.

## Running it

1. Install [Node.js](https://nodejs.org).
2. Copy `db-config.example.json` to `db-config.json` and fill in the database details and passwords.
   (`db-config.json` is never uploaded to GitHub.)
3. Double-click `start-server.bat`. It installs what it needs the first time, starts the server and opens
   http://localhost:5600/. Keep its window open while using the system.

## Layout

| Path | What it is |
|---|---|
| `server.mjs` | Web server and data API; creates the tables, syncs the local copy |
| `database/*.sql` | Table definitions, one file per schema (students, settings, finance, staff, files) |
| `db.js` | Data access used by every page (talks to the server) |
| `auth.js` | Logins, staff rights, shared page parts |
| `StudentAdmissions.html` | Student Hub, documents, queries, finance, reports, settings |
| `Dashboard.html`, `NewStudents.html`, `Staff.html`, `StudentPortal.html`, `login.html`, `ChangePassword.html` | The other pages |
| `start-server.bat` | Starts the system on Windows |
