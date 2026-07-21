import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const INTERNAL_OCR_PROVIDER = 'INTERNAL_OCR';

const SIMPLE_IMAGE_TYPES = new Set(['image_text', 'simple_image', 'text_image', 'captcha_image']);
const BLOCKED_TYPES = ['recaptcha', 'hcaptcha', 'turnstile', 'aws_waf', 'cloudflare', '2fa', 'certificado', 'human'];

function normalizeType(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isSimpleImageCaptcha(type = '') {
  const normalized = normalizeType(type);
  return SIMPLE_IMAGE_TYPES.has(normalized) || normalized.includes('image_text') || normalized.includes('simple');
}

export function isOcrApplicable(context = {}) {
  const type = normalizeType(context.captchaType || context.captcha_type);
  if (!type) {
    return false;
  }
  if (BLOCKED_TYPES.some((item) => type.includes(item))) {
    return false;
  }
  return isSimpleImageCaptcha(type);
}

function runTesseract(imagePath, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.env.TESSERACT_BIN || 'tesseract', [imagePath, 'stdout', '--psm', '8', '-l', process.env.CAPTCHA_OCR_LANG || 'eng'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, code: 'OCR_TIMEOUT', stderr });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'OCR_UNAVAILABLE', stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, code: 'OCR_FAILED', stderr });
        return;
      }
      resolve({ ok: true, text: stdout });
    });
  });
}

function cleanOcrText(value = '') {
  return String(value || '')
    .replace(/[^A-Za-z0-9]/g, '')
    .trim();
}

function estimateConfidence(text = '') {
  if (!text) return 0;
  if (text.length >= 4 && text.length <= 8) return 0.82;
  if (text.length >= 3 && text.length <= 10) return 0.68;
  return 0.4;
}

export async function solveInternalOcr(context = {}, config = {}) {
  const startedAt = Date.now();
  if (!isOcrApplicable(context)) {
    return {
      ok: false,
      provider: INTERNAL_OCR_PROVIDER,
      status: 'INTERNAL_OCR_NOT_APPLICABLE',
      confidence: 0,
      durationMs: Date.now() - startedAt,
      message: 'OCR interno não se aplica a este tipo de CAPTCHA.',
    };
  }

  const imagePath = String(context.screenshotPath || context.imagePath || '').trim();
  if (!imagePath || !fs.existsSync(imagePath)) {
    return {
      ok: false,
      provider: INTERNAL_OCR_PROVIDER,
      status: 'INTERNAL_OCR_FAILED',
      confidence: 0,
      durationMs: Date.now() - startedAt,
      code: 'IMAGE_NOT_AVAILABLE',
      message: 'Imagem do CAPTCHA não disponível para OCR interno.',
    };
  }

  const result = await runTesseract(imagePath, Number(config.timeoutMs || 20000));
  if (!result.ok) {
    return {
      ok: false,
      provider: INTERNAL_OCR_PROVIDER,
      status: 'INTERNAL_OCR_FAILED',
      confidence: 0,
      durationMs: Date.now() - startedAt,
      code: result.code || 'OCR_FAILED',
      message: result.stderr || 'Falha no OCR interno.',
    };
  }

  const text = cleanOcrText(result.text);
  const confidence = estimateConfidence(text);
  const minConfidence = Number(config.minConfidence || 0.75);
  if (!text || confidence < minConfidence) {
    return {
      ok: false,
      provider: INTERNAL_OCR_PROVIDER,
      status: 'INTERNAL_OCR_LOW_CONFIDENCE',
      confidence,
      durationMs: Date.now() - startedAt,
      code: 'LOW_CONFIDENCE',
      message: 'OCR interno retornou baixa confiança.',
      solution: text,
    };
  }

  return {
    ok: true,
    provider: INTERNAL_OCR_PROVIDER,
    status: 'INTERNAL_OCR_SOLVED',
    confidence,
    durationMs: Date.now() - startedAt,
    solution: text,
  };
}
