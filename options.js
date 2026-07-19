/**
 * CodeGuard Proctor — Options page logic.
 * Persists Server/Client URLs to chrome.storage.local; config.js reads these
 * (and reacts to changes live via storage.onChanged).
 */

const $ = (id) => document.getElementById(id);
const DEFAULTS = { serverUrl: "http://localhost:3000", clientUrl: "http://localhost:5173" };

const trimSlash = (v) => (v || "").trim().replace(/\/$/, "");

function setStatus(msg, ok = true) {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${ok ? "ok" : "err"}`;
  if (msg) setTimeout(() => { el.textContent = ""; el.className = "status"; }, 2500);
}

async function load() {
  const stored = await chrome.storage.local.get(["serverUrl", "clientUrl", "apiBaseUrl", "configLocked"]);
  $("serverUrl").value = stored.serverUrl || stored.apiBaseUrl || DEFAULTS.serverUrl;
  $("clientUrl").value = stored.clientUrl || DEFAULTS.clientUrl;
  $("configLocked").checked = stored.configLocked === true;
}

async function save() {
  const serverUrl = trimSlash($("serverUrl").value) || DEFAULTS.serverUrl;
  const clientUrl = trimSlash($("clientUrl").value) || DEFAULTS.clientUrl;

  try {
    // Basic validation — must be a parseable http(s) URL.
    for (const u of [serverUrl, clientUrl]) {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error("Use http:// or https://");
    }
  } catch (err) {
    setStatus(`Invalid URL: ${err.message}`, false);
    return;
  }

  await chrome.storage.local.set({
    serverUrl,
    clientUrl,
    apiBaseUrl: serverUrl, // legacy key kept in sync
    configLocked: $("configLocked").checked, // when true, page auto-config is ignored
  });
  setStatus("✓ Saved. Reopen the exam tab to apply.", true);
}

$("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);
load();
