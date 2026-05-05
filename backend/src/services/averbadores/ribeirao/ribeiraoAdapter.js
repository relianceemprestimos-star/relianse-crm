import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_VERSION } from '../../../build.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

function pathExists(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

export function resolveRibeiraoProjectRoot() {
  const envRoot = process.env.RIBEIRAO_PROJECT_ROOT;
  if (envRoot && pathExists(envRoot)) {
    return path.resolve(envRoot);
  }

  const candidates = [
    path.resolve(__dirname, 'vendor', 'worker'),
    path.resolve(__dirname, 'vendor', 'worker', 'legacy_portal'),
    path.resolve(process.cwd(), '..', 'Basemargem', 'consignado-platform', 'worker'),
    path.resolve(process.cwd(), 'Basemargem', 'consignado-platform', 'worker'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'Basemargem', 'consignado-platform', 'worker'),
  ];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return path.resolve(candidate);
    }
  }

  return envRoot ? path.resolve(envRoot) : '';
}

export function getRibeiraoCliPath() {
  return path.join(__dirname, 'ribeirao_cli.py');
}

function buildEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
  };

  const projectRoot = resolveRibeiraoProjectRoot();
  if (projectRoot) {
    env.RIBEIRAO_PROJECT_ROOT = projectRoot;
  }
  env.RIBEIRAO_BUILD_VERSION = BUILD_VERSION;

  return env;
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

export function runRibeiraoCommand(payload, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ['-u', getRibeiraoCliPath()], {
      cwd: process.cwd(),
      env: buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error('Tempo limite excedido na integracao Ribeirao.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const text = stdout.trim();
      if (code !== 0) {
        reject(new Error(stderr.trim() || text || 'Falha ao executar integracao Ribeirao.'));
        return;
      }
      if (!text) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`Resposta invalida da integracao Ribeirao: ${text.slice(0, 500)}`));
      }
    });

    try {
      child.stdin.end(JSON.stringify(payload ?? {}));
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

export function startRibeiraoSessionBackground(payload) {
  const sessionId = payload?.session_id || payload?.sessionId || '1';
  const payloadDir = path.resolve(resolveRepoRoot(), 'data', 'ribeirao_sessions');
  fs.mkdirSync(payloadDir, { recursive: true });
  const payloadPath = path.join(payloadDir, `session_${sessionId}.payload.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload ?? {}, null, 2), 'utf-8');
  const statusPath = path.join(payloadDir, `session_${sessionId}.status.json`);

  const writeFallbackStatus = (status, message) => {
    try {
      fs.writeFileSync(
        statusPath,
        JSON.stringify(
          {
            session_id: String(sessionId),
            status,
            message,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch {
      // ignore
    }
  };

    const child = spawn(PYTHON_BIN, ['-u', getRibeiraoCliPath(), '--payload-file', payloadPath], {
      cwd: process.cwd(),
      env: buildEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk.toString('utf8'));
      });
    }

  child.on('error', (error) => {
    writeFallbackStatus('erro_login', error instanceof Error ? error.message : 'Falha ao iniciar worker Ribeirao.');
  });

  child.on('close', (code) => {
    if (code !== 0 && !fs.existsSync(statusPath)) {
      writeFallbackStatus('erro_login', `Worker Ribeirao encerrou com codigo ${code ?? 'desconhecido'}.`);
    }
  });

  child.unref();
  return true;
}
