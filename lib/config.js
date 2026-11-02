/** Plugin configuration: defaults and normalization. Kept dependency-free. */

export const DEFAULT_CONFIG = {
  injectIndex: true,
  indexByteBudget: 4096,
  discoverabilityBudget: 512,
  recallTopK: 40,
  injectGlobalBank: true,
  wrapEnabled: false,
  autoExport: false,
  consoleEnabled: true,
  consolePort: 7788,
}

export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) }
  const int = (value, fallback, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
  }
  config.injectIndex = Boolean(config.injectIndex)
  config.injectGlobalBank = Boolean(config.injectGlobalBank)
  config.wrapEnabled = Boolean(config.wrapEnabled)
  config.autoExport = Boolean(config.autoExport)
  config.indexByteBudget = int(config.indexByteBudget, DEFAULT_CONFIG.indexByteBudget, 256, 32768)
  config.discoverabilityBudget = int(config.discoverabilityBudget, DEFAULT_CONFIG.discoverabilityBudget, 0, 4096)
  config.recallTopK = int(config.recallTopK, DEFAULT_CONFIG.recallTopK, 1, 500)
  config.consoleEnabled = Boolean(config.consoleEnabled)
  config.consolePort = int(config.consolePort, DEFAULT_CONFIG.consolePort, 1024, 65535)
  return config
}
