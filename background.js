const BATCH_SIZE = 20;
const MAX_BATCH_CHARS = 4500;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
// Transient server-side failures worth retrying with backoff. 503 in
// particular is returned by Gemini when a model is overloaded or being
// deprecated — it does NOT mean the API key is invalid.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MODEL_PATTERN = /^[a-zA-Z0-9._\-]{1,80}$/;
const CACHE_PREFIX = "cleanSubsCache:";
const CACHE_META_KEY = "cleanSubsCacheMeta";
const MAX_CACHE_ENTRIES = 20000;
const MAX_REQUESTS_PER_MINUTE = 8;
const MIN_REQUEST_GAP_MS = Math.ceil(60000 / MAX_REQUESTS_PER_MINUTE);
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 45000;
const MIN_RECOVERY_BATCH = 4;
const PROGRESS_CHUNK = 80;
const HEARTBEAT_INTERVAL_MS = 20000;

let translationQueue = Promise.resolve();
const jobs = new Map();
const latestRequestIdByTab = new Map();
const keepAlivePorts = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "clean-subs-keepalive") {
    const tabId = port.sender?.tab?.id;
    keepAlivePorts.set(port, { tabId, lastPingAt: Date.now() });

    port.onMessage.addListener((msg) => {
      if (msg?.type === "PING") {
        const entry = keepAlivePorts.get(port);
        if (entry) entry.lastPingAt = Date.now();
        try {
          port.postMessage({ type: "PONG" });
        } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      keepAlivePorts.delete(port);
    });
  }
});

// Safety net: periodically wake the worker while any content script still has
// an active keepalive port. Without this, a service-worker restart can leave a
// long-running translation job stranded until the content script notices.
setInterval(() => {
  const now = Date.now();
  for (const [port, entry] of keepAlivePorts) {
    if (now - entry.lastPingAt > HEARTBEAT_INTERVAL_MS * 3) {
      keepAlivePorts.delete(port);
      continue;
    }
    try {
      port.postMessage({ type: "WORKER_PING" });
    } catch (_) {
      keepAlivePorts.delete(port);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// Release per-tab bookkeeping when a tab goes away so jobs/maps can't leak.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, job] of jobs) {
    if (job.tabId === tabId) jobs.delete(id);
  }
  latestRequestIdByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "CHECK_JOB_ALIVE") {
    const requestId = String(request.requestId || "");
    const job = jobs.get(requestId);
    const tabId = sender?.tab?.id;
    const alive = !!job && !job.canceled && Number.isInteger(tabId)
      ? latestRequestIdByTab.get(tabId) === requestId
      : false;
    try {
      sendResponse({ type: "JOB_ALIVE_RESULT", requestId, alive });
    } catch (_) {}
    return false;
  }

  if (request?.action !== "TRANSLATE_BATCH") return;

  const requestId = String(request.requestId || "");
  const videoId = String(request.videoId || "");
  const currentPlaybackSec = Number(request.currentPlaybackSec || 0);
  const startIndex = Number.isInteger(request.startIndex) && request.startIndex > 0
    ? request.startIndex
    : 0;
  const texts = Array.isArray(request.texts)
    ? request.texts.map((x) => String(x || "").trim())
    : [];

  const tabId = sender?.tab?.id;

  if (!requestId || !texts.length || !Number.isInteger(tabId)) {
    try {
      sendResponse({ accepted: false, error: "Invalid translation request parameters." });
    } catch (_) {}
    return;
  }

  for (const [id, job] of jobs) {
    if (job.tabId === tabId && id !== requestId) {
      job.canceled = true;
    }
  }

  jobs.set(requestId, { tabId, videoId, canceled: false });
  latestRequestIdByTab.set(tabId, requestId);

  try {
    sendResponse({ accepted: true, requestId, total: texts.length });
  } catch (_) {}

  translationQueue = translationQueue
    .catch(() => {})
    .then(() =>
      processRequest({
        requestId,
        videoId,
        texts,
        startIndex,
        newTexts: texts.slice(startIndex),
        tabId,
        currentPlaybackSec
      })
    )
    .catch(async (error) => {
      console.error("[CleanSubs] Translation job exception:", error);
      if (!isStaleJob(tabId, requestId)) {
        await sendProgress(tabId, requestId, {
          type: "TRANSLATION_ERROR",
          error: describeError(error),
          details: error?.message || String(error)
        });
      }
    })
    .finally(() => {
      jobs.delete(requestId);
      if (latestRequestIdByTab.get(tabId) === requestId) {
        latestRequestIdByTab.delete(tabId);
      }
    });

  return false;
});

