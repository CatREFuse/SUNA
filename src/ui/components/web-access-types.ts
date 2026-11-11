export type ProviderId = 'tavily' | 'deepseek'
export type OperationId = 'search' | 'fetch'

export interface OperationState {
  available: boolean
  status: 'unconfigured' | 'disabled' | 'unverified' | 'connected' | 'error' | 'unsupported' | 'closed'
  reason?: string
  lastCheckedAt?: string
  provider?: ProviderId
  attempts?: Array<{provider: ProviderId; ok: boolean; code?: string}>
}

export interface ProviderStatus {
  id: ProviderId
  enabled: boolean
  configured: boolean
  hasApiKey: boolean
  baseURL: string
  credentialSource: 'client'
  state: OperationState
}

export interface OperationConfigStatus {
  enabled: boolean
  order: ProviderId[]
  providers: ProviderStatus[]
  supportedProviders: ProviderId[]
  available: boolean
  state: OperationState
}

export interface SearchStatus {
  schemaVersion: 4
  version: number
  operations: Record<OperationId, OperationConfigStatus>
  available: boolean
  fetchAvailable: boolean
  search: OperationState
  fetch: OperationState
}

type VersionedOperation = {operation: OperationId; expectedVersion: number}
type ProviderValues = {enabled?: boolean; apiKey?: string; baseURL?: string}
export type WebSettingsPatch = VersionedOperation & (
  | {action: 'add'; provider: ProviderId} & ProviderValues
  | {action: 'update'; provider: ProviderId; clearApiKey?: boolean} & ProviderValues
  | {action: 'remove'; provider: ProviderId}
  | {action: 'reorder'; order: ProviderId[]}
  | {action: 'set-enabled'; enabled: boolean}
)
