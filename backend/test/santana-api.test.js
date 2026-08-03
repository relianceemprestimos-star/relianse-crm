import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authenticateSantanaApi,
  extractSantanaMargins,
  extractSantanaServerUuids,
  querySantanaCpf,
} from '../src/services/averbadores/santana/santanaApiService.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('Santana autentica na API RF1 e extrai JWT sem usar o portal de Ribeirão', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ token: 'jwt-de-teste' });
  };
  const result = await authenticateSantanaApi({
    apiBaseUrl: 'https://santana-api.example.invalid/',
    login: '123.456.789-09',
    password: 'senha-de-teste',
    fetchImpl,
  });
  assert.equal(result.token, 'jwt-de-teste');
  assert.equal(calls[0].url, 'https://santana-api.example.invalid/Usuario/login-api');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    cpf: '12345678909',
    senha: 'senha-de-teste',
  });
});

test('Santana encontra UUIDs e margens no retorno completo da RF1', () => {
  const preliminary = {
    servidores: [
      { uuidServidor: '11111111-1111-1111-1111-111111111111' },
      { guid: '22222222-2222-2222-2222-222222222222' },
    ],
  };
  assert.deepEqual(extractSantanaServerUuids(preliminary), [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
  ]);
  assert.deepEqual(extractSantanaMargins({
    servidor: {
      margemConsignavel: 'R$ 150,25',
      eventos: [{ margemCartaoDisponivel: -12.5 }],
    },
  }), [
    { key: 'margemConsignavel', path: 'servidor.margemConsignavel', value: 150.25 },
    { key: 'margemCartaoDisponivel', path: 'servidor.eventos.0.margemCartaoDisponivel', value: -12.5 },
  ]);
});

test('Santana consulta CPF em duas etapas usando somente endpoints RF1', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/Usuario/login-api')) return jsonResponse({ accessToken: 'jwt' });
    if (url.includes('/Servidor/buscar-preliminar-api')) {
      return jsonResponse({ itens: [{ uuidServidor: 'abc-123' }] });
    }
    if (url.includes('/Servidor/buscar-completo-api')) {
      return jsonResponse({ nome: 'Cliente Teste', margemDisponivel: 99.9 });
    }
    return jsonResponse({}, 404);
  };
  const result = await querySantanaCpf({
    apiBaseUrl: 'https://santana-api.example.invalid',
    login: '12345678909',
    password: 'senha-de-teste',
    cpf: '12345678909',
    fetchImpl,
  });
  assert.equal(result.status, 'sucesso');
  assert.equal(result.servidores.length, 1);
  assert.equal(result.margins[0].value, 99.9);
  assert.equal(calls.some((url) => url.includes('ribeirao')), false);
});
