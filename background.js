/**
 * API Base URL Configuration - Auto-Detection Mode
 * 
 * The extension automatically detects the environment based on which site it's running on:
 * - localhost:5173 → Uses http://localhost:3000 API
 * - code-guard-six.vercel.app → Uses https://codeguardserverside.onrender.com API
 * 
 * No manual switching required!
 */

// Import configuration module for dynamic environment detection
import {
  getCachedApiBaseUrl,
  updateEnvironmentFromUrl,
  setConfiguredUrls,
  initializeFromStorage,
  saveToStorage,
  CONFIG
} from './config.js';

// Import recording manager (ES6 module - requires "type": "module" in manifest)
import { recordingManager, RECORDING_CONFIG } from './recording.js';

// Import screen recorder for desktop capture
import { screenRecorder } from './screenRecorder.js';

// ========== SERVICE WORKER KEEP-ALIVE ==========
// Chrome service workers go idle after ~30 seconds of inactivity
// This keeps the worker alive during active exams to prevent message loss
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return; // Already running
  
  console.log("💓 Starting service worker keep-alive...");
  keepAliveInterval = setInterval(async () => {
    try {
      const { examActive } = await chrome.storage.local.get(['examActive']);
      if (examActive) {
        console.log('💓 Service worker heartbeat - exam active');
      } else {
        console.log('💤 Exam not active, stopping keep-alive');
        stopKeepAlive();
      }
    } catch (err) {
      console.warn('⚠️ Keep-alive check failed:', err);
    }
  }, 25000); // Every 25 seconds (before 30s timeout)
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log("💤 Service worker keep-alive stopped");
  }
}

// Also use chrome.alarms as backup for longer periods
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // ~24 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepAlive') {
    const { examActive } = await chrome.storage.local.get(['examActive']);
    if (examActive) {
      console.log('⏰ Alarm keep-alive ping - exam active');
    }
  }
});
// ================================================

// ========== OFFLINE FLAG QUEUE ==========
// Queue flags locally when offline, sync when back online
let flagQueue = [];
let isSyncing = false;
const MAX_QUEUE_SIZE = 50;  // Prevent memory issues
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];  // Exponential backoff

// Load queue from storage on startup
async function loadFlagQueue() {
  try {
    const { offlineFlagQueue } = await chrome.storage.local.get(['offlineFlagQueue']);
    if (offlineFlagQueue && Array.isArray(offlineFlagQueue)) {
      flagQueue = offlineFlagQueue;
      console.log(`📦 Loaded ${flagQueue.length} queued flags from storage`);
    }
  } catch (err) {
    console.warn('⚠️ Failed to load flag queue:', err);
  }
}

// Save queue to storage (persists through service worker restarts)
async function saveFlagQueue() {
  try {
    await chrome.storage.local.set({ offlineFlagQueue: flagQueue });
  } catch (err) {
    console.warn('⚠️ Failed to save flag queue:', err);
  }
}

// Add flag to queue
async function queueFlag(payload) {
  if (flagQueue.length >= MAX_QUEUE_SIZE) {
    console.warn('⚠️ Flag queue full, dropping oldest flag');
    flagQueue.shift();
  }
  
  payload.queuedAt = new Date().toISOString();
  flagQueue.push(payload);
  await saveFlagQueue();
  console.log(`📦 Flag queued (${flagQueue.length} total). Will sync when online.`);
}

// Send a single flag with retry
async function sendFlagWithRetry(payload, retryIndex = 0) {
  try {
    const headers = await getAuthHeaders({ 'Content-Type': 'application/json' });
    const response = await fetch(`${getApiBaseUrl()}/api/proctoring/flag`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      // 401 = expired/missing token; retrying won't help. Keep the flag queued
      // and wait for a fresh SET_TOKEN from the page to flush the queue.
      if (response.status === 401) {
        return { success: false, authError: true, error: 'HTTP 401' };
      }
      throw new Error(`HTTP ${response.status}`);
    }

    return { success: true };
  } catch (err) {
    // Retry with exponential backoff
    if (retryIndex < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[retryIndex]));
      return sendFlagWithRetry(payload, retryIndex + 1);
    }
    return { success: false, error: err.message };
  }
}

// Sync all queued flags
async function syncQueuedFlags() {
  if (isSyncing || flagQueue.length === 0) return;
  
  isSyncing = true;
  console.log(`🔄 Syncing ${flagQueue.length} queued flags...`);
  
  const successfulIndices = [];
  
  for (let i = 0; i < flagQueue.length; i++) {
    const flag = flagQueue[i];
    const result = await sendFlagWithRetry(flag);
    
    if (result.success) {
      successfulIndices.push(i);
      console.log(`✅ Synced queued flag ${i + 1}/${flagQueue.length}`);
    } else {
      console.warn(`❌ Failed to sync flag ${i + 1}, will retry later`);
      break;  // Stop on first failure to maintain order
    }
  }
  
  // Remove successful flags from queue
  if (successfulIndices.length > 0) {
    flagQueue = flagQueue.filter((_, index) => !successfulIndices.includes(index));
    await saveFlagQueue();
    console.log(`📦 ${successfulIndices.length} flags synced, ${flagQueue.length} remaining`);
  }
  
  isSyncing = false;
}

