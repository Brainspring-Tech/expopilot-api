const cron     = require('node-cron');
const supabase = require('../services/supabase');
const {
  sendTaskDueReminder,
  sendShiftReminder,
  sendShippingDeadlineAlert,
  sendBudgetThresholdAlert,
  sendPostConferenceWrapup,
  sendInactivityNudge,
} = require('../services/email');
const { notifyIfEnabled } = require('../services/notifications');
const { recordCronRun } = require('../services/cronHealth');

// How many days out an asset's ship_by_date triggers a reminder.
const SHIPPING_REMINDER_DAYS = 3;
// A staff member assigned to a conference starting within this many days...
const INACTIVITY_WINDOW_DAYS = 7;
// ...gets nudged if they haven't logged in for at least this many days.
const INACTIVITY_THRESHOLD_DAYS = 14;

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function startDailyRemindersJob() {
  // 7am daily — ahead of the weekly digest's Monday 8am slot.
  cron.schedule('0 7 * * *', async () => {
    console.log('[cron] running daily reminders');
    const checks = [
      ['task due reminders',     checkTaskDueReminders],
      ['shift reminders',        checkShiftReminders],
      ['shipping deadlines',     checkShippingDeadlines],
      ['budget thresholds',      checkBudgetThresholds],
      ['post-conference wrapups', checkPostConferenceWrapups],
      ['inactivity nudges',      checkInactivityNudges],
    ];
    const failed = [];
    for (const [label, fn] of checks) {
      try {
        await fn();
      } catch (err) {
        console.error(`[cron] ${label} error:`, err.message);
        failed.push({ label, error: err.message });
      }
    }

    // Each of the 6 checks is already independently isolated (one
    // failing doesn't block the others), but the run as a whole is
    // still flagged as an error if any check failed — a platform
    // operator watching this page needs to know something broke, even
    // if the other 5 checks completed fine. Which check(s) failed are
    // named in the error message rather than just "something failed".
    await recordCronRun('daily_reminders', {
      success: failed.length === 0,
      error: failed.length > 0 ? failed.map(f => `${f.label}: ${f.error}`).join('; ') : undefined,
      summary: { checks: checks.length, failed: failed.map(f => f.label) },
    });
  });

  console.log('[cron] job scheduled: daily reminders (07:00)');
}

// Due-tomorrow and overdue-since-yesterday share one exact-date-match
// check each (rather than an open range), so a task only ever triggers
// this once per state instead of every day it stays open — same
// dedup-by-exact-match approach used for shift/shipping/wrapup below.
async function checkTaskDueReminders() {
  const tomorrow  = dateOffset(1);
  const yesterday = dateOffset(-1);

  const { data: dueSoon } = await supabase
    .from('tasks')
    .select('id, title, due_date, assigned_to, conference_id, conferences(name)')
    .eq('due_date', tomorrow)
    .neq('status', 'done')
    .not('assigned_to', 'is', null);

  const { data: overdue } = await supabase
    .from('tasks')
    .select('id, title, due_date, assigned_to, conference_id, conferences(name)')
    .eq('due_date', yesterday)
    .neq('status', 'done')
    .not('assigned_to', 'is', null);

  const tasks = [
    ...(dueSoon || []).map(t => ({ ...t, overdue: false })),
    ...(overdue || []).map(t => ({ ...t, overdue: true })),
  ];

  for (const task of tasks) {
    notifyIfEnabled(task.assigned_to, 'task_due_reminder', recipient => sendTaskDueReminder({
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      taskTitle: task.title,
      conferenceId: task.conference_id,
      conferenceName: task.conferences?.name || 'a conference',
      dueDate: task.due_date,
      overdue: task.overdue,
    }));
  }
}

async function checkShiftReminders() {
  const tomorrow = dateOffset(1);

  const { data: shifts } = await supabase
    .from('staff_shifts')
    .select('id, user_id, shift_date, start_time, end_time, conference_id, conferences(name, venue)')
    .eq('shift_date', tomorrow);

  for (const shift of (shifts || [])) {
    notifyIfEnabled(shift.user_id, 'shift_reminder', recipient => sendShiftReminder({
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      conferenceName: shift.conferences?.name || 'a conference',
      venue: shift.conferences?.venue,
      shiftDate: shift.shift_date,
      startTime: shift.start_time,
      endTime: shift.end_time,
    }));
  }
}

