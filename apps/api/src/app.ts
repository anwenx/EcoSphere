import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { logger } from './lib/logger';
import { csrfProtection } from './middleware/auth';
import { errorHandler, notFound } from './middleware/error';
import { authRouter } from './modules/auth/auth.routes';
import { binsRouter } from './modules/bins/bins.routes';
import { depotsRouter } from './modules/depots/depots.routes';
import { zonesRouter } from './modules/zones/zones.routes';
import { optimizationRouter } from './modules/optimization/optimization.routes';
import { routesRouter } from './modules/routes/routes.routes';
import { alertsRouter } from './modules/alerts/alerts.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { driverRouter } from './modules/driver/driver.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { vehiclesRouter } from './modules/vehicles/vehicles.routes';
import { healthRouter } from './modules/health/health.routes';
import { usersRouter } from './modules/users/users.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy in production, set this so rate limiting sees real client IPs.
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(pinoHttp({ logger, genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID() }));
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const v1 = express.Router();
  v1.use(csrfProtection);
  v1.use('/health', healthRouter);
  v1.use('/auth', authRouter);
  v1.use('/users', usersRouter);
  v1.use('/bins', binsRouter);
  v1.use('/zones', zonesRouter);
  v1.use('/depots', depotsRouter);
  v1.use('/vehicles', vehiclesRouter);
  v1.use('/optimization', optimizationRouter);
  v1.use('/routes', routesRouter);
  v1.use('/driver', driverRouter);
  v1.use('/alerts', alertsRouter);
  v1.use('/notifications', notificationsRouter);
  v1.use('/dashboard', dashboardRouter);
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
