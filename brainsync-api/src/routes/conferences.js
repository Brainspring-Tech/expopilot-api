const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const { sendDiscussionCommentAlert } = require('../services/email');
const { notifyIfEnabled } = require('../services/notifications');

// Recipients for a new discussion post = staff assigned to this
// conference UNION org admins (the schema has no per-conference admin,
// so "admin of" a conference maps to org-level role='admin') — minus the
// comment's own author.
async function notifyDiscussionPost(req, { conferenceId, authorId, authorName, commentBody }) {
  const { data: conf } = await req.userClient
    .from('conferences')
    .select('name, organization_id')
    .eq('id', conferenceId)
    .single();
  if (!conf) return;

  const [{ data: assignments }, { data: admins }] = await Promise.all([
    req.userClient.from('staff_assignments').select('user_id').eq('conference_id', conferenceId),
    req.userClient.from('users').select('id').eq('organization_id', conf.organization_id).eq('role', 'admin'),
  ]);

  const recipientIds = new Set([
    ...(assignments || []).map(a => a.user_id),
    ...(admins || []).map(a => a.id),
  ]);
  recipientIds.delete(authorId);

  for (const userId of recipientIds) {
    notifyIfEnabled(userId, 'discussion_comment', recipient => sendDiscussionCommentAlert({
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      conferenceId,
      conferenceName: conf.name,
      authorName,
      commentBody,
    }));
  }
}

router.use(requireAuth);

