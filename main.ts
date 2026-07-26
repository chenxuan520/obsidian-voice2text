import {
  App,
  Editor,
  EditorPosition,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  type SettingDefinitionItem,
} from "obsidian"
import { getProvider, listProviders } from "./src/providers"
import { advancePosition, copyPosition, finalSuffix } from "./src/text"
import type {
  MimoConfig,
  ProviderId,
  RecognitionSession,
  VolcengineConfig,
  Voice2TextSettings,
} from "./src/types"

const DEFAULT_SETTINGS: Voice2TextSettings = {
  provider: "volcengine",
  maxDurationSeconds: 180,
  appendTrailingSpace: true,
  providerConfig: {
    volcengine: {
      appId: "",
      accessToken: "",
      resourceId: "volc.seedasr.sauc.duration",
      endpoint: "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
      language: "zh-CN",
      endWindowSize: 800,
    },
    mimo: {
      apiKey: "",
      model: "mimo-v2.5-asr",
      endpoint: "https://api.xiaomimimo.com/v1/chat/completions",
      language: "auto",
    },
  },
}

type Phase = "idle" | "starting" | "recording" | "transcribing"

type InsertTarget = {
  view: MarkdownView
  filePath: string
  editor: Editor
  cursor: EditorPosition
  selectionEnd: EditorPosition
  inserted: boolean
  expectedValue: string
}

export default class Voice2TextPlugin extends Plugin {
  settings: Voice2TextSettings = DEFAULT_SETTINGS
  private phase: Phase = "idle"
  private session: RecognitionSession | undefined
  private insertTarget: InsertTarget | undefined
  private ribbonElement: HTMLElement | undefined
  private maxDurationTimer: number | undefined
  private sessionGeneration = 0
  private disposed = false

  async onload(): Promise<void> {
    this.disposed = false
    await this.loadSettings()

    this.ribbonElement = this.addRibbonIcon(
      "microphone",
      "语音转文字（点击开始或停止）",
      () => void this.toggleRecording(),
    )
    this.ribbonElement.classList.add("voice2text-ribbon")

    this.addCommand({
      id: "toggle-voice-input",
      name: "开始/停止语音转文字",
      hotkeys: [{ modifiers: ["Ctrl"], key: "s" }],
      editorCallback: () => void this.toggleRecording(),
    })

    this.addSettingTab(new Voice2TextSettingTab(this.app, this))
  }

