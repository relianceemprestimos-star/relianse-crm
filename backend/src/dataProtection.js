import crypto from 'node:crypto';

const DEFAULT_TEST_KEY = 'reliance-crm-local-test-encryption-key';

function cleanDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function assertSafeFallbackAllowed() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  if (env === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY obrigatoria em producao.');
  }
  return DEFAULT_TEST_KEY;
}

function encryptionKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim() || assertSafeFallbackAllowed();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;
  return crypto.createHash('sha256').update(raw).digest();
}

function hashSecret() {
  return String(process.env.HASH_SECRET || process.env.JWT_SECRET || 'reliance-crm-local-hash-secret');
}

export function maskCpf(cpf) {
  const digits = cleanDigits(cpf);
  if (!digits) return '';
  if (digits.length !== 11) return `***${digits.slice(-3)}`;
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

export function maskPhone(phone) {
  const digits = cleanDigits(phone);
  if (!digits) return '';
  if (digits.length < 4) return '****';
  return `***${digits.slice(-4)}`;
}

export function maskBankAccount(value) {
  const digits = cleanDigits(value);
  if (!digits) return '';
  return digits.length <= 2 ? '**' : `***${digits.slice(-2)}`;
}

export function hashSensitive(value, purpose = 'general') {
  const normalized = cleanDigits(value) || String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  return crypto.createHmac('sha256', hashSecret()).update(`${purpose}:${normalized}`).digest('hex');
}

export function encryptSensitive(value) {
  if (value === null || value === undefined || value === '') return '';
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSensitive(value) {
  const text = String(value || '');
  if (!text.startsWith('v1:')) return '';
  const [, ivText, tagText, encryptedText] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

export function maskByKey(key, value) {
  const normalized = String(key || '').toLowerCase();
  if (normalized.includes('cpf') || normalized.includes('document')) return maskCpf(value);
  if (normalized.includes('phone') || normalized.includes('telefone') || normalized.includes('celular')) return maskPhone(value);
  if (normalized.includes('account') || normalized.includes('conta') || normalized.includes('agencia')) return maskBankAccount(value);
  return value;
}
