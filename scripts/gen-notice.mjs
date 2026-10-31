// 生成 NOTICE.md。唯一真相源是 docs/third-party.json。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNotice } from './lib/notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs', 'third-party.json');
const OUT = path.join(ROOT, 'NOTICE.md');

const doc = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const text = buildNotice(doc);
fs.writeFileSync(OUT, text, 'utf8');

console.log(`已生成 ${path.relative(ROOT, OUT)}（${doc.components.length} 个组件）`);
