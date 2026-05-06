import { cleanDigits } from '../../utils.js';

export function normalizePhoneNumber(value) {
  let digits = cleanDigits(value);
  if (!digits) {
    return null;
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (digits.startsWith('55')) {
    digits = digits.slice(2);
  }
  if (digits.length < 10 || digits.length > 11) {
    return null;
  }

  const ddd = digits.slice(0, 2);
  if (ddd === '00') {
    return null;
  }

  return `+55${digits}`;
}

export function phoneTypeFromNumber(normalized, rawLabel = '') {
  const local = cleanDigits(normalized).replace(/^55/, '');
  const label = String(rawLabel || '').toLowerCase();
  if (label.includes('whatsapp')) return 'whatsapp';
  if (label.includes('cel')) return 'celular';
  if (label.includes('fix')) return 'fixo';
  if (local.length === 11 && local[2] === '9') return 'celular';
  if (local.length === 10) return 'fixo';
  return '';
}

export function normalizePhoneQuality(value = '') {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (text.includes('bom') || text.includes('boa') || text.includes('alto')) return 'bom';
  if (text.includes('medio') || text.includes('regular')) return 'regular';
  if (text.includes('baixo') || text.includes('ruim')) return 'baixo';
  if (text.includes('invalid')) return 'invalido';
  return String(value || '').trim();
}

export function normalizePhoneCandidate(candidate = {}) {
  const rawNumber = candidate.number || candidate.phone || candidate.telefone || candidate.phone_number || '';
  const normalized = normalizePhoneNumber(candidate.normalized || candidate.normalized_phone || rawNumber);
  if (!normalized) {
    return null;
  }
  const rawLabel = String(candidate.raw_label || candidate.label || candidate.quality || '').trim();
  return {
    number: String(rawNumber || normalized).trim(),
    normalized,
    type: candidate.type || phoneTypeFromNumber(normalized, rawLabel),
    quality: normalizePhoneQuality(candidate.quality || rawLabel),
    is_whatsapp: candidate.is_whatsapp ?? (rawLabel.toLowerCase().includes('whatsapp') ? true : null),
    raw_label: rawLabel,
    source: candidate.source || 'Nova Vida',
    status: 'active',
  };
}

export function dedupePhones(phones = []) {
  const byNumber = new Map();
  for (const phone of phones) {
    const normalized = normalizePhoneCandidate(phone);
    if (!normalized) continue;
    if (!byNumber.has(normalized.normalized)) {
      byNumber.set(normalized.normalized, normalized);
    }
  }
  return Array.from(byNumber.values());
}
