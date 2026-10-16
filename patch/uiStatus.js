'use strict';

function activePaths(peer) {
  if (!peer || !Array.isArray(peer.paths)) return [];
  return peer.paths.filter(path => path && path.active === true && path.expired !== true);
}

function preferredPath(peer) {
  const paths = activePaths(peer);
  return paths.find(path => path.preferred === true) || paths[0] || null;
}

function isPlanetReachable(peer) {
  return Boolean(peer) && peer.role === 'LEAF' && activePaths(peer).length > 0;
}

function probeLinkState(peer, probeAddress, memberId) {
  if (probeAddress && memberId && probeAddress.toLowerCase() === memberId.toLowerCase()) return 'self';
  if (!peer) return 'unknown';
  if (peer.tunneled === true) return 'tcp_relay';
  if (activePaths(peer).length === 0) return 'relay';
  return 'direct';
}

function lastActivityMs(peer, now) {
  const timestamps = activePaths(peer)
    .flatMap(path => [Number(path.lastReceive), Number(path.lastSend)])
    .filter(value => Number.isFinite(value) && value > 0);
  if (!timestamps.length) return null;
  return Math.max(0, Number(now) - Math.max(...timestamps));
}

function managedMemberIds(memberResponse) {
  const ids = new Set();
  if (Array.isArray(memberResponse)) {
    for (const item of memberResponse) {
      if (!item || typeof item !== 'object') continue;
      for (const id of Object.keys(item)) {
        if (/^[0-9a-f]{10}$/i.test(id)) ids.add(id.toLowerCase());
      }
    }
  } else if (memberResponse && typeof memberResponse === 'object') {
    for (const id of Object.keys(memberResponse)) {
      if (/^[0-9a-f]{10}$/i.test(id)) ids.add(id.toLowerCase());
    }
  }
  return ids;
}

function versionParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

module.exports = {
  activePaths,
  preferredPath,
  isPlanetReachable,
  probeLinkState,
  lastActivityMs,
  managedMemberIds,
  compareVersions
};
