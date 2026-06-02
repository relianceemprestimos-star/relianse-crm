function cleanDigits(value?: string | null) {
  return String(value || '').replace(/\D/g, '');
}

export function onlyDigits(value: string | number | null | undefined) {
  return cleanDigits(String(value ?? ''));
}

export function maskCpf(value: string | number | null | undefined) {
  const digits = onlyDigits(value);
  if (digits.length < 2) return '***.***.***-**';
  return `***.***.***-${digits.slice(-2)}`;
}

export function maskPhone(value: string | number | null | undefined) {
  const digits = onlyDigits(value);
  if (digits.length < 4) return '(**) *****-****';
  return `(**) *****-${digits.slice(-4)}`;
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

export function formatMoney(value: number | string | null | undefined) {
  const number = Number(value || 0);
  return number.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
}

export function productLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    consignado: 'Consignado',
    cartao_consignado: 'Cartao consignado',
    cartao_beneficio: 'Cartao beneficio',
  };
  return labels[String(value || '')] || String(value || 'Produto');
}
