import type { Client, Settings } from '../types';
import { formatCurrencyDisplay, getMarginByProduct, getMarginSummary } from './margins';

function cleanDigits(value: string) {
  return String(value || '').replace(/\D/g, '');
}

export function formatPhoneToBrazilInternational(phone?: string) {
  const digits = cleanDigits(phone || '');
  if (!digits) {
    return '';
  }

  if (digits.startsWith('55')) {
    return digits;
  }

  return `55${digits}`;
}

export function formatPhoneDisplay(phone?: string) {
  const digits = cleanDigits(phone || '');
  const local = digits.startsWith('55') ? digits.slice(2) : digits;

  if (local.length === 11) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }

  if (local.length === 10) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  }

  return local || '-';
}

export function formatCpfDisplay(cpf?: string) {
  const digits = cleanDigits(cpf || '').slice(0, 11);
  if (digits.length !== 11) {
    return digits || '-';
  }

  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function applyTemplate(template: string, client: Client) {
  const margins = getMarginSummary(client);
  const consignacao = getMarginByProduct(client, 'consignacao')?.net_margin ?? client.margem_liquida_consignacao ?? null;
  const credito = getMarginByProduct(client, 'credito')?.net_margin ?? client.margem_liquida_credito ?? null;
  const cartao = getMarginByProduct(client, 'cartao')?.net_margin ?? client.margem_liquida_cartao ?? null;
  const bestMargin = margins.bestNetMargin ?? client.current_margin ?? null;
  const bestProduct = margins.bestProductLabel || client.best_product_label || client.best_product_type || '';

  return template
    .replaceAll('{nome}', client.name || '')
    .replaceAll('{cpf}', formatCpfDisplay(client.cpf))
    .replaceAll('{margem}', formatCurrencyDisplay(bestMargin))
    .replaceAll('{telefone}', formatPhoneDisplay(client.phone))
    .replaceAll('{margem_consignacao_liquida}', formatCurrencyDisplay(consignacao))
    .replaceAll('{margem_credito_liquida}', formatCurrencyDisplay(credito))
    .replaceAll('{margem_cartao_liquida}', formatCurrencyDisplay(cartao))
    .replaceAll('{melhor_margem}', formatCurrencyDisplay(bestMargin))
    .replaceAll('{melhor_produto}', bestProduct);
}

export function createWhatsAppLink(client: Client, messageTemplate: string, settings?: Settings) {
  const phone = formatPhoneToBrazilInternational(client.phone);
  if (!phone) {
    return '';
  }

  const fallbackTemplate =
    messageTemplate ||
    settings?.whatsapp_message ||
    'Oie, {nome}, tudo bem? É a Aline. Vi aqui que apareceu uma oportunidade no seu consignado. Posso te enviar uma simulação sem compromisso?';

  const message = applyTemplate(fallbackTemplate, client);
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

export function openWhatsAppConversation(client: Client, messageTemplate: string, settings?: Settings) {
  const link = createWhatsAppLink(client, messageTemplate, settings);
  if (!link) {
    return '';
  }

  window.open(link, '_blank', 'noopener,noreferrer');
  return link;
}

export function openWhatsAppWeb() {
  window.open('https://web.whatsapp.com', '_blank', 'noopener,noreferrer');
}
