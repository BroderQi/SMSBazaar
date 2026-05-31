'use strict';

require('dotenv').config();

const serviceRegistry = require('./config/service-config');
const { createApp } = require('./app');
const { createDatabase, upsertServiceConfig } = require('./lib/db');
const { createExchangeRateService } = require('./lib/exchange-rates');
const { createRefreshController } = require('./lib/refresh-controller');

const port = Number(process.env.PORT || 8787);
const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS || 120000);
const refreshCooldownMs = Number(process.env.REFRESH_COOLDOWN_MS || 30000);
const databasePath = process.env.DATABASE_PATH || './data/app.sqlite';
const exchangeRateUrl = process.env.EXCHANGE_RATE_URL || 'https://api.frankfurter.app/latest?from=USD';

async function bootstrap() {
  const db = createDatabase(databasePath);
  for (const serviceConfig of serviceRegistry.getServiceConfigs()) {
    upsertServiceConfig(db, serviceConfig);
  }

  const exchangeRateService = createExchangeRateService({
    db,
    rateUrl: exchangeRateUrl,
  });

  const refreshController = createRefreshController({
    db,
    exchangeRateService,
    serviceConfig: serviceRegistry,
    refreshCooldownMs,
  });

  const app = createApp({
    db,
    refreshController,
  });

  const server = app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  refreshController.refreshAll('startup').catch((error) => {
    console.error(`Initial refresh failed: ${error.message}`);
  });

  const interval = setInterval(() => {
    refreshController.refreshAll('scheduled').catch((error) => {
      console.error(`Scheduled refresh failed: ${error.message}`);
    });
  }, refreshIntervalMs);

  const shutdown = () => {
    clearInterval(interval);
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
