const BLOCKED_STATUSES = new Set([
  'sem_interesse',
  'sem interesse',
  'bloqueado',
  'nao_abordar',
  'não_abordar',
  'nao abordar',
  'não abordar',
  'finalizado_sem_interesse',
  'finalizado sem interesse',
]);

const INTEREST_KEYWORDS = ['pode mandar', 'sim', 'quero', 'manda', 'pode'];
const OPTOUT_KEYWORDS = ['nao tenho interesse', 'não tenho interesse', 'nao quero', 'não quero', 'parar', 'remover', 'bloquear', 'nao me chama', 'não me chama'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canSendToClientByStatus(status) {
  const normalized = normalizeText(status);
  return !BLOCKED_STATUSES.has(normalized);
}

export function detectInboundIntent(message) {
  const text = normalizeText(message);
  if (!text) return 'none';
  if (OPTOUT_KEYWORDS.some((keyword) => text.includes(normalizeText(keyword)))) {
    return 'opt_out';
  }
  if (INTEREST_KEYWORDS.some((keyword) => text.includes(normalizeText(keyword)))) {
    return 'interest';
  }
  return 'none';
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 5) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}
