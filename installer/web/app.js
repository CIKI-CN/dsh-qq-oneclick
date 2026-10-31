// 安装向导前端：无框架，纯 DOM。
// 原则：界面只显示真实状态；没实现的功能明确写「未实现」，不做假进度条。

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEPS = [
  { name: '环境检测', hint: '先看清楚这台机器的实际情况，红项会给修复动作。' },
  { name: '出处与许可', hint: '装之前先知道每个组件是谁写的、什么许可证、我们改了什么。' },
  { name: '安装位置', hint: '程序目录可以随便选；记忆数据固定在用户目录，不会跟着移动。' },
  { name: '功能选择', hint: '不确定就选套餐；勾父项会自动带上依赖。' },
  { name: '配置', hint: '这一步可以跳过，装完在设置中心里改也一样。' },
  { name: '确认安装', hint: '看清楚要装什么再开始。' },
];

const S = { state: null, features: null, third: null, step: 0, root: '' };

// —— 基础请求 ——
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

// —— 状态存取（防抖，避免每敲一个字写一次盘）——
let saveTimer = null;
let pendingPatch = {};
async function persist(patch, immediate = false) {
  pendingPatch = { ...pendingPatch, ...patch };
  clearTimeout(saveTimer);
  const flush = async () => {
    const body = { patch: pendingPatch };
    pendingPatch = {};
    const { state } = await api('/api/state', { method: 'POST', body });
    S.state = state;
  };
  if (immediate) return flush();
  saveTimer = setTimeout(flush, 300);
}

// —— 功能清单工具 ——
const allItems = () => S.features.groups.flatMap((g) => g.items.map((it) => ({ ...it, group: g.id, required: !!g.required })));
const itemById = (id) => allItems().find((it) => it.id === id);
const requiredIds = () => allItems().filter((it) => it.required || it.locked === 'always').map((it) => it.id);
function isOn(id) {
  if (requiredIds().includes(id)) return true;
  return (S.state.selected ?? []).includes(id);
}
function effectiveSelection() {
  return [...new Set([...requiredIds(), ...(S.state.selected ?? [])])];
}
function applyPreset(key) {
  const preset = S.features.presets[key];
  S.state.preset = key;
  S.state.selected = [...new Set([...(preset?.items ?? []), ...requiredIds()])];
  persist({ preset: key, selected: S.state.selected });
}

// —— 渲染：步骤条 ——
function renderRail() {
  $('#rail').innerHTML = STEPS.map((s, i) => {
    const cls = i === S.step ? 'step active' : i < S.step ? 'step done' : 'step';
    return `<div class="${cls}"><span class="idx">${i < S.step ? '✓' : i + 1}</span><span>${esc(s.name)}</span></div>`;
  }).join('');
}

function renderFooter() {
  const last = S.step === STEPS.length - 1;
  $('#hint').textContent = STEPS[S.step].hint;
  $('#btn-back').disabled = S.step === 0;
  $('#btn-next').textContent = last ? '开始安装' : '下一步';
  $('#btn-next').disabled = S.step === 1 && !S.state?.consent;
}

// —— 第 0 步：环境检测 ——
async function runDetect() {
  $('#panel').innerHTML = '<div class="loading">正在检测（端口、网络要等几秒）…</div>';
  const { detect } = await api('/api/detect', { method: 'POST' });
  S.state.detect = detect;
  renderDetect();
}

