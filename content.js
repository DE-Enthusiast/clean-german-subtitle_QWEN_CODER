let currentSubtitles = [];
let stitchedSegments = [];
let translations = [];

let processedVideoId = null;
let activeRequestId = null;
let pendingVideoId = null;

let activePort = null;
let portPingInterval = null;
let workerListener = null;
let watchdogId = null;

let syncFrameId = null;
let activeSubtitleIndex = -1;

function isExtensionContextValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

function decodeHtml(str) {
  if (!str) return "";
  try {
    const doc = new DOMParser().parseFromString(str, "text/html");
    return doc.body.textContent || str;
  } catch (_) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&auml;/g, "ä")
      .replace(/&ouml;/g, "ö")
      .replace(/&uuml;/g, "ü")
      .replace(/&szlig;/g, "ß")
      .replace(/&Auml;/g, "Ä")
      .replace(/&Ouml;/g, "Ö")
      .replace(/&Uuml;/g, "Ü");
  }
}

function getSoundEffectTranslation(text) {
  const t = String(text || "").trim();
  if (/^([|()(musik|music)(]|))$/i.test(t)) return "[Music]";
  if (/^([|()(applaus|applause|beifall)(]|))$/i.test(t)) return "[Applause]";
  if (/^([|()(lachen|gelächter|laughter)(]|))$/i.test(t)) return "[Laughter]";
  if (/^([|()(stille|silence)(]|))$/i.test(t)) return "[Silence]";
  if (/^([|()(seufzen|sigh)(]|))$/i.test(t)) return "[Sigh]";
  return null;
}

function parseRawCaptionsPayload(raw) {
  const trimmed = String(raw || "").trim();
  const events = [];

  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);

      for (const ev of data.events || []) {
        if (!ev.segs) continue;

        const startMs = Number(ev.tStartMs);
        if (!Number.isFinite(startMs)) continue;

        const text = ev.segs.map((s) => s.utf8 || "").join("").trim();

        if (text) {
          events.push({
            tStartMs: startMs,
            dDurationMs: Number(ev.dDurationMs) || 2000,
            text
          });
        }
      }

      if (events.length > 0) return events;
    } catch (_) {}
  }

  const textRegex =
    /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>(.*?)<\/text>/gis;

  let match;
  while ((match = textRegex.exec(trimmed)) !== null) {
    const startSec = parseFloat(match[1]);
    const durSec = match[2] ? parseFloat(match[2]) : 2.0;
    const cleanText = decodeHtml(match[3].replace(/<[^>]+>/g, "").trim());

    if (cleanText) {
      events.push({
        tStartMs: Math.round(startSec * 1000),
        dDurationMs: Math.round(durSec * 1000),
        text: cleanText
      });
    }
  }

  if (events.length > 0) return events;

  const pRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>(.*?)<\/p>/gis;
  while ((match = pRegex.exec(trimmed)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durMs = match[2] ? parseInt(match[2], 10) : 2000;
    const cleanText = decodeHtml(match[3].replace(/<[^>]+>/g, "").trim());

    if (cleanText) {
      events.push({
        tStartMs: startMs,
        dDurationMs: durMs,
        text: cleanText
      });
    }
  }

  return events;
}

function stitchGermanSegments(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];

  const stitched = [];
  let buffer = null;

  const MAX_GAP_MS = 450;
  const MAX_WORDS = 14;
  const END_TAIL_MS = 60;

  const sorted = [...rawEvents].sort(
    (a, b) => (Number(a.tStartMs) || 0) - (Number(b.tStartMs) || 0)
  );

  for (const item of sorted) {
    const text = String(item.text || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const start = Math.max(0, Number(item.tStartMs) || 0);

    let duration = Number(item.dDurationMs);
    if (!Number.isFinite(duration) || duration < 250) duration = 2000;
    if (duration > 20000) duration = 20000;

    const end = start + duration;

    if (!buffer) {
      buffer = { text, startMs: start, endMs: end };
      continue;
    }

    const pauseDuration = start - buffer.endMs;
    const endsWithTerminal = /[.!?…]$/.test(buffer.text);
    const wordCount = buffer.text.split(/\s+/).length;

    if (pauseDuration > MAX_GAP_MS || endsWithTerminal || wordCount >= MAX_WORDS) {
      buffer.endMs = Math.max(buffer.startMs + 250, buffer.endMs - END_TAIL_MS);
      stitched.push(buffer);

      buffer = { text, startMs: start, endMs: end };
      continue;
    }

    buffer.text += " " + text;
    buffer.endMs = Math.max(buffer.endMs, end);
  }

  if (buffer) {
    buffer.endMs = Math.max(buffer.startMs + 250, buffer.endMs - END_TAIL_MS);
    stitched.push(buffer);
  }

  return stitched;
}

let currentFontSize = "normal";

if (isExtensionContextValid()) {
  try {
    chrome.storage.local.get(["fontSize"], (res) => {
      if (res?.fontSize) currentFontSize = res.fontSize;
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.fontSize?.newValue) {
        currentFontSize = changes.fontSize.newValue;
        const c = document.getElementById("clean-subs-container");
        if (c) c.className = `font-${currentFontSize}`;
      }
    });
  } catch (_) {}
}

