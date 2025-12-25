/**
 * Screen Recorder for CodeGuard Extension
 * 
 * This module receives video chunks from the website and saves to Downloads.
 * The website handles the actual screen capture via getDisplayMedia().
 * 
 * Features:
 * - Receives video chunks from website
 * - Saves merged recording to Downloads folder
 * - No extra user prompt needed (uses existing screen share)
 */

const MIME_TYPE = 'video/webm';

class ScreenRecorder {
  constructor() {
    this.isRecording = false;
    this.startTime = null;
    this.examInfo = null;
    this.recordedBlobs = [];
  }

  /**
   * Start receiving recording chunks
   * Called when website starts screen sharing
   */
  async startRecording(examInfo) {
    if (this.isRecording) {
      console.warn('⚠️ Recording already in progress');
      return { success: false, error: 'Already recording' };
    }

    this.examInfo = examInfo;
    this.startTime = Date.now();
    this.recordedBlobs = [];
    this.isRecording = true;

    // Save state to storage
    await chrome.storage.local.set({
      recordingActive: true,
      recordingStartTime: this.startTime,
      recordingExamInfo: examInfo
    });

    console.log('🎬 Screen recording started - waiting for video chunks from website');
    return { 
      success: true, 
      message: 'Recording started - capturing screen via website',
      isRecording: true,
      startTime: this.startTime
    };
  }

  /**
   * Process video data from the website
   * Called when the website sends video chunks
   */
  async processVideoChunk(blob) {
    if (!this.isRecording) {
      console.warn('⚠️ Received chunk but not recording');
      return;
    }
    
    this.recordedBlobs.push(blob);
    
    const totalSize = this.recordedBlobs.reduce((sum, b) => sum + b.size, 0);
    console.log(`📹 Chunk ${this.recordedBlobs.length} received (${(blob.size / 1024).toFixed(2)} KB, total: ${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
  }

  /**
   * Stop recording and save to Downloads
   */
  async stopRecording() {
    if (!this.isRecording) {
      console.warn('⚠️ No recording in progress');
      return { success: false, error: 'Not recording' };
    }

    try {
      this.isRecording = false;
      
      // Update storage
      await chrome.storage.local.set({
        recordingActive: false,
        recordingEndTime: Date.now()
      });

      const duration = Math.floor((Date.now() - this.startTime) / 1000);
      
      console.log(`⏹️ Recording stopped. Duration: ${duration}s, Chunks: ${this.recordedBlobs.length}`);
      
      // Save if we have recorded data
      let saveResult = null;
      if (this.recordedBlobs.length > 0) {
        saveResult = await this.saveRecording();
      } else {
        console.warn('⚠️ No video chunks received - nothing to save');
      }

      return { 
        success: true, 
        message: saveResult?.success ? 'Recording saved to Downloads' : 'Recording stopped (no data)',
        duration,
        chunksCount: this.recordedBlobs.length,
        filename: saveResult?.filename
      };

    } catch (error) {
      console.error('❌ Failed to stop recording:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Save the recording to Downloads folder
   */
  async saveRecording() {
    if (this.recordedBlobs.length === 0) {
      console.warn('⚠️ No recorded data to save');
      return { success: false, error: 'No data' };
    }

    try {
      // Merge all blobs
      const finalBlob = new Blob(this.recordedBlobs, { type: MIME_TYPE });
      
      // Create filename
      const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const examName = (this.examInfo?.examName || 'Exam').replace(/[^a-zA-Z0-9]/g, '_');
      const studentId = (this.examInfo?.studentId || 'student').replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `CodeGuard_${examName}_${studentId}_${date}.webm`;
      
      // Convert blob to data URL for chrome.downloads
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(finalBlob);
      });

      // Download using chrome.downloads API
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: `CodeGuard_Recordings/${filename}`,
        saveAs: false
      });

      console.log(`💾 Recording saved to Downloads!`);
      console.log(`   📁 File: CodeGuard_Recordings/${filename}`);
      console.log(`   📊 Size: ${(finalBlob.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   🆔 Download ID: ${downloadId}`);

      // Clear recorded blobs
      this.recordedBlobs = [];
      
      return { success: true, filename, downloadId };

    } catch (error) {
      console.error('❌ Failed to save recording:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current recording status
   */
  getStatus() {
    const duration = this.isRecording && this.startTime 
      ? Math.floor((Date.now() - this.startTime) / 1000)
      : 0;

    return {
      isRecording: this.isRecording,
      duration,
      chunksCount: this.recordedBlobs.length,
      startTime: this.startTime,
      examInfo: this.examInfo
    };
  }
}

// Export singleton
export const screenRecorder = new ScreenRecorder();