  onunload(): void {
    this.disposed = true
    this.sessionGeneration += 1
    this.clearMaxDurationTimer()
    if (this.session) void Promise.resolve(this.session.abort()).catch(() => undefined)
    this.session = undefined
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<Voice2TextSettings> | null
    const savedProviders = saved?.providerConfig
    const provider = saved?.provider === "mimo" || saved?.provider === "volcengine"
      ? saved.provider
      : DEFAULT_SETTINGS.provider

    const configuredMaxDuration = Math.max(30, Math.min(
      600,
      typeof saved?.maxDurationSeconds === "number"
        ? saved.maxDurationSeconds
        : DEFAULT_SETTINGS.maxDurationSeconds,
    ))
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      provider,
      maxDurationSeconds: provider === "mimo"
        ? Math.min(configuredMaxDuration, 240)
        : configuredMaxDuration,
      providerConfig: {
        volcengine: {
          ...DEFAULT_SETTINGS.providerConfig.volcengine,
          ...savedProviders?.volcengine,
        },
        mimo: {
          ...DEFAULT_SETTINGS.providerConfig.mimo,
          ...savedProviders?.mimo,
        },
      },
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  private async toggleRecording(): Promise<void> {
    if (this.phase === "starting") {
      new Notice("语音转文字正在启动，请稍候。")
      return
    }
    if (this.phase === "transcribing") {
      new Notice("上一段语音仍在识别，请稍候。")
      return
    }
    if (this.phase === "recording") {
      await this.stopAndTranscribe()
      return
    }
    await this.startRecording()
  }

  private captureInsertTarget(): InsertTarget | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view?.file) return undefined
    return {
      view,
      filePath: view.file.path,
      editor: view.editor,
      cursor: copyPosition(view.editor.getCursor("from")),
      selectionEnd: copyPosition(view.editor.getCursor("to")),
      inserted: false,
      expectedValue: view.editor.getValue(),
    }
  }

  private insertText(text: string): void {
    const target = this.insertTarget
    if (!text.trim() || !target) return

    this.writeAtTarget(text)
  }

  private writeAtTarget(text: string): void {
    const target = this.insertTarget
    if (!target) return
    if (target.view.file?.path !== target.filePath || target.editor.getValue() !== target.expectedValue) {
      throw new Error("录音期间目标文档已切换或被编辑，已停止插入以避免覆盖错误内容。")
    }

    const to = target.inserted ? target.cursor : target.selectionEnd
    target.editor.replaceRange(text, target.cursor, to)
    target.cursor = advancePosition(target.cursor, text)
    target.inserted = true
    target.expectedValue = target.editor.getValue()
  }

  private appendConfiguredSpace(): void {
    const target = this.insertTarget
    if (!this.settings.appendTrailingSpace || !target?.inserted) return
    const line = target.editor.getLine(target.cursor.line)
    if (target.cursor.ch > 0 && /\s/.test(line[target.cursor.ch - 1] || "")) return
    this.writeAtTarget(" ")
  }

  private async startRecording(): Promise<void> {
    const provider = getProvider(this.settings.provider)
    if (!provider) {
      new Notice("没有找到所选语音识别服务，请检查插件设置。")
      return
    }

    const configError = provider.validate(this.settings)
    if (configError) {
      new Notice(configError, 6000)
      return
    }

    this.insertTarget = this.captureInsertTarget()
    if (!this.insertTarget) {
      new Notice("请先打开 Markdown 文档并把光标放到要插入文字的位置。")
      return
    }

    this.setPhase("starting")
    new Notice(`正在启动 ${provider.displayName}…`, 2500)
    const generation = ++this.sessionGeneration

    try {
      const session = await provider.createSession(this.settings, {
        onStableText: (text) => {
          if (!this.disposed && this.sessionGeneration === generation) this.insertText(text)
        },
      })
      if (this.disposed || this.sessionGeneration !== generation) {
        await Promise.resolve(session.abort()).catch(() => undefined)
        return
      }
      this.session = session
      this.setPhase("recording")
      new Notice("正在录音，再次点击麦克风停止。", 4000)
      this.maxDurationTimer = window.setTimeout(() => {
        new Notice("已达到最长录音时间，正在停止并识别。")
        void this.stopAndTranscribe()
      }, this.settings.maxDurationSeconds * 1000)
    } catch (error) {
      if (this.disposed || this.sessionGeneration !== generation) return
      this.session = undefined
      this.insertTarget = undefined
      this.setPhase("idle")
      new Notice(this.errorMessage(error), 7000)
    }
  }

  private async stopAndTranscribe(): Promise<void> {
    const currentSession = this.session
    if (!currentSession || this.phase !== "recording") return
    const generation = this.sessionGeneration

    this.clearMaxDurationTimer()
    this.setPhase("transcribing")
    new Notice("录音已停止，正在完成识别…", 3000)

    try {
      const result = await currentSession.stop()
      if (this.disposed || this.sessionGeneration !== generation) return
      const tail = finalSuffix(result.stableText, result.text)
      if (tail) this.insertText(tail)
      this.appendConfiguredSpace()
      if (!result.stableText.trim() && !result.text.trim()) {
        new Notice("没有识别到文字。")
      }
    } catch (error) {
      await Promise.resolve(currentSession.abort()).catch(() => undefined)
      if (!this.disposed && this.sessionGeneration === generation) {
        new Notice(this.errorMessage(error), 7000)
      }
    } finally {
      if (!this.disposed && this.sessionGeneration === generation) {
        this.session = undefined
        this.insertTarget = undefined
        this.setPhase("idle")
      }
    }
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    const element = this.ribbonElement
    if (!element) return
    element.classList.toggle("is-starting", phase === "starting")
    element.classList.toggle("is-recording", phase === "recording")
    element.classList.toggle("is-transcribing", phase === "transcribing")
  }

  private clearMaxDurationTimer(): void {
    if (this.maxDurationTimer === undefined) return
    window.clearTimeout(this.maxDurationTimer)
    this.maxDurationTimer = undefined
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}

