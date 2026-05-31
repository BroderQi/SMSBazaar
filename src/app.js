'use strict';

const express = require('express');
const path = require('node:path');
const serviceRegistry = require('./config/service-config');
const { aggregateByCountry } = require('./lib/aggregator');
const { loadOpenAiSupportedCountries } = require('./lib/openai-supported-country-config');
const { loadRecommendedCountryConfig } = require('./lib/recommended-country-config');
const {
  getExchangeRates,
  getAllProviderSnapshots,
  getAllProviderStates,
  getLatestRefreshEvent,
  upsertServiceConfig,
} = require('./lib/db');

function getServiceModes(serviceConfig) {
  return Array.isArray(serviceConfig.modes) && serviceConfig.modes.length
    ? serviceConfig.modes
    : [{ value: 'all', label: 'All countries', description: 'All countries returned by providers' }];
}

function getServiceSummary(serviceConfig) {
  return {
    serviceKey: serviceConfig.serviceKey,
    displayName: serviceConfig.displayName,
    defaultMode: serviceConfig.defaultMode || 'all',
    modes: getServiceModes(serviceConfig),
  };
}

function createApp({ db, refreshController }) {
  const app = express();
  app.use(express.json());
  const recommendationFilePath = process.env.RECOMMENDED_COUNTRY_PATHS_FILE || './data/recommended-country-paths.txt';
  const openAiSupportedCountriesFilePath = process.env.OPENAI_SUPPORTED_COUNTRIES_FILE || './data/openai-supported-api-countries.txt';
  const adminRefreshToken = String(process.env.ADMIN_REFRESH_TOKEN || '').trim();
  const refreshIntervalMs = Number(process.env.REFRESH_INTERVAL_MS || 60000);
  const exposeProviderErrors = String(process.env.EXPOSE_PROVIDER_ERRORS || '').toLowerCase() === 'true';

  for (const serviceConfig of serviceRegistry.getServiceConfigs()) {
    upsertServiceConfig(db, serviceConfig);
  }

  function resolveService(serviceKey) {
    return serviceRegistry.getServiceConfig(String(serviceKey || serviceRegistry.defaultServiceKey || '').trim());
  }

  function resolveMode(serviceConfig, requestedMode) {
    const modes = getServiceModes(serviceConfig).map((mode) => mode.value);
    const candidate = String(requestedMode || serviceConfig.defaultMode || 'all');
    if (modes.includes(candidate)) return candidate;
    return serviceConfig.defaultMode || modes[0] || 'all';
  }

  function getRegisterSupportedCountries(serviceConfig) {
    if (serviceConfig.serviceKey === 'openai_chatgpt') {
      return loadOpenAiSupportedCountries(openAiSupportedCountriesFilePath);
    }
    return {
      whitelist: serviceConfig.registerSupportedWhitelistIso2 || [],
    };
  }

  function redactProviderError(message) {
    if (exposeProviderErrors) return message || '';
    return message ? '平台异常' : '';
  }

  function redactCompareRows(rows) {
    return rows.map((row) => ({
      ...row,
      offers: row.offers.map((offer) => ({
        ...offer,
        errorMessage: redactProviderError(offer.errorMessage),
      })),
    }));
  }

  app.get('/api/meta', (req, res) => {
    const serviceConfig = resolveService(req.query.service);
    const latestRefresh = getLatestRefreshEvent(db);
    const states = getAllProviderStates(db, serviceConfig.serviceKey);
    const snapshots = new Map(getAllProviderSnapshots(db, serviceConfig.serviceKey).map((snapshot) => [snapshot.providerKey, snapshot]));
    const usdRates = getExchangeRates(db, 'USD');
    const recommendationConfig = loadRecommendedCountryConfig(recommendationFilePath, serviceConfig.recommendedWhitelistIso2);
    const registerSupportedCountries = getRegisterSupportedCountries(serviceConfig);

    res.json({
      defaultServiceKey: serviceRegistry.defaultServiceKey,
      services: serviceRegistry.getServiceConfigs().map(getServiceSummary),
      service: {
        serviceKey: serviceConfig.serviceKey,
        displayName: serviceConfig.displayName,
        defaultMode: serviceConfig.defaultMode || 'all',
        modes: getServiceModes(serviceConfig),
        bindWhitelistIso2: serviceConfig.bindWhitelistIso2,
        recommendedWhitelistIso2: recommendationConfig.whitelist,
        registerSupportedWhitelistIso2: registerSupportedCountries.whitelist,
      },
      display: {
        primaryCurrency: 'CNY',
        secondaryCurrency: 'USD',
        cnyRateFromUsd: Number(usdRates?.payload?.rates?.CNY || 7.2),
        refreshIntervalMs,
      },
      recommendationConfig: {
        updatedAt: recommendationConfig.updatedAt,
        source: recommendationConfig.source,
        entries: recommendationConfig.entries,
      },
      providers: serviceConfig.providerMappings.map((mapping) => {
        const state = states.get(mapping.providerKey);
        const snapshot = snapshots.get(mapping.providerKey);
        return {
          providerKey: mapping.providerKey,
          displayName: mapping.displayName,
          configured: Boolean(process.env[mapping.keyEnv] || mapping.providerKey === 'smsbower' || mapping.providerKey === '5sim'),
          status: state?.status || 'idle',
          lastAttemptedAt: state?.last_attempted_at || '',
          lastSuccessAt: state?.last_success_at || '',
          errorMessage: redactProviderError(state?.error_message),
          offerCount: snapshot?.payload?.offers?.length || 0,
        };
      }),
      lastRefresh: latestRefresh,
      refreshState: refreshController.getState().isRunning ? 'running' : 'idle',
    });
  });

  app.get('/api/compare', (req, res) => {
    const serviceConfig = resolveService(req.query.service);
    const filters = {
      service: serviceConfig.serviceKey,
      mode: resolveMode(serviceConfig, req.query.mode),
      country: req.query.country || '',
      provider: req.query.provider || '',
      status: req.query.status || '',
      sort: req.query.sort || 'price_asc',
    };

    const snapshots = getAllProviderSnapshots(db, serviceConfig.serviceKey);
    const providerStates = getAllProviderStates(db, serviceConfig.serviceKey);
    const recommendationConfig = loadRecommendedCountryConfig(recommendationFilePath, serviceConfig.recommendedWhitelistIso2);
    const registerSupportedCountries = getRegisterSupportedCountries(serviceConfig);
    const rows = redactCompareRows(aggregateByCountry({
      snapshots,
      states: providerStates,
      filters,
      whitelist: serviceConfig.bindWhitelistIso2,
      recommendedWhitelist: recommendationConfig.whitelist,
      recommendationPathByIso2: recommendationConfig.pathByIso2,
      registerSupportedWhitelist: registerSupportedCountries.whitelist,
    }));

    const countries = rows.map((row) => ({
      iso2: row.countryIso2,
      name: row.countryName,
      displayName: row.countryDisplayName || row.countryName,
      chineseName: row.countryNameZh || row.countryName,
      englishName: row.countryNameEn || row.countryName,
      recommendationPath: row.recommendationPath,
    }));

    res.json({
      filters,
      recommendationConfig: {
        updatedAt: recommendationConfig.updatedAt,
        source: recommendationConfig.source,
      },
      countries,
      rows,
      updatedAt: getLatestRefreshEvent(db)?.completed_at || '',
    });
  });

  app.post('/api/refresh', async (req, res) => {
    if (!adminRefreshToken) {
      res.status(503).json({
        accepted: false,
        reason: 'admin_refresh_not_configured',
      });
      return;
    }

    const providedToken = String(
      req.get('x-admin-refresh-token')
      || req.get('authorization')?.replace(/^Bearer\s+/i, '')
      || '',
    ).trim();

    if (providedToken !== adminRefreshToken) {
      res.status(403).json({
        accepted: false,
        reason: 'forbidden',
      });
      return;
    }

    const result = typeof refreshController.triggerRefresh === 'function'
      ? refreshController.triggerRefresh('manual')
      : await refreshController.refreshAll('manual');
    res.status(result.accepted ? 202 : 429).json(result);
  });

  const clientDist = path.resolve(process.cwd(), 'dist/client');
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, 'index.html'), (error) => {
      if (error) next();
    });
  });

  return app;
}

module.exports = {
  createApp,
};
