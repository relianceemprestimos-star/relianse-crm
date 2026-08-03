import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.SQLITE_PATH = path.join(os.tmpdir(), `relianse-margin-portals-${process.pid}.sqlite`);
process.env.DATABASE_PATH = process.env.SQLITE_PATH;
process.env.JWT_SECRET = 'margin-portals-test-secret';

const db = await import('../src/db.js');
const portals = await import('../src/services/credentials/portalConfigs.js');

await db.initDb();

test('cadastro central separa Ribeirao e Santana como conectores distintos', () => {
  const rows = portals.getMarginPortalConfigs();
  const ribeirao = rows.find((row) => row.id === 'prefeitura_ribeirao_preto');
  const santana = rows.find((row) => row.id === 'prefeitura_santana_parnaiba');

  assert.equal(ribeirao?.supports_batch, true);
  assert.equal(santana?.supports_batch, true);
  assert.notEqual(ribeirao?.convenio_code, santana?.convenio_code);
  assert.deepEqual(ribeirao?.margin_products, ['consignado', 'cartao_consignado']);
  assert.deepEqual(santana?.margin_products, ['consignado', 'cartao_consignado', 'cartao_beneficio', 'acisesp']);
});

test('lote Santana remove CPF duplicado e mantém progresso próprio', () => {
  const batch = db.createSantanaBatchRecord({
    userId: 1,
    sourceFileName: 'base-santana.xlsx',
    cpfs: ['12345678909', '123.456.789-09', '98765432100'],
  });

  assert.equal(batch.total_cpfs, 2);
  assert.equal(batch.processed_count, 0);

  const updated = db.updateSantanaBatchRecord(batch.id, {
    status: 'em_execucao',
    processed_count: 1,
    success_count: 1,
  });
  assert.equal(updated.progress_percent, 50);
  assert.equal(updated.success_count, 1);
});
