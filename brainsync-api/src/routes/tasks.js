const express  = require('express');
const router   = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/tasks?conference_id=xxx&phase=pre_show&status=open
router.get('/', async (req, res, next) => {
  try {
    let query = req.userClient
      .from('tasks')
      .select('*, users!tasks_assigned_to_fkey(full_name)')
      .order('due_date', { ascending: true });

    if (req.query.conference_id) query = query.eq('conference_id', req.query.conference_id);
    if (req.query.phase)         query = query.eq('phase', req.query.phase);
    if (req.query.status)        query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// POST /api/tasks — switched to req.userClient. Requires the matching
// "tasks: staff create assigned" RLS policy (added separately) so staff
// retain the ability to create tasks for conferences they're assigned
// to, while the tenant/assignment check now actually gets enforced.
router.post('/', async (req, res, next) => {
  try {
    const { conference_id, title, description, phase, assigned_to, due_date } = req.body;
    if (!conference_id || !title) {
      return res.status(400).json({ error: 'conference_id and title are required' });
    }

    const { data, error } = await req.userClient
      .from('tasks')
      .insert({ conference_id, title, description, phase: phase || 'pre_show', assigned_to, due_date })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id — switched to req.userClient so this can only
// affect a task the caller can see under RLS (their org, and for staff,
// only tasks assigned to them) — previously used the service-role
// client with no check at all.
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['title','description','phase','status','assigned_to','due_date'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // Auto-stamp completed_at when marking done
    if (updates.status === 'done') updates.completed_at = new Date().toISOString();

    const { data, error } = await req.userClient
      .from('tasks')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Task not found' });
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id — admin only. Switched to req.userClient so
// this can only affect a task in the caller's org.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await req.userClient.from('tasks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
