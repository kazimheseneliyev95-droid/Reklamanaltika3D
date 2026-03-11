/**
 * SEC-06: AES-256-GCM encryption utilities for sensitive data at rest.
 * Used to encrypt Facebook access tokens before storing in the database.
 *
 * Requires ENCRYPTION_SECRET env var (32+ character string).
 * Falls back to no encryption if not set (with a warning).
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const KEY_DERIVATION_SALT = 'reklamanaltika3d_fb_token_v1';

let _derivedKey = null;

function getKey() {
  if (_derivedKey) return _derivedKey;
  const secret = (process.env.ENCRYPTION_SECRET || '').trim();
  if (!secret) return null;

  // Derive a 32-byte key from the secret using PBKDF2
  _derivedKey = crypto.pbkdf2Sync(secret, KEY_DERIVATION_SALT, 100000, 32, 'sha256');
  return _derivedKey;
}

/**
 * Encrypt a plain-text string. Returns a hex-encoded string: iv:authTag:ciphertext
 * Returns the original string if ENCRYPTION_SECRET is not set.
 */
function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  if (!key) return plaintext; // no encryption key configured

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  // Format: enc:iv:tag:ciphertext  (prefix 'enc:' marks it as encrypted)
  return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an encrypted string. If the string is not encrypted (no 'enc:' prefix),
 * returns it as-is (backward compat for existing plain-text tokens).
 */
function decrypt(encryptedStr) {
  if (!encryptedStr) return encryptedStr;
  if (!encryptedStr.startsWith('enc:')) return encryptedStr; // plain-text fallback

  const key = getKey();
  if (!key) {
    console.warn('⚠️ ENCRYPTION_SECRET not set but encrypted data found. Cannot decrypt.');
    return null;
  }

  try {
    const parts = encryptedStr.slice(4).split(':'); // remove 'enc:' prefix
    if (parts.length !== 3) {
      console.warn('⚠️ Invalid encrypted format');
      return null;
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('⚠️ Decryption failed:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };
