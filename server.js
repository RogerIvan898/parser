/**
 * Точка входа для хостинга (Bothost и т.п.): собирает dist при первом старте, затем API.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const entry = resolve(root, 'dist', 'server.js');

function build() {
  console.log('[start] dist/server.js нет — npm run build:all');
  execSync('npm run build:all', {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

if (!existsSync(entry)) {
  build();
}

if (!existsSync(entry)) {
  console.error(
    '[start] не удалось собрать dist/server.js. Нужны devDependencies (typescript) или образ с Dockerfile.',
  );
  process.exit(1);
}

await import(entry);