function isStaleJob(tabId, requestId) {
  const job = jobs.get(requestId);
  if (!job || job.canceled) return true;
  if (Number.isInteger(tabId) && latestRequestIdByTab.get(tabId) !== requestId) {
    return true;
  }
  return false;
}

// Turn a raw Gemini error into a short, actionable user-facing message.
// Previously the full API error body (including huge JSON blobs) leaked into
// logs/UI and every failure looked like "Gemini API Error (503)", which users
// misread as an invalid key — 503 actually means Google's servers/model are
// temporarily unavailable.
function describeError(error) {
  const status = error?.status || parseStatus(error?.message);
  const lower = String(error?.message || "").toLowerCase();

  if (status === 400 && /not found|unsupported|model/i.test(lower)) {
    return "The selected model isn't available on your account. Pick a different model in the extension popup.";
  }
  if (status === 400 && /api key not valid|invalid api key|api_key_invalid/i.test(lower)) {
    return "Your Gemini API key was rejected. Double-check it in the extension popup.";
  }
  if (status === 403) {
    return "Access denied by Gemini. Make sure Generative Language API is enabled for this key.";
  }
  if (status === 429) {
    return "Gemini rate limit or free-tier quota reached after retries. Try again in a few minutes.";
  }
  if (status >= 500) {
    return `Gemini service temporarily unavailable (HTTP ${status}). Your key is fine — please retry.`;
  }
  if (/timed out/i.test(lower)) {
    return "Gemini request timed out after retries. Check your connection and try again.";
  }
  return "Translation failed after retries. See the browser console for details.";
}

