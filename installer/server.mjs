// DSH一键式接入QQ — 本地安装向导服务（零依赖）
// 只监听 127.0.0.1，不写注册表，不需要管理员。关掉进程就什么都不留。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

import { detect } from './lib/detect.mjs';
import { install } from './lib/install.mjs';
import { inspectRegistration } from './lib/dsh.mjs';
import { verifyInstall } from './lib/verify.mjs';
import { bridgeStatus, readConfig, readManifest, startBridge, stopBridge, tailLog, pathsFor, writeConfigPatch } from './lib/appconfig.mjs';
import { detect as detectSnowLuma, inspectDir as inspectSnowLuma, pickFolder as pickSnowLumaFolder } from './lib/snowluma.mjs';
import { load as loadState, save as saveState, appendLog, dataDir } from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(HERE, 'web');
const HOST = '127.0.0.1';
const PORT_START = 3210;
const PORT_TRIES = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 单实例安装任务：同一时间只允许一个安装在跑，进度放内存里供前端轮询。
// seq 单调递增：前端按 seq 取增量，即使缓冲区被裁剪也不会错位。
const job = { running: false, finished: false, error: null, manifest: null, events: [], seq: 0, startedAt: null, lastProgressAt: {} };

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

/** 当前该操作哪个安装目录（以 manifest 为准，光有 state 不算） */
function resolveTarget() {
  const st = loadState(ROOT);
  const t = st.installed?.targetDir || st.targetDir;
  if (!t) return null;
  try {
    if (!fs.existsSync(path.join(t, 'data', 'manifest.json'))) return null;
  } catch {
    return null;
  }
  return t;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/** 挡住 DNS rebinding：只接受本机 Host */
function hostAllowed(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  return host === '' || host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost';
}

function serveStatic(res, name) {
  const allowed = new Set(['index.html', 'app.js', 'style.css', 'settings.html', 'settings.js']);
  if (!allowed.has(name)) return send(res, 404, { error: 'not found' });
  const file = path.join(WEB, name);
  try {
    const content = fs.readFileSync(file);
    const type = MIME[path.extname(name)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function handle(req, res) {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;

  // —— 静态页面 ——
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
  if (req.method === 'GET' && (p === '/settings' || p === '/settings.html')) return serveStatic(res, 'settings.html');
  if (req.method === 'GET' && (p === '/app.js' || p === '/style.css' || p === '/settings.js')) return serveStatic(res, p.slice(1));

  // —— 状态 ——
  if (p === '/api/state' && req.method === 'GET') {
    return send(res, 200, { state: loadState(ROOT), root: ROOT, dataDir: dataDir(ROOT) });
  }
  if (p === '/api/state' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const next = saveState(ROOT, body?.patch ?? {});
      return send(res, 200, { state: next });
    } catch (error) {
      return send(res, 400, { error: error?.message ?? 'bad request' });
    }
  }

  // —— 环境检测 ——
  if (p === '/api/detect' && req.method === 'POST') {
    const state = loadState(ROOT);
    const result = await detect({ root: ROOT, targetDir: state.targetDir });
    saveState(ROOT, { detect: result });
    appendLog(ROOT, `环境检测：ok=${result.summary.ok} warn=${result.summary.warn} fail=${result.summary.fail}`);
    return send(res, 200, { detect: result });
  }

  // —— 功能清单 ——
  if (p === '/api/features' && req.method === 'GET') {
    try {
      return send(res, 200, readJson('installer/features.json'));
    } catch (error) {
      return send(res, 500, { error: `features.json 读不到：${error?.message ?? error}` });
    }
  }

  // —— 出处表（向导「出处与许可」页直接读它）——
  if (p === '/api/third-party' && req.method === 'GET') {
    try {
      return send(res, 200, readJson('docs/third-party.json'));
    } catch (error) {
      return send(res, 500, { error: `third-party.json 读不到：${error?.message ?? error}` });
    }
  }

  // —— 安装：起一个任务，前端轮询进度 ——
  if (p === '/api/install' && req.method === 'POST') {
    if (job.running) return send(res, 409, { error: 'busy', message: '已经在装了，等它跑完' });

    const state = loadState(ROOT);
    const targetDir = state.targetDir || (state.detect?.target ?? '');
    if (!targetDir) return send(res, 400, { error: 'no-target', message: '还没选安装目录' });
    if (!state.consent) return send(res, 400, { error: 'no-consent', message: '还没确认出处与许可' });

    job.running = true;
    job.finished = false;
    job.error = null;
    job.manifest = null;
    job.events = [];
    job.seq = 0;
    job.lastProgressAt = {};
    job.startedAt = Date.now();

    const push = (e) => {
      // 进度事件按 150ms 节流：否则一个 7MB 下载能刷出几千条，把步骤事件挤出缓冲区
      if (e.type === 'progress') {
        const now = Date.now();
        if (now - (job.lastProgressAt[e.id] ?? 0) < 150) return;
        job.lastProgressAt[e.id] = now;
      }
      job.seq += 1;
      job.events.push({ ...e, seq: job.seq, at: Date.now() });
      if (job.events.length > 600) job.events.splice(0, job.events.length - 600);
    };

    const c = state.config;
    const minimalConfig = {
      ownerQQ: c.ownerQQ,
      groups: c.groups,
      privates: c.privates,
      snowluma: c.snowluma,
      consoleToken: c.consoleToken,
    };

    install({
      targetDir,
      minimalConfig,
      features: { preset: state.preset, selected: state.selected },
      registerDsh: state.register !== false,
      forceRepoint: Boolean(state.forceRepoint),
      event: push,
      log: (m) => push({ type: 'log', line: m }),
    })
      .then((manifest) => {
        job.manifest = manifest;
        job.finished = true;
        saveState(ROOT, {
          step: 5,
          completed: [...new Set([...(loadState(ROOT).completed ?? []), 'install'])],
          installed: { version: manifest.surfcore.version, at: manifest.installedAt, targetDir },
        });
        appendLog(ROOT, `安装完成：${manifest.surfcore.version} → ${targetDir}`);
      })
      .catch((error) => {
        job.error = error?.message ?? String(error);
        appendLog(ROOT, `安装失败：${job.error}`);
      })
      .finally(() => {
        job.running = false;
      });

    return send(res, 202, { started: true });
  }

  if (p === '/api/install/status' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    return send(res, 200, {
      running: job.running,
      finished: job.finished,
      error: job.error,
      manifest: job.manifest,
      startedAt: job.startedAt,
      events: job.events.filter((e) => e.seq > since),
      total: job.seq,
    });
  }

  // —— 设置中心 ——
  if (p === '/api/settings' && req.method === 'GET') {
    const target = resolveTarget();
    if (!target) return send(res, 404, { error: 'no-install', message: '还没有装过（找不到安装目录）' });
    try {
      const manifest = readManifest(target);
      const status = await bridgeStatus(target);
      return send(res, 200, {
        target,
        manifest,
        bridge: status,
        config: fs.existsSync(pathsFor(target).config) ? readConfig(target) : null,
        registration: inspectRegistration({}),
      });
    } catch (error) {
      return send(res, 500, { error: error?.message ?? String(error) });
    }
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const target = resolveTarget();
    if (!target) return send(res, 404, { error: 'no-install' });
    try {
      const body = await readBody(req);
      const result = writeConfigPatch(target, body?.patch ?? {});
      appendLog(ROOT, '设置中心写入配置');
      return send(res, 200, { ok: true, backup: result.backup, config: result.config });
    } catch (error) {
      return send(res, 400, { error: error?.message ?? 'bad request' });
    }
  }

  if (p === '/api/settings/verify' && req.method === 'POST') {
    const target = resolveTarget();
    if (!target) return send(res, 404, { error: 'no-install' });
    const check = await verifyInstall({ targetDir: target });
    return send(res, 200, { verify: check });
  }

  if ((p === '/api/bridge/start' || p === '/api/bridge/stop') && req.method === 'POST') {
    const target = resolveTarget();
    if (!target) return send(res, 404, { error: 'no-install' });
    try {
      const result = p.endsWith('start') ? await startBridge(target) : await stopBridge(target);
      return send(res, 200, { result, bridge: await bridgeStatus(target) });
    } catch (error) {
      return send(res, 500, { error: error?.message ?? String(error) });
    }
  }

  if (p === '/api/logs' && req.method === 'GET') {
    const target = resolveTarget();
    if (!target) return send(res, 404, { error: 'no-install' });
    const lines = Math.min(Number(url.searchParams.get('lines') ?? 120) || 120, 400);
    return send(res, 200, { log: tailLog(target, lines) });
  }

  // —— SnowLuma 检测与接线（只找路径、写配置，不自动下载/部署）——
  if (p === '/api/snowluma' && req.method === 'GET') {
    const st = loadState(ROOT);
    const dir = url.searchParams.get('dir') || st.config?.snowluma?.homeDir || '';
    const found = dir ? inspectSnowLuma(dir) : detectSnowLuma(st.targetDir, st.config?.snowluma?.homeDir ?? '');
    return send(res, 200, {
      found,
      configured: {
        homeDir: st.config?.snowluma?.homeDir ?? '',
        launcherPath: st.config?.snowluma?.launcherPath ?? '',
      },
    });
  }

  if (p === '/api/snowluma/pick' && req.method === 'POST') {
    const picked = await pickSnowLumaFolder();
    return send(res, 200, { picked });
  }

  if (p === '/api/snowluma/apply' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const dir = String(body?.dir ?? '').trim();
      const found = inspectSnowLuma(dir);
      if (!found.ok) return send(res, 400, { error: 'invalid-dir', message: found.reason });

      // 已装：直接写进 app/config.json；没装：先记在向导状态里，装的时候一起写
      const target = resolveTarget();
      if (target) {
        writeConfigPatch(target, {
          snowluma: { homeDir: found.dir, launcherPath: found.launcher ?? '' },
        });
        return send(res, 200, { ok: true, where: 'app/config.json', found });
      }
      saveState(ROOT, { config: { snowluma: { homeDir: found.dir, launcherPath: found.launcher ?? '' } } });
      return send(res, 200, { ok: true, where: '安装时会写入', found });
    } catch (error) {
      return send(res, 400, { error: error?.message ?? 'bad request' });
    }
  }

  // —— DSH 现状探测（确认页要知道「会注册到哪、现在是谁」）——
  if (p === '/api/dsh' && req.method === 'GET') {
    try {
      const reg = inspectRegistration({});
      return send(res, 200, { registration: reg });
    } catch (error) {
      return send(res, 500, { error: error?.message ?? String(error) });
    }
  }

  // —— 管理：清空安装状态（调试/重来用，不动已装的文件）——
  if (p === '/api/reset' && req.method === 'POST') {
    saveState(ROOT, { step: 0, completed: [], consent: null, selected: [], installed: null });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/health') return send(res, 200, { ok: true, pid: process.pid, root: ROOT });

  return send(res, 404, { error: 'not found' });
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

function listen(port, tries) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        send(res, 500, { error: error?.message ?? 'internal error' });
      });
    });
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && tries > 1) {
        resolve(listen(port + 1, tries - 1));
      } else {
        reject(error);
      }
    });
    server.listen(port, HOST, () => resolve({ server, port }));
  });
}

const { port } = await listen(PORT_START, PORT_TRIES);
const url = `http://${HOST}:${port}/`;

fs.mkdirSync(dataDir(ROOT), { recursive: true });
fs.writeFileSync(
  path.join(dataDir(ROOT), 'installer.pid'),
  JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2),
);

console.log(`\n  DSH一键式接入QQ · 安装向导`);
console.log(`  ${url}`);
console.log(`  只监听本机；结束运行请按 Ctrl+C\n`);

// --settings：直接开设置中心（装完之后日常用这个）
if (process.argv.includes('--settings')) openBrowser(`${url}settings`);
else if (process.argv.includes('--open')) openBrowser(url);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      fs.rmSync(path.join(dataDir(ROOT), 'installer.pid'), { force: true });
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  });
}
