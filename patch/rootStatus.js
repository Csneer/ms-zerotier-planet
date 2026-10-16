'use strict';

const {isIP} = require('net');
const statusTools = require('./uiStatus');
const RECENT_RECEIVE_MS = 90000;
// Status and peer requests are sampled separately, even on the same node.
const SAMPLE_SKEW_MS = 1000;

function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
  const result = Number(value);
  return Number.isFinite(result) ? result : NaN;
}

function timestamp(value) {
  const result = numeric(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function nodeId(value) {
  return typeof value === 'string' && /^[0-9a-f]{10}$/i.test(value) ? value.toLowerCase() : null;
}

function endpoint(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^([^/]+)\/([0-9]{1,5})$/);
  return Boolean(match && isIP(match[1]) && Number(match[2]) > 0 && Number(match[2]) <= 65535);
}

function peerMap(peers) {
  return new Map((Array.isArray(peers) ? peers : [])
    .filter(peer => peer && nodeId(peer.address))
    .map(peer => [nodeId(peer.address), peer]));
}

function observation(peer, now) {
  now = timestamp(now) || Date.now();
  const paths = peer && Array.isArray(peer.paths) ? peer.paths.filter(p => p && endpoint(p.address)) : [];
  const receiveTime = path => {
    const value = timestamp(path.lastReceive);
    return value && value <= now + SAMPLE_SKEW_MS ? value : null;
  };
  const received = paths.map(receiveTime).filter(t => t !== null);
  const age = received.length ? Math.max(0, now - Math.max(...received)) : null;
  const active = statusTools.activePaths({paths});
  const recent = active.filter(p => receiveTime(p) !== null && now - receiveTime(p) <= RECENT_RECEIVE_MS);
  const path = statusTools.preferredPath({paths: recent.length ? recent : active});
  const state = peer && peer.role !== 'PLANET' ? 'unrecognized' : recent.length ? 'reachable' : received.length ? 'stale' : 'unseen';
  const latency = peer ? numeric(peer.latency) : NaN;
  return {
    state,
    lastReceiveMs: age,
    latency: state === 'reachable' && latency >= 0 ? latency : null,
    // -1 is ZeroTier's normal "no latency sample" sentinel.
    latencyAnomaly: Number.isFinite(latency) && latency < 0 && latency !== -1,
    path: path ? path.address : null
  };
}

function isReachable(observation) {
  return Boolean(observation) &&
    (observation.state === 'reachable' || observation.state === 'local');
}

function rootEvidence(root) {
  if (root.local) return 'local';
  const service = isReachable(root.service);
  const probe = isReachable(root.probe);
  if (service && probe) return 'both';
  if (service) return 'server';
  if (probe) return 'probe';
  return 'none';
}

function failoverSummary(roots, worldMatch) {
  const remoteRoots = roots.filter(root => !root.local);
  const readyRoots = roots.filter(root => root.ready);
  const remoteReadyRoots = remoteRoots.filter(root => root.ready);
  let state = 'unknown';
  if (roots.length === 0) state = 'unknown';
  else if (roots.length === 1) state = 'single_root';
  else if (!remoteReadyRoots.length) state = 'no_remote';
  else if (worldMatch === false) state = 'world_mismatch';
  else if (worldMatch === null) state = 'world_unknown';
  else state = 'ready';
  return {
    state,
    ready: state === 'ready',
    declaredRootCount: roots.length,
    remoteRootCount: remoteRoots.length,
    readyRootCount: readyRoots.length,
    remoteReadyCount: remoteReadyRoots.length,
    readyRootIds: readyRoots.map(root => root.id),
    remoteReadyRootIds: remoteReadyRoots.map(root => root.id),
    unreadyRootIds: roots.filter(root => !root.ready).map(root => root.id),
    worldMatch
  };
}

function build(metadata, service, peers, probe, env = process.env) {
  service = service || {};
  probe = probe || {available: false, peers: []};
  env = env || {};
  const ids = new Set();
  const available = Boolean(metadata && Array.isArray(metadata.roots) && metadata.roots.length &&
    metadata.roots.every(root => {
      if (!root || typeof root.identity !== 'string' || !/^[0-9a-f]{10}:0:[0-9a-f]+$/i.test(root.identity) ||
        !Array.isArray(root.stableEndpoints) || !root.stableEndpoints.length || !root.stableEndpoints.every(endpoint)) return false;
      const id = root.identity.split(':')[0].toLowerCase();
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    }));
  const now = timestamp(service.clock) || Date.now();
  const byId = peerMap(peers);
  const probeById = peerMap(probe.peers);
  const probeNow = probe.status && timestamp(probe.status.clock);
  const probeAvailable = probe.available === true && Boolean(probeNow) && Array.isArray(probe.peers);
  const roots = available ? metadata.roots.map(root => {
    const id = root.identity.split(':')[0].toLowerCase();
    const local = id === nodeId(service.address);
    const serviceObservation = local ? {state: 'local', lastReceiveMs: 0, latency: null, latencyAnomaly: false, path: null} : observation(byId.get(id), now);
    const probeObservation = probeAvailable ? observation(probeById.get(id), probeNow) :
      {state: 'unavailable', lastReceiveMs: null, latency: null, latencyAnomaly: false, path: null};
    const result = {id, local, endpoints: root.stableEndpoints.slice(),
      service: serviceObservation, probe: probeObservation};
    result.evidence = rootEvidence(result);
    result.ready = result.evidence !== 'none';
    return result;
  }) : [];
  const runtimeWorldId = timestamp(service.planetWorldId);
  const runtimeTimestamp = timestamp(service.planetWorldTimestamp);
  const worldId = available ? timestamp(metadata.id) : null;
  const worldTimestamp = available ? timestamp(metadata.timestamp) : null;
  const worldMatch = available && runtimeWorldId !== null && runtimeTimestamp !== null &&
    worldId !== null && worldTimestamp !== null
    ? runtimeWorldId === worldId && runtimeTimestamp === worldTimestamp
    : null;
  const negativeLatencyRoots = roots.filter(root => root.service.latencyAnomaly || root.probe.latencyAnomaly)
    .map(root => root.id);
  return {available, roots, worldId,
    timestamp: worldTimestamp,
    runtimeWorldId,
    runtimeTimestamp,
    mode: env.PLANET_MODE === 'external' ? 'external' : 'generated',
    role: env.CONTROLLER_ONLY === '1' ? 'controller_only' : env.ROOT_ONLY === '1' ? 'root_only' : 'controller_root',
    controllerId: env.ROOT_ONLY === '1' ? null : nodeId(service.address),
    recentReceiveSeconds: RECENT_RECEIVE_MS / 1000,
    reachableCount: roots.filter(root => root.local || root.service.state === 'reachable').length,
    probeReachableCount: roots.filter(root => root.probe.state === 'reachable').length,
    failover: failoverSummary(roots, worldMatch),
    warnings: {negativeLatencyRoots, negativeLatencyCount: negativeLatencyRoots.length}};
}

module.exports = {build, observation, failoverSummary, rootEvidence};
