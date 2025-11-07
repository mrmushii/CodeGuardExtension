const API_BASE_URL = "http://localhost:3000";

// --- 1. Listen for Messages from Content Script ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_EXAM") {
    console.log("📘 Exam started:", message);

    // Save all student details
    chrome.storage.local.set({
      studentId: message.studentId,
      studentName: message.studentName || "Unknown Student",
      roomId: message.roomId,
    });

    // Now that the exam has started, fetch the whitelist
    fetchWhitelist(message.roomId)
      .then(() => {
        sendResponse({ success: true, message: "Exam started successfully" });
      })
      .catch((err) => {
        console.error("Failed to fetch whitelist, but exam started:", err);
        sendResponse({ success: true, message: "Exam started, but whitelist fetch failed", warning: err.message });
      });

    // Return true to indicate we will send a response asynchronously
    return true;
  }
  
  // Return false for messages we don't handle
  return false;
});

// --- 2. Fetch Whitelist from Backend ---
async function fetchWhitelist(roomId) {
  try {
    if (!roomId) {
      // Try to get roomId from storage if not provided
      const { roomId: storedRoomId } = await chrome.storage.local.get(["roomId"]);
      roomId = storedRoomId;
    }
    
    if (!roomId) {
      throw new Error("Room ID is required to fetch whitelist");
    }

    const res = await fetch(`${API_BASE_URL}/api/proctoring/whitelist?roomId=${encodeURIComponent(roomId)}`);
    
    if (!res.ok) {
      throw new Error(`Failed to fetch whitelist: ${res.status} ${res.statusText}`);
    }
    
    const result = await res.json();
    
    // Check if the API returned an error
    if (result.success === false) {
      throw new Error(result.message || "Failed to fetch whitelist");
    }
    
    // Store the whitelist (assuming result contains the whitelist array or has a whitelist property)
    // Merge with default allowed domains (Google, YouTube, Gmail, etc.)
    const backendWhitelist = result.whitelist || result.data || result;
    const defaultWhitelist = [
      "google.com",
      "google.co.in",
      "youtube.com",
      "gmail.com",
      "mail.google.com",
      "drive.google.com",
      "docs.google.com",
      "classroom.google.com",
      "accounts.google.com"
    ];
    
    // Combine backend whitelist with default whitelist, removing duplicates
    const whitelist = [...new Set([...defaultWhitelist, ...(Array.isArray(backendWhitelist) ? backendWhitelist : [])])];
    
    chrome.storage.local.set({ whitelist });
    console.log("✅ Whitelist loaded:", whitelist);
  } catch (err) {
    console.error("❌ Failed to fetch whitelist:", err);
    throw err; // Re-throw so the caller can handle it
  }
}

// --- 3. Watch Tab URLs for Non-Whitelisted Sites ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only check when the URL changes and tab is valid
  if (!changeInfo.url || !tab?.id) return;

  const { whitelist, studentId } = await chrome.storage.local.get([
    "whitelist",
    "studentId",
  ]);

  // Skip if exam hasn't started or no whitelist yet
  if (!whitelist || !studentId) return;

  try {
    const url = new URL(changeInfo.url);
    const domain = url.hostname.replace("www.", "");
    
    // Skip chrome://, chrome-extension://, and other internal URLs
    if (url.protocol === "chrome:" || url.protocol === "chrome-extension:" || url.protocol === "about:") {
      return;
    }

    // Check if domain is whitelisted (exact match or subdomain)
    const isWhitelisted = whitelist.some(allowedDomain => {
      return domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);
    });

    // If the domain is NOT whitelisted, block and flag it
    if (!isWhitelisted) {
      console.log(`🚨 BLOCKED: Student attempted to visit non-whitelisted site: ${domain}`);
      
      // Flag the violation (screenshot will be taken here)
      await handleFlaggedSite(tab.id, changeInfo.url);
      
      // Close the tab after flagging
      try {
        await chrome.tabs.remove(tab.id);
      } catch (err) {
        console.warn("Could not close tab:", err);
      }
    }
  } catch (err) {
    // ignore invalid URLs like chrome://newtab
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

    // ✅ Capture screenshot from tab's window
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

    // ✅ Get saved student/room details
    const { studentId, studentName, roomId } = await chrome.storage.local.get([
      "studentId",
      "studentName",
      "roomId",
    ]);

    if (!studentId || !roomId) {
      console.warn("⚠️ Missing student or room info, skipping report.");
      return;
    }

    // ✅ Clean the image data
    const screenshotData = screenshotDataUrl.split(",")[1];
    const timestamp = new Date().toISOString();

    // ✅ Send the report to backend
    const response = await fetch(`${API_BASE_URL}/api/proctoring/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId,
        studentName: studentName || "Unknown Student",
        roomId,
        blockedUrl,
        timestamp,
        screenshotData,
      }),
    });

    const result = await response.json();
    console.log(`✅ [${timestamp}] Flag report sent:`, result.message);
  } catch (err) {
    console.error("❌ Error sending flag:", err);
  }
}
