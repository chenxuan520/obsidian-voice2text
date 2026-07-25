export type ProviderId = "volcengine" | "mimo"

export type VolcengineConfig = {
  appId: string
  accessToken: string
  resourceId: string
  endpoint: string
  language: string
  endWindowSize: number
}

export type MimoConfig = {
  apiKey: string
  model: string
  endpoint: string
  language: "auto" | "zh" | "en"
}

export type Voice2TextSettings = {
  provider: ProviderId
  maxDurationSeconds: number
  appendTrailingSpace: boolean
  providerConfig: {
    volcengine: VolcengineConfig
    mimo: MimoConfig
  }
}

export type RecognitionCallbacks = {
  onStableText?: (text: string) => Promise<void> | void
}

export type TranscriptResult = {
  text: string
  stableText: string
  logId: string
}

export type RecognitionSession = {
  stop: () => Promise<TranscriptResult>
  abort: () => Promise<void> | void
}

export type VoiceProvider = {
  id: ProviderId
  displayName: string
  validate: (settings: Voice2TextSettings) => string | undefined
  createSession: (
    settings: Voice2TextSettings,
    callbacks: RecognitionCallbacks,
  ) => Promise<RecognitionSession>
}
