import { requestUrl } from "obsidian"
import { buildWav, startPcmRecording, toBase64 } from "../recorder"
import type {
  RecognitionCallbacks,
  RecognitionSession,
  TranscriptResult,
  Voice2TextSettings,
  VoiceProvider,
} from "../types"

const MAX_BASE64_AUDIO_CHARS = 10 * 1024 * 1024
const MAX_PCM_BYTES = Math.floor(MAX_BASE64_AUDIO_CHARS * 3 / 4) - 44

function extractText(body: unknown): string {
  const data = body as {
    choices?: Array<{ message?: { content?: unknown } }>
    text?: unknown
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return content.map((item: unknown) => {
      if (typeof item === "string") return item
      if (!item || typeof item !== "object") return ""
      const record = item as Record<string, unknown>
      if (typeof record.text === "string") return record.text
      if (typeof record.content === "string") return record.content
      return ""
    }).join("").trim()
  }
  return typeof data?.text === "string" ? data.text.trim() : ""
}

function extractError(body: unknown): string {
  if (!body || typeof body !== "object") return ""
  const data = body as Record<string, unknown>
  const error = data.error && typeof data.error === "object"
    ? data.error as Record<string, unknown>
    : undefined
  const candidates = [error?.message, error?.details, data.message, data.detail]
  return candidates.find((value) => typeof value === "string" && value.trim()) as string | undefined || ""
}

async function transcribe(settings: Voice2TextSettings, wavBase64: string): Promise<TranscriptResult> {
  const config = settings.providerConfig.mimo
  const endpoint = config.endpoint.trim().replace(/\/+$/, "")
  const normalizedEndpoint = endpoint.endsWith("/v1") ? `${endpoint}/chat/completions` : endpoint
  const response = await requestUrl({
    url: normalizedEndpoint,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey.trim(),
    },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: { data: `data:audio/wav;base64,${wavBase64}` },
        }],
      }],
      asr_options: { language: config.language },
    }),
    throw: false,
  })

  let body: unknown
  try {
    body = response.text.trim() ? JSON.parse(response.text) : {}
  } catch {
    throw new Error(`无法解析小米 MiMo ASR 响应：${response.text.slice(0, 200)}`)
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`小米 MiMo ASR 返回 HTTP ${response.status}${extractError(body) ? `：${extractError(body)}` : ""}`)
  }

  const text = extractText(body)
  if (!text) throw new Error("小米 MiMo ASR 没有返回识别文字。")

  return {
    text,
    stableText: "",
    logId: response.headers["x-request-id"] || response.headers["request-id"] || "",
  }
}

async function createMimoSession(
  settings: Voice2TextSettings,
  _callbacks: RecognitionCallbacks,
): Promise<RecognitionSession> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let tooLarge = false
  const recorder = await startPcmRecording((chunk) => {
    totalBytes += chunk.length
    if (totalBytes > MAX_PCM_BYTES) {
      tooLarge = true
      return
    }
    chunks.push(chunk)
  })
  let stopped = false

  return {
    async stop() {
      if (stopped) throw new Error("当前录音已经停止。")
      stopped = true
      await recorder.stop()
      if (tooLarge) {
        chunks.length = 0
        throw new Error("录音过长，小米 MiMo ASR 的 base64 音频上限为 10MB。")
      }
      if (chunks.length === 0) return { text: "", stableText: "", logId: "" }

      const audioBase64 = toBase64(buildWav(chunks))
      chunks.length = 0
      if (audioBase64.length > MAX_BASE64_AUDIO_CHARS) {
        throw new Error("录音过长，小米 MiMo ASR 的 base64 音频上限为 10MB。")
      }
      return transcribe(settings, audioBase64)
    },
    abort() {
      stopped = true
      chunks.length = 0
      recorder.abort()
    },
  }
}

export const mimoProvider: VoiceProvider = {
  id: "mimo",
  displayName: "小米 MiMo ASR",
  validate(settings) {
    const config = settings.providerConfig.mimo
    if (!config.apiKey.trim()) return "请先在插件设置中填写小米 MiMo API Key。"
    if (!config.endpoint.trim()) return "请先填写小米 MiMo API 地址。"
    if (!config.model.trim()) return "请先填写小米 MiMo 模型名称。"
    return undefined
  },
  createSession: createMimoSession,
}
