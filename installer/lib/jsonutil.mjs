// JSON 读取的容错层：Windows 上记事本存 UTF-8 默认带 BOM，
// 直接 JSON.parse 会炸在第一个字符上。用户手改配置一定会遇到，所以统一入口。

import fs from 'node:fs';

export function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

export function readJson(file) {
  return parseJson(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
