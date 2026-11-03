import { computed, ref } from 'vue'

export type SprocketProvider = 'openrouter' | 'agent'

export interface SprocketAgent {
  id: string
  name: string
  keyPrefix: string
  workspace: string
  scopes: string[]
  /** Can read boards and has not expired. */
  usable: boolean
}

export interface SprocketSettings {
  provider: SprocketProvider
  agentKeyId: string | null
  model: string
  effort: string | null
  hasOpenRouterKey: boolean
  openrouterModel: string | null
  agents: SprocketAgent[]
  claude: { allowed: boolean, available: boolean, version: string | null }
  models: string[]
  efforts: string[]
}

// One copy for the chat panel and the settings page, like useUserSettings.
const _settings = ref<SprocketSettings | null>(null)
let _loading: Promise<void> | null = null

export function useSprocketSettings() {
  async function load(force = false) {
    if (_settings.value && !force) return
    _loading ??= $fetch<SprocketSettings>('/api/settings/sprocket')
      .then((data) => {
        _settings.value = data
      })
      .finally(() => {
        _loading = null
      })
    await _loading
  }

  async function save(patch: Partial<Pick<SprocketSettings, 'provider' | 'agentKeyId' | 'model' | 'effort'>>) {
    const current = _settings.value
    if (!current) return
    const body = {
      provider: patch.provider ?? current.provider,
      agentKeyId: patch.agentKeyId !== undefined ? patch.agentKeyId : current.agentKeyId,
      model: patch.model ?? current.model,
      effort: patch.effort !== undefined ? patch.effort : current.effort
    }
    const saved = await $fetch<Pick<SprocketSettings, 'provider' | 'agentKeyId' | 'model' | 'effort'>>('/api/settings/sprocket', { method: 'PUT', body })
    _settings.value = { ...current, ...saved }
  }

  const agent = computed(() => _settings.value?.agents.find(a => a.id === _settings.value?.agentKeyId) ?? null)

  /** One line for the chat header: who answers, with which model. */
  const answeredBy = computed(() => {
    const s = _settings.value
    if (!s) return null
    if (s.provider === 'openrouter') return s.openrouterModel
    return ['Claude Code', s.model, s.effort, agent.value?.name].filter(Boolean).join(' · ')
  })

  return { settings: _settings, agent, answeredBy, load, save }
}
