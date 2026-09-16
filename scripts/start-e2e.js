const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const fixtureScript = path.join(projectRoot, 'e2e', 'media-fixture-server.js');
const runtimeDir = path.join(projectRoot, '.e2e-runtime');
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

const concurrentlyCli = path.join(projectRoot, 'node_modules', 'concurrently', 'dist', 'bin', 'concurrently.js');
const fixture = spawn(process.execPath, [fixtureScript], {
  cwd: projectRoot,
  stdio: 'inherit',
});
const child = spawn(process.execPath, [
  concurrentlyCli,
  '--kill-others',
  'npm run dev -w backend',
  'npm run dev -w frontend -- --host 127.0.0.1 --port 5173 --strictPort',
], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    CONFIG_DIR: runtimeDir,
    DATABASE_URL: path.join(runtimeDir, 'test.sqlite'),
    NODE_ENV: 'test',
    MEDIA_E2E_FIXTURE_ORIGIN: 'http://127.0.0.1:3456',
    NCM_API_BASE_URL: 'http://127.0.0.1:3456/ncm-fixture',
    MEDIA_HANDLE_SECRET: 'e2e-only-media-handle-secret-32-bytes',
    JWT_ACCESS_EXPIRES_IN: '2s',
    MEDIA_ROOM_GRANT_TTL_MS: '2000',
    VITE_API_URL: 'http://127.0.0.1:3333',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
    fixture.kill(signal);
  });
}
child.on('exit', (code) => {
  fixture.kill('SIGTERM');
  process.exit(code ?? 0);
});
