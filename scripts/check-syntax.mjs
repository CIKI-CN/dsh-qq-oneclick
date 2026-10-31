// 语法检查：node --check 所有 .mjs/.js，任何一个不过就失败。
// 放进 CI 是为了拦住「改了没跑」的低级错误——本地跑一次也就两秒。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'data', 'cache', '.git']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

function check(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? `${path.relative(ROOT, file)}: ${(stderr || stdout).trim().split('\n').slice(0, 3).join(' ')}` : null);
    });
  });
}

const files = walk(ROOT);
const failed = [];
for (const f of files) {
  const err = await check(f);
  if (err) failed.push(err);
}

if (failed.length) {
  console.error(`❌ 语法检查失败（${failed.length}/${files.length}）：`);
  for (const e of failed) console.error(`   · ${e}`);
  process.exit(1);
}
console.log(`✅ 语法检查通过：${files.length} 个文件`);
