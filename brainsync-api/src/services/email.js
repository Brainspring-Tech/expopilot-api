const axios = require('axios');

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

async function sendEmail({ to, subject, body }) {
  const token = await getAccessToken();

  const message = {
    message: {
      subject,
      body:       { contentType: 'HTML', content: body },
      toRecipients: Array.isArray(to)
        ? to.map(addr => ({ emailAddress: { address: addr } }))
        : [{ emailAddress: { address: to } }],
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

module.exports = { sendEmail, sendConferenceAssignmentAlert, sendDailyLeadSummary };