function renderDetect() {
  const d = S.state.detect;
  if (!d) {
    $('#panel').innerHTML = '<h1>环境检测</h1><p class="lead">点下面按钮开始。</p><button class="btn primary" id="run">开始检测</button>';
    $('#run').onclick = runDetect;
    return;
  }
  const banner =
    d.summary.fail > 0
      ? `<div class="banner">有 ${d.summary.fail} 项红项，可能装不完整。修不了也可以用「我知道风险」继续，但出问题要先看这些。</div>`
      : d.summary.warn > 0
        ? `<div class="banner">${d.summary.warn} 项警告：能装，但可能会踩坑。</div>`
        : '';

  $('#panel').innerHTML = `
    <h1>环境检测</h1>
    <p class="lead">检测于 ${esc(new Date(d.at).toLocaleString('zh-CN'))}</p>
    ${banner}
    <table>
      <thead><tr><th style="width:34%">项目</th><th style="width:10%">状态</th><th>结果与处理</th></tr></thead>
      <tbody>
        ${d.results
          .map(
            (r) => `<tr>
              <td>${esc(r.label)}</td>
              <td><span class="pill ${esc(r.status)}">${esc({ ok: '正常', warn: '注意', fail: '阻塞' }[r.status] ?? r.status)}</span></td>
              <td>${esc(r.detail)}${r.fix ? `<div class="fix">→ ${esc(r.fix)}</div>` : ''}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p style="margin-top:16px"><button class="btn" id="rerun">重新检测</button></p>
  `;
  $('#rerun').onclick = runDetect;
}

// —— 第 1 步：出处与许可 ——
const INCLUSION_LABEL = {
  bundle: '随包分发',
  download: '装时从上游下载',
  'user-provided': '由你自行安装',
  reference: '参考设计（未复制源码）',
  'doc-only': '仅引用文档链接',
};
const INCLUSION_DUTY = {
  bundle: '我们随包附上它的完整许可证原文与我们的修改说明。',
  download: '安装时从它自己的仓库拉取；我们不参与再分发。',
  'user-provided': '我们不下载、不代登录，只给指引和检测。',
  reference: '我们参考了它的设计，但没有复制其源码。',
  'doc-only': '我们只放链接，不复刻正文。',
};

function renderLicense() {
  const doc = S.third;
  const groups = {};
  for (const c of doc.components) (groups[c.inclusion] ??= []).push(c);

  const sections = Object.entries(groups)
    .map(
      ([kind, list]) => `
      <h2>${esc(INCLUSION_LABEL[kind] ?? kind)} <span class="note">（${list.length}）</span></h2>
      <p class="note">${esc(INCLUSION_DUTY[kind] ?? '')}</p>
      <table>
        <thead><tr><th style="width:22%">组件</th><th style="width:18%">作者 / 发布方</th><th style="width:22%">许可证</th><th>用途与我们做的改动</th></tr></thead>
        <tbody>
          ${list
            .map(
              (c) => `<tr>
              <td><strong>${esc(c.name)}</strong><div class="note"><a href="${esc(c.upstream)}" target="_blank" rel="noreferrer">${esc(c.upstream)}</a></div></td>
              <td>${esc(c.author)}</td>
              <td>${esc(c.license)}</td>
              <td>${esc(c.usedFor)}<div class="note">改动：${esc(c.modified)}</div>${c.notice ? `<div class="fix">${esc(c.notice)}</div>` : ''}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>`,
    )
    .join('');

  $('#panel').innerHTML = `
    <h1>出处与许可</h1>
    <p class="lead">共 ${doc.components.length} 个组件。这份表由 <code>docs/third-party.json</code> 生成，漏登记的组件构建时就过不了。</p>
    ${sections}
    <label class="agree">
      <input type="checkbox" id="consent" ${S.state.consent ? 'checked' : ''} />
      <span>我已阅读上面的出处与许可，理解这是一个<strong>非官方</strong>安装器，也知道每个组件由谁提供、我该遵守哪一方的条款。</span>
    </label>
  `;
  $('#consent').onchange = (e) => {
    S.state.consent = e.target.checked ? new Date().toISOString() : null;
    persist({ consent: S.state.consent }, true).then(renderFooter);
  };
}

// —— 第 2 步：安装位置 ——
function renderTarget() {
  const d = S.state.detect;
  const value = S.state.targetDir || d?.target || '';
  $('#panel').innerHTML = `
    <h1>安装位置</h1>
    <p class="lead">程序装在这里；记忆、角色、B站凭据固定在 <code>~/.dsh/</code> 下，不随这里移动。</p>
    <div class="field">
      <label>安装目录</label>
      <input id="target" value="${esc(value)}" placeholder="%LOCALAPPDATA%\\DSHQQ" />
    </div>
    <p class="note">绿色安装：不写注册表、不加系统服务、不要管理员权限。卸载时删掉这个目录即可。</p>
    <p class="note">记忆数据单独存放，卸载默认保留——不然重装一次就忘了所有人。</p>
  `;
  const input = $('#target');
  input.onchange = () => {
    S.state.targetDir = input.value.trim();
    persist({ targetDir: S.state.targetDir });
  };
}

// —— 第 3 步：功能选择 ——
function renderFeatures() {
  const f = S.features;
  const sel = effectiveSelection();
  const presetBtns = Object.entries(f.presets)
    .map(
      ([k, p]) => `<button class="preset ${S.state.preset === k ? 'on' : ''}" data-preset="${k}">
        <div class="name">${esc(p.name)}</div><div class="desc">${esc(p.desc)}</div>
      </button>`,
    )
    .join('');

  const groups = f.groups
    .map((g) => {
      const cards = g.items
        .map((it) => {
          const on = sel.includes(it.id);
          const disabled = it.notInV1;
          const locked = it.required || it.locked === 'always';
          const statusPill =
            it.status === 'new'
              ? '<span class="pill new">新增</span>'
              : it.status === 'default-off'
                ? '<span class="pill">默认关</span>'
                : it.status === 'unknown'
                  ? '<span class="pill">待确认</span>'
                  : '<span class="pill have">已有</span>';
          const dl = it.download && it.download !== 'user-provided' && it.download !== ''
            ? `<span class="pill">${esc({ model: '需下模型', engine: '需下引擎', release: '需下安装包', thirdparty: '第三方组件' }[it.download] ?? it.download)}</span>`
            : '';
          return `<label class="card ${on ? 'on' : ''} ${disabled ? 'disabled' : ''} ${locked ? 'locked' : ''}">
            <input type="checkbox" data-id="${esc(it.id)}" ${on ? 'checked' : ''} ${disabled || locked ? 'disabled' : ''} />
            <span>
              <span class="title">${esc(it.name)} ${statusPill} ${dl}</span>
              <span class="sub">${esc(it.note ?? `来源：${it.source}`)}</span>
            </span>
          </label>`;
        })
        .join('');
      return `<h2>${esc(g.name)}${g.required ? ' <span class="note">（必装）</span>' : ''}</h2>
        ${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}
        <div class="grid">${cards}</div>`;
    })
    .join('');

  $('#panel').innerHTML = `
    <h1>功能选择</h1>
    <p class="lead">已选 <strong>${sel.length}</strong> 项。勾选项会在安装时写入配置，未勾的不会加载。</p>
    <div class="presets">${presetBtns}</div>
    ${groups}
    <p class="note" style="margin-top:18px">说明：这里的清单只维护「名称、依赖、来源、风险」。真正的配置键在安装时与上游 <code>config.example.json</code> 合并生成——上游新增的键归入「未分类」，不会静默丢弃。</p>
  `;

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      applyPreset(btn.dataset.preset);
      renderFeatures();
    };
  });
  document.querySelectorAll('.card input[data-id]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      const set = new Set(S.state.selected ?? []);
      cb.checked ? set.add(id) : set.delete(id);
      S.state.selected = [...set];
      S.state.preset = null;
      persist({ selected: S.state.selected, preset: null });
      renderFeatures();
    };
  });
}

