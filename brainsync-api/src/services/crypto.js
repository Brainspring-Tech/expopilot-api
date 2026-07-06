const crypto = require('crypto');

// AES-256-GCM, app-layer encryption for customer CRM credentials.
// CRM_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set as a
// Render env var — NEVER stored in the database. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Losing this key means every stored integration credential becomes
// permanently undecryptable — back it up somewhere safe outside Render
// (a password manager, not a file in the repo).

const KEY = process.env.CRM_ENCRYPTION_KEY
  ? Buffer.from(process.env.CRM_ENCRYPTION_KEY, 'base64')
  : null;

function requireKey() {
  if (!KEY || KEY.length !== 32) {
    throw new Error('CRM_ENCRYPTION_KEY is missing or invalid (must be a base64-encoded 32-byte key)');
  }
}

// Returns a single string safe to store in a text column:
// "<iv_base64>:<authTag_base64>:<ciphertext_base64>"
function encrypt(plaintext) {
  requireKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(stored) {
  requireKey();
  const [ivB64, tagB64, ciphertextB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('Malformed encrypted value');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
