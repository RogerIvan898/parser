/**
 * Точка входа, если хостинг запускает server.js, а не dist/server.js.
 * В образе Bothost сборка лежит в /usr/src/app: /app при старте перекрывается Git и dist пропадает.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const imageRoot = '/usr/src/app';
const imageEntry = resolve(imageRoot, 'dist', 'server.js');

/** На хостинге часто NODE_ENV=production — без этого npm не ставит devDependencies (tsc, vite). */
const installEnv = { ...process.env, NODE_ENV: 'development' };
delete installEnv.npm_config_production;

function run(cmd, label) {
  console.log(`[start] ${label}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: installEnv });
}

function ensureDependencies() {
  if (!existsSync(resolve(root, 'node_modules', 'typescript'))) {
    run('npm install', 'корень: npm install (typescript, tsc)');
  }

  if (!existsSync(resolve(root, 'web', 'node_modules', 'vite'))) {
    run('npm install --prefix web', 'web: npm install (vite)');
  }
}

function buildAll() {
  ensureDependencies();

  const entry = resolve(root, 'dist', 'server.js');
  const webDist = resolve(root, 'web', 'dist', 'index.html');
  if (!existsSync(entry)) {
    run('npm run build', 'сборка API (tsc)');
  }
  if (!existsSync(webDist)) {
    run('npm run build --prefix web', 'сборка UI (vite)');
  }
}

let entry = resolve(root, 'dist', 'server.js');

if (existsSync(imageEntry) && resolve(root) !== resolve(imageRoot)) {
  process.chdir(imageRoot);
  entry = imageEntry;
  console.log('[start] API из образа:', entry);
} else if (!existsSync(entry)) {
  buildAll();
  entry = resolve(root, 'dist', 'server.js');
}

if (!existsSync(entry)) {
  console.error('[start] нет dist/server.js после сборки');
  process.exit(1);
}

console.log('[start] запуск API (dist/server.js)…');
try {
  await import(pathToFileURL(entry).href);
} catch (err) {
  const text = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error('[start] ошибка загрузки API:', text);
  process.exit(1);
}
