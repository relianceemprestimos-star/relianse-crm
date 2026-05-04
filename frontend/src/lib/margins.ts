import type { Client, MarginRecord, ProductType } from '../types';

export function formatCurrencyDisplay(value?: number | string | null) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return '-';
  }

  const formatted = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(number));
  return number < 0 ? `R$ -${formatted}` : `R$ ${formatted}`;
}

export function getMarginByProduct(client: Client, productType: ProductType): MarginRecord | null {
  return client.margins?.find((margin) => margin.product_type === productType) || null;
}

export function getMarginSummary(client: Client) {
  const margins = (client.margins || []).filter((margin) => margin.product_type !== 'outros');
  const best = margins.reduce<{
    product_type: ProductType | '';
    net_margin: number | null;
    gross_margin: number | null;
  }>(
    (acc, margin) => {
      const net = margin.net_margin;
      if (net === null || net === undefined || !Number.isFinite(Number(net))) {
        return acc;
      }
      if (acc.net_margin === null || Number(net) > Number(acc.net_margin)) {
        return {
          product_type: margin.product_type,
          net_margin: Number(net),
          gross_margin: margin.gross_margin ?? null,
        };
      }
      return acc;
    },
    { product_type: client.best_product_type || '', net_margin: client.best_net_margin ?? null, gross_margin: null }
  );

  return {
    consignacao: getMarginByProduct(client, 'consignacao'),
    credito: getMarginByProduct(client, 'credito'),
    cartao: getMarginByProduct(client, 'cartao'),
    bestProductType: (best.product_type || client.best_product_type || '') as ProductType | '',
    bestProductLabel: client.best_product_label || productLabel(best.product_type || client.best_product_type || ''),
    bestNetMargin: best.net_margin ?? client.best_net_margin ?? null,
    bestNetMarginFormatted: formatCurrencyDisplay(best.net_margin ?? client.best_net_margin ?? null),
  };
}

export function marginState(value?: number | null) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return { tone: 'neutral' as const, label: 'Sem dados' };
  }
  if (number > 0) {
    return { tone: 'success' as const, label: 'Disponível' };
  }
  if (number === 0) {
    return { tone: 'neutral' as const, label: 'Sem margem' };
  }
  return { tone: 'danger' as const, label: 'Negativa' };
}

export function productLabel(productType: ProductType | '') {
  const labels: Record<ProductType, string> = {
    consignacao: 'Consignação',
    credito: 'Crédito',
    cartao: 'Cartão',
    outros: 'Outros',
  };

  return productType ? labels[productType] : '-';
}