class Voice2TextSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: Voice2TextPlugin) {
    super(app, plugin)
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const volcengine = this.plugin.settings.providerConfig.volcengine
    const mimo = this.plugin.settings.providerConfig.mimo
    const refresh = () => undefined

    return [
      {
        name: "识别服务",
        desc: "火山引擎支持边说边写；小米 MiMo 在停止录音后整段识别。",
        render: (setting) => this.addProviderControl(setting, refresh),
      },
      {
        name: "最长录音时间",
        desc: this.durationDescription(),
        render: (setting) => this.addDurationControl(setting),
      },
      {
        name: "识别结果后添加空格",
        desc: "适合连续口述；关闭后会紧接光标后的内容。",
        render: (setting) => this.addTrailingSpaceControl(setting),
      },
      {
        type: "group",
        heading: "火山引擎大模型 ASR",
        items: [
          {
            name: "App ID",
            desc: "火山引擎语音识别应用的 App ID。",
            render: (setting) => this.addTextControl(setting, volcengine, "appId"),
          },
          {
            name: "Access Token",
            desc: "凭证只保存在当前 Vault 的插件数据中。",
            render: (setting) => this.addTextControl(setting, volcengine, "accessToken", true),
          },
          {
            name: "Resource ID",
            desc: "需与控制台开通的资源一致。",
            render: (setting) => this.addTextControl(setting, volcengine, "resourceId"),
          },
          {
            name: "WebSocket 地址",
            desc: "大模型流式语音识别接口。",
            render: (setting) => this.addTextControl(setting, volcengine, "endpoint"),
          },
          {
            name: "识别语言",
            desc: "例如 zh-CN；留空则由服务端处理。",
            render: (setting) => this.addTextControl(setting, volcengine, "language"),
          },
          {
            name: "静音判停窗口",
            desc: "火山引擎 end_window_size，单位为毫秒。",
            render: (setting) => this.addEndWindowControl(setting, volcengine),
          },
        ],
      },
      {
        type: "group",
        heading: "小米 MiMo ASR",
        items: [
          {
            name: "API Key",
            desc: "小米 MiMo 开放平台的 API Key，只保存在当前 Vault。",
            render: (setting) => this.addTextControl(setting, mimo, "apiKey", true),
          },
          {
            name: "模型",
            desc: "默认使用 mimo-v2.5-asr。",
            render: (setting) => this.addTextControl(setting, mimo, "model"),
          },
          {
            name: "API 地址",
            desc: "兼容 /v1 或完整 chat/completions 地址。",
            render: (setting) => this.addTextControl(setting, mimo, "endpoint"),
          },
          {
            name: "识别语言",
            desc: "明确语种时手动指定可提高准确率。",
            render: (setting) => this.addMimoLanguageControl(setting, mimo),
          },
        ],
      },
    ]
  }

  display(): void {
    this.renderLegacySettings()
  }

  private renderLegacySettings(): void {
    const { containerEl } = this
    containerEl.empty()

    this.addProviderControl(new Setting(containerEl)
      .setName("识别服务")
      .setDesc("火山引擎支持边说边写；小米 MiMo 在停止录音后整段识别。"), () => this.renderLegacySettings())

    this.addDurationControl(new Setting(containerEl)
      .setName("最长录音时间")
      .setDesc(this.durationDescription()))

    this.addTrailingSpaceControl(new Setting(containerEl)
      .setName("识别结果后添加空格")
      .setDesc("适合连续口述；关闭后会紧接光标后的内容。"))

    if (this.plugin.settings.provider === "volcengine") {
      const config = this.plugin.settings.providerConfig.volcengine
      new Setting(containerEl).setName("火山引擎大模型 ASR").setHeading()
      this.addTextSetting(containerEl, "App ID", "火山引擎语音识别应用的 App ID。", config, "appId")
      this.addTextSetting(containerEl, "Access Token", "凭证只保存在当前 Vault 的插件数据中。", config, "accessToken", true)
      this.addTextSetting(containerEl, "Resource ID", "需与控制台开通的资源一致。", config, "resourceId")
      this.addTextSetting(containerEl, "WebSocket 地址", "大模型流式语音识别接口。", config, "endpoint")
      this.addTextSetting(containerEl, "识别语言", "例如 zh-CN；留空则由服务端处理。", config, "language")
      this.addEndWindowControl(new Setting(containerEl)
        .setName("静音判停窗口")
        .setDesc("火山引擎 end_window_size，单位为毫秒。"), config)
    } else {
      const config = this.plugin.settings.providerConfig.mimo
      new Setting(containerEl).setName("小米 MiMo ASR").setHeading()
      this.addTextSetting(containerEl, "API Key", "小米 MiMo 开放平台的 API Key，只保存在当前 Vault。", config, "apiKey", true)
      this.addTextSetting(containerEl, "模型", "默认使用 mimo-v2.5-asr。", config, "model")
      this.addTextSetting(containerEl, "API 地址", "兼容 /v1 或完整 chat/completions 地址。", config, "endpoint")
      this.addMimoLanguageControl(new Setting(containerEl)
        .setName("识别语言")
        .setDesc("明确语种时手动指定可提高准确率。"), config)
    }
  }

  private durationDescription(): string {
    return "达到上限后自动停止。火山引擎最多 600 秒；MiMo 受 10MB 音频上限约束，最多 240 秒。"
  }

  private addProviderControl(setting: Setting, refresh: () => void): void {
    setting.addDropdown((dropdown) => {
      for (const provider of listProviders()) dropdown.addOption(provider.id, provider.displayName)
      dropdown.setValue(this.plugin.settings.provider)
      dropdown.onChange(async (value) => {
        this.plugin.settings.provider = value as ProviderId
        if (value === "mimo") {
          this.plugin.settings.maxDurationSeconds = Math.min(this.plugin.settings.maxDurationSeconds, 240)
        }
        await this.plugin.saveSettings()
        refresh()
      })
    })
  }

  private addDurationControl(setting: Setting): void {
    setting.addSlider((slider) => slider
      .setLimits(30, 600, 30)
      .setValue(this.plugin.settings.maxDurationSeconds)
      .onChange(async (value) => {
        const maximum = this.plugin.settings.provider === "mimo" ? 240 : 600
        const duration = Math.min(value, maximum)
        this.plugin.settings.maxDurationSeconds = duration
        if (duration !== value) slider.setValue(duration)
        await this.plugin.saveSettings()
      }))
  }

  private addTrailingSpaceControl(setting: Setting): void {
    setting.addToggle((toggle) => toggle
      .setValue(this.plugin.settings.appendTrailingSpace)
      .onChange(async (value) => {
        this.plugin.settings.appendTrailingSpace = value
        await this.plugin.saveSettings()
      }))
  }

  private addEndWindowControl(setting: Setting, config: VolcengineConfig): void {
    setting.addSlider((slider) => slider
      .setLimits(200, 5000, 100)
      .setValue(config.endWindowSize)
      .onChange(async (value) => {
        config.endWindowSize = value
        await this.plugin.saveSettings()
      }))
  }

  private addMimoLanguageControl(setting: Setting, config: MimoConfig): void {
    setting.addDropdown((dropdown) => dropdown
        .addOption("auto", "自动检测")
        .addOption("zh", "中文")
        .addOption("en", "英文")
        .setValue(config.language)
        .onChange(async (value) => {
          config.language = value as MimoConfig["language"]
          await this.plugin.saveSettings()
        }))
  }

  private addTextSetting<T extends VolcengineConfig | MimoConfig, K extends {
    [P in keyof T]: T[P] extends string ? P : never
  }[keyof T]>(
    containerEl: HTMLElement,
    name: string,
    description: string,
    config: T,
    key: K,
    password = false,
  ): void {
    this.addTextControl(new Setting(containerEl).setName(name).setDesc(description), config, key, password)
  }

  private addTextControl<T extends VolcengineConfig | MimoConfig, K extends {
    [P in keyof T]: T[P] extends string ? P : never
  }[keyof T]>(setting: Setting, config: T, key: K, password = false): void {
    setting.addText((text) => {
      text.setValue(config[key] as string)
      text.onChange(async (value) => {
        config[key] = value as T[K]
        await this.plugin.saveSettings()
      })
      if (password) text.inputEl.type = "password"
    })
  }
}
