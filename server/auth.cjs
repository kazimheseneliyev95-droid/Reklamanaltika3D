const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_ISSUER = 'reklamanaltika3d';
const JWT_AUDIENCE = 'crm-ui';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_PASSWORD || 'dev-insecure-jwt-secret-change-me';
  if (!process.env.JWT_SECRET) {
    console.warn('⚠️ JWT_SECRET is not set. Using compatibility fallback secret. Set JWT_SECRET in production.');
  }
  return secret;
}

function signAuthToken(payload) {
  const secret = getJwtSecret();
  const expiresIn = process.env.JWT_EXPIRES_IN || '12h';
  return jwt.sign(payload, secret, {
    expiresIn,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

function verifyAuthToken(token) {
  const secret = getJwtSecret();
  return jwt.verify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE
  });
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function hashPassword(plainPassword) {
  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  return bcrypt.hash(plainPassword, rounds);
}

async function verifyPassword(plainPassword, storedHashOrPlain) {
  if (!storedHashOrPlain || typeof storedHashOrPlain !== 'string') {
    return false;
  }
  if (isBcryptHash(storedHashOrPlain)) {
    return bcrypt.compare(plainPassword, storedHashOrPlain);
  }
  return plainPassword === storedHashOrPlain;
}

module.exports = {
  signAuthToken,
  verifyAuthToken,
  isBcryptHash,
  hashPassword,
  verifyPassword
};
