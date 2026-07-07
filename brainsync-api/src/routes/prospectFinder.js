const express  = require('express');
const router   = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('admin', 'staff'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// A resumable session older than this is treated as stale — GET /session
// returns null past this point, so the frontend shows a fresh intake form
// instead of a "resume?" banner for something from days ago.
const RESUME_WINDOW_HOURS = 24;

// Gate: the org must have purchased the add-on. Separate from the role
// check above — an admin in a non-subscribed org still gets blocked here,
// same spirit as the seat_limit check in users.js gating on a plan
// attribute rather than a role.
async function requireProspectFinderEnabled(req, res, next) {
  try {
    const { data: org, error } = await req.userClient
      .from('organizations')
      .select('prospect_finder_enabled')
      .eq('id', req.user.organization_id)
      .single();

    if (error) throw error;
    if (!org?.prospect_finder_enabled) {
      return res.status(403).json({ error: 'Prospect Finder is not enabled for your organization. Contact support to add it.' });
    }
    next();
  } catch (err) { next(err); }
}
router.use(requireProspectFinderEnabled);

// System prompt for every /chat turn. Forces strict JSON so the API layer
// never has to guess at parsing free-form prose, and explicitly tells the
// model when it should search vs. just filter/re-rank what it already has
// — this is what keeps "exclude ones over $5k" from burning a search
// credit when it's really just a filter on existing results.
const SYSTEM_PROMPT = `You are the Prospect Finder assistant inside ExpoPilot, a conference/trade-show management tool. You help a business discover real conferences, trade shows, and industry events worth exhibiting at, sponsoring, or speaking at.

Respond with ONLY valid JSON — no markdown code fences, no preamble, no text outside the JSON object. Shape:
{
  "reply": "<short, natural-language message for the chat panel — 1-3 sentences>",
  "results": [
    {
      "name": "string",
      "dates": "string, e.g. 'March 12-14, 2027'",
      "location": "string, city/state or venue",
      "industry": "string",
      "estimated_attendance": "string, e.g. '3,000-5,000 attendees' or 'Unknown'",
      "attendee_profile": "string describing typical attendee/company types",
      "cost_snapshot": { "exhibit": "string or null", "sponsor": "string or null", "speaker": "string or null" },
      "application_deadline": "string or null",
      "fit_rationale": "string — 1 sentence on why this matches the business profile",
      "source_links": ["https://..."]
    }
  ],
  "thin_results_note": "string explaining why few/no strong matches were found, or null if results are solid"
}

Rules:
- Every conference in "results" MUST come from real web search results. Never invent, guess, or hallucinate a conference, its dates, or its costs. If you can't verify something is real and current, leave it out entirely rather than including it with uncertain info.
- Always include "source_links" for anything you did find via search, so the person can verify it themselves.
- If the incoming message is a pure filter/refinement of the CURRENT RESULT SET you're given (e.g. "exclude ones over $5k", "just show ones in the Midwest", "sort by attendance") and you already have enough information to answer from that existing data, do NOT search — just filter/re-rank/re-describe the existing results and return that same set (filtered).
- Only perform a new search when the request genuinely needs new information (broader criteria, "find more like this", a different industry angle, etc.).
- If a note in the user message says the organization is out of searches for this period, do not attempt to search under any circumstance — only work with the existing result set, and say so plainly in "reply" if their request would have required a new search.`;

// GET /api/prospect-finder/session — resume check. Returns the user's
// session row if one exists AND it's within the resume window, otherwise
// null (frontend treats null as "start fresh").
router.get('/session', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('prospect_finder_sessions')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json(null);

    const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3600000;
    if (ageHours > RESUME_WINDOW_HOURS) return res.json(null);

    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/prospect-finder/session — start a fresh search. Upserts on
// user_id, so this always overwrites any prior session rather than
// growing a history — matches the "one resumable session at a time"
// decision.
router.post('/session', async (req, res, next) => {
  try {
    const { profile } = req.body;
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: 'profile is required' });
    }

    const { data, error } = await req.userClient
      .from('prospect_finder_sessions')
      .upsert({
        user_id: req.user.id,
        organization_id: req.user.organization_id,
        profile,
        filter_history: [],
        results: [],
        chat_transcript: [],
        searches_used: 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// POST /api/prospect-finder/chat — the core conversational endpoint.
// Loads the existing session, checks/rolls over the org's monthly search
// cap, calls Claude (with or without the web_search tool depending on
// remaining budget), parses the structured JSON reply, persists the
// updated session, and only increments the org's search counter if a
// search actually happened this turn.
router.post('/chat', async (req, res, next) => {
  try {
    // filterLabel is optional — sent by the frontend when the message
    // came from a quick-action filter chip (e.g. "Under $5k") rather than
    // free-text chat. When present, it gets appended to filter_history so
    // it shows up as a removable chip in the UI on reload/resume, distinct
    // from the free-text chat_transcript.
    const { message, filterLabel } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const { data: session, error: sessionError } = await req.userClient
      .from('prospect_finder_sessions')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (sessionError) throw sessionError;
    if (!session) return res.status(404).json({ error: 'No active session — start a new search first.' });

    const { data: org, error: orgError } = await req.userClient
      .from('organizations')
      .select('prospect_search_limit, prospect_searches_used, prospect_search_reset_at')
      .eq('id', req.user.organization_id)
      .single();
    if (orgError) throw orgError;

    let { prospect_search_limit: limit, prospect_searches_used: used, prospect_search_reset_at: resetAt } = org;

    // Monthly rollover check, done inline rather than via a cron job —
    // same "check on use, not on schedule" approach as elsewhere in this
    // app's usage tracking.
    const today = new Date().toISOString().slice(0, 10);
    if (resetAt && resetAt <= today) {
      used = 0;
      const nextReset = new Date();
      nextReset.setMonth(nextReset.getMonth() + 1);
      resetAt = nextReset.toISOString().slice(0, 10);
      await req.userClient
        .from('organizations')
        .update({ prospect_searches_used: 0, prospect_search_reset_at: resetAt })
        .eq('id', req.user.organization_id);
    }

    const searchBudgetRemaining = used < limit;
    const transcript = session.chat_transcript || [];

    const promptParts = [
      `Business profile: ${JSON.stringify(session.profile)}`,
      `Filter history applied so far: ${JSON.stringify(session.filter_history || [])}`,
      `Current result set: ${JSON.stringify(session.results || [])}`,
    ];
    if (transcript.length) {
      promptParts.push(`Prior conversation:\n${transcript.map(t => `${t.role}: ${t.content}`).join('\n')}`);
    }
    promptParts.push(`New user message: ${message}`);
    if (!searchBudgetRemaining) {
      promptParts.push(`NOTE: This organization has used all ${limit} searches for this billing period. Do not search — only filter, sort, or discuss the existing "Current result set" above.`);
    }

    const tools = searchBudgetRemaining ? [{ type: 'web_search_20250305', name: 'web_search' }] : [];

    console.log(`[prospect-finder] chat request starting — user=${req.user.id} searchBudgetRemaining=${searchBudgetRemaining}`);
    const startedAt = Date.now();

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: promptParts.join('\n\n') }],
      ...(tools.length ? { tools } : {}),
    }, { timeout: 90000 }); // fail after 90s instead of hanging indefinitely

    console.log(`[prospect-finder] chat request completed in ${Date.now() - startedAt}ms`);

    const usedSearchThisTurn = response.content.some(
      block => block.type === 'server_tool_use' || block.type === 'web_search_tool_result'
    );

    const textBlock = response.content.find(b => b.type === 'text');
    let parsed;
    try {
      const cleaned = (textBlock?.text || '').trim().replace(/^```json\s*|```$/g, '');
      parsed = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: 'Prospect Finder had trouble formatting a response — try rephrasing your request.' });
    }

    const newTranscript = [...transcript, { role: 'user', content: message }, { role: 'assistant', content: parsed.reply }];
    const finalUsed = usedSearchThisTurn ? session.searches_used + 1 : session.searches_used;
    const newFilterHistory = filterLabel
      ? [...(session.filter_history || []), filterLabel]
      : (session.filter_history || []);

    const { data: updatedSession, error: updateError } = await req.userClient
      .from('prospect_finder_sessions')
      .update({
        results: parsed.results || [],
        chat_transcript: newTranscript,
        filter_history: newFilterHistory,
        searches_used: finalUsed,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (updateError) throw updateError;

    if (usedSearchThisTurn) {
      await req.userClient
        .from('organizations')
        .update({ prospect_searches_used: used + 1 })
        .eq('id', req.user.organization_id);
    }

    res.json({
      reply: parsed.reply,
      results: parsed.results || [],
      thin_results_note: parsed.thin_results_note || null,
      session: updatedSession,
      search_credit_used: usedSearchThisTurn,
      searches_remaining: Math.max(0, limit - finalUsed),
    });
  } catch (err) { next(err); }
});

