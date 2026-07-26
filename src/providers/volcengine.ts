import { randomUUID } from "node:crypto"
import zlib from "node:zlib"
import WebSocket, { type RawData } from "ws"
import { startPcmRecording, type PcmRecorder } from "../recorder"
import type {
  RecognitionCallbacks,
  RecognitionSession,
  TranscriptResult,
  Voice2TextSettings,
  VoiceProvider,
} from "../types"

const HEADER_VERSION = 0x1
const HEADER_SIZE = 0x1
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2
const MESSAGE_TYPE_ERROR = 0xf
const SERIALIZATION_NONE = 0x0
const SERIALIZATION_JSON = 0x1
const COMPRESSION_GZIP = 0x1
const NETWORK_TIMEOUT_MS = 30_000
const AUDIO_CHUNK_MS = 200

type VolcengineResponse = {
  flags: number
  data: unknown
}

type VolcengineUtterance = {
  definite?: unknown
  text?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function buildProtocolHeader(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
): Buffer {
  return Buffer.from([
    (HEADER_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ])
}

function buildClientMessage(
  messageType: number,
  flags: number,
  payload: Buffer,
  serialization: number,
): Buffer {
  const compressedPayload = zlib.gzipSync(payload)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(compressedPayload.length)
  return Buffer.concat([
    buildProtocolHeader(messageType, flags, serialization, COMPRESSION_GZIP),
    size,
    compressedPayload,
  ])
}

function buildLastAudioMessage(): Buffer {
  return buildClientMessage(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    0x2,
    Buffer.alloc(0),
    SERIALIZATION_NONE,
  )
}

function parseServerMessage(message: Buffer): VolcengineResponse {
  if (message.length < 8) throw new Error("火山引擎返回了无效的数据帧。")

  const headerSize = (message[0] & 0x0f) * 4
  const messageType = message[1] >> 4
  const flags = message[1] & 0x0f
  const serialization = message[2] >> 4
  const compression = message[2] & 0x0f
  let offset = headerSize

  if (messageType === MESSAGE_TYPE_ERROR) {
    const code = message.readUInt32BE(offset)
    offset += 4
    const payloadSize = message.readUInt32BE(offset)
    offset += 4
    const payload = message.subarray(offset, offset + payloadSize)
    const text = compression === COMPRESSION_GZIP
      ? zlib.gunzipSync(payload).toString("utf8")
      : payload.toString("utf8")
    throw new Error(`火山引擎 ASR 错误 ${code}：${text}`)
  }

  if (flags === 0x1 || flags === 0x3) offset += 4
  if (offset + 4 > message.length) throw new Error("火山引擎响应缺少数据长度。")
  const payloadSize = message.readUInt32BE(offset)
  offset += 4
  const payload = message.subarray(offset, offset + payloadSize)
  const body = compression === COMPRESSION_GZIP ? zlib.gunzipSync(payload) : payload

  const data: unknown = serialization === SERIALIZATION_JSON
    ? JSON.parse(body.toString("utf8")) as unknown
    : body
  return { flags, data }
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

class BinarySocket {
  private readonly socket: WebSocket
  private readonly frames: Buffer[] = []
  private readonly waiters: Array<{
    resolve: (frame: Buffer) => void
    reject: (error: Error) => void
  }> = []
  private closedError: Error | undefined
  private responseHeaders: Record<string, string> = {}

  constructor(endpoint: string, headers: Record<string, string>) {
    this.socket = new WebSocket(endpoint, { headers, handshakeTimeout: NETWORK_TIMEOUT_MS })
    this.socket.on("upgrade", (response) => {
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === "string") this.responseHeaders[key.toLowerCase()] = value
        else if (Array.isArray(value)) this.responseHeaders[key.toLowerCase()] = value.join(", ")
      }
    })
    this.socket.on("message", (data, isBinary) => {
      if (!isBinary) return
      const frame = rawDataToBuffer(data)
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(frame)
      else this.frames.push(frame)
    })
    this.socket.on("error", (error) => this.markClosed(error))
    this.socket.on("close", () => this.markClosed(new Error("火山引擎 WebSocket 已关闭。")))
  }

  async open(): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup()
        this.socket.terminate()
        reject(new Error("连接火山引擎 ASR 超时。"))
      }, NETWORK_TIMEOUT_MS)
      const cleanup = () => {
        window.clearTimeout(timer)
        this.socket.off("open", onOpen)
        this.socket.off("error", onError)
      }
      const onOpen = () => {
        cleanup()
        resolve(this.responseHeaders)
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      this.socket.once("open", onOpen)
      this.socket.once("error", onError)
    })
  }

  send(payload: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw this.closedError || new Error("火山引擎 WebSocket 尚未连接。")
    }
    this.socket.send(payload, { binary: true })
  }

  receive(timeoutMs?: number): Promise<Buffer> {
    const frame = this.frames.shift()
    if (frame) return Promise.resolve(frame)
    if (this.closedError) return Promise.reject(this.closedError)

    return new Promise((resolve, reject) => {
      let timer: number | undefined
      const waiter = {
        resolve: (value: Buffer) => {
          if (timer) window.clearTimeout(timer)
          resolve(value)
        },
        reject: (error: Error) => {
          if (timer) window.clearTimeout(timer)
          reject(error)
        },
      }
      if (timeoutMs !== undefined) {
        timer = window.setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error("等待火山引擎 ASR 响应超时。"))
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        this.socket.terminate()
        resolve()
      }, 300)
      this.socket.once("close", () => {
        window.clearTimeout(timer)
        resolve()
      })
      this.socket.close()
    })
  }

  private markClosed(error: Error): void {
    if (!this.closedError) this.closedError = error
    while (this.waiters.length > 0) this.waiters.shift()?.reject(this.closedError)
  }
}