// GET /api/conferences — list all (admin) or assigned (staff).
// Optional ?status=planning or ?status=planning,active (comma-separated)
// includes only those statuses. Optional ?exclude_status=prospect (also
// comma-separated) excludes those instead — used by the PWA's conference
// picker so prospect-stage conferences don't show up there, without
// needing to enumerate every other status. Omitting both params preserves
// the old unfiltered behavior (the admin console wants to see everything,
// including prospects, so it never passes either param).
router.get('/', async (req, res, next) => {
  try {
    const client = req.userClient;
    let query = client
      .from('conferences')
      .select('*')
      .order('start_date', { ascending: false });

    if (req.query.status) {
      const statuses = req.query.status.split(',').map(s => s.trim()).filter(Boolean);
      query = statuses.length > 1 ? query.in('status', statuses) : query.eq('status', statuses[0]);
    }

    if (req.query.exclude_status) {
      const excluded = req.query.exclude_status.split(',').map(s => s.trim()).filter(Boolean);
      query = excluded.length > 1
        ? query.not('status', 'in', `(${excluded.join(',')})`)
        : query.neq('status', excluded[0]);
    }

    const { data, error } = await query;

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/conferences/roi — ROI summary view
router.get('/roi', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conference_roi_summary')
      .select('*')
      .order('start_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// GET /api/conferences/budget-summary — org-wide budget rollup for the
// Dashboard. Must stay registered ahead of GET /:id below — as a
// single-segment wildcard, /:id would otherwise shadow this literal
// path (same class of bug already hit twice in users.js and
// leads-adjacent routes: a wildcard registered first swallows a
// same-method literal route registered after it).
//
// Two independent scopes, matching what was actually asked for:
//   - totals/byCategory: all-time across every confirmed/active/completed
//     conference (no date restriction) — the "budget summary" card.
//   - monthly: cumulative running totals for the org's CURRENT FISCAL
//     YEAR (organizations.fiscal_year_start_month, defaults to 1/January
//     — plain calendar year for orgs that never configured it) — the
//     "fiscal period" trend chart. Budgeted cumulative adds a
//     conference's full budget at its start_date; actual cumulative adds
//     each expense at its own expense_date (which can fall well before
//     or after the conference itself — e.g. paying for a hotel weeks
//     ahead of the event).
router.get('/budget-summary', async (req, res, next) => {
  try {
    const { data: confs, error: confError } = await req.userClient
      .from('conferences')
      .select('id, budget, start_date')
      .in('status', ['confirmed', 'active', 'completed']);
    if (confError) throw confError;

    const totalBudget = (confs || []).reduce((s, c) => s + Number(c.budget || 0), 0);
    const confIds = (confs || []).map(c => c.id);

    let expenses = [];
    if (confIds.length > 0) {
      const { data: expData, error: expError } = await req.userClient
        .from('conference_expenses')
        .select('amount, category, expense_date')
        .in('conference_id', confIds);
      if (expError) throw expError;
      expenses = expData || [];
    }

    const totalSpent = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

    const categoryTotals = {};
    for (const e of expenses) {
      const cat = e.category || 'misc';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + Number(e.amount || 0);
    }
    const byCategory = Object.entries(categoryTotals)
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total);

    const { data: org } = await req.userClient
      .from('organizations')
      .select('fiscal_year_start_month')
      .eq('id', req.user.organization_id)
      .maybeSingle();
    const fyStartMonth = org?.fiscal_year_start_month || 1; // 1-12, 1 = plain calendar year

    // Which fiscal year are we currently inside? If the current calendar
    // month hasn't reached the FY start month yet, we're still in the
    // fiscal year that began in the PREVIOUS calendar year.
    const now = new Date();
    const currentCalendarMonth = now.getMonth() + 1; // 1-12
    const fyStartCalendarYear = currentCalendarMonth >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = new Date(fyStartCalendarYear, fyStartMonth - 1, 1);
    const fyEnd   = new Date(fyStartCalendarYear + 1, fyStartMonth - 1, 0); // day before next FY starts

    const confsThisFY = (confs || []).filter(c => c.start_date && new Date(c.start_date) >= fyStart && new Date(c.start_date) <= fyEnd);
    const expensesThisFY = expenses.filter(e => e.expense_date && new Date(e.expense_date) >= fyStart && new Date(e.expense_date) <= fyEnd);

    const monthly = Array.from({ length: 12 }, (_, i) => {
      const monthIndex0 = (fyStartMonth - 1 + i) % 12; // 0-11
      const slotYear = fyStartCalendarYear + Math.floor((fyStartMonth - 1 + i) / 12);
      const monthEnd = new Date(slotYear, monthIndex0 + 1, 0); // last calendar day of that slot's month
      const budgetedCumulative = confsThisFY
        .filter(c => new Date(c.start_date) <= monthEnd)
        .reduce((s, c) => s + Number(c.budget || 0), 0);
      const actualCumulative = expensesThisFY
        .filter(e => new Date(e.expense_date) <= monthEnd)
        .reduce((s, e) => s + Number(e.amount || 0), 0);
      return { month: `${slotYear}-${String(monthIndex0 + 1).padStart(2, '0')}`, budgetedCumulative, actualCumulative };
    });

    const fmtMonthYear = d => d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const periodLabel = fyStartMonth === 1
      ? String(fyStartCalendarYear)
      : `${fmtMonthYear(fyStart)} – ${fmtMonthYear(fyEnd)}`;

    res.json({
      totalBudget,
      totalSpent,
      remaining: totalBudget - totalSpent,
      byCategory,
      monthly,
      periodLabel,
    });
  } catch (err) { next(err); }
});

// GET /api/conferences/:id — single conference with staff + asset counts + attachments
router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conferences')
      .select(`
        *,
        staff_assignments ( id, role, user_id, arrival_date, departure_date, arrival_flight,
                             departure_flight, hotel_name, hotel_confirmation, travel_notes,
                             users(full_name, email, job_title, phone, avatar_url) ),
        booth_assets ( id, name, category, status, quantity ),
        tasks ( id, title, phase, status, due_date, is_important ),
        conference_budgets ( category, budgeted, actual ),
        conference_attachments ( id, file_name, file_url, file_type, file_size, created_at, users(full_name) ),
        conference_comments ( id )
      `)
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conference not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/conferences — admin only. CRITICAL FIX: organization_id was
// never set on the insert, which has been silently broken since Phase 1
// made that column NOT NULL — every attempt to create a new conference
// has been failing. Also switched to req.userClient for tenant isolation.
router.post('/', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, venue, city, state, start_date, end_date, budget, notes, website_url } = req.body;
    if (!name || !start_date || !end_date) {
      return res.status(400).json({ error: 'name, start_date, and end_date are required' });
    }

    const { data, error } = await req.userClient
      .from('conferences')
      .insert({
        name, venue, city, state, start_date, end_date, budget, notes, website_url,
        created_by: req.user.id,
        organization_id: req.user.organization_id,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/conferences/:id — admin only. Switched to req.userClient so
// this can only affect a conference in the caller's org.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = ['name','venue','city','state','start_date','end_date','budget','status','notes','hubspot_deal_id','website_url'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('conferences')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conference not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/conferences/:id — admin only. Switched to req.userClient.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient
      .from('conferences')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/conferences/:id/budget — upsert budget line items. Switched
// to req.userClient so this can only affect budgets on a conference in
// the caller's org.
router.post('/:id/budget', requireRole('admin'), async (req, res, next) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }

    const rows = items.map(i => ({ ...i, conference_id: req.params.id }));
    const { data, error } = await req.userClient
      .from('conference_budgets')
      .upsert(rows, { onConflict: 'conference_id,category' })
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// ── Attachments ──────────────────────────────────────────────

// GET /api/conferences/:id/attachments
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conference_attachments')
      .select('*, users(full_name)')
      .eq('conference_id', req.params.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/conferences/:id/attachments — add a link (or record after
// direct upload). Switched to req.userClient.
router.post('/:id/attachments', requireRole('admin'), async (req, res, next) => {
  try {
    const { file_name, file_url, file_type, file_size } = req.body;
    if (!file_name || !file_url) {
      return res.status(400).json({ error: 'file_name and file_url are required' });
    }

    const { data, error } = await req.userClient
      .from('conference_attachments')
      .insert({
        conference_id: req.params.id,
        file_name, file_url, file_type, file_size,
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// DELETE /api/conferences/:id/attachments/:attachmentId — switched to req.userClient.
router.delete('/:id/attachments/:attachmentId', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient
      .from('conference_attachments')
      .delete()
      .eq('id', req.params.attachmentId)
      .eq('conference_id', req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Discussion ───────────────────────────────────────────────

// GET /api/conferences/:id/comments
router.get('/:id/comments', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conference_comments')
      .select('*, users(full_name, avatar_url)')
      .eq('conference_id', req.params.id)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/conferences/:id/comments — any org member (not just admin)
// can post, mirroring how staff can already create tasks. RLS is the
// real tenant-isolation boundary here (see the "org insert" policy on
// conference_comments), same as everywhere else in this file.
router.post('/:id/comments', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'body is required' });
    }

    const { data, error } = await req.userClient
      .from('conference_comments')
      .insert({
        conference_id: req.params.id,
        user_id: req.user.id,
        body: body.trim(),
      })
      .select('*, users(full_name, avatar_url)')
      .single();

    if (error) throw error;
    res.status(201).json(data);

    notifyDiscussionPost(req, {
      conferenceId: req.params.id,
      authorId: req.user.id,
      authorName: req.user.full_name,
      commentBody: body.trim(),
    });
  } catch (err) { next(err); }
});

// DELETE /api/conferences/:id/comments/:commentId — author or admin
// only. Explicit ownership check here as defense-in-depth, matching the
// pattern used for shifts/users elsewhere, even though the "author or
// admin delete" RLS policy should already enforce this.
router.delete('/:id/comments/:commentId', async (req, res, next) => {
  try {
    const { data: comment, error: lookupError } = await req.userClient
      .from('conference_comments')
      .select('user_id')
      .eq('id', req.params.commentId)
      .eq('conference_id', req.params.id)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (!comment) return res.status(404).json({ error: 'Comment not found' });

    const isAuthor = comment.user_id === req.user.id;
    const isAdmin  = req.user.role === 'admin';
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }

    const { error } = await req.userClient
      .from('conference_comments')
      .delete()
      .eq('id', req.params.commentId)
      .eq('conference_id', req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Expenses ─────────────────────────────────────────────────

// GET /api/conferences/:id/expenses
router.get('/:id/expenses', async (req, res, next) => {
  try {
    const { data, error } = await req.userClient
      .from('conference_expenses')
      .select('*, users(full_name)')
      .eq('conference_id', req.params.id)
      .order('expense_date', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/conferences/:id/expenses — switched to req.userClient.
router.post('/:id/expenses', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const { category, amount, expense_date, notes } = req.body;
    if (!category || amount === undefined) {
      return res.status(400).json({ error: 'category and amount are required' });
    }

    const { data, error } = await req.userClient
      .from('conference_expenses')
      .insert({
        conference_id: req.params.id,
        category, amount, expense_date, notes,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/conferences/:id/expenses/:expenseId — switched to req.userClient.
router.patch('/:id/expenses/:expenseId', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const allowed = ['category', 'amount', 'expense_date', 'notes'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await req.userClient
      .from('conference_expenses')
      .update(updates)
      .eq('id', req.params.expenseId)
      .eq('conference_id', req.params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Expense not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/conferences/:id/expenses/:expenseId — switched to req.userClient.
router.delete('/:id/expenses/:expenseId', requireRole('admin', 'staff'), async (req, res, next) => {
  try {
    const { error } = await req.userClient
      .from('conference_expenses')
      .delete()
      .eq('id', req.params.expenseId)
      .eq('conference_id', req.params.id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/conferences/:id/report/pdf — post-show recap report
router.get('/:id/report/pdf', async (req, res, next) => {
  try {
    const confId = req.params.id;

    const [confRes, leadsRes, budgetsRes, expensesRes, tasksRes, followUpsRes] = await Promise.all([
      req.userClient.from('conferences').select('*').eq('id', confId).single(),
      req.userClient.from('leads').select('*').eq('conference_id', confId),
      req.userClient.from('conference_budgets').select('*').eq('conference_id', confId),
      req.userClient.from('conference_expenses').select('*').eq('conference_id', confId),
      req.userClient.from('tasks').select('*').eq('conference_id', confId),
      req.userClient.from('leads')
        .select('id, first_name, last_name, follow_up_tasks(*, users!follow_up_tasks_assigned_to_fkey(full_name))')
        .eq('conference_id', confId),
    ]);

    if (confRes.error) throw confRes.error;
    if (!confRes.data) return res.status(404).json({ error: 'Conference not found' });
    if (leadsRes.error) throw leadsRes.error;
    if (budgetsRes.error) throw budgetsRes.error;
    if (expensesRes.error) throw expensesRes.error;
    if (tasksRes.error) throw tasksRes.error;
    if (followUpsRes.error) throw followUpsRes.error;

    const conf     = confRes.data;
    const leads    = leadsRes.data || [];
    const budgets  = budgetsRes.data || [];
    const expenses = expensesRes.data || [];
    const tasks    = tasksRes.data || [];

    // ── Compute stats ──
    const totalLeads  = leads.length;
    const hotLeads    = leads.filter(l => l.score >= 4).length;
    const avgScore    = totalLeads ? leads.reduce((s, l) => s + (l.score || 0), 0) / totalLeads : 0;
    const syncedCount = leads.filter(l => l.synced_to_hubspot).length;
    const topLeads    = [...leads].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);

    const totalBudgeted     = budgets.reduce((s, b) => s + Number(b.budgeted || 0), 0);
    const totalBudgetActual = budgets.reduce((s, b) => s + Number(b.actual || 0), 0);
    const totalExpenses     = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);

    const totalTasks     = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'done').length;
    const overdueTasks   = tasks.filter(t => t.due_date && new Date(t.due_date) < new Date() && t.status !== 'done').length;

    const followUps = [];
    (followUpsRes.data || []).forEach(l => {
      const leadName = [l.first_name, l.last_name].filter(Boolean).join(' ') || 'Unnamed lead';
      (l.follow_up_tasks || []).forEach(f => {
        followUps.push({
          leadName,
          action:      f.action,
          due_date:    f.due_date,
          assignedTo:  f.users?.full_name || 'Unassigned',
        });
      });
    });

    // ── Generate PDF ──
    const safeName = (conf.name || 'conference').replace(/[^a-z0-9]/gi, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_recap.pdf"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).fillColor('#000').text(`${conf.name} — Post-Show Recap`);
    doc.fontSize(11).fillColor('#555').text(
      `${conf.venue ? conf.venue + ' · ' : ''}${[conf.city, conf.state].filter(Boolean).join(', ')}`
    );
    doc.text(`${conf.start_date || '—'} → ${conf.end_date || '—'}`);
    doc.moveDown(1.5);

    doc.fillColor('#000').fontSize(14).text('Lead Capture Summary', { underline: true });
    doc.moveDown(0.5).fontSize(11);
    doc.text(`Total leads captured: ${totalLeads}`);
    doc.text(`Hot leads (score \u2265 4): ${hotLeads}`);
    doc.text(`Average lead score: ${avgScore.toFixed(1)} / 5`);
    doc.text(`Synced to HubSpot: ${syncedCount} / ${totalLeads}`);
    doc.moveDown(1);

    doc.fontSize(13).text('Top Leads by Interest Score');
    doc.moveDown(0.3).fontSize(10);
    if (topLeads.length === 0) {
      doc.text('No leads captured.');
    } else {
      topLeads.forEach(l => {
        const name = [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Unnamed';
        doc.text(`${name} — ${l.organization || '—'} — Score: ${l.score ?? '—'}/5`);
      });
    }
    doc.moveDown(1);

    doc.fontSize(14).text('Budget', { underline: true });
    doc.moveDown(0.5).fontSize(11);
    doc.text(`Total budgeted: $${totalBudgeted.toLocaleString()}`);
    doc.text(`Total budget actuals: $${totalBudgetActual.toLocaleString()}`);
    doc.text(`Total logged expenses: $${totalExpenses.toLocaleString()}`);
    if (budgets.length > 0) {
      doc.moveDown(0.5).fontSize(10);
      budgets.forEach(b => {
        doc.text(`${b.category}: budgeted $${Number(b.budgeted || 0).toLocaleString()}, actual $${Number(b.actual || 0).toLocaleString()}`);
      });
    }
    doc.moveDown(1);

    doc.fontSize(14).text('Task Completion', { underline: true });
    doc.moveDown(0.5).fontSize(11);
    doc.text(`${completedTasks} / ${totalTasks} tasks completed`);
    doc.text(`${overdueTasks} overdue`);
    doc.moveDown(1);

    doc.fontSize(14).text('Follow-Ups', { underline: true });
    doc.moveDown(0.5).fontSize(10);
    if (followUps.length === 0) {
      doc.text('No follow-ups logged.');
    } else {
      followUps.forEach(f => {
        doc.text(`${f.leadName} — ${f.action} — Due: ${f.due_date || '—'} — Assigned: ${f.assignedTo}`);
      });
    }

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