// Check if we're online and sync
async function checkAndSync() {
  try {
    // Simple connectivity check
    const response = await fetch(`${getApiBaseUrl()}/health`, { 
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    if (response.ok) {
      await syncQueuedFlags();
    }
  } catch {
    // Offline, will try again later
  }
}

// Load queue on startup
loadFlagQueue();

// Periodic sync attempt (every 30 seconds during active exam)
chrome.alarms.create('syncFlags', { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'syncFlags') {
    const { examActive } = await chrome.storage.local.get(['examActive']);
    if (examActive && flagQueue.length > 0) {
      await checkAndSync();
    }
  }
});
// ================================================

// Initialize environment on service worker start
initializeFromStorage().then(() => {
  console.log('🚀 CodeGuard Extension initialized');
  console.log(`   Current API: ${getCachedApiBaseUrl()}`);
});

// Helper function to get current API URL (uses cached value)
function getApiBaseUrl() {
  return getCachedApiBaseUrl();
}

// ========== RECORDING UPLOAD (shared by examiner-request + flagged auto-upload) ==========
// Upload one stored chunk to the (LAN-aware) API and mark it uploaded locally.
async function uploadChunkRecord(chunk, requestId = '') {
  const formData = new FormData();
  formData.append('recording', chunk.blob, `chunk_${chunk.chunkIndex}.webm`);
  formData.append('roomId', chunk.roomId);
  formData.append('studentId', chunk.studentId);
  formData.append('chunkIndex', chunk.chunkIndex.toString());
  formData.append('startTime', chunk.startTime);
  formData.append('endTime', chunk.endTime);
  formData.append('duration', chunk.duration.toString());
  formData.append('events', JSON.stringify(chunk.events || []));
  formData.append('requestId', requestId || '');

  const headers = await getAuthHeaders();
  const response = await fetch(`${getApiBaseUrl()}/api/recordings/upload`, {
    method: 'POST',
    headers,
    body: formData
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed: ${response.status} - ${errorText}`);
  }
  const result = await response.json();
  await recordingManager.markChunkUploaded(chunk.chunkId, result.url);
  return result;
}

// On a violation flag, auto-upload the most-recent stored recording chunk so
// flagged evidence always reaches the server even if no examiner requested it
// (owner policy: "auto-upload only flagged"). Preserved from cleanup once
// uploaded. Best-effort — never throws into the flag path.
async function autoUploadRecordingForFlag() {
  try {
    const { examActive, roomId } = await chrome.storage.local.get(['examActive', 'roomId']);
    if (!examActive) return;
    const rid = recordingManager.examRoomId || roomId;
    if (!rid) return;

    const chunks = await recordingManager.getChunksByRoom(rid); // sorted by chunkIndex
    const pending = chunks.filter(c => c.status !== 'uploaded' && c.blob);
    if (pending.length === 0) return;

    const latest = pending[pending.length - 1];
    await recordingManager.updateChunkStatus(latest.chunkId, 'uploading');
    await uploadChunkRecord(latest, `flag_${Date.now()}`);
    console.log(`⬆️ Flagged evidence auto-uploaded: chunk ${latest.chunkIndex}`);
  } catch (err) {
    console.warn('⚠️ Flag auto-upload failed:', err.message);
  }
}

// ========== AUTO-CONFIG (learn Server URL from the web page) ==========
// content.js runs on ALL origins, so any site can post SET_CONFIG. The gate
// below makes that safe: never change mid-exam, honor a manual Options lock,
// and only commit a new server after probing /health for the CodeGuard marker.
function normalizeUrl(u) {
  if (typeof u !== 'string') return null;
  const trimmed = u.trim().replace(/\/$/, '');
  try {
    const parsed = new URL(trimmed);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// Probe a candidate server to confirm it is a real CodeGuard backend.
async function isCodeGuardServer(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return data && data.service === 'codeguard';
  } catch {
    return false;
  }
}

async function handleSetConfig(message) {
  const serverUrl = normalizeUrl(message.serverUrl);
  const clientUrl = normalizeUrl(message.clientUrl);
  if (!serverUrl) {
    return { success: false, message: 'Invalid serverUrl' };
  }

  const { examActive, configLocked, serverUrl: currentServer } =
    await chrome.storage.local.get(['examActive', 'configLocked', 'serverUrl']);

  // Gate 1: never swap servers mid-exam.
  if (examActive === true) {
    console.log('🔒 SET_CONFIG ignored — exam active');
    return { success: false, message: 'Exam active — config change refused' };
  }

  // Gate 2: a proctor's manual Options entry wins.
  if (configLocked === true) {
    console.log('🔒 SET_CONFIG ignored — config locked by Options');
    return { success: false, message: 'Config locked' };
  }

  // No change → nothing to do (avoids a needless /health round-trip).
  if (currentServer === serverUrl) {
    if (clientUrl) { setConfiguredUrls({ clientUrl }); await saveToStorage(); }
    return { success: true, message: 'Config unchanged' };
  }

  // Gate 3: verify the candidate before trusting it.
  const verified = await isCodeGuardServer(serverUrl);
  if (!verified) {
    console.warn(`⚠️ SET_CONFIG rejected — ${serverUrl}/health is not a CodeGuard server`);
    return { success: false, message: 'Server verification failed' };
  }

  setConfiguredUrls({ serverUrl, clientUrl });
  await saveToStorage();

  // Surface the learned server so a proctor can spot a wrong target.
  try {
    const host = new URL(serverUrl).host;
    chrome.action.setTitle({ title: `Code-Guard Proctor — server: ${host}` });
  } catch { /* ignore */ }

  console.log(`✅ Auto-config: server learned from page → ${serverUrl}`);
  return { success: true, message: 'Config updated', serverUrl };
}
// ======================================================================

async function getAuthHeaders(customHeaders = {}) {
  const data = await chrome.storage.local.get("token");
  const headers = { ...customHeaders };
  if (data.token) {
    headers["Authorization"] = `Bearer ${data.token}`;
  }
  return headers;
}

// Removed automatic whitelist refresh - now updates happen via socket events
// Whitelist is fetched once when exam starts and refreshed when examiner adds/removes sites

function startWhitelistRefresh() {
  // No automatic refresh - whitelist updates via socket events
  console.log("ℹ️ Whitelist will be updated via real-time socket events");
}

function stopWhitelistRefresh() {
  // No interval to stop - keeping this function for compatibility
  console.log("ℹ️ No whitelist refresh interval to stop");
}

// --- 1. Listen for Messages from Content Script ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("📨 Message received:", message.type, message);
  
  // ========== AUTO-DETECT ENVIRONMENT ==========
  // Detect environment based on the sender's tab URL
  if (sender?.tab?.url) {
    updateEnvironmentFromUrl(sender.tab.url);
    saveToStorage(); // Persist for service worker restart
    console.log(`🌐 Environment detected from: ${sender.tab.url}`);
  } else if (sender?.url) {
    // Fallback to sender URL if tab URL not available
    updateEnvironmentFromUrl(sender.url);
    saveToStorage();
  }
  // ==============================================
  
  if (message.type === "SET_CONFIG") {
    handleSetConfig(message).then(sendResponse);
    return true; // async response
  }

  if (message.type === "SET_TOKEN") {
    console.log("🔑 Storing auth token in local storage:", message.token ? "present" : "absent");
    chrome.storage.local.set({ token: message.token || null }, () => {
      sendResponse({ success: true, message: "Token stored successfully" });
      // Fresh token may unblock 401-queued flags — flush the offline queue
      if (message.token && flagQueue.length > 0) {
        setTimeout(() => syncQueuedFlags(), 500);
      }
    });
    return true; // Keep message channel open for async response
  }

  if (message.type === "START_EXAM") {
    console.log("📘 Exam initialization:", message);

    // Save all student details but DON'T start monitoring yet
    // Monitoring will only start when exam actually begins (via exam-started event)
    chrome.storage.local.set({
      studentId: message.studentId,
      studentName: message.studentName || "Unknown Student",
      roomId: message.roomId,
      token: message.token || null, // Save token if passed
      examActive: false, // Don't start monitoring until exam actually starts
    }, () => {
      console.log("✅ Student info saved to storage");
    });

    // Fetch whitelist but don't start monitoring yet (examActive is false)
    fetchWhitelist(message.roomId)
      .then(() => {
        // Don't start whitelist refresh yet - wait for EXAM_STARTED message
        sendResponse({ success: true, message: "Student info saved, waiting for exam to start" });
      })
      .catch((err) => {
        // This shouldn't happen now since fetchWhitelist has fallback, but just in case
        console.warn("Unexpected error in fetchWhitelist:", err);
        sendResponse({ success: true, message: "Student info saved (using default whitelist)" });
      });

    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  if (message.type === "EXAM_STARTED") {
    console.log("📘 EXAM_STARTED message received:", message);
    console.log("🔍 Full message object:", JSON.stringify(message, null, 2));
    
    // Handle async operations
    (async () => {
      try {
        // Get current storage state
        const currentState = await chrome.storage.local.get(["roomId", "studentId", "studentName", "examActive"]);
        console.log("📋 Current storage state BEFORE update:", currentState);
        
        // If roomId is provided in message, use it (fallback)
        const roomId = message.roomId || currentState.roomId;
        
        if (!roomId) {
          console.error("❌ No roomId available - cannot start exam monitoring");
          sendResponse({ success: false, message: "No roomId available", error: "Missing roomId" });
          return;
        }
        
        // Now start monitoring - exam has officially begun
        await chrome.storage.local.set({
          examActive: true,
          // Ensure roomId is set if provided in message
          ...(message.roomId && { roomId: message.roomId })
        });
        
        // Verify it was set - with retry logic
        let verify = await chrome.storage.local.get(["examActive", "roomId"]);
        console.log("✅ examActive set to:", verify.examActive, "roomId:", verify.roomId);
        
        // If examActive is still not true, retry once
        if (verify.examActive !== true) {
          console.warn("⚠️ examActive not set correctly, retrying...");
          await chrome.storage.local.set({ examActive: true });
          verify = await chrome.storage.local.get(["examActive", "roomId"]);
          console.log("✅ After retry - examActive:", verify.examActive, "roomId:", verify.roomId);
        }
        
        // Fetch whitelist if not already fetched
        if (verify.roomId) {
          console.log("🔄 Fetching whitelist for room:", verify.roomId);
          await fetchWhitelist(verify.roomId);
          startWhitelistRefresh();
        } else {
          console.warn("⚠️ No roomId found in storage when starting exam");
        }
        
        // ✅ Start service worker keep-alive to prevent idle timeout
        startKeepAlive();
        
        // Final verification before sending response
        const finalCheck = await chrome.storage.local.get(["examActive"]);
        console.log("🔍 Final verification - examActive:", finalCheck.examActive);
        
        sendResponse({ 
          success: true, 
          message: "Monitoring started - exam is active", 
          examActive: finalCheck.examActive,
          verified: finalCheck.examActive === true
        });
      } catch (error) {
        console.error("❌ Error handling EXAM_STARTED:", error);
        sendResponse({ success: false, message: "Error starting monitoring", error: error.message });
      }
    })();
    
    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  if (message.type === "END_EXAM") {
    console.log("📘 Exam ended:", message);
    
    // Stop monitoring by clearing examActive flag
    chrome.storage.local.set({
      examActive: false,
    });
    
    // Stop whitelist refresh and keep-alive
    stopWhitelistRefresh();
    stopKeepAlive();
    
    sendResponse({ success: true, message: "Exam ended, monitoring stopped" });
    return true;
  }
  
  if (message.type === "STOP_MONITORING") {
    console.log("📘 Stopping monitoring");
    
    // Clear all exam-related data
    chrome.storage.local.remove(["examActive", "roomId", "studentId", "studentName"]);
    
    // Stop whitelist refresh and keep-alive
    stopWhitelistRefresh();
    stopKeepAlive();
    
    sendResponse({ success: true, message: "Monitoring stopped" });
    return true;
  }
  
  if (message.type === "REFRESH_WHITELIST") {
    console.log("📘 Refreshing whitelist immediately:", message);
    
    // Handle async operations
    (async () => {
      try {
        const { roomId } = await chrome.storage.local.get(["roomId"]);
        const targetRoomId = message.roomId || roomId;
        
        if (targetRoomId) {
          console.log(`🔄 Fetching updated whitelist for room ${targetRoomId}...`);
          await fetchWhitelist(targetRoomId);
          console.log(`✅ Whitelist refreshed after ${message.action} ${message.website}`);
          sendResponse({ success: true, message: "Whitelist refreshed successfully" });
        } else {
          console.warn("⚠️ No roomId available for whitelist refresh");
          sendResponse({ success: false, message: "No roomId available" });
        }
      } catch (error) {
        console.error("❌ Error refreshing whitelist:", error);
        sendResponse({ success: false, message: "Error refreshing whitelist", error: error.message });
      }
    })();
    
    return true;
  }
  
  // ========== SCREEN RECORDING HANDLERS ==========
  // These handlers control full-screen recording triggered from the PiP UI
  
  if (message.type === "START_SCREEN_RECORDING") {
    console.log("🎬 START_SCREEN_RECORDING received:", message);
    
    (async () => {
      try {
        const { roomId, studentId, studentName, examName } = message;
        
        if (!roomId || !studentId) {
          sendResponse({ success: false, error: "Missing roomId or studentId" });
          return;
        }
        
        // Start screen recording (receives chunks from website)
        const result = await screenRecorder.startRecording(
          { roomId, studentId, studentName, examName }
        );
        
        if (result.success) {
          // Also initialize the old recording manager for event tracking
          await recordingManager.initRecording(roomId, studentId);
        }
        
        console.log("🎬 Screen recording result:", result);
        sendResponse(result);
        
      } catch (error) {
        console.error("❌ Failed to start recording:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  if (message.type === "STOP_SCREEN_RECORDING") {
    console.log("⏹️ STOP_SCREEN_RECORDING received:", message);
    
    (async () => {
      try {
        // Resolve the room (memory first, storage fallback after SW restart).
        const roomId = recordingManager.examRoomId
          || (await chrome.storage.local.get(['roomId'])).roomId;

        // Save the single local copy to Downloads by merging the stored chunks
        // (no separate in-RAM buffer — chunks already live in IndexedDB).
        let saveResult = { success: false, error: 'No data' };
        if (roomId) {
          const chunks = await recordingManager.getChunksByRoom(roomId);
          const blobs = chunks.map(c => c.blob).filter(Boolean);
          if (blobs.length > 0) {
            saveResult = await screenRecorder.saveMergedBlobs(blobs);
          }
        }

        // Update lifecycle state + event metadata.
        await screenRecorder.stopRecording();
        await recordingManager.stopRecording();

        // Delete non-flagged / unrequested chunks after the grace period;
        // flagged (uploaded) chunks are preserved.
        if (roomId) recordingManager.scheduleCleanup(roomId);

        console.log("⏹️ Recording stopped; local copy:", saveResult.filename || saveResult.error);
        sendResponse({ success: true, ...saveResult });

      } catch (error) {
        console.error("❌ Failed to stop recording:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();

    return true;
  }

  if (message.type === "GET_RECORDING_STATUS") {
    console.log("📊 GET_RECORDING_STATUS received");
    
    (async () => {
      try {
        // Get status from screen recorder
        const status = screenRecorder.getStatus();
        
        sendResponse({
          success: true,
          ...status
        });
        
      } catch (error) {
        console.error("❌ Failed to get recording status:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  // Handle video chunk data from website
  if (message.type === "VIDEO_CHUNK") {
    console.log("📹 VIDEO_CHUNK received:", message.chunkSize, "bytes");
    
    (async () => {
      try {
        // Convert base64 back to blob
        const response = await fetch(message.dataUrl);
        const blob = await response.blob();

        // Persist to IndexedDB so the examiner's on-demand fetch and the
        // flagged auto-upload have real chunks; the single local Downloads copy
        // is merged from these same chunks at STOP_SCREEN_RECORDING.
        await recordingManager.appendLiveChunk(blob);

        sendResponse({ success: true });
      } catch (error) {
        console.error("❌ Failed to process video chunk:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  // ================================================
  
  if (message.type === "PASTE_VIOLATION") {
    console.log("📘 Paste violation reported:", message);
    
    // Handle async operations
    (async () => {
      try {
        const { studentId, roomId, violationType, details, timestamp } = message;
        
        if (!studentId || !roomId) {
          console.warn("⚠️ Missing studentId or roomId for paste violation");
          sendResponse({ success: false, message: "Missing required fields" });
          return;
        }
        
        // Get student name from storage
        const { studentName } = await chrome.storage.local.get(["studentName"]);
        
        // Check if exam is active
        const { examActive } = await chrome.storage.local.get(["examActive"]);
        if (examActive !== true) {
          console.log("ℹ️ Exam not active, skipping paste violation report");
          sendResponse({ success: true, message: "Violation logged but exam not active" });
          return;
        }
        
        // Prepare payload for backend (using similar format as URL violations)
        const payload = {
          studentId,
          studentName: studentName || "Unknown Student",
          roomId,
          illegalUrl: `paste_violation:${violationType}`, // Format: paste_violation:large_paste or paste_violation:rapid_paste
          blockedUrl: `paste_violation:${violationType}`, // For compatibility
          actionType: `paste_${violationType}`, // paste_large_paste or paste_rapid_paste
          violationDetails: details, // Additional details about the violation
          timestamp: timestamp || new Date().toISOString(),
          screenshotData: "" // No screenshot for paste violations
        };
        
        console.log("📤 Sending paste violation to backend:", payload);
        
        // Send to backend
        const headers = await getAuthHeaders({ "Content-Type": "application/json" });
        const response = await fetch(`${getApiBaseUrl()}/api/proctoring/flag`, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload),
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`❌ Paste violation report failed (${response.status}):`, errorText);
          sendResponse({ success: false, message: "Failed to report violation" });
          return;
        }
        
        const result = await response.json();
        console.log(`✅ Paste violation reported:`, result.message || result);

        // Flagged evidence: auto-upload the current recording chunk over LAN.
        autoUploadRecordingForFlag();

        sendResponse({ success: true, message: "Paste violation reported successfully" });
      } catch (error) {
        console.error("❌ Error handling paste violation:", error);
        sendResponse({ success: false, message: "Error reporting violation", error: error.message });
      }
    })();
    
    return true;
  }
  
  // ========== RECORDING MESSAGE HANDLERS ==========
  
  // Initialize recording state (called when exam starts)
  if (message.type === "INIT_RECORDING") {
    console.log("🎬 Initializing recording state:", message);
    
    (async () => {
      try {
        const result = await recordingManager.initRecording(message.roomId, message.studentId);
        sendResponse({ success: true, ...result });
      } catch (error) {
        console.error("❌ Recording init error:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  // Add event marker to recording timeline
  if (message.type === "ADD_RECORDING_EVENT") {
    console.log("📌 Adding event to recording:", message);
    
    try {
      const event = recordingManager.addEvent(message.eventType, message.details);
      sendResponse({ success: true, event });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    
    return true;
  }
  
  // Register a recorded chunk (called from content script after chunk is recorded)
  if (message.type === "REGISTER_CHUNK") {
    console.log("💾 Registering chunk:", message.chunkIndex);
    
    (async () => {
      try {
        // Convert base64 to blob
        const response = await fetch(message.blobDataUrl);
        const blob = await response.blob();
        
        const chunkData = await recordingManager.registerChunk(
          message.chunkIndex,
          message.startTime,
          message.endTime,
          message.duration,
          blob
        );
        
        sendResponse({ success: true, chunkId: chunkData.chunkId, sizeBytes: chunkData.sizeBytes });
      } catch (error) {
        console.error("❌ Chunk registration error:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  // Stop recording
  if (message.type === "STOP_RECORDING") {
    console.log("⏹️ Stopping recording:", message);
    
    (async () => {
      try {
        const result = await recordingManager.stopRecording();
        sendResponse({ success: true, ...result });
      } catch (error) {
        console.error("❌ Stop recording error:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  // Get available chunks list (for examiner request)
  if (message.type === "GET_CHUNK_LIST") {
    console.log("📋 Getting chunk list");
    
    (async () => {
      try {
        const chunks = await recordingManager.getChunkList();
        sendResponse({ success: true, chunks });
      } catch (error) {
        console.error("❌ Get chunk list error:", error);
        sendResponse({ success: false, error: error.message, chunks: [] });
      }
    })();
    
    return true;
  }
  
  // Upload specific chunk (triggered by examiner request)
  if (message.type === "UPLOAD_CHUNK") {
    console.log("📤 Uploading chunk:", message.chunkIndex);
    
    (async () => {
      try {
        const chunk = await recordingManager.getChunkForUpload(message.chunkIndex);

        console.log(`📤 Uploading chunk ${chunk.chunkIndex} (${(chunk.sizeBytes / 1024 / 1024).toFixed(2)} MB)...`);

        // Upload + mark-uploaded via the shared helper (also used by flag auto-upload).
        const result = await uploadChunkRecord(chunk, message.requestId);

        console.log(`✅ Chunk ${chunk.chunkIndex} uploaded successfully:`, result.url);
        sendResponse({ success: true, ...result, chunkId: chunk.chunkId });
      } catch (error) {
        console.error("❌ Chunk upload error:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    
    return true;
  }
  
  // Schedule cleanup (called when exam ends)
  if (message.type === "SCHEDULE_CLEANUP") {
    console.log("🗑️ Scheduling cleanup for room:", message.roomId);
    
    const result = recordingManager.scheduleCleanup(
      message.roomId, 
      message.delayMs || RECORDING_CONFIG.CLEANUP_DELAY_MS
    );
    sendResponse({ success: true, ...result });
    return true;
  }
  
  // Cancel cleanup (if examiner requests more chunks before cleanup happens)
  if (message.type === "CANCEL_CLEANUP") {
    console.log("🚫 Cancelling cleanup for room:", message.roomId);
    
    const cancelled = recordingManager.cancelCleanup(message.roomId);
    sendResponse({ success: true, cancelled });
    return true;
  }
  
  // Get recording state (for debugging)
  if (message.type === "GET_RECORDING_STATE") {
    const state = recordingManager.getState();
    sendResponse({ success: true, ...state });
    return true;
  }
  
  // Return false for messages we don't handle
  return false;
});

// --- 2. Fetch Whitelist from Backend ---
async function fetchWhitelist(roomId) {
  // Default whitelist (always included)
  const defaultWhitelist = [
    "google.com",
    "google.co.in",
    "youtube.com",
    "gmail.com",
    "mail.google.com",
    "drive.google.com",
    "docs.google.com",
    "classroom.google.com",
    "accounts.google.com",
    // ImageKit domains for viewing/downloading exam questions
    "ik.imagekit.io",
    "imagekit.io"
  ];
  
  // Normalize domain helper
  const normalizeDomain = (domain) => {
    if (typeof domain !== 'string') return null;
    return domain.toLowerCase().replace(/^www\./, "").trim();
  };
  
  try {
    if (!roomId) {
      // Try to get roomId from storage if not provided
      const { roomId: storedRoomId } = await chrome.storage.local.get(["roomId"]);
      roomId = storedRoomId;
    }
    
    if (!roomId) {
      console.warn("⚠️ No roomId provided, using default whitelist only");
      // Use default whitelist if no roomId
      const normalizedDefault = defaultWhitelist.map(normalizeDomain).filter(Boolean);
      chrome.storage.local.set({ whitelist: normalizedDefault });
      console.log("✅ Default whitelist loaded:", normalizedDefault);
      return;
    }

    const headers = await getAuthHeaders();
    const res = await fetch(`${getApiBaseUrl()}/api/proctoring/whitelist?roomId=${encodeURIComponent(roomId)}`, {
      headers: headers
    });
    
    if (!res.ok) {
      // If endpoint doesn't exist (404) or other error, fall back to default whitelist
      if (res.status === 404) {
        console.warn("⚠️ Whitelist endpoint not found (404), using default whitelist only");
      } else {
        console.warn(`⚠️ Failed to fetch whitelist (${res.status}), using default whitelist only`);
      }
      
      // Use default whitelist as fallback
      const normalizedDefault = defaultWhitelist.map(normalizeDomain).filter(Boolean);
      chrome.storage.local.set({ whitelist: normalizedDefault });
      console.log("✅ Default whitelist loaded:", normalizedDefault);
      return;
    }
    
    const result = await res.json();
    
    // Check if the API returned an error
    if (result.success === false) {
      console.warn("⚠️ API returned error, using default whitelist only:", result.message);
      // Use default whitelist as fallback
      const normalizedDefault = defaultWhitelist.map(normalizeDomain).filter(Boolean);
      chrome.storage.local.set({ whitelist: normalizedDefault });
      console.log("✅ Default whitelist loaded:", normalizedDefault);
      return;
    }
    
    // Store the whitelist (assuming result contains the whitelist array or has a whitelist property)
    // Merge with default allowed domains (Google, YouTube, Gmail, etc.)
    const backendWhitelist = result.whitelist || result.data || result;
    
    const normalizedDefault = defaultWhitelist.map(normalizeDomain).filter(Boolean);
    const normalizedBackend = Array.isArray(backendWhitelist) 
      ? backendWhitelist.map(normalizeDomain).filter(Boolean)
      : [];
    
    // Combine backend whitelist with default whitelist, removing duplicates
    const whitelist = [...new Set([...normalizedDefault, ...normalizedBackend])];
    
    chrome.storage.local.set({ whitelist });
    console.log("✅ Whitelist loaded (backend + default):", whitelist);
  } catch (err) {
    // Network error or other exception - use default whitelist as fallback
    console.warn("⚠️ Error fetching whitelist, using default whitelist only:", err.message);
    const normalizedDefault = defaultWhitelist.map(normalizeDomain).filter(Boolean);
    chrome.storage.local.set({ whitelist: normalizedDefault });
    console.log("✅ Default whitelist loaded:", normalizedDefault);
    // Don't throw error - we have a fallback whitelist
  }
}

// --- 3. Watch Tab URLs for Non-Whitelisted Sites ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only check when the URL changes and tab is valid
  if (!changeInfo.url || !tab?.id) return;

  const storageData = await chrome.storage.local.get([
    "whitelist",
    "studentId",
    "roomId",
    "examActive",
  ]);
  
  const { whitelist, studentId, roomId, examActive } = storageData;

  // Skip if exam hasn't started or no whitelist yet
  if (!whitelist || !studentId || !roomId) {
    console.log("⏭️ Skipping - missing prerequisites:", { 
      hasWhitelist: !!whitelist, 
      hasStudentId: !!studentId, 
      hasRoomId: !!roomId 
    });
    return;
  }
  
  // ✅ Only monitor if exam is active
  // Check both examActive flag and ensure it's explicitly true (not undefined/null)
  if (examActive !== true) {
    console.log("ℹ️ Exam not active, skipping flag check", { 
      examActive, 
      examActiveType: typeof examActive,
      examActiveValue: examActive,
      studentId, 
      roomId, 
      hasWhitelist: !!whitelist 
    });
    // Debug: Check what's actually in storage
    console.log("🔍 Full storage state:", storageData);
    
    // Try to re-check after a short delay (in case of timing issue)
    setTimeout(async () => {
      const recheck = await chrome.storage.local.get(["examActive"]);
      console.log("🔍 Re-check after delay - examActive:", recheck.examActive);
    }, 1000);
    
    return;
  }
  
  console.log("✅ Exam is active, proceeding with flag check");

  try {
    const url = new URL(changeInfo.url);
    let domain = url.hostname.toLowerCase();
    
    // Skip chrome://, chrome-extension://, and other internal URLs
    if (url.protocol === "chrome:" || url.protocol === "chrome-extension:" || url.protocol === "about:") {
      return;
    }

    // Allow browser search bar searches (search queries from address bar)
    // Common search engines: Google, Bing, Yahoo, DuckDuckGo, etc.
    const isSearchQuery = (() => {
      const searchDomains = [
        'google.com',
        'google.co.in',
        'bing.com',
        'yahoo.com',
        'search.yahoo.com',
        'duckduckgo.com',
        'yandex.com',
        'baidu.com'
      ];
      
      // Check if domain is a search engine
      const isSearchEngine = searchDomains.some(searchDomain => {
        return domain === searchDomain || domain.endsWith(`.${searchDomain}`);
      });
      
      if (!isSearchEngine) return false;
      
      // Check if URL contains search query parameters
      const searchParams = ['q', 'query', 'p', 'search', 'text', 'wd'];
      const hasSearchParam = searchParams.some(param => url.searchParams.has(param));
      
      // Also check common search paths
      const searchPaths = ['/search', '/webhp', '/'];
      const hasSearchPath = searchPaths.some(path => url.pathname === path || url.pathname.startsWith(path));
      
      return hasSearchParam || (hasSearchPath && url.searchParams.toString().length > 0);
    })();

    // If it's a search query, allow it without flagging
    if (isSearchQuery) {
      console.log(`✅ ALLOWED: Browser search query from ${domain}`);
      return;
    }

    // Remove www. prefix for matching
    const domainWithoutWww = domain.replace(/^www\./, "");
    
    // Check if domain is whitelisted (exact match or subdomain)
    // Note: We only check the hostname, so github.com/mrmushii will match if github.com is whitelisted
    const isWhitelisted = whitelist.some(allowedDomain => {
      if (!allowedDomain || typeof allowedDomain !== 'string') return false;
      
      const allowedDomainLower = allowedDomain.toLowerCase().replace(/^www\./, "").trim();
      
      // Exact match (e.g., github.com === github.com)
      if (domainWithoutWww === allowedDomainLower) {
        return true;
      }
      
      // Subdomain match: mail.google.com should match if google.com is whitelisted
      if (domainWithoutWww.endsWith(`.${allowedDomainLower}`)) {
        return true;
      }
      
      // Parent domain match: google.com should match if mail.google.com is whitelisted
      if (allowedDomainLower.endsWith(`.${domainWithoutWww}`)) {
        return true;
      }
      
      return false;
    });

    console.log(`🔍 Checking domain: ${domain} (without www: ${domainWithoutWww}), Whitelisted: ${isWhitelisted}, Whitelist:`, whitelist);

    // If the domain is NOT whitelisted, flag it (but don't block - just monitor)
    if (!isWhitelisted) {
      console.log(`🚨 FLAGGED: Student visited non-whitelisted site: ${domain} (path: ${url.pathname})`);
      
      // Wait for page to load before taking screenshot (2 seconds delay)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Flag the violation (screenshot will be taken here) - but don't close the tab
      await handleFlaggedSite(tab.id, changeInfo.url);
    } else {
      console.log(`✅ ALLOWED: Student visited whitelisted site: ${domain}${url.pathname}`);
    }
  } catch (err) {
    // ignore invalid URLs like chrome://newtab
    console.warn("Error processing URL:", err);
  }
});

// --- 4. Handle the Flagging (Screenshot & API Call) ---
async function handleFlaggedSite(tabId, blockedUrl) {
  try {
    // ✅ Check if the tab still exists
    const tab = await new Promise((resolve) => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) {
          console.warn("⚠️ Tab not found or already closed:", chrome.runtime.lastError?.message);
          resolve(null);
        } else {
          resolve(t);
        }
      });
    });

    if (!tab) return; // stop if no valid tab

    // Wait a bit more to ensure page is fully loaded before screenshot
    await new Promise(resolve => setTimeout(resolve, 1000));

    // ✅ Capture screenshot from tab's window
    let screenshotData = "";
    try {
      const windowId = tab.windowId;
      const screenshotDataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }, (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            reject(chrome.runtime.lastError?.message || "Failed to capture screenshot");
          } else {
            resolve(dataUrl);
          }
        });
      });

      // ✅ Clean the image data
      if (screenshotDataUrl && screenshotDataUrl.includes(",")) {
        screenshotData = screenshotDataUrl.split(",")[1];
      } else {
        console.warn("⚠️ Screenshot data format unexpected, using empty string");
      }
    } catch (screenshotErr) {
      console.warn("⚠️ Failed to capture screenshot:", screenshotErr.message);
      // Continue without screenshot - still report the violation
    }

    // ✅ Get saved student/room details
    const { studentId, studentName, roomId } = await chrome.storage.local.get([
      "studentId",
      "studentName",
      "roomId",
    ]);

    if (!studentId || !roomId) {
      console.warn("⚠️ Missing student or room info, skipping report.");
      console.warn("   studentId:", studentId, "roomId:", roomId);
      return;
    }
    
    // ✅ Double-check exam is still active before sending flag
    const { examActive } = await chrome.storage.local.get(["examActive"]);
    if (examActive !== true) {
      console.log("ℹ️ Exam not active, skipping flag report");
      return;
    }
    const timestamp = new Date().toISOString();

    // Prepare the payload
    const payload = {
      studentId,
      studentName: studentName || "Unknown Student",
      roomId,
      illegalUrl: blockedUrl, // Backend might expect 'illegalUrl' instead of 'blockedUrl'
      blockedUrl: blockedUrl, // Include both for compatibility
      actionType: "navigate", // Explicitly mark as navigation (not search)
      timestamp,
      screenshotData: screenshotData || "", // Ensure it's not undefined
    };

    // Log what we're sending (without screenshot data for brevity)
    console.log("📤 Sending flag report:", {
      studentId: payload.studentId,
      studentName: payload.studentName,
      roomId: payload.roomId,
      illegalUrl: payload.illegalUrl,
      timestamp: payload.timestamp,
      screenshotDataLength: payload.screenshotData ? payload.screenshotData.length : 0,
    });

    // ✅ Send the report to backend (with offline queue fallback)
    try {
      const headers = await getAuthHeaders({ "Content-Type": "application/json" });
      const response = await fetch(`${getApiBaseUrl()}/api/proctoring/flag`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Flag report failed (${response.status}):`, errorText);
        // Queue for retry on server error (5xx) or expired token (401 —
        // flushed when the page posts a fresh SET_TOKEN)
        if (response.status >= 500 || response.status === 401) {
          await queueFlag(payload);
        }
        return;
      }

      const result = await response.json();
      console.log(`✅ [${timestamp}] Flag report sent:`, result.message || result);

      // Flagged evidence: auto-upload the current recording chunk over LAN.
      autoUploadRecordingForFlag();

      // Try to sync any queued flags since we're online
      if (flagQueue.length > 0) {
        setTimeout(() => syncQueuedFlags(), 1000);
      }
    } catch (networkErr) {
      // Network error - queue the flag for later
      console.warn("📴 Network error sending flag, queuing for later:", networkErr.message);
      await queueFlag(payload);
    }
  } catch (err) {
    console.error("❌ Error in handleFlaggedSite:", err);
  }
}

