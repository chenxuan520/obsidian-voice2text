# Voice2Text

[![CI](https://github.com/chenxuan520/obsidian-voice2text/actions/workflows/ci.yml/badge.svg)](https://github.com/chenxuan520/obsidian-voice2text/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/chenxuan520/obsidian-voice2text)](https://github.com/chenxuan520/obsidian-voice2text/releases)

Record speech in Obsidian desktop and insert the transcript at the editor cursor.

## Features

- Press `Ctrl+S` to start recording and press it again to stop. The command can be rebound under **Settings → Hotkeys**.
- Volcengine big-model ASR streams stable transcript segments into the note while you speak.
- Xiaomi MiMo ASR uploads a WAV recording after you stop and inserts the final transcript.
- Provider credentials are stored only in the current vault's plugin data.

## Network and privacy

- The plugin connects only when you start recording. Volcengine receives streaming PCM audio; Xiaomi MiMo receives a WAV recording after capture stops.
- Both providers require your own account and API credentials and may charge according to their pricing policies.
- Credentials remain in `.obsidian/plugins/voice-text-input/data.json`. The plugin has no client-side telemetry, ads, or self-update mechanism.
- The plugin does not send your local username or hostname. It is desktop-only because authenticated Volcengine WebSocket connections require Node.js networking support.

## Installation and configuration

Install **Voice2Text** from Obsidian's Community plugins browser. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release into `.obsidian/plugins/voice-text-input/`.

Open the plugin settings, select Volcengine or Xiaomi MiMo, and enter the credentials issued by that provider. The default Volcengine resource ID is `volc.seedasr.sauc.duration`; the default Xiaomi model is `mimo-v2.5-asr`.

## 中文说明

在 Obsidian 桌面端录音，把识别文字插入录音开始时的编辑器光标位置。

## 功能

- 按 `Ctrl+S` 开始录音，再按一次停止；也可以点击左侧栏麦克风按钮。
- 可在“设置 → 快捷键”中修改“开始/停止语音转文字”的快捷键。
- 火山引擎大模型 ASR：WebSocket 流式识别，稳定片段边说边写。
- 小米 MiMo ASR：停止后上传整段 WAV，一次性插入最终结果。
- App ID、Token、API Key 等配置只保存在当前 Vault 的插件 `data.json`。

插件使用 Node.js TLS/WebSocket 能力给火山引擎请求添加鉴权头，因此只支持 Obsidian 桌面端。

## 网络与隐私

- 插件仅在用户主动录音时连接所选服务。选择火山引擎时，麦克风 PCM 音频会流式发送到火山引擎；选择小米 MiMo 时，录音会封装为 WAV 并在停止后发送到小米 MiMo。
- 两种服务都需要用户自行申请账号和 API 凭证，服务商可能按其计费规则收费。
- App ID、Access Token 和 API Key 仅保存在当前 Vault 的 `.obsidian/plugins/voice-text-input/data.json`，不会写入笔记或发送给其它服务。
- 插件不包含客户端遥测、广告或自动更新机制，也不会发送本机用户名和主机名。

## 安装

优先在 Obsidian 第三方插件市场中搜索 `Voice2Text` 安装。手动安装时，从 [Releases](https://github.com/chenxuan520/obsidian-voice2text/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`，放到 Vault 的 `.obsidian/plugins/voice-text-input/`，然后启用插件。

## 火山引擎配置

在插件设置中选择“火山引擎大模型 ASR”，填写：

- App ID
- Access Token
- Resource ID，默认 `volc.seedasr.sauc.duration`
- WebSocket 地址，默认 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
- 识别语言，默认 `zh-CN`

App ID、Access Token 和 Resource ID 必须属于同一个已开通大模型流式语音识别的火山引擎应用。

## 小米 MiMo 配置

在插件设置中选择“小米 MiMo ASR”，填写 API Key。默认配置为：

- 模型：`mimo-v2.5-asr`
- API 地址：`https://api.xiaomimimo.com/v1/chat/completions`
- 语言：自动检测

MiMo 单次请求的 base64 音频上限为 10MB。插件录制 16kHz、16bit、单声道 WAV。

## 开发

```bash
npm install
npm test
npm run build
```

构建产物为根目录下的 `main.js`。本地安装时，将以下文件放入 Vault 的 `.obsidian/plugins/voice-text-input/`：

- `main.js`
- `manifest.json`
- `styles.css`

启用插件后，首次录音时 Obsidian/系统会请求麦克风权限。

本机同时配置了两种服务时，可以运行真实合成语音测试：

```bash
npm run test:live
```

该命令读取 `~/.config/opencode/voice2text.local.json`，使用 macOS `say` 和 SoX 生成测试语音，不会打印凭证。

## CI/CD

- push 和 pull request 自动执行单元测试、类型检查和生产构建，并上传可安装插件 ZIP。
- 推送与 `package.json`、`manifest.json` 版本完全一致的标签（例如 `0.1.3`）时，自动创建 GitHub Release 并上传三个插件文件。
