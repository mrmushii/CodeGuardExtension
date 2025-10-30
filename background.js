const API_BASE_URL = "http://localhost:3000";

// --- 1. Listen for Messages from Content Script ---
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "START_EXAM") {
    console.log("📘 Exam started:", message);

    // Save all student details
    chrome.storage.local.set({
      studentId: message.studentId,
      studentName: message.studentName,
      roomId: message.roomId,
    });

    // Now that the exam has started, fetch the blacklist
    fetchBlacklist();
  }
});

// --- 2. Fetch Blacklist from Backend ---
async function fetchBlacklist() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/proctoring/blacklist`);
    const blacklist = await res.json();
    chrome.storage.local.set({ blacklist });
    console.log("✅ Blacklist loaded:", blacklist);
  } catch (err) {
    console.error("❌ Failed to fetch blacklist:", err);
  }
}

// --- 3. Watch Tab URLs for Blacklist Hits ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only check when the URL changes and tab is valid
  if (!changeInfo.url || !tab?.id) return;

  const { blacklist, studentId } = await chrome.storage.local.get([
    "blacklist",
    "studentId",
  ]);

  // Skip if exam hasn't started or no blacklist yet
  if (!blacklist || !studentId) return;

  try {
    const domain = new URL(changeInfo.url).hostname.replace("www.", "");

    // If the domain is blacklisted
    if (blacklist.includes(domain)) {
      console.log(`🚨 FLAGGED: Student visited ${domain}`);
      await handleFlaggedSite(tab.id, changeInfo.url);
    }
  } catch (err) {
    // ignore invalid URLs like chrome://newtab
  }
});

// --- 4. Handle the Flagging (Screenshot & API Call) ---
async function handleFlaggedSite(tabId, illegalUrl) {
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
        illegalUrl,
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
