const supabase = require('./supabase');

// Service-role lookup (not req.userClient) — the recipient of a
// notification is frequently not the caller (e.g. an admin assigning
// someone else to a conference), so this can't rely on the caller's RLS
// visibility. Read-only, single-row, used only to address/gate an
// internally-triggered email.
async function getRecipient(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('email, full_name, notification_prefs')
    .eq('id', userId)
    .single();
  if (error) throw error;
  return data;
}

// Fire-and-forget notification wrapper — looks up the recipient, checks
// their notification_prefs[prefKey], and only then calls sendFn(recipient).
// Never throws: a missing recipient, a disabled pref, or an email-provider
// failure are all just logged, since a notification failure should never
// fail the request that triggered it (the assignment/task/comment/shift
// itself already succeeded by the time this runs).
async function notifyIfEnabled(userId, prefKey, sendFn) {
  try {
    const recipient = await getRecipient(userId);
    if (!recipient?.notification_prefs?.[prefKey]) return;
    await sendFn(recipient);
  } catch (err) {
    console.error(`[notifications] failed to notify user ${userId} (${prefKey}):`, err.message);
  }
}

module.exports = { getRecipient, notifyIfEnabled };
