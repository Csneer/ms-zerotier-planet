'use strict';

// Build network-level communication summaries from the observations already
// collected by monitoringController. This intentionally does not claim that a
// member's path to this server is the path between two arbitrary members.

function emptyNetwork(network) {
  return {
    nwid: network && network.nwid ? String(network.nwid) : '',
    name: network && network.name ? String(network.name) : '',
    mtu: Number.isFinite(Number(network && network.mtu)) ? Number(network.mtu) : null,
    memberCount: 0,
    authorizedCount: 0,
    planetObservedCount: 0,
    planetUnknownCount: 0,
    planetReachableCount: 0,
    probeDirectCount: 0,
    probeRelayCount: 0,
    probeUnknownCount: 0,
    bridgeCount: 0,
    oldVersionCount: 0,
    planetCoveragePercent: null,
    directPercent: null,
    relayPercent: null,
    state: 'empty'
  };
}

function percent(value, total) {
  return total > 0 ? Math.round((value * 1000) / total) / 10 : null;
}

function buildNetworkStats(networks, members, probeAvailable) {
  const byId = new Map();
  for (const network of Array.isArray(networks) ? networks : []) {
    const item = emptyNetwork(network);
    if (item.nwid) byId.set(item.nwid.toLowerCase(), item);
  }

  for (const member of Array.isArray(members) ? members : []) {
    const memberships = Array.isArray(member && member.networks) ? member.networks : [];
    for (const membership of memberships) {
      const item = byId.get(String(membership && membership.nwid || '').toLowerCase());
      if (!item) continue;
      item.memberCount += 1;
      if (membership.authorized === true) item.authorizedCount += 1;
      if (membership.activeBridge === true) item.bridgeCount += 1;
      if (member && member.versionBehind === true) item.oldVersionCount += 1;
      const planet = member && member.planet;
      // A controller/root normally does not have a peer entry for every
      // managed endpoint. Treat that as unknown rather than as unreachable.
      const planetObserved = Boolean(planet && planet.observed === true);
      if (planetObserved) {
        item.planetObservedCount += 1;
        if (planet.reachable === true) item.planetReachableCount += 1;
      } else {
        item.planetUnknownCount += 1;
      }
      const state = member && member.probe ? member.probe.state : 'unknown';
      if (!probeAvailable || state === 'unavailable' || state === 'unknown' || state === 'self') {
        item.probeUnknownCount += 1;
      } else if (state === 'direct') {
        item.probeDirectCount += 1;
      } else if (state === 'relay' || state === 'tcp_relay') {
        item.probeRelayCount += 1;
      } else {
        item.probeUnknownCount += 1;
      }
    }
  }

  for (const item of byId.values()) {
    item.planetCoveragePercent = percent(item.planetReachableCount, item.planetObservedCount);
    const probeObserved = item.probeDirectCount + item.probeRelayCount;
    item.directPercent = probeAvailable ? percent(item.probeDirectCount, probeObserved) : null;
    item.relayPercent = probeAvailable ? percent(item.probeRelayCount, probeObserved) : null;
    if (!item.memberCount) item.state = 'empty';
    else if (!item.planetObservedCount) item.state = 'unknown';
    else if (!item.planetReachableCount && !item.planetUnknownCount) item.state = 'offline';
    else if (item.planetUnknownCount) item.state = 'partial';
    else if (item.planetReachableCount < item.planetObservedCount) item.state = 'degraded';
    else item.state = 'healthy';
  }
  return [...byId.values()];
}

function buildCommunicationSummary(networkStats, probeAvailable) {
  const summary = {
    networkCount: Array.isArray(networkStats) ? networkStats.length : 0,
    memberCount: 0,
    authorizedCount: 0,
    planetObservedCount: 0,
    planetUnknownCount: 0,
    planetReachableCount: 0,
    probeDirectCount: 0,
    probeRelayCount: 0,
    probeUnknownCount: 0,
    bridgeCount: 0,
    oldVersionCount: 0,
    planetCoveragePercent: null,
    directPercent: null,
    relayPercent: null,
    probeAvailable: probeAvailable === true
  };
  for (const item of Array.isArray(networkStats) ? networkStats : []) {
    summary.memberCount += item.memberCount;
    summary.authorizedCount += item.authorizedCount;
    summary.planetObservedCount += item.planetObservedCount;
    summary.planetUnknownCount += item.planetUnknownCount;
    summary.planetReachableCount += item.planetReachableCount;
    summary.probeDirectCount += item.probeDirectCount;
    summary.probeRelayCount += item.probeRelayCount;
    summary.probeUnknownCount += item.probeUnknownCount;
    summary.bridgeCount += item.bridgeCount;
    summary.oldVersionCount += item.oldVersionCount;
  }
  summary.planetCoveragePercent = percent(summary.planetReachableCount, summary.planetObservedCount);
  const observed = summary.probeDirectCount + summary.probeRelayCount;
  summary.directPercent = probeAvailable === true ? percent(summary.probeDirectCount, observed) : null;
  summary.relayPercent = probeAvailable === true ? percent(summary.probeRelayCount, observed) : null;
  return summary;
}

module.exports = {buildNetworkStats, buildCommunicationSummary};
