(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.networkValidation = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function ipv4(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) return null;
    var octets = value.split('.').map(Number);
    if (octets.some(function(n) { return n > 255; })) return null;
    return octets.reduce(function(n, octet) { return n * 256 + octet; }, 0);
  }
  function cidr(value) {
    if (typeof value !== 'string') return null;
    var parts = value.split('/');
    if (parts.length !== 2 || !/^(?:[1-9]|[12][0-9]|30)$/.test(parts[1])) return null;
    var address = ipv4(parts[0]);
    if (address === null) return null;
    var size = Math.pow(2, 32 - Number(parts[1]));
    var network = Math.floor(address / size) * size;
    return {network: network, prefix: Number(parts[1]), first: network + 1, last: network + size - 2};
  }
  function validate(body) {
    body = body || {};
    var range = cidr(body.networkCIDR);
    if (!range) return 'network.invalid_cidr';
    var start = ipv4(body.poolStart), end = ipv4(body.poolEnd);
    if (start === null || end === null || start > end || start < range.first || end > range.last) return 'network.invalid_pool';
    return null;
  }
  return {ipv4: ipv4, cidr: cidr, validate: validate};
});
