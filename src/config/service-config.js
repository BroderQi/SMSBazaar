const DEFAULT_BIND_WHITELIST = [
  'AF',
  'AM',
  'CW',
  'AO',
  'AX',
  'BD',
  'BF',
  'BG',
  'BI',
  'BL',
  'BO',
  'CA',
  'CC',
  'CF',
  'CM',
  'CX',
  'DZ',
  'EC',
  'EG',
  'EH',
  'ET',
  'FK',
  'FR',
  'GH',
  'GN',
  'GW',
  'HN',
  'HT',
  'ID',
  'IO',
  'JM',
  'JO',
  'JP',
  'KG',
  'KH',
  'KM',
  'KR',
  'LB',
  'LK',
  'LY',
  'ME',
  'MF',
  'MG',
  'ML',
  'MN',
  'MP',
  'MU',
  'MY',
  'MZ',
  'NG',
  'NU',
  'PE',
  'PK',
  'PN',
  'PS',
  'SA',
  'SD',
  'SH',
  'SI',
  'SJ',
  'SL',
  'SM',
  'SN',
  'TG',
  'TH',
  'TJ',
  'TK',
  'TL',
  'TM',
  'TW',
  'UG',
  'UM',
  'US',
  'UZ',
  'VA',
  'VN',
  'VU',
  'RS',
  'ZM',
  'ZW',
];

const DEFAULT_RECOMMENDED_WHITELIST = [
  'ID',
  'PH',
  'CO',
  'UA',
  'NL',
  'BR',
  'PL',
  'GB',
  'CA',
  'MX',
  'IL',
  'FR',
  'SE',
  'TH',
  'HK',
];

const MODE_DEFINITIONS = {
  all: {
    value: 'all',
    label: 'All countries',
    description: 'All countries returned by providers',
  },
  register: {
    value: 'register',
    label: 'Register OAuth',
    description: 'OpenAI supported countries',
  },
  bind: {
    value: 'bind',
    label: 'Bind OAuth',
    description: 'Configured bind whitelist',
  },
  recommended: {
    value: 'recommended',
    label: 'Recommended',
    description: 'Configured recommended countries',
  },
};

const BASE_PROVIDERS = [
  {
    providerKey: 'hero-sms',
    displayName: 'Hero SMS',
    envPrefix: 'HERO_SMS',
    legacyServiceCodeEnv: 'HERO_SMS_SERVICE_CODE',
    baseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    keyEnv: 'HERO_SMS_API_KEY',
  },
  {
    providerKey: 'smsbower',
    displayName: 'SMSBower',
    envPrefix: 'SMSBOWER',
    legacyServiceCodeEnv: 'SMSBOWER_SERVICE_CODE',
    baseUrl: 'https://smsbower.page/stubs/handler_api.php',
    publicPricesUrl: 'https://smsbower.app/activations/getPricesByService',
    keyEnv: 'SMSBOWER_API_KEY',
  },
  {
    providerKey: '5sim',
    displayName: '5SIM',
    envPrefix: 'FIVESIM',
    legacyServiceCodeEnv: 'FIVESIM_SERVICE_CODE',
    baseUrl: 'https://5sim.net/v1',
    keyEnv: 'FIVESIM_API_KEY',
  },
  {
    providerKey: 'nexsms',
    displayName: 'NexSMS',
    envPrefix: 'NEXSMS',
    legacyServiceCodeEnv: 'NEXSMS_SERVICE_CODE',
    baseUrl: 'https://api.nexsms.net/api',
    keyEnv: 'NEXSMS_API_KEY',
  },
  {
    providerKey: 'grizzlysms',
    displayName: 'Grizzly SMS',
    envPrefix: 'GRIZZLYSMS',
    legacyServiceCodeEnv: 'GRIZZLYSMS_SERVICE_CODE',
    baseUrl: 'https://api.grizzlysms.com/stubs/handler_api.php',
    keyEnv: 'GRIZZLYSMS_API_KEY',
  },
  {
    providerKey: 'sms-verification-number',
    displayName: 'SMS Verification Number',
    envPrefix: 'SMS_VERIFICATION',
    legacyServiceCodeEnv: 'SMS_VERIFICATION_SERVICE_CODE',
    baseUrl: 'https://sms-verification-number.com/stubs/handler_api',
    keyEnv: 'SMS_VERIFICATION_API_KEY',
  },
  {
    providerKey: 'smspool',
    displayName: 'SMSPool',
    envPrefix: 'SMSPOOL',
    legacyServiceCodeEnv: 'SMSPOOL_SERVICE_CODE',
    baseUrl: 'https://api.smspool.net',
    keyEnv: 'SMSPOOL_API_KEY',
    minRefreshIntervalMs: Number(process.env.SMSPOOL_REFRESH_INTERVAL_MS || 180000),
  },
];

