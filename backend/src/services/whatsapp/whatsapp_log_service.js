import fs from 'node:fs';
import path from 'node:path';

import { maskPhone } from './whatsapp_rules_service.js';

const LOG_DIR = process.env.LOG_DIR || path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'whatsapp.log');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

export function writeWhatsappLog(level = 'info', event = 'unknown', payload = {}) {
  try {
    ensureDir();
    const safe = {
      ...payload,
      phone: payload.phone ? maskPhone(payload.phone) : undefined,
      token: undefined,
      api_token: undefined,
    };
    const line = `${nowIso()} [${String(level).toUpperCase()}] [${event}] ${JSON.stringify(safe)}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // never break application because of log write failure
  }
}
