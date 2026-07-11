require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
 
const conferencesRouter = require('./routes/conferences');
const leadsRouter       = require('./routes/leads');
const syncRouter        = require('./routes/sync');
const assetsRouter      = require('./routes/assets');
const assetCatalogRouter = require('./routes/asset-catalog');
const tasksRouter       = require('./routes/tasks');
const usersRouter       = require('./routes/users');
const visionRouter      = require('./routes/vision');
const shiftsRouter      = require('./routes/shifts');
const signupRouter      = require('./routes/signup');
const stripeRouter        = require('./routes/stripe');
const stripeWebhookRouter = require('./routes/stripeWebhook');
const organizationsRouter = require('./routes/organizations');
const platformRouter      = require('./routes/platform');
const integrationsRouter  = require('./routes/integrations');
const prospectFinderRouter = require('./routes/prospectFinder');
const feedbackRouter      = require('./routes/feedback');
const apiKeysRouter       = require('./routes/apiKeys');

const { startSyncJob } = require('./jobs/hubspotSync');
const { startCrmSyncJob } = require('./jobs/crmSync');
 
const app = express();
 
// ── Security middleware ─────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    process.env.ADMIN_URL,
    process.env.SIGNUP_URL,
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:5174',
  ],
  credentials: true,
}));
 
// Rate limiting — 120 req/min per IP.
// Stripe's webhook is exempted (see `skip` below): it's already
// authenticated by signature verification in stripeWebhook.js, not by
// this limiter, and there's a real downside to throttling it — if Stripe
// ever needs to retry a burst of events (e.g. after a temporary outage),
// getting rate-limited here would make Stripe see failures and back off,
// which could delay critical billing state updates (cancellations,
// failed payments) reaching the database. No matching upside, since the
// route's real security is the signature check, not shared request volume.
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/stripe/webhook'),
}));
 
// Tighter rate limit specifically for signup — this is the one public,
// unauthenticated write endpoint in the API, so it's worth limiting
// separately from normal traffic to make bulk/automated org creation
// harder.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts from this network. Please try again later.' },
});
 
// ── Stripe webhook — MUST be mounted before express.json() ────────
// Stripe signs the raw request body; if express.json() parses it first,
// the signature check in stripeWebhook.js will always fail. express.raw()
// hands the handler an untouched Buffer instead of a parsed object.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookRouter);
 
app.use(express.json({ limit: '8mb' }));
 
// ── Health check (no auth required) ─────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});
 
// ── API routes ───────────────────────────────────────────────────
app.use('/api/conferences', conferencesRouter);
app.use('/api/leads',       leadsRouter);
app.use('/api/sync',        syncRouter);
app.use('/api/assets',      assetsRouter);
app.use('/api/asset-catalog', assetCatalogRouter);
app.use('/api/tasks',       tasksRouter);
app.use('/api/users',       usersRouter);
app.use('/api/vision',      visionRouter);
app.use('/api/shifts',      shiftsRouter);
app.use('/api/signup',      signupLimiter, signupRouter);
app.use('/api/stripe',      stripeRouter);
app.use('/api/organizations', organizationsRouter);
app.use('/api/platform',    platformRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/prospect-finder', prospectFinderRouter);
app.use('/api/feedback',    feedbackRouter);
app.use('/api/api-keys',    apiKeysRouter);
 
// ── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});
 
// ── Global error handler ─────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message, err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});
 
// ── Start server ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BrainSync API running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    startSyncJob();
    console.log('HubSpot sync job scheduled');
    startCrmSyncJob();
    console.log('CRM integrations sync job scheduled');
  }
});
