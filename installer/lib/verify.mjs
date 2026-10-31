// 装完自检：六项，每项都要有可执行的结论，不许「应该没问题」。
// 判据是可观察的事实：文件在不在、包数够不够、JSON 能不能解析、注册指向哪、端口能不能拿。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { readJson } from './jsonutil.mjs';
import { inspectRegistration } from './dsh.mjs';

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * @param {{targetDir:string, dshHome?:string, profile?:string}} opts
 * @returns {Promise<{at:string, results:Array<{id:string,label:string,status:string,detail:string,fix:string}>, summary:object}>}
 */
export async function verifyInstall({ targetDir, dshHome, profile } = {}) {
  const app = path.join(targetDir, 'app');
  const data = path.join(targetDir, 'data');
  const results = [];
  const add = (id, label, status, detail, fix = '') => results.push({ id, label, status, detail, fix });

  // 1. 文件完整
  const bridge = path.join(app, 'src', 'bridge.js');
  const pkgFile = path.join(app, 'package.json');
  if (fs.existsSync(bridge) && fs.existsSync(pkgFile)) {
    let version = '?';
    try {
      version = readJson(pkgFile).version ?? '?';
    } catch {
      /* 版本读不到不影响这项 */
    }
    add('files', '程序文件', 'ok', `v${version}，入口 src/bridge.js 在位`);
  } else {
    add('files', '程序文件', 'fail', '缺少 src/bridge.js 或 package.json', '重跑安装（会在 app.new 里重新解包）');
  }

  // 2. 依赖完整（上游 128 个包；阈值取 50 容忍上游裁剪）
  const nm = path.join(app, 'node_modules');
  let count = 0;
  try {
    count = fs.readdirSync(nm, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
  } catch {
    count = 0;
  }
  const hasSdk = fs.existsSync(path.join(nm, '@snowluma', 'sdk'));
  if (count >= 50 && hasSdk) {
    add('deps', '依赖完整', 'ok', `${count} 个包，@snowluma/sdk 在位`);
  } else {
    add('deps', '依赖完整', 'fail', `只有 ${count} 个包${hasSdk ? '' : '，且缺 @snowluma/sdk'}`, '重跑安装（会重跑 npm ci）');
  }

  // 3. 配置可解析且关键字段合理
  const cfgFile = path.join(app, 'config.json');
  try {
    const cfg = readJson(cfgFile);
    const owner = cfg.ownerQQ;
    const groups = cfg.allow?.groups ?? [];
    if (!owner) {
      add('config', '配置', 'warn', `config.json 能解析，但没有 ownerQQ`, '在设置中心填管理员 QQ，否则审批/管理命令不可用');
    } else if (!groups.length && !(cfg.allow?.private ?? []).length) {
      add('config', '配置', 'warn', `ownerQQ=${owner}，但白名单为空（=谁都不理）`, '在设置中心把要用的群/私聊加进白名单');
    } else {
      add('config', '配置', 'ok', `ownerQQ=${owner}，群 ${groups.length} / 私聊 ${(cfg.allow?.private ?? []).length}`);
    }
  } catch (error) {
    add('config', '配置', 'fail', `config.json 读不出：${error.message}`, '重跑安装或从 data/backups 恢复');
  }

  // 4. DSH 注册
  const reg = inspectRegistration({ dshHome, profile });
  if (!reg.hasProfile) {
    add('dsh', 'DSH 注册', 'skip', '本机没有 DSH profile，跳过', '装好 DSH 后回来点「注册」');
  } else {
    const ours = reg.entries.length === 3 && reg.pointsTo && path.resolve(reg.pointsTo).toLowerCase() === path.resolve(app).toLowerCase();
    if (ours && reg.hasBundle) add('dsh', 'DSH 注册', 'ok', `${reg.entries.length} 个 MCP + bundle → ${reg.profile}`);
    else if (reg.roots.length) add('dsh', 'DSH 注册', 'warn', `已注册，但指向 ${reg.roots.join(', ')}`, '点「注册」改成当前安装目录（会先备份）');
    else add('dsh', 'DSH 注册', 'warn', `profile ${reg.profile} 里没有 SurfCore 条目`, '点「注册」写入');
  }

  // 5. 清单一致
  try {
    const m = readJson(path.join(data, 'manifest.json'));
    if (m?.surfcore?.sha256 && m?.surfcore?.version) add('manifest', '安装清单', 'ok', `${m.surfcore.version} / sha256 ${String(m.surfcore.sha256).slice(0, 10)}…`);
    else add('manifest', '安装清单', 'warn', 'manifest.json 缺版本或校验和', '重跑安装生成');
  } catch {
    add('manifest', '安装清单', 'fail', '没有 data/manifest.json', '重跑安装');
  }

  // 6. 端口：3000/3001 应可用（SnowLuma 自己的），3100 应可用（控制台）
  const ports = await Promise.all([3000, 3001, 3100].map(async (p) => [p, await portFree(p)]));
  const busy = ports.filter(([, free]) => !free).map(([p]) => p);
  if (busy.length === 0) add('ports', '端口', 'ok', '3000 / 3001 / 3100 都空闲');
  else if (busy.length === 3) add('ports', '端口', 'warn', '3000/3001/3100 都被占用', '如果占用者就是已经在跑的 SnowLuma/SurfCore，属正常');
  else add('ports', '端口', 'warn', `${busy.join('/')} 被占用`, '确认占用者是谁；若是别的程序，桥接会连不上');

  const summary = {
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
  return { at: new Date().toISOString(), results, summary };
}
