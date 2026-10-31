// SnowLuma 的检测与接线（不做自动部署）。
//
// 为什么不做「一键下载解压并启动」：
//   SnowLuma EULA §5.4 明确写「将其并入第三方安装包…或通过自动化脚本部署，
//   均须事先取得书面授权」。所以这里只做三件事：
//     1. 找到用户自己解压的那份 SnowLuma（自动扫 + 手动选）
//     2. 校验它是不是完整的发行包（index.mjs + release.json + node.exe）
//     3. 把路径写进 SurfCore 的 config（homeDir / launcherPath），省掉手填
//   「下载」「解压」「启动」都留给用户自己——那是他本人使用，不是我们部署。

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';

/** 判断某个目录是不是一份 SnowLuma 发行包 */
export function inspectDir(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, reason: '目录不存在' };

  const hasIndex = fs.existsSync(path.join(dir, 'index.mjs'));
  const hasRelease = fs.existsSync(path.join(dir, 'release.json'));
  const hasNode = fs.existsSync(path.join(dir, 'node.exe'));
  if (!hasIndex || !hasRelease) {
    return { ok: false, reason: '不像 SnowLuma 发行包（缺 index.mjs 或 release.json）' };
  }

  let version = null;
  let target = null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8').replace(/^\uFEFF/, ''));
    version = r.version ?? null;
    target = r.target ?? null;
  } catch {
    /* 版本读不到不影响可用性 */
  }

  return {
    ok: true,
    dir: path.resolve(dir),
    version,
    target,
    node: hasNode ? path.join(dir, 'node.exe') : null,
    launcher: fs.existsSync(path.join(dir, 'launcher.bat')) ? path.join(dir, 'launcher.bat') : null,
    eula: fs.existsSync(path.join(dir, 'EULA.md')) ? path.join(dir, 'EULA.md') : null,
  };
}

/** 常见位置：配置里记过的、安装目录旁边、用户目录、几个盘根 */
export function candidates(targetDir, configured = '') {
  const list = [];
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };

  push(configured);
  if (targetDir) push(path.join(targetDir, 'snowluma'));
  if (process.env.LOCALAPPDATA) push(path.join(process.env.LOCALAPPDATA, 'SnowLuma'));
  if (process.env.USERPROFILE) {
    push(path.join(process.env.USERPROFILE, 'SnowLuma'));
    push(path.join(process.env.USERPROFILE, 'Downloads', 'SnowLuma'));
    push(path.join(process.env.USERPROFILE, 'Desktop', 'SnowLuma'));
  }
  for (const d of ['C:', 'D:', 'E:']) push(`${d}\\SnowLuma`);

  return list;
}

/** 扫一遍，返回第一个像样的 */
export function detect(targetDir, configured = '') {
  for (const dir of candidates(targetDir, configured)) {
    const r = inspectDir(dir);
    if (r.ok) return r;
  }
  return { ok: false, reason: '没找到。你下载解压到哪了？可以手动选一下' };
}

/**
 * 让用户点选目录（Windows 原生文件夹对话框）。
 * 这是唯一会弹窗的操作——因为路径只有用户知道。
 */
export function pickFolder() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, reason: '只有 Windows 支持' });
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$d.Description = "选择 SnowLuma 解压后的目录（有 index.mjs 的那一层）";',
      'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath } else { Write-Output "" }',
    ].join(' ');
    execFile(
      'powershell',
      ['-NoProfile', '-STA', '-Command', script],
      { windowsHide: false, timeout: 120000 },
      (error, stdout) => {
        const dir = String(stdout ?? '').trim();
        if (error || !dir) return resolve({ ok: false, reason: '没有选择目录' });
        const r = inspectDir(dir);
        resolve(r.ok ? r : { ok: false, reason: r.reason, dir });
      },
    );
  });
}

/**
 * 查官方最新发行版里「Windows x64 完整包」的直链。
 *
 * 只做「告诉你下哪个、把链接给你」——不替用户下载、不解压、不运行。
 * 为什么值得做：Releases 页面同时挂着 linux-arm64 / linux-x64 / lite 等 6 个包，
 * 普通人很容易点错；这里自动挑出唯一正确的那一个。
 */
export function latestWinAsset({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: 'api.github.com',
        path: '/repos/SnowLuma/SnowLuma/releases/latest',
        method: 'GET',
        headers: { 'user-agent': 'dsh-qq-oneclick', accept: 'application/vnd.github+json' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, reason: `GitHub 返回 ${res.statusCode}` });
          try {
            const rel = JSON.parse(body);
            const assets = Array.isArray(rel.assets) ? rel.assets : [];
            // Windows x64 完整包：排除 -lite、linux、arm64
            const hit = assets.find((a) => /win-x64\.zip$/i.test(a.name) && !/lite/i.test(a.name));
            if (!hit) return resolve({ ok: false, reason: '这个发行版里没找到 Windows x64 完整包' });
            resolve({
              ok: true,
              tag: rel.tag_name,
              name: hit.name,
              sizeMB: Math.round((hit.size / 1024 / 1024) * 10) / 10,
              url: hit.browser_download_url,
              page: rel.html_url,
            });
          } catch (error) {
            resolve({ ok: false, reason: error.message });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: '查 GitHub 超时（网络问题，可直接去 Releases 页）' });
    });
    req.on('error', (error) => resolve({ ok: false, reason: error.message }));
    req.end();
  });
}
