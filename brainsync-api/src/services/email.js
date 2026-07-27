const { google } = require('googleapis');
const MailComposer = require('nodemailer/lib/mail-composer');
const { DateTime } = require('luxon');

// Sends via the Gmail API using a Google Cloud service account with
// domain-wide delegation — not SMTP/app-password, and not Microsoft
// Graph. App passwords weren't available for this Workspace account
// (blocked by org policy or Google's broader phase-out), and Graph has
// no authority over mailboxes outside the Entra ID tenant it's
// registered in, so neither was viable for a Google Workspace sender.
//
// GMAIL_IMPERSONATE_EMAIL is the real account the service account is
// authorized to act as — if the visible sender (GMAIL_FROM_ADDRESS) is
// an alias rather than a standalone mailbox, aliases can't be
// impersonated directly, only the real underlying account can.
// GMAIL_FROM_ADDRESS falls back to GMAIL_IMPERSONATE_EMAIL when they're
// the same (a real mailbox, not an alias) — Gmail accepts the alias as
// a valid From header as long as it's a registered alias of whichever
// account is impersonated, same as picking it from the "Send as"
// dropdown in Gmail's own UI would.
const IMPERSONATE_EMAIL = process.env.GMAIL_IMPERSONATE_EMAIL;
const FROM_ADDRESS      = process.env.GMAIL_FROM_ADDRESS || IMPERSONATE_EMAIL;

// Same env vars already used for CORS (index.js) and Stripe redirects
// (routes/stripe.js) — FRONTEND_URL is the staff-facing PWA,
// ADMIN_URL is the admin console. Reused here so notification emails
// link to the same places those other systems already agree on.
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.expopilot.app';
const ADMIN_URL    = process.env.ADMIN_URL    || 'https://admin.expopilot.app';

let _gmail = null;
function getGmailClient() {
  if (_gmail) return _gmail;
  const jwtClient = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Render env vars store the key with literal "\n" sequences instead
    // of real newlines — has to be un-escaped or the PEM parse fails.
    key: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: IMPERSONATE_EMAIL,
  });
  _gmail = google.gmail({ version: 'v1', auth: jwtClient });
  return _gmail;
}

