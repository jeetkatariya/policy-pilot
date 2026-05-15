import { buildApp } from './app.js';
import { allSessions, disposeSession } from './sessions.js';
import * as runtime from './runtime/playwright.js';

const PORT = Number(process.env.PORT) || 3001;
const app = await buildApp({ logger: { level: 'info' } });
await app.listen({ port: PORT, host: '127.0.0.1' });
app.log.info(`listening on http://127.0.0.1:${PORT}`);

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  for (const s of allSessions()) await disposeSession(s);
  await runtime.shutdown();
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
