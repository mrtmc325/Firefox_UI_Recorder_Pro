(function (global) {
  "use strict";

  var DB_NAME = "uir-frame-spool-v1";
  var DB_VERSION = 3;
  var STORES = {
    FRAMES: "frames",
    FRAME_META: "frame_meta",
    SESSION_REFS: "session_refs",
    REPORT_REFS: "report_refs",
    TEXT_DOCS: "text_docs",
    TEXT_REPORT_REFS: "text_report_refs",
    AUDIO_DOCS: "audio_docs",
    AUDIO_REPORT_REFS: "audio_report_refs"
  };
  var DEFAULT_DECODE_WORKER_COUNT = 1;
  var DEFAULT_DECODE_BATCH_SIZE = 1;
  var DEFAULT_DECODE_DISPATCH_POLICY = "single-worker-safe";
  var DEFAULT_DECODE_WORKER_SCRIPT = "frame_spool_worker.js";
  var DECODE_WORKER_ERROR_THRESHOLD = 3;
  var DECODE_INFLIGHT_MULTIPLIER = 2;
  var COLLECTOR2_YIELD_MS = 0;
  var COLLECTOR3_BATCH_SIZE = 2;
  var COLLECTOR3_YIELD_MS = 0;
  var CAPTURE_QUEUE_BYTES_CAP_DEFAULT = 12 * 1024 * 1024;
  var PROCESS_QUEUE_BYTES_CAP_DEFAULT = 24 * 1024 * 1024;
  var WRITE_QUEUE_BYTES_CAP_DEFAULT = 24 * 1024 * 1024;

  function noop() {}

  function nowMs() {
    return Date.now();
  }

  function waitMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function clampInt(value, min, max, fallback) {
    var num = Math.round(Number(value));
    if (!Number.isFinite(num)) return Math.round(Number(fallback) || min);
    return Math.max(min, Math.min(max, num));
  }

  function parseDataUrl(rawInput) {
    var raw = String(rawInput || "").trim();
    var match = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(raw);
    if (!match) throw new Error("Invalid data URL payload");
    var mime = String(match[1] || "image/png").trim() || "image/png";
    return {
      raw: raw,
      mime: mime,
      isBase64: !!match[2],
      payload: String(match[3] || "")
    };
  }

  function parseDataUrlMime(rawInput, fallbackMime) {
    try {
      return parseDataUrl(rawInput).mime;
    } catch (_) {
      return String(fallbackMime || "image/png");
    }
  }

  function resolveCaptureMime(meta, dataUrl, fallbackMime) {
    var fromMeta = String(meta && meta.mime || "").trim().toLowerCase();
    if (fromMeta) return fromMeta;
    return parseDataUrlMime(dataUrl, fallbackMime || "image/png");
  }

  function dataUrlToBytes(dataUrl) {
    var parsed = parseDataUrl(dataUrl);
    var bytes;
    if (parsed.isBase64) {
      var decoded = atob(parsed.payload);
      bytes = new Uint8Array(decoded.length);
      for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    } else {
      var decodedUri = decodeURIComponent(parsed.payload);
      bytes = new TextEncoder().encode(decodedUri);
    }
    return { bytes: bytes, mime: parsed.mime };
  }

  function estimateDataUrlBytes(dataUrl) {
    var raw = String(dataUrl || "");
    if (!raw) return 0;
    var comma = raw.indexOf(",");
    if (comma < 0) return raw.length;
    var payload = raw.slice(comma + 1);
    if (raw.slice(0, comma).indexOf(";base64") >= 0) {
      return Math.floor((payload.length * 3) / 4);
    }
    return payload.length;
  }

  function createSpoolDropError(reason) {
    var err = new Error(String(reason || "Frame dropped due to spool pressure"));
    try {
      err.code = "FRAME_SPOOL_PRESSURE_DROP";
      err.uiRecorderDropped = true;
    } catch (_) {}
    return err;
  }

  function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value instanceof Set) return Array.from(value);
    return [];
  }

  function uniqueStrings(values) {
    var out = [];
    var seen = new Set();
    toArray(values).forEach(function (value) {
      var text = String(value || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      out.push(text);
    });
    return out;
  }

  function makeKey(a, b) {
    return String(a || "") + ":" + String(b || "");
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB request failed")); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
      tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction aborted")); };
    });
  }

  function openCursorAll(source, onRecord) {
    return new Promise(function (resolve, reject) {
      var request = source.openCursor();
      request.onerror = function () { reject(request.error || new Error("Cursor failed")); };
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          onRecord(cursor.value, cursor);
        } catch (err) {
          reject(err);
          return;
        }
        cursor.continue();
      };
    });
  }

  function openCursorByIndex(index, key, onRecord) {
    return new Promise(function (resolve, reject) {
      var request = index.openCursor(IDBKeyRange.only(key));
      request.onerror = function () { reject(request.error || new Error("Cursor by index failed")); };
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          onRecord(cursor.value, cursor);
        } catch (err) {
          reject(err);
          return;
        }
        cursor.continue();
      };
    });
  }

  function dataUrlToBlob(dataUrl) {
    var decoded = dataUrlToBytes(dataUrl);
    return new Blob([decoded.bytes], { type: decoded.mime });
  }

  function bytesToDataUrl(bytes, mime) {
    var safeMime = String(mime || "image/png").trim() || "image/png";
    var chunkSize = 0x8000;
    var binary = "";
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return "data:" + safeMime + ";base64," + btoa(binary);
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(reader.error || new Error("Failed to read blob as data URL")); };
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.readAsDataURL(blob);
    });
  }

  function normalizeRef(raw, fallbackSessionId) {
    if (!raw || typeof raw !== "object") return null;
    var frameId = String(raw.frameId || "").trim();
    if (!frameId) return null;
    var sessionId = String(raw.sessionId || fallbackSessionId || "").trim();
    return {
      frameId: frameId,
      sessionId: sessionId,
      mime: String(raw.mime || "image/png"),
      createdAtMs: Number(raw.createdAtMs) || nowMs(),
      width: Number(raw.width) || null,
      height: Number(raw.height) || null
    };
  }

  function normalizeTextRef(raw) {
    if (!raw || typeof raw !== "object") return null;
    var docId = String(raw.docId || "").trim();
    if (!docId) return null;
    var mime = String(raw.mime || "text/plain").trim() || "text/plain";
    return {
      docId: docId,
      mime: mime,
      byteLength: Number(raw.byteLength) || 0,
      createdAtMs: Number(raw.createdAtMs) || nowMs()
    };
  }

  function createFrameId() {
    return "frm_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createTextDocId() {
    return "txt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createAudioDocId() {
    return "aud_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function createCaptureItem(meta, dataUrl, resolve, reject) {
    var safeMeta = meta && typeof meta === "object" ? meta : {};
    var payload = String(dataUrl || "");
    var createdAtMs = Number(safeMeta.createdAtMs) || nowMs();
    var estimatedBytes = Math.max(0, estimateDataUrlBytes(payload));
    return {
      meta: safeMeta,
      dataUrl: payload,
      createdAtMs: createdAtMs,
      resolve: typeof resolve === "function" ? resolve : noop,
      reject: typeof reject === "function" ? reject : noop,
      frameId: createFrameId(),
      byteBuffer: null,
      byteLength: 0,
      mime: resolveCaptureMime(safeMeta, payload, "image/png"),
      sessionId: String(safeMeta.sessionId || ""),
      width: Number(safeMeta.width) || null,
      height: Number(safeMeta.height) || null,
      estimatedBytes: estimatedBytes,
      dropOnPressure: !!safeMeta.dropOnPressure
    };
  }

  function FrameSpoolService(options) {
    var opts = options || {};
    this.captureQueueMax = Math.max(1, Number(opts.captureQueueMax) || 6);
    this.processQueueMax = Math.max(1, Number(opts.processQueueMax) || 12);
    this.writeQueueMax = Math.max(1, Number(opts.writeQueueMax) || 18);
    this.decodeWorkerEnabled = opts.decodeWorkerEnabled === true;
    this.decodeWorkerCount = this.decodeWorkerEnabled
      ? 1
      : clampInt(opts.decodeWorkerCount, 1, 1, DEFAULT_DECODE_WORKER_COUNT);
    this.decodeBatchSize = clampInt(opts.decodeBatchSize, 1, 8, DEFAULT_DECODE_BATCH_SIZE);
    this.decodeDispatchPolicy = String(opts.decodeDispatchPolicy || DEFAULT_DECODE_DISPATCH_POLICY);
    if (this.decodeDispatchPolicy !== DEFAULT_DECODE_DISPATCH_POLICY && this.decodeDispatchPolicy !== "round-robin-busy-skip") {
      this.decodeDispatchPolicy = DEFAULT_DECODE_DISPATCH_POLICY;
    }
    this.decodeWorkerScript = String(opts.decodeWorkerScript || DEFAULT_DECODE_WORKER_SCRIPT);
    this.decodeInlineFallback = false;
    this.captureQueueBytesCap = Math.max(1024 * 1024, Number(opts.captureQueueBytesCap) || CAPTURE_QUEUE_BYTES_CAP_DEFAULT);
    this.processQueueBytesCap = Math.max(1024 * 1024, Number(opts.processQueueBytesCap) || PROCESS_QUEUE_BYTES_CAP_DEFAULT);
    this.writeQueueBytesCap = Math.max(1024 * 1024, Number(opts.writeQueueBytesCap) || WRITE_QUEUE_BYTES_CAP_DEFAULT);
    this.captureQueue = [];
    this.processQueue = [];
    this.writeQueue = [];
    this._dbPromise = null;
    this._pumpScheduled = false;
    this._collector2Running = false;
    this._collector3Running = false;
    this._closed = false;
    this._decodeWorkers = [];
    this._decodeInflight = new Map();
    this._decodeBatchSeq = 0;
    this._decodeDispatchCursor = 0;
    this._decodeInflightFrames = 0;
    this._decodeInflightFrameCap = Math.max(
      this.decodeWorkerCount * this.decodeBatchSize * DECODE_INFLIGHT_MULTIPLIER,
      this.writeQueueMax * DECODE_INFLIGHT_MULTIPLIER
    );
    this.captureQueueBytes = 0;
    this.processQueueBytes = 0;
    this.writeQueueBytes = 0;
    this.queueBytesHighWater = 0;
    this.droppedFrames = 0;
    this.lastDropReason = null;
    this._log = typeof opts.log === "function" ? opts.log : noop;
    this._warn = typeof opts.warn === "function" ? opts.warn : noop;
    this.stats = {
      frameCount: 0,
      totalBytes: 0,
      lastGcAtMs: 0
    };
  }

  FrameSpoolService.prototype._logEvent = function (event, payload) {
    try { this._log(event, payload || {}); } catch (_) {}
  };

  FrameSpoolService.prototype._warnEvent = function (event, payload) {
    try { this._warn(event, payload || {}); } catch (_) {}
  };

  FrameSpoolService.prototype._queueBytesTotal = function () {
    return (
      Math.max(0, Number(this.captureQueueBytes) || 0) +
      Math.max(0, Number(this.processQueueBytes) || 0) +
      Math.max(0, Number(this.writeQueueBytes) || 0)
    );
  };

  FrameSpoolService.prototype._queueBytesCapTotal = function () {
    return (
      Math.max(0, Number(this.captureQueueBytesCap) || 0) +
      Math.max(0, Number(this.processQueueBytesCap) || 0) +
      Math.max(0, Number(this.writeQueueBytesCap) || 0)
    );
  };

  FrameSpoolService.prototype._updateQueueByteHighWater = function () {
    this.queueBytesHighWater = Math.max(
      Math.max(0, Number(this.queueBytesHighWater) || 0),
      this._queueBytesTotal()
    );
  };

  FrameSpoolService.prototype._getBackpressureLevel = function () {
    var total = this._queueBytesTotal();
    var cap = Math.max(1, this._queueBytesCapTotal());
    var ratio = total / cap;
    var writeRatio = (Number(this.writeQueue.length) || 0) / Math.max(1, this.writeQueueMax);
    var processRatio = (Number(this.processQueue.length) || 0) / Math.max(1, this.processQueueMax);
    if (this.shouldPauseCapture() || ratio >= 0.9 || writeRatio >= 0.9 || processRatio >= 0.9) return "severe";
    if (ratio >= 0.72 || writeRatio >= 0.75 || processRatio >= 0.75) return "high";
    if (ratio >= 0.45 || writeRatio >= 0.5 || processRatio >= 0.5) return "moderate";
    return "healthy";
  };

  FrameSpoolService.prototype._runtimeDecodeMode = function () {
    return this._workersAvailable() ? "single-worker-safe" : "inline-safe";
  };

  FrameSpoolService.prototype._registerDroppedItem = function (item, reason) {
    this.droppedFrames = Math.max(0, Number(this.droppedFrames) || 0) + 1;
    this.lastDropReason = String(reason || "pressure-drop");
    this._warnEvent("frame-spool:drop-frame", {
      reason: this.lastDropReason,
      frameId: item && item.frameId ? String(item.frameId) : null,
      queueBytes: this._queueBytesTotal(),
      queueLevel: this._getBackpressureLevel()
    });
  };

  FrameSpoolService.prototype._canQueueCaptureItem = function (item) {
    var est = Math.max(0, Number(item && item.estimatedBytes) || 0);
    if ((this.captureQueueBytes + est) > this.captureQueueBytesCap) return false;
    if (this.processQueueBytes > this.processQueueBytesCap) return false;
    if (this.writeQueueBytes > this.writeQueueBytesCap) return false;
    if ((this._queueBytesTotal() + est) > this._queueBytesCapTotal()) return false;
    return true;
  };

  FrameSpoolService.prototype._resolveDecodeWorkerScriptUrl = function () {
    var script = String(this.decodeWorkerScript || DEFAULT_DECODE_WORKER_SCRIPT).trim() || DEFAULT_DECODE_WORKER_SCRIPT;
    if (/^(moz-extension:|chrome-extension:|https?:|data:|blob:)/i.test(script)) return script;
    try {
      if (global && global.browser && global.browser.runtime && typeof global.browser.runtime.getURL === "function") {
        return global.browser.runtime.getURL(script);
      }
    } catch (_) {}
    try {
      if (global && global.chrome && global.chrome.runtime && typeof global.chrome.runtime.getURL === "function") {
        return global.chrome.runtime.getURL(script);
      }
    } catch (_) {}
    return script;
  };

  FrameSpoolService.prototype._workersAvailable = function () {
    return (
      this.decodeWorkerEnabled &&
      !this.decodeInlineFallback &&
      typeof Worker === "function"
    );
  };

  FrameSpoolService.prototype._teardownDecodeWorkers = function (reason, keepInflight) {
    var preserveInflight = keepInflight === true;
    if (!preserveInflight && this._decodeInflight.size) {
      var restored = [];
      this._decodeInflight.forEach(function (entry) {
        if (!entry || !Array.isArray(entry.items)) return;
        entry.items.forEach(function (item) {
          if (!item) return;
          restored.push(item);
        });
      });
      if (restored.length) {
        this.processQueue = restored.concat(this.processQueue);
        for (var r = 0; r < restored.length; r++) {
          var restoredEst = Math.max(0, Number(restored[r] && restored[r].estimatedBytes) || 0);
          this.processQueueBytes += restoredEst;
        }
      }
    }
    this._decodeInflight.clear();
    this._decodeInflightFrames = 0;
    for (var i = 0; i < this._decodeWorkers.length; i++) {
      var workerEntry = this._decodeWorkers[i];
      if (!workerEntry || !workerEntry.worker) continue;
      try { workerEntry.worker.terminate(); } catch (_) {}
    }
    this._decodeWorkers.length = 0;
    this._decodeDispatchCursor = 0;
    if (reason) {
      this._logEvent("frame-spool:decode-workers-stopped", { reason: String(reason) });
    }
  };

  FrameSpoolService.prototype._disableWorkerDecode = function (reason, payload) {
    if (this.decodeInlineFallback) return;
    this.decodeInlineFallback = true;
    var details = { reason: String(reason || "unknown") };
    if (payload && typeof payload === "object") {
      for (var key in payload) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
        details[key] = payload[key];
      }
    }
    this._warnEvent("frame-spool:decode-worker-disabled", {
      reason: details.reason,
      workerIndex: details.workerIndex,
      error: details.error
    });
    this._teardownDecodeWorkers(String(reason || "decode-worker-disabled"));
  };

  FrameSpoolService.prototype._initializeDecodeWorkers = function () {
    if (!this._workersAvailable()) return false;
    if (this._decodeWorkers.length) return true;
    var workerUrl = this._resolveDecodeWorkerScriptUrl();
    var created = 0;
    for (var i = 0; i < this.decodeWorkerCount; i++) {
      var worker = null;
      try {
        worker = new Worker(workerUrl);
      } catch (err) {
        this._warnEvent("frame-spool:decode-worker-create-failed", {
          workerIndex: i,
          error: String((err && err.message) || err || "worker-create-failed")
        });
        continue;
      }
      var self = this;
      (function bindHandlers(index, boundWorker) {
        boundWorker.onmessage = function (event) {
          self._onDecodeWorkerMessage(index, event && event.data);
        };
        boundWorker.onerror = function (event) {
          var message = event && event.message
            ? String(event.message)
            : "decode-worker-runtime-error";
          self._onDecodeWorkerError(index, message);
        };
        boundWorker.onmessageerror = function () {
          self._onDecodeWorkerError(index, "decode-worker-message-error");
        };
      })(i, worker);

      this._decodeWorkers.push({
        index: i,
        worker: worker,
        busy: false,
        healthy: true,
        fallback: false,
        inflightBatchId: null,
        completedBatches: 0,
        failedBatches: 0,
        errorStreak: 0,
        lastError: null,
        lastStartedAtMs: null,
        lastCompletedAtMs: null
      });
      created += 1;
    }
    if (!created) {
      this._disableWorkerDecode("worker-create-unavailable");
      return false;
    }
    this._logEvent("frame-spool:decode-workers-started", {
      workerCount: created,
      batchSize: this.decodeBatchSize,
      dispatchPolicy: this.decodeDispatchPolicy
    });
    return true;
  };

  FrameSpoolService.prototype._onDecodeWorkerError = function (workerIndex, errorText) {
    var index = Number(workerIndex);
    var entry = this._decodeWorkers[index];
    if (!entry) return;
    if (entry.inflightBatchId) {
      var inflight = this._decodeInflight.get(entry.inflightBatchId);
      if (inflight && Array.isArray(inflight.items) && inflight.items.length) {
        this.processQueue = inflight.items.concat(this.processQueue);
        for (var ir = 0; ir < inflight.items.length; ir++) {
          var inflightEst = Math.max(0, Number(inflight.items[ir] && inflight.items[ir].estimatedBytes) || 0);
          this.processQueueBytes += inflightEst;
        }
      }
      if (inflight) {
        this._decodeInflight.delete(entry.inflightBatchId);
        this._decodeInflightFrames = Math.max(0, this._decodeInflightFrames - inflight.items.length);
      }
    }
    entry.failedBatches += 1;
    entry.errorStreak = Math.max(0, Number(entry.errorStreak) || 0) + 1;
    entry.lastError = String(errorText || "decode-worker-error");
    entry.healthy = entry.errorStreak < DECODE_WORKER_ERROR_THRESHOLD;
    entry.busy = false;
    entry.inflightBatchId = null;
    if (entry.errorStreak >= DECODE_WORKER_ERROR_THRESHOLD) {
      this._disableWorkerDecode("worker-error-threshold", {
        workerIndex: index,
        error: entry.lastError
      });
      return;
    }
    this._warnEvent("frame-spool:decode-worker-error", {
      workerIndex: index,
      error: entry.lastError,
      errorStreak: entry.errorStreak
    });
    this._schedulePump();
  };

  FrameSpoolService.prototype._decodeInlineItem = function (item) {
    var decoded = dataUrlToBytes(item.dataUrl);
    item.byteBuffer = decoded.bytes.buffer.slice(
      decoded.bytes.byteOffset,
      decoded.bytes.byteOffset + decoded.bytes.byteLength
    );
    item.byteLength = decoded.bytes.byteLength;
    item.mime = String(item.mime || decoded.mime || "image/png").trim() || "image/png";
    item.dataUrl = "";
    item.createdAtMs = Number(item.createdAtMs) || nowMs();
    item.sessionId = String(item.sessionId || "");
    item.width = Number(item.width) || null;
    item.height = Number(item.height) || null;
    return item;
  };

  FrameSpoolService.prototype._canDispatchMoreDecodeFrames = function () {
    return (
      (this._decodeInflightFrames + this.writeQueue.length) < this._decodeInflightFrameCap
    );
  };

  FrameSpoolService.prototype._hasIdleDecodeWorker = function () {
    for (var i = 0; i < this._decodeWorkers.length; i++) {
      var entry = this._decodeWorkers[i];
      if (entry && entry.worker && !entry.busy && entry.healthy !== false) return true;
    }
    return false;
  };

  FrameSpoolService.prototype._nextIdleWorkerIndex = function () {
    if (!this._decodeWorkers.length) return -1;
    var count = this._decodeWorkers.length;
    for (var offset = 0; offset < count; offset++) {
      var idx = (this._decodeDispatchCursor + offset) % count;
      var entry = this._decodeWorkers[idx];
      if (!entry || !entry.worker || entry.busy || entry.healthy === false) continue;
      this._decodeDispatchCursor = (idx + 1) % count;
      return idx;
    }
    return -1;
  };

  FrameSpoolService.prototype._onDecodeWorkerMessage = function (workerIndex, payload) {
    if (!payload || typeof payload !== "object") return;
    var type = String(payload.type || "");
    if (type === "decodeBatchResult") {
      this._settleDecodeBatch(workerIndex, payload.batchId, true, payload);
      return;
    }
    if (type === "decodeBatchError") {
      this._settleDecodeBatch(workerIndex, payload.batchId, false, payload);
      return;
    }
    this._warnEvent("frame-spool:decode-worker-unknown-message", {
      workerIndex: Number(workerIndex),
      type: type || "unknown"
    });
  };

  FrameSpoolService.prototype._settleDecodeBatch = function (workerIndex, batchIdRaw, success, payload) {
    var batchId = String(batchIdRaw || "").trim();
    if (!batchId) return;
    var entry = this._decodeWorkers[Number(workerIndex)];
    var inflight = this._decodeInflight.get(batchId);
    if (!inflight) {
      if (entry) {
        entry.busy = false;
        entry.inflightBatchId = null;
      }
      return;
    }
    this._decodeInflight.delete(batchId);
    this._decodeInflightFrames = Math.max(0, this._decodeInflightFrames - inflight.items.length);
    if (entry) {
      entry.busy = false;
      entry.inflightBatchId = null;
      entry.lastCompletedAtMs = nowMs();
    }

    if (!success) {
      var errorText = String(payload && payload.error || "decode-batch-error");
      if (entry) {
        entry.failedBatches += 1;
        entry.errorStreak = Math.max(0, Number(entry.errorStreak) || 0) + 1;
        entry.lastError = errorText;
        entry.healthy = entry.errorStreak < DECODE_WORKER_ERROR_THRESHOLD;
      }
      var restoreItems = Array.isArray(inflight.items) ? inflight.items : [];
      if (restoreItems.length) {
        this.processQueue = restoreItems.concat(this.processQueue);
        for (var ri = 0; ri < restoreItems.length; ri++) {
          var restoreEst = Math.max(0, Number(restoreItems[ri] && restoreItems[ri].estimatedBytes) || 0);
          this.processQueueBytes += restoreEst;
        }
      }
      this._warnEvent("frame-spool:decode-batch-error", {
        workerIndex: Number(workerIndex),
        batchId: batchId,
        error: errorText
      });
      if (entry && entry.errorStreak >= DECODE_WORKER_ERROR_THRESHOLD) {
        this._disableWorkerDecode("worker-batch-error-threshold", {
          workerIndex: Number(workerIndex),
          error: errorText
        });
        return;
      }
      this._schedulePump();
      return;
    }

    var frames = Array.isArray(payload && payload.frames) ? payload.frames : [];
    var frameById = new Map();
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var frameId = String(frame && frame.frameId || "").trim();
      if (!frameId) continue;
      frameById.set(frameId, frame);
    }

    var items = Array.isArray(inflight.items) ? inflight.items : [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      if (!item) continue;
      var framePayload = frameById.get(String(item.frameId || "").trim());
      if (!framePayload || !(framePayload.buffer instanceof ArrayBuffer)) {
        try {
          this._decodeInlineItem(item);
          this.writeQueue.push(item);
          this.writeQueueBytes += Math.max(0, Number(item && item.estimatedBytes) || 0);
        } catch (err) {
          item.reject(err);
        }
        continue;
      }
      item.byteBuffer = framePayload.buffer;
      item.byteLength = Number(framePayload.byteLength) || item.byteBuffer.byteLength || 0;
      item.mime = String(framePayload.mime || item.mime || "image/png").trim() || "image/png";
      item.dataUrl = "";
      this.writeQueue.push(item);
      this.writeQueueBytes += Math.max(0, Number(item && item.estimatedBytes) || 0);
    }

    if (entry) {
      entry.completedBatches += 1;
      entry.errorStreak = 0;
      entry.healthy = true;
      entry.lastError = null;
    }
    this._schedulePump();
  };

  FrameSpoolService.prototype._dispatchDecodeWork = function () {
    if (!this._initializeDecodeWorkers()) return false;
    if (!this.processQueue.length) return false;
    var dispatched = 0;
    while (this.processQueue.length && this._canDispatchMoreDecodeFrames()) {
      var workerIndex = this._nextIdleWorkerIndex();
      if (workerIndex < 0) break;
      var workerEntry = this._decodeWorkers[workerIndex];
      if (!workerEntry || !workerEntry.worker) break;

      var batch = [];
      while (batch.length < this.decodeBatchSize && this.processQueue.length) {
        var item = this.processQueue.shift();
        if (!item) continue;
        this.processQueueBytes = Math.max(0, this.processQueueBytes - (Math.max(0, Number(item.estimatedBytes) || 0)));
        batch.push(item);
      }
      if (!batch.length) break;

      var seq = ++this._decodeBatchSeq;
      var batchId = "dec_" + seq.toString(36);
      workerEntry.busy = true;
      workerEntry.inflightBatchId = batchId;
      workerEntry.lastStartedAtMs = nowMs();
      this._decodeInflight.set(batchId, {
        batchId: batchId,
        seq: seq,
        workerIndex: workerIndex,
        startedAtMs: nowMs(),
        items: batch
      });
      this._decodeInflightFrames += batch.length;

      var framesPayload = batch.map(function (item) {
        return {
          frameId: String(item.frameId || ""),
          dataUrl: item.dataUrl,
          meta: {
            sessionId: item.sessionId || "",
            createdAtMs: Number(item.createdAtMs) || nowMs(),
            width: Number(item.width) || null,
            height: Number(item.height) || null,
            mime: String(item.mime || "image/png")
          }
        };
      });

      try {
        workerEntry.worker.postMessage({
          type: "decodeBatch",
          batchId: batchId,
          frames: framesPayload
        });
        dispatched += 1;
      } catch (err) {
        this._decodeInflight.delete(batchId);
        this._decodeInflightFrames = Math.max(0, this._decodeInflightFrames - batch.length);
        workerEntry.busy = false;
        workerEntry.inflightBatchId = null;
        workerEntry.failedBatches += 1;
        workerEntry.errorStreak = Math.max(0, Number(workerEntry.errorStreak) || 0) + 1;
        workerEntry.lastError = String((err && err.message) || err || "decode-worker-post-failed");
        this.processQueue = batch.concat(this.processQueue);
        for (var bi = 0; bi < batch.length; bi++) {
          var batchEst = Math.max(0, Number(batch[bi] && batch[bi].estimatedBytes) || 0);
          this.processQueueBytes += batchEst;
        }
        this._warnEvent("frame-spool:decode-dispatch-failed", {
          workerIndex: workerIndex,
          batchId: batchId,
          error: workerEntry.lastError
        });
        if (workerEntry.errorStreak >= DECODE_WORKER_ERROR_THRESHOLD) {
          this._disableWorkerDecode("worker-post-error-threshold", {
            workerIndex: workerIndex,
            error: workerEntry.lastError
          });
          break;
        }
      }
    }
    this._updateQueueByteHighWater();
    return dispatched > 0;
  };

  FrameSpoolService.prototype.getWorkerState = function () {
    var enabled = this.decodeWorkerEnabled && !this.decodeInlineFallback && this._decodeWorkers.length > 0;
    var workerHealth = this._decodeWorkers.map(function (entry) {
        return {
          index: Number(entry && entry.index) || 0,
          busy: !!(entry && entry.busy),
          healthy: entry && Object.prototype.hasOwnProperty.call(entry, "healthy")
            ? !!entry.healthy
            : true,
          fallback: false,
          completedBatches: Number(entry && entry.completedBatches) || 0,
          failedBatches: Number(entry && entry.failedBatches) || 0,
          lastError: entry && entry.lastError ? String(entry.lastError) : null
        };
      });
    if (!workerHealth.length && this.decodeInlineFallback) {
      workerHealth.push({
        index: 0,
        busy: false,
        healthy: true,
        fallback: true,
        completedBatches: 0,
        failedBatches: 0,
        lastError: "worker-disabled-inline-fallback"
      });
    }
    return {
      enabled: enabled,
      workerCount: this._decodeWorkers.length || (this.decodeInlineFallback ? this.decodeWorkerCount : 0),
      batchSize: this.decodeBatchSize,
      dispatchCursor: this._decodeDispatchCursor,
      inflightBatches: this._decodeInflight.size,
      decodeQueueDepth: this.processQueue.length,
      workerHealth: workerHealth
    };
  };

  FrameSpoolService.prototype._ensureOpen = function () {
    if (this._closed) throw new Error("Frame spool is closed");
  };

  FrameSpoolService.prototype._openDb = function () {
    var self = this;
    self._ensureOpen();
    if (self._dbPromise) return self._dbPromise;
    self._dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = function () { reject(request.error || new Error("Failed to open frame spool DB")); };
      request.onupgradeneeded = function () {
        var db = request.result;
        var frames = db.objectStoreNames.contains(STORES.FRAMES)
          ? request.transaction.objectStore(STORES.FRAMES)
          : db.createObjectStore(STORES.FRAMES, { keyPath: "frameId" });
        if (!frames.indexNames.contains("createdAtMs")) frames.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!frames.indexNames.contains("sessionId")) frames.createIndex("sessionId", "sessionId", { unique: false });

        var meta = db.objectStoreNames.contains(STORES.FRAME_META)
          ? request.transaction.objectStore(STORES.FRAME_META)
          : db.createObjectStore(STORES.FRAME_META, { keyPath: "frameId" });
        if (!meta.indexNames.contains("createdAtMs")) meta.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!meta.indexNames.contains("sessionId")) meta.createIndex("sessionId", "sessionId", { unique: false });

        var sessionRefs = db.objectStoreNames.contains(STORES.SESSION_REFS)
          ? request.transaction.objectStore(STORES.SESSION_REFS)
          : db.createObjectStore(STORES.SESSION_REFS, { keyPath: "id" });
        if (!sessionRefs.indexNames.contains("sessionId")) sessionRefs.createIndex("sessionId", "sessionId", { unique: false });
        if (!sessionRefs.indexNames.contains("frameId")) sessionRefs.createIndex("frameId", "frameId", { unique: false });

        var reportRefs = db.objectStoreNames.contains(STORES.REPORT_REFS)
          ? request.transaction.objectStore(STORES.REPORT_REFS)
          : db.createObjectStore(STORES.REPORT_REFS, { keyPath: "id" });
        if (!reportRefs.indexNames.contains("reportId")) reportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!reportRefs.indexNames.contains("frameId")) reportRefs.createIndex("frameId", "frameId", { unique: false });

        var textDocs = db.objectStoreNames.contains(STORES.TEXT_DOCS)
          ? request.transaction.objectStore(STORES.TEXT_DOCS)
          : db.createObjectStore(STORES.TEXT_DOCS, { keyPath: "docId" });
        if (!textDocs.indexNames.contains("createdAtMs")) textDocs.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!textDocs.indexNames.contains("mime")) textDocs.createIndex("mime", "mime", { unique: false });

        var textReportRefs = db.objectStoreNames.contains(STORES.TEXT_REPORT_REFS)
          ? request.transaction.objectStore(STORES.TEXT_REPORT_REFS)
          : db.createObjectStore(STORES.TEXT_REPORT_REFS, { keyPath: "id" });
        if (!textReportRefs.indexNames.contains("reportId")) textReportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!textReportRefs.indexNames.contains("docId")) textReportRefs.createIndex("docId", "docId", { unique: false });

        var audioDocs = db.objectStoreNames.contains(STORES.AUDIO_DOCS)
          ? request.transaction.objectStore(STORES.AUDIO_DOCS)
          : db.createObjectStore(STORES.AUDIO_DOCS, { keyPath: "docId" });
        if (!audioDocs.indexNames.contains("createdAtMs")) audioDocs.createIndex("createdAtMs", "createdAtMs", { unique: false });
        if (!audioDocs.indexNames.contains("mime")) audioDocs.createIndex("mime", "mime", { unique: false });

        var audioReportRefs = db.objectStoreNames.contains(STORES.AUDIO_REPORT_REFS)
          ? request.transaction.objectStore(STORES.AUDIO_REPORT_REFS)
          : db.createObjectStore(STORES.AUDIO_REPORT_REFS, { keyPath: "id" });
        if (!audioReportRefs.indexNames.contains("reportId")) audioReportRefs.createIndex("reportId", "reportId", { unique: false });
        if (!audioReportRefs.indexNames.contains("docId")) audioReportRefs.createIndex("docId", "docId", { unique: false });
      };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () {
          try { db.close(); } catch (_) {}
          self._dbPromise = null;
        };
        resolve(db);
      };
    });
    return self._dbPromise;
  };

  FrameSpoolService.prototype.init = async function () {
    await this._openDb();
    this._initializeDecodeWorkers();
    await this.refreshStats();
    this._updateQueueByteHighWater();
    return this;
  };

  FrameSpoolService.prototype.getQueueState = function () {
    this._updateQueueByteHighWater();
    return {
      captureQueue: this.captureQueue.length,
      processQueue: this.processQueue.length,
      writeQueue: this.writeQueue.length,
      decodeQueueDepth: this.processQueue.length,
      inflightBatches: this._decodeInflight.size,
      captureQueueBytes: this.captureQueueBytes,
      processQueueBytes: this.processQueueBytes,
      writeQueueBytes: this.writeQueueBytes,
      queueBytes: this._queueBytesTotal(),
      queueBytesHighWater: this.queueBytesHighWater,
      droppedFrames: this.droppedFrames,
      backpressureLevel: this._getBackpressureLevel(),
      decodeMode: this._runtimeDecodeMode(),
      safetyCapActive: this.shouldPauseCapture(),
      paused: this.shouldPauseCapture()
    };
  };

  FrameSpoolService.prototype.getRuntimeState = function () {
    this._updateQueueByteHighWater();
    var queueDepth = (
      (Number(this.captureQueue.length) || 0) +
      (Number(this.processQueue.length) || 0) +
      (Number(this.writeQueue.length) || 0)
    );
    return {
      queueDepth: queueDepth,
      queueBytes: this._queueBytesTotal(),
      queueBytesHighWater: this.queueBytesHighWater,
      droppedFrames: Math.max(0, Number(this.droppedFrames) || 0),
      backpressureLevel: this._getBackpressureLevel(),
      decodeMode: this._runtimeDecodeMode(),
      safetyCapActive: this.shouldPauseCapture()
    };
  };

  FrameSpoolService.prototype._isIdle = function () {
    return (
      this.captureQueue.length === 0 &&
      this.processQueue.length === 0 &&
      this.writeQueue.length === 0 &&
      this._decodeInflight.size === 0 &&
      !this._collector2Running &&
      !this._collector3Running &&
      !this._pumpScheduled
    );
  };

  FrameSpoolService.prototype.waitUntilIdle = async function (options) {
    var opts = options || {};
    var timeoutMs = Math.max(50, Number(opts.timeoutMs) || 2500);
    var pollMs = Math.max(10, Number(opts.pollMs) || 50);
    var start = nowMs();
    while (true) {
      if (this._isIdle()) return true;
      if ((nowMs() - start) >= timeoutMs) return false;
      await waitMs(pollMs);
    }
  };

  FrameSpoolService.prototype.shouldPauseCapture = function () {
    return (
      this.writeQueue.length >= this.writeQueueMax ||
      this.processQueue.length >= this.processQueueMax ||
      this._decodeInflightFrames >= this._decodeInflightFrameCap ||
      this.captureQueueBytes >= this.captureQueueBytesCap ||
      this.processQueueBytes >= this.processQueueBytesCap ||
      this.writeQueueBytes >= this.writeQueueBytesCap ||
      this._queueBytesTotal() >= this._queueBytesCapTotal()
    );
  };

  FrameSpoolService.prototype.enqueueCapture = function (meta, dataUrl) {
    var self = this;
    self._ensureOpen();
    return new Promise(function (resolve, reject) {
      var item = createCaptureItem(meta, dataUrl, resolve, reject);
      if (!item.dataUrl) {
        reject(new Error("Cannot enqueue empty frame payload"));
        return;
      }
      if (self.captureQueue.length >= (self.captureQueueMax * 4)) {
        reject(new Error("Frame capture queue overflow"));
        return;
      }
      if (!self._canQueueCaptureItem(item)) {
        if (item.dropOnPressure) {
          self._registerDroppedItem(item, "capture-byte-cap");
          reject(createSpoolDropError("Frame dropped due to spool byte cap"));
          return;
        }
        reject(new Error("Frame capture byte budget exceeded"));
        return;
      }
      self.captureQueue.push(item);
      self.captureQueueBytes += Math.max(0, Number(item.estimatedBytes) || 0);
      self._updateQueueByteHighWater();
      self._schedulePump();
    });
  };

  FrameSpoolService.prototype.enqueueCaptureImmediate = function (meta, dataUrl) {
    this._ensureOpen();
    var item = createCaptureItem(meta, dataUrl, noop, noop);
    if (!item.dataUrl) throw new Error("Cannot enqueue empty frame payload");
    if (this.captureQueue.length >= (this.captureQueueMax * 4)) {
      throw new Error("Frame capture queue overflow");
    }
    if (!this._canQueueCaptureItem(item)) {
      if (item.dropOnPressure) {
        this._registerDroppedItem(item, "capture-byte-cap");
        throw createSpoolDropError("Frame dropped due to spool byte cap");
      }
      throw new Error("Frame capture byte budget exceeded");
    }
    this.captureQueue.push(item);
    this.captureQueueBytes += Math.max(0, Number(item.estimatedBytes) || 0);
    this._updateQueueByteHighWater();
    this._schedulePump();
    return {
      frameId: item.frameId,
      sessionId: item.sessionId,
      mime: item.mime,
      createdAtMs: item.createdAtMs,
      width: item.width,
      height: item.height
    };
  };

  FrameSpoolService.prototype._schedulePump = function () {
    var self = this;
    if (self._pumpScheduled || self._closed) return;
    self._pumpScheduled = true;
    Promise.resolve().then(function () {
      self._pumpScheduled = false;
      self._pump().catch(function (err) {
        self._warnEvent("frame-spool:pump-error", { error: String((err && err.message) || err) });
      });
    });
  };

  FrameSpoolService.prototype._pump = async function () {
    this._drainCollector1();
    var collector2DidWork = await this._drainCollector2();
    await this._drainCollector3();
    if (this.captureQueue.length || this.processQueue.length || this.writeQueue.length) {
      if (
        this._decodeInflight.size &&
        this.processQueue.length &&
        !this.writeQueue.length &&
        !this._hasIdleDecodeWorker() &&
        !collector2DidWork
      ) {
        return;
      }
      this._schedulePump();
    }
  };

  FrameSpoolService.prototype._drainCollector1 = function () {
    while (this.captureQueue.length && this.processQueue.length < this.processQueueMax) {
      var candidate = this.captureQueue[0];
      var est = Math.max(0, Number(candidate && candidate.estimatedBytes) || 0);
      if ((this.processQueueBytes + est) > this.processQueueBytesCap) break;
      var item = this.captureQueue.shift();
      this.captureQueueBytes = Math.max(0, this.captureQueueBytes - est);
      this.processQueueBytes += est;
      this.processQueue.push(item);
    }
    this._updateQueueByteHighWater();
  };

  FrameSpoolService.prototype._drainCollector2 = async function () {
    if (this._collector2Running) return false;
    this._collector2Running = true;
    var didWork = false;
    try {
      var usingWorkerDecode = this._workersAvailable();
      if (usingWorkerDecode) {
        didWork = this._dispatchDecodeWork() || didWork;
        usingWorkerDecode = this._workersAvailable();
      }
      if (!usingWorkerDecode) {
        if (this.processQueue.length && this.writeQueue.length < this.writeQueueMax) {
          var item = this.processQueue.shift();
          var est = Math.max(0, Number(item && item.estimatedBytes) || 0);
          this.processQueueBytes = Math.max(0, this.processQueueBytes - est);
          var writeOverCap = (
            (this.writeQueueBytes + est) > this.writeQueueBytesCap ||
            this.writeQueue.length >= this.writeQueueMax
          );
          if (writeOverCap) {
            this.processQueue.unshift(item);
            this.processQueueBytes += est;
            await waitMs(COLLECTOR2_YIELD_MS);
            return didWork;
          }
          try {
            if (!item.frameId) item.frameId = createFrameId();
            this._decodeInlineItem(item);
          } catch (err) {
            item.reject(err);
            await waitMs(COLLECTOR2_YIELD_MS);
            return didWork;
          }
          this.writeQueue.push(item);
          this.writeQueueBytes += est;
          this._updateQueueByteHighWater();
          didWork = true;
          await waitMs(COLLECTOR2_YIELD_MS);
        }
      }
    } finally {
      this._collector2Running = false;
    }
    return didWork;
  };

  FrameSpoolService.prototype._drainCollector3 = async function () {
    if (this._collector3Running) return;
    this._collector3Running = true;
    try {
      var writesInBatch = 0;
      while (this.writeQueue.length) {
        var item = this.writeQueue.shift();
        var est = Math.max(0, Number(item && item.estimatedBytes) || 0);
        this.writeQueueBytes = Math.max(0, this.writeQueueBytes - est);
        try {
          var ref = await this._writeFrameItem(item);
          item.resolve(ref);
        } catch (err) {
          item.reject(err);
          this._warnEvent("frame-spool:write-error", { error: String((err && err.message) || err) });
        } finally {
          item.dataUrl = "";
          item.byteBuffer = null;
          item.byteLength = 0;
          item.meta = null;
        }
        writesInBatch += 1;
        if (writesInBatch >= COLLECTOR3_BATCH_SIZE) {
          writesInBatch = 0;
          await waitMs(COLLECTOR3_YIELD_MS);
        }
      }
      this._updateQueueByteHighWater();
    } finally {
      this._collector3Running = false;
    }
  };

  FrameSpoolService.prototype._writeFrameItem = async function (item) {
    var mime = String(item && item.mime || "").trim();
    if (!mime) mime = parseDataUrlMime(item && item.dataUrl, "image/png");
    if (!mime) mime = "image/png";

    var payloadBuffer = null;
    if (item && item.byteBuffer instanceof ArrayBuffer) {
      payloadBuffer = item.byteBuffer;
    } else if (item && item.dataUrl) {
      var decoded = dataUrlToBytes(item.dataUrl);
      payloadBuffer = decoded.bytes.buffer.slice(
        decoded.bytes.byteOffset,
        decoded.bytes.byteOffset + decoded.bytes.byteLength
      );
      if (!mime) mime = decoded.mime;
      item.dataUrl = "";
    }
    if (!(payloadBuffer instanceof ArrayBuffer)) {
      throw new Error("Frame payload is missing decode buffer");
    }
    var byteLength = payloadBuffer.byteLength;
    var blob = new Blob([payloadBuffer], { type: mime });

    var db = await this._openDb();
    var tx = db.transaction(
      [STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS],
      "readwrite"
    );
    var framesStore = tx.objectStore(STORES.FRAMES);
    var metaStore = tx.objectStore(STORES.FRAME_META);
    var sessionStore = tx.objectStore(STORES.SESSION_REFS);

    var createdAtMs = Number(item.createdAtMs) || nowMs();
    var frameRecord = {
      frameId: item.frameId,
      blob: blob,
      mime: mime,
      createdAtMs: createdAtMs,
      sessionId: item.sessionId || "",
      width: item.width,
      height: item.height
    };
    var metaRecord = {
      frameId: item.frameId,
      mime: mime,
      createdAtMs: createdAtMs,
      sessionId: item.sessionId || "",
      width: item.width,
      height: item.height,
      byteLength: byteLength
    };

    framesStore.put(frameRecord);
    metaStore.put(metaRecord);
    if (item.sessionId) {
      sessionStore.put({
        id: makeKey(item.sessionId, item.frameId),
        sessionId: item.sessionId,
        frameId: item.frameId,
        createdAtMs: createdAtMs
      });
    }

    await txDone(tx);
    this.stats.frameCount += 1;
    this.stats.totalBytes += metaRecord.byteLength;

    return {
      frameId: item.frameId,
      sessionId: item.sessionId || "",
      mime: mime,
      createdAtMs: createdAtMs,
      width: item.width,
      height: item.height
    };
  };

  FrameSpoolService.prototype.getFrameBlob = async function (frameId) {
    var key = String(frameId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAMES], "readonly");
    var store = tx.objectStore(STORES.FRAMES);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    return record.blob;
  };

  FrameSpoolService.prototype.getFrameDataUrl = async function (frameId) {
    var blob = await this.getFrameBlob(frameId);
    if (!blob) return "";
    return blobToDataUrl(blob);
  };

  FrameSpoolService.prototype.hasFrame = async function (frameId) {
    var key = String(frameId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAME_META], "readonly");
    var store = tx.objectStore(STORES.FRAME_META);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.waitForFrame = async function (frameId, options) {
    var key = String(frameId || "").trim();
    if (!key) return false;
    var opts = options || {};
    var timeoutMs = Math.max(50, Number(opts.timeoutMs) || 2000);
    var pollMs = Math.max(10, Number(opts.pollMs) || 80);
    var start = nowMs();
    while (true) {
      var exists = false;
      try {
        exists = await this.hasFrame(key);
      } catch (_) {
        exists = false;
      }
      if (exists) return true;
      if ((nowMs() - start) >= timeoutMs) return false;
      await waitMs(pollMs);
    }
  };

  FrameSpoolService.prototype.getFrameBytes = async function (frameId) {
    var blob = await this.getFrameBlob(frameId);
    if (!blob) return null;
    var buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.putFrameFromBytes = async function (ref, bytes) {
    var normalized = normalizeRef(ref, "");
    if (!normalized) throw new Error("Invalid frame ref");
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Frame payload is empty");

    var db = await this._openDb();
    var tx = db.transaction(
      [STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS],
      "readwrite"
    );
    var framesStore = tx.objectStore(STORES.FRAMES);
    var metaStore = tx.objectStore(STORES.FRAME_META);
    var sessionStore = tx.objectStore(STORES.SESSION_REFS);

    var blob = new Blob([payload], { type: normalized.mime || "image/png" });
    framesStore.put({
      frameId: normalized.frameId,
      blob: blob,
      mime: normalized.mime,
      createdAtMs: normalized.createdAtMs,
      sessionId: normalized.sessionId,
      width: normalized.width,
      height: normalized.height
    });
    metaStore.put({
      frameId: normalized.frameId,
      mime: normalized.mime,
      createdAtMs: normalized.createdAtMs,
      sessionId: normalized.sessionId,
      width: normalized.width,
      height: normalized.height,
      byteLength: payload.length
    });
    if (normalized.sessionId) {
      sessionStore.put({
        id: makeKey(normalized.sessionId, normalized.frameId),
        sessionId: normalized.sessionId,
        frameId: normalized.frameId,
        createdAtMs: normalized.createdAtMs
      });
    }

    await txDone(tx);
    return normalized;
  };

  FrameSpoolService.prototype.linkFrameToReport = async function (reportId, frameId) {
    var report = String(reportId || "").trim();
    var frame = String(frameId || "").trim();
    if (!report || !frame) return;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    tx.objectStore(STORES.REPORT_REFS).put({
      id: makeKey(report, frame),
      reportId: report,
      frameId: frame,
      createdAtMs: nowMs()
    });
    await txDone(tx);
  };

  FrameSpoolService.prototype.linkFramesToReport = async function (reportId, frameIds) {
    var report = String(reportId || "").trim();
    if (!report) return;
    var frames = uniqueStrings(frameIds);
    if (!frames.length) return;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var stamp = nowMs();
    frames.forEach(function (frameId) {
      store.put({
        id: makeKey(report, frameId),
        reportId: report,
        frameId: frameId,
        createdAtMs: stamp
      });
    });
    await txDone(tx);
  };

  FrameSpoolService.prototype.removeReportRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeReportTextRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeReportAudioRefs = async function (reportId) {
    var report = String(reportId || "").trim();
    if (!report) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_REPORT_REFS);
    var index = store.index("reportId");
    var removed = 0;
    await openCursorByIndex(index, report, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.removeSessionRefs = async function (sessionId) {
    var session = String(sessionId || "").trim();
    if (!session) return 0;
    var db = await this._openDb();
    var tx = db.transaction([STORES.SESSION_REFS], "readwrite");
    var store = tx.objectStore(STORES.SESSION_REFS);
    var index = store.index("sessionId");
    var removed = 0;
    await openCursorByIndex(index, session, function (_value, cursor) {
      cursor.delete();
      removed += 1;
    });
    await txDone(tx);
    return removed;
  };

  FrameSpoolService.prototype.getReportIds = async function () {
    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readonly");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var ids = new Set();
    await openCursorAll(store, function (value) {
      if (!value || !value.reportId) return;
      ids.add(String(value.reportId));
    });
    await txDone(tx);
    return Array.from(ids);
  };

  FrameSpoolService.prototype.syncReportRefs = async function (reportFrameMap) {
    var normalized = new Map();
    if (reportFrameMap instanceof Map) {
      reportFrameMap.forEach(function (frameIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(frameIds));
      });
    } else if (reportFrameMap && typeof reportFrameMap === "object") {
      Object.keys(reportFrameMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportFrameMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (frameIds, reportId) {
      frameIds.forEach(function (frameId) {
        desired.add(makeKey(reportId, frameId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var frameId = parts.join(":");
      store.put({ id: id, reportId: reportId, frameId: frameId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.syncReportTextRefs = async function (reportTextMap) {
    var normalized = new Map();
    if (reportTextMap instanceof Map) {
      reportTextMap.forEach(function (docIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(docIds));
      });
    } else if (reportTextMap && typeof reportTextMap === "object") {
      Object.keys(reportTextMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportTextMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (docIds, reportId) {
      docIds.forEach(function (docId) {
        desired.add(makeKey(reportId, docId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var docId = parts.join(":");
      store.put({ id: id, reportId: reportId, docId: docId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.syncReportAudioRefs = async function (reportAudioMap) {
    var normalized = new Map();
    if (reportAudioMap instanceof Map) {
      reportAudioMap.forEach(function (docIds, reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(docIds));
      });
    } else if (reportAudioMap && typeof reportAudioMap === "object") {
      Object.keys(reportAudioMap).forEach(function (reportId) {
        var report = String(reportId || "").trim();
        if (!report) return;
        normalized.set(report, uniqueStrings(reportAudioMap[reportId]));
      });
    }

    var desired = new Set();
    normalized.forEach(function (docIds, reportId) {
      docIds.forEach(function (docId) {
        desired.add(makeKey(reportId, docId));
      });
    });

    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_REPORT_REFS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_REPORT_REFS);
    var existingKeys = new Set();
    await openCursorAll(store, function (value, cursor) {
      var id = String((value && value.id) || cursor.key || "");
      if (!id) return;
      existingKeys.add(id);
      if (!desired.has(id)) cursor.delete();
    });

    var stamp = nowMs();
    desired.forEach(function (id) {
      if (existingKeys.has(id)) return;
      var parts = String(id).split(":");
      var reportId = parts.shift();
      var docId = parts.join(":");
      store.put({ id: id, reportId: reportId, docId: docId, createdAtMs: stamp });
    });

    await txDone(tx);
    return { reportCount: normalized.size, refCount: desired.size };
  };

  FrameSpoolService.prototype.putTextFromBytes = async function (ref, bytes, meta) {
    var inputRef = ref && typeof ref === "object" ? ref : {};
    var docId = String(inputRef.docId || "").trim() || createTextDocId();
    var mime = String(inputRef.mime || "text/plain").trim() || "text/plain";
    var createdAtMs = Number(inputRef.createdAtMs) || nowMs();
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Text payload is empty");
    var details = meta && typeof meta === "object" ? meta : {};
    var fileName = String(details.fileName || "").trim();
    var fileType = String(details.fileType || "").trim();
    var preview = String(details.preview || "").slice(0, 240);

    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readwrite");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    store.put({
      docId: docId,
      blob: new Blob([payload], { type: mime }),
      mime: mime,
      createdAtMs: createdAtMs,
      byteLength: payload.length,
      fileName: fileName,
      fileType: fileType,
      preview: preview
    });
    await txDone(tx);

    return {
      docId: docId,
      mime: mime,
      byteLength: payload.length,
      createdAtMs: createdAtMs
    };
  };

  FrameSpoolService.prototype.putAudioFromBytes = async function (ref, bytes, meta) {
    var inputRef = ref && typeof ref === "object" ? ref : {};
    var docId = String(inputRef.docId || "").trim() || createAudioDocId();
    var mime = String(inputRef.mime || "audio/mpeg").trim() || "audio/mpeg";
    var createdAtMs = Number(inputRef.createdAtMs) || nowMs();
    var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!payload.length) throw new Error("Audio payload is empty");
    var details = meta && typeof meta === "object" ? meta : {};
    var fileName = String(details.fileName || "").trim();
    var fileType = String(details.fileType || "").trim();
    var preview = String(details.preview || "").slice(0, 240);

    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readwrite");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    store.put({
      docId: docId,
      blob: new Blob([payload], { type: mime }),
      mime: mime,
      createdAtMs: createdAtMs,
      byteLength: payload.length,
      fileName: fileName,
      fileType: fileType,
      preview: preview
    });
    await txDone(tx);

    return {
      docId: docId,
      mime: mime,
      byteLength: payload.length,
      createdAtMs: createdAtMs
    };
  };

  FrameSpoolService.prototype.getTextBytes = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    var buffer = await record.blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.getAudioBytes = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record || !record.blob) return null;
    var buffer = await record.blob.arrayBuffer();
    return new Uint8Array(buffer);
  };

  FrameSpoolService.prototype.hasTextDoc = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.hasAudioDoc = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return false;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    return !!record;
  };

  FrameSpoolService.prototype.getTextDocMeta = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.TEXT_DOCS], "readonly");
    var store = tx.objectStore(STORES.TEXT_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record) return null;
    return {
      docId: key,
      mime: String(record.mime || "text/plain"),
      byteLength: Number(record.byteLength) || 0,
      createdAtMs: Number(record.createdAtMs) || 0,
      fileName: String(record.fileName || ""),
      fileType: String(record.fileType || ""),
      preview: String(record.preview || "")
    };
  };

  FrameSpoolService.prototype.getAudioDocMeta = async function (docId) {
    var key = String(docId || "").trim();
    if (!key) return null;
    var db = await this._openDb();
    var tx = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var store = tx.objectStore(STORES.AUDIO_DOCS);
    var record = await requestToPromise(store.get(key));
    await txDone(tx);
    if (!record) return null;
    return {
      docId: key,
      mime: String(record.mime || "audio/mpeg"),
      byteLength: Number(record.byteLength) || 0,
      createdAtMs: Number(record.createdAtMs) || 0,
      fileName: String(record.fileName || ""),
      fileType: String(record.fileType || ""),
      preview: String(record.preview || "")
    };
  };

  FrameSpoolService.prototype.refreshStats = async function () {
    var db = await this._openDb();
    var tx = db.transaction([STORES.FRAME_META], "readonly");
    var store = tx.objectStore(STORES.FRAME_META);
    var frameCount = 0;
    var totalBytes = 0;
    await openCursorAll(store, function (value) {
      frameCount += 1;
      totalBytes += Number((value && value.byteLength) || 0);
    });
    await txDone(tx);
    this.stats.frameCount = frameCount;
    this.stats.totalBytes = totalBytes;
    return {
      frameCount: frameCount,
      totalBytes: totalBytes
    };
  };

  FrameSpoolService.prototype._deleteFrameAndRefs = function (tx, frameId) {
    var frameKey = String(frameId || "").trim();
    if (!frameKey) return;
    tx.objectStore(STORES.FRAMES).delete(frameKey);
    tx.objectStore(STORES.FRAME_META).delete(frameKey);

    var sessionStore = tx.objectStore(STORES.SESSION_REFS);
    var sessionIndex = sessionStore.index("frameId");
    var reportStore = tx.objectStore(STORES.REPORT_REFS);
    var reportIndex = reportStore.index("frameId");

    sessionIndex.openCursor(IDBKeyRange.only(frameKey)).onsuccess = function (event) {
      var cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    reportIndex.openCursor(IDBKeyRange.only(frameKey)).onsuccess = function (event) {
      var cursor = event.target.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
  };

  FrameSpoolService.prototype.gc = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(64 * 1024 * 1024, Number(opts.maxBytes) || (1536 * 1024 * 1024));
    var activeSessions = new Set(uniqueStrings(opts.activeSessionIds));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.FRAME_META, STORES.REPORT_REFS, STORES.SESSION_REFS], "readonly");
    var metaStore = txRead.objectStore(STORES.FRAME_META);
    var reportStore = txRead.objectStore(STORES.REPORT_REFS);
    var sessionStore = txRead.objectStore(STORES.SESSION_REFS);

    var metas = [];
    var keepFrameIds = new Set();

    await openCursorAll(metaStore, function (value) {
      if (!value || !value.frameId) return;
      metas.push({
        frameId: String(value.frameId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });

    await openCursorAll(reportStore, function (value) {
      if (!value || !value.frameId) return;
      keepFrameIds.add(String(value.frameId));
    });

    var sessionIndex = sessionStore.index("sessionId");
    var sessionTasks = [];
    activeSessions.forEach(function (sessionId) {
      sessionTasks.push(openCursorByIndex(sessionIndex, sessionId, function (value) {
        if (!value || !value.frameId) return;
        keepFrameIds.add(String(value.frameId));
      }));
    });
    await Promise.all(sessionTasks);
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = metas.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = metas
      .filter(function (item) {
        if (keepFrameIds.has(item.frameId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropFrameIds = [];
    var dropFrameIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropFrameIdSet.has(item.frameId)) return;
      dropFrameIds.push(item.frameId);
      dropFrameIdSet.add(item.frameId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = metas
        .filter(function (item) {
          return !keepFrameIds.has(item.frameId) && !dropFrameIdSet.has(item.frameId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropFrameIdSet.has(candidate.frameId)) continue;
        dropFrameIds.push(candidate.frameId);
        dropFrameIdSet.add(candidate.frameId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropFrameIds.length) {
      var txWrite = db.transaction([STORES.FRAMES, STORES.FRAME_META, STORES.SESSION_REFS, STORES.REPORT_REFS], "readwrite");
      for (var j = 0; j < dropFrameIds.length; j++) {
        this._deleteFrameAndRefs(txWrite, dropFrameIds[j]);
      }
      await txDone(txWrite);
    }

    var stats = await this.refreshStats();
    var result = {
      deletedFrameCount: dropFrameIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: stats.totalBytes,
      frameCountAfter: stats.frameCount,
      maxBytes: maxBytes
    };
    this.stats.lastGcAtMs = nowMs();
    this._logEvent("frame-spool:gc", result);
    return result;
  };

  FrameSpoolService.prototype.gcText = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(8 * 1024 * 1024, Number(opts.maxBytes) || (256 * 1024 * 1024));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.TEXT_DOCS, STORES.TEXT_REPORT_REFS], "readonly");
    var docsStore = txRead.objectStore(STORES.TEXT_DOCS);
    var refsStore = txRead.objectStore(STORES.TEXT_REPORT_REFS);

    var docs = [];
    var keepDocIds = new Set();
    await openCursorAll(docsStore, function (value) {
      if (!value || !value.docId) return;
      docs.push({
        docId: String(value.docId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });
    await openCursorAll(refsStore, function (value) {
      if (!value || !value.docId) return;
      keepDocIds.add(String(value.docId));
    });
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = docs.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = docs
      .filter(function (item) {
        if (keepDocIds.has(item.docId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropDocIds = [];
    var dropDocIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropDocIdSet.has(item.docId)) return;
      dropDocIds.push(item.docId);
      dropDocIdSet.add(item.docId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = docs
        .filter(function (item) {
          return !keepDocIds.has(item.docId) && !dropDocIdSet.has(item.docId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropDocIdSet.has(candidate.docId)) continue;
        dropDocIds.push(candidate.docId);
        dropDocIdSet.add(candidate.docId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropDocIds.length) {
      var txWrite = db.transaction([STORES.TEXT_DOCS, STORES.TEXT_REPORT_REFS], "readwrite");
      var docsWrite = txWrite.objectStore(STORES.TEXT_DOCS);
      var refsWrite = txWrite.objectStore(STORES.TEXT_REPORT_REFS);
      var refsIdx = refsWrite.index("docId");
      for (var j = 0; j < dropDocIds.length; j++) {
        var docId = dropDocIds[j];
        docsWrite.delete(docId);
        refsIdx.openCursor(IDBKeyRange.only(docId)).onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      await txDone(txWrite);
    }

    var txStats = db.transaction([STORES.TEXT_DOCS], "readonly");
    var docsStats = txStats.objectStore(STORES.TEXT_DOCS);
    var byteAfter = 0;
    var docCountAfter = 0;
    await openCursorAll(docsStats, function (value) {
      docCountAfter += 1;
      byteAfter += Number((value && value.byteLength) || 0);
    });
    await txDone(txStats);

    return {
      deletedTextDocCount: dropDocIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: byteAfter,
      textDocCountAfter: docCountAfter,
      maxBytes: maxBytes
    };
  };

  FrameSpoolService.prototype.gcAudio = async function (options) {
    var opts = options || {};
    var orphanMaxAgeMs = Math.max(60 * 1000, Number(opts.orphanMaxAgeMs) || (24 * 60 * 60 * 1000));
    var maxBytes = Math.max(8 * 1024 * 1024, Number(opts.maxBytes) || (256 * 1024 * 1024));

    var db = await this._openDb();
    var txRead = db.transaction([STORES.AUDIO_DOCS, STORES.AUDIO_REPORT_REFS], "readonly");
    var docsStore = txRead.objectStore(STORES.AUDIO_DOCS);
    var refsStore = txRead.objectStore(STORES.AUDIO_REPORT_REFS);

    var docs = [];
    var keepDocIds = new Set();
    await openCursorAll(docsStore, function (value) {
      if (!value || !value.docId) return;
      docs.push({
        docId: String(value.docId),
        createdAtMs: Number(value.createdAtMs) || 0,
        byteLength: Number(value.byteLength) || 0
      });
    });
    await openCursorAll(refsStore, function (value) {
      if (!value || !value.docId) return;
      keepDocIds.add(String(value.docId));
    });
    await txDone(txRead);

    var now = nowMs();
    var bytesBefore = docs.reduce(function (sum, item) { return sum + item.byteLength; }, 0);
    var orphanCandidates = docs
      .filter(function (item) {
        if (keepDocIds.has(item.docId)) return false;
        return (now - item.createdAtMs) >= orphanMaxAgeMs;
      })
      .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });

    var dropDocIds = [];
    var dropDocIdSet = new Set();
    var bytesPlannedDrop = 0;
    orphanCandidates.forEach(function (item) {
      if (dropDocIdSet.has(item.docId)) return;
      dropDocIds.push(item.docId);
      dropDocIdSet.add(item.docId);
      bytesPlannedDrop += item.byteLength;
    });

    var bytesAfterAgeDrop = Math.max(0, bytesBefore - bytesPlannedDrop);
    if (bytesAfterAgeDrop > maxBytes) {
      var remainingOrphans = docs
        .filter(function (item) {
          return !keepDocIds.has(item.docId) && !dropDocIdSet.has(item.docId);
        })
        .sort(function (a, b) { return a.createdAtMs - b.createdAtMs; });
      for (var i = 0; i < remainingOrphans.length && bytesAfterAgeDrop > maxBytes; i++) {
        var candidate = remainingOrphans[i];
        if (dropDocIdSet.has(candidate.docId)) continue;
        dropDocIds.push(candidate.docId);
        dropDocIdSet.add(candidate.docId);
        bytesAfterAgeDrop -= candidate.byteLength;
      }
    }

    if (dropDocIds.length) {
      var txWrite = db.transaction([STORES.AUDIO_DOCS, STORES.AUDIO_REPORT_REFS], "readwrite");
      var docsWrite = txWrite.objectStore(STORES.AUDIO_DOCS);
      var refsWrite = txWrite.objectStore(STORES.AUDIO_REPORT_REFS);
      var refsIdx = refsWrite.index("docId");
      for (var j = 0; j < dropDocIds.length; j++) {
        var docId = dropDocIds[j];
        docsWrite.delete(docId);
        refsIdx.openCursor(IDBKeyRange.only(docId)).onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      await txDone(txWrite);
    }

    var txStats = db.transaction([STORES.AUDIO_DOCS], "readonly");
    var docsStats = txStats.objectStore(STORES.AUDIO_DOCS);
    var byteAfter = 0;
    var docCountAfter = 0;
    await openCursorAll(docsStats, function (value) {
      docCountAfter += 1;
      byteAfter += Number((value && value.byteLength) || 0);
    });
    await txDone(txStats);

    return {
      deletedAudioDocCount: dropDocIds.length,
      orphanCount: orphanCandidates.length,
      bytesBefore: bytesBefore,
      bytesAfter: byteAfter,
      audioDocCountAfter: docCountAfter,
      maxBytes: maxBytes
    };
  };

  FrameSpoolService.prototype.close = async function () {
    if (this._closed) return;
    var db = null;
    try { db = await this._openDb(); } catch (_) { db = null; }
    this._closed = true;
    this._teardownDecodeWorkers("close");
    if (db) {
      try { db.close(); } catch (_) {}
    }
    this._dbPromise = null;
    this.captureQueue.length = 0;
    this.processQueue.length = 0;
    this.writeQueue.length = 0;
    this.captureQueueBytes = 0;
    this.processQueueBytes = 0;
    this.writeQueueBytes = 0;
    this.queueBytesHighWater = 0;
    this.droppedFrames = 0;
    this.lastDropReason = null;
  };

  global.UIRFrameSpool = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORES: STORES,
    createService: function (options) {
      return new FrameSpoolService(options || {});
    },
    dataUrlToBlob: dataUrlToBlob,
    bytesToDataUrl: bytesToDataUrl
  };
})(typeof self !== "undefined" ? self : window);
