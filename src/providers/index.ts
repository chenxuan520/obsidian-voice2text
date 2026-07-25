import type { ProviderId, VoiceProvider } from "../types"
import { mimoProvider } from "./mimo"
import { volcengineProvider } from "./volcengine"

const providers: VoiceProvider[] = [volcengineProvider, mimoProvider]

export function listProviders(): VoiceProvider[] {
  return providers
}

export function getProvider(id: ProviderId): VoiceProvider | undefined {
  return providers.find((provider) => provider.id === id)
}