async function checkShippingDeadlines() {
  const targetDate = dateOffset(SHIPPING_REMINDER_DAYS);

  const { data: assets } = await supabase
    .from('booth_assets')
    .select('id, name, ship_by_date, conference_id, conferences(name, organization_id)')
    .eq('ship_by_date', targetDate)
    .in('status', ['pending', 'packed']);

  if (!assets || assets.length === 0) return;

  // One email per conference per admin, listing every asset due — not
  // one email per asset, which would spam admins on conferences with a
  // big shipping list.
  const byConf = {};
  for (const a of assets) {
    if (!byConf[a.conference_id]) {
      byConf[a.conference_id] = {
        name: a.conferences?.name,
        organizationId: a.conferences?.organization_id,
        assets: [],
      };
    }
    byConf[a.conference_id].assets.push(a);
  }

  for (const [confId, group] of Object.entries(byConf)) {
    const { data: admins } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', group.organizationId)
      .eq('role', 'admin');

    for (const admin of (admins || [])) {
      notifyIfEnabled(admin.id, 'shipping_deadline_reminder', recipient => sendShippingDeadlineAlert({
        adminEmail: recipient.email,
        conferenceId: confId,
        conferenceName: group.name || 'a conference',
        assets: group.assets.map(a => ({ name: a.name, ship_by_date: a.ship_by_date })),
      }));
    }
  }
}

async function checkBudgetThresholds() {
  const { data: confs } = await supabase
    .from('conferences')
    .select('id, name, budget, organization_id, budget_alert_level_sent')
    .not('budget', 'is', null)
    .gt('budget', 0)
    .in('status', ['confirmed', 'active']);

  for (const conf of (confs || [])) {
    const { data: expenses } = await supabase
      .from('conference_expenses')
      .select('amount')
      .eq('conference_id', conf.id);

    const spent = (expenses || []).reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const pct = (spent / Number(conf.budget)) * 100;

    // Monotonic — only fires on newly crossing a HIGHER threshold than
    // already alerted, never re-fires for staying above one already sent.
    let thresholdCrossed = null;
    if (pct >= 100 && conf.budget_alert_level_sent < 100) thresholdCrossed = 100;
    else if (pct >= 80 && conf.budget_alert_level_sent < 80) thresholdCrossed = 80;
    if (!thresholdCrossed) continue;

    await supabase.from('conferences').update({ budget_alert_level_sent: thresholdCrossed }).eq('id', conf.id);

    const { data: admins } = await supabase
      .from('users')
      .select('id')
      .eq('organization_id', conf.organization_id)
      .eq('role', 'admin');

    for (const admin of (admins || [])) {
      notifyIfEnabled(admin.id, 'budget_threshold_alert', recipient => sendBudgetThresholdAlert({
        adminEmail: recipient.email,
        conferenceId: conf.id,
        conferenceName: conf.name,
        thresholdPercent: thresholdCrossed,
        budget: conf.budget,
        spent,
      }));
    }
  }
}

async function checkPostConferenceWrapups() {
  const yesterday = dateOffset(-1);

  const { data: confs } = await supabase
    .from('conferences')
    .select('id, name')
    .eq('end_date', yesterday);

  for (const conf of (confs || [])) {
    const { count: total } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('conference_id', conf.id);

    const { count: hot } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('conference_id', conf.id)
      .gte('score', 4);

    const { data: assignments } = await supabase
      .from('staff_assignments')
      .select('user_id')
      .eq('conference_id', conf.id);

    for (const a of (assignments || [])) {
      notifyIfEnabled(a.user_id, 'post_conference_wrapup', recipient => sendPostConferenceWrapup({
        staffEmail: recipient.email,
        staffName: recipient.full_name,
        conferenceId: conf.id,
        conferenceName: conf.name,
        totalLeads: total || 0,
        hotLeads: hot || 0,
      }));
    }
  }
}

async function checkInactivityNudges() {
  const todayStr   = dateOffset(0);
  const windowEnd  = dateOffset(INACTIVITY_WINDOW_DAYS);

  const { data: confs } = await supabase
    .from('conferences')
    .select('id, name, start_date')
    .gte('start_date', todayStr)
    .lte('start_date', windowEnd);

  if (!confs || confs.length === 0) return;

  const confIds = confs.map(c => c.id);
  const { data: assignments } = await supabase
    .from('staff_assignments')
    .select('user_id, conference_id')
    .in('conference_id', confIds);

  if (!assignments || assignments.length === 0) return;

  // last_sign_in_at lives on Supabase Auth's own auth.users, not
  // public.users — only reachable via the Admin API, not a normal query.
  const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const lastSignInById = {};
  for (const u of (authList?.users || [])) {
    lastSignInById[u.id] = u.last_sign_in_at ? new Date(u.last_sign_in_at) : null;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INACTIVITY_THRESHOLD_DAYS);

  const confById = Object.fromEntries(confs.map(c => [c.id, c]));

  for (const a of assignments) {
    const lastSignIn = lastSignInById[a.user_id];
    const isInactive = !lastSignIn || lastSignIn < cutoff;
    if (!isInactive) continue;

    const conf = confById[a.conference_id];
    notifyIfEnabled(a.user_id, 'inactivity_nudge', recipient => sendInactivityNudge({
      staffEmail: recipient.email,
      staffName: recipient.full_name,
      conferenceName: conf.name,
      startDate: conf.start_date,
    }));
  }
}

module.exports = { startDailyRemindersJob };
