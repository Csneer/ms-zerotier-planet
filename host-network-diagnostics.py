#!/usr/bin/env python3
"""Publish a bounded, read-only audit of the known host Root drain policy.

This is not a general firewall evaluator. The Web process only reads the public
snapshot; it never receives permission to inspect or change the host firewall.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time

MARKER = '# Managed by ms-zerotier-planet host diagnostics'
SERVICE = 'ms-zerotier-host-diagnostics.service'
TIMER = 'ms-zerotier-host-diagnostics.timer'
CHAINS = {'INPUT': 'ZT_ROOT_A_IN', 'OUTPUT': 'ZT_ROOT_A_OUT'}


def command(args):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                universal_newlines=True, timeout=5)
        return result.stdout if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def option(tokens, name, default=None):
    try:
        return tokens[tokens.index(name) + 1]
    except (ValueError, IndexError):
        return default


def recognized_rule(tokens, flags, modules):
    """Accept only key/value syntax understood by this bounded collector."""
    seen = set()
    index = 2
    while index < len(tokens):
        key = tokens[index]
        if key not in flags or index + 1 >= len(tokens) or (key != '-m' and key in seen):
            return False
        value = tokens[index + 1]
        if value == '!' or (key == '-m' and value not in modules):
            return False
        seen.add(key)
        index += 2
    return True


def parse_rules(content, port):
    result = {'present': False, 'active': False, 'inputRestricted': False,
              'outputRestricted': False, 'allowedPeers': [], 'reviewRequired': False}
    rules = []
    for line in content.splitlines():
        if any(line.startswith(':' + name + ' ') for name in CHAINS.values()):
            result['present'] = True
        if not line.startswith('-A '):
            continue
        try:
            tokens = shlex.split(line)
        except ValueError:
            result['reviewRequired'] = True
            continue
        if len(tokens) < 4:
            result['reviewRequired'] = True
            continue
        rules.append(tokens)
        if tokens[1] in CHAINS.values() or option(tokens, '-j') in CHAINS.values():
            result['present'] = True
    allowed = []
    for parent, chain in CHAINS.items():
        jumps = [r for r in rules if r[1] == parent and option(r, '-j') == chain]
        if not jumps:
            continue
        result['active'] = True
        # Conditional jumps or multiple entry points require operator review.
        if len(jumps) != 1 or not recognized_rule(jumps[0], {'-j', '-m', '--comment'}, {'comment'}):
            result['reviewRequired'] = True
        peers = set()
        restricted = False
        for rule in [r for r in rules if r[1] == chain]:
            # Only interpret the small rule language emitted by
            # zt-root-a-drain. An extra interface, match module, state test or
            # negation changes the meaning of a DROP/RETURN rule; fail closed
            # instead of calling the policy understood.
            allowed_flags = {
                '-s', '-d', '-p', '-m', '--sport', '--dport', '--sports', '--dports',
                '--comment', '--u32', '-j'
            }
            if not recognized_rule(rule, allowed_flags, {'comment', 'udp', 'multiport', 'u32'}):
                result['reviewRequired'] = True
                continue
            target = option(rule, '-j')
            if target not in ('RETURN', 'DROP', 'REJECT'):
                result['reviewRequired'] = True
                continue
            protocol = option(rule, '-p')
            if protocol not in ('udp', '17', None):
                continue
            direction = '--dports' if parent == 'INPUT' else '--sports'
            single = '--dport' if parent == 'INPUT' else '--sport'
            ports = option(rule, direction, option(rule, single))
            if ports is not None and str(port) not in ports.split(','):
                # Ranges and negation aren't evaluated as proof of safety.
                if ':' in ports or '!' in rule:
                    result['reviewRequired'] = True
                continue
            if target in ('DROP', 'REJECT'):
                restricted = True
                peer_port_flag = '--sport' if parent == 'INPUT' else '--dport'
                if any(x in rule for x in ['-s', '-d', '--u32', peer_port_flag]):
                    result['reviewRequired'] = True
                break
            address = option(rule, '-s' if parent == 'INPUT' else '-d')
            if address is None:
                # An unconditional RETURN before DROP means later rules do not apply.
                if len(rule) == 4:
                    break
                result['reviewRequired'] = True
                continue
            try:
                if ('-d' if parent == 'INPUT' else '-s') in rule:
                    raise ValueError('additional address restriction')
                selector = option(rule, '--u32')
                if selector is not None and (parent != 'INPUT' or not re.fullmatch(
                        r'0x0>>0x16&0x3c@0x10=0x[0-9a-f]{1,8}&&0x0>>0x16&0x3c@0x14>>0x18=0x[0-9a-f]{1,2}', selector.lower())):
                    raise ValueError('unrecognized packet selector')
                network = ipaddress.ip_network(address, strict=False)
                if network.prefixlen != network.max_prefixlen or '!' in rule:
                    raise ValueError('not one peer')
                peer_port = option(rule, '--sport' if parent == 'INPUT' else '--dport')
                if protocol not in ('udp', '17') or peer_port != str(port):
                    raise ValueError('unrecognized peer rule')
                peers.add(str(network.network_address))
            except ValueError:
                result['reviewRequired'] = True
        result['inputRestricted' if parent == 'INPUT' else 'outputRestricted'] = restricted
        if restricted:
            allowed.append(peers)
    if allowed:
        result['allowedPeers'] = sorted(set.intersection(*allowed))
    if result['active'] and not (result['inputRestricted'] and result['outputRestricted']):
        result['reviewRequired'] = True
    return result


def collect(port, runner=command):
    collectors = {}
    families = []
    for family, tool in [('ipv4', 'iptables-save'), ('ipv6', 'ip6tables-save')]:
        content = runner([tool, '-t', 'filter'])
        if content is not None and not ('*filter' in content.splitlines() and 'COMMIT' in content.splitlines()):
            content = None
        collectors[family] = 'ok' if content is not None else 'unavailable'
        families.append(parse_rules(content, port) if content is not None else None)
    service = runner(['systemctl', 'show', 'zt-root-a-drain.service',
                      '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState'])
    service_values = dict(line.split('=', 1) for line in (service or '').splitlines() if '=' in line)
    collectors['service'] = 'ok' if all(key in service_values for key in ['LoadState', 'ActiveState', 'UnitFileState']) else 'unavailable'
    known = [f for f in families if f is not None]
    complete = len(known) == 2 and all(value == 'ok' for value in collectors.values())
    policy = {key: any(f[key] for f in known) for key in ['present', 'active', 'reviewRequired']}
    for key in ['inputRestricted', 'outputRestricted']:
        policy[key] = complete and all(f[key] for f in known)
    # The family-specific lists must be united: an IPv4 endpoint cannot also
    # appear in IPv6 rules. Within each family INPUT/OUTPUT use intersection.
    policy['allowedPeers'] = sorted({peer for f in known for peer in f['allowedPeers']}) if complete else []
    # Keep endpoint matching explicit in the snapshot. The Web process must
    # never infer a permitted port from a World endpoint sharing the same IP.
    policy['allowedEndpoints'] = [peer + '/' + str(port) for peer in policy['allowedPeers']]
    policy['auditedPort'] = port
    policy['serviceActive'] = service_values.get('ActiveState') in ('active', 'activating', 'reloading')
    policy['serviceEnabled'] = service_values.get('UnitFileState') in ('enabled', 'enabled-runtime', 'linked', 'linked-runtime')
    if len(known) == 2 and known[0]['active'] != known[1]['active']:
        policy['reviewRequired'] = True
    if policy['serviceActive'] and not policy['active']:
        policy['reviewRequired'] = True
    if not complete:
        policy['reviewRequired'] = True
    return {'schema': 1, 'scope': 'known-root-drain', 'collectedAt': int(time.time() * 1000),
            'collectors': collectors, 'policy': policy}


def write_atomic(path, content, mode=0o644):
    parent = path.parent
    if parent.resolve() != parent.absolute() or not parent.is_dir() or path.is_symlink():
        raise ValueError('output must use an existing directory without symlinks')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=str(parent))
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
        os.chmod(temporary, mode)
        os.replace(temporary, str(path))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def systemd_quote(value):
    if '\n' in value or '\r' in value:
        raise ValueError('unit paths cannot contain newlines')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def install_timer(output, port):
    if os.geteuid() != 0:
        raise ValueError('--install-timer requires root')
    unit_dir = Path('/etc/systemd/system')
    for name in [SERVICE, TIMER]:
        path = unit_dir / name
        if path.is_symlink() or (path.exists() and not path.read_text().startswith(MARKER + '\n')):
            raise ValueError('refusing to replace an unmanaged unit: ' + name)
    executable = systemd_quote(sys.executable)
    script = systemd_quote(str(Path(__file__).resolve()))
    output_arg = systemd_quote(str(output))
    service = (MARKER + '\n[Unit]\nDescription=Read-only ZeroTier host Root policy diagnostics\n'
               '[Service]\nType=oneshot\nUMask=0022\nNoNewPrivileges=true\n'
               'ProtectSystem=strict\nReadWritePaths=' + systemd_quote(str(output.parent)) + '\n'
               'ExecStart=' + executable + ' ' + script + ' --output ' + output_arg + ' --port ' + str(port) + '\n')
    timer = (MARKER + '\n[Unit]\nDescription=Refresh ZeroTier host Root policy diagnostics\n'
             '[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nAccuracySec=5s\n'
             '[Install]\nWantedBy=timers.target\n')
    write_atomic(unit_dir / SERVICE, service)
    write_atomic(unit_dir / TIMER, timer)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
    subprocess.run(['systemctl', 'enable', '--now', TIMER], check=True, timeout=20)
    subprocess.run(['systemctl', 'start', SERVICE], check=True, timeout=20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--port', type=int, default=9994)
    parser.add_argument('--install-timer', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    output = args.output.absolute()
    snapshot = collect(args.port)
    write_atomic(output, json.dumps(snapshot, sort_keys=True, indent=2) + '\n')
    if args.install_timer:
        install_timer(output, args.port)
    print(json.dumps(snapshot, sort_keys=True))


if __name__ == '__main__':
    main()
