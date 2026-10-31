// NOTICE 生成器（被 gen-notice 与 check-notice 共用）。
// 输出必须确定：同样的 third-party.json 一定生成同样的文本，否则闸门会天天误报。

const ORDER = ['user-provided', 'download', 'bundle', 'reference', 'doc-only'];

const LABEL = {
  bundle: '随包分发',
  download: '安装时从上游下载',
  'user-provided': '由用户自行安装',
  reference: '参考设计（未复制源码）',
  'doc-only': '仅引用文档链接',
};

const DUTY = {
  bundle: '我们随包附上完整许可证原文，并说明本项目的修改。',
  download: '安装时从该组件自己的仓库获取，本项目不参与再分发。',
  'user-provided': '本项目不下载、不代登录、不代扫码，只做检测与指引。',
  reference: '本项目参考其设计，但未复制其源码。',
  'doc-only': '本项目只引用链接，不复刻其正文。',
};

export function buildNotice(doc) {
  const list = [...doc.components].sort((a, b) => {
    const d = ORDER.indexOf(a.inclusion) - ORDER.indexOf(b.inclusion);
    return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
  });

  const lines = [];
  lines.push('# 第三方组件与出处');
  lines.push('');
  lines.push('> **本文件是生成物，请勿手改。**');
  lines.push('> 由 `scripts/gen-notice.mjs` 从 `docs/third-party.json` 生成；');
  lines.push('> 改出处请改 `docs/third-party.json`，然后跑 `npm run gen:notice`。');
  lines.push(`> 数据更新日期：${doc.updatedAt ?? '未记录'}。`);
  lines.push('');
  lines.push('## 一句话');
  lines.push('');
  lines.push('本项目是 **非官方安装器**，与下列任一项目的作者 **均无隶属、合作、授权或背书关系**。');
  lines.push('项目本体的功劳属于各自作者；我们只负责按文档安装、让你勾选、装完给你一个能调的界面。');
  lines.push('');
  lines.push('## 覆盖范围');
  lines.push('');
  lines.push('本仓库的 MIT 许可（见 `LICENSE`）**只覆盖本仓库自己的代码**，不覆盖下表中的任何组件。');
  lines.push('');

  for (const kind of ORDER) {
    const group = list.filter((c) => c.inclusion === kind);
    if (!group.length) continue;
    lines.push(`## ${LABEL[kind]}（${group.length}）`);
    lines.push('');
    lines.push(`> ${DUTY[kind]}`);
    lines.push('');
    lines.push('| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of group) {
      const used = `${c.usedFor ?? '—'}${c.modified ? `<br>改动：${c.modified}` : ''}${c.notice ? `<br>⚠️ ${c.notice}` : ''}`;
      lines.push(`| ${c.name} | ${c.author ?? '—'} | ${c.license ?? '—'} | ${c.upstream} | ${used} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 未随包分发的内容（明确声明）');
  lines.push('');
  lines.push('- **SurfCore**：装时从上游拉指定版本并校验，本仓库不含其代码。');
  lines.push('- **SnowLuma**：上游许可限制再分发，本项目不打包、不代装、不代登录。');
  lines.push('- **语音模型 / STT 模型**：体积大且条款独立，只下载，永不进包。');
  lines.push('- **QQ 客户端**：必须是你自己安装的官方 NTQQ。');
  lines.push('');
  lines.push('每个组件的完整字段（含 `versionPin`、`licenseUrl`、收录方式）见 `docs/third-party.json`。');
  lines.push('');

  return lines.join('\n');
}