// DELETE /api/prospect-finder/filters/:index — removes one entry from the
// filter history log. Just edits the log itself; if removing a filter
// should also change the visible results, the frontend follows this with
// a normal /chat message asking to reconsider without it — kept as two
// separate steps rather than one endpoint trying to do both.
router.delete('/filters/:index', async (req, res, next) => {
  try {
    const index = parseInt(req.params.index, 10);
    const { data: session, error: sessionError } = await req.userClient
      .from('prospect_finder_sessions')
      .select('filter_history')
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (sessionError) throw sessionError;
    if (!session) return res.status(404).json({ error: 'No active session' });

    const updatedHistory = (session.filter_history || []).filter((_, i) => i !== index);

    const { data, error } = await req.userClient
      .from('prospect_finder_sessions')
      .update({ filter_history: updatedHistory, updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/prospect-finder/add-to-prospects — creates a real conferences
// row (status = 'prospect') from a card the person has decided to save.
// This is what makes "same object, early stage" concrete: the row created
// here is a genuine conferences record, just with prospect-only fields
// populated and status set accordingly, so promoting it later is a status
// change, not a data migration.
router.post('/add-to-prospects', async (req, res, next) => {
  try {
    const card = req.body;
    if (!card?.name) return res.status(400).json({ error: 'A conference name is required' });

    const { data, error } = await req.userClient
      .from('conferences')
      .insert({
        name: card.name,
        status: 'prospect',
        fit_rationale: card.fit_rationale || null,
        source_links: card.source_links || [],
        estimated_attendance: parseInt(card.estimated_attendance, 10) || null,
        attendee_profile: card.attendee_profile || null,
        cost_snapshot: card.cost_snapshot || null,
        application_deadline: card.application_deadline || null,
        notes: `Location: ${card.location || 'Unknown'}\nDates: ${card.dates || 'Unknown'}\n\nAdded via Prospect Finder.`,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// POST /api/prospect-finder/promote/:conferenceId — flips a prospect into
// a real, in-progress conference. A one-way status change, not a copy —
// nothing about the row's identity changes, so anything filled in at the
// Prospect stage (fit_rationale, source_links, etc.) carries forward.
router.post('/promote/:conferenceId', async (req, res, next) => {
  try {
    const { data: conference, error: fetchError } = await req.userClient
      .from('conferences')
      .select('id, status')
      .eq('id', req.params.conferenceId)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!conference) return res.status(404).json({ error: 'Conference not found' });
    if (conference.status !== 'prospect') {
      return res.status(400).json({ error: 'Only prospects can be promoted' });
    }

    const { data, error } = await req.userClient
      .from('conferences')
      .update({ status: 'planning' })
      .eq('id', req.params.conferenceId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

module.exports = router;
