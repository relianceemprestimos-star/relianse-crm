import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relianse-automation-registry-'));
process.env.AUTOMATION_REGISTRY_ROOT = registryRoot;

const flowDir = path.join(registryRoot, 'convenios', 'ribeirao-preto');
fs.mkdirSync(flowDir, { recursive: true });
const flowPath = path.join(flowDir, 'saec-consiglog.json');
const validatedFlow = {
  schema_version: '1.0',
  convenio_id: 'prefeitura_ribeirao_preto',
  convenio_nome: 'Prefeitura de Ribeirao Preto',
  portal: 'SAEC Consiglog',
  status: 'validado',
  ultima_validacao: '2026-06-01',
  login_url: 'https://saec.consiglog.com.br/',
  consulta_url: 'https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx',
  fluxo_versao: '1.0.0',
  aliases: ['ribeirao-preto'],
  etapas_fluxo: [],
  seletores_usados: {},
  falhas_conhecidas: [],
  regras_fallback: [],
  evidencias_validacao: [],
  observacoes_tecnicas: [],
};
fs.writeFileSync(flowPath, JSON.stringify(validatedFlow, null, 2), 'utf-8');

const registry = await import('../src/services/automationRegistryService.js');

test('carrega caminho salvo validado do registry', () => {
  const flow = registry.getValidatedAutomationFlow('ribeirao-preto');
  assert.equal(flow.convenio_id, 'prefeitura_ribeirao_preto');
  assert.equal(flow.status, 'validado');
  assert.equal(flow.consulta_url, 'https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx');
});

test('aplica caminho salvo no payload antes do robo executar', () => {
  const { payload, flow } = registry.applyAutomationFlowToPayload({
    action: 'query',
    portal_id: 'prefeitura_ribeirao_preto',
    portal_url: 'https://investigacao-invalida.local',
    consulta_url: '',
  });

  assert.equal(flow.status, 'validado');
  assert.equal(payload.portal_url, validatedFlow.login_url);
  assert.equal(payload.consulta_url, validatedFlow.consulta_url);
  assert.equal(payload.automation_registry_version, '1.0.0');
});

test('fallback salva log, screenshot e html sem apagar registry existente', () => {
  const before = fs.readFileSync(flowPath, 'utf-8');
  const failure = registry.recordAutomationFailure({
    convenioId: 'prefeitura_ribeirao_preto',
    action: 'query',
    stage: 'cpf_input',
    message: 'Campo CPF nao encontrado.',
    raw: { cpf: '12345678909', password: 'segredo' },
  });
  const after = fs.readFileSync(flowPath, 'utf-8');

  assert.equal(after, before);
  assert.ok(fs.existsSync(path.join(registryRoot, failure.log_file)));
  assert.ok(fs.existsSync(path.join(registryRoot, failure.screenshot_file)));
  assert.ok(fs.existsSync(path.join(registryRoot, failure.html_dump_file)));

  const log = JSON.parse(fs.readFileSync(path.join(registryRoot, failure.log_file), 'utf-8'));
  assert.equal(log.raw.cpf, '123.***.***-09');
  assert.equal(log.raw.password, '[redacted]');
});

test('fluxo validado nao e sobrescrito: falha cria versao candidata', () => {
  const failure = registry.recordAutomationFailure({
    convenioId: 'prefeitura_ribeirao_preto',
    action: 'start_session',
    stage: 'login_fields',
    message: 'Layout mudou.',
  });
  const candidatePath = path.join(registryRoot, failure.candidate_version_file);
  const activeFlow = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));

  assert.equal(activeFlow.status, 'validado');
  assert.equal(activeFlow.fluxo_versao, '1.0.0');
  assert.equal(candidate.status, 'candidato');
  assert.equal(candidate.fluxo_base, '1.0.0');
});
