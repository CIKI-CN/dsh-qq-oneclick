// 把装好的 app 注册进 DSH：跑上游的 scripts/setup-dsh.mjs。
//
// 为什么不能直接跑：
//   上游脚本会「删掉所有同 id 的 MCP 条目 + 重建 junction」指向当前仓库。
//   如果用户已经有一套指向别的目录（比如开发者自己的仓库），直接跑就是**静默抢占**。
//   所以这里先探测、再决定：默认不动，要求显式 force。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const MANAGED_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];

// 我们自己的 MCP 条目：跟上游那三个分开管，卸载时可单独摘掉，也不会被上游的同步逻辑误删。
const OUR_BEGIN = '# === dsh-qq-oneclick STT BEGIN ===';
const OUR_END = '# === dsh-qq-oneclick STT END ===';

function q(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ourSttBlock({ scriptPath, targetDir }) {
  return [
    OUR_BEGIN,
    '- insert:',
    '    - id: mcp-stt',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: stt',
    '        transport: stdio',
    `        command: ${q(process.execPath)}`,
    '        args:',
    `          - ${q(scriptPath)}`,
    '          - --target',
    `          - ${q(targetDir)}`,
    OUR_END,
    '',
  ].join('\n');
}

/** 把我们自己的 STT MCP 写进 profile（幂等；不动上游那段） */
export function ensureOurMcp({ dshHome, profile, targetDir, scriptPath }) {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = ourSttBlock({ scriptPath, targetDir });

  const re = new RegExp(`${OUR_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${OUR_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  const text = re.test(original) ? original.replace(re, block) : `${original}${original.endsWith('\n') || !original ? '' : '\n'}\n${block}`;

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { file, changed: text !== original };
}

export function removeOurMcp({ dshHome, profile }) {
  const file = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  if (!fs.existsSync(file)) return { changed: false };
  const original = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`\\n?${OUR_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${OUR_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g');
  const text = original.replace(re, '\n');
  if (text === original) return { changed: false };
  fs.writeFileSync(file, text, 'utf8');
  return { changed: true };
}

// 上游自己维护的两个标记（见它源码里的 mcpEntries()）
const UP_BEGIN = '# === qq-bridge MCP BEGIN ===';
const UP_END = '# === qq-bridge MCP END ===';

function rmdirLink(p) {
  try {
    fs.rmdirSync(p); // 对 junction 只删链接本身，不递归进目标
    return true;
  } catch {
    return false;
  }
}

/**
 * 反注册：把我们和上游写进这套 DSH 的东西摘掉，先备份。
 * 不删用户自己的其它条目；只删带标记的那两段 + bundle 依赖 + 两个 junction。
 */
export function unregister({ dshHome, profile, targetDir }) {
  const home = dshHome || resolveDshHome();
  const prof = profile || inspectRegistration({ dshHome: home }).profile;
  if (!prof) return { changed: false, detail: '没有 profile，无需反注册' };

  const profileDir = path.join(home, 'profiles', prof);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const pkgFile = path.join(profileDir, 'package.json');
  const removed = [];

  if (targetDir) {
    const dir = path.join(path.dirname(targetDir), 'data', 'backups', `uninstall-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [src, name] of [[patchFile, 'cordis.patch.yml'], [pkgFile, 'package.json']]) {
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    removed.push(`备份 → ${path.basename(dir)}`);
  }

  // 1. 两段 MCP 标记
  if (fs.existsSync(patchFile)) {
    let text = fs.readFileSync(patchFile, 'utf8');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ourRe = new RegExp(`\\n?${esc(OUR_BEGIN)}[\\s\\S]*?${esc(OUR_END)}\\n?`, 'g');
    const upRe = new RegExp(`\\n?${esc(UP_BEGIN)}[\\s\\S]*?${esc(UP_END)}\\n?`, 'g');
    const before = text;
    text = text.replace(ourRe, '\n').replace(upRe, '\n');
    if (text !== before) {
      fs.writeFileSync(patchFile, text.replace(/\n{3,}/g, '\n\n'), 'utf8');
      removed.push('cordis.patch.yml：摘掉 MCP 条目');
    }
  }

  // 2. profile package.json 里的 bundle
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      let touched = false;
      if (pkg?.dependencies?.surfcore) { delete pkg.dependencies.surfcore; touched = true; }
      if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
        const next = pkg.dsh.profile.bundles.filter((b) => b !== 'surfcore');
        if (next.length !== pkg.dsh.profile.bundles.length) { pkg.dsh.profile.bundles = next; touched = true; }
      }
      if (touched) {
        fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
        removed.push('profile package.json：去掉 surfcore bundle');
      }
    } catch {
      removed.push('profile package.json 解析失败，未改动');
    }
  }

  // 3. 两个 junction
  for (const link of [path.join(home, 'plugins', 'surfcore'), path.join(profileDir, 'node_modules', 'surfcore')]) {
    if (fs.existsSync(link) || (() => { try { fs.lstatSync(link); return true; } catch { return false; } })()) {
      if (rmdirLink(link)) removed.push(`删链接 ${link}`);
    }
  }

  return { changed: removed.length > 0, detail: removed.join('；') || '没有需要摘的东西' };
}

export function resolveDshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function listProfiles(dshHome) {
  try {
    return fs
      .readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 从 cordis.patch.yml 的文本里抠出我们管理的 MCP 条目（不引 yaml 依赖） */
export function parseManagedEntries(text) {
  const entries = [];
  const blocks = String(text ?? '').split(/^\s*-\s+id:\s*/m).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.search(/\s/) >= 0 ? block.search(/\s/) : block.length).trim();
    if (!MANAGED_MCP_IDS.includes(id)) continue;
    // 脚本路径在 config.args 里（形如  args:\n  - 'E:\...\mcp-snowluma-safe.js'），
    // 不是 `script:` —— 那是上游源码里的变量名，不是 YAML 键。
    const paths = [...block.matchAll(/['"]([^'"]+?\.(?:js|mjs|cjs))['"]/g)].map((m) => m[1]);
    const script = paths.find((p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) ?? null;
    entries.push({ id, script });
  }
  return entries;
}

/**
 * 看这套 DSH 现在注册的是谁。
 * @returns {{
 *   dshHome:string, profile:string|null, profiles:string[],
 *   hasProfile:boolean, entries:Array<{id:string,script:string|null}>,
 *   roots:string[], pointsTo:string|null, hasBundle:boolean,
 *   pluginLink:string|null, pluginLinkTarget:string|null,
 * }}
 */
export function inspectRegistration({ dshHome, profile } = {}) {
  const home = dshHome || resolveDshHome();
  const profiles = listProfiles(home);
  const prof = profile || (profiles.includes('desktop') ? 'desktop' : profiles[0] ?? null);
  const profileDir = prof ? path.join(home, 'profiles', prof) : null;
  const patchFile = profileDir ? path.join(profileDir, 'cordis.patch.yml') : null;

  let entries = [];
  if (patchFile && fs.existsSync(patchFile)) {
    try {
      entries = parseManagedEntries(fs.readFileSync(patchFile, 'utf8'));
    } catch {
      entries = [];
    }
  }

  const roots = [...new Set(entries.map((e) => (e.script ? path.dirname(path.dirname(e.script)) : null)).filter(Boolean))];

  let hasBundle = false;
  if (profileDir) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      hasBundle = (pkg?.dsh?.profile?.bundles ?? []).includes('surfcore') || Boolean(pkg?.dependencies?.surfcore);
    } catch {
      /* 没有 package.json 就当没注册 */
    }
  }

  const linkPath = path.join(home, 'plugins', 'surfcore');
  let linkTarget = null;
  try {
    linkTarget = fs.realpathSync(linkPath);
  } catch {
    linkTarget = null;
  }

  return {
    dshHome: home,
    profile: prof,
    profiles,
    hasProfile: Boolean(prof),
    entries,
    roots,
    pointsTo: roots.length === 1 ? roots[0] : null,
    hasBundle,
    pluginLink: fs.existsSync(linkPath) ? linkPath : null,
    pluginLinkTarget: linkTarget,
  };
}

function samePath(a, b) {
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  } catch {
    return false;
  }
}

function runNode(args, { cwd, env, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

function backupProfile({ dshHome, profile, targetDir }) {
  const dir = path.join(targetDir, 'data', 'backups', `dsh-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const profileDir = path.join(dshHome, 'profiles', profile);
  for (const name of ['cordis.patch.yml', 'package.json']) {
    const src = path.join(profileDir, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  }
  return dir;
}

/**
 * 注册。默认拒绝抢占别人的注册。
 * @returns {Promise<{status:'ok'|'skipped'|'conflict'|'failed', detail:string, backup?:string, inspected:object}>}
 */
export async function register({ appDir, dshHome, profile, force = false, stt = null, event = () => {}, log = () => {} }) {
  const before = inspectRegistration({ dshHome, profile });

  if (!before.hasProfile) {
    return { status: 'skipped', detail: `没找到 DSH profile（${before.dshHome} 下没有 profiles/*），先装 DSH 再来`, inspected: before };
  }

  const ourApp = path.resolve(appDir);
  const alreadyOurs = before.pointsTo && samePath(before.pointsTo, ourApp) && before.hasBundle;
  if (alreadyOurs) {
    return { status: 'ok', detail: `已注册并指向 ${ourApp}，无需改动`, inspected: before };
  }

  const conflicts = before.roots.filter((r) => !samePath(r, ourApp));
  if (conflicts.length && !force) {
    return {
      status: 'conflict',
      detail: `这套 DSH 已经注册了另一套 SurfCore：${conflicts.join(', ')}。为免抢走它，默认不动。确认要改成 ${ourApp} 再勾「强制改指向」。`,
      inspected: before,
    };
  }

  const setupScript = path.join(appDir, 'scripts', 'setup-dsh.mjs');
  if (!fs.existsSync(setupScript)) {
    return { status: 'failed', detail: `上游缺少 scripts/setup-dsh.mjs（版本不符？）`, inspected: before };
  }
  // 上游脚本 import js-yaml；没装依赖时它会直接崩，给个能看懂的提示而不是 exit code
  if (!fs.existsSync(path.join(appDir, 'node_modules', 'js-yaml'))) {
    return {
      status: 'skipped',
      detail: '依赖还没装（setup-dsh.mjs 需要 js-yaml），先跑完 npm ci 再注册',
      inspected: before,
    };
  }

  const backup = backupProfile({ dshHome: before.dshHome, profile: before.profile, targetDir: path.dirname(appDir) });
  log(`已备份 DSH 配置到 ${backup}`);

  const env = {
    ...process.env,
    DSH_HOME: before.dshHome,
    // 不让上游顺手跑 `dsh plugin install`（那需要 dsh CLI；失败会误导用户）
    QQ_BRIDGE_SKIP_DSH_INSTALL: '1',
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  event({ type: 'step', id: 'register', status: 'running', message: `写入 profile ${before.profile}` });
  const r = await runNode([setupScript, before.profile], { cwd: appDir, env });
  for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
    if (line.trim()) event({ type: 'log', id: 'register', line: line.trim() });
  }

  const after = inspectRegistration({ dshHome: before.dshHome, profile: before.profile });
  const ok = after.entries.length === MANAGED_MCP_IDS.length && after.pointsTo && samePath(after.pointsTo, ourApp) && after.hasBundle;

  if (!ok) {
    return {
      status: 'failed',
      detail: `上游脚本退出码 ${r.code}，但注册没落地（MCP ${after.entries.length}/${MANAGED_MCP_IDS.length}，bundle=${after.hasBundle}）`,
      backup,
      inspected: after,
    };
  }

  // 上游那段写好了，再挂我们自己的 STT 工具（单独一段，互不影响）
  let sttNote = '';
  if (stt?.scriptPath && stt?.targetDir) {
    try {
      const r2 = ensureOurMcp({ dshHome: before.dshHome, profile: before.profile, targetDir: stt.targetDir, scriptPath: stt.scriptPath });
      sttNote = r2.changed ? '，另挂 mcp-stt（语音转文字）' : '，mcp-stt 已是最新';
    } catch (error) {
      sttNote = `，但 mcp-stt 没挂上：${error.message}`;
    }
  }

  return {
    status: 'ok',
    detail: `已写入 ${after.profile}：${after.entries.length} 个 MCP + bundle${sttNote}，备份在 ${path.basename(backup)}`,
    backup,
    inspected: after,
  };
}
