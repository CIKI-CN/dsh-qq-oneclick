// 设置中心：只做「装完之后还要改的东西」。
// 不做 DSH 设置页那 14 个标签的复刻——那是上游的活；这里管白名单、语音开关、启停、诊断。

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { data: null };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
  return data;
}

const toId = (v) => (/^\d+$/.test(String(v).trim()) ? Number(v) : String(v).trim());
const listOf = (text) => String(text ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).map(toId);

function pill(status, text) {
  const cls = { ok: 'ok', warn: 'warn', fail: 'fail', skip: '' }[status] ?? '';
  return `<span class="pill ${cls}">${esc(text)}</span>`;
}

function render() {
  const d = S.data;
  const cfg = d.config ?? {};
  const b = d.bridge ?? {};
  const reg = d.registration ?? {};
  const m = d.manifest ?? {};
  const voice = cfg.socialV2?.voice ?? {};

  $('#meta').textContent = d.target ?? '';

  $('#panel').innerHTML = `
    <h1>概览</h1>
    <dl class="summary">
      <dt>版本</dt><dd>${esc(m.surfcore?.version ?? '未装')}</dd>
      <dt>安装目录</dt><dd><code>${esc(d.target)}</code></dd>
      <dt>桥接</dt><dd>${pill(b.ours ? 'ok' : b.consoleOpen ? 'warn' : 'fail', b.detail ?? '未知')}</dd>
      <dt>DSH 注册</dt><dd>${reg.hasProfile
        ? `${esc(reg.profile)} ${reg.pointsTo ? `→ <code>${esc(reg.pointsTo)}</code>` : '（没有 SurfCore 条目）'}`
        : '本机没有 DSH'}</dd>
    </dl>

    <div class="row" style="margin-top:14px">
      <div><button class="btn primary" id="start">启动桥接</button></div>
      <div><button class="btn" id="stop">停止桥接</button></div>
    </div>
    <p class="note" id="bmsg" style="margin-top:8px"></p>

    <h2>白名单与主人</h2>
    <p class="note">空名单 = 谁都不理（不是全放行）。改完需要重启桥接才完全生效。</p>
    <div class="field">
      <label>主人 QQ（只认这个人的管理指令）</label>
      <input id="ownerQQ" value="${esc(cfg.ownerQQ ?? '')}" inputmode="numeric" />
    </div>
    <div class="row">
      <div class="field"><label>允许的群（逗号分隔）</label><input id="groups" value="${esc((cfg.allow?.groups ?? []).join(','))}" /></div>
      <div class="field"><label>允许的私聊（逗号分隔）</label><input id="privates" value="${esc((cfg.allow?.private ?? []).join(','))}" /></div>
    </div>
    <p><button class="btn primary" id="save-allow">保存白名单</button></p>

    <h2>语音</h2>
    <p class="note">语音条发送依赖外部 TTS 服务（本地 8765 / 云端 8767）。没起服务时开了也不会真说话，只是允许。</p>
    <label class="agree"><input type="checkbox" id="voice-on" ${voice.enabled ? 'checked' : ''} />
      <span>允许发语音条（<code>socialV2.voice.enabled</code>）</span></label>
    <label class="agree"><input type="checkbox" id="tts-on" ${voice.tts?.enabled ? 'checked' : ''} />
      <span>开启现场合成（<code>socialV2.voice.tts.enabled</code>）</span></label>
    <div class="row">
      <div class="field"><label>走哪条</label>
        <input id="tts-route" value="${esc(voice.tts?.route ?? 'local')}" placeholder="local / cloud" /></div>
      <div class="field"><label>TTS 地址</label>
        <input id="tts-url" value="${esc(voice.tts?.baseUrl ?? 'http://127.0.0.1:8765')}" /></div>
    </div>
    <p><button class="btn primary" id="save-voice">保存语音设置</button></p>

    <h2>诊断</h2>
    <p><button class="btn" id="verify">跑一次自检</button> <button class="btn" id="logs">看最近日志</button></p>
    <div id="diag"></div>

    <h2>重新安装 / 改功能</h2>
    <p class="note">回到向导可以重装箱体（会沿用这份配置）。</p>
    <p><a class="btn" href="/">打开安装向导</a></p>
  `;

  $('#start').onclick = () => bridgeCall('start');
  $('#stop').onclick = () => bridgeCall('stop');
  $('#save-allow').onclick = saveAllow;
  $('#save-voice').onclick = saveVoice;
  $('#verify').onclick = runVerify;
  $('#logs').onclick = showLogs;
}

