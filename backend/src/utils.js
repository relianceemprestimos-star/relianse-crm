import xlsx from 'xlsx';

export const PRODUCT_DEFINITIONS = {
  consignacao: {
    key: 'consignacao',
    label: 'Consignação',
    aliases: ['consignacao', 'consig', 'consignado', 'consignao'],
  },
  credito: {
    key: 'credito',
    label: 'Crédito',
    aliases: ['credito', 'crdito', 'emprestimo', 'emprestimo consignado'],
  },
  cartao: {
    key: 'cartao',
    label: 'Cartão',
    aliases: ['cartao', 'carto', 'cartao consignado', 'cartao de credito', 'card'],
  },
  outros: {
    key: 'outros',
    label: 'Outros',
    aliases: ['outros', 'outro'],
  },
};

export const CONSULTA_STATUS_ALIASES = {
  com_marg: ['com margem', 'com_marg', 'commarg', 'positivo', 'positiva', 'disponivel', 'disponível'],
  sem_marg: ['sem margem', 'sem_marg', 'semmarg', 'sem margem disponivel', 'sem margem disponível', 'zero'],
  erro: ['erro', 'falha', 'invalid', 'invalido', 'inválido'],
};

export function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

export function normalizeHeaderKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

export function cleanDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

export function parseMoney(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const normalized = text
    .replace(/[R$\s]/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/(?!^)-/g, '');

  const number = Number(normalized);
  if (Number.isFinite(number)) {
    return number;
  }

  const cleaned = text.replace(/[^\d,-]/g, '');
  const sign = cleaned.includes('-') ? -1 : 1;
  const digits = cleaned.replace(/-/g, '').replace(/\./g, '').replace(',', '.');
  const fallback = Number(digits);
  return Number.isFinite(fallback) ? sign * fallback : null;
}

export function formatMoney(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '-';
  }

  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(number));
  return number < 0 ? `R$ -${formatted}` : `R$ ${formatted}`;
}

export function formatCpfDisplay(cpf) {
  const digits = cleanDigits(cpf).slice(0, 11);
  if (digits.length !== 11) {
    return digits || '-';
  }

  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function formatPhoneDisplay(phone) {
  const digits = cleanDigits(phone);
  const local = digits.startsWith('55') ? digits.slice(2) : digits;

  if (local.length === 11) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }

  if (local.length === 10) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  }

  return local || '-';
}

export function normalizePhoneToBrazilInternational(phone) {
  const digits = cleanDigits(phone);
  if (!digits) {
    return '';
  }

  if (digits.startsWith('55')) {
    return digits;
  }

  return `55${digits}`;
}

export function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

export function readSpreadsheetRows(buffer, filename) {
  const lower = String(filename || '').toLowerCase();
  const workbook = lower.endsWith('.csv')
    ? xlsx.read(buffer.toString('utf8'), { type: 'string', raw: true, cellDates: false })
    : xlsx.read(buffer, { type: 'buffer', raw: true, cellDates: false });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return [];
  }

  const worksheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(worksheet, { defval: '', raw: true, blankrows: false });
}

export function matchColumn(headers, aliases) {
  const normalizedHeaders = headers.map((header) => ({
    raw: header,
    norm: normalizeHeaderKey(header),
  }));

  const normalizedAliases = aliases.map((alias) => normalizeHeaderKey(alias));
  const found = normalizedHeaders.find((header) => normalizedAliases.some((alias) => header.norm.includes(alias)));
  return found?.raw || '';
}

export function getWorksheetHeaders(rows) {
  return rows.length ? Object.keys(rows[0]) : [];
}

export function stringifyRawRow(row) {
  return JSON.stringify(row || {}, null, 0);
}

export function normalizeConsultaStatus(value, fallback = '') {
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }

  if (CONSULTA_STATUS_ALIASES.erro.some((alias) => text.includes(alias))) {
    return 'erro';
  }

  if (CONSULTA_STATUS_ALIASES.com_marg.some((alias) => text.includes(alias))) {
    return 'com_marg';
  }

  if (CONSULTA_STATUS_ALIASES.sem_marg.some((alias) => text.includes(alias))) {
    return 'sem_marg';
  }

  return fallback || text;
}

export function normalizeCpfValue(value) {
  const original = value === null || value === undefined ? '' : String(value).trim();
  if (!original) {
    return {
      cpf: '',
      displayCpf: '',
      alert: 'CPF vazio',
      alerts: ['CPF vazio'],
      isValid: false,
    };
  }

  const scientific = /e[+-]?\d+/i.test(original);
  let digits = '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    digits = String(Math.trunc(value));
  } else if (scientific) {
    const parsed = Number(original.replace(',', '.'));
    digits = Number.isFinite(parsed) ? String(Math.trunc(parsed)) : cleanDigits(original);
  } else {
    digits = cleanDigits(original);
  }

  const alerts = [];
  if (digits.length < 11 && (scientific || typeof value === 'number')) {
    digits = digits.padStart(11, '0');
    alerts.push('CPF completado com zeros a esquerda');
  }

  if (digits.length > 11) {
    alerts.push('CPF possui mais de 11 digitos');
  }

  if (digits.length !== 11) {
    alerts.push('CPF invalido');
  }

  return {
    cpf: digits,
    displayCpf: formatCpfDisplay(digits),
    alert: alerts.join('; '),
    alerts,
    isValid: digits.length === 11,
  };
}
