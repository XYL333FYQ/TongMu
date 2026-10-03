"""Prove production image retention is narrowly scoped to old release tags."""
import json
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("retained-release-images.py").resolve()
ACTIVE = "a" * 40


class RetainedReleaseImagesTest(unittest.TestCase):
    def run_script(self, images):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), ACTIVE], input=json.dumps(images),
            capture_output=True, text=True, check=True,
        )
        return result.stdout.splitlines()

    def test_keeps_active_and_newest_rollback_and_only_lists_old_tongmu_tags(self):
        images = [
            {"Created": "2026-10-03T14:00:00Z", "RepoTags": [f"tongmu-release:{ACTIVE}"]},
            {"Created": "2026-10-03T13:00:00Z", "RepoTags": [f"tongmu-release:{'b' * 40}"]},
            {"Created": "2026-10-02T13:00:00Z", "RepoTags": [f"tongmu-release:{'c' * 40}"]},
            {"Created": "2026-10-01T13:00:00Z", "RepoTags": ["other-application:old"]},
            {"Created": "2026-09-01T13:00:00Z", "RepoTags": ["<none>:<none>"]},
            {"Created": "not-a-date", "RepoTags": [f"tongmu-release:{'d' * 40}"]},
        ]
        self.assertEqual(self.run_script(images), [f"tongmu-release:{'c' * 40}"])

    def test_invalid_active_identity_fails_closed(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "latest"], input="[]", capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
