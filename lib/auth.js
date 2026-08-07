const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function randomToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}

function randomCode(digits = 6) {
  return String(Math.floor(Math.random() * Math.pow(10, digits))).padStart(digits, '0');
}

module.exports = { hashPassword, verifyPassword, randomToken, randomCode };
