import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist', 'db');
mkdirSync(outDir, { recursive: true });
cpSync(resolve(root, 'src', 'db', 'schema.sql'), resolve(outDir, 'schema.sql'));
