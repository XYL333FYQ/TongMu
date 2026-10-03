"""List safe TongMu release tags older than the active and previous image."""
from datetime import datetime
import json
import re
import sys


SHA = re.compile(r"^[0-9a-f]{40}$")
ACTIVE_SHA = sys.argv[1] if len(sys.argv) == 2 else ""
if not SHA.fullmatch(ACTIVE_SHA):
    raise SystemExit("Expected an active full Git SHA")

images = json.load(sys.stdin)
releases = []
for image in images:
    if not isinstance(image, dict):
        continue
    created = image.get("Created")
    try:
        created_at = datetime.fromisoformat(created.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        continue
    for reference in image.get("RepoTags") or []:
        match = re.fullmatch(r"tongmu-release:([0-9a-f]{40})", reference)
        if match:
            releases.append((created_at, match.group(1), reference))

releases.sort(key=lambda item: (item[1] == ACTIVE_SHA, item[0]), reverse=True)
retained = {reference for _, _, reference in releases[:2]}
for _, _, reference in releases:
    if reference not in retained:
        print(reference)
