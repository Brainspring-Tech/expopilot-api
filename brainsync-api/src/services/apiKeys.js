const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Raw key format: epk_<32 random bytes, base64url>. Only ever shown to
// the admin once, at creation time — we store the hash, never the raw
// value. key_prefix is just the first chars of the raw key, kept
// alongside the hash purely so the admin console can show "epk_A1b2..."
// to help identify which key is which without ever re-displaying the
// full secret.
function generateApiKey() {
  const raw = 'epk_' + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function looksLikeApiKey(token) {
  return typeof token === 'string' && token.startsWith('epk_');
}

// Mints a short-lived (5 min) token for the shadow user behind an API
// key, signed with the project's own JWT secret so it's indistinguishable
// from a real Supabase session token to PostgREST/RLS — this is what lets
// API-key requests reuse the exact same req.userClient path as a normal
// logged-in user, rather than a second hand-rolled authorization path.
function mintShadowUserToken(authUserId) {
  return jwt.sign(
    { sub: authUserId, role: 'authenticated', aud: 'authenticated' },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: '5m' }
  );
}

module.exports = { generateApiKey, hashApiKey, looksLikeApiKey, mintShadowUserToken };
