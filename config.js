/**
 * CodeGuard Extension - Dynamic Environment Configuration
 * 
 * This module automatically detects whether the extension is running
 * in development (localhost) or production (Vercel/Render) mode and
 * configures the API URLs accordingly.
 * 
 * How it works:
 * - The content script runs on both localhost:5173 and code-guard-six.vercel.app
 * - When messages come from the webpage, we check the origin
 * - Based on the origin, we switch between localhost and production APIs
 */

// ========== URL Configuration ==========

// Development URLs (localhost)
const DEV_CONFIG = {
  CLIENT_URL: 'http://localhost:5173',
  API_BASE_URL: 'http://localhost:3000',
  SOCKET_URL: 'http://localhost:3000'
};

// Production URLs (deployed)
const PROD_CONFIG = {
  CLIENT_URL: 'https://code-guard-six.vercel.app',
  API_BASE_URL: 'https://codeguardserverside.onrender.com',
  SOCKET_URL: 'https://codeguardserverside.onrender.com'
};

// ========== Environment Detection ==========

/**
 * Detects if the current context is development based on the page URL
 * @param {string} url - The URL to check
 * @returns {boolean} - True if development environment
 */
export function isDevEnvironment(url) {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('localhost') || lowerUrl.includes('127.0.0.1');
}

/**
 * Gets the appropriate config based on the environment
 * @param {boolean} isDev - Whether we're in dev mode
 * @returns {Object} - Configuration object with URLs
 */
export function getConfig(isDev) {
  return isDev ? DEV_CONFIG : PROD_CONFIG;
}

/**
 * Gets the API base URL for a given page URL
 * @param {string} pageUrl - The current page URL
 * @returns {string} - The API base URL to use
 */
export function getApiBaseUrl(pageUrl) {
  const isDev = isDevEnvironment(pageUrl);
  const config = getConfig(isDev);
  console.log(`🌐 Environment: ${isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
  console.log(`   API URL: ${config.API_BASE_URL}`);
  return config.API_BASE_URL;
}

// ========== Cached Environment State ==========

// Default to production (safer fallback)
let cachedApiBaseUrl = PROD_CONFIG.API_BASE_URL;
let cachedEnvironment = 'production';

/**
 * Updates the cached environment based on received page URL
 * Called when content script sends messages
 * @param {string} pageUrl - The page URL from the content script
 */
export function updateEnvironmentFromUrl(pageUrl) {
  if (!pageUrl) return;
  
  const isDev = isDevEnvironment(pageUrl);
  cachedApiBaseUrl = isDev ? DEV_CONFIG.API_BASE_URL : PROD_CONFIG.API_BASE_URL;
  cachedEnvironment = isDev ? 'development' : 'production';
  
  console.log(`🔄 Environment updated: ${cachedEnvironment} -> ${cachedApiBaseUrl}`);
}

/**
 * Gets the cached API base URL
 * @returns {string} - The cached API base URL
 */
export function getCachedApiBaseUrl() {
  return cachedApiBaseUrl;
}

/**
 * Gets the cached environment name
 * @returns {string} - 'development' or 'production'
 */
export function getCachedEnvironment() {
  return cachedEnvironment;
}

// ========== Initialize from Storage ==========

/**
 * Initialize environment from chrome.storage
 * This helps persist the environment across service worker restarts
 */
export async function initializeFromStorage() {
  try {
    const stored = await chrome.storage.local.get(['apiBaseUrl', 'environment']);
    if (stored.apiBaseUrl) {
      cachedApiBaseUrl = stored.apiBaseUrl;
      cachedEnvironment = stored.environment || 'production';
      console.log(`📦 Loaded from storage: ${cachedEnvironment} -> ${cachedApiBaseUrl}`);
    }
  } catch (err) {
    console.warn('⚠️ Could not load environment from storage:', err.message);
  }
}

/**
 * Save current environment to chrome.storage
 */
export async function saveToStorage() {
  try {
    await chrome.storage.local.set({
      apiBaseUrl: cachedApiBaseUrl,
      environment: cachedEnvironment
    });
    console.log(`💾 Saved to storage: ${cachedEnvironment} -> ${cachedApiBaseUrl}`);
  } catch (err) {
    console.warn('⚠️ Could not save environment to storage:', err.message);
  }
}

// ========== Export Configuration Constants ==========

export const CONFIG = {
  DEV: DEV_CONFIG,
  PROD: PROD_CONFIG
};

// Default export for convenience
export default {
  isDevEnvironment,
  getConfig,
  getApiBaseUrl,
  updateEnvironmentFromUrl,
  getCachedApiBaseUrl,
  getCachedEnvironment,
  initializeFromStorage,
  saveToStorage,
  CONFIG
};
