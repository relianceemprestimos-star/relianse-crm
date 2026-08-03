export const PORTAL_CONFIGS = [
  {
    id: 'portal_consignado',
    name: 'Portal do Consignado',
    url: 'https://www.portaldoconsignado.com.br/home?1',
    requiresCaptcha: true,
    requiresAssistedLogin: true,
    providerStatus: 'assisted_login_required',
    category: 'Governos',
    convenioCode: 'portal_consignado',
    supportsIndividual: false,
    supportsBatch: false,
    marginProducts: [],
  },
  {
    id: 'governo_sp',
    name: 'Estado de SP',
    url: 'https://www.portaldoconsignado.com.br/home?1',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'implemented_browser_capsolver',
    category: 'Governos',
    convenioCode: 'governo_sp',
    supportsIndividual: true,
    supportsBatch: true,
    marginProducts: ['consignado', 'cartao_consignado', 'cartao_beneficio'],
  },
  {
    id: 'tjsp',
    name: 'TJSP',
    url: 'https://www.portaldoconsignado.com.br/home?1',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'implemented_browser_capsolver',
    category: 'Governos',
    convenioCode: 'tjsp',
    supportsIndividual: true,
    supportsBatch: true,
    marginProducts: ['consignado', 'cartao_beneficio'],
  },
  {
    id: 'prefeitura_ribeirao_preto',
    name: 'Prefeitura de Ribeirão Preto',
    url: 'https://saec.consiglog.com.br/Login.aspx',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'implemented',
    category: 'Prefeituras',
    convenioCode: 'prefeitura_ribeirao_preto',
    supportsIndividual: true,
    supportsBatch: true,
    marginProducts: ['consignado', 'cartao_consignado'],
  },
  {
    id: 'prefeitura_santana_parnaiba',
    name: 'Prefeitura de Santana de Parnaíba',
    url: 'https://santana.rf1consig.com.br/',
    apiBaseUrl: 'https://santanaapi.rf1consig.com.br/',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'implemented_rf1_api',
    category: 'Prefeituras',
    convenioCode: 'prefeitura_santana_parnaiba',
    supportsIndividual: true,
    supportsBatch: true,
    marginProducts: ['consignado', 'cartao_consignado', 'cartao_beneficio', 'acisesp'],
  },
  {
    id: 'prefeitura_ananindeua',
    name: 'Prefeitura de Ananindeua',
    url: 'https://ananindeua.rf1consig.com.br/',
    apiBaseUrl: 'https://ananindeuaapi.rf1consig.com.br/',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'implemented_rf1_api',
    category: 'Prefeituras',
    convenioCode: 'prefeitura_ananindeua',
    supportsIndividual: true,
    supportsBatch: true,
    marginProducts: ['consignado', 'cartao_consignado', 'cartao_beneficio', 'acisesp'],
  },
  {
    id: 'governo_amapa',
    name: 'Governo do Amapá',
    url: 'https://consignataria.apconsig.ap.gov.br/login',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'pending_provider',
    category: 'Governos',
    convenioCode: 'governo_amapa',
    supportsIndividual: false,
    supportsBatch: false,
    marginProducts: [],
  },
];

export function getPortalConfig(portalId) {
  return PORTAL_CONFIGS.find((portal) => portal.id === String(portalId || '')) || null;
}

export function normalizePortalId(portalId) {
  const value = String(portalId || '').trim();
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (['portal_consignado', 'portal-do-consignado', 'portalconsignado'].includes(normalized)) {
    return 'portal_consignado';
  }
  if (['estado_sp', 'estado-de-sp', 'gov_sp', 'governo-sp', 'governo_de_sp'].includes(normalized)) {
    return 'governo_sp';
  }
  if (['tjsp', 'tj_sp', 'tj-sp', 'tribunal_justica_sp'].includes(normalized)) {
    return 'tjsp';
  }
  if (value === 'governo_sp_tjsp' || value === 'governo-sp-tjsp') {
    return 'governo_sp';
  }
  if (value === 'governo-amapa' || normalized === 'governo_amapa') {
    return 'governo_amapa';
  }
  if (value === 'prefeitura-ribeirao-preto' || normalized === 'prefeitura_ribeirao_preto') {
    return 'prefeitura_ribeirao_preto';
  }
  if (
    value === 'prefeitura-santana-parnaiba' ||
    ['prefeitura_santana_parnaiba', 'santana', 'santana_de_parnaiba'].includes(normalized)
  ) {
    return 'prefeitura_santana_parnaiba';
  }
  if (
    value === 'prefeitura-ananindeua' ||
    ['prefeitura_ananindeua', 'ananindeua'].includes(normalized)
  ) {
    return 'prefeitura_ananindeua';
  }
  return value;
}

export function isRf1ApiPortal(portalId) {
  const config = getPortalConfig(normalizePortalId(portalId));
  return config?.providerStatus === 'implemented_rf1_api';
}

export function getMarginPortalConfigs() {
  return PORTAL_CONFIGS.filter((portal) => portal.convenioCode).map((portal) => ({
    id: portal.id,
    value: portal.id.replaceAll('_', '-'),
    name: portal.name,
    category: portal.category || 'Outros',
    convenio_code: portal.convenioCode,
    provider_status: portal.providerStatus,
    supports_individual: Boolean(portal.supportsIndividual),
    supports_batch: Boolean(portal.supportsBatch),
    requires_captcha: Boolean(portal.requiresCaptcha),
    margin_products: portal.marginProducts || [],
  }));
}
