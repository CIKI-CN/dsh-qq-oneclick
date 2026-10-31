# 第三方组件与出处

> **本文件是生成物，请勿手改。**
> 由 `scripts/gen-notice.mjs` 从 `docs/third-party.json` 生成；
> 改出处请改 `docs/third-party.json`，然后跑 `npm run gen:notice`。
> 数据更新日期：2026-10-31。

## 一句话

本项目是 **非官方安装器**，与下列任一项目的作者 **均无隶属、合作、授权或背书关系**。
项目本体的功劳属于各自作者；我们只负责按文档安装、让你勾选、装完给你一个能调的界面。

## 覆盖范围

本仓库的 MIT 许可（见 `LICENSE`）**只覆盖本仓库自己的代码**，不覆盖下表中的任何组件。

## 由用户自行安装（3）

> 本项目不下载、不代登录、不代扫码，只做检测与指引。

| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |
| --- | --- | --- | --- | --- |
| DeepSeek Harness（DSH） | DeepSeek | MIT（@deepseek-ai/dsh-host-apiproxy 0.1.1-rc.2、@deepseek-ai/schemastery 3.18.5） | https://github.com/deepseek-ai/deepseek-harness | 宿主；本项目以插件形式接入（preset + MCP + bundle）<br>改动：通过官方 bundle patch 机制注册，不修改 DSH 本体<br>⚠️ 用户自行安装 DSH，本项目只做检测与注册。 |
| QQ NT 客户端 | 腾讯 | 专有软件 | https://im.qq.com/ | SnowLuma 注入的宿主客户端<br>改动：未修改，不打包、不代装<br>⚠️ 必须是官方 NTQQ，不是 TIM 或魔改版。 |
| SnowLuma（QQ → OneBot v11 运行时） | SnowLuma / MotricSeven | LICENSE（源码可见非商业许可）+ 官方发行包 EULA v1.1 | https://github.com/SnowLuma/SnowLuma | 把 QQ 转成 OneBot v11 接口（第 1 层）<br>改动：未修改。用户点击后由安装器从官方 Releases 下载 zip 并解压到本机；不启动、不配置、不登录、不随本包分发<br>⚠️ EULA §5.4：未经书面授权，不得将其专有组件并入第三方安装包或 Docker 镜像、通过自动化脚本部署。本安装器的处理：不打包、不静默安装；仅当用户在界面上点击时，从官方地址下载并做文件展开（等同用户自己用解压软件），随后由用户本人双击 launcher.bat 并扫码登录。启动与登录始终不代做。 |

## 安装时从上游下载（17）

> 安装时从该组件自己的仓库获取，本项目不参与再分发。

| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |
| --- | --- | --- | --- | --- |
| dsh-bili-danmaku-lite | rentaoyan0628-collab | 待核实 | https://github.com/rentaoyan0628-collab/dsh-bili-danmaku-lite | B站直播弹幕只读/监听（v1 不装，M7 评估）<br>改动：未修改 |
| dsh-douyin-scroll | NEWJO123 | 待核实 | https://github.com/NEWJO123/dsh-douyin-scroll | 抖音刷视频与日报（v1 不装，M7 评估）<br>改动：未修改<br>⚠️ 需先确认其许可证与是否允许被第三方安装器调用。 |
| faster-whisper / whisper.cpp（STT 引擎） | SYSTRAN / Georgi Gerganov | MIT（引擎）；模型权重条款另行确认 | https://github.com/SYSTRAN/faster-whisper | 语音转文字（新增能力）<br>改动：未修改<br>⚠️ 引擎与模型均不入包；模型条款随上游。 |
| FFmpeg | FFmpeg 项目 | LGPL/GPL（视编译选项） | https://ffmpeg.org/ | 音频转码与时长探测<br>改动：未修改<br>⚠️ 若选用 GPL 编译版本，分发与说明义务不同，需选定具体构建后核实。 |
| GPT-SoVITS（语音模型上游） | RVC-Boss 及贡献者 | 待核实 | https://github.com/RVC-Boss/GPT-SoVITS | 本地 TTS 的模型与推理引擎<br>改动：未修改<br>⚠️ 许可证与模型权重使用条款需在发布前核实；未核实前不做任何打包。 |
| js-yaml | Vladimir Zapparov | MIT | https://github.com/nodeca/js-yaml | YAML 解析（cordis 配置）<br>改动：未修改 |
| @modelcontextprotocol/sdk | Anthropic, PBC | MIT | https://github.com/modelcontextprotocol/typescript-sdk | MCP server 实现基础<br>改动：未修改 |
| npm (CLI) | npm, Inc. / GitHub | Artistic-2.0 | https://github.com/npm/cli | 装 surfcore 的依赖（npm ci）。系统没有 npm 时，安装器自己下载一份到 runtime/npm<br>改动：未修改<br>⚠️ 选 11.x 而不是最新的 12.x：npm 12 要求 Node ^22.22.2，会卡住 Node 22.13~22.21 的用户。 |
| @snowluma/mcp | MotricSeven | SEE LICENSE IN LICENSE（⚠️ 同上，包内未随附 LICENSE） | https://github.com/SnowLuma/SnowLuma/tree/main/packages/mcp | OneBot 相关 MCP 能力<br>改动：未修改<br>⚠️ 同 snowluma-sdk，许可证文本不可得，只做 npm 拉取。 |
| @snowluma/sdk | MotricSeven | SEE LICENSE IN LICENSE（⚠️ npm 包内未随附 LICENSE 文件） | https://github.com/SnowLuma/SnowLuma/tree/main/packages/sdk | OneBot HTTP / WebSocket 传输层<br>改动：postinstall 打了一个 ESM 解析补丁（scripts/patch-snowluma-sdk.mjs）<br>⚠️ 上游在 package.json 声明许可证指向 LICENSE，但其 files 字段未包含该文件，导致拿到包的人无法读到条款。因此本项目不作为 bundle 分发，改由 npm ci 获取。 |
| SurfCore（第三方项目，本安装器所服务的宿主程序） | Mieksido（发布方）；著作权行：Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors | MIT（LICENSE 内含第三方合规附录；MIT 正文源自 qq-bridge） | https://github.com/Mieksido/surfcore | 桥接、记忆、人格、B站、语音调度、控制台、DSH 插件<br>改动：本项目不修改其代码。安装器只按上游文档自动执行安装步骤，并校验 sha256。<br>⚠️ 非官方安装器，与 SurfCore / qq-bridge / SnowLuma 作者均无隶属或背书关系。若最终选择随包分发（方案 B/C），必须随包附完整 MIT 原文与上述著作权行。 |
| surfpet（桌宠） | Mieksido 系 | 待核实 | https://github.com/Mieksido/surfpet | 桌面分身、文本/语音对话<br>改动：未修改，走 Release zip + version.json + sha256 |
| surfvoicecloud（云端声音复刻 TTS） | Mieksido 系 | 待核实 | https://github.com/Mieksido/surfvoicecloud | 云端 TTS（端口 8767），按字符计费<br>改动：未修改，仅调度其 HTTP 接口<br>⚠️ 按字符计费，安装向导需明示费用。 |
| surfvoicelocal（本地 TTS，GPT-SoVITS 系） | Mieksido 系 | 待核实 | https://github.com/Mieksido/surfvoicelocal | 语音条现场合成（端口 8765）<br>改动：未修改，仅调度其 HTTP 接口<br>⚠️ 模型权重体积大且条款独立，永不进安装包。 |
| whisper.cpp（Windows CPU 构建，whisper-cli） | ggml-org / Georgi Gerganov 及贡献者 | MIT | https://github.com/ggml-org/whisper.cpp | 本地语音转文字（STT）引擎，CPU 推理，不联网<br>改动：未修改。只以子进程方式调用 whisper-cli.exe，不自带任何补丁<br>⚠️ 官方 tag 发的 Release 经常没有可执行文件，实际资产挂在 b5454 这类构建 tag 上；pin 的是构建 tag 而不是 vX.Y.Z。 |
| whisper 模型 ggml-tiny | OpenAI（Whisper 权重）/ ggerganov（ggml 转换） | MIT（OpenAI Whisper 权重）；ggml 转换件随 HuggingFace 仓库条款 | https://huggingface.co/ggerganov/whisper.cpp | 语音转文字的声学模型（74 MB）<br>改动：未修改，原样下载并按 sha256 校验<br>⚠️ 模型体积大，永不进安装包；ggml-org/whisper.cpp 仓库目前返回 401，改从 ggerganov/whisper.cpp 取。 |
| zod | Colin McDonnell | MIT | https://github.com/colinhacks/zod | 工具参数校验<br>改动：未修改 |

## 随包分发（1）

> 我们随包附上完整许可证原文，并说明本项目的修改。

| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |
| --- | --- | --- | --- | --- |
| Node.js 运行时（随包内置） | Node.js contributors（OpenSSL / V8 等第三方各自作者，见随包 LICENSE） | MIT（含 OpenSSL 等第三方许可，全文随包） | https://github.com/nodejs/node | 运行安装器、设置中心与 SurfCore 的 JS 运行时<br>改动：未修改，原样复制 node.exe<br>⚠️ 发布包内 runtime/node/LICENSE 是完整许可原文（含全部内置依赖的许可声明）。 |

## 参考设计（未复制源码）（1）

> 本项目参考其设计，但未复制其源码。

| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |
| --- | --- | --- | --- | --- |
| qq-bridge | Derpyu520 | MIT | https://github.com/Derpyu520/qq-bridge | 桥接层结构参考：收发队列、单实例、控制台分层<br>改动：未复制源码；本项目桥接为独立实现，协议层直接对接 @snowluma/sdk<br>⚠️ 设计思路来源，代码为独立实现。 |

## 仅引用文档链接（1）

> 本项目只引用链接，不复刻其正文。

| 组件 | 作者 / 发布方 | 许可证 | 上游 | 用途与我们的改动 |
| --- | --- | --- | --- | --- |
| dsh-qq-bot-playbook | rentaoyan0628-collab | MIT | https://github.com/rentaoyan0628-collab/dsh-qq-bot-playbook | 排障表与设计取舍的参考索引（不复制正文）<br>改动：无<br>⚠️ 作者声明本仓库只放链接与设计说明，故本项目只引用链接，不复刻其正文。 |

---

## 未随包分发的内容（明确声明）

- **SurfCore**：装时从上游拉指定版本并校验，本仓库不含其代码。
- **SnowLuma**：上游许可限制再分发，本项目不打包、不代装、不代登录。
- **语音模型 / STT 模型**：体积大且条款独立，只下载，永不进包。
- **QQ 客户端**：必须是你自己安装的官方 NTQQ。

每个组件的完整字段（含 `versionPin`、`licenseUrl`、收录方式）见 `docs/third-party.json`。
