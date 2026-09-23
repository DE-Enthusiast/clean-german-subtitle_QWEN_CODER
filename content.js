let currentSubtitles = [];
let stitchedSegments = [];
let translations = [];

let processedVideoId = null;
let activeRequestId = null;
let pendingVideoId = null;
let lastSentCount = 0;

let activePort = null;
let portPingInterval = null;
let workerListener = null;
let watchdogId = null;
let lastProgressAt = 0;

let syncFrameId = null;
let syncTimerId = null;
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

// The previous regexes used a character class instead of an alternation group
// (e.g. [|()(musik|music)(]|) matches single characters, never "[Musik]"),
// so sound-effect cues were never pre-translated and wasted API quota.
const SOUND_EFFECT_PATTERNS = [
  { re: /^\s*[[(]\s*(musik|music)\s*[\])]\s*$/i, out: "[Music]" },
  { re: /^\s*[[(]\s*(applaus|applause|beifall)\s*[\])]\s*$/i, out: "[Applause]" },
  { re: /^\s*[[(]\s*(lachen|gelächter|laughter)\s*[\])]\s*$/i, out: "[Laughter]" },
  { re: /^\s*[[(]\s*(stille|silence)\s*[\])]\s*$/i, out: "[Silence]" },
  { re: /^\s*[[(]\s*(seufzen|sigh)\s*[\])]\s*$/i, out: "[Sigh]" }
];

function getSoundEffectTranslation(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  for (const { re, out } of SOUND_EFFECT_PATTERNS) {
    if (re.test(t)) return out;
  }
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
  // stitchedSegments is already time-ordered (stitch sorts, continuations
  // append newer chunks), so no re-sort is needed. Previously every progress
  // message rebuilt and re-sorted the entire array — O(n log n) per message,
  // O(n² log n) across a long video. Now we do one cheap linear pass that
  // updates only cues whose text actually changed (which is at most the cues
  // touched by the latest progress message).
  const len = stitchedSegments.length;

  if (currentSubtitles.length !== len) {
    currentSubtitles.length = len;
  }

  for (let i = 0; i < len; i++) {
    const segment = stitchedSegments[i];
    const start = segment.startMs / 1000;
    const end = segment.endMs / 1000;
    const translated =
      typeof translations[i] === "string" ? translations[i].trim() : "";
    const text = translated || segment.text;
    const cue = currentSubtitles[i];

    if (!cue || cue.text !== text || cue.start !== start || cue.end !== end) {
      currentSubtitles[i] = { start, end, text };
      if (i === activeSubtitleIndex) {
        const textNode = getCachedTextNode();
        if (textNode) textNode.textContent = text;
      }
    }
  }

  startSyncLoop();
}

function startSyncLoop() {
  // Subtitle timing granularity of ~100ms is plenty; a perpetual 60fps rAF
  // loop with per-frame DOM queries burned CPU continuously. rAF also pauses
  // in background tabs, which a setInterval does not — better behavior here.
  if (syncFrameId == null && syncTimerId == null) {
    syncTimerId = setInterval(syncPlaybackTick, 100);
  }
}

function stopSyncLoop() {
  if (syncFrameId != null) {
    cancelAnimationFrame(syncFrameId);
    syncFrameId = null;
  }
  if (syncTimerId != null) {
    clearInterval(syncTimerId);
    syncTimerId = null;
  }
  activeSubtitleIndex = -1;
  overlayTextEl = null;
  videoEl = null;
}

let overlayTextEl = null;
let videoEl = null;

function getCachedTextNode() {
  if (overlayTextEl && overlayTextEl.isConnected) return overlayTextEl;
  overlayTextEl = ensureOverlay();
  return overlayTextEl;
}

