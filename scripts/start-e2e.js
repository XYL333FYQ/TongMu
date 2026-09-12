const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.e2e-runtime');
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

const concurrentlyCli = path.join(projectRoot, 'node_modules', 'concurrently', 'dist', 'bin', 'concurrently.js');
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
    MEDIA_HANDLE_SECRET: 'e2e-only-media-handle-secret-32-bytes',
    VITE_API_URL: 'http://127.0.0.1:3333',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
