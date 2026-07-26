import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { mimoProvider } from "../src/providers/mimo"
import { volcengineProvider } from "../src/providers/volcengine"
import type { Voice2TextSettings, VoiceProvider } from "../src/types"

type WorkletMessage = {
  data: unknown
}

class FakeMessagePort {
  onmessage: ((event: WorkletMessage) => void) | null = null

  postMessage(message: unknown): void {
    if (typeof message === "object" && message !== null && "type" in message && message.type === "flush") {
      queueMicrotask(() => this.onmessage?.({ data: { type: "flushed" } }))
    }
  }
}

class FakeAudioWorkletNode {
  readonly port = new FakeMessagePort()

  constructor(_context: unknown, _name: string, _options: unknown) {
    activeProcessor = this
  }

  connect(): void {}
  disconnect(): void {}
}

let activeProcessor: FakeAudioWorkletNode | undefined

class FakeAudioContext {
  readonly sampleRate = 16000
  readonly destination = {}
  readonly audioWorklet = {
    async addModule(_url: string): Promise<void> {},
  }

  createMediaStreamSource() {
    return {
      connect() {},
      disconnect() {},
    }
  }

  async close(): Promise<void> {}
}

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() {
        return {
          getTracks: () => [{ stop() {} }],
        }
      },
    },
  },
})

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    AudioContext: FakeAudioContext,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  },
})

Object.defineProperty(globalThis, "AudioWorkletNode", {
  configurable: true,
  value: FakeAudioWorkletNode,
})

function providerConfig(local: any, providerId: "volcengine" | "mimo"): Record<string, unknown> {
  const root = local.providerConfig
  if (root?.[providerId] && typeof root[providerId] === "object") return root[providerId]
  if (local.provider === providerId && root && typeof root === "object") return root
  return {}
}

function loadSettings(): Voice2TextSettings {
  const configPath = path.join(os.homedir(), ".config", "opencode", "voice2text.local.json")
  const local = JSON.parse(readFileSync(configPath, "utf8"))
  const volcengine = providerConfig(local, "volcengine")
  const mimo = providerConfig(local, "mimo")

  return {
    provider: "volcengine",
    maxDurationSeconds: 30,
    appendTrailingSpace: false,
    providerConfig: {
      volcengine: {
        appId: String(volcengine.appId || local.appId || ""),
        accessToken: String(volcengine.accessToken || local.accessToken || ""),
        resourceId: String(volcengine.resourceId || "volc.seedasr.sauc.duration"),
        endpoint: String(volcengine.endpoint || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"),
        language: "zh-CN",
        endWindowSize: 800,
      },
      mimo: {
        apiKey: String(mimo.apiKey || local.mimoApiKey || ""),
        model: String(mimo.model || "mimo-v2.5-asr"),
        endpoint: String(mimo.endpoint || "https://api.xiaomimimo.com/v1/chat/completions"),
        language: "zh",
      },
    },
  }
}

function synthesizeSpeech(): Float32Array {
  const directory = mkdtempSync(path.join(os.tmpdir(), "obsidian-voice2text-"))
  const aiffPath = path.join(directory, "speech.aiff")
  const rawPath = path.join(directory, "speech.raw")
  try {
    execFileSync("/usr/bin/say", ["-o", aiffPath, "这是一次语音转文字测试"])
    execFileSync("/opt/homebrew/bin/sox", [
      aiffPath,
      "-r", "16000",
      "-c", "1",
      "-b", "16",
      "-e", "signed-integer",
      "-L",
      "-t", "raw",
      rawPath,
    ])
    const pcm = readFileSync(rawPath)
    const samples = new Float32Array(Math.floor(pcm.length / 2))
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = pcm.readInt16LE(index * 2) / 0x8000
    }
    return samples
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function feedAudio(samples: Float32Array): void {
  assert(activeProcessor?.port.onmessage, "recorder did not create an audio worklet")
  for (let offset = 0; offset < samples.length; offset += 4096) {
    const chunk = samples.slice(offset, Math.min(offset + 4096, samples.length))
    activeProcessor.port.onmessage({ data: chunk })
  }
}

async function testProvider(
  provider: VoiceProvider,
  settings: Voice2TextSettings,
  samples: Float32Array,
): Promise<void> {
  const validationError = provider.validate(settings)
  assert.equal(validationError, undefined, `${provider.displayName} is not configured`)

  activeProcessor = undefined
  const stableParts: string[] = []
  const session = await provider.createSession(settings, {
    onStableText: (text) => {
      stableParts.push(text)
    },
  })
  feedAudio(samples)
  const result = await session.stop()
  const transcript = result.text.trim() || stableParts.join("").trim()
  assert(transcript, `${provider.displayName} returned an empty transcript`)
  console.log(`${provider.displayName}: ${transcript}`)
}

async function main(): Promise<void> {
  const settings = loadSettings()
  const samples = synthesizeSpeech()
  assert(samples.length > 16000, "synthesized speech is unexpectedly short")
  await testProvider(volcengineProvider, settings, samples)
  await testProvider(mimoProvider, settings, samples)
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
