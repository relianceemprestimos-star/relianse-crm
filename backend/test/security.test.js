import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import xlsx from 'xlsx';

process.env.SQLITE_PATH = path.join(os.tmpdir(), `relianse-security-test-${process.pid}.sqlite`);
process.env.DATABASE_PATH = process.env.SQLITE_PATH;
process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.HASH_SECRET = 'test-hash-secret';

const protection = await import('../src/dataProtection.js');
const db = await import('../src/db.js');

await db.initDb();

test('mascara CPF, telefone e metadados sensiveis', () => {
  assert.equal(protection.maskCpf('12345678909'), '123.***.***-09');
  assert.equal(protection.maskPhone('5511999998888'), '***8888');
  assert.deepEqual(protection.sanitizeAuditMetadata({ cpf: '12345678909', phone: '11999998888', status: 'ok' }), {
    cpf: '123.***.***-09',
    phone: '***8888',
    status: 'ok',
  });
});

test('criptografa e descriptografa valor sensivel', () => {
  const encrypted = protection.encryptSensitiveValue('12345678909');
  assert.match(encrypted, /^v1:/);
  assert.notEqual(encrypted, '12345678909');
  assert.equal(protection.decryptSensitiveValue(encrypted), '12345678909');
});

test('consentimento ativo permite e opt-out bloqueia', () => {
  const consent = db.grantCustomerConsent({
    customerId: 1,
    channel: 'whatsapp',
    source: 'unit_test',
    actorUserId: 1,
  });
  assert.equal(consent.consent_status, 'active');
  assert.equal(db.getActiveConsent(1, 'whatsapp')?.consent_status, 'active');

  db.revokeCustomerConsent({
    customerId: 1,
    channel: 'whatsapp',
    actorUserId: 1,
    source: 'unit_test',
  });
  assert.equal(db.getActiveConsent(1, 'whatsapp'), undefined);
});

