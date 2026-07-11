const axios = require('axios');
const { DateTime } = require('luxon');

let _token = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiry - 60000) return _token;

  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    scope:         'https://graph.microsoft.com/.default',
  });

  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  _token       = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return _token;
}

async function sendEmail({ to, subject, body, attachments }) {
  const token = await getAccessToken();

  const message = {
    message: {
      subject,
      body:       { contentType: 'HTML', content: body },
      toRecipients: Array.isArray(to)
        ? to.map(addr => ({ emailAddress: { address: addr } }))
        : [{ emailAddress: { address: to } }],
      // Graph file attachments — each item: { name, contentType, contentBytes (base64) }.
      ...(attachments?.length ? {
        attachments: attachments.map(a => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.name,
          contentType: a.contentType,
          contentBytes: a.contentBytes,
        })),
      } : {}),
    },
    saveToSentItems: false,
  };

  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${process.env.MS_SENDER_EMAIL}/sendMail`,
    message,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  console.log(`[email] sent "${subject}" to ${Array.isArray(to) ? to.join(', ') : to}`);
}

// Pre-built alert templates

async function sendConferenceAssignmentAlert({ staffEmail, staffName, conferenceName, conferenceDate, role }) {
  await sendEmail({
    to: staffEmail,
    subject: `You've been assigned to ${conferenceName}`,
    body: `
      <p>Hi ${staffName},</p>
      <p>You've been assigned to <strong>${conferenceName}</strong> on <strong>${conferenceDate}</strong> as <strong>${role}</strong>.</p>
      <p>Log in to BrainSync to view your tasks, assets, and shift details.</p>
      <p>— Brainspring Team</p>
    `,
  });
}

async function sendDailyLeadSummary({ adminEmail, conferenceName, totalLeads, hotLeads, date }) {
  await sendEmail({
    to: adminEmail,
    subject: `${conferenceName} — lead summary for ${date}`,
    body: `
      <p>Here's today's lead capture summary for <strong>${conferenceName}</strong>:</p>
      <ul>
        <li>Total leads captured: <strong>${totalLeads}</strong></li>
        <li>Hot leads (score ≥ 4): <strong>${hotLeads}</strong></li>
      </ul>
      <p>Log in to BrainSync to review and assign follow-ups.</p>
      <p>— BrainSync</p>
    `,
  });
}

async function sendTaskAssignmentAlert({ staffEmail, staffName, taskTitle, conferenceName, dueDate }) {
  await sendEmail({
    to: staffEmail,
    subject: `New task: ${taskTitle}`,
    body: `
      <p>Hi ${staffName},</p>
      <p>You've been assigned a new task on <strong>${conferenceName}</strong>:</p>
      <p><strong>${taskTitle}</strong>${dueDate ? ` — due ${dueDate}` : ''}</p>
      <p>Log in to BrainSync to view the full task details.</p>
      <p>— Brainspring Team</p>
    `,
  });
}

async function sendDiscussionCommentAlert({ staffEmail, staffName, conferenceName, authorName, commentBody }) {
  await sendEmail({
    to: staffEmail,
    subject: `New discussion post on ${conferenceName}`,
    body: `
      <p>Hi ${staffName},</p>
      <p><strong>${authorName}</strong> posted in the discussion board for <strong>${conferenceName}</strong>:</p>
      <p style="padding:12px;background:#f5f4f0;border-radius:8px;">${commentBody}</p>
      <p>Log in to BrainSync to reply.</p>
      <p>— Brainspring Team</p>
    `,
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
  const description = escapeICSText(`Booth shift for ${conferenceName}. Log in to BrainSync for full details.`);

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
  const organizer = organizerEmail || process.env.MS_SENDER_EMAIL;
  const ics = buildShiftICS({ shiftId, staffEmail, staffName, organizerEmail: organizer, conferenceName, venue, shiftDate, startTime, endTime, timezone });

  await sendEmail({
    to: staffEmail,
    subject: `Shift scheduled — ${conferenceName}`,
    body: `
      <p>Hi ${staffName},</p>
      <p>You've been scheduled for a shift at <strong>${conferenceName}</strong> on <strong>${shiftDate}</strong> from <strong>${startTime}</strong> to <strong>${endTime}</strong>.</p>
      <p>Open the attached invite to add it to your calendar.</p>
      <p>— Brainspring Team</p>
    `,
    attachments: [{
      name: 'invite.ics',
      contentType: 'text/calendar',
      contentBytes: Buffer.from(ics, 'utf-8').toString('base64'),
    }],
  });
}

module.exports = {
  sendEmail,
  sendConferenceAssignmentAlert,
  sendDailyLeadSummary,
  sendTaskAssignmentAlert,
  sendDiscussionCommentAlert,
  sendShiftCalendarInvite,
};