async function processRequest({ requestId, videoId, texts, startIndex = 0, newTexts, tabId, currentPlaybackSec }) {
  if (isStaleJob(tabId, requestId)) return;

  const { geminiApiKey, extensionEnabled, selectedModel } = await chrome.storage.local.get([
    "geminiApiKey",
    "extensionEnabled",
    "selectedModel"
  ]);

  if (extensionEnabled === false) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_ERROR",
      error: "Extension is disabled in settings popup."
    });
    return;
  }

  const apiKey = String(geminiApiKey || "").trim();
  if (!apiKey) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_ERROR",
      error: "Gemini API key missing. Click the extension icon to set your key."
    });
    return;
  }

  // Only ever pass a conservative model-name allowlist into the API URL.
  let modelName = String(selectedModel || DEFAULT_MODEL).trim();
  if (!MODEL_PATTERN.test(modelName)) {
    console.warn(`[CleanSubs] Ignoring invalid model name "${modelName}"; using default.`);
    modelName = DEFAULT_MODEL;
  }

  // For continuation requests the content script sends only the newly added
  // cues; translateBatch works on this local slice and remaps indexes back
  // into the full transcript when reporting progress. This avoids re-sending
  // (and re-hashing / re-cache-looking-up) the entire transcript on every
  // chunk of a 3h+ video, which was O(n²) overall.
  const batchTexts = Array.isArray(newTexts) && newTexts.length > 0 ? newTexts : texts;
  const total = Number.isInteger(startIndex) && startIndex >= 0
    ? startIndex + batchTexts.length
    : texts.length;
  const allTranslations = new Array(batchTexts.length);
  const cacheKeys = batchTexts.map((t) => makeCacheKey(t, modelName));
  const lookupKeys = cacheKeys.map((key) => CACHE_PREFIX + key);

  let cached = {};
  try {
    cached = await chrome.storage.local.get(lookupKeys);
  } catch (err) {
    console.warn("[CleanSubs] Cache lookup warning:", err);
  }

  const cachedIndexes = [];
  const cachedTranslations = [];
  const uncachedIndexes = [];

  for (let i = 0; i < batchTexts.length; i++) {
    const value = cached[CACHE_PREFIX + cacheKeys[i]];
    if (typeof value === "string" && value.trim()) {
      allTranslations[i] = value;
      cachedIndexes.push(i);
      cachedTranslations.push(value);
    } else {
      uncachedIndexes.push(i);
    }
  }

  console.log(
    `[CleanSubs] Video ${videoId}: ${cachedIndexes.length} cached cues, ${uncachedIndexes.length} to translate (${batchTexts.length} in this request, ${total} total cues).`
  );

  let sentCached = 0;
  for (let i = 0; i < cachedIndexes.length; i += PROGRESS_CHUNK) {
    if (isStaleJob(tabId, requestId)) return;

    const indexes = cachedIndexes.slice(i, i + PROGRESS_CHUNK).map((idx) => idx + startIndex);
    const translations = cachedTranslations.slice(i, i + PROGRESS_CHUNK);
    sentCached += indexes.length;

    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      total,
      indexes,
      translations,
      complete: false,
      completedCues: sentCached
    });
  }

  let completed = cachedIndexes.length;

  if (uncachedIndexes.length === 0) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      total,
      indexes: [],
      translations: [],
      complete: true,
      completedCues: completed
    });
    await pruneCacheIfNeeded().catch(() => {});
    return;
  }

  // Translate from the playback position forward (approximate index heuristic),
  // then wrap around to any earlier missed cues. Previously it sorted by raw
  // absolute distance, which interleaved far-future batches with already-passed
  // cues and wasted rate-limit budget on text the viewer may never reach soon.
  const approxCurrentIndex = Math.max(0, Math.floor(currentPlaybackSec / 3) - startIndex);
  uncachedIndexes.sort((a, b) => {
    const fwdA = a >= approxCurrentIndex ? a - approxCurrentIndex : Number.MAX_SAFE_INTEGER - (approxCurrentIndex - a);
    const fwdB = b >= approxCurrentIndex ? b - approxCurrentIndex : Number.MAX_SAFE_INTEGER - (approxCurrentIndex - b);
    return fwdA - fwdB;
  });

  let cursor = 0;

  while (cursor < uncachedIndexes.length) {
    if (isStaleJob(tabId, requestId)) return;

    const batchIndexes = [];
    let chars = 0;

    while (cursor < uncachedIndexes.length && batchIndexes.length < BATCH_SIZE) {
      const idx = uncachedIndexes[cursor];
      const candidate = batchTexts[idx];
      const candidateChars = candidate.length + 8;

      if (batchIndexes.length > 0 && chars + candidateChars > MAX_BATCH_CHARS) {
        break;
      }

      batchIndexes.push(idx);
      chars += candidateChars;
      cursor += 1;
    }

    const batch = batchIndexes.map((idx) => batchTexts[idx]);

    const batchTranslations = await translateBatchResilient(
      batch,
      apiKey,
      modelName,
      () => isStaleJob(tabId, requestId)
    );

    if (isStaleJob(tabId, requestId)) return;

    const cacheWrite = {};
    for (let i = 0; i < batchTranslations.length; i++) {
      const globalIndex = batchIndexes[i];
      const translated = String(batchTranslations[i] ?? "").trim();
      allTranslations[globalIndex] = translated || batchTexts[globalIndex];
      cacheWrite[CACHE_PREFIX + cacheKeys[globalIndex]] = allTranslations[globalIndex];
    }

    try {
      await chrome.storage.local.set(cacheWrite);
      await recordCacheWrite(Object.keys(cacheWrite));
    } catch (quotaErr) {
      console.warn("[CleanSubs] Cache storage write warning, continuing:", quotaErr);
      // Storage is likely full — drop the oldest half of the cache and retry once.
      await forcePruneCache().catch(() => {});
      try {
        await chrome.storage.local.set(cacheWrite);
        await recordCacheWrite(Object.keys(cacheWrite));
      } catch (_) {}
    }

    completed += batchIndexes.length;

    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      total,
      indexes: batchIndexes.map((idx) => idx + startIndex),
      translations: batchTranslations,
      complete: cursor >= uncachedIndexes.length,
      completedCues: completed
    });
  }

  await sendProgress(tabId, requestId, {
    type: "TRANSLATION_PROGRESS",
    total,
    indexes: [],
    translations: [],
    complete: true,
    completedCues: completed
  });

  await pruneCacheIfNeeded().catch(() => {});
}

