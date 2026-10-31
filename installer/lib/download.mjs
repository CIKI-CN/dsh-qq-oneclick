// 下载与校验：流式写盘 + 边下边算 sha256 + 原子落盘。
// 设计原则：下不动就明确失败，绝不写入半截文件让后面「看起来装好了」。

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

const MAX_REDIRECTS = 6;

function openStream(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: { 'user-agent': 'dsh-qq-oneclick', accept: '*/*' },
        timeout: 30000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('重定向次数过多'));
          return resolve(openStream(new URL(location, url).toString(), redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`下载失败：HTTP ${status} ${url}`));
        }
        resolve(res);
      },
    );
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

/**
 * @param {string} url
 * @param {string} dest 目标文件（会先写 dest.partial）
 * @param {{expectSha256?:string|null, onProgress?:(p:{received:number,total:number})=>void, log?:(m:string)=>void}} opts
 * @returns {Promise<{path:string, bytes:number, sha256:string}>}
 */
export async function downloadTo(url, dest, { expectSha256 = null, onProgress, log = () => {} } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;

  const res = await openStream(url);
  const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    res.on('data', (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      if (onProgress) onProgress({ received, total });
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  const sha256 = hash.digest('hex');
  if (expectSha256 && sha256 !== expectSha256) {
    fs.rmSync(partial, { force: true });
    throw new Error(`校验失败：期望 sha256=${expectSha256}，实际 ${sha256}\n上游可能重新打包过；维护者请跑 node scripts/fetch-pins.mjs 重新固定。`);
  }

  fs.renameSync(partial, dest);
  log(`下载完成 ${(received / 1024 / 1024).toFixed(1)} MB，sha256 ${sha256.slice(0, 12)}…`);
  return { path: dest, bytes: received, sha256 };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
