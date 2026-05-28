'use strict';

const { createProviderError, makeOffer } = require('./helpers');
const { request } = require('../http');

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || 'https://api.smspool.net').trim();
  if (!raw || raw.includes('/stubs/handler_api')) return 'https://api.smspool.net';
  return raw.replace(/\/+$/, '');
}

function parseJson(text, endpoint) {
  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `Failed to parse SMSPool ${endpoint} response: ${error.message}`;
    throw error;
  }
}

async function postJson(baseUrl, endpoint, params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    body.set(key, String(value));
  }

  const response = await request(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  return parseJson(response.text, endpoint);
}

async function mapWithConcurrency(items, limit, iteratee) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isNumericServiceCode(serviceCode) {
  return /^\d+$/.test(String(serviceCode || '').trim());
}

function findNativeServiceId(services, mapping) {
  const configuredName = String(mapping.nativeServiceName || '').trim().toLowerCase();
  const fallbackPattern = /openai|chatgpt/i;

  const exact = services.find((service) => (
    configuredName
      && String(service.name || service.service_name || '').trim().toLowerCase() === configuredName
  ));
  if (exact) return String(exact.ID || exact.id || exact.service || '');

  const fuzzy = services.find((service) => (
    fallbackPattern.test(String(service.name || service.service_name || service.title || ''))
  ));
  return fuzzy ? String(fuzzy.ID || fuzzy.id || fuzzy.service || '') : '';
}

async function resolveServiceId(baseUrl, mapping) {
  if (isNumericServiceCode(mapping.serviceCode)) {
    return String(mapping.serviceCode).trim();
  }

  const services = await postJson(baseUrl, '/service/retrieve_all');
  const serviceList = Array.isArray(services) ? services : [];
  const serviceId = findNativeServiceId(serviceList, mapping);
  if (!serviceId) {
    throw new Error(`SMSPool native service not found for ${mapping.serviceCode || mapping.nativeServiceName || 'OpenAI / ChatGPT'}`);
  }
  return serviceId;
}

function groupPricingByCountry(pricingRows) {
  const countries = new Map();

  for (const row of pricingRows || []) {
    const countryId = String(row.country || row.country_id || '').trim();
    if (!countryId) continue;

    const country = countries.get(countryId) || {
      countryId,
      countryIso2: String(row.short_name || row.iso || '').trim().toUpperCase(),
      countryName: String(row.country_name || row.name || countryId).trim(),
      tiers: [],
    };

    country.tiers.push({
      pool: String(row.pool || row.pool_id || '').trim(),
      priceOriginal: Number(row.price || row.cost || 0),
      stock: 0,
      providerRef: String(row.pool || row.pool_id || '').trim(),
    });
    countries.set(countryId, country);
  }

  return Array.from(countries.values());
}

async function fetchPoolNames(baseUrl, countryId, serviceId) {
  try {
    const payload = await postJson(baseUrl, '/pool/retrieve_valid', {
      country: countryId,
      service: serviceId,
      web: 1,
    });
    return new Map(Object.entries(payload || {}).map(([poolId, poolName]) => [String(poolId), String(poolName)]));
  } catch (error) {
    return new Map();
  }
}

async function fetchStock(baseUrl, countryId, serviceId, pool = '') {
  const payload = await postJson(baseUrl, '/sms/stock', {
    country: countryId,
    service: serviceId,
    pool,
  });

  if (Number(payload?.success) === 0) {
    throw new Error(payload?.message || 'SMSPool stock request failed');
  }

  return Number(payload?.amount || 0);
}

async function fetchStockSafely(baseUrl, countryId, serviceId, pool = '') {
  try {
    return {
      stock: await fetchStock(baseUrl, countryId, serviceId, pool),
      errorMessage: '',
    };
  } catch (error) {
    return {
      stock: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchProviderOffers({ mapping, exchangeRateService, apiKey }) {
  try {
    if (!apiKey) {
      throw new Error('Missing API key');
    }

    const baseUrl = normalizeBaseUrl(mapping.baseUrl);
    const serviceId = await resolveServiceId(baseUrl, mapping);
    const pricingPayload = await postJson(baseUrl, '/request/pricing', {
      key: apiKey,
      service: serviceId,
    });
    const countries = groupPricingByCountry(Array.isArray(pricingPayload) ? pricingPayload : []);
    const now = new Date().toISOString();
    const includePoolNames = String(process.env.SMSPOOL_INCLUDE_POOL_NAMES || '').toLowerCase() === 'true';
    const stockMode = String(process.env.SMSPOOL_STOCK_MODE || 'country').toLowerCase();

    const offers = await mapWithConcurrency(countries, 3, async (country) => {
      const poolNames = includePoolNames
        ? await fetchPoolNames(baseUrl, country.countryId, serviceId)
        : new Map();
      const sortedTiers = country.tiers
        .slice()
        .sort((left, right) => left.priceOriginal - right.priceOriginal);
      const tiers = stockMode === 'pool'
        ? await mapWithConcurrency(sortedTiers, 2, async (tier) => {
          const poolName = poolNames.get(tier.pool);
          const stockResult = await fetchStockSafely(baseUrl, country.countryId, serviceId, tier.pool);
          return {
            priceOriginal: tier.priceOriginal,
            stock: stockResult.stock,
            providerRef: poolName ? `${tier.pool} ${poolName}` : tier.providerRef,
            stockErrorMessage: stockResult.errorMessage,
          };
        })
        : sortedTiers.map((tier, index) => {
          const poolName = poolNames.get(tier.pool);
          const providerRef = poolName ? `${tier.pool} ${poolName}` : tier.providerRef;
          return {
            priceOriginal: tier.priceOriginal,
            stock: 0,
            providerRef: index === 0 ? `${providerRef} / total stock` : providerRef,
          };
        });

      if (stockMode !== 'pool' && tiers.length > 0) {
        const stockResult = await fetchStockSafely(baseUrl, country.countryId, serviceId);
        tiers[0].stock = stockResult.stock;
        tiers[0].stockErrorMessage = stockResult.errorMessage;
      }
      const stockErrorMessage = tiers.find((tier) => tier.stockErrorMessage)?.stockErrorMessage || '';

      return makeOffer({
        providerKey: mapping.providerKey,
        providerName: mapping.displayName,
        countryValue: country.countryIso2 || country.countryName,
        countryName: country.countryName,
        currency: 'USD',
        tiers,
        exchangeRateService,
        lastFetchedAt: now,
        status: stockErrorMessage ? 'stale' : undefined,
        errorMessage: stockErrorMessage ? 'SMSPool stock unavailable for this country; price is still shown.' : '',
        metadata: {
          nativeServiceId: serviceId,
          nativeCountryId: country.countryId,
        },
      });
    });

    return {
      providerKey: mapping.providerKey,
      providerName: mapping.displayName,
      offers: offers.filter((offer) => offer.countryIso2),
      error: '',
    };
  } catch (error) {
    return createProviderError(mapping.providerKey, mapping.displayName, error);
  }
}

module.exports = {
  fetchProviderOffers,
  groupPricingByCountry,
  normalizeBaseUrl,
};
