'use strict';

function applyStateToOffer(offer, providerState) {
  if (!providerState) return offer;
  if (providerState.status === 'success') return offer;
  return {
    ...offer,
    status: offer.inventoryTotal > 0 ? 'stale' : 'error',
    errorMessage: providerState.error_message || offer.errorMessage || '',
  };
}

function aggregateByCountry({
  snapshots,
  states,
  filters,
  whitelist,
  recommendedWhitelist,
  recommendationPathByIso2,
  openAiSupportedWhitelist,
  registerSupportedWhitelist,
}) {
  const rows = new Map();
  const providerFilter = filters.provider ? String(filters.provider).toLowerCase() : '';
  const countryFilter = filters.country ? String(filters.country).toUpperCase() : '';
  const statusFilter = filters.status ? String(filters.status).toLowerCase() : '';
  const whitelistSet = new Set((whitelist || []).map((value) => String(value).toUpperCase()));
  const recommendedSet = new Set((recommendedWhitelist || []).map((value) => String(value).toUpperCase()));
  const recommendationMap = recommendationPathByIso2 || new Map();
  const registerSupportedSet = new Set((registerSupportedWhitelist || openAiSupportedWhitelist || []).map((value) => String(value).toUpperCase()));

  for (const snapshot of snapshots) {
    const providerState = states.get(snapshot.providerKey);
    for (const offer of snapshot.payload.offers || []) {
      const materializedOffer = applyStateToOffer(offer, providerState);
      if (!materializedOffer.countryIso2) continue;
      if (filters.mode === 'register' && registerSupportedSet.size > 0 && !registerSupportedSet.has(materializedOffer.countryIso2)) continue;
      if (filters.mode === 'bind' && !whitelistSet.has(materializedOffer.countryIso2)) continue;
      if (filters.mode === 'recommended' && !recommendedSet.has(materializedOffer.countryIso2)) continue;
      if (countryFilter && materializedOffer.countryIso2 !== countryFilter) continue;
      if (providerFilter && materializedOffer.providerKey.toLowerCase() !== providerFilter) continue;
      if (statusFilter && materializedOffer.status.toLowerCase() !== statusFilter) continue;

      const current = rows.get(materializedOffer.countryIso2) || {
        countryIso2: materializedOffer.countryIso2,
        countryName: materializedOffer.countryName,
        countryNameEn: materializedOffer.countryNameEn,
        countryNameZh: materializedOffer.countryNameZh,
        countryDisplayName: materializedOffer.countryDisplayName || materializedOffer.countryName,
        recommendationPath: recommendationMap.has(materializedOffer.countryIso2)
          ? recommendationMap.get(materializedOffer.countryIso2)
          : null,
        providerCount: 0,
        inventoryTotal: 0,
        minPriceUsd: Number.POSITIVE_INFINITY,
        minPriceOriginal: 0,
        cheapestCurrency: '',
        lastFetchedAt: '',
        offers: [],
      };
      current.providerCount += 1;
      current.inventoryTotal += Number(materializedOffer.inventoryTotal || 0);
      if (materializedOffer.minPriceUsd < current.minPriceUsd) {
        current.minPriceUsd = materializedOffer.minPriceUsd;
        current.minPriceOriginal = materializedOffer.minPriceOriginal;
        current.cheapestCurrency = materializedOffer.currency;
      }
      if (!current.lastFetchedAt || materializedOffer.lastFetchedAt > current.lastFetchedAt) {
        current.lastFetchedAt = materializedOffer.lastFetchedAt;
      }
      current.offers.push(materializedOffer);
      rows.set(materializedOffer.countryIso2, current);
    }
  }

  const values = Array.from(rows.values()).map((row) => ({
    ...row,
    minPriceUsd: Number.isFinite(row.minPriceUsd) ? row.minPriceUsd : 0,
    offers: row.offers.sort((left, right) => left.minPriceUsd - right.minPriceUsd || right.inventoryTotal - left.inventoryTotal),
  }));

  const sort = filters.sort || 'price_asc';
  values.sort((left, right) => {
    if (sort === 'price_desc') return right.minPriceUsd - left.minPriceUsd || right.inventoryTotal - left.inventoryTotal;
    if (sort === 'stock_desc') return right.inventoryTotal - left.inventoryTotal || left.minPriceUsd - right.minPriceUsd;
    return left.minPriceUsd - right.minPriceUsd || right.inventoryTotal - left.inventoryTotal;
  });
  return values;
}

module.exports = {
  aggregateByCountry,
};
