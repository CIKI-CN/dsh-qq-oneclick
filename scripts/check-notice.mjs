// 出处闸门：构建前跑它。任何一条不过就 exit 1。
// 设计意图：让「忘记标出处」变成一个会红的技术失败，而不是一句口头约定。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNotice } from './lib/notice.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUSIONS = new Set(['bundle', 'download', 'user-provided', 'reference', 'doc-only']);
const REQUIRED_FIELDS = ['id', 'name', 'upstream', 'author', 'license', 'inclusion', 'usedFor'];
const SELF_CODES = new Set(['self']);

const errors = [];
const warns = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warns.push(msg);

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (error) {
    fail(`读不到或解析失败：${rel}（${error?.message ?? error}）`);
    return null;
  }
}

const doc = readJson('docs/third-party.json');
if (!doc) finish();

// 1. 必备字段 / 取值
for (const c of doc.components ?? []) {
  const missing = REQUIRED_FIELDS.filter((k) => !String(c[k] ?? '').trim());
  if (missing.length) fail(`组件 ${c.id ?? '(无 id)'} 缺少字段：${missing.join(', ')}`);
  if (c.inclusion && !INCLUSIONS.has(c.inclusion)) fail(`组件 ${c.id} 的 inclusion 非法：${c.inclusion}`);
  if (c.upstream && !/^https?:\/\//i.test(c.upstream)) fail(`组件 ${c.id} 的 upstream 不是 http(s) 链接：${c.upstream}`);

  // 许可证不明的组件不得随包分发
  const lic = String(c.license ?? '');
  if (c.inclusion === 'bundle' && (/待核实|未知|unknown|SEE LICENSE/i.test(lic) || !lic.trim())) {
    fail(`组件 ${c.id} 许可证未明（${lic || '空'}），不允许 inclusion=bundle；改成 download 或 user-provided`);
  }
}

// 2. id 唯一
const ids = (doc.components ?? []).map((c) => c.id);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dup.length) fail(`组件 id 重复：${[...new Set(dup)].join(', ')}`);

// 3. features.json 引用的 source 必须能落到某个组件
const features = readJson('installer/features.json');
if (features?.groups) {
  const known = new Set([...ids, ...SELF_CODES]);
  for (const g of features.groups) {
    for (const it of g.items ?? []) {
      const src = String(it.source ?? '').trim();
      if (!src) {
        fail(`功能 ${it.id} 没有 source`);
        continue;
      }
      if (!known.has(src)) fail(`功能 ${it.id} 的来源 "${src}" 不在 third-party.json 里（也没有算作 self）`);
    }
  }
}

// 4. package.json 的依赖必须被某个组件覆盖
const pkg = readJson('package.json');
if (pkg) {
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  for (const dep of deps) {
    const covered = (doc.components ?? []).some(
      (c) => String(c.name ?? '').includes(dep) || String(c.upstream ?? '').includes(dep),
    );
    if (!covered) fail(`依赖 ${dep} 没有在 third-party.json 登记（新增依赖必须同时加出处）`);
  }
}

// 5. 下载清单（sources.json）里的每个组件也必须登记过
const sources = readJson('installer/sources.json');
if (sources?.sources) {
  for (const id of Object.keys(sources.sources)) {
    if (!ids.includes(id)) fail(`installer/sources.json 里的 "${id}" 没有在 third-party.json 登记`);
  }
} else {
  fail('缺少 installer/sources.json（安装器靠它确定版本与校验和）');
}

// 6. NOTICE.md 必须与生成结果一致
try {
  const existing = fs.readFileSync(path.join(ROOT, 'NOTICE.md'), 'utf8');
  const expected = buildNotice(doc);
  if (existing !== expected) {
    fail('NOTICE.md 与 third-party.json 不一致（或被人手改过）。跑 `npm run gen:notice` 重新生成');
  }
} catch {
  fail('缺少 NOTICE.md。跑 `npm run gen:notice` 生成');
}

// 6. 提醒：没有署名的「参考」类要写清到底参考了什么
for (const c of doc.components ?? []) {
  if (c.inclusion === 'reference' && !String(c.modified ?? '').trim()) {
    warn(`组件 ${c.id} 是 reference，但没写"我们改了什么/参考了什么"`);
  }
}

finish();

function finish() {
  for (const w of warns) console.warn(`⚠️  ${w}`);
  if (errors.length) {
    console.error(`\n❌ 出处闸门未通过（${errors.length} 项）：`);
    for (const e of errors) console.error(`   · ${e}`);
    console.error('\n修法：改 docs/third-party.json → npm run gen:notice → 再跑一次。');
    process.exit(1);
  }
  console.log(`✅ 出处闸门通过：${doc?.components?.length ?? 0} 个组件、NOTICE.md 与来源表一致。`);
  process.exit(0);
}
