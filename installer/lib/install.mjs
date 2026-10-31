// 安装核心：预检 → 拉取 → 校验 → 解包 → 装依赖 → 写配置 → 写清单。
// 失败一律回滚到「装之前」的样子：不留下半个 app/，也不动已有记忆。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadTo, sha256File } from './download.mjs';
import { extractTarGz, extractWithTar } from './extract.mjs';
import { ensureNpm, runNpm } from './npm.mjs';
import { ensureStt } from './stt.mjs';
import { register } from './dsh.mjs';
import { verifyInstall } from './verify.mjs';
import { readJson } from './jsonutil.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export function loadSources() {
  return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'sources.json'), 'utf8'));
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 把向导里的最小配置翻译成上游 config.json 的补丁（不碰模板） */
export function buildConfigPatch(minimal = {}) {
  const patch = {};
  if (minimal.ownerQQ) patch.ownerQQ = Number(minimal.ownerQQ) || minimal.ownerQQ;
  if (minimal.groups || minimal.privates) {
    patch.allow = {
      groups: (minimal.groups ?? []).map((g) => Number(g) || g),
      private: (minimal.privates ?? []).map((p) => Number(p) || p),
    };
  }
  if (minimal.snowluma) {
    patch.snowluma = {
      wsUrl: minimal.snowluma.wsUrl,
      httpUrl: minimal.snowluma.httpUrl,
      accessToken: minimal.snowluma.accessToken,
    };
    // 用户自己解压的 SnowLuma 目录（我们不下载、不部署，只帮他记住路径）
    if (minimal.snowluma.homeDir) patch.snowluma.homeDir = minimal.snowluma.homeDir;
    if (minimal.snowluma.launcherPath) patch.snowluma.launcherPath = minimal.snowluma.launcherPath;
  }
  if (minimal.consoleToken) patch.consoleToken = minimal.consoleToken;
  return patch;
}

export function buildConfig(template, minimal) {
  return deepMerge(template, buildConfigPatch(minimal));
}

