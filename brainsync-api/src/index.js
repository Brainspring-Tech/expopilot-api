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

const { startSyncJob } = require('./jobs/hubspotSync');

const app = express();

// ── Security middleware ──────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    process.env.ADMIN_URL,
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:5174',
  ],
  credentials: true,
}));

// Rate limiting — 120 req/min per IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use(express.json({ limit: '8mb' }));

// ── Health check (no auth required) ─────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── API routes ───────────────────────────────────────────────
app.use('/api/conferences', conferencesRouter);
app.use('/api/leads',       leadsRouter);
app.use('/api/sync',        syncRouter);
app.use('/api/assets',      assetsRouter);
app.use('/api/asset-catalog', assetCatalogRouter);
app.use('/api/tasks',       tasksRouter);
app.use('/api/users',       usersRouter);
app.use('/api/vision',      visionRouter);
app.use('/api/shifts',      shiftsRouter);

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message, err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BrainSync API running on port ${PORT}`);
  if (process.env.NODE_ENV === 'production') {
    startSyncJob();
    console.log('HubSpot sync job scheduled');
  }
});
