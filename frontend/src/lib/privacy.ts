export function onlyDigits(value: string | number | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
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
