// 语音转文字（STT）：本地 whisper.cpp。
//
// 为什么是"我们自己的东西"：上游没有任何 STT 能力，也不会去改它——
// 我们把 whisper 跑起来，通过一个**独立的 MCP server** 暴露给 agent。
// 这样升级上游不会冲掉我们，卸载也只是去掉一条 MCP 条目。
//
// 体积：二进制 8.5 MB（CPU 版）+ 模型 74 MB（tiny）。模型可选，越大越准。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { downloadTo } from './download.mjs';
import { extractZip } from './extract.mjs';

const MODELS = {
  tiny: { file: 'ggml-tiny.bin', label: 'tiny（74 MB，快，够用）' },
  base: { file: 'ggml-base.bin', label: 'base（142 MB，更准）' },
};

export function sttPaths(targetDir) {
  const root = path.join(targetDir, 'runtime', 'stt');
  return {
    root,
    bin: path.join(root, 'whisper', 'Release', 'whisper-cli.exe'),
    binDir: path.join(root, 'whisper'),
    models: path.join(root, 'models'),
    cache: path.join(targetDir, 'cache'),
  };
}

export function sttStatus(targetDir) {
  const p = sttPaths(targetDir);
  const models = fs.existsSync(p.models)
    ? fs.readdirSync(p.models).filter((f) => f.endsWith('.bin'))
    : [];
  return {
    installed: fs.existsSync(p.bin) && models.length > 0,
    bin: fs.existsSync(p.bin) ? p.bin : null,
    models,
    modelDir: p.models,
  };
}

/**
 * 下载并解包 whisper 二进制 + 模型。已存在且校验通过就跳过。
 * @returns {Promise<{ok:boolean, bin:string, model:string, modelName:string, reused:boolean}>}
 */
export async function ensureStt({ targetDir, model = 'tiny', sources, event = () => {}, log = () => {} }) {
  const p = sttPaths(targetDir);
  const binPin = sources?.sources?.whisper;
  const modelPin = sources?.sources?.[`whisper-model-${model}`];
  if (!binPin?.url || !modelPin?.url) throw new Error(`sources.json 里没有 whisper / whisper-model-${model}`);

  fs.mkdirSync(p.cache, { recursive: true });
  fs.mkdirSync(p.models, { recursive: true });

  // 1. 二进制
  let reused = true;
  if (!fs.existsSync(p.bin)) {
    reused = false;
    const zip = path.join(p.cache, 'whisper-bin-x64.zip');
    event({ type: 'step', id: 'stt', status: 'running', message: `下载 whisper 二进制（${Math.round(binPin.bytes / 1024 / 1024)} MB）` });
    if (!fs.existsSync(zip)) {
      await downloadTo(binPin.url, zip, {
        expectSha256: binPin.sha256,
        log,
        onProgress: ({ received, total }) => event({ type: 'progress', id: 'stt-bin', received, total: total || binPin.bytes }),
      });
    }
    fs.rmSync(p.binDir, { recursive: true, force: true });
    await extractZip(zip, p.binDir, { log });
    if (!fs.existsSync(p.bin)) throw new Error(`解包后找不到 whisper-cli.exe（预期在 ${p.bin}）`);
    log('whisper 二进制就绪');
  }

  // 2. 模型
  const modelFile = path.join(p.models, MODELS[model]?.file ?? `ggml-${model}.bin`);
  if (!fs.existsSync(modelFile)) {
    reused = false;
    event({ type: 'step', id: 'stt', status: 'running', message: `下载语音模型 ${model}（${Math.round(modelPin.bytes / 1024 / 1024)} MB）` });
    await downloadTo(modelPin.url, modelFile, {
      expectSha256: modelPin.sha256,
      log,
      onProgress: ({ received, total }) => event({ type: 'progress', id: 'stt-model', received, total: total || modelPin.bytes }),
    });
  }

  return { ok: true, bin: p.bin, model: modelFile, modelName: model, reused };
}

/**
 * 转写一个本地音频文件。
 * whisper.cpp 自带 miniaudio，能解 wav/mp3/flac/ogg；silk/amr 需要先转码（这里会给出明确提示）。
 * @returns {Promise<{text:string, seconds:number, model:string}>}
 */
export function transcribe({ targetDir, file, language = 'auto', timeoutMs = 180000, model = 'tiny' } = {}) {
  const p = sttPaths(targetDir);
  if (!fs.existsSync(p.bin)) throw new Error('还没装 whisper（先勾上「语音转文字」并装一次）');
  const modelFile = path.join(p.models, MODELS[model]?.file ?? `ggml-${model}.bin`);
  if (!fs.existsSync(modelFile)) throw new Error(`找不到模型 ${path.basename(modelFile)}`);
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);

  const args = ['-m', modelFile, '-f', file, '-nt', '-np'];
  if (language && language !== 'auto') args.push('-l', language);

  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(p.bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const hint = /read_audio_data|failed to decode|unsupported/i.test(`${stderr}${stdout}`)
          ? '（这个音频格式 whisper 解不了，QQ 的 silk/amr 需要先转成 wav/mp3）'
          : '';
        return reject(new Error(`whisper 失败：${error.message}${hint}`));
      }
      // -nt 去掉时间戳，stdout 就是纯文本（可能多行）
      const text = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      resolve({ text, seconds: Math.round((Date.now() - started) / 100) / 10, model });
    });
  });
}
