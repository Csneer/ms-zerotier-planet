'use strict';

const fs = require('fs');
const {isIP} = require('net');
const SNAPSHOT_PATH = '/app/config/host-network-diagnostics.json';
const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 180000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const unknown = state => ({state, collectedAt: null, policy: null, allowedRoots: [], unmatchedPeers: [], restartRisk: false});
const canonicalIP = ip => {
  if (isIP(ip) !== 6) return ip;
  const [address, zone] = ip.split('%');
  return new URL(`http://[${address}]/`).hostname + (zone ? `%${zone}` : '');
};
function canonicalEndpoint(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^([^/]+)\/([0-9]{1,5})$/);
  if (!match || !isIP(match[1]) || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  return `${canonicalIP(match[1])}/${Number(match[2])}`;
}

function build(snapshot, topology, now = Date.now()) {
  if (!object(snapshot) || snapshot.schema !== 1 || snapshot.scope !== 'known-root-drain' ||
      !Number.isSafeInteger(snapshot.collectedAt) || snapshot.collectedAt <= 0 ||
      !object(snapshot.collectors) || !object(snapshot.policy)) return unknown('unknown');
  const p = snapshot.policy;
  const fields = ['present', 'active', 'inputRestricted', 'outputRestricted', 'reviewRequired', 'serviceActive', 'serviceEnabled'];
  const auditedPort = p.auditedPort;
  if (fields.some(key => typeof p[key] !== 'boolean') ||
      ['ipv4', 'ipv6', 'service'].some(key => !['ok', 'unavailable'].includes(snapshot.collectors[key])) ||
      !Number.isSafeInteger(auditedPort) || auditedPort < 1 || auditedPort > 65535 ||
      !Array.isArray(p.allowedPeers) || p.allowedPeers.length > 1024 ||
      p.allowedPeers.some(ip => typeof ip !== 'string' || !isIP(ip))) return unknown('unknown');
  if (!Array.isArray(p.allowedEndpoints) || p.allowedEndpoints.length > 1024 ||
      p.allowedEndpoints.some(value => {
        if (typeof value !== 'string') return true;
        const split = value.lastIndexOf('/');
        return split <= 0 || isIP(value.slice(0, split)) === 0 || value.slice(split + 1) !== String(auditedPort);
      })) return unknown('unknown');
  if (snapshot.collectedAt > now) return unknown('unknown');
  if (now - snapshot.collectedAt > MAX_AGE_MS) return {...unknown('stale'), collectedAt: snapshot.collectedAt};
  const policy = Object.fromEntries(fields.map(key => [key, p[key]]));
  policy.allowedPeers = [...new Set(p.allowedPeers)];
  policy.allowedEndpoints = [...new Set(p.allowedEndpoints)];
  policy.auditedPort = auditedPort;
  const roots = topology && Array.isArray(topology.roots) ? topology.roots : [];
  const allowedEndpoints = new Set(policy.allowedEndpoints.map(canonicalEndpoint));
  const peerIPs = new Set(policy.allowedPeers.map(canonicalIP));
  const endpointIPs = new Set(policy.allowedEndpoints.map(endpoint => canonicalIP(endpoint.split('/')[0])));
  const consistentPeers = peerIPs.size === endpointIPs.size && [...peerIPs].every(ip => endpointIPs.has(ip));
  const endpointMatches = endpoint => allowedEndpoints.has(canonicalEndpoint(endpoint));
  const allowedRoots = roots.filter(root => root.endpoints.some(endpointMatches))
    .map(root => {
      const expected = root.endpoints.filter(endpointMatches);
      const responding = !root.local && root.service.state === 'reachable' && expected.some(endpoint => canonicalEndpoint(endpoint) === canonicalEndpoint(root.service.path));
      return {id: root.id, local: root.local, responding};
    });
  const unmatchedPeers = policy.allowedEndpoints.filter(endpoint => !roots.some(root => root.endpoints.some(value => canonicalEndpoint(value) === canonicalEndpoint(endpoint))));
  const pathMismatch = roots.some(root => !root.local && root.service.state === 'reachable' &&
    (!endpointMatches(root.service.path) || !root.endpoints.some(endpoint => canonicalEndpoint(endpoint) === canonicalEndpoint(root.service.path))));
  const respondingCount = allowedRoots.filter(root => root.responding).length;
  let state = 'absent';
  if (!consistentPeers || Object.values(snapshot.collectors).some(value => value !== 'ok') || p.reviewRequired ||
      (p.active && !p.present) || ((p.inputRestricted || p.outputRestricted) && !p.active)) state = 'unknown';
  else if (p.active) {
    if (!topology || !topology.available || unmatchedPeers.length || pathMismatch || !p.inputRestricted || !p.outputRestricted) state = 'review';
    else if (!respondingCount) state = 'restricted_no_response';
    else if (respondingCount === 1) state = 'single_path';
    else state = 'restricted';
  } else if (p.present || p.serviceActive) state = 'inactive';
  return {state, collectedAt: snapshot.collectedAt, policy, allowedRoots, unmatchedPeers,
    restartRisk: p.serviceEnabled && !p.active};
}

async function collect(topology, path = SNAPSHOT_PATH, now = Date.now()) {
  let handle;
  try {
    // Reject symlinks and special files before opening; nonblocking + nofollow
    // also protects against replacement with a FIFO or symlink between checks.
    if (!(await fs.promises.lstat(path)).isFile()) return unknown('unknown');
    handle = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return unknown('unknown');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > MAX_BYTES) return unknown('unknown');
    return build(JSON.parse(buffer.toString('utf8', 0, length)), topology, now);
  } catch (_) {
    return unknown('unknown');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = {build, collect};
