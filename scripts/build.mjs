// 打包：把「能发出去的东西」做成一个 zip。
//
// 顺序很重要：先跑出处闸门——闸门不过就不打包。否则发出去的包可能漏了署名。
//
// 产物：
//   dist/dsh-qq-oneclick-v<版本>/        ← 绿色版目录（双击 启动向导.bat 即用）
//   dist/dsh-qq-oneclick-v<版本>.zip     ← 发布资产
//   dist/version.json                    ← 更新检查用（版本 + sha256 + 文件清单）

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const NAME = `dsh-qq-oneclick-v${pkg.version}`;
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, NAME);

const PAYLOAD = [
  'installer',
  'docs',
  'scripts',
  'README.md',
  'LICENSE',
  'NOTICE.md',
  'package.json',
  'start.bat',
  'settings.bat',
  'uninstall.bat',
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT, windowsHide: true, ...opts }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${cmd} 失败：${stderr || error.message}`));
      resolve(String(stdout));
    });
  });
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

async function main() {
  console.log('1/5 跑出处闸门…');
  await run(process.execPath, [path.join(ROOT, 'scripts', 'check-notice.mjs')]);

  console.log('2/5 清空 dist…');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log('3/5 拷贝文件…');
  for (const item of PAYLOAD) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) throw new Error(`缺少打包项：${item}`);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      for (const rel of walk(src)) copy(path.join(src, rel), path.join(OUT, item, rel));
    } else {
      copy(src, path.join(OUT, item));
    }
  }

  // 内置 Node：用当前跑构建的这份，连许可证一起带上（再分发必须附）
  const nodeSrc = process.execPath;
  const nodeDst = path.join(OUT, 'runtime', 'node', 'node.exe');
  copy(nodeSrc, nodeDst);
  const nodeLicense = path.join(ROOT, 'docs', 'licenses', 'node-LICENSE.txt');
  if (!fs.existsSync(nodeLicense)) throw new Error('缺少 docs/licenses/node-LICENSE.txt —— 内置 Node 必须带许可证，不能发');
  copy(nodeLicense, path.join(OUT, 'runtime', 'node', 'LICENSE'));

  console.log('4/5 计算校验和…');
  const files = [];
  let total = 0;
  for (const rel of walk(OUT)) {
    const full = path.join(OUT, rel);
    const bytes = fs.statSync(full).size;
    total += bytes;
    files.push({ path: rel.replace(/\\/g, '/'), bytes, sha256: await sha256(full) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const versionInfo = {
    name: 'DSH一键式接入QQ（非官方）',
    version: pkg.version,
    builtAt: new Date().toISOString(),
    node: process.version,
    fileCount: files.length,
    totalBytes: total,
    files,
  };
  fs.writeFileSync(path.join(OUT, 'version.json'), `${JSON.stringify(versionInfo, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(DIST, 'version.json'), `${JSON.stringify(versionInfo, null, 2)}\n`, 'utf8');

  console.log('5/5 打 zip…');
  const zip = path.join(DIST, `${NAME}.zip`);
  await run('tar', ['-a', '-cf', zip, '-C', DIST, NAME]);

  const zipBytes = fs.statSync(zip).size;
  console.log(`\n✅ 完成`);
  console.log(`   目录  ${path.relative(ROOT, OUT)}  （${(total / 1024 / 1024).toFixed(1)} MB，${files.length} 个文件）`);
  console.log(`   压缩  ${path.relative(ROOT, zip)}  （${(zipBytes / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`   Node  ${process.version}（已内置，含 LICENSE）`);
}

main().catch((error) => {
  console.error(`\n❌ 打包失败：${error.message}`);
  process.exit(1);
});
