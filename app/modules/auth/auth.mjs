import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requiresEmailVerification(env = process.env) {
  return env.NODE_ENV === 'production' || env.EMAIL_VERIFICATION_REQUIRED !== 'false';
}

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateRegistration({ name, email, password }) {
  const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
  const cleanEmail = normalizeEmail(email);
  if (cleanName.length < 2 || cleanName.length > 80) return { error: 'Укажите имя от 2 до 80 символов.' };
  if (cleanEmail.length > 254 || !EMAIL_PATTERN.test(cleanEmail)) return { error: 'Укажите корректный email.' };
  if (String(password ?? '').length < 10 || String(password ?? '').length > 128) return { error: 'Пароль должен содержать от 10 до 128 символов.' };
  return { value: { name: cleanName, email: cleanEmail, password: String(password) } };
}

export function validatePasswordChange({ currentPassword, newPassword, confirmPassword }) {
  if (!String(currentPassword ?? '')) return { error: 'Введите текущий пароль.' };
  if (String(newPassword ?? '').length < 10 || String(newPassword ?? '').length > 128) {
    return { error: 'Новый пароль должен содержать от 10 до 128 символов.' };
  }
  if (newPassword !== confirmPassword) return { error: 'Новые пароли не совпадают.' };
  if (newPassword === currentPassword) return { error: 'Новый пароль должен отличаться от текущего.' };
  return { value: { currentPassword: String(currentPassword), newPassword: String(newPassword) } };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded).split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(String(password), Buffer.from(saltText, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createSessionToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function createVerificationCode(){return String(Number.parseInt(randomBytes(4).toString('hex'),16)%1_000_000).padStart(6,'0');}
