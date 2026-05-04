import { initDb } from '../src/db.js';

async function main() {
  await initDb();
  console.log('Banco migrado e inicializado com sucesso.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

