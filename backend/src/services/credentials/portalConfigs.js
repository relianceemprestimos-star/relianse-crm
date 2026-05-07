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
    providerStatus: 'pending_provider',
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
  return value;
}