test('audit log sanitiza metadata antes de persistir', () => {
  db.writeAuditLog({
    actorUserId: 1,
    action: 'unit.test',
    entityType: 'client',
    entityId: '1',
    metadata: { cpf: '12345678909', telefone: '11999998888' },
  });
  const row = db.getDb().prepare("SELECT metadata_json FROM audit_log WHERE action = 'unit.test' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row.metadata_json.includes('123.***.***-09'));
  assert.ok(!row.metadata_json.includes('12345678909'));
});

test('importacao da esteira aceita planilha somente com CPF sem cabecalho', () => {
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([['12345678909'], ['11144477735']]);
  xlsx.utils.book_append_sheet(workbook, sheet, 'Base');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const analysis = db.analyzeSpreadsheet(buffer, 'base-sem-cabecalho.xlsx');
  assert.equal(analysis.summary.valid_rows, 2);
  assert.equal(analysis.rows[0].cpf, '12345678909');
  assert.equal(analysis.rows[0].name, 'Cliente 8909');
});

test('importacao da esteira aceita coluna de CPF sem nome do cliente', () => {
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet([{ CPF: '12345678909' }, { CPF: '11144477735' }]);
  xlsx.utils.book_append_sheet(workbook, sheet, 'Base');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const analysis = db.analyzeSpreadsheet(buffer, 'base-cpf.xlsx');
  assert.equal(analysis.summary.valid_rows, 2);
  assert.equal(analysis.summary.invalid_rows, 0);
  assert.equal(analysis.rows[1].name, 'Cliente 7735');
});

function seedPipelineClient({
  convenio = 'Governo de SP',
  name = 'Cliente Teste',
  cpf = '90000000001',
  phone = '11900000001',
  birthDate = '1980-01-01',
  age = 46,
  gender = 'M',
  raw = {},
  margins = [],
}) {
  const database = db.getDb();
  const now = new Date().toISOString();
  const base = database
    .prepare(
      `
        INSERT INTO bases (
          nome_base, tipo_base, campaign_id, convenio, estado, cidade, arquivo_original,
          total_clientes, total_com_margem, total_sem_margem, total_erro,
          observacao, is_active, archived_at, created_at, updated_at
        ) VALUES (?, 'Outro', NULL, ?, 'SP', '', 'teste.csv', 1, 1, 0, 0, '', 1, NULL, ?, ?)
      `
    )
    .run(`Base ${name}`, convenio, now, now);
  const baseId = Number(database.prepare('SELECT MAX(id) AS id FROM bases').get().id);
  const client = database
    .prepare(
      `
        INSERT INTO clients (
          base_id, campaign_id, name, cpf, phone, email, status_atendimento, consulta_status,
          consulta_mensagem, raw_data_json, has_duplicate_in_other_base, best_product_type,
          best_net_margin, current_margin, status, assigned_to, queue_position, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, '', 'novo_na_fila', 'com_marg', '', ?, 0, '', NULL, NULL, 'novo_na_fila', NULL, 0, ?, ?)
      `
    )
    .run(baseId, name, cpf, phone, JSON.stringify(raw), now, now);
  const clientId = Number(database.prepare('SELECT MAX(id) AS id FROM clients').get().id);
  for (const margin of margins) {
    database
      .prepare(
        `
          INSERT INTO client_margins (client_id, product_type, gross_margin, net_margin, source_gross_column, source_net_column, created_at, updated_at)
          VALUES (?, ?, ?, ?, '', '', ?, ?)
        `
      )
      .run(clientId, margin.product_type, margin.gross_margin, margin.net_margin, now, now);
  }
  db.saveClientEnrichmentData({
    clientId,
    data: {
      cpf,
      full_name: name,
      birth_date: birthDate,
      age,
      gender,
      email: 'teste@example.invalid',
    },
    source: 'unit_test',
  });
  return clientId;
}

test('coeficientes diarios refletem bancos, produtos e prazos operacionais', () => {
  const rows = db.getTodayBankCoefficients().bancos;
  const key = (row) => `${row.convenio}:${row.banco}:${row.produto}`;
  const byKey = new Map(rows.map((row) => [key(row), row]));

  assert.equal(byKey.get('prefeitura_rp:futuro_previdencia:consignado')?.prazo, 120);
  assert.equal(byKey.get('prefeitura_rp:futuro_previdencia:cartao_consignado')?.prazo, 96);
  assert.equal(byKey.get('prefeitura_rp:bib:consignado')?.prazo, 48);
  assert.equal(byKey.has('prefeitura_rp:bib:cartao_consignado'), false);
  assert.equal(byKey.get('gov_sp:daycoval:consignado')?.prazo, 96);
  assert.equal(byKey.get('gov_sp:amigoz:cartao_consignado')?.taxa, 4.5);
});

test('governo envia cartao ja utilizado para atendimento manual', () => {
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'amigoz', bancoLabel: 'Amigoz', produto: 'cartao_consignado', coeficiente: 0.025, taxa: 4.5, prazo: 96 });
  const clientId = seedPipelineClient({
    name: 'Cliente Gov Manual',
    cpf: '90000000002',
    margins: [
      { product_type: 'consignado', gross_margin: 0, net_margin: 0 },
      { product_type: 'cartao_consignado', gross_margin: 1000, net_margin: 500 },
    ],
  });

  const result = db.listCampaignOpportunities({ convenio: 'gov_sp', produto: 'cartao_consignado' });
  assert.equal(result.oportunidades.some((item) => item.client_id === clientId), false);
  assert.ok(result.grupos.some((item) => item.grupo === 'MARGEM_COMPLEMENTAR_GOV'));
});

test('governo com cartao livre usa Amigoz quando bruto e liquido sao iguais', () => {
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'amigoz', bancoLabel: 'Amigoz', produto: 'cartao_consignado', coeficiente: 1, taxa: 4.5, prazo: 96 });
  const clientId = seedPipelineClient({
    name: 'Cliente Gov Cartao Livre',
    cpf: '90000000003',
    margins: [
      { product_type: 'consignado', gross_margin: 0, net_margin: 0 },
      { product_type: 'cartao_consignado', gross_margin: 1000, net_margin: 1000 },
    ],
  });

  const result = db.listCampaignOpportunities({ convenio: 'gov_sp', produto: 'cartao_consignado', banco: 'amigoz' });
  const opportunity = result.oportunidades.find((item) => item.client_id === clientId);
  assert.equal(opportunity?.banco, 'amigoz');
  assert.equal(opportunity?.faixa_valor, 'ate_5k');
});

test('governo acima de 70 anos usa Santander ou Banco do Brasil para consignado', () => {
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'daycoval', bancoLabel: 'Daycoval', produto: 'consignado', coeficiente: 0.02, prazo: 96 });
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'santander', bancoLabel: 'Santander', produto: 'consignado', coeficiente: 0.02, prazo: 96 });
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'banco_brasil', bancoLabel: 'Banco do Brasil', produto: 'consignado', coeficiente: 0.02, prazo: 96 });
  const clientId = seedPipelineClient({
    name: 'Cliente Gov Acima Setenta',
    cpf: '90000000004',
    birthDate: '1955-01-01',
    age: 71,
    margins: [{ product_type: 'consignado', gross_margin: 200, net_margin: 200 }],
  });

  const result = db.listCampaignOpportunities({ convenio: 'gov_sp', produto: 'consignado' });
  const banks = result.oportunidades.filter((item) => item.client_id === clientId).map((item) => item.banco).sort();
  assert.deepEqual(banks, ['banco_brasil', 'santander']);
});

