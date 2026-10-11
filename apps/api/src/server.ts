import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { failStaleJobs } from './modules/optimization/optimization.service';

const app = createApp();
void failStaleJobs()
  .then((n) => n && logger.warn(`Marked ${n} interrupted optimization job(s) as FAILED`))
  .catch((err) => logger.error({ err }, 'failStaleJobs failed'));
const server = app.listen(env.API_PORT, () => {
  logger.info(`EcoSphere API listening on :${env.API_PORT} (${env.NODE_ENV}, demo=${env.DEMO_MODE})`);
});
server.requestTimeout = 30_000;

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