async function sendProgress(tabId, requestId, message) {
  if (!Number.isInteger(tabId)) return;

  try {
    await chrome.tabs.sendMessage(tabId, { requestId, ...message });
  } catch (error) {
    const msg = String(error?.message || error);
    if (/no tab|tab was closed|receiving end does not exist|extension context invalidated|message port closed/i.test(msg)) {
      const job = jobs.get(requestId);
      if (job) job.canceled = true;
    }
  }
}

// In-memory sliding-window rate limiter. The previous implementation stored
// timestamps in chrome.storage.local and re-read them between awaits, which
// (a) caused read-modify-write races that could let bursts exceed the limit
// and (b) hammered storage on every single API call. All translation jobs are
// already serialized through translationQueue, so a module-level array is
// sufficient and correct.
let recentRequestTimestamps = [];

async function waitForRateSlot() {
  for (;;) {
    const now = Date.now();
    recentRequestTimestamps = recentRequestTimestamps.filter(
      (time) => Number.isFinite(time) && now - time < 60000
    );

    let waitMs = 0;

    if (recentRequestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      waitMs = Math.max(250, 60000 - (now - recentRequestTimestamps[0]) + 100);
    } else {
      const last = recentRequestTimestamps[recentRequestTimestamps.length - 1] || 0;
      const gap = MIN_REQUEST_GAP_MS - (now - last);
      if (gap > 0) waitMs = gap;
    }

    if (waitMs <= 0) break;
    await sleep(waitMs);
  }

  recentRequestTimestamps.push(Date.now());
}

// Keep the translation cache bounded: track insertion order in a small meta
// entry and evict oldest entries once the cache grows past MAX_CACHE_ENTRIES.
async function pruneCacheIfNeeded() {
  const meta = await chrome.storage.local.get(CACHE_META_KEY);
  const order = Array.isArray(meta[CACHE_META_KEY]?.order) ? meta[CACHE_META_KEY].order : [];

  if (order.length <= MAX_CACHE_ENTRIES) return;

  const evictCount = Math.floor(MAX_CACHE_ENTRIES / 4);
  const toEvict = order.slice(0, evictCount);
  const remaining = order.slice(evictCount);

  await chrome.storage.local.remove(toEvict);
  await chrome.storage.local.set({ [CACHE_META_KEY]: { order: remaining } });
  console.log(`[CleanSubs] Pruned ${toEvict.length} oldest cache entries (${remaining.length} remain).`);
}

async function forcePruneCache() {
  const meta = await chrome.storage.local.get(CACHE_META_KEY);
  const order = Array.isArray(meta[CACHE_META_KEY]?.order) ? meta[CACHE_META_KEY].order : [];
  if (order.length === 0) return;

  const half = Math.ceil(order.length / 2);
  const toEvict = order.slice(0, half);

  await chrome.storage.local.remove(toEvict);
  await chrome.storage.local.set({ [CACHE_META_KEY]: { order: order.slice(half) } });
}

