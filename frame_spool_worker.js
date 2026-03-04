(function () {
  "use strict";

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

  function decodeDataUrlParser(rawInput) {
    var parsed = parseDataUrl(rawInput);
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

  async function decodeDataUrl(rawInput) {
    var parsed = parseDataUrl(rawInput);
    try {
      var response = await fetch(parsed.raw);
      if (!response || !response.ok) throw new Error("fetch-decode-failed");
      var blob = await response.blob();
      var buffer = await blob.arrayBuffer();
      return {
        mime: String(blob.type || parsed.mime || "image/png").trim() || "image/png",
        buffer: buffer,
        byteLength: buffer.byteLength
      };
    } catch (_) {
      var fallback = decodeDataUrlParser(parsed.raw);
      var fallbackBuffer = fallback.bytes.buffer.slice(
        fallback.bytes.byteOffset,
        fallback.bytes.byteOffset + fallback.bytes.byteLength
      );
      return {
        mime: String(fallback.mime || parsed.mime || "image/png").trim() || "image/png",
        buffer: fallbackBuffer,
        byteLength: fallback.bytes.byteLength
      };
    }
  }

  self.onmessage = async function (event) {
    var msg = event && event.data ? event.data : null;
    if (!msg || msg.type !== "decodeBatch") return;

    var batchId = String(msg.batchId || "").trim();
    if (!batchId) return;

    var frames = Array.isArray(msg.frames) ? msg.frames : [];
    var outFrames = [];
    var transferables = [];

    try {
      for (var i = 0; i < frames.length; i++) {
        var frame = frames[i] || {};
        var frameId = String(frame.frameId || "").trim();
        if (!frameId) continue;

        var decoded = await decodeDataUrl(frame.dataUrl);
        var meta = frame.meta && typeof frame.meta === "object" ? frame.meta : null;
        var resolvedMime = String((meta && meta.mime) || decoded.mime || "image/png").trim() || "image/png";
        outFrames.push({
          frameId: frameId,
          mime: resolvedMime,
          byteLength: Number(decoded.byteLength) || decoded.buffer.byteLength || 0,
          buffer: decoded.buffer,
          meta: meta
        });
        transferables.push(decoded.buffer);
      }

      self.postMessage({
        type: "decodeBatchResult",
        batchId: batchId,
        frames: outFrames
      }, transferables);
    } catch (err) {
      var failedFrameIds = frames.map(function (frame) {
        return String(frame && frame.frameId || "").trim();
      }).filter(function (frameId) {
        return !!frameId;
      });
      self.postMessage({
        type: "decodeBatchError",
        batchId: batchId,
        error: String((err && err.message) || err || "decode-batch-failed"),
        failedFrameIds: failedFrameIds
      });
    }
  };
})();
