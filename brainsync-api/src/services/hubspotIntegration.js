// Thin HubSpot API client for the generalized, per-org CRM integration.
// Deliberately separate from Brainspring's own existing hardcoded
// HubSpot sync (the BRAINSPRING_ORG_ID-gated one) — that one keeps
// running as-is; this is the new customer-facing, multi-tenant path.
// Consolidating them into one code path is a reasonable future cleanup
// once this is proven, but not attempted here to avoid risking the
// existing production sync.

const HUBSPOT_API = 'https://api.hubapi.com';

// Quick validity check when a customer first pastes in a token — calling
// this before saving means a bad/expired token surfaces immediately as a
// clear error, not as a silent failure the next time the cron runs.
async function validateToken(accessToken) {
  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts?limit=1`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.ok) return { valid: true };

  const body = await res.json().catch(() => ({}));
  return { valid: false, error: body.message || `HubSpot rejected the token (HTTP ${res.status})` };
}

// Maps an ExpoPilot lead row to HubSpot contact properties using the
// org's configured field_mappings (expopilot field -> hubspot property
// name). Only includes properties that have a non-empty value — HubSpot
// doesn't need explicit nulls, and this avoids clobbering existing
// HubSpot data with blanks for fields ExpoPilot didn't capture.
function mapLeadToHubSpotProperties(lead, fieldMappings) {
  const source = {
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    organization: lead.organization,
    phone: lead.phone,
    score: lead.score,
    notes: lead.notes,
  };

  const properties = {};
  for (const [expoField, hubspotProp] of Object.entries(fieldMappings || {})) {
    const value = source[expoField];
    if (value !== undefined && value !== null && value !== '') {
      properties[hubspotProp] = String(value);
    }
  }
  return properties;
}

// Batch-upserts up to 100 leads in a single HubSpot API call, matched by
// email. Returns per-lead results so the caller can record success/error
// per lead in lead_crm_syncs rather than treating the whole batch as
// pass/fail.
async function upsertContactsBatch(accessToken, leads, fieldMappings) {
  if (leads.length === 0) return [];
  if (leads.length > 100) {
    throw new Error('upsertContactsBatch only supports up to 100 leads per call — caller must chunk');
  }

  const inputs = leads.map(lead => ({
    idProperty: 'email',
    id: lead.email,
    properties: mapLeadToHubSpotProperties(lead, fieldMappings),
  }));

  const res = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts/batch/upsert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs }),
  });

  const body = await res.json().catch(() => ({}));

  if (res.ok) {
    // HubSpot returns results in the same order as inputs.
    return leads.map((lead, i) => ({
      lead_id: lead.id,
      success: true,
      external_id: body.results?.[i]?.id || null,
    }));
  }

  // Batch-level failure (bad token, rate limit, etc.) — every lead in
  // this batch failed for the same reason.
  const errorMessage = body.message || `HubSpot API error (HTTP ${res.status})`;
  return leads.map(lead => ({ lead_id: lead.id, success: false, error: errorMessage }));
}

module.exports = { validateToken, upsertContactsBatch };
