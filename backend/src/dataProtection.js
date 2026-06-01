import crypto from 'node:crypto';

const PII_KEYS = new Set([
  'cpf',
  'documento',
  'rg',
  'phone',
  'telefone',
  'phone_number',
  'normalized_phone',
  'email',
  'address',
  'address_full',
  'endereco',
  'birth_date',
  'data_nascimento',
  'bank_account',
  'account',
  'agencia',
  'conta',
  'beneficio',
  'matricula',
]);

function cleanDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function getHashSecret() {
  return String(process.env.HASH_SECRET || process.env.DATA_HASH_SECRET || process.env.JWT_SECRET || 'relianse-dev-hash-secret');
}

function getEncryptionKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    return null;
  }

  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) {
    return base64;
  }

  return crypto.createHash('sha256').update(raw).digest();
}

export function hashSensitiveValue(value, purpose = 'general') {
  const normalized = cleanDigits(value) || String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  return crypto.createHmac('sha256', getHashSecret()).update(`${purpose}:${normalized}`).digest('hex');
}

export function encryptSensitiveValue(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const key = getEncryptionKey();
  if (!key) {
    return '';
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSensitiveValue(value) {
  const text = String(value || '');
  if (!text.startsWith('v1:')) {
    return '';
  }
  const key = getEncryptionKey();
  if (!key) {
    return '';
  }
  const [, ivText, tagText, encryptedText] = text.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

export function maskCpf(value) {
  const digits = cleanDigits(value);
  if (digits.length !== 11) {
    return digits ? `***${digits.slice(-3)}` : '';
  }
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

export function maskPhone(value) {
  const digits = cleanDigits(value);
  if (digits.length < 4) {
    return digits ? '****' : '';
  }
  return `***${digits.slice(-4)}`;
}

export function maskEmail(value) {
  const text = String(value || '').trim();
  const [name, domain] = text.split('@');
  if (!name || !domain) {
    return text ? '[email]' : '';
  }
  return `${name.slice(0, 2)}***@${domain}`;
}

export function maskSensitiveValue(key, value) {
  const normalizedKey = String(key || '').toLowerCase();
  if (normalizedKey.includes('cpf') || normalizedKey.includes('documento')) {
    return maskCpf(value);
  }
  if (normalizedKey.includes('phone') || normalizedKey.includes('telefone') || normalizedKey.includes('celular')) {
    return maskPhone(value);
  }
  if (normalizedKey.includes('email')) {
    return maskEmail(value);
  }
  if (
    normalizedKey.includes('address') ||
    normalizedKey.includes('endereco') ||
    normalizedKey.includes('conta') ||
    normalizedKey.includes('agencia') ||
    normalizedKey.includes('matricula') ||
    normalizedKey.includes('beneficio')
  ) {
    return value ? '[protegido]' : '';
  }
  return value;
}

export function sanitizeAuditMetadata(input, depth = 0) {
  if (input === null || input === undefined) {
    return input;
  }
  if (depth > 4) {
    return '[truncado]';
  }
  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => sanitizeAuditMetadata(item, depth + 1));
  }
  if (typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        if (PII_KEYS.has(normalizedKey) || [...PII_KEYS].some((item) => normalizedKey.includes(item))) {
          return [key, maskSensitiveValue(key, value)];
        }
        return [key, sanitizeAuditMetadata(value, depth + 1)];
      })
    );
  }
  if (typeof input === 'string' && /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(input)) {
    return input.replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, (match) => maskCpf(match));
  }
  return input;
}
