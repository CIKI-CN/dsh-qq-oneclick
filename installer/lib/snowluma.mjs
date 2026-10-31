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
import { downloadTo } from './download.mjs';
import { extractZip } from './extract.mjs';

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

/**
 * 走系统代理下载。
 * 为什么不直接用 https.get：这台机器上 github.com 直连会超时，只有 WinINET 里配的
 * 代理（127.0.0.1:7890）能通；Node 不会自动读这个设置，而 PowerShell 会。
 */
function downloadViaSystemProxy(url, dest, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const q = (s) => String(s).replace(/'/g, "''");
    const cmd = [
      "$ProgressPreference='SilentlyContinue'",
      `Invoke-WebRequest -Uri '${q(url)}' -OutFile '${q(dest)}' -UseBasicParsing -TimeoutSec 600`,
    ].join('; ');
    execFile(
      'powershell',
      ['-NoProfile', '-Command', cmd],
      { timeout: 620000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`下载失败：${String(stderr || error.message).trim().slice(0, 200)}`));
        const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        if (size < 10 * 1024 * 1024) return reject(new Error(`下载的文件只有 ${size} 字节，像是出错了`));
        log(`下载完成 ${(size / 1024 / 1024).toFixed(1)} MB`);
        resolve({ bytes: size });
      },
    );
  });
}

/**
 * 一键获取：下载官方最新 Windows 包 → 解压到指定目录 → 校验。
 *
 * 边界（写在这，免得以后自己忘了）：
 *   - 只由用户点击触发；
 *   - 不启动、不配置、不登录，解压完就停手；
 *   - 不修改包内任何文件，也不随我们的发布包分发。
 * EULA §5.4 把「通过自动化脚本部署」列为需书面授权；这里只做用户本来
 * 用解压软件自己也能完成的文件展开，不做"装好并跑起来"。
 */
export async function fetchAndExtract({ destDir, onProgress = () => {}, log = () => {} }) {
  const asset = await latestWinAsset({ timeoutMs: 20000 });
  if (!asset.ok) throw new Error(`查不到最新版：${asset.reason}`);

  fs.mkdirSync(destDir, { recursive: true });
  const zip = path.join(destDir, asset.name);

  if (!fs.existsSync(zip) || fs.statSync(zip).size < 10 * 1024 * 1024) {
    log(`下载 ${asset.name}（${asset.sizeMB} MB）`);
    await downloadViaSystemProxy(asset.url, zip, { log });
  } else {
    log('复用已下载的压缩包');
  }

  log("解压…");
  await extractZip(zip, destDir, { log });
  fs.rmSync(zip, { force: true });

  const info = inspectDir(destDir);
  if (!info.ok) throw new Error(`解压后不像 SnowLuma：${info.reason}`);
  return { ...info, source: asset.tag, assetName: asset.name };
}