// Builds the raw RFC 2822 MIME message using Nodemailer purely as a
// composer (no SMTP transport involved) — reuses the exact same
// HTML/attachment/icalEvent handling already exercised for the Graph and
// SMTP paths, so only the actual send call below is new.
function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, body, attachments, icalEvent }) {
  const gmail = getGmailClient();

  const mailOptions = {
    from: `"ExpoPilot" <${FROM_ADDRESS}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html: body,
    ...(attachments?.length ? {
      attachments: attachments.map(a => ({
        filename: a.name,
        content: a.contentBytes ? Buffer.from(a.contentBytes, 'base64') : a.content,
        contentType: a.contentType,
      })),
    } : {}),
    ...(icalEvent ? { icalEvent } : {}),
  };

  try {
    const rawMessage = await buildRawMessage(mailOptions);
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: toBase64Url(rawMessage) },
    });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.error('[email] Gmail API send failed:', detail);
    throw new Error(`Gmail send failed: ${detail}`);
  }

  console.log(`[email] sent "${subject}" to ${Array.isArray(to) ? to.join(', ') : to}`);
}

// Shared branded layout — mirrors the look of Supabase's custom "invite"
// email template (wordmark header, coral CTA pill, tip box, tagline
// footer) so every email from ExpoPilot reads as one system. Colors
// pulled from the admin console's actual design tokens (src/index.css):
// --brand-500 #FF5A36, --ink-900 #191B20, --ink-600 #5A5D66, --paper
// #FBF8F3, --brand-50 #FFF3ED, --dark-nav-item #A9B4BD.
function renderEmailTemplate({ heading, bodyHtml, ctaText, ctaUrl, tip }) {
  return `
    <div style="background:#FBF8F3;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <table role="presentation" width="100%" style="max-width:480px;margin:0 auto;border-collapse:collapse;">
        <tr><td style="text-align:center;padding-bottom:24px;">
          <span style="font-size:20px;font-weight:800;color:#191B20;letter-spacing:-0.02em;">Expo<span style="color:#FF5A36;">Pilot</span></span>
        </td></tr>
        <tr><td style="background:#FFFFFF;border-radius:20px;padding:32px;">
          <h1 style="font-size:19px;margin:0 0 16px;color:#191B20;">${heading}</h1>
          <div style="font-size:15px;line-height:1.6;color:#3A3D45;">${bodyHtml}</div>
          ${ctaUrl ? `
          <div style="text-align:center;margin:28px 0 8px;">
            <a href="${ctaUrl}" style="display:inline-block;background:#FF5A36;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 28px;border-radius:999px;">${ctaText}</a>
          </div>` : ''}
          ${tip ? `<div style="margin-top:24px;padding:14px 16px;background:#FFF3ED;border-radius:12px;font-size:13px;color:#5A5D66;">${tip}</div>` : ''}
        </td></tr>
        <tr><td style="text-align:center;padding-top:24px;font-size:12.5px;color:#5A5D66;">
          <p style="margin:0 0 4px;">— The ExpoPilot Team</p>
          <p style="margin:0;letter-spacing:.06em;font-weight:700;color:#A9B4BD;font-size:10.5px;">CLEARED FOR EVENT SUCCESS</p>
        </td></tr>
      </table>
    </div>
  `;
}

// Pre-built alert templates
//
// CTA destinations: conference-assignment and shift-invite emails go to
// the PWA (app.expopilot.app) — that's staff's day-of-event surface
// (Schedule/Travel/Shipping) and what the invite email itself points
// people to for phone access. Task and discussion emails go to the
// admin console (admin.expopilot.app) instead, because Tasks/Discussion
// only exist there today — there's no PWA equivalent to link to. Staff
// already have console access (ADMIN_CONSOLE_ROLES includes 'staff' in
// brainsync-admin/src/App.jsx), so this isn't gated to admins only.

async function sendConferenceAssignmentAlert({ staffEmail, staffName, conferenceName, conferenceDate, role }) {
  await sendEmail({
    to: staffEmail,
    subject: `You've been assigned to ${conferenceName}`,
    body: renderEmailTemplate({
      heading: `You've been assigned to ${conferenceName}`,
      bodyHtml: `<p>Hi ${staffName},</p><p>You've been added to <strong>${conferenceName}</strong> on <strong>${conferenceDate}</strong> as <strong>${role}</strong>.</p>`,
      ctaText: 'View your schedule',
      ctaUrl: `${FRONTEND_URL}/schedule`,
      tip: 'Tip: access ExpoPilot from your phone at app.expopilot.app — open it in Safari or Chrome and add it to your home screen for quick access.',
    }),
  });
}

// Sends the "set your password" invite email — used for BOTH the first
// invite (POST /api/users) and resends (POST /:id/resend-invite). Both
// paths mint the action link with supabase.auth.admin.generateLink()
// (type 'invite' for new users, 'recovery' for resends), which creates/
// resolves the auth user but never sends an email itself — so we send it
// here through the same Gmail pipeline every other notification already
// uses successfully, sidestepping the Resend-backed Supabase mailer's
// deliverability problems (quarantine, noreply spam-scoring) entirely.
async function sendInviteEmail({ toEmail, fullName, orgName, actionLink, isLeadCapture }) {
  await sendEmail({
    to: toEmail,
    subject: `You're invited to join ${orgName} on ExpoPilot`,
    body: renderEmailTemplate({
      heading: `You're invited to join ${orgName}`,
      bodyHtml: `<p>Hi ${fullName || 'there'},</p><p><strong>${orgName}</strong> has invited you to ExpoPilot${isLeadCapture ? ' to help capture leads at upcoming events' : ''}. Click below to set your password and get started.</p>`,
      ctaText: 'Set your password',
      ctaUrl: actionLink,
      tip: isLeadCapture
        ? 'Tip: open this link on your phone, then add ExpoPilot to your home screen for quick access at the booth.'
        : undefined,
    }),
  });
}