function buildRequest(settings: Voice2TextSettings): Record<string, unknown> {
  const config = settings.providerConfig.volcengine
  const audio: Record<string, unknown> = {
    format: "pcm",
    codec: "raw",
    rate: 16000,
    bits: 16,
    channel: 1,
  }
  if (config.language.trim()) audio.language = config.language.trim()

  return {
    user: {
      uid: "obsidian-user",
      did: "obsidian",
      platform: process.platform,
      sdk_version: "obsidian-plugin",
      app_version: "voice2text",
    },
    audio,
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      result_type: "full",
      show_utterances: true,
      end_window_size: config.endWindowSize,
    },
  }
}

function resultOf(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data.result)) return undefined
  return data.result
}

function transcriptTextOf(data: unknown): string {
  const text = resultOf(data)?.text
  return typeof text === "string" ? text.trim() : ""
}

function stableTextOf(data: unknown): string {
  const value = resultOf(data)?.utterances
  if (!Array.isArray(value)) return ""
  const utterances = value.filter((item): item is VolcengineUtterance => isRecord(item))
  return utterances
    .filter((item) => item.definite === true && typeof item.text === "string" && item.text.trim())
    .map((item) => item.text as string)
    .join("")
    .trim()
}

function suffixAfter(previous: string, next: string): string {
  if (!next) return ""
  if (!previous) return next
  return next.startsWith(previous) ? next.slice(previous.length) : ""
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(errorOf(error))
      },
    )
  })
}

async function createVolcengineSession(
  settings: Voice2TextSettings,
  callbacks: RecognitionCallbacks,
): Promise<RecognitionSession> {
  const config = settings.providerConfig.volcengine
  const client = new BinarySocket(config.endpoint.trim(), {
    "X-Api-App-Key": config.appId.trim(),
    "X-Api-Access-Key": config.accessToken.trim(),
    "X-Api-Resource-Id": config.resourceId.trim(),
    "X-Api-Connect-Id": randomUUID(),
  })

  let responseHeaders: Record<string, string>
  try {
    responseHeaders = await client.open()
    client.send(buildClientMessage(
      MESSAGE_TYPE_FULL_CLIENT_REQUEST,
      0,
      Buffer.from(JSON.stringify(buildRequest(settings)), "utf8"),
      SERIALIZATION_JSON,
    ))
    parseServerMessage(await client.receive(NETWORK_TIMEOUT_MS))
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }

  let finalText = ""
  let stableText = ""
  const receiveLoop = (async (): Promise<TranscriptResult> => {
    while (true) {
      const response = parseServerMessage(await client.receive())
      const nextText = transcriptTextOf(response.data)
      if (nextText) finalText = nextText

      const nextStableText = stableTextOf(response.data)
      const delta = suffixAfter(stableText, nextStableText)
      if (delta) {
        stableText = nextStableText
        await callbacks.onStableText?.(delta)
      }

      if (response.flags === 0x3) {
        return {
          text: finalText,
          stableText,
          logId: responseHeaders["x-tt-logid"] || "",
        }
      }
    }
  })()
  void receiveLoop.catch(() => undefined)

  const chunkBytes = 16000 * 2 * AUDIO_CHUNK_MS / 1000
  let pending = Buffer.alloc(0)
  let sendChain = Promise.resolve()
  let recorder: PcmRecorder

  try {
    recorder = await startPcmRecording((chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)])
    })
  } catch (error) {
    await client.close().catch(() => undefined)
    throw error
  }

  const queueAudio = (audio: Buffer) => {
    sendChain = sendChain.then(() => {
      client.send(buildClientMessage(
        MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
        0,
        audio,
        SERIALIZATION_NONE,
      ))
    })
  }
  const sendTimer = window.setInterval(() => {
    if (pending.length < chunkBytes) return
    const next = pending.subarray(0, chunkBytes)
    pending = pending.subarray(chunkBytes)
    queueAudio(next)
  }, AUDIO_CHUNK_MS)

  let stopResult: Promise<TranscriptResult> | undefined
  let aborted = false

  return {
    stop() {
      if (!stopResult) {
        stopResult = (async () => {
          window.clearInterval(sendTimer)
          await recorder.stop()
          while (pending.length >= chunkBytes) {
            const next = pending.subarray(0, chunkBytes)
            pending = pending.subarray(chunkBytes)
            queueAudio(next)
          }
          if (pending.length > 0) {
            const tail = pending
            pending = Buffer.alloc(0)
            queueAudio(tail)
          }
          await sendChain
          client.send(buildLastAudioMessage())
          try {
            return await withTimeout(
              receiveLoop,
              NETWORK_TIMEOUT_MS,
              "等待火山引擎最终识别结果超时。",
            )
          } finally {
            await client.close()
          }
        })()
      }
      return stopResult
    },
    async abort() {
      if (aborted) return
      aborted = true
      window.clearInterval(sendTimer)
      recorder.abort()
      pending = Buffer.alloc(0)
      await client.close()
    },
  }
}

export const volcengineProvider: VoiceProvider = {
  id: "volcengine",
  displayName: "火山引擎大模型 ASR",
  validate(settings) {
    const config = settings.providerConfig.volcengine
    if (!config.appId.trim()) return "请先在插件设置中填写火山引擎 App ID。"
    if (!config.accessToken.trim()) return "请先填写火山引擎 Access Token。"
    if (!config.resourceId.trim()) return "请先填写火山引擎 Resource ID。"
    if (!config.endpoint.trim()) return "请先填写火山引擎 WebSocket 地址。"
    return undefined
  },
  createSession: createVolcengineSession,
}
