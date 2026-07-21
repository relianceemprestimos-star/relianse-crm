import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

import { initDb } from '../src/db.js';
import {
  getCaptchaEngineConfig,
  maskApiKey,
  validateLimits,
} from '../src/services/captcha/captchaManager.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true });

await initDb();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
}

check('mascara_api_key', maskApiKey('CAP-1234567890ABCDEF') === 'CAP-************CDEF');

const config = getCaptchaEngineConfig();
check('config_sem_api_key_exposta', config.capsolverApiKey === undefined);
check('portal_rules_presentes', Boolean(config.portalRules?.governo_amapa && config.portalRules?.prefeitura_ribeirao_preto));
check('limites_validam_sem_uso', validateLimits('governo_amapa', 0).ok === true);

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
}
if (failed.length) {
  process.exit(1);
}
