/**
 * Recording Manager for CodeGuard Extension
 * 
 * Features:
 * - Chunked recording (10-minute segments)
 * - Local IndexedDB storage
 * - On-demand compression & upload
 * - Automatic cleanup after exam
 * - Event timeline tracking
 */

const CONFIG = {
  DB_NAME: 'CodeGuardRecordings',
  DB_VERSION: 2,
  STORE_NAME: 'chunks',
  META_STORE: 'metadata',
  CHUNK_DURATION_MS: 10 * 60 * 1000, // 10 minutes per chunk
  VIDEO_BITRATE: 1000000, // 1 Mbps (720p compressed)
  MIME_TYPE: 'video/webm;codecs=vp9', // VP9 for better compression
  CLEANUP_DELAY_MS: 5 * 60 * 1000, // 5 min grace period after exam ends
};

class RecordingManager {
  constructor() {
    this.db = null;
    this.isRecording = false;
    this.examRoomId = null;
    this.studentId = null;
    this.examStartTime = null;
    this.events = [];
    this.chunkMetadata = [];
    this.cleanupTimers = {};
  }

  // ========== DATABASE OPERATIONS ==========
  
  async openDB() {
    if (this.db) return this.db;
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      
      request.onerror = () => {
        console.error('❌ Failed to open IndexedDB:', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ IndexedDB opened successfully');
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Chunk storage - stores the actual video blobs
        if (!db.objectStoreNames.contains(CONFIG.STORE_NAME)) {
          const store = db.createObjectStore(CONFIG.STORE_NAME, { keyPath: 'chunkId' });
          store.createIndex('roomId', 'roomId', { unique: false });
          store.createIndex('studentId', 'studentId', { unique: false });
          store.createIndex('status', 'status', { unique: false });
          store.createIndex('chunkIndex', 'chunkIndex', { unique: false });
          console.log('✅ Created chunks object store');
        }
        
        // Metadata storage - stores exam session info
        if (!db.objectStoreNames.contains(CONFIG.META_STORE)) {
          db.createObjectStore(CONFIG.META_STORE, { keyPath: 'roomId' });
          console.log('✅ Created metadata object store');
        }
      };
    });
  }

  async saveChunk(chunkData, blob) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      
      const record = {
        ...chunkData,
        blob: blob,
        sizeBytes: blob.size,
        savedAt: new Date().toISOString()
      };
      
      const request = store.put(record);
      
      request.onsuccess = () => {
        console.log(`💾 Saved chunk ${chunkData.chunkIndex} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
        resolve(record);
      };
      
      request.onerror = () => {
        console.error('❌ Failed to save chunk:', request.error);
        reject(request.error);
      };
    });
  }

  async getChunk(chunkId) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readonly');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      const request = store.get(chunkId);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getChunksByRoom(roomId) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readonly');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      const index = store.index('roomId');
      const request = index.getAll(roomId);
      
      request.onsuccess = () => {
        const chunks = request.result || [];
        // Sort by chunkIndex
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        resolve(chunks);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async updateChunkStatus(chunkId, status, url = null) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      
      const getRequest = store.get(chunkId);
      
      getRequest.onsuccess = () => {
        const chunk = getRequest.result;
        if (chunk) {
          chunk.status = status;
          if (url) chunk.uploadedUrl = url;
          chunk.updatedAt = new Date().toISOString();
          
          const putRequest = store.put(chunk);
          putRequest.onsuccess = () => resolve(chunk);
          putRequest.onerror = () => reject(putRequest.error);
        } else {
          reject(new Error(`Chunk ${chunkId} not found`));
        }
      };
      
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  async deleteChunksByRoom(roomId) {
    await this.openDB();
    
    const chunks = await this.getChunksByRoom(roomId);
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      
      let deletedCount = 0;
      
      chunks.forEach(chunk => {
        const request = store.delete(chunk.chunkId);
        request.onsuccess = () => deletedCount++;
      });
      
      transaction.oncomplete = () => {
        console.log(`🗑️ Deleted ${deletedCount} chunks for room ${roomId}`);
        resolve(deletedCount);
      };
      
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async deleteUnuploadedChunks(roomId) {
    await this.openDB();
    
    const chunks = await this.getChunksByRoom(roomId);
    const unuploaded = chunks.filter(c => c.status !== 'uploaded');
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(CONFIG.STORE_NAME);
      
      let deletedCount = 0;
      
      unuploaded.forEach(chunk => {
        const request = store.delete(chunk.chunkId);
        request.onsuccess = () => deletedCount++;
      });
      
      transaction.oncomplete = () => {
        console.log(`🗑️ Deleted ${deletedCount} unuploaded chunks for room ${roomId}`);
        resolve(deletedCount);
      };
      
      transaction.onerror = () => reject(transaction.error);
    });
  }

  // ========== METADATA OPERATIONS ==========

  async saveMetadata(roomId, metadata) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.META_STORE], 'readwrite');
      const store = transaction.objectStore(CONFIG.META_STORE);
      
      const request = store.put({ roomId, ...metadata, updatedAt: new Date().toISOString() });
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getMetadata(roomId) {
    await this.openDB();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([CONFIG.META_STORE], 'readonly');
      const store = transaction.objectStore(CONFIG.META_STORE);
      const request = store.get(roomId);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ========== RECORDING STATE MANAGEMENT ==========
  
  async initRecording(roomId, studentId) {
    await this.openDB();
    
    this.examRoomId = roomId;
    this.studentId = studentId;
    this.examStartTime = Date.now();
    this.events = [{ type: 'exam_start', timestamp: 0, time: new Date().toISOString() }];
    this.chunkMetadata = [];
    this.isRecording = true;
    
    // Save initial metadata
    await this.saveMetadata(roomId, {
      studentId,
      examStartTime: this.examStartTime,
      events: this.events,
      status: 'recording'
    });
    
    console.log('🎬 Recording initialized for room:', roomId, 'student:', studentId);
    return { success: true, examStartTime: this.examStartTime };
  }

  addEvent(eventType, details = null) {
    if (!this.isRecording) return;
    
    const timestamp = Date.now() - this.examStartTime;
    const event = { 
      type: eventType, 
      timestamp, 
      time: new Date().toISOString(),
      details 
    };
    
    this.events.push(event);
    console.log(`📌 Event recorded: ${eventType} at ${(timestamp / 1000).toFixed(1)}s`, details || '');
    
    return event;
  }

  async registerChunk(chunkIndex, startTime, endTime, duration, blob) {
    const chunkId = `${this.examRoomId}_${this.studentId}_${chunkIndex}`;
    
    // Filter events for this chunk's time range
    const chunkStartMs = chunkIndex * CONFIG.CHUNK_DURATION_MS;
    const chunkEndMs = (chunkIndex + 1) * CONFIG.CHUNK_DURATION_MS;
    const chunkEvents = this.events.filter(e => 
      e.timestamp >= chunkStartMs && e.timestamp < chunkEndMs
    );
    
    const chunkData = {
      chunkId,
      chunkIndex,
      roomId: this.examRoomId,
      studentId: this.studentId,
      startTime,
      endTime,
      duration,
      status: 'stored',
      events: chunkEvents
    };
    
    await this.saveChunk(chunkData, blob);
    this.chunkMetadata.push(chunkData);
    
    return chunkData;
  }

  async stopRecording() {
    this.isRecording = false;
    this.addEvent('exam_end');
    
    // Update metadata
    if (this.examRoomId) {
      await this.saveMetadata(this.examRoomId, {
        studentId: this.studentId,
        examStartTime: this.examStartTime,
        examEndTime: Date.now(),
        events: this.events,
        totalChunks: this.chunkMetadata.length,
        status: 'ended'
      });
    }
    
    console.log('⏹️ Recording stopped. Total chunks:', this.chunkMetadata.length);
    return { success: true, totalChunks: this.chunkMetadata.length };
  }

  // ========== CHUNK RETRIEVAL FOR UPLOAD ==========
  
  async getChunkForUpload(chunkIndex) {
    // Get roomId from chrome.storage if not in memory (service worker may have restarted)
    let roomId = this.examRoomId;
    
    if (!roomId) {
      try {
        const stored = await chrome.storage.local.get(['roomId']);
        roomId = stored.roomId;
        if (roomId) {
          this.examRoomId = roomId;
          console.log('📦 Restored roomId from storage for upload:', roomId);
        }
      } catch (err) {
        console.warn('⚠️ Could not get roomId from storage:', err.message);
      }
    }
    
    if (!roomId) {
      throw new Error('No active exam room - cannot upload chunk');
    }
    
    const chunks = await this.getChunksByRoom(roomId);
    const chunk = chunks.find(c => c.chunkIndex === chunkIndex);
    
    if (!chunk) {
      throw new Error(`Chunk ${chunkIndex} not found`);
    }
    
    // Mark as uploading
    await this.updateChunkStatus(chunk.chunkId, 'uploading');
    
    // Return chunk data (blob included)
    return {
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      roomId: chunk.roomId,
      studentId: chunk.studentId,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      duration: chunk.duration,
      events: chunk.events,
      blob: chunk.blob,
      sizeBytes: chunk.sizeBytes
    };
  }

  async markChunkUploaded(chunkId, url) {
    await this.updateChunkStatus(chunkId, 'uploaded', url);
    console.log(`✅ Chunk ${chunkId} marked as uploaded`);
  }

  async getChunkList() {
    // Get roomId from chrome.storage if not in memory (service worker may have restarted)
    let roomId = this.examRoomId;
    
    if (!roomId) {
      try {
        const stored = await chrome.storage.local.get(['roomId']);
        roomId = stored.roomId;
        console.log('📦 Retrieved roomId from storage:', roomId);
        
        // Restore state if we got roomId from storage
        if (roomId) {
          this.examRoomId = roomId;
        }
      } catch (err) {
        console.warn('⚠️ Could not get roomId from storage:', err.message);
      }
    }
    
    if (!roomId) {
      console.warn('⚠️ No active exam room for getChunkList');
      return [];
    }
    
    const chunks = await this.getChunksByRoom(roomId);
    console.log(`📋 Found ${chunks.length} chunks for room ${roomId}`);
    
    // Return metadata only (without blob data for smaller payload)
    return chunks.map(chunk => ({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      duration: chunk.duration,
      sizeBytes: chunk.sizeBytes,
      status: chunk.status,
      events: chunk.events || [],
      uploadedUrl: chunk.uploadedUrl || null
    }));
  }

  // ========== CLEANUP ==========
  
  scheduleCleanup(roomId, delayMs = CONFIG.CLEANUP_DELAY_MS) {
    // Clear any existing timer for this room
    if (this.cleanupTimers[roomId]) {
      clearTimeout(this.cleanupTimers[roomId]);
    }
    
    console.log(`📅 Scheduling cleanup for room ${roomId} in ${delayMs / 1000}s`);
    
    this.cleanupTimers[roomId] = setTimeout(async () => {
      try {
        const chunks = await this.getChunksByRoom(roomId);
        const hasUploadedChunks = chunks.some(c => c.status === 'uploaded');
        
        if (chunks.length === 0) {
          console.log(`ℹ️ No chunks to clean for room ${roomId}`);
          return;
        }
        
        if (!hasUploadedChunks) {
          // No chunks were requested, safe to delete all
          await this.deleteChunksByRoom(roomId);
          console.log(`🗑️ Auto-cleanup completed for room ${roomId} - deleted ${chunks.length} chunks`);
        } else {
          // Only delete non-uploaded chunks
          const deletedCount = await this.deleteUnuploadedChunks(roomId);
          console.log(`🗑️ Partial cleanup for room ${roomId} - deleted ${deletedCount} unrequested chunks`);
        }
        
        delete this.cleanupTimers[roomId];
      } catch (error) {
        console.error(`❌ Cleanup failed for room ${roomId}:`, error);
      }
    }, delayMs);
    
    return { scheduled: true, delayMs };
  }

  cancelCleanup(roomId) {
    if (this.cleanupTimers[roomId]) {
      clearTimeout(this.cleanupTimers[roomId]);
      delete this.cleanupTimers[roomId];
      console.log(`🚫 Cleanup cancelled for room ${roomId}`);
      return true;
    }
    return false;
  }

  // ========== UTILITY ==========
  
  getConfig() {
    return { ...CONFIG };
  }

  getState() {
    return {
      isRecording: this.isRecording,
      examRoomId: this.examRoomId,
      studentId: this.studentId,
      examStartTime: this.examStartTime,
      eventsCount: this.events.length,
      chunksCount: this.chunkMetadata.length
    };
  }
}

// Export singleton instance
export const recordingManager = new RecordingManager();
export { CONFIG as RECORDING_CONFIG };