// --- 5. Check for Updates ---
async function checkForUpdates() {
  try {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;
    
    console.log(`🔍 Checking for updates... Current version: ${currentVersion}`);
    
    const response = await fetch(`${getApiBaseUrl()}/extension/version.json`);
    if (!response.ok) return;
    
    const data = await response.json();
    const latestVersion = data.version;
    
    if (latestVersion && latestVersion !== currentVersion) {
      console.log(`✨ New version available: ${latestVersion}`);
      
      // Compare versions (simple string comparison for now, or semantic versioning if needed)
      // Assuming semantic versioning (major.minor.patch)
      const isNewer = (v1, v2) => {
        const p1 = v1.split('.').map(Number);
        const p2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
          const n1 = p1[i] || 0;
          const n2 = p2[i] || 0;
          if (n1 > n2) return true;
          if (n1 < n2) return false;
        }
        return false;
      };

      if (isNewer(latestVersion, currentVersion)) {
        chrome.action.setBadgeText({ text: "NEW" });
        chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
        chrome.action.setTitle({ title: `New version ${latestVersion} available! Please update.` });
      }
    }
  } catch (error) {
    console.warn("⚠️ Failed to check for updates:", error);
  }
}

// Check for updates on startup
checkForUpdates();
// Check every hour
setInterval(checkForUpdates, 60 * 60 * 1000);