function ensureOverlay() {
  const playerContainer = document.querySelector(".html5-video-player");
  if (!playerContainer) return null;

  let container = document.getElementById("clean-subs-container");
  let text = document.getElementById("clean-subs-text");

  if (!container || !container.isConnected) {
    container = document.createElement("div");
    container.id = "clean-subs-container";
    container.className = `font-${currentFontSize}`;

    text = document.createElement("span");
    text.id = "clean-subs-text";

    container.appendChild(text);
    playerContainer.appendChild(container);
  } else {
    container.className = `font-${currentFontSize}`;
    if (!text || !text.isConnected) {
      text = document.createElement("span");
      text.id = "clean-subs-text";
      container.appendChild(text);
    }
  }

  return text;
}

function hideOverlay() {
  const text = document.getElementById("clean-subs-text");
  if (text) text.style.display = "none";
}

function rebuildSubtitles() {
  currentSubtitles = stitchedSegments.map((segment, idx) => {
    const translated =
      typeof translations[idx] === "string" ? translations[idx].trim() : "";

    return {
      start: segment.startMs / 1000,
      end: segment.endMs / 1000,
      text: translated || segment.text
    };
  });

  currentSubtitles.sort((a, b) => a.start - b.start);
  activeSubtitleIndex = -1;

  startSyncLoop();
}

function startSyncLoop() {
  if (!syncFrameId) {
    syncFrameId = requestAnimationFrame(syncPlaybackLoop);
  }
}

function stopSyncLoop() {
  if (syncFrameId) {
    cancelAnimationFrame(syncFrameId);
  }
  syncFrameId = null;
  activeSubtitleIndex = -1;
}

