import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptSensitive,
  encryptSensitive,
  hashSensitive,
  maskBankAccount,
  maskCpf,
  maskPhone,
} from '../src/dataProtection.js';
import {
  communicationLimiter,
  createRateLimiter,
  globalLimiter,
  loginLimiter,
} from '../src/rateLimits.js';

process.env.NODE_ENV = 'test';
process.env.DATA_ENCRYPTION_KEY = 'test-only-reliance-crm-encryption-key';
process.env.HASH_SECRET = 'test-only-reliance-crm-hash-secret';

function fakeCpf() {
  return ['123', '456', '789', '00'].join('');
}

function fakePhone() {
  return ['119', '8765', '4321'].join('');
}

function fakeAccount() {
  return ['1234', '5678', '90'].join('');
}

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('maskCpf nao expoe o documento completo', () => {
  const cpf = fakeCpf();
  const masked = maskCpf(cpf);

  assert.notEqual(masked, cpf);
  assert.equal(masked.includes(cpf), false);
  assert.match(masked, /^\d{3}\.\*\*\*\.\*\*\*-\d{2}$/);
});

test('maskPhone nao expoe o telefone completo', () => {
  const phone = fakePhone();
  const masked = maskPhone(phone);

  assert.notEqual(masked, phone);
  assert.equal(masked.includes(phone), false);
  assert.equal(masked, '***4321');
});

test('maskBankAccount nao expoe conta completa', () => {
  const account = fakeAccount();
  const masked = maskBankAccount(account);

  assert.notEqual(masked, account);
  assert.equal(masked.includes(account), false);
  assert.equal(masked, '***90');
});

test('hashSensitive gera hash estavel e nao retorna o valor original', () => {
  const value = fakeCpf();
  const firstHash = hashSensitive(value, 'cpf');
  const secondHash = hashSensitive(value, 'cpf');

  assert.equal(firstHash, secondHash);
  assert.notEqual(firstHash, value);
  assert.match(firstHash, /^[a-f0-9]{64}$/);
});

test('encryptSensitive e decryptSensitive protegem e recuperam texto em teste', () => {
  const value = `cliente-${fakeCpf()}-${fakePhone()}`;
  const encrypted = encryptSensitive(value);

  assert.notEqual(encrypted, value);
  assert.equal(encrypted.includes(value), false);
  assert.equal(decryptSensitive(encrypted), value);
});

test('rateLimits exporta middlewares esperados', () => {
  assert.equal(typeof loginLimiter, 'function');
  assert.equal(typeof communicationLimiter, 'function');
  assert.equal(typeof globalLimiter, 'function');
});

test('rate limiter bloqueia apos ultrapassar limite configurado', () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    message: 'Limite atingido.',
  });
  const req = {
    ip: '203.0.113.10',
    get() {
      return '';
    },
    socket: {},
  };
  const firstResponse = createMockResponse();
  const secondResponse = createMockResponse();
  let nextCalls = 0;

  limiter(req, firstResponse, () => {
    nextCalls += 1;
  });
  limiter(req, secondResponse, () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.body.code, 'RATE_LIMITED');
  assert.ok(secondResponse.headers['Retry-After']);
});
