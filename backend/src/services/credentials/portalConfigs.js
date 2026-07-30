export const PORTAL_CONFIGS = [
  {
    id: 'prefeitura_ribeirao_preto',
    name: 'Prefeitura de Ribeirão Preto',
    url: 'https://saec.consigx.com.br/Login.aspx',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'implemented',
  },
  {
    id: 'prefeitura_guarulhos_proconsig',
    name: 'Prefeitura de Guarulhos',
    url: 'https://proconsig.com.br/consulta_margem',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'script_preservado',
  },
  {
    id: 'prefeitura_sorriso_mt',
    name: 'Prefeitura de Sorriso MT',
    url: 'https://sistema.digitalconsig.com.br/Login.aspx',
    requiresCaptcha: false,
    requiresAssistedLogin: false,
    providerStatus: 'script_preservado',
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
  if (value === 'prefeitura-guarulhos' || value === 'prefeitura-guarulhos-proconsig') {
    return 'prefeitura_guarulhos_proconsig';
  }
  if (value === 'prefeitura-sorriso-mt') {
    return 'prefeitura_sorriso_mt';
  }
  return value;
}
