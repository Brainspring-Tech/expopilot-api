# BrainSync API

Node.js / Express backend for the BrainSync conference management platform. Runs on Render (Starter plan, always-on).

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express
- **Database**: Supabase (Postgres + RLS)
- **Integrations**: HubSpot CRM, Microsoft Graph email, MailerLite
- **Hosting**: Render (web service)

## Project structure

```
src/
  index.js              — app entry point, middleware, route mounting
  middleware/
    auth.js             — JWT verification, role middleware
  routes/
    conferences.js      — conference CRUD + budget + ROI
    leads.js            — lead capture, batch upload, interactions, follow-ups
    assets.js           — booth asset tracking
    tasks.js            — pre/show/post task checklist
    sync.js             — HubSpot sync trigger + status
    users.js            — staff management + conference assignment
  services/
    supabase.js         — service-role Supabase client
    hubspot.js          — contact upsert, sync queue
    email.js            — Microsoft Graph email templates
  jobs/
    hubspotSync.js      — cron: sync every 15 min + daily lead summary
```

## Local development

```bash
cp .env.example .env
# Fill in all values in .env
npm install
npm run dev
```

Server starts on http://localhost:3000. Test with:

```bash
curl http://localhost:3000/health
```

## Deploying to Render

1. Push this folder to a GitHub repo (e.g. `Brainspring-Tech/brainsync-api`)
2. In Render → New → Web Service → connect the repo
3. Render detects `render.yaml` automatically
4. Add all environment variables in the Render dashboard (Environment tab)
5. Deploy — the health check at `/health` confirms it's running

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (Settings → API) |
| `HUBSPOT_ACCESS_TOKEN` | Private app token from HubSpot |
| `MS_TENANT_ID` | Azure AD tenant ID |
| `MS_CLIENT_ID` | Azure app client ID |
| `MS_CLIENT_SECRET` | Azure app client secret |
| `MS_SENDER_EMAIL` | orders@brainspring.com |
| `MAILERLITE_API_KEY` | MailerLite API key |
| `FRONTEND_URL` | Netlify URL of the React frontend |
| `API_SECRET_KEY` | Random 64-char string for internal use |

## HubSpot custom properties

Create these contact properties in your HubSpot portal before first sync:

| Internal name | Label | Type |
|---|---|---|
| `brainsync_conference` | Conference | Single-line text |
| `brainsync_interest_tags` | Interest tags | Single-line text |
| `brainsync_grade_levels` | Grade levels | Single-line text |
| `brainsync_lead_score` | Booth lead score | Single-line text |
| `brainsync_notes` | Booth notes | Multi-line text |

## API reference

### Auth
All routes (except `/health`) require:
```
Authorization: Bearer <supabase-jwt>
```
The JWT comes from Supabase Auth on the frontend (`supabase.auth.getSession()`).

### Conferences
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/conferences` | any | List conferences |
| GET | `/api/conferences/roi` | any | ROI summary view |
| GET | `/api/conferences/:id` | any | Single conference (with staff, assets, tasks) |
| POST | `/api/conferences` | admin | Create conference |
| PATCH | `/api/conferences/:id` | admin | Update conference |
| DELETE | `/api/conferences/:id` | admin | Delete conference |
| POST | `/api/conferences/:id/budget` | admin | Upsert budget line items |

### Leads
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/leads` | any | List leads (filterable) |
| GET | `/api/leads/:id` | any | Single lead + interactions + follow-ups |
| POST | `/api/leads` | any | Capture single lead |
| POST | `/api/leads/batch` | any | Batch upload (max 200, offline sync) |
| PATCH | `/api/leads/:id` | any | Update lead |
| POST | `/api/leads/:id/interactions` | any | Log touchpoint |
| POST | `/api/leads/:id/follow-ups` | any | Create follow-up task |

### Assets
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/assets` | any | List assets |
| POST | `/api/assets` | any | Add asset |
| PATCH | `/api/assets/:id` | any | Update status/tracking |
| DELETE | `/api/assets/:id` | admin | Delete asset |

### Tasks
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/tasks` | any | List tasks |
| POST | `/api/tasks` | any | Create task |
| PATCH | `/api/tasks/:id` | any | Update status |
| DELETE | `/api/tasks/:id` | admin | Delete task |

### Sync
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/sync/status` | any | Count of unsynced leads |
| POST | `/api/sync/run` | admin | Trigger full sync now |
| POST | `/api/sync/lead/:id` | admin | Sync single lead |

### Users
| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/users/me` | any | Current user profile |
| GET | `/api/users` | admin | List all staff |
| PATCH | `/api/users/:id/role` | admin | Change user role |
| POST | `/api/users/assign` | admin | Assign staff to conference |
| DELETE | `/api/users/assign` | admin | Remove staff from conference |
