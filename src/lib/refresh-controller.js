'use strict';

const {
  completeRefreshEvent,
  getAllProviderSnapshots,
  getAllProviderStates,
  getLatestRefreshEvent,
  getProviderState,
  getProviderSnapshot,
  insertRefreshEvent,
  saveProviderSnapshot,
  saveProviderState,
  upsertServiceConfig,
} = require('./db');
const { getProvider } = require('./providers');

function normalizeServiceConfigs(serviceConfig) {
  if (Array.isArray(serviceConfig?.services)) return serviceConfig.services;
  if (Array.isArray(serviceConfig)) return serviceConfig;
  return serviceConfig ? [serviceConfig] : [];
}

function createRefreshController({ db, exchangeRateService, serviceConfig, refreshCooldownMs }) {
  const serviceConfigs = normalizeServiceConfigs(serviceConfig);
  let isRunning = false;
  let lastManualTriggerAt = 0;
  let currentPromise = null;

  function upsertAllServiceConfigs() {
    for (const currentServiceConfig of serviceConfigs) {
      upsertServiceConfig(db, currentServiceConfig);
    }
  }

  function getReusableProviderResult(currentServiceConfig, mapping, reason) {
    const minRefreshIntervalMs = Number(mapping.minRefreshIntervalMs || 0);
    if (!minRefreshIntervalMs) return null;

    const state = getProviderState(db, currentServiceConfig.serviceKey, mapping.providerKey);
    const lastAttempt = state?.last_attempted_at || state?.last_success_at;
    if (!lastAttempt) return null;

    const lastAttemptMs = new Date(lastAttempt).getTime();
    if (!Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs >= minRefreshIntervalMs) return null;

    const snapshot = getProviderSnapshot(db, currentServiceConfig.serviceKey, mapping.providerKey);
    if (!snapshot?.payload) return null;

    return {
      ...snapshot.payload,
      serviceKey: currentServiceConfig.serviceKey,
      providerKey: mapping.providerKey,
      providerName: mapping.displayName,
      skipped: true,
    };
  }

  async function refreshProvider(currentServiceConfig, mapping, reason) {
    const reusableResult = getReusableProviderResult(currentServiceConfig, mapping, reason);
    if (reusableResult) return reusableResult;

    const provider = getProvider(mapping.providerKey);
    const apiKey = process.env[mapping.keyEnv] || '';
    const previousSnapshot = getProviderSnapshot(db, currentServiceConfig.serviceKey, mapping.providerKey)?.payload || null;
    const result = await provider.fetchProviderOffers({
      mapping,
      apiKey,
      exchangeRateService,
      previousSnapshot,
    });
    const materializedResult = {
      ...result,
      serviceKey: currentServiceConfig.serviceKey,
    };

    const attemptedAt = new Date().toISOString();
    if (materializedResult.error) {
      const existing = getProviderState(db, currentServiceConfig.serviceKey, mapping.providerKey);
      saveProviderState(db, {
        service_key: currentServiceConfig.serviceKey,
        provider_key: mapping.providerKey,
        status: 'error',
        last_attempted_at: attemptedAt,
        last_success_at: existing?.last_success_at || null,
        error_message: materializedResult.error,
      });
      return materializedResult;
    }

    saveProviderSnapshot(db, currentServiceConfig.serviceKey, mapping.providerKey, materializedResult);
    saveProviderState(db, {
      service_key: currentServiceConfig.serviceKey,
      provider_key: mapping.providerKey,
      status: 'success',
      last_attempted_at: attemptedAt,
      last_success_at: attemptedAt,
      error_message: '',
    });
    return materializedResult;
  }

  async function refreshAllServices(reason, eventId) {
    upsertAllServiceConfigs();
    await exchangeRateService.loadUsdRates(reason === 'manual');

    const tasks = serviceConfigs.flatMap((currentServiceConfig) => (
      currentServiceConfig.providerMappings.map((mapping) => (
        refreshProvider(currentServiceConfig, mapping, reason)
      ))
    ));
    const results = await Promise.all(tasks);

    completeRefreshEvent(db, eventId, 'success', {
      reason,
      providers: results.map((result) => ({
        serviceKey: result.serviceKey,
        providerKey: result.providerKey,
        error: result.error,
        offerCount: result.offers?.length || 0,
        skipped: Boolean(result.skipped),
      })),
    });

    return results;
  }

  function checkCanStart(reason) {
    if (isRunning) {
      return { accepted: false, reason: 'already_running' };
    }
    if (reason === 'manual') {
      const now = Date.now();
      if (now - lastManualTriggerAt < refreshCooldownMs) {
        return {
          accepted: false,
          reason: 'cooldown',
          cooldownRemainingMs: refreshCooldownMs - (now - lastManualTriggerAt),
        };
      }
      lastManualTriggerAt = now;
    }
    return { accepted: true };
  }

  async function runRefresh(reason = 'scheduled') {
    const canStart = checkCanStart(reason);
    if (!canStart.accepted) return canStart;

    isRunning = true;
    const eventId = insertRefreshEvent(db, new Date().toISOString());

    try {
      await refreshAllServices(reason, eventId);
      return { accepted: true, status: 'success' };
    } catch (error) {
      completeRefreshEvent(db, eventId, 'error', {
        reason,
        error: error.message,
      });
      return { accepted: true, status: 'error', error: error.message };
    } finally {
      isRunning = false;
    }
  }

  function getState() {
    return {
      isRunning,
      currentPromise,
      latestEvent: getLatestRefreshEvent(db),
      snapshots: getAllProviderSnapshots(db),
      providerStates: getAllProviderStates(db),
    };
  }

  function refreshAll(reason = 'scheduled') {
    currentPromise = runRefresh(reason)
      .finally(() => {
        currentPromise = null;
      });
    return currentPromise;
  }

  function triggerRefresh(reason = 'manual') {
    const canStart = checkCanStart(reason);
    if (!canStart.accepted) return canStart;

    isRunning = true;
    currentPromise = (async () => {
      const eventId = insertRefreshEvent(db, new Date().toISOString());
      try {
        await refreshAllServices(reason, eventId);
      } catch (error) {
        completeRefreshEvent(db, eventId, 'error', {
          reason,
          error: error.message,
        });
      } finally {
        isRunning = false;
        currentPromise = null;
      }
    })();

    return {
      accepted: true,
      status: 'started',
    };
  }

  return {
    getState,
    refreshAll,
    triggerRefresh,
  };
}

module.exports = {
  createRefreshController,
};
