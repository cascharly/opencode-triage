const NAME = "opencode-triage"

function target(entry) {
  return typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : entry?.package
}

function isTriageEntry(entry) {
  const name = target(entry)
  return typeof name === "string" && (name === NAME || name.startsWith(NAME + "@"))
}

function options(entry) {
  const value = Array.isArray(entry) ? entry[1] : entry?.options
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function readTriageOptions(config) {
  for (const key of ["plugins", "plugin"]) {
    if (!Array.isArray(config[key])) continue
    const entry = config[key].find(isTriageEntry)
    if (entry !== undefined) return options(entry)
  }
  return null
}

function setTriageState(config, enabled) {
  const matches = []
  for (const key of ["plugins", "plugin"]) {
    if (!Array.isArray(config[key])) continue
    config[key].forEach((entry, index) => { if (isTriageEntry(entry)) matches.push({ key, index, entry }) })
  }
  if (!matches.length) {
    if (!enabled) return false
    const key = Object.hasOwn(config, "plugins") ? "plugins" : "plugin"
    if (config[key] !== undefined && !Array.isArray(config[key])) throw new Error(`Invalid ${key} configuration`)
    config[key] ??= []
    matches.push({ key, index: config[key].length, entry: NAME })
  }
  let changed = false
  for (const { key, index, entry } of matches) {
    const nextOptions = { ...options(entry), autoHide: enabled }
    const next = key === "plugins"
      ? { ...(typeof entry === "object" && !Array.isArray(entry) ? entry : {}), package: target(entry), options: nextOptions }
      : [target(entry), nextOptions]
    if (JSON.stringify(entry) === JSON.stringify(next)) continue
    config[key][index] = next
    changed = true
  }
  return changed
}

module.exports = { isTriageEntry, readTriageOptions, setTriageState }
