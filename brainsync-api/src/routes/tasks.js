const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
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

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const { conference_id, title, description, phase, assigned_to, due_date } = req.body;
    if (!conference_id || !title) {
      return res.status(400).json({ error: 'conference_id and title are required' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({ conference_id, title, description, phase: phase || 'pre_show', assigned_to, due_date })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['title','description','phase','status','assigned_to','due_date'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // Auto-stamp completed_at when marking done
    if (updates.status === 'done') updates.completed_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:id — admin only
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
    if (error) throw error;
    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
