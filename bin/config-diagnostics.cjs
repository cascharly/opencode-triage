const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const { stripJsoncComments } = require("./shared.cjs")
const { readTriageOptions } = require("./plugin-config.cjs")

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function readConfigForDiagnostics(configPath) {
  let raw
  try {
    raw = fs.readFileSync(configPath, "utf-8")
  } catch {
    return {
      path: configPath,
      exists: fs.existsSync(configPath),
      error: "read_error",
      pluginPresent: false,
      sectionKeys: [],
      sectionHashes: {},
      hash: null,
    }
  }

  try {
    const config = JSON.parse(stripJsoncComments(raw))
    const normalized = JSON.stringify(canonical(config))
    return {
      path: configPath,
      exists: true,
      error: null,
      pluginPresent: readTriageOptions(config) !== null,
      sectionKeys: Object.keys(config).sort(),
      sectionHashes: Object.fromEntries(
        Object.keys(config).sort().map(key => [
          key,
          crypto.createHash("sha256").update(JSON.stringify(canonical(config[key]))).digest("hex").slice(0, 12),
        ])
      ),
      hash: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12),
    }
  } catch {
    return {
      path: configPath,
      exists: true,
      error: "parse_error",
      pluginPresent: false,
      sectionKeys: [],
      sectionHashes: {},
      hash: null,
    }
  }
}

function collectWindowsConfigDiagnostics(GLOBAL_CFG_PATH, WINDOWS_APPDATA_CFG_PATH) {
  if (process.platform !== "win32" || !WINDOWS_APPDATA_CFG_PATH) return null
  const userConfig = readConfigForDiagnostics(GLOBAL_CFG_PATH)
  const appDataConfig = readConfigForDiagnostics(WINDOWS_APPDATA_CFG_PATH)
  const samePath = path.resolve(userConfig.path).toLowerCase() === path.resolve(appDataConfig.path).toLowerCase()
  if (!userConfig.exists || !appDataConfig.exists || samePath) return null

  const sections = new Set([...userConfig.sectionKeys, ...appDataConfig.sectionKeys])
  const differingSections = [...sections]
    .filter(key => userConfig.sectionHashes[key] !== appDataConfig.sectionHashes[key])
    .sort()

  return {
    userConfig,
    appDataConfig,
    sameHash: userConfig.hash !== null && userConfig.hash === appDataConfig.hash,
    differingSections,
  }
}


module.exports = { collectWindowsConfigDiagnostics }
