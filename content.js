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

    // Forward the message to the background script
    const message = event.data.message;
    
    if (message && message.type) {
      console.log(`📤 Forwarding ${message.type} to background script...`);
      console.log(`🔍 Full message payload:`, JSON.stringify(message, null, 2));
      
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
