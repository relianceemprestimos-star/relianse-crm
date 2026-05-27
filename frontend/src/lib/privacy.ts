function cleanDigits(value?: string | null) {
  return String(value || '').replace(/\D/g, '');
}

export function maskCpfForList(cpf?: string | null) {
  const digits = cleanDigits(cpf).slice(0, 11);
  if (!digits) return '-';
  const suffix = digits.slice(-2).padStart(2, '*');
  return `***.***.***-${suffix}`;
}

export function maskPhoneForList(phone?: string | null) {
  const digits = cleanDigits(phone);
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  if (!local) return '-';
  const suffix = local.slice(-4).padStart(4, '*');
  return `(**) *****-${suffix}`;
}

export function maskBankAccountForList(value?: string | null) {
  const digits = cleanDigits(value);
  if (!digits) return '-';
  const suffix = digits.slice(-3).padStart(3, '*');
  return `****${suffix}`;
}