async function sendDailyLeadSummary({ adminEmail, conferenceId, conferenceName, totalLeads, hotLeads, date }) {
  await sendEmail({
    to: adminEmail,
    subject: `${conferenceName} — lead summary for ${date}`,
    body: renderEmailTemplate({
      heading: `${conferenceName} — lead summary`,
      bodyHtml: `
        <p>Here's today's lead capture summary for <strong>${conferenceName}</strong>:</p>
        <ul style="margin:12px 0;padding-left:20px;">
          <li>Total leads captured: <strong>${totalLeads}</strong></li>
          <li>Hot leads (score ≥ 4): <strong>${hotLeads}</strong></li>
        </ul>
      `,
      ctaText: 'Review leads',
      ctaUrl: conferenceId ? `${ADMIN_URL}/leads?conference_id=${conferenceId}` : `${ADMIN_URL}/leads`,
    }),
  });
}

async function sendTaskAssignmentAlert({ staffEmail, staffName, taskTitle, conferenceId, conferenceName, dueDate }) {
  await sendEmail({
    to: staffEmail,
    subject: `New task: ${taskTitle}`,
    body: renderEmailTemplate({
      heading: 'New task assigned to you',
      bodyHtml: `<p>Hi ${staffName},</p><p>You've been assigned a new task on <strong>${conferenceName}</strong>:</p><p><strong>${taskTitle}</strong>${dueDate ? ` — due ${dueDate}` : ''}</p>`,
      ctaText: 'View task',
      ctaUrl: conferenceId ? `${ADMIN_URL}/conferences/${conferenceId}` : ADMIN_URL,
    }),
  });
}

async function sendDiscussionCommentAlert({ staffEmail, staffName, conferenceId, conferenceName, authorName, commentBody }) {
  await sendEmail({
    to: staffEmail,
    subject: `New discussion post on ${conferenceName}`,
    body: renderEmailTemplate({
      heading: 'New discussion post',
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p><strong>${authorName}</strong> posted in the discussion board for <strong>${conferenceName}</strong>:</p>
        <p style="padding:12px;background:#f5f4f0;border-radius:8px;">${commentBody}</p>
      `,
      ctaText: 'Reply',
      ctaUrl: conferenceId ? `${ADMIN_URL}/conferences/${conferenceId}` : ADMIN_URL,
    }),
  });
}

async function sendWeeklyAdminDigest({ adminEmail, upcomingConferences, openTaskCount, unshippedAssetCount }) {
  const confListHtml = upcomingConferences.length
    ? `<ul style="margin:12px 0;padding-left:20px;">${upcomingConferences.map(c => `<li><strong>${c.name}</strong> — ${c.start_date}</li>`).join('')}</ul>`
    : `<p style="color:#5A5D66;">No conferences starting in the next 7 days.</p>`;

  await sendEmail({
    to: adminEmail,
    subject: `Your weekly ExpoPilot digest`,
    body: renderEmailTemplate({
      heading: 'Your week ahead',
      bodyHtml: `
        <p>Here's what's coming up this week:</p>
        <p style="margin:16px 0 4px;font-weight:700;color:#191B20;">Conferences starting soon</p>
        ${confListHtml}
        <ul style="margin:12px 0;padding-left:20px;">
          <li>Open tasks across your conferences: <strong>${openTaskCount}</strong></li>
          <li>Assets not yet shipped: <strong>${unshippedAssetCount}</strong></li>
        </ul>
      `,
      ctaText: 'Open dashboard',
      ctaUrl: ADMIN_URL,
    }),
  });
}

async function sendWeeklyPersonalSummary({ staffEmail, staffName, leadsCaptured, conferenceCount }) {
  await sendEmail({
    to: staffEmail,
    subject: `Your week in review — ${leadsCaptured} leads captured`,
    body: renderEmailTemplate({
      heading: 'Nice work this week',
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p>This past week you captured <strong>${leadsCaptured}</strong> lead${leadsCaptured === 1 ? '' : 's'} across <strong>${conferenceCount}</strong> conference${conferenceCount === 1 ? '' : 's'}.</p>
      `,
      ctaText: 'View your leads',
      ctaUrl: `${FRONTEND_URL}/leads`,
    }),
  });
}

