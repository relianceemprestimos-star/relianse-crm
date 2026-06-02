export type ClientStatus =
  | 'novo_na_fila'
  | 'em_atendimento'
  | 'aguardando_retorno'
  | 'finalizado'
  | 'sem_interesse'
  | 'convertido';

export type ConsultaStatus = 'com_marg' | 'sem_marg' | 'erro';
export type ProductType = 'consignacao' | 'credito' | 'cartao' | 'cartao_beneficio' | 'outros';

export interface Base {
  id: number;
  nome_base: string;
  tipo_base: string;
  campaign_id?: number | null;
  convenio: string;
  estado: string;
  cidade: string;
  arquivo_original: string;
  total_clientes: number;
  total_com_margem: number;
  total_sem_margem: number;
  total_erro: number;
  observacao?: string;
  is_active?: number | boolean;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Campaign {
  id: number;
  name: string;
  convenio: string;
  description?: string;
  product_focus: string;
  status: 'active' | 'inactive' | 'archived' | string;
  internal_notes?: string;
  created_by?: number | null;
  created_by_name?: string;
  file_name?: string;
  total_clients: number;
  total_bases: number;
  total_pendente: number;
  total_em_atendimento: number;
  total_agendados: number;
  total_finalizados: number;
  total_convertidos: number;
  total_sem_interesse: number;
  last_base_imported_at?: string | null;
  created_at?: string;
  updated_at?: string;
  total_users?: number;
  users?: Array<{
    id: number;
    name: string;
    login: string;
    role: string;
  }>;
  bases?: Base[];
}

export type DispatchCampaignStatus = 'rascunho' | 'em_andamento' | 'concluida' | 'pausada' | string;
export type DispatchProduct = 'consignado' | 'cartao_consignado' | 'cartao_beneficio' | string;

export interface CampaignCoefficient {
  cadastrado: boolean;
  id?: number;
  data: string;
  coeficiente: number | null;
  prazo: number | null;
  cadastrado_por?: string;
  cadastrado_em?: string;
  updated_at?: string;
}

export interface BankCoefficient {
  id?: number | null;
  data: string;
  convenio: 'gov_sp' | 'prefeitura_rp' | string;
  banco: string;
  banco_label: string;
  produto: DispatchProduct;
  coeficiente: number | null;
  taxa: number | null;
  prazo: number | null;
  primeiro_vencimento_dias?: number | null;
  status: 'ativo' | 'inativo' | 'aguardando' | string;
  cadastrado: boolean;
  cadastrado_por?: string;
  cadastrado_em?: string;
  updated_at?: string;
}

export interface CampaignOpportunity {
  client_id: number;
  nome: string;
  cpf: string;
  convenio: 'gov_sp' | 'prefeitura_rp' | string;
  convenio_label?: string;
  telefone: string;
  produto: DispatchProduct;
  margem_disponivel: number;
  valor_liberado: number;
  faixa_valor?: string;
  faixa_valor_label?: string;
  prazo: number;
  coeficiente: number;
  taxa?: number | null;
  banco?: string;
  banco_label?: string;
  primeiro_vencimento_dias?: number | null;
  grupo?: string;
  status_regra?: string;
  motivo_regra?: string;
  idade?: number | null;
  sexo?: string;
  data_nascimento?: string;
  orgao?: string;
  matricula?: string;
  cargo?: string;
  vinculo?: string;
  oferta_complementar: boolean;
  produto_complementar?: DispatchProduct | null;
  valor_complementar?: number | null;
}

export interface CampaignOpportunitySummary {
  total_importado: number;
  com_margem: number;
  sem_margem: number;
  erro_margem: number;
  elegiveis: number;
  sem_oportunidade: number;
  analise_manual: number;
  com_telefone: number;
  sem_telefone: number;
  aguardando_coeficiente: number;
}

export interface PipelineGroup {
  grupo: string;
  grupo_label: string;
  total_clientes: number;
  total_valor_liberado: number;
  status: string;
  updated_at?: string;
}

export interface PipelineSimulationSummary {
  esteira_id: number;
  base: Base;
  total_clientes: number;
  total_simulacoes: number;
  prontas: number;
  aguardando_coeficiente: number;
  status: string;
  grupos: PipelineGroup[];
}

export interface PipelineGroupClient {
  id: number;
  esteira_id: number;
  client_id: number;
  nome: string;
  convenio: string;
  convenio_label?: string;
  banco: string;
  banco_label: string;
  produto: DispatchProduct;
  margem_disponivel: number;
  valor_liberado: number;
  coeficiente: number | null;
  taxa: number | null;
  prazo: number | null;
  primeiro_vencimento: string;
  faixa_valor: string;
  faixa_valor_label: string;
  grupo: string;
  status_regra: string;
  motivo_regra: string;
  idade: number | null;
  sexo: string;
  data_nascimento: string;
  telefone_status: string;
  metadata?: Record<string, unknown>;
}

export interface DispatchCampaign {
  id: string;
  nome: string;
  convenio: string;
  produto?: string;
  banco?: string;
  faixa_valor?: string;
  mensagem_inicial?: string;
  followup_mensagem?: string;
  followup_intervalo_horas?: number;
  janela_inicio?: string;
  janela_fim?: string;
  intervalo_envios_segundos?: number;
  coeficiente: number;
  prazo: number;
  sessao_rewhats?: string;
  status: DispatchCampaignStatus;
  criada_em: string;
  iniciada_em?: string | null;
  concluida_em?: string | null;
  total_disparos: number;
  total_respostas: number;
  total_aceites: number;
}

export interface DispatchCampaignClient {
  id: number;
  campanha_id: string;
  client_id: number;
  nome?: string;
  cpf?: string;
  produto: DispatchProduct;
  margem_disponivel: number;
  valor_liberado: number;
  oferta_complementar: boolean;
  produto_complementar?: DispatchProduct | null;
  valor_complementar?: number | null;
  telefone: string;
  status: string;
  enviado_em?: string | null;
  respondeu_em?: string | null;
  status_atualizado_em?: string | null;
}

export interface DocumentChecklist {
  id: number;
  campanha_id: string;
  client_id?: number | null;
  telefone: string;
  banco: string;
  status: 'pendente' | 'completo' | 'aguardando_humano' | string;
  conta_digital: number | boolean;
  isento_documentos: number | boolean;
  requer_rg_cnh: number | boolean;
  requer_comprovante: number | boolean;
  requer_holerite: number | boolean;
  requer_dados_bancarios: number | boolean;
  requer_extrato: number | boolean;
  recebeu_rg_cnh: number | boolean;
  recebeu_comprovante: number | boolean;
  recebeu_holerite: number | boolean;
  recebeu_dados_bancarios: number | boolean;
  recebeu_extrato: number | boolean;
  observacoes?: string;
  atualizado_em?: string;
  nome_cliente?: string;
  documentos_recebidos?: number;
  pendentes?: Array<{ tipo: string; label: string }>;
}

export interface ClientDocument {
  id: number;
  campanha_id?: string;
  client_id?: number | null;
  telefone: string;
  tipo_documento: string;
  nome_arquivo: string;
  url_arquivo?: string;
  caminho?: string;
  mimetype?: string;
  status: 'recebido' | 'validado' | 'rejeitado' | string;
  document_ai_status?: string;
  document_ai_text?: string;
  document_ai_json?: string;
  document_ai_error?: string;
  document_ai_processed_at?: string;
  recebido_em: string;
  observacao?: string;
}

export interface ReWhatsSession {
  id: string;
  nome?: string;
  numero?: string;
  conectado: boolean;
  status?: string;
}

export interface MarginRecord {
  id?: number;
  client_id?: number;
  product_type: ProductType;
  product_label?: string;
  gross_margin: number | null;
  net_margin: number | null;
  source_gross_column?: string;
  source_net_column?: string;
  status_label?: string;
  gross_margin_formatted?: string;
  net_margin_formatted?: string;
}

export interface Client {
  id: number;
  campaign_id?: number | null;
  base_id?: number | null;
  name: string;
  cpf: string;
  phone: string;
  email: string;
  status: ClientStatus;
  status_atendimento?: ClientStatus;
  consulta_status: ConsultaStatus;
  consulta_status_label?: string;
  consulta_mensagem: string;
  assigned_to?: number | null;
  assigned_to_name?: string;
  queue_position: number;
  campaign_name?: string;
  campaign_file_name?: string;
  base_name?: string;
  base_type?: string;
  base_convenio?: string;
  base_state?: string;
  base_city?: string;
  base_file_name?: string;
  base_observation?: string;
  base_is_active?: boolean;
  base_archived_at?: string | null;
  has_duplicate_in_other_base?: boolean;
  duplicate_bases?: Base[];
  status_label?: string;
  last_interaction_at?: string;
  last_interaction_at_formatted?: string;
  last_interaction_type?: string;
  last_interaction_note?: string;
  next_return_at?: string;
  next_return_at_formatted?: string;
  created_at?: string;
  updated_at?: string;
  updated_at_formatted?: string;
  created_at_formatted?: string;
  best_product_type?: ProductType | '';
  best_product_label?: string;
  best_net_margin?: number | null;
  best_net_margin_formatted?: string;
  current_margin?: number | null;
  current_margin_formatted?: string;
  margem_bruta_consignacao?: number | null;
  margem_liquida_consignacao?: number | null;
  margem_bruta_credito?: number | null;
  margem_liquida_credito?: number | null;
  margem_bruta_cartao?: number | null;
  margem_liquida_cartao?: number | null;
  margins?: MarginRecord[];
  margins_map?: Record<ProductType, Omit<MarginRecord, 'product_type'>>;
  raw_data_json?: string;
  raw_data?: Record<string, unknown>;
  scheduled_returns?: unknown[];
  deals?: unknown[];
  interactions?: unknown[];
  phones?: ClientPhone[];
  nova_vida_data?: ClientEnrichmentData | null;
  nova_vida_last_lookup_at?: string;
  nova_vida_last_lookup_at_formatted?: string;
  nova_vida_lookup_status?: string;
  phone_lookup_job?: PhoneLookupJob | null;
}

export interface ClientAddress {
  address_full?: string;
  full_address?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  zip_code?: string;
}

export interface ClientEnrichmentData {
  id?: number;
  client_id?: number | null;
  source?: string;
  cpf?: string;
  full_name?: string;
  birth_date?: string;
  age?: number | null;
  gender?: string;
  mother_name?: string;
  father_name?: string;
  email?: string;
  emails?: string[];
  address_full?: string;
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  addresses?: ClientAddress[];
  raw_data?: Record<string, unknown>;
  searched_at?: string;
  searched_at_formatted?: string;
}

export interface ClientPhone {
  id: number;
  client_id: number;
  phone_number: string;
  normalized_phone: string;
  type?: string;
  source: string;
  quality?: string;
  is_whatsapp?: boolean | null;
  is_primary: boolean;
  status: string;
  raw_label?: string;
  searched_at?: string;
  searched_at_formatted?: string;
}

export interface PhoneLookupJob {
  id: number;
  client_id: number;
  cpf: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'not_found' | 'failed' | 'blocked' | 'requires_manual_login' | string;
  source: string;
  attempts: number;
  error_message?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
  updated_at?: string;
  client_name?: string;
}

export interface PhoneLookupHistoryItem {
  id: number;
  client_id?: number | null;
  cpf?: string;
  cpf_masked: string;
  nome?: string;
  name: string;
  full_name?: string;
  telefone_pesquisado?: string;
  source: string;
  origin?: string;
  status: string;
  message?: string;
  phones_found_count: number;
  phones_count?: number;
  addresses_count?: number;
  emails_count?: number;
  has_address?: boolean;
  has_birth_date?: boolean;
  error_message?: string;
  consulted_at?: string;
  consulted_at_formatted?: string;
  expires_at?: string;
  expires_at_formatted?: string;
  created_at: string;
  created_at_formatted?: string;
  client_name?: string;
  phones?: ClientPhone[];
  addresses?: ClientAddress[];
  emails?: Array<{ email: string; is_primary?: boolean }>;
}

export interface DashboardData {
  stats: Record<string, number>;
  productStats?: Array<{
    product_type: ProductType;
    positive_count: number;
    zero_count: number;
    negative_count: number;
  }>;
  nextClient: {
    client: Client;
    queue_total: number;
    queue_position: number;
  } | null;
  recentActivity: Array<{
    id: number;
    client_id: number;
    client_name?: string;
    user_name?: string;
    type: string;
    note?: string;
    private_note?: string;
    created_at: string;
    cpf?: string;
    phone?: string;
    status?: string;
    best_net_margin?: number | null;
  }>;
}

export interface Settings {
  company_name: string;
  attendant_name: string;
  whatsapp_message: string;
  allow_column_editing: string;
  daily_limit: string;
  theme: string;
  expected_columns?: string;
}

export interface RibeiraoConfigStatus {
  configured: boolean;
  env_key: string;
  value_masked: string;
  message: string;
  hint: string;
}

export interface RibeiraoDiagnostics {
  ribeiraoConfigured: boolean;
  ribeiraoHost: string;
  hasLoginUrl: boolean;
  hasConsultaUrl: boolean;
  headless: boolean;
  loginUrlMasked?: string;
  consultaUrlMasked?: string;
  message?: string;
  hint?: string;
}

export interface UserRecord {
  id: number;
  name: string;
  login: string;
  email?: string;
  role: 'gerencial' | 'vendedor' | 'admin' | string;
  is_active: boolean;
  last_login_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UploadAnalysis {
  headers: string[];
  recognizedFields: Record<string, { status: string; source_column: string; alerts?: string[] }>;
  summary: {
    total_rows: number;
    valid_rows: number;
    invalid_rows: number;
    warnings: number;
    duplicates: number;
  };
  rows: Array<{
    rowNumber: number;
    name: string;
    cpf: string;
    cpf_display?: string;
    phone: string;
    email: string;
    consulta_status: ConsultaStatus | string;
    consulta_status_label?: string;
    consulta_mensagem: string;
    best_product_type?: ProductType | '';
    best_product_label?: string;
    best_net_margin?: number | null;
    best_net_margin_formatted?: string;
    margins: Record<
      ProductType,
      {
        product_type: ProductType;
        gross_margin: number | null;
        net_margin: number | null;
        source_gross_column: string;
        source_net_column: string;
      }
    > & { outros?: { product_type: ProductType; gross_margin: number | null; net_margin: number | null; source_gross_column: string; source_net_column: string } };
    margem_bruta_consignacao?: number | null;
    margem_liquida_consignacao?: number | null;
    margem_bruta_credito?: number | null;
    margem_liquida_credito?: number | null;
    margem_bruta_cartao?: number | null;
    margem_liquida_cartao?: number | null;
    raw_data_json?: string;
    raw_data?: Record<string, unknown>;
    row_alerts: string[];
    recognizedFields: Record<string, { status: string; source_column: string; alerts?: string[] }>;
    isValid: boolean;
  }>;
  previewRows?: Array<{
    rowNumber: number;
    name: string;
    cpf: string;
    cpf_display?: string;
    phone: string;
    email: string;
    consulta_status: ConsultaStatus | string;
    consulta_status_label?: string;
    consulta_mensagem: string;
    best_product_type?: ProductType | '';
    best_product_label?: string;
    best_net_margin?: number | null;
    best_net_margin_formatted?: string;
    margins: Record<
      ProductType,
      {
        product_type: ProductType;
        gross_margin: number | null;
        net_margin: number | null;
        source_gross_column: string;
        source_net_column: string;
      }
    > & { outros?: { product_type: ProductType; gross_margin: number | null; net_margin: number | null; source_gross_column: string; source_net_column: string } };
    margem_bruta_consignacao?: number | null;
    margem_liquida_consignacao?: number | null;
    margem_bruta_credito?: number | null;
    margem_liquida_credito?: number | null;
    margem_bruta_cartao?: number | null;
    margem_liquida_cartao?: number | null;
    raw_data_json?: string;
    raw_data?: Record<string, unknown>;
    row_alerts: string[];
    recognizedFields: Record<string, { status: string; source_column: string; alerts?: string[] }>;
    isValid: boolean;
  }>;
}

export interface ClientsResponse {
  clients: Client[];
  meta: {
    stats: Record<string, number>;
    campaigns: Campaign[];
    bases: Base[];
    users: UserRecord[];
  };
}

export interface ReportResponse {
  totals: Record<string, number>;
  daily: Array<{ day: string; total: number }>;
  productStats?: Array<{
    product_type: ProductType;
    positive_count: number;
    zero_count: number;
    negative_count: number;
  }>;
  rows: Array<{
    id: number;
    name: string;
    cpf: string;
    phone: string;
    email?: string;
    status: ClientStatus;
    base_id?: number | null;
    base_name?: string;
    base_type?: string;
    base_convenio?: string;
    base_state?: string;
    base_city?: string;
    base_file_name?: string;
    consulta_status?: ConsultaStatus | string;
    consulta_status_label?: string;
    consulta_mensagem?: string;
    best_product_type?: ProductType | '';
    best_product_label?: string;
    best_net_margin?: number | null;
    best_net_margin_formatted?: string;
    updated_at: string;
    campaign_name?: string;
    assigned_to_name?: string;
    last_note?: string;
    last_interaction_at?: string;
    next_return_at?: string;
    updated_at_formatted?: string;
    last_interaction_at_formatted?: string;
    next_return_at_formatted?: string;
    margins?: MarginRecord[];
  }>;
}

export type RibeiraoSessionStatus =
  | 'no_conectado'
  | 'conectando'
  | 'aguardando_captcha_manual'
  | 'aguardando_validacao_manual'
  | 'captcha_required'
  | 'conectado'
  | 'erro_login'
  | 'login_error'
  | 'portal_unavailable'
  | 'portal_unreachable'
  | 'browser_launch_error'
  | 'sessao_expirada'
  | 'expired'
  | 'error'
  | 'erro'
  | 'desconhecido';

export type RibeiraoQueryStatus =
  | 'com_marg'
  | 'sem_marg'
  | 'nao_encontrado'
  | 'erro'
  | 'captcha_required'
  | 'login_error'
  | 'session_expired';

export interface RibeiraoProductMargin {
  product_type: ProductType | 'outros' | string;
  gross_margin: number | null;
  net_margin: number | null;
  source_gross_column?: string;
  source_net_column?: string;
  state?: {
    label: string;
    tone: 'neutral' | 'accent' | 'success' | 'danger' | 'info';
  };
}

export interface RibeiraoSession {
  id: number;
  user_id: number;
  status: RibeiraoSessionStatus;
  message?: string;
  error_code?: string | null;
  stage?: string | null;
  started_at?: string;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
  raw?: Record<string, unknown> | null;
}

export interface RibeiraoQueryResult {
  id: number;
  user_id: number;
  session_id: number;
  client_id?: number | null;
  base_id?: number | null;
  cpf: string;
  cpf_masked: string;
  nome?: string;
  matricula?: string;
  orgao?: string;
  cargo?: string;
  vinculo?: string;
  consulta_status: RibeiraoQueryStatus;
  consulta_status_label?: string;
  mensagem?: string;
  best_product_type?: string;
  best_net_margin?: number | null;
  best_net_margin_formatted?: string;
  margem_emprestimo_total?: number | null;
  margem_emprestimo_disponivel?: number | null;
  margem_cartao_total?: number | null;
  margem_cartao_disponivel?: number | null;
  margem_emprestimo_total_formatted?: string;
  margem_emprestimo_disponivel_formatted?: string;
  margem_cartao_total_formatted?: string;
  margem_cartao_disponivel_formatted?: string;
  margem_consignavel_bruta?: number | null;
  margem_consignavel_liquida?: number | null;
  margem_cartao_bruta?: number | null;
  margem_cartao_liquida?: number | null;
  margem_consignavel_bruta_formatted?: string;
  margem_consignavel_liquida_formatted?: string;
  margem_cartao_bruta_formatted?: string;
  margem_cartao_liquida_formatted?: string;
  raw_result_json?: string;
  created_at?: string;
  created_at_formatted?: string;
  margins?: RibeiraoProductMargin[];
}

export interface RibeiraoHistoryItem extends RibeiraoQueryResult {
  user_name?: string;
  session_status?: RibeiraoSessionStatus;
  session_started_at?: string;
  session_finished_at?: string;
  session_error_message?: string;
  client_matches?: Array<{
    id: number;
    base_id?: number | null;
    name: string;
    cpf: string;
    phone?: string;
    email?: string;
    status_atendimento?: string;
    consulta_status?: string;
    consulta_mensagem?: string;
    best_product_type?: string;
    best_net_margin?: number | null;
    base_name?: string;
    base_type?: string;
    base_convenio?: string;
    base_state?: string;
    base_city?: string;
    base_file_name?: string;
    base_is_active?: boolean;
    base_archived_at?: string | null;
    base_created_at?: string;
    base_updated_at?: string;
  }>;
}

export interface AuthResponse {
  token: string;
  user: {
    id: number;
    name: string;
    login: string;
    role: 'gerencial' | 'vendedor' | 'admin';
    is_active: boolean;
    last_login_at?: string | null;
    created_at?: string;
    updated_at?: string;
  };
}

export interface ChangePasswordResponse {
  message: string;
}

export type RibeiraoBatchStatus =
  | 'pendente'
  | 'em_andamento'
  | 'pausado'
  | 'aguardando_captcha'
  | 'pausado_sessao_expirada'
  | 'concluido'
  | 'cancelado'
  | 'erro';

export type RibeiraoBatchSourceType = 'upload' | 'base';

export interface RibeiraoBatchPreviewRow {
  rowNumber: number;
  cpf: string;
  cpf_display: string;
  name?: string;
  raw_value: string;
  isValid: boolean;
  alerts: string[];
}

export interface RibeiraoBatchPreview {
  headers: string[];
  cpf_column: string;
  name_column?: string;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  preview_rows: RibeiraoBatchPreviewRow[];
  cpfs: string[];
  clients?: Array<{ cpf: string; cpf_display?: string; name?: string }>;
}

export interface RibeiraoBatchRecord {
  id: number;
  user_id: number;
  base_id?: number | null;
  source_type: RibeiraoBatchSourceType | string;
  source_file_name: string;
  total_cpfs: number;
  processed_count: number;
  success_count: number;
  no_margin_count: number;
  not_found_count: number;
  error_count: number;
  captcha_count: number;
  status: RibeiraoBatchStatus | string;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
  progress_percent?: number;
  user_name?: string;
  user_login?: string;
  base_name?: string;
  base_type?: string;
  base_convenio?: string;
  base_state?: string;
  base_city?: string;
  base_file_name?: string;
  base_is_active?: boolean;
  base_archived_at?: string | null;
}

export interface RibeiraoBatchResultItem extends RibeiraoHistoryItem {
  batch_id?: number | null;
  client_name?: string;
  client_base_id?: number | null;
  base_name?: string;
  base_type?: string;
  base_convenio?: string;
  base_state?: string;
  base_city?: string;
  base_file_name?: string;
}
