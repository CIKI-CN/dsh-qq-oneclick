// 环境检测：每一项都真去探，不许写假绿。
// 状态约定：ok = 可用；warn = 能用但会踩坑；fail = 这一步过不去（除非勾「我知道风险」）。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';

const MIN_NODE = [22, 13, 0];
const DEFAULT_TARGET = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'DSHQQ')
  : path.join(os.homedir(), 'DSHQQ');

function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function parseVersion(v) {
  return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0).slice(0, 3);
}

/** 试着在 127.0.0.1 上监听：能监听 = 空闲 */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { ok: true, detail: dir };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}

function probeNetwork(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = https.request(
      { method: 'HEAD', host: 'github.com', path: '/', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve({ ok: true, detail: `github.com 可达（HTTP ${res.statusCode}）` });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, detail: `github.com 超时（>${timeoutMs}ms）` });
    });
    req.on('error', (error) => resolve({ ok: false, detail: error?.message ?? String(error) }));
    req.end();
  });
}

function checkDsh() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  if (!fs.existsSync(dshHome)) {
    return {
      status: 'warn',
      detail: `未发现 ${dshHome}`,
      fix: '没有 DSH 也能装（只是暂时用不了设置页）；装好 DSH 后回到本向导「注册」即可。',
    };
  }
  let profiles = [];
  try {
    profiles = fs
      .readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    /* profiles 不存在也算发现了 DSH 家目录 */
  }
  return {
    status: 'ok',
    detail: profiles.length ? `${dshHome}（profile: ${profiles.join(', ')}）` : dshHome,
    fix: '',
  };
}

function checkExistingInstall(root) {
  const manifest = path.join(root, 'data', 'manifest.json');
  if (!fs.existsSync(manifest)) {
    return { status: 'ok', detail: '未发现已有安装（全新安装）', fix: '' };
  }
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return {
      status: 'warn',
      detail: `已装过：v${m.version ?? '?'}（${m.installedAt ?? '时间未知'}）`,
      fix: '继续会走「修复/补装」，不会清空已有记忆；要重装请先在设置中心卸载。',
    };
  } catch {
    return { status: 'warn', detail: 'manifest.json 存在但无法解析', fix: '可在设置中心「修复」。' };
  }
}

function checkAttribution(root) {
  const file = path.join(root, 'docs', 'third-party.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(doc.components) ? doc.components : [];
    const bad = list.filter((c) => !c.id || !c.upstream || !c.license || !c.inclusion);
    if (!list.length) return { status: 'fail', detail: 'third-party.json 里没有任何组件', fix: '这不是正常发布包，请重新下载。' };
    if (bad.length) {
      return {
        status: 'fail',
        detail: `${bad.length} 个组件缺少必要字段：${bad.map((b) => b.id ?? '(无 id)').join(', ')}`,
        fix: '运行 npm run check:notice 定位。',
      };
    }
    return { status: 'ok', detail: `${list.length} 个组件已登记出处`, fix: '' };
  } catch (error) {
    return { status: 'fail', detail: `读不到 ${file}`, fix: '发布包残缺，请重新下载。' };
  }
}

export async function detect({ root, targetDir } = {}) {
  const target = targetDir || DEFAULT_TARGET;
  const results = [];

  // 1. 系统
  results.push({
    id: 'os',
    label: '操作系统',
    status: process.platform === 'win32' ? 'ok' : 'warn',
    detail: `${process.platform} ${os.release()} ${process.arch}`,
    fix: process.platform === 'win32' ? '' : 'SnowLuma 的 QQ 注入只支持 Windows；当前系统只能跑不注入的部分。',
  });

  // 2. Node
  const nodeOk = cmpVersion(parseVersion(process.version), MIN_NODE) >= 0;
  results.push({
    id: 'node',
    label: 'Node.js',
    status: nodeOk ? 'ok' : 'fail',
    detail: `${process.version}（要求 >= ${MIN_NODE.join('.')}）`,
    fix: nodeOk ? '' : '安装 Node.js 22.13 或更新版本后重启向导。',
  });

  // 3. DSH
  const dsh = checkDsh();
  results.push({ id: 'dsh', label: 'DeepSeek Harness', ...dsh });

  // 4~7. 端口
  for (const [port, label] of [
    [3000, 'SnowLuma HTTP'],
    [3001, 'SnowLuma WS'],
    [3100, 'SurfCore 控制台'],
  ]) {
    const free = await portFree(port);
    results.push({
      id: `port-${port}`,
      label: `端口 ${port}（${label}）`,
      status: free ? 'ok' : 'warn',
      detail: free ? '空闲' : '已被占用',
      fix: free ? '' : '若占用的就是 SnowLuma/SurfCore，属正常；若是别的程序，装完会连不上。',
    });
  }

  // 8. 目标目录可写
  const w = probeWritable(target);
  results.push({
    id: 'target',
    label: '安装目录可写',
    status: w.ok ? 'ok' : 'fail',
    detail: w.detail,
    fix: w.ok ? '' : '换一个目录，或用管理员权限重开向导。',
  });

  // 9. 网络
  const net = await probeNetwork();
  results.push({
    id: 'network',
    label: '网络（拉取上游）',
    status: net.ok ? 'ok' : 'warn',
    detail: net.detail,
    fix: net.ok ? '' : '下载式安装需要联网；离线请用发布页的离线包（如提供）。',
  });

  // 10. 已有安装
  const existing = checkExistingInstall(root);
  results.push({ id: 'existing', label: '已有安装', ...existing });

  // 11. 出处登记完整
  const attr = checkAttribution(root);
  results.push({ id: 'attribution', label: '出处登记', ...attr });

  const summary = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
  };

  return { at: new Date().toISOString(), target, results, summary };
}

// 允许单独跑：node installer/lib/detect.mjs --self-test
if (process.argv.includes('--self-test')) {
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  detect({ root }).then((r) => {
    for (const x of r.results) {
      console.log(`[${x.status.toUpperCase().padEnd(4)}] ${x.label}: ${x.detail}`);
      if (x.fix) console.log(`         → ${x.fix}`);
    }
    console.log(`\n汇总：ok=${r.summary.ok} warn=${r.summary.warn} fail=${r.summary.fail}`);
    process.exit(r.summary.fail ? 1 : 0);
  });
}
