import crypto from 'node:crypto';

function normalizeValue(value) {
  return String(value ?? '').trim();
}

function getHashSecret() {
  return (
    process.env.HASH_SECRET ||
    process.env.DATA_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'reliance-crm-local-hash-secret'
  );
}

export function hashSensitiveValue(value, context = 'generic') {
  const normalized = normalizeValue(value);

  if (!normalized) {
    return '';
  }

  return crypto.createHmac('sha256', getHashSecret()).update(`${context}:${normalized}`).digest('hex');
}

function sanitizeScalar(value) {
  if (value == null) {
    return value;
  }

  const text = String(value);
  const digits = text.replace(/\D/g, '');

  if (digits.length === 11) {
    return `***.***.***-${digits.slice(-2)}`;
  }

  if (digits.length >= 10 && digits.length <= 13) {
    return `(**) *****-${digits.slice(-4)}`;
  }

  if (/token|secret|password|senha|api[_-]?key/i.test(text)) {
    return '[redacted]';
  }

  return text;
}

export function sanitizeAuditMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  if (Array.isArray(metadata)) {
    return metadata.map((item) => sanitizeAuditMetadata(item));
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => {
      if (/token|secret|password|senha|api[_-]?key/i.test(key)) {
        return [key, '[redacted]'];
      }

      if (value && typeof value === 'object') {
        return [key, sanitizeAuditMetadata(value)];
      }

      return [key, sanitizeScalar(value)];
    }),
  );
}