function dirSizeMb(dir) {
  try {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(dir);
    return Math.round((total / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * @param {{
 *   targetDir:string,
 *   minimalConfig?:object,
 *   features?:{preset?:string|null, selected?:string[]},
 *   event?:(e:object)=>void,
 *   log?:(m:string)=>void,
 *   skipDeps?:boolean,
 *   archive?:string|null,
 *   sources?:object,
 * }} opts
 */
export async function install({
  targetDir,
  minimalConfig = {},
  features = {},
  event = () => {},
  log = () => {},
  skipDeps = false,
  archive = null,
  sources = loadSources(),
  registerDsh = true,
  forceRepoint = false,
  dshHome = undefined,
  profile = undefined,
} = {}) {
  if (!targetDir) throw new Error('没有安装目录');
  const pin = sources.sources.surfcore;
  const app = path.join(targetDir, 'app');
  const data = path.join(targetDir, 'data');
  const runtime = path.join(targetDir, 'runtime');
  const cache = path.join(targetDir, 'cache');

  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });

  // 安装前的状态快照，用于回滚
  const manifestExisted = fs.existsSync(path.join(data, 'manifest.json'));
  let swapped = false;

  const step = (id, status, message, extra = {}) => event({ type: 'step', id, status, message, ...extra });

  try {
    // 1. 预检
    step('preflight', 'running', '检查安装目录与已有安装');
    if (fs.existsSync(app) && !manifestExisted) {
      const entries = fs.readdirSync(app);
      if (entries.length > 0) {
        throw new Error(`目标目录里的 app\\ 不是本安装器装的（没有 data/manifest.json），拒绝覆盖：${app}`);
      }
    }
    step('preflight', 'ok', `目标：${targetDir}${manifestExisted ? '（已装过，走修复）' : ''}`);

    // 2. 取包
    step('fetch', 'running', archive ? '使用本地归档' : `下载 ${pin.name} ${pin.tag}`);
    const archivePath = archive ?? path.join(cache, `surfcore-${pin.tag}.tar.gz`);
    if (!archive) {
      const cached = fs.existsSync(archivePath) && pin.sha256 && (await sha256File(archivePath)) === pin.sha256;
      if (!cached) {
        if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true });
        await downloadTo(pin.url, archivePath, {
          expectSha256: pin.sha256,
          log,
          onProgress: ({ received, total }) =>
            event({ type: 'progress', id: 'fetch', received, total: total || pin.bytes || 0 }),
        });
      } else {
        log('复用缓存，sha256 一致');
      }
    }
    step('fetch', 'ok', archive ? archive : `已就绪（${(fs.statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB）`);

    // 3. 校验
    step('checksum', 'running', '校验 sha256');
    const actual = await sha256File(archivePath);
    if (pin.sha256 && actual !== pin.sha256) {
      throw new Error(`sha256 不符：期望 ${pin.sha256}，实际 ${actual}`);
    }
    step('checksum', 'ok', actual.slice(0, 16) + '…');

    // 4. 解包（先解到临时目录，成功了再换）
    step('extract', 'running', '解包');
    const staging = path.join(targetDir, 'app.new');
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      extractTarGz(archivePath, staging, { stripPrefix: pin.stripPrefix ?? 1, log });
    } catch (error) {
      log(`内置解包失败（${error.message}），改用 tar.exe`);
      fs.rmSync(staging, { recursive: true, force: true });
      await extractWithTar(archivePath, staging, pin.stripPrefix ?? 1);
    }
    if (!fs.existsSync(path.join(staging, 'package.json'))) {
      throw new Error('解包后没有 package.json —— 归档结构变了，请检查 sources.json 的 stripPrefix');
    }

    // 5. 换目录（旧 app 先留成 app.bak，失败可还原）
    const backup = path.join(targetDir, 'app.bak');
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(app)) fs.renameSync(app, backup);
    fs.renameSync(staging, app);
    swapped = true;
    step('extract', 'ok', `已安装到 ${app}（${dirSizeMb(app)} MB）`);

    // 6. 依赖
    if (skipDeps) {
      step('deps', 'skip', '按要求跳过（--skip-deps）');
    } else {
      step('deps', 'running', '准备 npm');
      const npm = await ensureNpm({ runtimeDir: runtime, sources, event, log });
      log(`使用 npm：${npm.source}`);
      step('deps', 'running', `npm ci（这一步最久，别关窗口）`);
      const t0 = Date.now();
      await runNpm(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: app,
        onLine: (line) => event({ type: 'log', id: 'deps', line }),
      });
      step('deps', 'ok', `依赖装完（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    }

    // 7. 配置
    // 真相源是 app/config.json —— 上游所有读取和回写（token 自愈、控制台改白名单）都指向它。
    // 升级时它随旧 app 一起被挪到 app.bak，必须捞回来，否则一次升级就丢了白名单和 token。
    step('configure', 'running', '写配置');
    const templatePath = path.join(app, 'config.example.json');
    const template = fs.existsSync(templatePath) ? readJson(templatePath) : {};
    const configPath = path.join(app, 'config.json');
    const oldConfigPath = path.join(targetDir, 'app.bak', 'config.json');
    const carried = fs.existsSync(oldConfigPath) ? readJson(oldConfigPath) : null;
    if (carried) {
      const backupPath = path.join(data, 'config.bak', `${Date.now()}.json`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, `${JSON.stringify(carried, null, 2)}\n`, 'utf8');
      log(`沿用旧配置（已备份到 ${path.relative(targetDir, backupPath)}）`);
    }
    const merged = deepMerge(carried ?? template, buildConfigPatch(minimalConfig));
    fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    step('configure', 'ok', path.relative(targetDir, configPath) + (carried ? '（已沿用旧配置）' : ''));

    // 7.5 语音转文字（可选；我们自己加的能力，不动上游）
    let sttInfo = null;
    const wantsStt = (features.selected ?? []).includes('B9');
    if (wantsStt) {
      step('stt', 'running', '安装语音转文字（whisper.cpp）');
      try {
        const r = await ensureStt({ targetDir, model: 'tiny', sources, event, log });
        // MCP server 拷进安装目录：安装器以后被移动/删除也不影响已装的实例
        const src = path.join(PROJECT_ROOT, 'installer', 'stt', 'mcp-stt-server.mjs');
        const dst = path.join(targetDir, 'runtime', 'stt', 'mcp-stt-server.mjs');
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        sttInfo = { scriptPath: dst, targetDir, bin: r.bin, model: r.model, modelName: r.modelName };
        step('stt', 'ok', `whisper + ${r.modelName} 就绪${r.reused ? '（复用已有）' : ''}`);
      } catch (error) {
        step('stt', 'warn', `语音转文字没装上：${error.message}（不影响其它功能）`);
      }
    } else {
      step('stt', 'skip', '未选语音转文字');
    }

    // 8. 注册进 DSH（可选；失败不影响「程序已经装好」这个事实）
    let registration = { status: 'skipped', detail: '按设置跳过' };
    if (registerDsh) {
      step('register', 'running', '注册进 DSH');
      try {
        registration = await register({
          appDir: app,
          dshHome,
          profile,
          force: forceRepoint,
          stt: sttInfo,
          event,
          log,
        });
      } catch (error) {
        registration = { status: 'failed', detail: error?.message ?? String(error) };
      }
      const statusMap = { ok: 'ok', skipped: 'skip', conflict: 'warn', failed: 'warn' };
      step('register', statusMap[registration.status] ?? 'warn', registration.detail);
    } else {
      step('register', 'skip', '按设置跳过注册');
    }

    // 9. 清单（先落地版本与校验和，自检要读它）
    step('manifest', 'running', '写安装清单');
    const manifest = {
      name: 'DSH一键式接入QQ',
      installerVersion: readJson(path.join(PROJECT_ROOT, 'package.json')).version,
      installedAt: new Date().toISOString(),
      targetDir,
      surfcore: {
        version: pin.tag,
        commit: pin.commit,
        repo: pin.repo,
        sourceUrl: pin.url,
        sha256: actual,
        bytes: fs.statSync(archivePath).size,
      },
      features: { preset: features.preset ?? null, selected: features.selected ?? [] },
      paths: { app, data, runtime, config: configPath },
      dsh: { registered: registration.status === 'ok', status: registration.status, detail: registration.detail, profile },
      stt: sttInfo ? { installed: true, model: sttInfo.modelName, bin: sttInfo.bin } : null,
    };
    const manifestPath = path.join(data, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // 10. 自检（必须在清单写完之后：它要核对清单本身）
    step('verify', 'running', '装完自检');
    const check = await verifyInstall({ targetDir, dshHome, profile });
    step('verify', check.summary.fail ? 'warn' : 'ok', `ok=${check.summary.ok} warn=${check.summary.warn} fail=${check.summary.fail}${check.summary.skip ? ` skip=${check.summary.skip}` : ''}`);

    // 把自检结论回写进清单
    manifest.verify = check;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    step('manifest', 'ok', 'done');

    fs.rmSync(backup, { recursive: true, force: true });
    event({ type: 'done', manifest });
    return manifest;
  } catch (error) {
    // 回滚
    log(`失败，开始回滚：${error.message}`);
    try {
      if (swapped && fs.existsSync(app)) fs.rmSync(app, { recursive: true, force: true });
      const backup = path.join(targetDir, 'app.bak');
      if (fs.existsSync(backup)) fs.renameSync(backup, app);
      fs.rmSync(path.join(targetDir, 'app.new'), { recursive: true, force: true });
    } catch (rollbackError) {
      log(`回滚也失败了：${rollbackError.message}`);
    }
    event({ type: 'error', message: error.message });
    throw error;
  }
}

// —— CLI：给自己和 CI 用，向导走 HTTP 调用同一个函数 ——
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const targetDir = arg('target');
  if (!targetDir) {
    console.log('用法：node installer/lib/install.mjs --target <目录> [--archive <本地包>] [--skip-deps] [--config <json>]');
    process.exit(2);
  }
  const minimal = arg('config') ? readJson(arg('config')) : {};
  const selected = (arg('features') ?? 'B1,B2,B3,B4,B5,B6,C1,E4').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    await install({
      targetDir: path.resolve(targetDir),
      minimalConfig: minimal,
      features: { preset: arg('preset') ?? 'min', selected },
      skipDeps: process.argv.includes('--skip-deps'),
      archive: arg('archive') ? path.resolve(arg('archive')) : null,
      log: (m) => console.log(`  · ${m}`),
      event: (e) => {
        if (e.type === 'step') console.log(`[${e.status}] ${e.id}: ${e.message}`);
        else if (e.type === 'progress' && e.total) process.stdout.write(`\r  ${((e.received / e.total) * 100).toFixed(0)}%   `);
      },
    });
    console.log('\n✅ 安装完成');
  } catch (error) {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  }
}
