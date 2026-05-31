import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createDatabase, saveProviderSnapshot, saveProviderState } from '../src/lib/db';

describe('API endpoints', () => {
  process.env.ADMIN_REFRESH_TOKEN = 'test-admin-token';

  function setupApp() {
    const db = createDatabase(':memory:');
    saveProviderSnapshot(db, 'openai_chatgpt', 'smsbower', {
      providerKey: 'smsbower',
      providerName: 'SMSBower',
      offers: [
        {
          providerKey: 'smsbower',
          providerName: 'SMSBower',
          countryIso2: 'US',
          countryName: 'United States',
          status: 'in_stock',
          currency: 'USD',
          minPriceOriginal: 0.11,
          minPriceUsd: 0.11,
          inventoryTotal: 9,
          tiers: [{ priceOriginal: 0.11, priceUsd: 0.11, stock: 9, providerRef: '' }],
          lastFetchedAt: '2026-05-27T12:00:00.000Z',
          errorMessage: '',
        },
      ],
      error: '',
    });
    saveProviderSnapshot(db, 'paypal', 'smsbower', {
      providerKey: 'smsbower',
      providerName: 'SMSBower',
      offers: [
        {
          providerKey: 'smsbower',
          providerName: 'SMSBower',
          countryIso2: 'GB',
          countryName: 'United Kingdom',
          status: 'in_stock',
          currency: 'USD',
          minPriceOriginal: 0.21,
          minPriceUsd: 0.21,
          inventoryTotal: 5,
          tiers: [{ priceOriginal: 0.21, priceUsd: 0.21, stock: 5, providerRef: '' }],
          lastFetchedAt: '2026-05-27T12:00:00.000Z',
          errorMessage: '',
        },
      ],
      error: '',
    });
    saveProviderState(db, {
      service_key: 'openai_chatgpt',
      provider_key: 'smsbower',
      status: 'success',
      last_attempted_at: '2026-05-27T12:00:00.000Z',
      last_success_at: '2026-05-27T12:00:00.000Z',
      error_message: '',
    });
    saveProviderState(db, {
      service_key: 'paypal',
      provider_key: 'smsbower',
      status: 'success',
      last_attempted_at: '2026-05-27T12:00:00.000Z',
      last_success_at: '2026-05-27T12:00:00.000Z',
      error_message: '',
    });

    const refreshController = {
      getState() {
        return { isRunning: false };
      },
      async refreshAll() {
        return { accepted: true, status: 'success' };
      },
    };

    return createApp({ db, refreshController });
  }

  it('serves meta and compare payloads', async () => {
    const app = setupApp();
    const meta = await request(app).get('/api/meta');
    expect(meta.status).toBe(200);
    expect(meta.body.service.serviceKey).toBe('openai_chatgpt');
    expect(meta.body.services.map((service) => service.serviceKey)).toContain('paypal');
    expect(Array.isArray(meta.body.service.recommendedWhitelistIso2)).toBe(true);
    expect(Array.isArray(meta.body.service.registerSupportedWhitelistIso2)).toBe(true);
    expect(meta.body.recommendationConfig.filePath).toBeUndefined();

    const compare = await request(app).get('/api/compare?mode=register&sort=price_asc');
    expect(compare.status).toBe(200);
    expect(compare.body.rows).toHaveLength(1);
    expect(compare.body.rows[0].countryIso2).toBe('US');
    expect(compare.body.recommendationConfig.filePath).toBeUndefined();

    const paypal = await request(app).get('/api/compare?service=paypal&mode=all&sort=price_asc');
    expect(paypal.status).toBe(200);
    expect(paypal.body.filters.service).toBe('paypal');
    expect(paypal.body.filters.mode).toBe('all');
    expect(paypal.body.rows).toHaveLength(1);
    expect(paypal.body.rows[0].countryIso2).toBe('GB');

    const recommended = await request(app).get('/api/compare?mode=recommended&sort=price_asc');
    expect(recommended.status).toBe(200);
  });

  it('triggers manual refresh endpoint', async () => {
    const app = setupApp();
    const response = await request(app)
      .post('/api/refresh')
      .set('x-admin-refresh-token', 'test-admin-token');
    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
  });

  it('rejects manual refresh without admin token', async () => {
    const app = setupApp();
    const response = await request(app).post('/api/refresh');
    expect(response.status).toBe(403);
    expect(response.body.accepted).toBe(false);
  });
});