function getCachedVideo() {
  if (videoEl && videoEl.isConnected) return videoEl;
  videoEl = document.querySelector("video");
  return videoEl;
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

function syncPlaybackTick() {
  if (!isExtensionContextValid()) {
    cleanupJob();
    stopSyncLoop();
    hideOverlay();
    return;
  }

  try {
    if (!currentSubtitles.length) {
      hideOverlay();
      return;
    }

    const video = getCachedVideo();
    if (!video) {
      hideOverlay();
      return;
    }

    const now = Number(video.currentTime || 0) + 0.08;
    const nextIndex = findSubtitleIndex(now);

    if (nextIndex === activeSubtitleIndex) return;

    activeSubtitleIndex = nextIndex;

    if (nextIndex >= 0) {
      const textNode = ensureOverlay();
      if (!textNode) return;
      textNode.textContent = currentSubtitles[nextIndex].text;
      textNode.style.display = "inline-block";
    } else {
      hideOverlay();
    }
  } catch (_) {}
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
  lastSentCount = 0;
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

// Liveness tracking for the background job. The old watchdog only checked the
// keepalive port, which stays alive even if the service worker dies mid-job —
// subtitles would silently freeze forever. Now we track the timestamp of the
// last progress message and, when it goes stale, ping the worker directly; if
// the worker no longer knows about this job (or is dead), we retry from where
// we left off instead of hanging.
let jobStartAt = 0;

function requestJobRetry(reason) {
  const requestId = activeRequestId;
  if (!requestId || !pendingVideoId) return;
  if (!isExtensionContextValid()) return;

  const doneCount = translations.filter(Boolean).length;
  console.warn(
    `[CleanSubs] ${reason} — restarting translation from cue ${doneCount}/${stitchedSegments.length}.`
  );

  const newRequestId = `${pendingVideoId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  activeRequestId = newRequestId;
  lastSentCount = stitchedSegments.length;
  lastProgressAt = Date.now();
  jobStartAt = Date.now();

  chrome.runtime.sendMessage(
    {
      action: "TRANSLATE_BATCH",
      requestId: newRequestId,
      videoId: pendingVideoId,
      texts: stitchedSegments.map((s) => s.text),
      startIndex: doneCount,
      currentPlaybackSec: Number(getCachedVideo()?.currentTime || 0)
    },
    (response) => {
      const err = chrome.runtime.lastError;
      if (err || !response || response.accepted === false) {
        console.debug("[CleanSubs] Retry rejected:", err?.message || response?.error);
      }
    }
  );
}

function armWatchdog(ms = 90000) {
  if (watchdogId) clearTimeout(watchdogId);

  watchdogId = setTimeout(() => {
    watchdogId = null;
    if (!activeRequestId) return;

    const since = Date.now() - lastProgressAt;

    // Job still delivering progress — nothing to do.
    if (since < ms * 2) {
      armWatchdog(ms);
      return;
    }

    console.warn("[CleanSubs] Health check probe: verifying worker connection...");

    let responded = false;
    const probeId = activeRequestId;

    const probeListener = (message) => {
      if (message?.type !== "JOB_ALIVE_RESULT" || message.requestId !== probeId) return;
      responded = true;
      try {
        chrome.runtime.onMessage.removeListener(probeListener);
      } catch (_) {}
      if (!message.alive && activeRequestId === probeId) {
        requestJobRetry("Worker lost our translation job");
      }
    };

    try {
      chrome.runtime.onMessage.addListener(probeListener);
    } catch (_) {
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { action: "CHECK_JOB_ALIVE", requestId: probeId },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}

    setTimeout(() => {
      try {
        chrome.runtime.onMessage.removeListener(probeListener);
      } catch (_) {}
      // No PONG at all means the service worker is dead/unreachable.
      if (!responded && activeRequestId === probeId) {
        requestJobRetry("Service worker unresponsive");
      }
    }, 8000);

    armWatchdog(ms);
  }, ms);
}

async function handleEventsPipeline(incomingEvents, videoId, source) {
  if (!isExtensionContextValid()) {
    console.debug("[CleanSubs] Extension context is no longer valid; refresh tab.");
    return;
  }

  if (!videoId || !Array.isArray(incomingEvents) || !incomingEvents.length) return;

  const isContinuation = (videoId === processedVideoId || videoId === pendingVideoId);

  if (!isContinuation && activeRequestId) {
    cleanupJob();
    stitchedSegments = [];
    translations = [];
  }

  // Number of cues already handed to the worker in previous requests. The
  // background script translates texts[startIndex...] and reports global
  // indexes, so continuation chunks only send their NEW tail instead of the
  // whole transcript again (previously O(n^2) message payloads on 3h+ videos).
  let sentCount = 0;

  if (isContinuation && stitchedSegments.length > 0) {
    sentCount = Math.min(lastSentCount, stitchedSegments.length);

    // Dedupe against RAW event start times, not post-stitch segment starts:
    // stitching shifts/merges boundaries so raw tStartMs values rarely match
    // stitched startMs exactly — the old comparison silently let overlapping
    // chunks append duplicate cues. Instead, drop incoming events that overlap
    // the last existing cue's time range; everything after that boundary is
    // genuinely new.
    const lastSeg = stitchedSegments[stitchedSegments.length - 1];
    const fresh = incomingEvents.filter(
      (ev) => Number(ev.tStartMs) >= lastSeg.endMs - 250
    );

    if (!fresh.length) return; // fully redundant chunk

    const stitchedNew = stitchGermanSegments(fresh);
    if (!stitchedNew.length) return;

    stitchedSegments = stitchedSegments.concat(stitchedNew);
    for (let i = 0; i < stitchedNew.length; i++) translations.push(undefined);

    console.log(
      `[CleanSubs] Appended ${stitchedNew.length} new cues for extended video (${stitchedSegments.length} total).`
    );
  } else {
    const stitched = stitchGermanSegments(incomingEvents);
    if (!stitched.length) return;

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

  const newTexts = stitchedSegments.slice(sentCount).map((s) => s.text);
  if (!newTexts.length) {
    rebuildSubtitles();
    return;
  }

  const requestId = `${videoId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  activeRequestId = requestId;
  pendingVideoId = videoId;
  lastSentCount = stitchedSegments.length;
  lastProgressAt = Date.now();
  jobStartAt = Date.now();

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

        lastProgressAt = Date.now();
        rebuildSubtitles();
        armWatchdog(90000);

        if (message.complete) {
          processedVideoId = pendingVideoId;
          if (watchdogId) {
            clearTimeout(watchdogId);
            watchdogId = null;
          }
          teardownWorkerChannel();
          console.log(
            `[CleanSubs] Translation complete: ${translations.filter(Boolean).length}/${stitchedSegments.length} cues ready.`
          );
        }
        return;
      }

      if (message.type === "TRANSLATION_ERROR") {
        console.warn("[CleanSubs] Translation error:", message.error || "Gemini error");
        // Keep German fallback visible and tear down the channel WITHOUT
        // marking the video processed — a later caption chunk can still retry.
        if (watchdogId) {
          clearTimeout(watchdogId);
          watchdogId = null;
        }
        teardownWorkerChannel();
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
  armWatchdog(90000);

  const currentPlaybackSec = Number(getCachedVideo()?.currentTime || 0);

  try {
    chrome.runtime.sendMessage(
      {
        action: "TRANSLATE_BATCH",
        requestId,
        videoId,
        texts: newTexts,
        startIndex: sentCount,
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

        lastProgressAt = Date.now();
        armWatchdog(90000);
      }
    );
  } catch (err) {
    console.debug("[CleanSubs] Extension context error on sendMessage:", err);
    cleanupJob();
  }
}

// Release the port + ping timer once a job finishes or fails, but keep the
// message listener attached for future jobs in the same page session.
function teardownWorkerChannel() {
  if (portPingInterval) {
    clearInterval(portPingInterval);
    portPingInterval = null;
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch (_) {}
    activePort = null;
  }
  activeRequestId = null;
}

document.addEventListener("yt-navigate-start", () => {
  cleanupJob();
  currentSubtitles = [];
  stitchedSegments = [];
  translations = [];
  processedVideoId = null;
  lastSentCount = 0;

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