// 安装状态：一个 JSON 文件，原子写，关掉向导再打开能接着走。
// 约定：任何字段的修改都走 save()，不要直接写文件，避免半截 JSON。

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

function defaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    // 步骤号：0 环境检测 / 1 出处与许可 / 2 安装位置 / 3 选功能 / 4 配置 / 5 确认安装
    step: 0,
    // 已完成的步骤 id，用于「已装的能跳过、未装的能补」
    completed: [],
    // 同意出处与许可的时间戳；没有它不允许下一步
    consent: null,
    targetDir: '',
    preset: 'min',
    selected: [],
    config: {
      ownerQQ: '',
      groups: [],
      privates: [],
      snowluma: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', accessToken: '', homeDir: '', launcherPath: '' },
      consoleToken: '',
    },
    detect: null,
    // 装完是否注册进 DSH（写 profile 的 cordis.patch.yml + bundle），以及是否允许改指向
    register: true,
    forceRepoint: false,
    // 装完之后由安装任务写入：{version, at, targetDir}
    installed: null,
    log: [],
  };
}

export function dataDir(root) {
  return path.join(root, 'data');
}

export function stateFile(root) {
  return path.join(dataDir(root), 'install-state.json');
}

/** 浅合并 + config 深一层合并（其余字段整体替换，避免数组被错误拼接） */
function merge(cur, patch) {
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'config' && v && typeof v === 'object' && !Array.isArray(v)) {
      next.config = { ...cur.config, ...v };
      if (v.snowluma && typeof v.snowluma === 'object') {
        next.config.snowluma = { ...cur.config.snowluma, ...v.snowluma };
      }
    } else {
      next[k] = v;
    }
  }
  return next;
}

export function load(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return merge(defaults(), raw);
  } catch {
    return defaults();
  }
}

export function save(root, patch) {
  const next = merge(load(root), patch);
  next.schemaVersion = SCHEMA_VERSION;
  next.updatedAt = new Date().toISOString();
  if (Array.isArray(next.log) && next.log.length > 200) {
    next.log = next.log.slice(-200);
  }
  writeAtomic(stateFile(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function appendLog(root, message) {
  const cur = load(root);
  const log = Array.isArray(cur.log) ? cur.log : [];
  log.push({ at: new Date().toISOString(), message: String(message).slice(0, 500) });
  save(root, { log });
}

/** 先写临时文件再 rename：断电/强杀也不会留下半截 JSON */
export function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