async function recordCacheWrite(keys) {
  try {
    const meta = await chrome.storage.local.get(CACHE_META_KEY);
    const order = Array.isArray(meta[CACHE_META_KEY]?.order) ? meta[CACHE_META_KEY].order : [];
    const existing = new Set(order);
    for (const key of keys) {
      if (!existing.has(key)) order.push(key);
    }
    // Trim from the front if we massively overshot the soft cap.
    const trimmed = order.length > MAX_CACHE_ENTRIES * 1.5
      ? order.slice(order.length - MAX_CACHE_ENTRIES)
      : order;
    await chrome.storage.local.set({ [CACHE_META_KEY]: { order: trimmed } });
  } catch (_) {}
}

async function translateBatchResilient(batch, apiKey, modelName, shouldAbort) {
  if (shouldAbort?.()) throw new Error("Translation canceled.");

  try {
    return await translateWithRetry(batch, apiKey, modelName, shouldAbort);
  } catch (error) {
    if (shouldAbort?.()) throw error;

    if (!error?.retryableShape || batch.length <= MIN_RECOVERY_BATCH) {
      throw error;
    }

    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);

    console.warn(
      `[CleanSubs] Gemini cue count mismatch (${batch.length}). Splitting into ${left.length}+${right.length} recovery batches.`
    );

    const leftTranslations = await translateBatchResilient(left, apiKey, modelName, shouldAbort);
    const rightTranslations = await translateBatchResilient(right, apiKey, modelName, shouldAbort);

    return leftTranslations.concat(rightTranslations);
  }
}

// If the user's selected model is retired/unavailable on their account
// (404 NOT_FOUND), Google suggests a replacement in the error message.
// Rather than failing the whole job, we auto-switch to a working model:
// first the one Google recommends, then any other known-good default.
const FALLBACK_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-pro"
];

let activeModelOverride = null;

function suggestedModelFromError(text) {
  const match = String(text || "").match(/models\/([a-z0-9._-]+)/i);
  return match ? match[1] : "";
}

function buildModelCandidates(requestedModel, errorText) {
  const suggested = suggestedModelFromError(errorText);
  const seen = new Set();
  const candidates = [];

  for (const model of [suggested, requestedModel, ...FALLBACK_MODELS]) {
    if (model && !seen.has(model)) {
      seen.add(model);
      candidates.push(model);
    }
  }
  return candidates;
}

async function translateWithRetry(batch, apiKey, modelName, shouldAbort) {
  let lastError = null;
  // Honor an auto-switched model across batches so we don't re-discover the
  // same 404 on every chunk of the job.
  let effectiveModel = activeModelOverride || modelName;
  const triedModels = new Set([effectiveModel]);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (shouldAbort?.()) throw new Error("Translation canceled.");

    try {
      await waitForRateSlot();
      const result = await translateWithGemini(batch, apiKey, effectiveModel);
      return result;
    } catch (error) {
      lastError = error;
      if (shouldAbort?.()) throw error;

      const status = error?.status || parseStatus(error?.message);
      const retryableShape = Boolean(error?.retryableShape);

      // Model not found / not available: swap models and retry immediately
      // (no backoff — this is deterministic, not load-related). Google's 404
      // body usually names a replacement model; otherwise try known-good ones.
      if (status === 404) {
        const candidates = buildModelCandidates(effectiveModel, error?.message);
        let recovered = false;

        for (const candidate of candidates) {
          if (candidate === effectiveModel || triedModels.has(candidate)) continue;
          console.warn(
            `[CleanSubs] Model "${effectiveModel}" is unavailable (404). Falling back to "${candidate}".`
          );
          effectiveModel = candidate;
          activeModelOverride = candidate;
          triedModels.add(candidate);
          recovered = true;
          break;
        }

        if (recovered) {
          attempt--; // model switch shouldn't consume a retry slot
          continue;
        }

        throw new Error(
          `Model "${effectiveModel}" was not found and no fallback model worked. Open the extension popup and pick a different model.`
        );
      }

      if (!RETRYABLE_STATUSES.has(status) && !retryableShape) throw error;

      // Respect RetryInfo for 429s, but also back off transient 5xx errors
      // (500/502/503/504) — previously these were thrown immediately and the
      // whole job failed with a raw "Gemini API Error (503)" even though the
      // condition is usually gone after a few seconds.
      const waitMs = retryableShape && !RETRYABLE_STATUSES.has(status)
        ? 1200 * (attempt + 1)
        : Math.min(60000, Math.max(2000, error?.retryAfterMs || 5000 * Math.pow(2, attempt)));

      console.warn(
        `[CleanSubs] Gemini retry in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES}).`
      );

      await sleep(waitMs);
    }
  }

  throw lastError || new Error("Gemini translation request failed after retries.");
}