// —— 第 4 步：配置 ——
function renderConfig() {
  const c = S.state.config;
  $('#panel').innerHTML = `
    <h1>配置</h1>
    <p class="lead">只填你最清楚的四件事。其余几百个键都有默认值，装完在设置中心改。</p>

    <h2>SnowLuma（QQ 接入运行时）</h2>
    <div id="sl"><p class="note">正在查找…</p></div>

    <h2>你的信息</h2>
    <div class="field">
      <label>你的 QQ 号（只接受这个人的管理指令）</label>
      <input id="ownerQQ" value="${esc(c.ownerQQ)}" placeholder="例如 1000000001" inputmode="numeric" />
    </div>

    <div class="row">
      <div class="field">
        <label>允许的群（逗号分隔，留空 = 谁都不理）</label>
        <input id="groups" value="${esc((c.groups ?? []).join(','))}" placeholder="123456,789012" />
      </div>
      <div class="field">
        <label>允许的私聊（逗号分隔）</label>
        <input id="privates" value="${esc((c.privates ?? []).join(','))}" placeholder="1000000001" />
      </div>
    </div>

    <h2>连接</h2>
    <div class="row">
      <div class="field">
        <label>SnowLuma WS 地址</label>
        <input id="wsUrl" value="${esc(c.snowluma.wsUrl)}" />
      </div>
      <div class="field">
        <label>SnowLuma HTTP 地址</label>
        <input id="httpUrl" value="${esc(c.snowluma.httpUrl)}" />
      </div>
    </div>

    <div class="field">
      <label>SnowLuma AccessToken（HTTP 与 WS 可能是两个不同的值）</label>
      <input id="accessToken" value="${esc(c.snowluma.accessToken)}" />
    </div>

    <div class="field">
      <label>控制台令牌（留空 = 安装时自动生成）</label>
      <input id="consoleToken" value="${esc(c.consoleToken)}" />
    </div>

    <div class="banner">白名单留空不是「全放行」，是「谁都不响应」。想先自测就填你自己的 QQ 号。</div>
    <p class="note">密钥只写在本机 <code>data/config.json</code>，不会发到任何地方。</p>
  `;

  const bind = (id, apply, isArray = false) => {
    const el = $(`#${id}`);
    el.onchange = () => {
      const raw = el.value.trim();
      apply(isArray ? raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [] : raw);
      persist({ config: S.state.config });
    };
  };
  bind('ownerQQ', (v) => (S.state.config.ownerQQ = v));
  bind('groups', (v) => (S.state.config.groups = v), true);
  bind('privates', (v) => (S.state.config.privates = v), true);
  bind('wsUrl', (v) => (S.state.config.snowluma.wsUrl = v));
  bind('httpUrl', (v) => (S.state.config.snowluma.httpUrl = v));
  bind('accessToken', (v) => (S.state.config.snowluma.accessToken = v));
  bind('consoleToken', (v) => (S.state.config.consoleToken = v));

  refreshSnowLuma();
}

