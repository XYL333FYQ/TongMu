"""Exercise the production Bash script against isolated Git repos and fake Docker/HTTP."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from image_identity import image_identity

SCRIPT = Path(__file__).with_name('prebuilt-image.sh').resolve()


class PrebuiltDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='tongmu-deploy-test-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.root = self.directory / 'TongMu'
        origin = self.directory / 'origin.git'
        self.git('init', '--bare', '--initial-branch=main', str(origin))
        self.git('clone', str(origin), str(self.root))
        self.git('-C', str(self.root), 'config', 'user.name', 'Deployment Test')
        self.git('-C', str(self.root), 'config', 'user.email', 'test@example.invalid')
        (self.root / 'docker-compose.yml').write_text('services: {}\n')
        (self.root / 'docker-compose.deploy.yml').write_text('services: {}\n')
        self.git('-C', str(self.root), 'add', '.')
        self.git('-C', str(self.root), 'commit', '-m', 'fixture')
        self.git('-C', str(self.root), 'push', 'origin', 'main')
        self.sha = self.git('-C', str(self.root), 'rev-parse', 'HEAD').strip()
        self.identifier = self.sha + '-1-1'
        self.staging = Path(str(self.root) + '.deploy') / self.identifier
        self.calls = self.directory / 'docker-calls.jsonl'
        bin_directory = self.directory / 'bin'
        bin_directory.mkdir()
        self.executable(bin_directory / 'docker', '''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
with open(os.environ['FAKE_CALLS'], 'a') as f: f.write(json.dumps(a) + '\\n')
if a[0] == 'info': print(os.environ['FAKE_DOCKER_ROOT'])
elif a[:2] == ['image', 'inspect']:
    if len(a) == 3:
        print(json.dumps([{'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Env': ['TONGMU_BUILD_SHA=' + os.environ['FAKE_IMAGE_SHA']]}, 'RootFS': {'Layers': ['sha256:' + os.environ.get('FAKE_LAYER', 'c' * 64)]}}]))
    elif '.Config.Env' in a[3]: print('TONGMU_BUILD_SHA=' + os.environ['FAKE_IMAGE_SHA'])
    else: print('sha256:' + os.environ.get('FAKE_IMAGE_ID', 'a' * 64))
elif a[0] == 'load': pass
elif a[0] == 'compose' and a[5] in ('config', 'up', 'ps'): pass
else: sys.exit(42)
''')
        self.executable(bin_directory / 'curl', '''#!/usr/bin/env python3
import json, os
print(json.dumps({'status': 'ok', 'commitSha': os.environ['FAKE_HEALTH_SHA']}))
''')
        self.executable(bin_directory / 'df', '''#!/usr/bin/env python3
import os
print('Avail')
print(os.environ.get('FAKE_FREE_BYTES', '9000000000'))
''')
        self.executable(bin_directory / 'sleep', '#!/bin/sh\nexit 0\n')
        self.env = dict(os.environ, PATH=str(bin_directory) + ':' + os.environ['PATH'],
                        TONGMU_DEPLOY_ROOT=str(self.root), FAKE_CALLS=str(self.calls),
                        FAKE_DOCKER_ROOT=str(self.directory), FAKE_IMAGE_SHA=self.sha,
                        FAKE_HEALTH_SHA=self.sha)

    def git(self, *args):
        return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout

    def executable(self, filename, source):
        filename.write_text(source)
        filename.chmod(0o700)

    def run_phase(self, phase, sha=None):
        sha = sha or self.sha
        result = subprocess.run(['bash', str(SCRIPT), phase, sha, sha + '-1-1', '100', '200'],
                                env=self.env, capture_output=True, text=True, timeout=15)
        return result

    def prepare_payload(self):
        result = self.run_phase('prepare')
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = b'isolated test image archive'
        (self.staging / 'image.tar.gz').write_bytes(payload)
        (self.staging / 'image.sha256').write_text(hashlib.sha256(payload).hexdigest() + '  image.tar.gz\n')
        (self.staging / 'image-id.txt').write_text('sha256:' + 'a' * 64 + '\n')
        metadata = {'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Env': ['TONGMU_BUILD_SHA=' + self.sha]}, 'RootFS': {'Layers': ['sha256:' + 'c' * 64]}}
        (self.staging / 'image-content.sha256').write_text(image_identity(metadata) + '\n')
        (self.staging / 'image_identity.py').write_bytes(SCRIPT.with_name('image_identity.py').read_bytes())

    def docker_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_success_imports_verified_image_without_building(self):
        self.prepare_payload()
        result = self.run_phase('deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.docker_calls()
        self.assertTrue(any(call[0] == 'load' for call in calls))
        start = next(call for call in calls if 'up' in call)
        self.assertIn('--no-build', start)
        self.assertEqual(start[start.index('--pull') + 1], 'never')
        self.assertFalse(self.staging.exists())

    def test_stale_commit_and_dirty_checkout_never_import_an_image(self):
        self.assertNotEqual(self.run_phase('prepare', 'b' * 40).returncode, 0)
        (self.root / 'local-change.txt').write_text('keep this change')
        self.assertNotEqual(self.run_phase('prepare').returncode, 0)
        self.assertEqual(self.docker_calls(), [])
        self.assertEqual((self.root / 'local-change.txt').read_text(), 'keep this change')

    def test_low_disk_space_does_not_create_staging(self):
        self.env['FAKE_FREE_BYTES'] = '100'
        self.assertNotEqual(self.run_phase('prepare').returncode, 0)
        self.assertFalse(self.staging.exists())

    def test_corrupt_transfer_is_rejected_before_docker_load(self):
        self.prepare_payload()
        (self.staging / 'image.tar.gz').write_bytes(b'corrupted')
        self.assertNotEqual(self.run_phase('deploy').returncode, 0)
        self.assertFalse(any(call[0] == 'load' for call in self.docker_calls()))
        self.assertFalse(self.staging.exists())

    def test_wrong_filesystem_or_build_identity_never_restarts_application(self):
        for variable in ('FAKE_LAYER', 'FAKE_IMAGE_SHA'):
            with self.subTest(variable=variable):
                self.prepare_payload()
                self.env[variable] = 'b' * (64 if variable == 'FAKE_LAYER' else 40)
                self.assertNotEqual(self.run_phase('deploy').returncode, 0)
                self.assertFalse(any('up' in call for call in self.docker_calls()))
                del self.env[variable]
                if variable == 'FAKE_IMAGE_SHA': self.env[variable] = self.sha

    def test_different_store_ids_with_identical_content_are_accepted(self):
        self.prepare_payload()
        self.env['FAKE_IMAGE_ID'] = 'b' * 64
        result = self.run_phase('deploy')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('checking portable content identity', result.stdout)

    def test_portable_identity_protects_startup_configuration(self):
        from copy import deepcopy
        original = {'Os': 'linux', 'Architecture': 'amd64', 'Config': {'Env': ['A=1'], 'Cmd': ['node', 'index.js']}, 'RootFS': {'Layers': ['sha256:' + 'c' * 64]}}
        copied = deepcopy(original)
        copied['Id'] = 'different store id'
        copied['Config']['Hostname'] = 'deprecated engine metadata'
        self.assertEqual(image_identity(original), image_identity(copied))
        copied['Config']['Cmd'] = ['different executable']
        self.assertNotEqual(image_identity(original), image_identity(copied))

    def test_old_healthy_version_is_not_accepted_as_success(self):
        self.prepare_payload()
        self.env['FAKE_HEALTH_SHA'] = 'b' * 40
        result = self.run_phase('deploy')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('deployment verified', result.stdout)
        self.assertFalse(any('down' in call or 'prune' in call for call in self.docker_calls()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
