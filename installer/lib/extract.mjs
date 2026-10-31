// 解包：.tar.gz 纯 JS 解析（zlib + tar 块），失败再回落系统 tar.exe。
// 不用第三方包；路径做了穿越防护（拒绝 .. 与绝对路径）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';

const BLOCK = 512;

function readOctal(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  return raw ? parseInt(raw, 8) : 0;
}

function readString(buf, offset, length) {
  return buf.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
}

/** pax 扩展头：格式 "<len> <key>=<value>\n" */
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i);
    if (space < 0) break;
    const len = parseInt(buf.subarray(i, space).toString('ascii'), 10);
    if (!len || Number.isNaN(len)) break;
    const record = buf.subarray(space + 1, i + len - 1).toString('utf8'); // 去掉结尾 \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

function safeJoin(destRoot, relPath, stripPrefix) {
  const parts = relPath.split('/').filter(Boolean);
  const stripped = parts.slice(stripPrefix);
  if (!stripped.length) return null;
  if (stripped.some((p) => p === '..' || p === '.' || /^[a-zA-Z]:$/.test(p))) {
    throw new Error(`拒绝可疑路径：${relPath}`);
  }
  const target = path.join(destRoot, ...stripped);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(destRoot) + path.sep)) {
    throw new Error(`路径越界：${relPath}`);
  }
  return resolved;
}

/**
 * @param {string} archive .tar.gz 路径
 * @param {string} destDir 解到哪
 * @param {{stripPrefix?:number, log?:(m:string)=>void}} opts
 */
export function extractTarGz(archive, destDir, { stripPrefix = 0, log = () => {} } = {}) {
  const gz = fs.readFileSync(archive);
  const tar = zlib.gunzipSync(gz);
  fs.mkdirSync(destDir, { recursive: true });

  let offset = 0;
  let files = 0;
  let dirs = 0;
  let pendingPath = null;
  let pendingLink = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;

    let name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156]) || '0';
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;

    if (type === 'L') {
      pendingPath = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'K') {
      pendingLink = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }
    if (type === 'x' || type === 'g') {
      const pax = parsePax(tar.subarray(dataStart, dataEnd));
      if (pax.path) pendingPath = pax.path;
      if (pax.linkpath) pendingLink = pax.linkpath;
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    const fullName = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;

    if (type === '5' || fullName.endsWith('/')) {
      const dir = safeJoin(destDir, fullName, stripPrefix);
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        dirs++;
      }
    } else if (type === '0' || type === '\0' || type === '7') {
      const file = safeJoin(destDir, fullName, stripPrefix);
      if (file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, tar.subarray(dataStart, dataEnd));
        const mode = readOctal(header, 100, 8);
        if (mode & 0o111) {
          try {
            fs.chmodSync(file, 0o755);
          } catch {
            /* Windows 上可能不支持，忽略 */
          }
        }
        files++;
      }
    }
    // 其余类型（硬链接、设备等）跳过：GitHub 归档里不会有

    // 注意：offset 必须从 dataStart 起算并按 512 向上取整；
    // 写成 dataEnd + 补齐长度会把数据块算两遍，导致第二个条目就错位。
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  log(`解包完成：${files} 个文件、${dirs} 个目录`);
  return { files, dirs };
}

/** 回落：系统 tar.exe（Windows 10 1803+ 自带 bsdtar） */
export function extractWithTar(archive, destDir, stripPrefix = 0) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const args = ['-xzf', archive, '-C', destDir];
    if (stripPrefix) args.push(`--strip-components=${stripPrefix}`);
    execFile('tar', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`tar 解包失败：${stderr || error.message}`));
      resolve({ files: -1, dirs: -1, via: 'tar.exe' });
    });
  });
}

/** zip 解包：bsdtar 能解 zip；没有 tar 就用 PowerShell Expand-Archive */
export function extractZip(archive, destDir, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile('tar', ['-xf', archive, '-C', destDir], { windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ via: 'tar.exe' });
      log(`bsdtar 解 zip 失败（${String(stderr || error.message).trim()}），改用 Expand-Archive`);
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`],
        { windowsHide: true, timeout: 180000 },
        (err2, out2, errout2) => {
          if (err2) return reject(new Error(`zip 解包失败：${String(errout2 || err2.message).trim()}`));
          resolve({ via: 'Expand-Archive' });
        },
      );
    });
  });
}