function readEnv(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function createProviderMappings({
  serviceEnvPrefix,
  defaultCodes,
  nativeNames = {},
  useLegacyOpenAiEnv = false,
}) {
  return BASE_PROVIDERS.map((provider) => {
    const serviceCode = readEnv(
      `${serviceEnvPrefix}_${provider.envPrefix}_SERVICE_CODE`,
      useLegacyOpenAiEnv
        ? readEnv(provider.legacyServiceCodeEnv, defaultCodes[provider.providerKey] || '')
        : (defaultCodes[provider.providerKey] || ''),
    );
    const nativeServiceName = provider.providerKey === 'smspool'
      ? readEnv(
        `${serviceEnvPrefix}_${provider.envPrefix}_NATIVE_SERVICE_NAME`,
        useLegacyOpenAiEnv
          ? readEnv('SMSPOOL_NATIVE_SERVICE_NAME', nativeNames[provider.providerKey] || '')
          : (nativeNames[provider.providerKey] || ''),
      )
      : '';

    if (!serviceCode && !nativeServiceName) return null;

    return {
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      serviceCode,
      nativeServiceName,
      baseUrl: provider.baseUrl,
      publicPricesUrl: provider.publicPricesUrl,
      keyEnv: provider.keyEnv,
      minRefreshIntervalMs: provider.minRefreshIntervalMs,
    };
  }).filter(Boolean);
}

const services = [
  {
    serviceKey: 'openai_chatgpt',
    displayName: 'OPENAI (ChatGPT)',
    defaultMode: 'register',
    modes: [
      MODE_DEFINITIONS.register,
      MODE_DEFINITIONS.bind,
      MODE_DEFINITIONS.recommended,
    ],
    bindWhitelistIso2: DEFAULT_BIND_WHITELIST,
    recommendedWhitelistIso2: DEFAULT_RECOMMENDED_WHITELIST,
    providerMappings: createProviderMappings({
      serviceEnvPrefix: 'OPENAI',
      useLegacyOpenAiEnv: true,
      defaultCodes: {
        'hero-sms': 'dr',
        smsbower: 'dr',
        '5sim': 'openai',
        nexsms: 'dr',
        grizzlysms: 'dr',
        'sms-verification-number': 'dr',
        smspool: '671',
      },
      nativeNames: {
        smspool: 'OpenAI / ChatGPT',
      },
    }),
  },
  {
    serviceKey: 'paypal',
    displayName: 'PayPal',
    defaultMode: 'all',
    modes: [MODE_DEFINITIONS.all],
    bindWhitelistIso2: [],
    recommendedWhitelistIso2: [],
    providerMappings: createProviderMappings({
      serviceEnvPrefix: 'PAYPAL',
      defaultCodes: {
        'hero-sms': 'ts',
        smsbower: 'ts',
        '5sim': 'paypal',
        nexsms: 'ts',
        grizzlysms: 'ts',
        'sms-verification-number': 'ts',
        smspool: '',
      },
      nativeNames: {
        smspool: '',
      },
    }),
  },
  {
    serviceKey: 'gojek_gopay',
    displayName: 'Gojek / GoPay',
    defaultMode: 'all',
    modes: [MODE_DEFINITIONS.all],
    bindWhitelistIso2: [],
    recommendedWhitelistIso2: [],
    providerMappings: createProviderMappings({
      serviceEnvPrefix: 'GOJEK_GOPAY',
      defaultCodes: {
        'hero-sms': 'ni',
        smsbower: 'ni',
        '5sim': 'gojek',
        nexsms: 'ni',
        grizzlysms: 'ni',
        'sms-verification-number': 'ni',
        smspool: '392',
      },
      nativeNames: {
        smspool: 'GoJek',
      },
    }),
  },
];

const defaultServiceKey = services.some((service) => service.serviceKey === process.env.DEFAULT_SERVICE_KEY)
  ? process.env.DEFAULT_SERVICE_KEY
  : 'openai_chatgpt';

function getServiceConfig(serviceKey) {
  return services.find((service) => service.serviceKey === serviceKey)
    || services.find((service) => service.serviceKey === defaultServiceKey)
    || services[0];
}

function getServiceConfigs() {
  return services;
}

module.exports = {
  defaultServiceKey,
  getServiceConfig,
  getServiceConfigs,
  modeDefinitions: MODE_DEFINITIONS,
  services,
};
