const TARGET_SAMPLE_RATE = 16000
const WORKLET_NAME = "voice-text-input-pcm-capture"
const WORKLET_SOURCE = `
class VoiceTextInputCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(4096)
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        this.flush()
        this.port.postMessage({ type: "flushed" })
      }
    }
  }

  flush() {
    if (this.offset === 0) return
    const chunk = this.buffer.slice(0, this.offset)
    this.port.postMessage(chunk, [chunk.buffer])
    this.buffer = new Float32Array(4096)
    this.offset = 0
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0]
    if (output) output.fill(0)
    const input = inputs[0] && inputs[0][0]
    if (!input) return true

    let inputOffset = 0
    while (inputOffset < input.length) {
      const count = Math.min(this.buffer.length - this.offset, input.length - inputOffset)
      this.buffer.set(input.subarray(inputOffset, inputOffset + count), this.offset)
      this.offset += count
      inputOffset += count
      if (this.offset === this.buffer.length) this.flush()
    }
    return true
  }
}

registerProcessor("${WORKLET_NAME}", VoiceTextInputCaptureProcessor)
`

export type PcmRecorder = {
  stop: () => Promise<void>
  abort: () => void
}

function resample(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return new Float32Array(input)

  const outputLength = Math.max(1, Math.round(input.length * TARGET_SAMPLE_RATE / inputRate))
  const output = new Float32Array(outputLength)
  const scale = input.length / outputLength

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * scale
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const weight = position - left
    output[index] = input[left] * (1 - weight) + input[right] * weight
  }

  return output
}

function encodePcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return bytes
}

export async function startPcmRecording(onChunk: (chunk: Uint8Array) => void): Promise<PcmRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("当前环境无法访问麦克风。")
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  })

  const AudioContextCtor = window.AudioContext || (window as typeof window & {
    webkitAudioContext?: typeof AudioContext
  }).webkitAudioContext

  if (!AudioContextCtor) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error("当前环境不支持 Web Audio 录音。")
  }

  const audioContext = new AudioContextCtor({ sampleRate: TARGET_SAMPLE_RATE })
  const source = audioContext.createMediaStreamSource(stream)
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }))
  try {
    await audioContext.audioWorklet.addModule(workletUrl)
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    await audioContext.close().catch(() => undefined)
    throw error
  } finally {
    URL.revokeObjectURL(workletUrl)
  }

  const processor = new AudioWorkletNode(audioContext, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  let flushResolver: (() => void) | undefined

  processor.port.onmessage = (event) => {
    const data: unknown = event.data
    if (data instanceof Float32Array) {
      const samples = resample(data, audioContext.sampleRate)
      onChunk(encodePcm16(samples))
      return
    }
    if (typeof data === "object" && data !== null && "type" in data && data.type === "flushed") {
      flushResolver?.()
      flushResolver = undefined
    }
  }

  source.connect(processor)
  processor.connect(audioContext.destination)

  let released = false
  const release = async (flush: boolean) => {
    if (released) return
    released = true
    if (flush) {
      await new Promise<void>((resolve) => {
        flushResolver = resolve
        processor.port.postMessage({ type: "flush" })
      })
    }
    processor.port.onmessage = null
    try {
      processor.disconnect()
      source.disconnect()
    } catch {
      // The audio graph may already be disconnected while Obsidian is unloading.
    }
    stream.getTracks().forEach((track) => track.stop())
    await audioContext.close().catch(() => undefined)
  }

  return {
    stop: () => release(true),
    abort() {
      void release(false)
    },
  }
}

export function buildWav(pcmChunks: Uint8Array[]): Uint8Array {
  const pcmLength = pcmChunks.reduce((total, chunk) => total + chunk.length, 0)
  const wav = new Uint8Array(44 + pcmLength)
  const view = new DataView(wav.buffer)
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + pcmLength, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, pcmLength, true)

  let offset = 44
  for (const chunk of pcmChunks) {
    wav.set(chunk, offset)
    offset += chunk.length
  }

  return wav
}

export function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}
