// 设置中心的底座：读写 app/config.json、探测桥接状态、启动/停止。
//
// 安全底线（比功能更重要）：
//   1. 只认「本安装器启动过的」桥接进程 —— pid 记在 data/bridge.pid，且命令行必须包含本安装目录。
//      用户自己从 E:\AI\surfcore 起的那个，绝不能被这里 stop 掉。
//   2. 写配置前一律备份；写之前先校验能解析（免得写坏 JSON 让上游起不来）。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';

import { readJson } from './jsonutil.mjs';

export function pathsFor(targetDir) {
  const app = path.join(targetDir, 'app');
  return {
    targetDir,
    app,
    data: path.join(targetDir, 'data'),
    config: path.join(app, 'config.json'),
    pid: path.join(targetDir, 'data', 'bridge.pid'),
    log: path.join(targetDir, 'data', 'logs', 'bridge.log'),
  };
}

export function readManifest(targetDir) {
  try {
    return readJson(path.join(targetDir, 'data', 'manifest.json'));
  } catch {
    return null;
  }
}

export function readConfig(targetDir) {
  const p = pathsFor(targetDir);
  return readJson(p.config);
}

/** 深合并写回；写前备份，写前校验 */
export function writeConfigPatch(targetDir, patch) {
  const p = pathsFor(targetDir);
  const current = readConfig(targetDir);
  const merged = deepMerge(current, patch);
  if (!merged || typeof merged !== 'object') throw new Error('合并结果是非法对象，已拒绝写入');

  fs.mkdirSync(path.join(p.data, 'config.bak'), { recursive: true });
  const backup = path.join(p.data, 'config.bak', `${Date.now()}.json`);
  fs.writeFileSync(backup, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

  const tmp = `${p.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p.config);
  return { backup, config: merged };
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out?.[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function readPid(targetDir) {
  try {
    const j = readJson(pathsFor(targetDir).pid);
    return Number.isInteger(j?.pid) ? j.pid : null;
  } catch {
    return null;
  }
}

/** 查进程命令行（Windows 用 CIM；其它平台用 ps） */
function processCommandLine(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { windowsHide: true, timeout: 5000 },
        (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
      );
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (error, stdout) =>
        resolve(error ? null : String(stdout).trim() || null),
      );
    }
  });
}

/**
 * 桥接状态。
 * @returns {Promise<{consoleOpen:boolean, pid:number|null, pidAlive:boolean, ours:boolean, foreign:boolean, detail:string}>}
 */
export async function bridgeStatus(targetDir) {
  const consoleOpen = await portOpen(3100);
  const pid = readPid(targetDir);
  let pidAlive = false;
  let ours = false;
  let cmd = null;

  if (pid) {
    cmd = await processCommandLine(pid);
    pidAlive = Boolean(cmd);
    const app = pathsFor(targetDir).app;
    // 只认命令行里带本安装目录的进程：同机可能还有另一套 SurfCore
    ours = Boolean(cmd) && path.resolve(cmd.replace(/^"|"$/g, '')).toLowerCase().includes(path.resolve(app).toLowerCase());
  }

  // 端口开着但不是我们记录的进程 → 是别人在跑（比如用户自己的仓库）
  const foreign = consoleOpen && !ours;

  const detail = ours
    ? `本安装器的桥接在跑（pid ${pid}）`
    : consoleOpen
      ? '3100 上有别的 SurfCore 在跑（不是本安装器启动的，这里不会去停它）'
      : '桥接未运行';

  return { consoleOpen, pid, pidAlive, ours, foreign, detail };
}

export async function startBridge(targetDir) {
  const p = pathsFor(targetDir);
  const status = await bridgeStatus(targetDir);
  if (status.ours) return { started: false, reason: '已经在跑' };
  if (status.consoleOpen) return { started: false, reason: '3100 已被占用（可能是另一套 SurfCore），先处理端口冲突' };

  const entry = path.join(p.app, 'src', 'bridge.js');
  if (!fs.existsSync(entry)) throw new Error(`找不到 ${entry}，先装一次`);

  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  const out = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: p.app,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  child.unref();
  fs.writeFileSync(p.pid, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), app: p.app }, null, 2));

  // 等它把 3100 占上（最多 8 秒）
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (await portOpen(3100)) return { started: true, pid: child.pid };
  }
  return { started: true, pid: child.pid, warning: '进程起来了，但 8 秒内没占上 3100，看日志' };
}

export async function stopBridge(targetDir) {
  const status = await bridgeStatus(targetDir);
  if (!status.pid || !status.pidAlive) {
    return { stopped: false, reason: status.foreign ? '3100 上的是别人的进程，不动它' : '没有本安装器启动的桥接在跑' };
  }
  if (!status.ours) return { stopped: false, reason: 'pid 文件里的进程命令行对不上，为安全起见不停' };

  try {
    process.kill(status.pid);
    fs.rmSync(pathsFor(targetDir).pid, { force: true });
    return { stopped: true, pid: status.pid };
  } catch (error) {
    return { stopped: false, reason: error.message };
  }
}

export function tailLog(targetDir, lines = 120) {
  try {
    const text = fs.readFileSync(pathsFor(targetDir).log, 'utf8');
    return text.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}