function findSubtitleIndex(time) {
  if (!currentSubtitles.length || !Number.isFinite(time)) return -1;

  let lo = 0;
  let hi = currentSubtitles.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;

    if (currentSubtitles[mid].start <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (result < 0) return -1;

  const cue = currentSubtitles[result];
  if (time <= cue.end) return result;

  const next = currentSubtitles[result + 1];
  if (next && time >= next.start && time <= next.end) return result + 1;

  return -1;
}

function syncPlaybackLoop() {
  syncFrameId = null;

  if (!isExtensionContextValid()) {
    cleanupJob();
    hideOverlay();
    return;
  }

  try {
    if (!currentSubtitles.length) {
      hideOverlay();
      return;
    }

    const textNode = ensureOverlay();
    const video = document.querySelector("video");

    if (!textNode || !video) {
      syncFrameId = requestAnimationFrame(syncPlaybackLoop);
      return;
    }

    const now = Number(video.currentTime || 0) + 0.08;
    const nextIndex = findSubtitleIndex(now);

    if (nextIndex !== activeSubtitleIndex) {
      activeSubtitleIndex = nextIndex;

      if (nextIndex >= 0) {
        textNode.textContent = currentSubtitles[nextIndex].text;
        textNode.style.display = "inline-block";
      } else {
        textNode.style.display = "none";
      }
    }
  } catch (_) {}

  syncFrameId = requestAnimationFrame(syncPlaybackLoop);
}

function cleanupJob() {
  if (watchdogId) {
    clearTimeout(watchdogId);
    watchdogId = null;
  }

  if (portPingInterval) {
    clearInterval(portPingInterval);
    portPingInterval = null;
  }

  if (workerListener) {
    try {
      chrome.runtime.onMessage.removeListener(workerListener);
    } catch (_) {}
    workerListener = null;
  }

  if (activePort) {
    try {
      activePort.disconnect();
    } catch (_) {}
    activePort = null;
  }

  activeRequestId = null;
  pendingVideoId = null;
}

function setupKeepAlivePort() {
  if (portPingInterval) clearInterval(portPingInterval);

  try {
    activePort = chrome.runtime.connect({ name: "clean-subs-keepalive" });

    portPingInterval = setInterval(() => {
      if (activePort) {
        try {
          activePort.postMessage({ type: "PING" });
        } catch (_) {
          clearInterval(portPingInterval);
        }
      }
    }, 20000);

    activePort.onDisconnect.addListener(() => {
      clearInterval(portPingInterval);
      activePort = null;
      console.debug("[CleanSubs] Keepalive port disconnected.");
    });
  } catch (err) {
    activePort = null;
  }
}

function armWatchdog(ms = 300000) {
  if (watchdogId) clearTimeout(watchdogId);

  watchdogId = setTimeout(() => {
    if (!activeRequestId) return;

    console.warn(`[CleanSubs] Health check probe: verifying worker connection...`);

    if (activePort) {
      try {
        activePort.postMessage({ type: "PING" });
        armWatchdog(180000);
        return;
      } catch (_) {}
    }

    setupKeepAlivePort();
    armWatchdog(180000);
  }, ms);
}

async function handleEventsPipeline(incomingEvents, videoId, source) {
  if (!isExtensionContextValid()) {
    console.debug("[CleanSubs] Extension context is no longer valid; refresh tab.");
    return;
  }

  if (!videoId) return;

  const isContinuation = (videoId === processedVideoId || videoId === pendingVideoId);

  if (!isContinuation && activeRequestId) {
    cleanupJob();
    stitchedSegments = [];
    translations = [];
  }

  let eventsToProcess = incomingEvents;

  if (isContinuation && stitchedSegments.length > 0) {
    const existingStartTimes = new Set(stitchedSegments.map((s) => s.startMs));
    eventsToProcess = incomingEvents.filter((ev) => !existingStartTimes.has(ev.tStartMs));

    if (!eventsToProcess.length) {
      return;
    }
  }

  const stitched = stitchGermanSegments(eventsToProcess);
  if (!stitched.length) return;

  if (isContinuation && stitchedSegments.length > 0) {
    stitchedSegments = stitchedSegments.concat(stitched);
    for (let i = 0; i < stitched.length; i++) {
      translations.push(undefined);
    }
    console.log(
      `[CleanSubs] Appended ${stitched.length} new cues for extended video (${stitchedSegments.length} total).`
    );
  } else {
    stitchedSegments = stitched;
    translations = new Array(stitched.length);
  }

  // Instant sound effect pre-translation (saves tokens and avoids rate limits)
  for (let i = 0; i < stitchedSegments.length; i++) {
    if (!translations[i]) {
      const fx = getSoundEffectTranslation(stitchedSegments[i].text);
      if (fx) translations[i] = fx;
    }
  }

  const rawTexts = stitchedSegments.map((s) => s.text);
  const requestId = `${videoId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  activeRequestId = requestId;
  pendingVideoId = videoId;

  rebuildSubtitles();

  if (!workerListener) {
    workerListener = (message) => {
      if (!message || message.requestId !== activeRequestId) return;

      if (message.type === "TRANSLATION_PROGRESS") {
        const indexes = Array.isArray(message.indexes) ? message.indexes : [];
        const incoming = Array.isArray(message.translations) ? message.translations : [];

        for (let i = 0; i < indexes.length; i++) {
          const idx = Number(indexes[i]);
          if (Number.isInteger(idx) && idx >= 0 && idx < translations.length) {
            const value = String(incoming[i] ?? "").trim();
            if (value) translations[idx] = value;
          }
        }

        rebuildSubtitles();
        armWatchdog(300000);

        if (message.complete) {
          processedVideoId = pendingVideoId;
          console.log(
            `[CleanSubs] Translation complete: ${translations.filter(Boolean).length}/${stitchedSegments.length} cues ready.`
          );
        }
        return;
      }

      if (message.type === "TRANSLATION_ERROR") {
        console.warn("[CleanSubs] Translation error:", message.error || "Gemini error");
        processedVideoId = pendingVideoId;
        cleanupJob();
      }
    };

    try {
      chrome.runtime.onMessage.addListener(workerListener);
    } catch (err) {
      console.debug("[CleanSubs] Could not attach runtime listener:", err);
      cleanupJob();
      return;
    }
  }

  setupKeepAlivePort();
  armWatchdog(300000);

  const videoElem = document.querySelector("video");
  const currentPlaybackSec = Number(videoElem?.currentTime || 0);

  try {
    chrome.runtime.sendMessage(
      {
        action: "TRANSLATE_BATCH",
        requestId,
        videoId,
        texts: rawTexts,
        currentPlaybackSec
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.debug("[CleanSubs] Worker start message failed:", err.message);
          return;
        }

        if (!response || response.accepted === false) {
          console.warn("[CleanSubs] Translation job rejected:", response?.error);
          if (activeRequestId === requestId) {
            processedVideoId = videoId;
            cleanupJob();
          }
          return;
        }

        armWatchdog(300000);
      }
    );
  } catch (err) {
    console.debug("[CleanSubs] Extension context error on sendMessage:", err);
    cleanupJob();
  }
}

document.addEventListener("yt-navigate-start", () => {
  cleanupJob();
  currentSubtitles = [];
  stitchedSegments = [];
  translations = [];
  processedVideoId = null;

  stopSyncLoop();
  hideOverlay();
});

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.__cleanSubs !== true) {
    return;
  }

  try {
    const msg = event.data;

    if (msg.type === "EVENTS") {
      const payload = msg.payload || {};
      if (Array.isArray(payload.events) && payload.videoId) {
        handleEventsPipeline(payload.events, payload.videoId, payload.source || "events");
      }
    } else if (msg.type === "RAW_PAYLOAD") {
      const payload = msg.payload || {};
      const videoId = payload.videoId || new URLSearchParams(window.location.search).get("v");
      if (!videoId || !payload.rawBody) return;

      const parsedEvents = parseRawCaptionsPayload(payload.rawBody);
      if (parsedEvents.length > 0) {
        handleEventsPipeline(parsedEvents, videoId, payload.source || "raw");
      }
    }
  } catch (_) {}
});

window.postMessage({ __cleanSubsClientReady: true }, "*");