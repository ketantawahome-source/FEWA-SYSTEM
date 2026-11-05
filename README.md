# FEWA Beauty & Fashion College System

Student admissions, student portal, staff management, settings and reports for FEWA Beauty & Fashion College.
The pages run in the browser; `server.mjs` serves them and keeps all data in PostgreSQL (Supabase), with an
optional two-way synced copy on a local PostgreSQL. Logins are checked on the server, and each person only
gets the data they may see, so the system can be put online.

## Online (Microsoft Azure)

`.github/workflows/azure-webapp.yml` deploys the system to an Azure App Service web app on every push to
`main`. One-time setup:

1. In the [Azure portal](https://portal.azure.com): **Create a resource > Web App** with
   Publish **Code**, Runtime stack **Node 22 LTS**, Operating System **Linux**, region **North Europe**
   (near the Supabase database), and a name, e.g. `fewa-system` (the address becomes
   `https://<name>.azurewebsites.net`). The Free (F1) plan works for trying it out.
   If the name differs, change `AZURE_WEBAPP_NAME` in the workflow file.
2. In the web app: **Settings > Environment variables > Add** `DATABASE_URL`:
   ```
   postgresql://postgres.<project-ref>:<database-password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
   ```
   Also **Settings > Configuration**: HTTPS Only **On**; **Monitoring > Health check**: path `/api/health`.
3. In the web app: **Overview > Download publish profile**. In GitHub: **Settings > Secrets and variables >
   Actions > New repository secret** named `AZURE_WEBAPP_PUBLISH_PROFILE`, pasting the whole file.
   (If the download is greyed out: web app **Settings > Configuration > General settings > SCM Basic Auth
   Publishing Credentials: On**.)
4. In GitHub: **Actions > Deploy to Azure > Run workflow** (later pushes deploy by themselves).

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
| `.github/workflows/azure-webapp.yml` | Online hosting on Microsoft Azure App Service |
