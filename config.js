/**
 * CodeGuard Extension - Environment Configuration
 *
 * LAN-first: the Server URL and Client URL are configured by the proctor via
 * the extension Options page (chrome.storage.local). This lets one build run
 * against localhost, a LAN server (e.g. http://192.168.1.50:3000), or a cloud
 * deployment — without rebuilding. Falls back to localhost for development.
 *
 * All previously hardcoded Render/Vercel production URLs have been removed.
 */

// ========== Defaults (development) ==========

const DEFAULT_CONFIG = {
  CLIENT_URL: 'http://localhost:5173',
  API_BASE_URL: 'http://localhost:3000',
  SOCKET_URL: 'http://localhost:3000',
};

// Back-compat alias (some callers still import DEV_CONFIG semantics).
const DEV_CONFIG = DEFAULT_CONFIG;

// ========== Environment Detection ==========

export function isDevEnvironment(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('localhost') || lowerUrl.includes('127.0.0.1');
}

/**
 * Returns the active config, preferring proctor-configured stored URLs.
 * `isDev` is accepted for signature back-compat but no longer branches to a
 * hardcoded production block.
 */
export function getConfig() {
  return {
    CLIENT_URL: storedClientUrl || DEFAULT_CONFIG.CLIENT_URL,
    API_BASE_URL: cachedApiBaseUrl || DEFAULT_CONFIG.API_BASE_URL,
    SOCKET_URL: cachedApiBaseUrl || DEFAULT_CONFIG.SOCKET_URL,
  };
}

export function getApiBaseUrl(pageUrl) {
  // Prefer the configured server URL; only fall back to localhost.
  const url = cachedApiBaseUrl || DEFAULT_CONFIG.API_BASE_URL;
  console.log(`🌐 CodeGuard API URL: ${url}${pageUrl ? ` (page: ${pageUrl})` : ''}`);
  return url;
}

// ========== Cached State ==========

let cachedApiBaseUrl = DEFAULT_CONFIG.API_BASE_URL;
let cachedEnvironment = 'development';
let storedClientUrl = DEFAULT_CONFIG.CLIENT_URL;

export function updateEnvironmentFromUrl(pageUrl) {
  if (!pageUrl) return;
  // Only used as a hint now; the configured server URL is authoritative.
  cachedEnvironment = isDevEnvironment(pageUrl) ? 'development' : 'configured';
}

export function getCachedApiBaseUrl() {
  return cachedApiBaseUrl;
}

export function getCachedEnvironment() {
  return cachedEnvironment;
}

export function getClientUrl() {
  return storedClientUrl;
}

/**
 * Commit Server/Client URLs learned from the web page (auto-config).
 * Updates the in-memory cache; callers persist via saveToStorage().
 */
export function setConfiguredUrls({ serverUrl, clientUrl } = {}) {
  if (serverUrl) cachedApiBaseUrl = serverUrl;
  if (clientUrl) storedClientUrl = clientUrl;
  cachedEnvironment = 'configured';
}

// ========== Storage (proctor-configured URLs) ==========

/**
 * Load Server/Client URLs saved by the Options page. Keys:
 *   serverUrl  → API + Socket base
 *   clientUrl  → the CodeGuard web app origin (used to gate content.js)
 * Also honors the legacy `apiBaseUrl` key.
 */
export async function initializeFromStorage() {
  try {
    const stored = await chrome.storage.local.get(['serverUrl', 'clientUrl', 'apiBaseUrl', 'environment']);
    if (stored.serverUrl) cachedApiBaseUrl = stored.serverUrl;
    else if (stored.apiBaseUrl) cachedApiBaseUrl = stored.apiBaseUrl;
    if (stored.clientUrl) storedClientUrl = stored.clientUrl;
    if (stored.environment) cachedEnvironment = stored.environment;
    console.log(`📦 CodeGuard config loaded — server: ${cachedApiBaseUrl}, client: ${storedClientUrl}`);
  } catch (err) {
    console.warn('⚠️ Could not load extension config from storage:', err.message);
  }
}

export async function saveToStorage() {
  try {
    await chrome.storage.local.set({
      serverUrl: cachedApiBaseUrl,
      clientUrl: storedClientUrl,
      apiBaseUrl: cachedApiBaseUrl, // legacy key
      environment: cachedEnvironment,
    });
  } catch (err) {
    console.warn('⚠️ Could not save extension config:', err.message);
  }
}

// React to Options-page changes without needing a reload.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.serverUrl?.newValue) cachedApiBaseUrl = changes.serverUrl.newValue;
    if (changes.clientUrl?.newValue) storedClientUrl = changes.clientUrl.newValue;
  });
}

// ========== Exports ==========

export const CONFIG = { DEV: DEFAULT_CONFIG, DEFAULT: DEFAULT_CONFIG };

export default {
  isDevEnvironment,
  getConfig,
  getApiBaseUrl,
  updateEnvironmentFromUrl,
  getCachedApiBaseUrl,
  getCachedEnvironment,
  getClientUrl,
  setConfiguredUrls,
  initializeFromStorage,
  saveToStorage,
  CONFIG,
};
