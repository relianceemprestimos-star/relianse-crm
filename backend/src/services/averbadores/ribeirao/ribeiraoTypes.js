import { PRODUCT_DEFINITIONS, cleanDigits, formatMoney, normalizeCpfValue, parseMoney } from '../../../utils.js';

export const RIBEIRAO_SESSION_STATUSES = {
  CONNECTING: 'conectando',
  WAITING_CAPTCHA: 'aguardando_captcha_manual',
  CONNECTED: 'conectado',
  LOGIN_ERROR: 'erro_login',
  SESSION_EXPIRED: 'sessao_expirada',
  ERROR: 'erro',
};

export const RIBEIRAO_QUERY_STATUSES = {
  WITH_MARGIN: 'com_marg',
  WITHOUT_MARGIN: 'sem_marg',
  ERROR: 'erro',
  CAPTCHA_REQUIRED: 'captcha_required',
  LOGIN_ERROR: 'login_error',
  SESSION_EXPIRED: 'session_expired',
};

function money(value) {
  const parsed = parseMoney(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickMoney(...values) {
  for (const value of values) {
    const parsed = money(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function productState(netValue) {
  if (netValue === null || netValue === undefined) {
    return { label: 'Sem dado', tone: 'neutral' };
  }
  if (netValue > 0) {
    return { label: 'Disponivel', tone: 'success' };
  }
  if (netValue === 0) {
    return { label: 'Sem margem', tone: 'neutral' };
  }
  return { label: 'Negativa', tone: 'danger' };
}

function maskCpf(cpf) {
  const digits = cleanDigits(cpf);
  if (digits.length !== 11) {
    return '***';
  }
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

function bestMarginFromProducts(products) {
  let best = { product_type: '', net: null };
  for (const item of products) {
    const value = item?.net;
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      continue;
    }
    const numeric = Number(value);
    if (best.net === null || numeric > best.net) {
      best = { product_type: item.product_type, net: numeric };
    }
  }
  return best;
}

function selectFirstDefined(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function labelForProductType(productType) {
  return PRODUCT_DEFINITIONS[productType]?.label || productType || '';
}

export function normalizeRibeiraoCpf(value) {
  const normalized = normalizeCpfValue(value);
  return {
    cpf: normalized.cpf,
    cpf_display: normalized.displayCpf,
    cpf_masked: maskCpf(normalized.cpf || value),
    alerts: normalized.alerts,
    isValid: normalized.isValid,
  };
}

export function normalizeRibeiraoQueryResult(rawResult, cpf, sessionId, userId, clientMatches = []) {
  const payload = rawResult?.payload_extra || rawResult?.payload || rawResult?.raw_data || rawResult || {};
  const status = String(rawResult?.status || rawResult?.consulta_status || 'erro').toLowerCase();

  const consignacaoGross = pickMoney(
    payload.facultativa_margem_consignavel,
    payload.consignacao_bruta,
    payload.margem_consignavel_bruta,
    payload.margem_bruta_consignacao,
    payload.bruta_facultativa
  );
  const consignacaoNet = pickMoney(
    payload.facultativa_disponivel,
    payload.consignacao_liquida,
    payload.margem_consignavel_liquida,
    payload.margem_liquida_consignacao,
    rawResult?.margem_disponivel
  );
  const creditoGross = pickMoney(
    payload.margem_emprestimo_total,
    payload.emprestimo_bruto,
    payload.credito_bruto,
    payload.margem_bruta_credito
  );
  const creditoNet = pickMoney(
    payload.margem_emprestimo_disponivel,
    payload.emprestimo_disponivel,
    payload.credito_liquida,
    payload.margem_liquida_credito
  );
  const cartaoGross = pickMoney(
    payload.cartao_margem_consignavel,
    payload.cartao_bruto,
    payload.margem_cartao,
    payload.margem_bruta_cartao,
    payload.bruta_cartao
  );
  const cartaoNet = pickMoney(
    payload.cartao_disponivel,
    payload.cartao_liquida,
    payload.margem_liquida_cartao,
    rawResult?.margem_cartao,
    rawResult?.margem_cartao_beneficio,
    payload.disp_cartao
  );

  const margins = {
    consignacao: {
      gross: consignacaoGross,
      net: consignacaoNet,
      source_gross_column: 'facultativa_margem_consignavel',
      source_net_column: 'facultativa_disponivel',
    },
    credito: {
      gross: creditoGross,
      net: creditoNet,
      source_gross_column: 'margem_emprestimo_total',
      source_net_column: 'margem_emprestimo_disponivel',
    },
    cartao: {
      gross: cartaoGross,
      net: cartaoNet,
      source_gross_column: 'cartao_margem_consignavel',
      source_net_column: 'cartao_disponivel',
    },
  };

  const best = bestMarginFromProducts(Object.entries(margins).map(([product_type, item]) => ({ product_type, net: item.net })));
  const queryStatus =
    status.includes('captcha')
      ? RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED
      : status.includes('login')
        ? RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR
        : status.includes('expire')
          ? RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED
          : status.includes('success') || status.includes('sucesso')
            ? best.net !== null && best.net > 0
              ? RIBEIRAO_QUERY_STATUSES.WITH_MARGIN
              : RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN
            : status.includes('not_found')
              ? RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN
              : status.includes('no_margin')
                ? RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN
                : status.includes('erro')
                  ? RIBEIRAO_QUERY_STATUSES.ERROR
                  : best.net !== null && best.net > 0
                    ? RIBEIRAO_QUERY_STATUSES.WITH_MARGIN
                    : RIBEIRAO_QUERY_STATUSES.ERROR;

  const rawNome = selectFirstDefined([payload.nome_portal, payload.nome, payload.name, rawResult?.nome]);
  const rawMatricula = selectFirstDefined([payload.matricula, rawResult?.matricula]);
  const rawOrgao = selectFirstDefined([payload.orgao, payload.orgao_nome, payload.convenio, rawResult?.orgao]);
  const mensagem = selectFirstDefined([
    rawResult?.detalhe_erro,
    rawResult?.error_msg,
    rawResult?.mensagem,
    rawResult?.message,
    payload.mensagem,
    payload.message,
    queryStatus === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN ? 'Consulta realizada com margem positiva.' : '',
    queryStatus === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN ? 'Consulta realizada, sem margem disponivel.' : '',
  ]);

  return {
    success: queryStatus === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN || queryStatus === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN,
    cpf: cleanDigits(cpf),
    cpf_masked: maskCpf(cpf),
    nome: rawNome,
    matricula: rawMatricula,
    orgao: rawOrgao,
    margem_consignavel_bruta: consignacaoGross,
    margem_consignavel_liquida: consignacaoNet,
    margem_cartao_bruta: cartaoGross,
    margem_cartao_liquida: cartaoNet,
    margins,
    consultaStatus: queryStatus,
    mensagem,
    best_product_type: best.product_type || '',
    best_net_margin: best.net === null || best.net === undefined ? null : Number(best.net),
    client_matches: clientMatches,
    rawResult,
    raw_result_json: JSON.stringify(rawResult ?? {}, null, 0),
    session_id: sessionId,
    user_id: userId,
    consulta_status_label:
      queryStatus === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN
        ? 'Com margem'
        : queryStatus === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN
          ? 'Sem margem'
          : queryStatus === RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED
          ? 'Aguardando confirmação'
            : queryStatus === RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR
              ? 'Erro de login'
              : queryStatus === RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED
                ? 'Sessao expirada'
                : 'Erro',
    products: Object.entries(margins).map(([product_type, item]) => ({
      product_type,
      gross_margin: item.gross,
      net_margin: item.net,
      state: productState(item.net),
      source_gross_column: item.source_gross_column,
      source_net_column: item.source_net_column,
    })),
  };
}

export function formatRibeiraoSummary(result) {
  return {
    cpf: result.cpf,
    cpf_masked: result.cpf_masked,
    consulta_status: result.consultaStatus,
    consulta_status_label: result.consulta_status_label,
    nome: result.nome,
    matricula: result.matricula,
    orgao: result.orgao,
    best_product_type: result.best_product_type,
    best_product_label: labelForProductType(result.best_product_type),
    best_net_margin: result.best_net_margin,
    best_net_margin_formatted: formatMoney(result.best_net_margin),
    margem_consignavel_bruta: result.margem_consignavel_bruta ?? null,
    margem_consignavel_liquida: result.margem_consignavel_liquida ?? null,
    margem_cartao_bruta: result.margem_cartao_bruta ?? null,
    margem_cartao_liquida: result.margem_cartao_liquida ?? null,
    margem_consignavel_bruta_formatted: formatMoney(result.margem_consignavel_bruta),
    margem_consignavel_liquida_formatted: formatMoney(result.margem_consignavel_liquida),
    margem_cartao_bruta_formatted: formatMoney(result.margem_cartao_bruta),
    margem_cartao_liquida_formatted: formatMoney(result.margem_cartao_liquida),
    mensagem: result.mensagem,
    margins: result.products,
    raw_result_json: result.raw_result_json,
    success: result.success,
  };
}