async function sendTaskDueReminder({ staffEmail, staffName, taskTitle, conferenceId, conferenceName, dueDate, overdue }) {
  await sendEmail({
    to: staffEmail,
    subject: overdue ? `Overdue: ${taskTitle}` : `Due tomorrow: ${taskTitle}`,
    body: renderEmailTemplate({
      heading: overdue ? 'Task overdue' : 'Task due tomorrow',
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p>${overdue ? 'This task was due yesterday and is still open' : 'This task is due tomorrow'} on <strong>${conferenceName}</strong>:</p>
        <p><strong>${taskTitle}</strong> — due ${dueDate}</p>
      `,
      ctaText: 'View task',
      ctaUrl: conferenceId ? `${ADMIN_URL}/conferences/${conferenceId}` : ADMIN_URL,
    }),
  });
}

async function sendShiftReminder({ staffEmail, staffName, conferenceName, venue, shiftDate, startTime, endTime }) {
  await sendEmail({
    to: staffEmail,
    subject: `Reminder: your shift at ${conferenceName} starts tomorrow`,
    body: renderEmailTemplate({
      heading: 'Shift tomorrow',
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p>Your shift at <strong>${conferenceName}</strong>${venue ? ` (${venue})` : ''} starts tomorrow, <strong>${shiftDate}</strong>, from <strong>${startTime}</strong> to <strong>${endTime}</strong>.</p>
      `,
      ctaText: 'View your schedule',
      ctaUrl: `${FRONTEND_URL}/schedule`,
    }),
  });
}

async function sendShippingDeadlineAlert({ adminEmail, conferenceId, conferenceName, assets }) {
  const assetListHtml = `<ul style="margin:12px 0;padding-left:20px;">${assets.map(a => `<li><strong>${a.name}</strong> — ship by ${a.ship_by_date}</li>`).join('')}</ul>`;

  await sendEmail({
    to: adminEmail,
    subject: `Shipping deadline approaching — ${conferenceName}`,
    body: renderEmailTemplate({
      heading: 'Shipping deadline approaching',
      bodyHtml: `
        <p>The following assets for <strong>${conferenceName}</strong> need to ship soon:</p>
        ${assetListHtml}
      `,
      ctaText: 'View assets',
      ctaUrl: conferenceId ? `${ADMIN_URL}/conferences/${conferenceId}` : ADMIN_URL,
    }),
  });
}

async function sendBudgetThresholdAlert({ adminEmail, conferenceId, conferenceName, thresholdPercent, budget, spent }) {
  await sendEmail({
    to: adminEmail,
    subject: `${conferenceName} has crossed ${thresholdPercent}% of budget`,
    body: renderEmailTemplate({
      heading: `${thresholdPercent}% of budget spent`,
      bodyHtml: `
        <p><strong>${conferenceName}</strong> has spent <strong>$${Number(spent).toLocaleString()}</strong> of its <strong>$${Number(budget).toLocaleString()}</strong> budget (${thresholdPercent}%+).</p>
      `,
      ctaText: 'View budget',
      ctaUrl: conferenceId ? `${ADMIN_URL}/conferences/${conferenceId}` : ADMIN_URL,
    }),
  });
}