async function bridgeCall(action) {
  const msg = $('#bmsg');
  msg.textContent = action === 'start' ? '正在启动…' : '正在停止…';
  try {
    const r = await api(`/api/bridge/${action}`, { method: 'POST', body: {} });
    S.data.bridge = r.bridge;
    msg.textContent = JSON.stringify(r.result);
    setTimeout(reload, 600);
  } catch (error) {
    msg.textContent = `失败：${error.message}`;
  }
}

async function saveAllow() {
  const patch = {
    ownerQQ: $('#ownerQQ').value.trim() ? toId($('#ownerQQ').value) : null,
    allow: { groups: listOf($('#groups').value), private: listOf($('#privates').value) },
  };
  await save(patch, '白名单已保存');
}

async function saveVoice() {
  const patch = {
    socialV2: {
      voice: {
        enabled: $('#voice-on').checked,
        tts: {
          enabled: $('#tts-on').checked,
          route: $('#tts-route').value.trim() || 'local',
          baseUrl: $('#tts-url').value.trim() || 'http://127.0.0.1:8765',
        },
      },
    },
  };
  await save(patch, '语音设置已保存');
}

async function save(patch, okText) {
  try {
    const r = await api('/api/settings', { method: 'POST', body: { patch } });
    S.data.config = r.config;
    toast(`${okText}（已备份到 ${r.backup.split(/[\\/]/).slice(-3).join('/')}）`);
  } catch (error) {
    toast(`保存失败：${error.message}`, true);
  }
}

function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'banner';
  if (bad) el.style.cssText = 'border-color:var(--fail);color:var(--fail)';
  el.textContent = text;
  const panel = $('#panel');
  panel.insertBefore(el, panel.firstChild);
  setTimeout(() => el.remove(), 5000);
}

async function runVerify() {
  const box = $('#diag');
  box.innerHTML = '<p class="note">自检中…</p>';
  try {
    const { verify } = await api('/api/settings/verify', { method: 'POST', body: {} });
    box.innerHTML = `<table><tbody>${verify.results
      .map(
        (r) => `<tr><td style="width:26%">${esc(r.label)}</td>
        <td style="width:10%">${pill(r.status === 'skip' ? 'skip' : r.status, { ok: '正常', warn: '注意', fail: '失败', skip: '跳过' }[r.status] ?? r.status)}</td>
        <td>${esc(r.detail)}${r.fix ? `<div class="fix">→ ${esc(r.fix)}</div>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  } catch (error) {
    box.innerHTML = `<p class="fix">自检失败：${esc(error.message)}</p>`;
  }
}

async function showLogs() {
  const box = $('#diag');
  try {
    const { log } = await api('/api/logs?lines=120');
    box.innerHTML = log
      ? `<pre class="note" style="white-space:pre-wrap;max-height:340px;overflow:auto">${esc(log)}</pre>`
      : '<p class="note">没有日志（还没启动过，或启动失败前没写）。</p>';
  } catch (error) {
    box.innerHTML = `<p class="fix">读日志失败：${esc(error.message)}</p>`;
  }
}

async function reload() {
  try {
    S.data = await api('/api/settings');
    render();
  } catch (error) {
    $('#panel').innerHTML = `<h1>读不到安装信息</h1>
      <p class="lead">${esc(error.data?.message ?? error.message)}</p>
      <p class="note">先去 <a href="/">安装向导</a> 装一次。</p>`;
  }
}

reload();
