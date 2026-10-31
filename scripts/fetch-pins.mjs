// 维护者工具：重新固定上游版本与 sha256。
// 用法：node scripts/fetch-pins.mjs [组件名...]
// 它只改 sources.json 的 sha256/bytes，不改 url/version —— 换版本请手工改 url 再跑。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadTo } from '../installer/lib/download.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'installer', 'sources.json');

const doc = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));

let changed = 0;
for (const [id, src] of Object.entries(doc.sources)) {
  if (only.length && !only.includes(id)) continue;
  if (!src.url) {
    console.log(`- ${id}: 没有 url，跳过`);
    continue;
  }
  process.stdout.write(`- ${id}: ${src.url}\n  下载中…`);
  const file = path.join(tmp, `${id}.tgz`);
  const { bytes, sha256 } = await downloadTo(src.url, file, {
    onProgress: ({ received, total }) => {
      if (total) process.stdout.write(`\r  ${((received / total) * 100).toFixed(0)}%   `);
    },
  });
  process.stdout.write(`\r  完成 ${(bytes / 1024 / 1024).toFixed(2)} MB\n`);
  const before = src.sha256;
  src.sha256 = sha256;
  src.bytes = bytes;
  if (before !== sha256) changed++;
  console.log(`  sha256 ${sha256}`);
  if (before && before !== sha256) {
    console.log('  ⚠️ 与旧值不同！上游重新打包过，或版本被移动。确认内容再提交。');
  }
}

fs.writeFileSync(SOURCES, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n已写回 installer/sources.json（变更 ${changed} 项）`);