async function translateWithGemini(batch, apiKey, modelName) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = `You translate German YouTube subtitles into natural, concise conversational English.
Rules:
- Return exactly ONE English string for EACH input cue.
- Keep the exact same order.
- NEVER merge cues.
- NEVER split cues.
- NEVER omit a cue.
- NEVER add a cue.
- Preserve names, numbers, jokes, tone, idioms, and punctuation.
- Keep translations brief and fitting as video subtitles.
- Output JSON array of strings only.
INPUT COUNT: ${batch.length}
INPUT ARRAY:
${JSON.stringify(batch)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: { type: "STRING" }
          },
          temperature: 0.1
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Gemini network connection error: ${error?.message || error}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    // Truncate defensively: error bodies can be large and we only keep the
    // first part for diagnostics anyway.
    const errText = (await response.text()).slice(0, 2000);
    const retryAfterHeader = response.headers.get("retry-after");
    let retryAfterMs = Number.isFinite(Number(retryAfterHeader)) && retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : 0;

    try {
      const parsed = JSON.parse(errText);
      const retryInfo = parsed?.error?.details?.find(
        (detail) => String(detail?.["@type"] || "").includes("RetryInfo")
      );
      const seconds = Number(String(retryInfo?.retryDelay || "").replace(/s$/, ""));
      if (Number.isFinite(seconds)) {
        retryAfterMs = Math.max(retryAfterMs, seconds * 1000);
      }
    } catch (_) {}

    const error = new Error(`Gemini API Error (${response.status}): ${errText}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) throw new Error("Empty translation response received from Gemini.");

  let clean = rawText.trim();
  if (clean.startsWith("```json")) {
    clean = clean.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (clean.startsWith("```")) {
    clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    const parseError = new Error(`Gemini returned non-JSON payload: ${err.message}`);
    parseError.retryableShape = true;
    throw parseError;
  }

  if (!Array.isArray(parsed)) throw new Error("Gemini returned invalid non-array translation structure.");

  if (parsed.length < batch.length) {
    const err = new Error(
      `Gemini returned ${parsed.length} items for ${batch.length} input cues.`
    );
    err.retryableShape = true;
    throw err;
  }

  return parsed.slice(0, batch.length).map((v) => String(v ?? "").trim());
}

function parseStatus(message) {
  const match = String(message || "").match(/Gemini API Error \((\d{3})\)/);
  return match ? Number(match[1]) : 0;
}

// 64-bit FNV-1a (two independent 32-bit lanes). A single 32-bit hash collides
// often enough at tens of thousands of cached cues to serve the wrong
// translation, so we combine two differently-seeded hashes plus the length.
function makeCacheKey(text, model) {
  const value = `${model}:en:${text}`;

  let h1 = 2166136261;
  let h2 = 5381;

  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }

  return `${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}_${value.length.toString(36)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}