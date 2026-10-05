/**
 * Точка входа на хостинге: при необходимости ставит зависимости, собирает dist, запускает API.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const entry = resolve(root, 'dist', 'server.js');
const webDist = resolve(root, 'web', 'dist', 'index.html');

/** На хостинге часто NODE_ENV=production — без этого npm не ставит devDependencies (tsc, vite). */
const installEnv = {
  ...process.env,
  NODE_ENV: 'development',
  npm_config_production: 'false',
};

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
  run('npm run build', 'сборка API (tsc)');
  if (!existsSync(webDist)) {
    run('npm run build --prefix web', 'сборка UI (vite)');
  }
}

if (!existsSync(entry)) {
  buildAll();
}

if (!existsSync(entry)) {
  console.error('[start] нет dist/server.js после сборки');
  process.exit(1);
}

await import(entry);
