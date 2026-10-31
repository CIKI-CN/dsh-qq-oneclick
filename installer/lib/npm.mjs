// npm 适配层：优先用系统的，其次用我们下载的，都没有就自己拉一份（pin 在 sources.json）。
// 目的：机器上没装 Node/npm 的人也能装完 —— 这是「无脑式」的前提。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { downloadTo } from './download.mjs';
import { extractTarGz, extractWithTar } from './extract.mjs';

function findOnPath(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}

/**
 * 决定用哪个 npm。
 * @returns {Promise<{kind:'node'|'bin', cli?:string, path?:string, source:string}>}
 */
export async function ensureNpm({ runtimeDir, sources, event = () => {}, log = () => {} }) {
  const explicit = process.env.DSH_QQ_NPM;
  if (explicit && fs.existsSync(explicit)) {
    return { kind: 'node', cli: explicit, source: 'env:DSH_QQ_NPM' };
  }

  const bundled = path.join(runtimeDir, 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundled)) {
    return { kind: 'node', cli: bundled, source: 'runtime/npm（已下载）' };
  }

  const sys = findOnPath('npm');
  if (sys) return { kind: 'bin', path: sys, source: `系统 PATH：${sys}` };

  // 都没有 → 自己拉一份
  // 注意：调用方可能传整份 sources.json（{sources:{...}}），也可能直接传子表，这里都兼容。
  const pin = sources?.sources?.npm ?? sources?.npm;
  if (!pin?.url) throw new Error('没有 npm，也没有可下载的 npm 源（sources.json 缺 npm）');

  event({ type: 'step', id: 'npm', status: 'running', message: `下载 npm ${pin.version}` });
  const cacheDir = path.join(runtimeDir, 'cache');
  const archive = path.join(cacheDir, `npm-${pin.version}.tgz`);
  if (!fs.existsSync(archive)) {
    await downloadTo(pin.url, archive, {
      expectSha256: pin.sha256,
      log,
      onProgress: ({ received, total }) =>
        event({ type: 'progress', id: 'npm', received, total: total || pin.bytes || 0 }),
    });
  }

  const dest = path.join(runtimeDir, 'npm');
  fs.rmSync(dest, { recursive: true, force: true });
  try {
    extractTarGz(archive, dest, { stripPrefix: pin.stripPrefix ?? 1, log });
  } catch (error) {
    log(`内置解包失败（${error.message}），改用 tar.exe`);
    await extractWithTar(archive, dest, pin.stripPrefix ?? 1);
  }

  if (!fs.existsSync(bundled)) throw new Error('npm 解包后仍找不到 bin/npm-cli.js');
  event({ type: 'step', id: 'npm', status: 'ok', message: `npm ${pin.version} 已就绪` });
  return { kind: 'node', cli: bundled, source: `下载到 runtime/npm（${pin.version}）` };
}

/** 跑 npm，逐行回传输出，超时或非零退出都抛错。 */
export function runNpm(npm, args, { cwd, onLine = () => {}, timeoutMs = 15 * 60 * 1000 } = {}) {
  const [cmd, argv] =
    npm.kind === 'bin'
      ? [npm.path, args]
      : [process.execPath, [npm.cli, ...args]];

  return new Promise((resolve, reject) => {
    // 关键：把当前 node 所在目录放进 PATH。
    // 否则上游的 postinstall（`node scripts/patch-snowluma-sdk.mjs`）会因为系统里没有
    // node 而失败 —— 这台机器就是这种情况。
    const nodeDir = path.dirname(process.execPath);
    const env = {
      ...process.env,
      PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    };

    const child = execFile(
      cmd,
      argv,
      {
        cwd,
        windowsHide: true,
        shell: npm.kind === 'bin' && process.platform === 'win32',
        maxBuffer: 32 * 1024 * 1024,
        timeout: timeoutMs,
        env,
      },
      (error, stdout, stderr) => {
        const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-40).join('\n');
        if (error) {
          reject(new Error(`npm ${args.join(' ')} 失败：${error.message}\n--- 最后输出 ---\n${tail}`));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    const feed = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
  });
}
