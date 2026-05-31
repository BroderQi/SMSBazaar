'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const LEGACY_SERVICE_KEY = 'openai_chatgpt';

const PROVIDER_SNAPSHOTS_SQL = `
  CREATE TABLE IF NOT EXISTS provider_snapshots (
    service_key TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (service_key, provider_key)
  );
`;

const PROVIDER_STATES_SQL = `
  CREATE TABLE IF NOT EXISTS provider_states (
    service_key TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    status TEXT NOT NULL,
    last_attempted_at TEXT NOT NULL,
    last_success_at TEXT,
    error_message TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (service_key, provider_key)
  );
`;

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function getTableInfo(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function getPrimaryKeyColumns(tableInfo) {
  return tableInfo
    .filter((column) => Number(column.pk || 0) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
}

function createTableSqlWithoutIfNotExists(sql) {
  return sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE');
}

function migrateProviderSnapshotsIfNeeded(db) {
  const tableInfo = getTableInfo(db, 'provider_snapshots');
  if (!tableInfo.length) {
    db.exec(PROVIDER_SNAPSHOTS_SQL);
    return;
  }

  const pkColumns = getPrimaryKeyColumns(tableInfo);
  if (pkColumns.join(',') === 'service_key,provider_key') return;

  const columnNames = new Set(tableInfo.map((column) => column.name));
  const serviceKeyExpression = columnNames.has('service_key') ? 'service_key' : `'${LEGACY_SERVICE_KEY}'`;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE provider_snapshots RENAME TO provider_snapshots_legacy');
    db.exec(createTableSqlWithoutIfNotExists(PROVIDER_SNAPSHOTS_SQL));
    db.exec(`
      INSERT OR REPLACE INTO provider_snapshots (service_key, provider_key, payload_json, fetched_at)
      SELECT ${serviceKeyExpression}, provider_key, payload_json, fetched_at
      FROM provider_snapshots_legacy
    `);
    db.exec('DROP TABLE provider_snapshots_legacy');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateProviderStatesIfNeeded(db) {
  const tableInfo = getTableInfo(db, 'provider_states');
  if (!tableInfo.length) {
    db.exec(PROVIDER_STATES_SQL);
    return;
  }

  const pkColumns = getPrimaryKeyColumns(tableInfo);
  if (pkColumns.join(',') === 'service_key,provider_key') return;

  const columnNames = new Set(tableInfo.map((column) => column.name));
  const serviceKeyExpression = columnNames.has('service_key') ? 'service_key' : `'${LEGACY_SERVICE_KEY}'`;

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE provider_states RENAME TO provider_states_legacy');
    db.exec(createTableSqlWithoutIfNotExists(PROVIDER_STATES_SQL));
    db.exec(`
      INSERT OR REPLACE INTO provider_states (
        service_key,
        provider_key,
        status,
        last_attempted_at,
        last_success_at,
        error_message
      )
      SELECT
        ${serviceKeyExpression},
        provider_key,
        status,
        last_attempted_at,
        last_success_at,
        error_message
      FROM provider_states_legacy
    `);
    db.exec('DROP TABLE provider_states_legacy');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureProviderTables(db) {
  db.exec(PROVIDER_SNAPSHOTS_SQL);
  db.exec(PROVIDER_STATES_SQL);
  migrateProviderSnapshotsIfNeeded(db);
  migrateProviderStatesIfNeeded(db);
}

function createDatabase(databasePath) {
  ensureParentDir(databasePath);
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS service_configs (
      service_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      base_currency TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refresh_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  ensureProviderTables(db);

  return db;
}

function upsertServiceConfig(db, serviceConfig) {
  db.prepare(`
    INSERT INTO service_configs (service_key, payload_json, updated_at)
    VALUES (@service_key, @payload_json, @updated_at)
    ON CONFLICT(service_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run({
    service_key: serviceConfig.serviceKey,
    payload_json: JSON.stringify(serviceConfig),
    updated_at: new Date().toISOString(),
  });
}

function getServiceConfig(db, serviceKey) {
  const row = db.prepare('SELECT payload_json FROM service_configs WHERE service_key = ?').get(serviceKey);
  return row ? JSON.parse(row.payload_json) : null;
}

function normalizeProviderSnapshotArgs(serviceKey, providerKey, payload) {
  if (payload === undefined) {
    return {
      serviceKey: LEGACY_SERVICE_KEY,
      providerKey: serviceKey,
      payload: providerKey,
    };
  }
  return { serviceKey, providerKey, payload };
}

function saveProviderSnapshot(db, serviceKey, providerKey, payload) {
  const args = normalizeProviderSnapshotArgs(serviceKey, providerKey, payload);
  const fetchedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO provider_snapshots (service_key, provider_key, payload_json, fetched_at)
    VALUES (@service_key, @provider_key, @payload_json, @fetched_at)
    ON CONFLICT(service_key, provider_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at
  `).run({
    service_key: args.serviceKey,
    provider_key: args.providerKey,
    payload_json: JSON.stringify(args.payload),
    fetched_at: fetchedAt,
  });
  return fetchedAt;
}

function normalizeProviderLookupArgs(serviceKey, providerKey) {
  if (providerKey === undefined) {
    return {
      serviceKey: LEGACY_SERVICE_KEY,
      providerKey: serviceKey,
    };
  }
  return { serviceKey, providerKey };
}

function getProviderSnapshot(db, serviceKey, providerKey) {
  const args = normalizeProviderLookupArgs(serviceKey, providerKey);
  const row = db.prepare(`
    SELECT service_key, provider_key, payload_json, fetched_at
    FROM provider_snapshots
    WHERE service_key = ? AND provider_key = ?
  `).get(args.serviceKey, args.providerKey);
  if (!row) return null;
  return {
    serviceKey: row.service_key,
    providerKey: row.provider_key,
    payload: JSON.parse(row.payload_json),
    fetchedAt: row.fetched_at,
  };
}

function getAllProviderSnapshots(db, serviceKey = '') {
  const rows = serviceKey
    ? db.prepare(`
      SELECT service_key, provider_key, payload_json, fetched_at
      FROM provider_snapshots
      WHERE service_key = ?
    `).all(serviceKey)
    : db.prepare('SELECT service_key, provider_key, payload_json, fetched_at FROM provider_snapshots').all();
  return rows.map((row) => ({
    serviceKey: row.service_key,
    providerKey: row.provider_key,
    payload: JSON.parse(row.payload_json),
    fetchedAt: row.fetched_at,
  }));
}

function saveProviderState(db, state) {
  db.prepare(`
    INSERT INTO provider_states (service_key, provider_key, status, last_attempted_at, last_success_at, error_message)
    VALUES (@service_key, @provider_key, @status, @last_attempted_at, @last_success_at, @error_message)
    ON CONFLICT(service_key, provider_key) DO UPDATE SET
      status = excluded.status,
      last_attempted_at = excluded.last_attempted_at,
      last_success_at = excluded.last_success_at,
      error_message = excluded.error_message
  `).run({
    service_key: state.service_key || LEGACY_SERVICE_KEY,
    provider_key: state.provider_key,
    status: state.status,
    last_attempted_at: state.last_attempted_at,
    last_success_at: state.last_success_at,
    error_message: state.error_message || '',
  });
}

function getAllProviderStates(db, serviceKey = '') {
  const rows = serviceKey
    ? db.prepare('SELECT * FROM provider_states WHERE service_key = ?').all(serviceKey)
    : db.prepare('SELECT * FROM provider_states').all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.provider_key, row);
  }
  return map;
}

function getProviderState(db, serviceKey, providerKey) {
  return db.prepare(`
    SELECT *
    FROM provider_states
    WHERE service_key = ? AND provider_key = ?
  `).get(serviceKey || LEGACY_SERVICE_KEY, providerKey);
}

function saveExchangeRates(db, baseCurrency, payload) {
  const fetchedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO exchange_rates (base_currency, payload_json, fetched_at)
    VALUES (@base_currency, @payload_json, @fetched_at)
    ON CONFLICT(base_currency) DO UPDATE SET
      payload_json = excluded.payload_json,
      fetched_at = excluded.fetched_at
  `).run({
    base_currency: baseCurrency,
    payload_json: JSON.stringify(payload),
    fetched_at: fetchedAt,
  });
  return fetchedAt;
}

function getExchangeRates(db, baseCurrency) {
  const row = db.prepare('SELECT payload_json, fetched_at FROM exchange_rates WHERE base_currency = ?').get(baseCurrency);
  if (!row) return null;
  return {
    payload: JSON.parse(row.payload_json),
    fetchedAt: row.fetched_at,
  };
}

function insertRefreshEvent(db, startedAt) {
  const info = db.prepare(`
    INSERT INTO refresh_events (started_at, status, details_json)
    VALUES (?, 'running', '{}')
  `).run(startedAt);
  return info.lastInsertRowid;
}

function completeRefreshEvent(db, id, status, details) {
  db.prepare(`
    UPDATE refresh_events
    SET completed_at = ?, status = ?, details_json = ?
    WHERE id = ?
  `).run(new Date().toISOString(), status, JSON.stringify(details || {}), id);
}

function getLatestRefreshEvent(db) {
  const row = db.prepare(`
    SELECT *
    FROM refresh_events
    ORDER BY id DESC
    LIMIT 1
  `).get();
  return row || null;
}

module.exports = {
  completeRefreshEvent,
  createDatabase,
  getAllProviderSnapshots,
  getAllProviderStates,
  getExchangeRates,
  getLatestRefreshEvent,
  getProviderState,
  getProviderSnapshot,
  getServiceConfig,
  insertRefreshEvent,
  saveExchangeRates,
  saveProviderSnapshot,
  saveProviderState,
  upsertServiceConfig,
};
