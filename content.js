console.log("!!! CONTENT SCRIPT IS RUNNING !!!");

function attemptStart() {
  console.log("Attempting to get session data...");

  const studentId = sessionStorage.getItem("studentId");
  const roomId = sessionStorage.getItem("roomId");

  console.log("Student ID found:", studentId);
  console.log("Room ID found:", roomId);

  if (studentId && roomId) {
    console.log("SUCCESS: Data found. Sending message to background.js");

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
            console.log("Message acknowledged by background:", response);
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
