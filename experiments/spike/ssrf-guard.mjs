// SSRF-safe dispatcher for the gateway's upstream fetches (E15). Validates the address actually dialled:
//  - IP literals are checked in the connector (undici never calls `lookup` for literals: round-5 finding);
//  - hostnames are resolved inside the connector and every answer is checked (defeats DNS rebinding, because
//    the checked address is the one we connect to);
//  - `allowHosts` lets admin-approved in-cluster names (e.g. woo-mcp.store.svc.cluster.local) resolve privately.
import { Agent, buildConnector } from 'undici';
import net from 'node:net';
import dns from 'node:dns';

const block = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) block.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32] /* Teredo */,
  ['2001:db8::', 32], ['2002::', 16] /* 6to4 */, ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) block.addSubnet(a, p, 'ipv6');

function embeddedV4(ip6) {
  const s = ip6.toLowerCase();
  let m = s.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.match(/^::(\d+\.\d+\.\d+\.\d+)$/); if (m) return m[1];
  m = s.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) { const x = parseInt(m[1], 16), y = parseInt(m[2], 16); return `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`; }
  return null;
}
export function isBlocked(ip) {
  const fam = net.isIP(ip); if (!fam) return true;
  if (fam === 4) return block.check(ip, 'ipv4');
  const v4 = embeddedV4(ip); if (v4) return block.check(v4, 'ipv4');
  return block.check(ip, 'ipv6');
}
const ssrfError = (msg) => Object.assign(new Error(`SSRF guard: ${msg}`), { code: 'ESSRF' });

export function createGuardedAgent({ allowHosts = [], timeout = 5000 } = {}) {
  const allow = new Set(allowHosts.map(h => h.toLowerCase().replace(/\.$/, '')));
  const checkedLookup = (hostname, opts, cb) => {
    dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find(a => isBlocked(a.address));
      if (bad) return cb(ssrfError(`${hostname} resolves to blocked ${bad.address}`));
      opts.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
    });
  };
  const guarded = buildConnector({ lookup: checkedLookup, timeout });
  const trusted = buildConnector({ timeout });
  return new Agent({
    connect: (opts, cb) => {
      const host = String(opts.hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
      if (!host) return cb(ssrfError('empty host'), null);
      if (allow.has(host.replace(/\.$/, ''))) return trusted(opts, cb);
      if (net.isIP(host)) return isBlocked(host) ? cb(ssrfError(`literal ${host} blocked`), null) : guarded(opts, cb);
      return guarded(opts, cb);
    },
  });
}
