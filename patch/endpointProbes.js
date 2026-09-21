'use strict';

const fs = require('fs');
const net = require('net');

const DEFAULT_FILE = '/app/config/endpoint-probes.json';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PROBES = 32;
const MAX_CONCURRENCY = 8;
const MAX_COLLECTION_MS = 10000;
const DEFAULT_TIMEOUT_MS = 1500;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;

const SAFE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH',
  'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EACCES', 'ECONNRESET', 'EPIPE',
  'EINVAL', 'ENOTFOUND', 'INVALID_CONFIG', 'INVALID_ENTRY',
  'INVALID_ID', 'INVALID_NAME', 'INVALID_ADDRESS', 'INVALID_PORT',
  'INVALID_TIMEOUT'
]);

function safeErrorCode(value) {
  const code = String(value || '').toUpperCase();
  return SAFE_ERROR_CODES.has(code) ? code : 'EUNKNOWN';
}

function unavailable(errorCode, configured) {
  return {
    available: false,
    configured: Boolean(configured),
    configuredCount: 0,
    reachableCount: 0,
    failedCount: 0,
    disabledCount: 0,
    invalidCount: 0,
    results: [],
    errorCode: errorCode ? safeErrorCode(errorCode) : null
  };
}

function normalizeString(value, maxLength) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function invalidResult(raw, index, errorCode) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const id = normalizeString(object.id, 80) || `probe-${index + 1}`;
  const name = normalizeString(object.name, 160) || id;
  const address = normalizeString(object.address, 128) || '—';
  const port = Number.isInteger(object.port) ? object.port : null;
  const addressLabel = address.includes(':') && address !== '—' ? `[${address}]` : address;
  return {
    id, name, address, addressLabel, port, state: 'invalid', reachable: false,
    latencyMs: null, errorCode: safeErrorCode(errorCode || 'INVALID_ENTRY')
  };
}

function normalizeProbe(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidResult(raw, index, 'INVALID_ENTRY');
  const id = normalizeString(raw.id, 80);
  const name = normalizeString(raw.name, 160);
  const address = normalizeString(raw.address, 128);
  const port = raw.port;
  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : raw.timeoutMs;
  if (!id) return invalidResult(raw, index, 'INVALID_ID');
  if (!name) return invalidResult(raw, index, 'INVALID_NAME');
  // Literal addresses only: net.connect must never perform DNS resolution.
  if (!address || address.includes('%') || net.isIP(address) === 0) return invalidResult(raw, index, 'INVALID_ADDRESS');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalidResult(raw, index, 'INVALID_PORT');
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return invalidResult(raw, index, 'INVALID_TIMEOUT');
  }
  return {
    id, name, address, addressLabel: net.isIP(address) === 6 ? `[${address}]` : address, port, timeoutMs,
    enabled: raw.enabled !== false
  };
}

function normalizeConfig(document) {
  const probes = Array.isArray(document) ? document : document && Array.isArray(document.probes) ? document.probes : null;
  if (!probes) return {valid: false, probes: [], errorCode: 'INVALID_CONFIG'};
  if (probes.length > MAX_PROBES) return {valid: false, probes: [], errorCode: 'INVALID_CONFIG'};
  const normalized = probes.map(normalizeProbe);
  const ids = normalized.filter(item => item.state !== 'invalid').map(item => item.id);
  if (new Set(ids).size !== ids.length) return {valid: false, probes: [], errorCode: 'INVALID_CONFIG'};
  return {valid: true, probes: normalized};
}

function classifyError(error) {
  const code = error && error.code ? String(error.code).toUpperCase() : '';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT') return 'timeout';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EACCES'].includes(code)) {
    return 'unreachable';
  }
  return 'unreachable';
}

function probeEndpoint(probe, budgetMs = Infinity) {
  if (probe.enabled === false) {
    return Promise.resolve({...probe, state: 'disabled', reachable: false, latencyMs: null, errorCode: null});
  }
  const configuredTimeout = Number.isInteger(probe.timeoutMs) ? probe.timeoutMs : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(configuredTimeout, Number.isFinite(budgetMs) ? budgetMs : configuredTimeout);
  if (timeoutMs <= 0) {
    return Promise.resolve({...probe, state: 'timeout', reachable: false, latencyMs: 0, errorCode: 'ETIMEDOUT'});
  }
  const started = Date.now();
  return new Promise(resolve => {
    let settled = false;
    let socket;
    const finish = (result, destroy) => {
      if (settled) return;
      settled = true;
      if (destroy && socket) socket.destroy();
      resolve({...probe, ...result});
    };
    try {
      socket = net.createConnection({host: probe.address, port: probe.port});
    } catch (error) {
      finish({state: 'unreachable', reachable: false,
        latencyMs: Math.max(0, Date.now() - started), errorCode: safeErrorCode(error && error.code)}, false);
      return;
    }
    socket.setTimeout(timeoutMs, () => finish({
      state: 'timeout', reachable: false, latencyMs: Math.max(0, Date.now() - started), errorCode: 'ETIMEDOUT'
    }, true));
    socket.once('connect', () => finish({
      state: 'reachable', reachable: true, latencyMs: Math.max(0, Date.now() - started), errorCode: null
    }, true));
    socket.once('error', error => finish({
      state: classifyError(error), reachable: false,
      latencyMs: Math.max(0, Date.now() - started), errorCode: safeErrorCode(error && error.code)
    }, true));
  });
}

async function mapLimited(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return output;
}

function summarize(results) {
  const reachableCount = results.filter(item => item.state === 'reachable').length;
  const disabledCount = results.filter(item => item.state === 'disabled').length;
  const invalidCount = results.filter(item => item.state === 'invalid').length;
  return {
    available: true,
    configured: true,
    configuredCount: results.length,
    reachableCount,
    failedCount: results.length - reachableCount - disabledCount,
    disabledCount,
    invalidCount,
    results,
    errorCode: null
  };
}

async function collect(file = process.env.ZT_ENDPOINT_PROBES_FILE || DEFAULT_FILE) {
  let document;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return unavailable('INVALID_CONFIG', true);
    const content = await fs.promises.readFile(file, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return unavailable('INVALID_CONFIG', true);
    document = JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') return unavailable(null, false);
    return unavailable('INVALID_CONFIG', true);
  }
  const config = normalizeConfig(document);
  if (!config.valid) return unavailable(config.errorCode, true);
  const deadline = Date.now() + MAX_COLLECTION_MS;
  const results = await mapLimited(config.probes, MAX_CONCURRENCY, async probe => {
    if (probe.state === 'invalid') return probe;
    return probeEndpoint(probe, deadline - Date.now());
  });
  return summarize(results);
}

module.exports = {
  DEFAULT_FILE,
  MAX_PROBES,
  MAX_CONCURRENCY,
  MAX_COLLECTION_MS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  normalizeConfig,
  probeEndpoint,
  collect
};