// —— SnowLuma：只找路径、记路径；不代下载、不代部署（EULA §5.4）——
async function refreshSnowLuma(dir) {
  const box = $('#sl');
  if (!box) return;
  box.innerHTML = '<p class="note">正在查找 SnowLuma…</p>';
  try {
    S.snow = await api(`/api/snowluma${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
  } catch (error) {
    box.innerHTML = `<p class="fix">查询失败：${esc(error.message)}</p>`;
    return;
  }
  renderSnowLuma();
}

function renderSnowLuma() {
  const box = $('#sl');
  if (!box) return;
  const f = S.snow?.found;

  box.innerHTML = f?.ok
    ? `
      <div class="banner" style="border-color:var(--ok);color:var(--ok)">
        已找到 SnowLuma ${esc(f.version ?? '')}：<code>${esc(f.dir)}</code>
      </div>
      <p class="note">装的时候会把这个路径写进配置，你不用再手填。扫码登录仍然要你自己打开 SnowLuma 完成。</p>
      <p><button class="btn" id="sl-again">重新查找</button>
         <button class="btn" id="sl-pick">换个目录</button>
         <button class="btn" id="sl-latest">查看最新版</button></p>`
    : `
      <div class="banner">
        还没找到 SnowLuma。点下面的按钮，浏览器会<b>直接开始下载正确的那一个包</b>（Windows x64 完整版，
        不是 lite、不是 linux）。下载后的解压和启动由你自己完成——SnowLuma EULA §5.4 把
        「通过自动化脚本部署」列为需事先书面授权的事。
      </div>
      <ol class="note" style="margin:0 0 12px 18px;padding:0;line-height:1.9">
        <li>点「下载 Windows 包」→ 等浏览器下完（约 41 MB）</li>
        <li>右键解压到 <code>D:\\SnowLuma</code>（或任意目录），别解压到压缩包里直接双击</li>
        <li>双击里面的 <code>launcher.bat</code> → <b>扫码登录 QQ</b></li>
        <li>回到这里点「我解压好了，选目录」</li>
      </ol>
      <p><button class="btn primary" id="sl-dl">下载 Windows 包</button>
         <button class="btn" id="sl-pick">我解压好了，选目录</button>
         <button class="btn" id="sl-again">再找一次</button></p>
      <p class="note" id="sl-info"></p>`;

  $('#sl-latest')?.addEventListener('click', () => window.open('https://github.com/SnowLuma/SnowLuma/releases/latest', '_blank', 'noopener'));

  // 下载：先问服务端「最新版里哪个资产对」，再打开直链让浏览器自己下
  $('#sl-dl')?.addEventListener('click', async () => {
    const info = $('#sl-info');
    if (info) info.textContent = '正在查最新版本…';
    try {
      const { asset } = await api('/api/snowluma/latest');
      if (!asset?.ok) {
        if (info) info.textContent = `${asset?.reason ?? '查不到'}，已打开 Releases 页面让你自己挑`;
        window.open('https://github.com/SnowLuma/SnowLuma/releases/latest', '_blank', 'noopener');
        return;
      }
      if (info) info.textContent = `${asset.tag} · ${asset.name} · ${asset.sizeMB} MB —— 已在新标签页开始下载`;
      window.open(asset.url, '_blank', 'noopener');
    } catch (error) {
      if (info) info.textContent = `查询失败：${error.message}，已打开 Releases 页面`;
      window.open('https://github.com/SnowLuma/SnowLuma/releases/latest', '_blank', 'noopener');
    }
  });
  $('#sl-again')?.addEventListener('click', () => refreshSnowLuma());
  $('#sl-pick')?.addEventListener('click', async () => {
    const box2 = $('#sl');
    box2.innerHTML = '<p class="note">请在弹出的窗口里选择 SnowLuma 目录（有 index.mjs 的那一层）…</p>';
    try {
      const { picked } = await api('/api/snowluma/pick', { method: 'POST', body: {} });
      if (!picked?.ok) {
        box2.innerHTML = `<div class="banner">${esc(picked?.reason ?? '没选到可用的目录')}</div>`;
        setTimeout(renderSnowLuma, 1200);
        return;
      }
      await api('/api/snowluma/apply', { method: 'POST', body: { dir: picked.dir } });
      S.state.config.snowluma.homeDir = picked.dir;
      S.state.config.snowluma.launcherPath = picked.launcher ?? '';
      await refreshSnowLuma(picked.dir);
    } catch (error) {
      box2.innerHTML = `<p class="fix">选择失败：${esc(error.message)}</p>`;
      setTimeout(renderSnowLuma, 1200);
    }
  });
}

// —— 第 5 步：确认并安装 ——
const JOB = {
  events: [],
  since: 0,
  running: false,
  finished: false,
  error: null,
  manifest: null,
  timer: null,
  progress: {}, // id -> {received,total}
};

const INSTALL_STEPS = [
  ['preflight', '预检'],
  ['fetch', '下载上游'],
  ['npm', '准备 npm'],
  ['checksum', '校验 sha256'],
  ['extract', '解包'],
  ['deps', '装依赖'],
  ['configure', '写配置'],
  ['stt', '语音模型'],
  ['register', '注册进 DSH'],
  ['verify', '装完自检'],
  ['manifest', '写清单'],
];

function stepStatus(id) {
  const evs = JOB.events.filter((e) => e.type === 'step' && e.id === id);
  return evs.length ? evs[evs.length - 1].status : 'pending';
}

function statusPill(status) {
  const map = { ok: ['ok', '完成'], running: ['warn', '进行中'], fail: ['fail', '失败'], skip: ['', '跳过'], pending: ['', '未开始'] };
  const [cls, label] = map[status] ?? ['', status];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

async function startInstall() {
  JOB.events = [];
  JOB.since = 0;
  JOB.progress = {};
  JOB.running = true;
  JOB.finished = false;
  JOB.error = null;
  JOB.manifest = null;
  renderInstall();
  try {
    await api('/api/install', { method: 'POST', body: {} });
    pollInstall();
  } catch (error) {
    JOB.running = false;
    JOB.error = error.data?.message ?? error.message;
    renderInstall();
  }
}

async function pollInstall() {
  clearTimeout(JOB.timer);
  try {
    const r = await api(`/api/install/status?since=${JOB.since}`);
    for (const e of r.events) {
      JOB.events.push(e);
      if (e.type === 'progress') JOB.progress[e.id] = { received: e.received, total: e.total };
    }
    // total 就是服务端的单调 seq：用它推进游标，缓冲区裁剪也不会错位
    JOB.since = r.total;
    JOB.running = r.running;
    JOB.finished = r.finished;
    JOB.error = r.error;
    JOB.manifest = r.manifest;
  } catch (error) {
    JOB.error = error.message;
    JOB.running = false;
  }
  renderInstall();
  if (JOB.running) JOB.timer = setTimeout(pollInstall, 600);
}

function renderInstall() {
  // 已经在装 / 装完了 → 显示进度视图
  if (JOB.running || JOB.finished || JOB.error) {
    const rows = INSTALL_STEPS.map(([id, label]) => {
      const st = stepStatus(id);
      const pg = JOB.progress[id];
      const pct = pg && pg.total ? Math.min(100, Math.round((pg.received / pg.total) * 100)) : null;
      return `<tr>
        <td>${esc(label)}</td>
        <td style="width:110px">${statusPill(st)}</td>
        <td>${pct !== null ? `<div class="bar"><i style="width:${pct}%"></i></div><span class="note">${pct}%</span>` : ''}</td>
      </tr>`;
    }).join('');

    const logs = JOB.events
      .filter((e) => e.type === 'log' || (e.type === 'step' && e.status === 'running'))
      .slice(-8)
      .map((e) => `· ${esc(e.line ?? e.message ?? '')}`)
      .join('\n');

    const done = JOB.finished && JOB.manifest;
    const head = JOB.error
      ? `<div class="banner" style="border-color:var(--fail);color:var(--fail)">安装失败：${esc(JOB.error)}<br>已回滚到装之前的状态。</div>`
      : done
        ? `<div class="banner" style="border-color:var(--ok);color:var(--ok)">装好了：${esc(JOB.manifest.surfcore.version)} → ${esc(JOB.manifest.targetDir)}</div>`
        : `<p class="lead">正在安装，别关窗口。装依赖那一步最久（一两分钟）。</p>`;

    // 自检结果（有就展示，没有就空）
    const checks = done?.verify?.results ?? [];
    const checkTable = checks.length
      ? `<h2>装完自检</h2>
         <table><tbody>${checks
           .map(
             (r) => `<tr>
               <td style="width:34%">${esc(r.label)}</td>
               <td style="width:10%">${statusPill(r.status === 'skip' ? 'skip' : r.status)}</td>
               <td>${esc(r.detail)}${r.fix ? `<div class="fix">→ ${esc(r.fix)}</div>` : ''}</td>
             </tr>`,
           )
           .join('')}</tbody></table>`
      : '';

    $('#panel').innerHTML = `
      <h1>${done ? '安装完成' : JOB.error ? '安装失败' : '正在安装'}</h1>
      ${head}
      <table><tbody>${rows}</tbody></table>
      ${logs ? `<pre class="note" style="white-space:pre-wrap;margin-top:14px">${logs}</pre>` : ''}
      ${checkTable}
      ${done ? `<p style="margin-top:16px">
        <a class="btn primary" href="/settings">打开设置中心</a>
        <button class="btn" id="again">再装一次（修复）</button>
      </p>` : ''}
      ${JOB.error ? `<p style="margin-top:16px"><button class="btn" id="retry">重试</button></p>` : ''}
    `;
    $('#again')?.addEventListener('click', startInstall);
    $('#retry')?.addEventListener('click', startInstall);
    return;
  }

  // 默认：确认摘要
  const sel = effectiveSelection();
  const c = S.state.config;
  const network = S.state.detect?.results?.find((r) => r.id === 'network');
  const target = S.state.targetDir || S.state.detect?.target || '(默认)';
  const reg = S.dsh?.registration;
  const norm = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
  const ourApp = norm(`${target}\\app`);
  const conflict = Boolean(reg?.pointsTo) && norm(reg.pointsTo) !== ourApp;
  const rows = [
    ['安装目录', target],
    ['上游版本', 'v0.8.0（固定版本，装完不自动追新）'],
    ['已选功能', `${sel.length} 项`],
    ['主人 QQ', c.ownerQQ || '(未填)'],
    ['白名单', `${(c.groups ?? []).length} 群 / ${(c.privates ?? []).length} 人`],
    ['网络', network ? network.detail : '(未检测)'],
  ];

  const regBlock = !reg?.hasProfile
    ? `<p class="note">本机没找到 DSH profile，跳过注册；装好 DSH 后可在设置中心补注册。</p>`
    : `
      <p class="note">DSH profile：<code>${esc(reg.profile)}</code>
        ${reg.pointsTo ? `，当前 SurfCore 注册指向 <code>${esc(reg.pointsTo)}</code>` : '，当前没有 SurfCore 注册'}
        ${reg.hasBundle ? '（bundle 已挂）' : ''}
      </p>
      ${conflict ? `<div class="banner">检测到另一套 SurfCore 注册。默认<strong>不动它</strong>——
        直接写会把它指向抢过来。要改成这次装的位置，请勾下面的「强制改指向」。</div>` : ''}
    `;

  $('#panel').innerHTML = `
    <h1>确认安装</h1>
    <p class="lead">下面这些将被写入。不服气可以回上一步改。</p>
    <dl class="summary">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>

    <h2>注册进 DSH</h2>
    ${regBlock}
    <label class="agree"><input type="checkbox" id="reg-on" ${S.state.register ? 'checked' : ''} />
      <span>装完把 SurfCore 注册进这套 DSH（3 个 MCP + bundle），这样 DSH 设置里才有入口。</span></label>
    ${conflict ? `<label class="agree"><input type="checkbox" id="reg-force" ${S.state.forceRepoint ? 'checked' : ''} />
      <span>强制改指向到本次安装的目录（会先备份 profile 的 cordis.patch.yml 与 package.json）。</span></label>` : ''}

    <div class="banner">
      装的时候会做五件事：从上游拉 v0.8.0（校验 sha256）→ 解包到 <code>app\\</code> →
      <code>npm ci</code> 装依赖 → 生成 <code>app\\config.json</code> → 注册进 DSH。
      前四步失败会整体回滚；注册失败只报告，不会让你白装一次。
    </div>
    <p><button class="btn primary" id="start">开始安装</button></p>
  `;

  $('#reg-on').onchange = (e) => {
    S.state.register = e.target.checked;
    persist({ register: S.state.register });
  };
  $('#reg-force')?.addEventListener('change', (e) => {
    S.state.forceRepoint = e.target.checked;
    persist({ forceRepoint: S.state.forceRepoint });
  });
  $('#start').onclick = startInstall;
}

// —— 路由 ——
function render() {
  renderRail();
  renderFooter();
  if (!S.features || !S.third) return;
  const fn = [renderDetect, renderLicense, renderTarget, renderFeatures, renderConfig, renderInstall][S.step];
  fn();
}

async function boot() {
  try {
    const [{ state, root }, features, third, dsh] = await Promise.all([
      api('/api/state'),
      api('/api/features'),
      api('/api/third-party'),
      api('/api/dsh').catch(() => null),
    ]);
    S.state = state;
    S.features = features;
    S.third = third;
    S.dsh = dsh;
    S.root = root;
    S.step = Math.min(Math.max(state.step ?? 0, 0), STEPS.length - 1);

    // 首次进入：默认「最小」套餐 + 必装项
    if (!state.selected || state.selected.length === 0) {
      const preset = features.presets[state.preset] ?? features.presets.min;
      S.state.selected = [...new Set([...(preset?.items ?? []), ...requiredIds()])];
      S.state.preset = state.preset ?? 'min';
      persist({ selected: S.state.selected, preset: S.state.preset });
    }

    $('#meta').textContent = root;

    $('#btn-back').onclick = () => {
      if (S.step === 0) return;
      S.step -= 1;
      persist({ step: S.step });
      render();
    };
    $('#btn-next').onclick = () => {
      if (S.step === 1 && !S.state.consent) return;
      if (S.step === STEPS.length - 1) return;
      S.step += 1;
      persist({ step: S.step });
      render();
    };

    render();
    if (S.step === 0 && !S.state.detect) runDetect();
  } catch (error) {
    $('#panel').innerHTML = `<h1>启动失败</h1><p class="lead">${esc(error.message)}</p>
      <p class="note">确认向导进程还在运行；端口被占用时它会自动顺延，看命令行输出的实际地址。</p>`;
  }
}

boot();
