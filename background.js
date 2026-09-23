const BATCH_SIZE = 20;
const MAX_BATCH_CHARS = 4500;
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const CACHE_PREFIX = "cleanSubsCache:";
const RATE_STATE_KEY = "cleanSubsRateState";
const MAX_REQUESTS_PER_MINUTE = 8;
const MIN_REQUEST_GAP_MS = Math.ceil(60000 / MAX_REQUESTS_PER_MINUTE);
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 45000;
const MIN_RECOVERY_BATCH = 4;
const PROGRESS_CHUNK = 80;

let translationQueue = Promise.resolve();
const jobs = new Map();
const latestRequestIdByTab = new Map();
const keepAlivePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "clean-subs-keepalive") {
    keepAlivePorts.add(port);

    port.onMessage.addListener((msg) => {
      if (msg?.type === "PING") {
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action !== "TRANSLATE_BATCH") return;

  const requestId = String(request.requestId || "");
  const videoId = String(request.videoId || "");
  const currentPlaybackSec = Number(request.currentPlaybackSec || 0);
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
    .then(() => processRequest({ requestId, videoId, texts, tabId, currentPlaybackSec }))
    .catch(async (error) => {
      console.error("[CleanSubs] Translation job exception:", error);
      if (!isStaleJob(tabId, requestId)) {
        await sendProgress(tabId, requestId, {
          type: "TRANSLATION_ERROR",
          error: error?.message || String(error)
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

async function processRequest({ requestId, videoId, texts, tabId, currentPlaybackSec }) {
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

  const modelName = String(selectedModel || DEFAULT_MODEL).trim();
  const total = texts.length;
  const allTranslations = new Array(total);
  const cacheKeys = texts.map((t) => makeCacheKey(t, modelName));
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

  for (let i = 0; i < total; i++) {
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
    `[CleanSubs] Video ${videoId}: ${cachedIndexes.length} cached cues, ${uncachedIndexes.length} to translate (${total} total).`
  );

  let sentCached = 0;
  for (let i = 0; i < cachedIndexes.length; i += PROGRESS_CHUNK) {
    if (isStaleJob(tabId, requestId)) return;

    const indexes = cachedIndexes.slice(i, i + PROGRESS_CHUNK);
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
    return;
  }

  const approxCurrentIndex = Math.max(0, Math.floor(currentPlaybackSec / 3));
  uncachedIndexes.sort((a, b) => {
    const distA = Math.abs(a - approxCurrentIndex);
    const distB = Math.abs(b - approxCurrentIndex);
    return distA - distB;
  });

  let cursor = 0;

  while (cursor < uncachedIndexes.length) {
    if (isStaleJob(tabId, requestId)) return;

    const batchIndexes = [];
    let chars = 0;

    while (cursor < uncachedIndexes.length && batchIndexes.length < BATCH_SIZE) {
      const idx = uncachedIndexes[cursor];
      const candidate = texts[idx];
      const candidateChars = candidate.length + 8;

      if (batchIndexes.length > 0 && chars + candidateChars > MAX_BATCH_CHARS) {
        break;
      }

      batchIndexes.push(idx);
      chars += candidateChars;
      cursor += 1;
    }

    const batch = batchIndexes.map((idx) => texts[idx]);

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
      allTranslations[globalIndex] = translated || texts[globalIndex];
      cacheWrite[CACHE_PREFIX + cacheKeys[globalIndex]] = allTranslations[globalIndex];
    }

    try {
      await chrome.storage.local.set(cacheWrite);
    } catch (quotaErr) {
      console.warn("[CleanSubs] Cache storage write warning, continuing:", quotaErr);
    }

    completed += batchIndexes.length;

    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      total,
      indexes: batchIndexes,
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

async function waitForRateSlot() {
  const state = await chrome.storage.local.get(RATE_STATE_KEY);
  let timestamps = Array.isArray(state[RATE_STATE_KEY]) ? state[RATE_STATE_KEY] : [];

  const now = Date.now();
  timestamps = timestamps.filter((time) => Number.isFinite(time) && now - time < 60000);

  const last = timestamps[timestamps.length - 1] || 0;
  const gap = MIN_REQUEST_GAP_MS - (now - last);

  if (gap > 0) await sleep(gap);

  timestamps = (await chrome.storage.local.get(RATE_STATE_KEY))[RATE_STATE_KEY];
  timestamps = Array.isArray(timestamps)
    ? timestamps.filter((time) => Number.isFinite(time) && Date.now() - time < 60000)
    : [];

  while (timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const waitMs = Math.max(500, 60000 - (Date.now() - timestamps[0]) + 250);
    await sleep(waitMs);

    timestamps = (await chrome.storage.local.get(RATE_STATE_KEY))[RATE_STATE_KEY];
    timestamps = Array.isArray(timestamps)
      ? timestamps.filter((time) => Number.isFinite(time) && Date.now() - time < 60000)
      : [];
  }

  timestamps.push(Date.now());

  await chrome.storage.local.set({
    [RATE_STATE_KEY]: timestamps.slice(-MAX_REQUESTS_PER_MINUTE)
  });
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

async function translateWithRetry(batch, apiKey, modelName, shouldAbort) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (shouldAbort?.()) throw new Error("Translation canceled.");

    try {
      await waitForRateSlot();
      return await translateWithGemini(batch, apiKey, modelName);
    } catch (error) {
      lastError = error;
      if (shouldAbort?.()) throw error;

      const status = error?.status || parseStatus(error?.message);
      const retryableShape = Boolean(error?.retryableShape);

      if (status !== 429 && !retryableShape) throw error;

      const waitMs = retryableShape
        ? 1200 * (attempt + 1)
        : Math.min(60000, Math.max(5000, error?.retryAfterMs || 30000));

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
    const errText = await response.text();
    const retryAfterHeader = response.headers.get("retry-after");
    let retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;

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

function makeCacheKey(text, model) {
  const value = `${model}:en:${text}`;
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `${(hash >>> 0).toString(16)}_${value.length}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}