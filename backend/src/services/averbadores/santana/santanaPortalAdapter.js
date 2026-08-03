import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

export function runSantanaPortalCommand(payload, { timeoutMs = 180_000, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ['-u', path.join(__dirname, 'santana_cli.py')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SANTANA_HEADLESS: process.env.SANTANA_HEADLESS || 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Tempo limite excedido na consulta Santana.'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'progress' && typeof onProgress === 'function') {
            onProgress(event);
          }
        } catch {
          // Ignore diagnostic lines that are not progress events.
        }
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = null;
      try {
        result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      } catch {
        reject(new Error('O robô Santana devolveu uma resposta inválida.'));
        return;
      }
      if (code !== 0 || result?.ok === false) {
        reject(new Error(result?.message || stderr.trim() || 'Falha no robô Santana.'));
        return;
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload || {}));
  });
}
