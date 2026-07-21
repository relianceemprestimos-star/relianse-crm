export const PORTAL_CONFIGS = [
  {
    id: 'prefeitura_ribeirao_preto',
    name: 'Prefeitura de Ribeirão Preto',
    url: 'https://saec.consiglog.com.br/Login.aspx',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'implemented',
  },
  {
    id: 'governo_sp',
    name: 'Governo de SP',
    url: 'https://www.portaldoconsignado.com.br/home?1',
    requiresCaptcha: true,
    requiresAssistedLogin: true,
    providerStatus: 'assisted_login_required',
  },
  {
    id: 'governo_amapa',
    name: 'Governo do Amapá',
    url: 'https://consignataria.apconsig.ap.gov.br/login',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'implemented',
  },
  {
    id: 'prefeitura_santana_parnaiba',
    name: 'Prefeitura de Santana de Parnaíba',
    url: 'https://santana.rf1consig.com.br/servidor/principal',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'web_portal_until_api',
  },
  {
    id: 'prefeitura_ananindeua',
    name: 'Prefeitura de Ananindeua',
    url: 'https://santana.rf1consig.com.br/servidor/principal',
    requiresCaptcha: true,
    requiresAssistedLogin: false,
    providerStatus: 'web_portal_until_api',
  },
];

export function getPortalConfig(portalId) {
  return PORTAL_CONFIGS.find((portal) => portal.id === String(portalId || '')) || null;
}

export function normalizePortalId(portalId) {
  const value = String(portalId || '').trim();
  if (value === 'governo_sp_tjsp' || value === 'governo-sp-tjsp') {
    return 'governo_sp';
  }
  if (value === 'governo-amapa') {
    return 'governo_amapa';
  }
  if (value === 'prefeitura-ribeirao-preto') {
    return 'prefeitura_ribeirao_preto';
  }
  if (value === 'prefeitura-santana-parnaiba') {
    return 'prefeitura_santana_parnaiba';
  }
  if (value === 'prefeitura-ananindeua' || value === 'ananindeua') {
    return 'prefeitura_ananindeua';
  }
  return value;
}
