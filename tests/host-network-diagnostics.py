import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('host_diagnostics', Path(__file__).resolve().parents[1] / 'host-network-diagnostics.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)

RULES = '''*filter
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:ZT_ROOT_A_IN - [0:0]
:ZT_ROOT_A_OUT - [0:0]
-A INPUT -m comment --comment zt-root-a-prefer-b -j ZT_ROOT_A_IN
-A OUTPUT -m comment --comment zt-root-a-prefer-b -j ZT_ROOT_A_OUT
-A ZT_ROOT_A_IN -s 198.51.100.99/32 -p udp --sport 9994 -m multiport --dports 9994,40189 -m u32 --u32 "0x0>>0x16&0x3c@0x10=0xa0e6a05e&&0x0>>0x16&0x3c@0x14>>0x18=0xfa" -j RETURN
-A ZT_ROOT_A_IN -p udp -m multiport --dports 9994,40189 -j DROP
-A ZT_ROOT_A_IN -j RETURN
-A ZT_ROOT_A_OUT -d 198.51.100.99/32 -p udp --dport 9994 -m multiport --sports 9994,40189 -j RETURN
-A ZT_ROOT_A_OUT -p udp -m multiport --sports 9994,40189 -j DROP
-A ZT_ROOT_A_OUT -j RETURN
COMMIT
'''
IPV6 = '\n'.join(line for line in RULES.splitlines() if '198.51.100.99' not in line)
INACTIVE = 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n'


class HostDiagnosticsTests(unittest.TestCase):
    def test_real_drain_policy_retains_only_allowed_peer(self):
        result = diagnostics.parse_rules(RULES, 9994)
        self.assertTrue(result['active'])
        self.assertTrue(result['inputRestricted'])
        self.assertTrue(result['outputRestricted'])
        self.assertEqual(result['allowedPeers'], ['198.51.100.99'])
        self.assertFalse(result['reviewRequired'])

    def test_unattached_chains_are_not_active(self):
        result = diagnostics.parse_rules('\n'.join(l for l in RULES.splitlines() if not l.startswith(('-A INPUT ', '-A OUTPUT '))), 9994)
        self.assertTrue(result['present'])
        self.assertFalse(result['active'])
        self.assertEqual(result['allowedPeers'], [])

    def test_drop_before_allow_never_claims_peer_allowed(self):
        lines = RULES.splitlines()
        incoming = next(l for l in lines if l.startswith('-A ZT_ROOT_A_IN -s'))
        lines.remove(incoming)
        lines.append(incoming)
        result = diagnostics.parse_rules('\n'.join(lines), 9994)
        self.assertEqual(result['allowedPeers'], [])

    def test_conditional_entry_requires_review(self):
        result = diagnostics.parse_rules(RULES.replace('-A INPUT -m', '-A INPUT -i eth0 -m'), 9994)
        self.assertTrue(result['reviewRequired'])

    def test_unknown_rule_is_not_assessed_as_safe(self):
        result = diagnostics.parse_rules(RULES.replace('-A ZT_ROOT_A_IN -s', '-A ZT_ROOT_A_IN -j ANOTHER_CHAIN\n-A ZT_ROOT_A_IN -s'), 9994)
        self.assertTrue(result['reviewRequired'])

    def test_wide_allowlist_requires_review(self):
        result = diagnostics.parse_rules(RULES.replace('198.51.100.99/32', '198.51.100.0/24'), 9994)
        self.assertTrue(result['reviewRequired'])

    def test_extra_conditions_and_negation_require_review(self):
        for rules in [RULES.replace('-j RETURN', '-o unexpected0 -j RETURN'),
                      RULES.replace('-j DROP', '-m length --length 0:1 -j DROP'),
                      RULES.replace('-s 198', '! -s 198'),
                      RULES.replace('--u32 "0x0', '--u32 "0x1'),
                      RULES.replace('-A INPUT -m', '-A INPUT ! -m')]:
            self.assertTrue(diagnostics.parse_rules(rules, 9994)['reviewRequired'])

    def test_partial_family_collection_is_unknown(self):
        def runner(args):
            return {'iptables-save': RULES, 'ip6tables-save': None, 'systemctl': INACTIVE}[args[0]]
        snapshot = diagnostics.collect(9994, runner)
        self.assertEqual(snapshot['collectors']['ipv6'], 'unavailable')
        self.assertEqual(snapshot['policy']['allowedPeers'], [])
        self.assertTrue(snapshot['policy']['reviewRequired'])
        self.assertFalse(snapshot['policy']['inputRestricted'])

    def test_both_families_and_service_are_collected(self):
        def runner(args):
            return {'iptables-save': RULES, 'ip6tables-save': IPV6, 'systemctl': 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n'}[args[0]]
        snapshot = diagnostics.collect(9994, runner)
        self.assertEqual(snapshot['collectors'], {'ipv4': 'ok', 'ipv6': 'ok', 'service': 'ok'})
        self.assertTrue(snapshot['policy']['serviceEnabled'])
        self.assertFalse(snapshot['policy']['reviewRequired'])
        self.assertEqual(snapshot['policy']['allowedEndpoints'], ['198.51.100.99/9994'])

    def test_one_family_requires_review_is_not_masked(self):
        def runner(args):
            return {'iptables-save': RULES.replace('-j RETURN', '-o unknown0 -j RETURN'),
                    'ip6tables-save': IPV6, 'systemctl': INACTIVE}[args[0]]
        self.assertTrue(diagnostics.collect(9994, runner)['policy']['reviewRequired'])

    def test_empty_collection_is_not_a_clear_firewall(self):
        snapshot = diagnostics.collect(9994, lambda args: '')
        self.assertTrue(all(value == 'unavailable' for value in snapshot['collectors'].values()))
        self.assertTrue(snapshot['policy']['reviewRequired'])

    def test_service_enabled_without_rules_stays_visible(self):
        def runner(args):
            return INACTIVE.replace('disabled', 'enabled') if args[0] == 'systemctl' else '*filter\nCOMMIT\n'
        snapshot = diagnostics.collect(9994, runner)
        self.assertTrue(snapshot['policy']['serviceEnabled'])
        self.assertFalse(snapshot['policy']['active'])

    def test_atomic_snapshot_refuses_symlinks_and_has_no_raw_rules(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / 'snapshot.json'
            snapshot = diagnostics.collect(9994, lambda args: INACTIVE if args[0] == 'systemctl' else RULES)
            diagnostics.write_atomic(path, json.dumps(snapshot))
            self.assertEqual(json.loads(path.read_text())['scope'], 'known-root-drain')
            self.assertNotIn('u32', path.read_text())
            link = root / 'link.json'
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                diagnostics.write_atomic(link, '{}')


if __name__ == '__main__':
    unittest.main()
