#!/usr/bin/env python3
"""Repository-only regression checks; never connects to a VPS or reads secrets."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
deploy = (root / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
diag = (root / ".github/workflows/production-diagnostics.yml").read_text(encoding="utf-8")
nginx = (root / "deploy/nginx/tongmu-http.conf.example").read_text(encoding="utf-8")
guide = (root / "docs/new-vps-deployment.md").read_text(encoding="utf-8")

checks = {
    "deployment remains manual-only": "workflow_dispatch:" in deploy and "\n  push:" not in deploy,
    "gate runs before publishing image": "  activation_gate:" in deploy and "needs: activation_gate" in deploy,
    "deployment scoped to production": "environment: production" in deploy,
    "old Hong Kong SSH Secrets are not used": all(
        f"secrets.{key}" not in deploy + diag
        for key in ("VPS_HOST", "VPS_USER", "VPS_PORT", "VPS_SSH_KEY")
    ),
    "new SSH credential is isolated": "secrets.TONGMU_PRODUCTION_SSH_KEY" in deploy and "secrets.TONGMU_PRODUCTION_SSH_KEY" in diag,
    "manual activation required": "TONGMU_DEPLOY_ENABLED" in deploy,
    "expired old Hong Kong host rejected": '8.217.140.53' in deploy and '8.217.140.53' in diag,
    "SSH host fingerprint pinned": "SSH_HOST_KEY_FINGERPRINT" in deploy and "ssh-keygen -lf" in deploy,
    "new VPS preflight required": "preflight-new-vps.sh" in deploy,
    "Nginx template keeps localhost API private": "proxy_pass http://127.0.0.1:3333;" in nginx,
    "Nginx template includes websocket upgrades": "proxy_set_header Upgrade $http_upgrade;" in nginx,
    "Nginx template does not assume existing SSL certificate": "ssl_certificate" not in nginx,
    "fresh install steps documented": "bootstrap-ubuntu.sh" in guide and "TONGMU_DEPLOY_ENABLED" in guide,
}

for script in ("scripts/deploy/bootstrap-ubuntu.sh", "scripts/deploy/preflight-new-vps.sh"):
    syntax = subprocess.run(["bash", "-n", str(root / script)], check=False, capture_output=True, text=True)
    checks[f"bash syntax: {script}"] = syntax.returncode == 0

failures = []
for message, success in checks.items():
    print(("PASS" if success else "FAIL") + " " + message)
    if not success:
        failures.append(message)
if failures:
    raise SystemExit(f"{len(failures)} new VPS preparation checks failed")
print("Future deployment configuration static checks passed; no servers contacted")
