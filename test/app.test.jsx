import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/src/App';

describe('App', () => {
  beforeEach(() => {
    let compareCalls = 0;
    global.fetch = vi.fn(async (url, options) => {
      if (String(url).startsWith('/api/meta')) {
        const requestUrl = new URL(String(url), 'http://localhost');
        const serviceKey = requestUrl.searchParams.get('service') || 'openai_chatgpt';
        const services = [
          {
            serviceKey: 'openai_chatgpt',
            displayName: 'OPENAI (ChatGPT)',
            defaultMode: 'register',
            modes: [
              { value: 'register', label: 'Register OAuth', description: 'OpenAI supported countries' },
              { value: 'bind', label: 'Bind OAuth', description: 'Configured bind whitelist' },
              { value: 'recommended', label: 'Recommended', description: 'Configured recommended countries' },
            ],
          },
          {
            serviceKey: 'paypal',
            displayName: 'PayPal',
            defaultMode: 'all',
            modes: [{ value: 'all', label: 'All countries', description: 'All countries returned by providers' }],
          },
        ];
        const service = services.find((entry) => entry.serviceKey === serviceKey) || services[0];
        return {
          ok: true,
          json: async () => ({
            defaultServiceKey: 'openai_chatgpt',
            services,
            service: {
              ...service,
              bindWhitelistIso2: ['US'],
            },
            providers: [
              { providerKey: 'smsbower', displayName: 'SMSBower', status: 'success' },
            ],
            lastRefresh: { completed_at: '2026-05-27T12:00:00.000Z' },
            refreshState: 'idle',
          }),
        };
      }

      if (String(url).startsWith('/api/compare')) {
        compareCalls += 1;
        const requestUrl = new URL(String(url), 'http://localhost');
        const serviceKey = requestUrl.searchParams.get('service') || 'openai_chatgpt';
        const countryIso2 = serviceKey === 'paypal' ? 'GB' : 'US';
        const countryName = serviceKey === 'paypal' ? 'United Kingdom' : 'United States';
        const payload = {
          rows: [
            {
              countryIso2,
              countryName,
              providerCount: 1,
              inventoryTotal: 9,
              minPriceUsd: 0.11,
              minPriceOriginal: 0.11,
              cheapestCurrency: 'USD',
              lastFetchedAt: '2026-05-27T12:00:00.000Z',
              offers: [
                {
                  providerKey: 'smsbower',
                  providerName: 'SMSBower',
                  status: 'in_stock',
                  currency: 'USD',
                  minPriceOriginal: 0.11,
                  minPriceUsd: 0.11,
                  inventoryTotal: 9,
                  lastFetchedAt: '2026-05-27T12:00:00.000Z',
                  tiers: [{ priceOriginal: 0.11, priceUsd: 0.11, stock: 9, providerRef: '' }],
                  errorMessage: '',
                },
              ],
            },
          ],
          countries: [{ iso2: countryIso2, name: countryName, displayName: countryName }],
          updatedAt: '2026-05-27T12:00:00.000Z',
        };

        return {
          ok: true,
          json: async () => payload,
        };
      }

      throw new Error(`Unhandled fetch for ${url}`);
    });
  });

  it('loads rows and expands provider details', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: /United States/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /United States/i }));
    expect(await screen.findByRole('heading', { name: 'SMSBower' })).toBeInTheDocument();
  });

  it('switches mode and refreshes rows', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /United States/i });
    fireEvent.click(screen.getByRole('button', { name: /无WhatsAPP国家/i }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('mode=bind'));
    });

    fireEvent.click(screen.getByRole('button', { name: /目前推荐国家\(自测\)/i }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('mode=recommended'));
    });

    fireEvent.click(screen.getByRole('tab', { name: 'PayPal' }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('service=paypal'));
    });
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('mode=all'));
    });
  });
});
