console.log("!!! CONTENT SCRIPT IS RUNNING !!!");

function attemptStart() {
  console.log("Attempting to get session data...");

  const studentId = sessionStorage.getItem("studentId");
  const roomId = sessionStorage.getItem("roomId");

  console.log("Student ID found:", studentId);
  console.log("Room ID found:", roomId);

  if (studentId && roomId) {
    console.log("SUCCESS: Data found. Sending START_EXAM message to background.js");

    try {
      chrome.runtime.sendMessage(
        {
          type: "START_EXAM",
          studentId,
          roomId
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "Error sending message to background script:",
              chrome.runtime.lastError.message
            );
          } else {
            console.log("START_EXAM message acknowledged by background:", response);
          }
        }
      );
    } catch (err) {
      console.error("Unexpected error while sending message:", err);
    }

    return true;
  } else {
    console.log("Data not found. Will try again...");
    return false;
  }
}

// Listen for messages from the web page (React app)
window.addEventListener("message", (event) => {
  // Only accept messages from the same origin
  if (event.origin !== window.location.origin) {
    console.log("⚠️ Ignoring message from different origin:", event.origin);
    return;
  }

  // Check if this is a message for the extension
  if (event.data && event.data.target === "CODEGUARD_EXTENSION") {
    console.log("📨 Content script received message from page:", event.data);

    // Handle PING message directly (for extension availability check)
    const message = event.data.message;
    if (message && message.type === "PING") {
      console.log("🏓 Received PING, responding with PONG");
      window.postMessage({
        target: "CODEGUARD_WEB_APP",
        type: "PONG"
      }, window.location.origin);
      return;
    }
    
    if (message && message.type) {
      console.log(`📤 Forwarding ${message.type} to background script...`);
      console.log(`🔍 Full message payload:`, JSON.stringify(message, null, 2));
      
      // Check if chrome.runtime is available (can be undefined if extension context invalidated)
      if (!chrome?.runtime?.sendMessage) {
        console.warn("⚠️ Chrome runtime not available, extension may need to be reloaded");
        window.postMessage({
          target: "CODEGUARD_WEB_APP",
          type: "RESPONSE",
          originalType: message.type,
          success: false,
          error: "Extension context invalidated. Please reload the extension."
        }, window.location.origin);
        return;
      }
      
      // Use try-catch to handle potential errors
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("❌ Error forwarding message:", chrome.runtime.lastError.message);
            
            // Send error response back to page
            window.postMessage({
              target: "CODEGUARD_WEB_APP",
              type: "RESPONSE",
              originalType: message.type,
              success: false,
              error: chrome.runtime.lastError.message
            }, window.location.origin);
          } else {
            console.log("✅ Message forwarded successfully, response:", response);
            
            // Send success response back to page
            window.postMessage({
              target: "CODEGUARD_WEB_APP",
              type: "RESPONSE",
              originalType: message.type,
              success: true,
              response: response
            }, window.location.origin);
          }
        });
      } catch (err) {
        console.error("❌ Exception when sending message:", err);
        
        // Send error response back to page
        window.postMessage({
          target: "CODEGUARD_WEB_APP",
          type: "RESPONSE",
          originalType: message.type,
          success: false,
          error: err.message
        }, window.location.origin);
      }
    } else {
      console.warn("⚠️ Received message without type:", event.data);
    }
  }
});

console.log("✅ Content script ready to receive messages from web page");

// Paste detection variables
let pasteHistory = [];
const LARGE_PASTE_THRESHOLD = 1000; // characters
const RAPID_PASTE_WINDOW = 5000; // 5 seconds
const RAPID_PASTE_COUNT = 3;

// Function to report paste violations
function reportPasteViolation(violationType, details) {
  console.log(`🚨 Paste violation detected: ${violationType}`, details);
  
  // Get student info from sessionStorage
  const studentId = sessionStorage.getItem("studentId");
  const roomId = sessionStorage.getItem("roomId");
  
  if (!studentId || !roomId) {
    console.warn("⚠️ Cannot report paste violation - missing studentId or roomId");
    return;
  }
  
  // Send violation to background script
  chrome.runtime.sendMessage({
    type: "PASTE_VIOLATION",
    studentId,
    roomId,
    violationType,
    details,
    timestamp: new Date().toISOString()
  }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("❌ Error reporting paste violation:", chrome.runtime.lastError.message);
    } else {
      console.log("✅ Paste violation reported:", response);
    }
  });
}

// Monitor paste events
document.addEventListener('paste', (e) => {
  try {
    const pasteData = e.clipboardData?.getData('text') || '';
    const timestamp = Date.now();
    
    console.log(`📋 Paste event detected, size: ${pasteData.length} characters`);
    
    // Check for large paste
    if (pasteData.length > LARGE_PASTE_THRESHOLD) {
      reportPasteViolation('large_paste', { 
        size: pasteData.length,
        preview: pasteData.substring(0, 100) // First 100 chars for context
      });
    }
    
    // Check for rapid paste sequence
    // Remove old entries outside the time window
    pasteHistory = pasteHistory.filter(t => timestamp - t < RAPID_PASTE_WINDOW);
    pasteHistory.push(timestamp);
    
    if (pasteHistory.length >= RAPID_PASTE_COUNT) {
      reportPasteViolation('rapid_paste', { 
        count: pasteHistory.length,
        timeWindow: RAPID_PASTE_WINDOW
      });
    }
  } catch (err) {
    console.error("❌ Error handling paste event:", err);
  }
}, true); // Use capture phase to catch all paste events

// Also monitor keyboard shortcuts (Ctrl+C, Ctrl+V, Cmd+C, Cmd+V)
document.addEventListener('keydown', (e) => {
  const isModifierPressed = e.ctrlKey || e.metaKey;
  const isPasteShortcut = isModifierPressed && (e.key === 'v' || e.key === 'V');
  
  if (isPasteShortcut) {
    // The actual paste will be caught by the paste event listener above
    // This is just for logging
    console.log("⌨️ Paste shortcut detected (Ctrl+V / Cmd+V)");
  }
}, true);

console.log("✅ Paste detection initialized");

window.addEventListener("load", () => {
  console.log("Window 'load' event fired.");
  attemptStart();
});

let attempts = 0;
const intervalId = setInterval(() => {
  attempts++;
  if (attemptStart() || attempts > 5) {
    clearInterval(intervalId);
  }
}, 2000);

console.log("✅ Content script ready to receive messages from web page");