async function sendPostConferenceWrapup({ staffEmail, staffName, conferenceId, conferenceName, totalLeads, hotLeads }) {
  await sendEmail({
    to: staffEmail,
    subject: `Wrap-up: ${conferenceName}`,
    body: renderEmailTemplate({
      heading: `Nice work at ${conferenceName}`,
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p>${conferenceName} has wrapped up. Here's how it went:</p>
        <ul style="margin:12px 0;padding-left:20px;">
          <li>Total leads captured: <strong>${totalLeads}</strong></li>
          <li>Hot leads (score ≥ 4): <strong>${hotLeads}</strong></li>
        </ul>
      `,
      ctaText: 'View leads',
      ctaUrl: `${FRONTEND_URL}/leads`,
    }),
  });
}

async function sendInactivityNudge({ staffEmail, staffName, conferenceName, startDate }) {
  await sendEmail({
    to: staffEmail,
    subject: `${conferenceName} is coming up`,
    body: renderEmailTemplate({
      heading: `${conferenceName} is coming up`,
      bodyHtml: `
        <p>Hi ${staffName},</p>
        <p>You're assigned to <strong>${conferenceName}</strong>, starting <strong>${startDate}</strong>. It's been a little while since you've logged into ExpoPilot — check your schedule and travel details before the event.</p>
      `,
      ctaText: 'Open ExpoPilot',
      ctaUrl: FRONTEND_URL,
    }),
  });
}

// Escapes TEXT-type ICS field values per RFC 5545 §3.3.11.
function escapeICSText(str = '') {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function toICSUTC(dt) {
  return dt.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

function buildShiftICS({ shiftId, staffEmail, staffName, organizerEmail, conferenceName, venue, shiftDate, startTime, endTime, timezone }) {
  const start = DateTime.fromISO(`${shiftDate}T${startTime}`, { zone: timezone });
  const end   = DateTime.fromISO(`${shiftDate}T${endTime}`,   { zone: timezone });
  const now   = DateTime.utc();

  const summary  = escapeICSText(`Shift — ${conferenceName}`);
  const location = escapeICSText(venue || conferenceName);
  const description = escapeICSText(`Booth shift for ${conferenceName}. Log in to ExpoPilot for full details.`);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ExpoPilot//Shift Invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:shift-${shiftId}@expopilot.app`,
    `DTSTAMP:${toICSUTC(now)}`,
    `DTSTART:${toICSUTC(start)}`,
    `DTEND:${toICSUTC(end)}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
    `DESCRIPTION:${description}`,
    `ORGANIZER;CN=ExpoPilot:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${escapeICSText(staffName)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${staffEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.join('\r\n') + '\r\n';
}

async function sendShiftCalendarInvite({ shiftId, staffEmail, staffName, conferenceName, venue, shiftDate, startTime, endTime, timezone, organizerEmail }) {
  const organizer = organizerEmail || FROM_ADDRESS;
  const ics = buildShiftICS({ shiftId, staffEmail, staffName, organizerEmail: organizer, conferenceName, venue, shiftDate, startTime, endTime, timezone });

  await sendEmail({
    to: staffEmail,
    subject: `Shift scheduled — ${conferenceName}`,
    body: renderEmailTemplate({
      heading: `Shift scheduled — ${conferenceName}`,
      bodyHtml: `<p>Hi ${staffName},</p><p>You've been scheduled for a shift at <strong>${conferenceName}</strong> on <strong>${shiftDate}</strong> from <strong>${startTime}</strong> to <strong>${endTime}</strong>.</p><p>Open the attached invite to add it to your calendar.</p>`,
      ctaText: 'View your schedule',
      ctaUrl: `${FRONTEND_URL}/schedule`,
    }),
    // Nodemailer's dedicated icalEvent option (rather than a generic file
    // attachment) is what gets Gmail/Outlook to render this as an actual
    // actionable invite (Yes/No/Maybe) instead of just a downloadable file.
    icalEvent: {
      filename: 'invite.ics',
      method: 'REQUEST',
      content: ics,
    },
  });
}

module.exports = {
  sendEmail,
  sendConferenceAssignmentAlert,
  sendInviteEmail,
  sendDailyLeadSummary,
  sendTaskAssignmentAlert,
  sendDiscussionCommentAlert,
  sendShiftCalendarInvite,
  sendWeeklyAdminDigest,
  sendWeeklyPersonalSummary,
  sendTaskDueReminder,
  sendShiftReminder,
  sendShippingDeadlineAlert,
  sendBudgetThresholdAlert,
  sendPostConferenceWrapup,
  sendInactivityNudge,
};
