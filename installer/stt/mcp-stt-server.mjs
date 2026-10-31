// MCP stdio server：把本地 whisper 暴露成一个工具。
//
// 为什么手写而不是用 SDK：这个进程要能独立运行、不依赖 app/node_modules，
// 而且只用到 MCP 的一小部分（initialize / tools/list / tools/call）。手写更可控。
//
// 协议：stdio + 每行一个 JSON-RPC 消息（MCP 的 stdio 传输就是这么定的）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const argTarget = (() => {
  const i = process.argv.indexOf('--target');
  return i > 0 ? process.argv[i + 1] : '';
})();

const SERVER = { name: 'dsh-qq-stt', version: '0.1.0' };
const PROTOCOL = '2025-06-18';

const MODELS = { tiny: 'ggml-tiny.bin', base: 'ggml-base.bin' };

function paths() {
  const root = path.join(argTarget, 'runtime', 'stt');
  return {
    bin: path.join(root, 'whisper', 'Release', 'whisper-cli.exe'),
    models: path.join(root, 'models'),
  };
}

function status() {
  const p = paths();
  const models = fs.existsSync(p.models) ? fs.readdirSync(p.models).filter((f) => f.endsWith('.bin')) : [];
  return {
    target: argTarget || '(未指定)',
    installed: fs.existsSync(p.bin) && models.length > 0,
    binary: fs.existsSync(p.bin) ? p.bin : null,
    models,
  };
}

// 注意：工具参数名是 path，这里必须映射成 file —— 直接解构 { file } 会永远拿到 undefined。
function transcribe({ path: file, language = 'auto', model = 'tiny' } = {}) {
  const p = paths();
  if (!fs.existsSync(p.bin)) throw new Error('whisper 未安装：先运行安装器勾上「语音转文字」');
  const modelFile = path.join(p.models, MODELS[model] ?? `ggml-${model}.bin`);
  if (!fs.existsSync(modelFile)) throw new Error(`模型不存在：${modelFile}`);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`path 必须是绝对路径（收到 ${typeof file}）`);
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);

  const args = ['-m', modelFile, '-f', file, '-nt', '-np'];
  if (language && language !== 'auto') args.push('-l', language);

  return new Promise((resolve, reject) => {
    execFile(p.bin, args, { timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const hint = /decode|unsupported|read_audio_data/i.test(`${stderr}${stdout}`)
          ? '（silk/amr 需要先转成 wav/mp3）'
          : '';
        return reject(new Error(`whisper 失败：${error.message}${hint}`));
      }
      const text = String(stdout)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      resolve({ text, model });
    });
  });
}

const TOOLS = [
  {
    name: 'stt_status',
    description: '查看本机语音转文字（whisper.cpp）是否可用、装了哪些模型。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'stt_transcribe',
    description:
      '把一段本地音频转成文字（本地运行，不联网）。QQ 语音如果是 silk/amr 格式，需要先转成 wav/mp3。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '音频文件的绝对路径（wav/mp3/flac/ogg）' },
        language: { type: 'string', description: '语言，默认 auto；中文用 zh' },
        model: { type: 'string', enum: ['tiny', 'base'], description: '用哪个模型，默认 tiny' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;

  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      if (name === 'stt_status') {
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(status(), null, 2) }] });
      }
      if (name === 'stt_transcribe') {
        const r = await transcribe(args);
        return reply(id, { content: [{ type: 'text', text: r.text || '（没有识别出内容）' }] });
      }
      return replyError(id, -32602, `unknown tool: ${name}`);
    } catch (error) {
      return reply(id, { content: [{ type: 'text', text: `转写失败：${error.message}` }], isError: true });
    }
  }

  if (method === 'ping') return reply(id, {});
  return replyError(id, -32601, `method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 坏行丢掉，别让整个 server 挂掉
    }
    handle(msg).catch((error) => {
      if (msg?.id !== undefined) replyError(msg.id, -32603, error.message);
    });
  }
});
