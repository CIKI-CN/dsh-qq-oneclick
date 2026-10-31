// 卸载：先摘 DSH 注册，再删文件。分三档，默认保守。
//   默认        只删程序（app/ runtime/ cache/），保留 data/ 与 ~/.dsh/surfcore 的记忆
//   --purge     连 data/ 一起删
//   --purge-all 再删 ~/.dsh/surfcore（角色/记忆/B站凭据），必须再加 --yes

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bridgeStatus, stopBridge, pathsFor } from './lib/appconfig.mjs';
import { unregister, inspectRegistration } from './lib/dsh.mjs';
import { readJson } from './lib/jsonutil.mjs';
import { load as loadState } from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

function targetFromArgument() {
  if (has('from-state')) {
    const st = loadState(PROJECT_ROOT);
    return st.installed?.targetDir || st.targetDir || null;
  }
  return arg('target');
}

async function main() {
  const targetDir = targetFromArgument();
  if (!targetDir) {
    console.error('用法：node installer/uninstall.mjs --from-state | --target <安装目录> [--purge | --purge-all --yes]');
    process.exit(2);
  }
  if (!fs.existsSync(targetDir)) {
    console.error(`目录不存在：${targetDir}`);
    process.exit(1);
  }

  const p = pathsFor(targetDir);
  let manifest = null;
  try {
    manifest = readJson(path.join(p.data, 'manifest.json'));
  } catch {
    /* 没清单也允许卸，只是不知道版本 */
  }

  console.log(`卸载目标：${targetDir}${manifest ? `（${manifest.surfcore?.version}）` : ''}`);

  // 1. 桥接
  const st = await bridgeStatus(targetDir);
  if (st.ours) {
    const r = await stopBridge(targetDir);
    console.log(`桥接：${r.stopped ? `已停止 pid ${r.pid}` : r.reason}`);
  } else if (st.consoleOpen) {
    console.log('桥接：3100 上有别的进程，不动它');
  }

  // 2. DSH 反注册
  const profile = manifest?.dsh?.profile || inspectRegistration({}).profile;
  if (profile) {
    const r = unregister({ dshHome: undefined, profile, targetDir });
    console.log(`DSH 注册：${r.changed ? r.detail : r.detail}`);
  }

  // 3. 文件
  const programDirs = ['app', 'runtime', 'cache'];
  for (const d of programDirs) {
    const dir = path.join(targetDir, d);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`删除 ${d}/`);
    }
  }

  if (has('purge') || has('purge-all')) {
    const data = path.join(targetDir, 'data');
    if (fs.existsSync(data)) {
      fs.rmSync(data, { recursive: true, force: true });
      console.log('删除 data/（配置与备份）');
    }
  } else {
    console.log('保留 data/（配置与备份）。要一起删加 --purge');
  }

  if (has('purge-all')) {
    if (!has('yes')) {
      console.log('!! 加 --yes 才会删 ~/.dsh/surfcore（角色 / 记忆 / B站凭据）。这次没删。');
    } else {
      const home = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'surfcore');
      if (fs.existsSync(home)) {
        fs.rmSync(home, { recursive: true, force: true });
        console.log('删除 ~/.dsh/surfcore（记忆与角色已清空）');
      }
    }
  }

  // 4. 收尾
  const left = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];
  console.log(left.length ? `\n目录里还留着：${left.join(', ')}` : `\n${targetDir} 已清空，可以手动删掉这个空目录`);
  console.log('提示：本安装器自己的文件夹（你双击的那个）不在删除范围内，用不到时直接删。');
}

main().catch((error) => {
  console.error(`卸载失败：${error.message}`);
  process.exit(1);
});
