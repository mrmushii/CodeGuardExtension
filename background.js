const API_BASE_URL = "http://localhost:3000";

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
  
  if (message.type === "START_EXAM") {
    console.log("📘 Exam initialization:", message);

    // Save all student details but DON'T start monitoring yet
    // Monitoring will only start when exam actually begins (via exam-started event)
    chrome.storage.local.set({
      studentId: message.studentId,
      studentName: message.studentName || "Unknown Student",
      roomId: message.roomId,
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
    
    // Stop whitelist refresh
    stopWhitelistRefresh();
    
    sendResponse({ success: true, message: "Exam ended, monitoring stopped" });
    return true;
  }
  
  if (message.type === "STOP_MONITORING") {
    console.log("📘 Stopping monitoring");
    
    // Clear all exam-related data
    chrome.storage.local.remove(["examActive", "roomId", "studentId", "studentName"]);
    
    // Stop whitelist refresh
    stopWhitelistRefresh();
    
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

    const res = await fetch(`${API_BASE_URL}/api/proctoring/whitelist?roomId=${encodeURIComponent(roomId)}`);
    
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

    // ✅ Send the report to backend
    const response = await fetch(`${API_BASE_URL}/api/proctoring/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Flag report failed (${response.status}):`, errorText);
      return;
    }

    const result = await response.json();
    console.log(`✅ [${timestamp}] Flag report sent:`, result.message || result);
  } catch (err) {
    console.error("❌ Error sending flag:", err);
  }
}