test('prefeitura abaixo de 150 mantem consignado com complemento de cartao', () => {
  db.saveBankCoefficient({ convenio: 'prefeitura_rp', banco: 'futuro_previdencia', bancoLabel: 'Futuro Previdência', produto: 'consignado', coeficiente: 0.02, prazo: 120 });
  const clientId = seedPipelineClient({
    convenio: 'Prefeitura de Ribeirao Preto',
    name: 'Cliente Prefeitura Complemento',
    cpf: '90000000005',
    birthDate: '1988-01-01',
    age: 38,
    gender: 'F',
    margins: [
      { product_type: 'consignado', gross_margin: 120, net_margin: 120 },
      { product_type: 'cartao_consignado', gross_margin: 900, net_margin: 300 },
    ],
  });

  const result = db.listCampaignOpportunities({ convenio: 'prefeitura_rp', produto: 'consignado', banco: 'futuro_previdencia' });
  const opportunity = result.oportunidades.find((item) => item.client_id === clientId);
  assert.equal(opportunity?.oferta_complementar, true);
  assert.equal(opportunity?.produto_complementar, 'cartao_consignado');
});

function baseIdFromClient(clientId) {
  return Number(db.getDb().prepare('SELECT base_id FROM clients WHERE id = ?').get(Number(clientId)).base_id);
}

test('simulacao da esteira persiste grupos e oculta CPF em lista', () => {
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'daycoval', bancoLabel: 'Daycoval', produto: 'consignado', coeficiente: 0.02, prazo: 96 });
  const clientId = seedPipelineClient({
    name: 'Cliente Simulacao Gov',
    cpf: '90000000006',
    birthDate: '1988-01-01',
    age: 38,
    margins: [{ product_type: 'consignado', gross_margin: 600, net_margin: 600 }],
  });
  const baseId = baseIdFromClient(clientId);

  const simulation = db.runPipelineSimulation(baseId);
  assert.equal(simulation.total_clientes, 1);
  assert.equal(simulation.prontas, 1);
  assert.ok(simulation.grupos.some((group) => group.grupo === 'GOV_SP_ELEGIVEL'));

  const clients = db.listPipelineGroupClients(baseId, 'GOV_SP_ELEGIVEL');
  assert.equal(clients.clientes.length, 1);
  assert.equal('cpf' in clients.clientes[0], false);
  assert.equal(clients.clientes[0].valor_liberado, 30000);
});

test('simulacao separa faixa 20k a 30k e acima de 30k', () => {
  db.saveBankCoefficient({ convenio: 'gov_sp', banco: 'daycoval', bancoLabel: 'Daycoval', produto: 'consignado', coeficiente: 0.02, prazo: 96 });
  const clientTwenty = seedPipelineClient({
    name: 'Cliente Faixa Vinte',
    cpf: '90000000007',
    birthDate: '1990-01-01',
    age: 36,
    margins: [{ product_type: 'consignado', gross_margin: 500, net_margin: 500 }],
  });
  const baseTwenty = baseIdFromClient(clientTwenty);
  db.runPipelineSimulation(baseTwenty);
  assert.equal(db.listPipelineGroupClients(baseTwenty, 'GOV_SP_ELEGIVEL').clientes[0].faixa_valor, '20k_30k');

  const clientThirty = seedPipelineClient({
    name: 'Cliente Faixa Trinta',
    cpf: '90000000008',
    birthDate: '1990-01-01',
    age: 36,
    margins: [{ product_type: 'consignado', gross_margin: 800, net_margin: 800 }],
  });
  const baseThirty = baseIdFromClient(clientThirty);
  db.runPipelineSimulation(baseThirty);
  assert.equal(db.listPipelineGroupClients(baseThirty, 'GOV_SP_ELEGIVEL').clientes[0].faixa_valor, 'acima_30k');
});

test('simulacao fica aguardando coeficiente quando banco elegivel nao foi preenchido', () => {
  const clientId = seedPipelineClient({
    convenio: 'Prefeitura de Ribeirao Preto',
    name: 'Cliente Prefeitura Sem Coeficiente',
    cpf: '90000000009',
    birthDate: '1988-01-01',
    age: 38,
    gender: 'F',
    margins: [{ product_type: 'cartao_consignado', gross_margin: 700, net_margin: 700 }],
  });
  const baseId = baseIdFromClient(clientId);
  const simulation = db.runPipelineSimulation(baseId);
  assert.ok(simulation.aguardando_coeficiente >= 1);
  assert.ok(simulation.grupos.some((group) => group.grupo === 'AGUARDANDO_COEFICIENTE'));
});
