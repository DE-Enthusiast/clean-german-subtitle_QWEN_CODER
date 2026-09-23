(function () {
  let isExtracting = false;
  let successfullyExtractedVideoId = "";
  let lastCachedPayload = null;
  let retryTimer = null;

  function getUrlString(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      if (input && typeof input.url === "string") return input.url;
    } catch (_) {}
    return "";
  }

  function isGermanTimedtextUrl(url) {
    const u = String(url || "");
    if (!u.includes("/api/timedtext")) return false;
    if (!/[?&]lang=/.test(u)) return true;
    return /[?&]lang=de(?:[-_]|&|$)/i.test(u);
  }

  function getVideoId() {
    try {
      const matchShorts = window.location.pathname.match(//shorts/([a-zA-Z0-9_-]+)/);
      if (matchShorts && matchShorts[1]) return matchShorts[1];

      const matchEmbed = window.location.pathname.match(//embed/([a-zA-Z0-9_-]+)/);
      if (matchEmbed && matchEmbed[1]) return matchEmbed[1];

      return new URLSearchParams(window.location.search).get("v") || "";
    } catch (_) {
      return "";
    }
  }

  function dispatchEvents(events, videoId, source) {
    if (!events || events.length === 0) return;

    successfullyExtractedVideoId = videoId;
    lastCachedPayload = {
      __cleanSubs: true,
      type: "EVENTS",
      payload: {
        videoId,
        events,
        source,
        timestamp: Date.now()
      }
    };

    window.postMessage(lastCachedPayload, "*");
  }

  function dispatchRawTranscript(rawBody, source, url) {
    if (!rawBody || rawBody.trim().length <= 10) return;

    const videoId = getVideoId();
    if (videoId) {
      successfullyExtractedVideoId = videoId;
    }

    lastCachedPayload = {
      __cleanSubs: true,
      type: "RAW_PAYLOAD",
      payload: {
        rawBody,
        source,
        url,
        videoId,
        timestamp: Date.now()
      }
    };

    window.postMessage(lastCachedPayload, "*");
  }

  // Hook XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const urlString = getUrlString(url);

    if (urlString.includes("/api/timedtext")) {
      this.__cleanSubsUrl = urlString;

      if (!this.__cleanSubsHooked) {
        this.__cleanSubsHooked = true;

        this.addEventListener("load", function () {
          const u = this.__cleanSubsUrl || "";
          if (
            this.responseText &&
            this.responseText.trim().length > 10 &&
            isGermanTimedtextUrl(u)
          ) {
            dispatchRawTranscript(this.responseText, "xhr_interception", u);
          }
        });
      }
    }

    return origOpen.apply(this, [method, url, ...rest]);
  };

  // Hook Fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);

    try {
      let url = getUrlString(args[0]);
      if (!url && response && response.url) url = response.url;

      if (response.ok && isGermanTimedtextUrl(url)) {
        const clone = response.clone();
        clone
          .text()
          .then((txt) => {
            if (txt && txt.trim().length > 10) {
              dispatchRawTranscript(txt, "fetch_interception", url);
            }
          })
          .catch(() => {});
      }
    } catch (_) {}

    return response;
  };

  // Tier 1: Direct Caption Track
  async function tryDirectCaptionTrack(track, videoId) {
    if (!track?.baseUrl) return false;

    try {
      const url = new URL(track.baseUrl, window.location.origin);
      url.searchParams.delete("exp");
      url.searchParams.set("fmt", "json3");

      const res = await fetch(url.toString(), {
        credentials: "omit",
        headers: { Accept: "*/*" }
      });

      if (!res.ok) return false;

      const text = await res.text();
      if (!text || text.trim().length <= 20) return false;

      const data = JSON.parse(text);
      if (!data.events || data.events.length === 0) return false;

      const parsed = [];

      for (const ev of data.events) {
        if (!ev.segs) continue;

        const startMs = Number(ev.tStartMs);
        if (!Number.isFinite(startMs)) continue;

        const t = ev.segs.map((s) => s.utf8 || "").join("").trim();
        if (t) {
          parsed.push({
            tStartMs: startMs,
            dDurationMs: Number(ev.dDurationMs) || 2000,
            text: t
          });
        }
      }

      if (parsed.length > 0) {
        dispatchEvents(parsed, videoId, "tier1_caption_track");
        return true;
      }
    } catch (_) {}

    return false;
  }

  // Tier 2: YouTube get_transcript endpoint
  async function tryGetTranscriptEndpoint(videoId) {
    try {
      const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY");
      if (!apiKey) return false;

      const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT") || {
        client: {
          clientName: "WEB",
          clientVersion: "2.20240901.01.00"
        }
      };

      const params = btoa(String.fromCharCode(10, 11) + videoId);

      const res = await fetch(
        `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ context, params })
        }
      );

      if (!res.ok) return false;

      const data = await res.json();
      const actions = data.actions || [];

      for (const act of actions) {
        const panel = act.updateEngagementPanelAction?.content;
        const renderer = panel?.transcriptRenderer;
        const body = renderer?.content?.transcriptSearchPanelRenderer?.body;
        const segments = body?.transcriptSegmentListRenderer?.initialSegments;

        if (segments && segments.length > 0) {
          const parsed = [];

          for (const s of segments) {
            const r = s.transcriptSegmentRenderer;
            if (!r) continue;

            const startMs = parseInt(r.startMs || "0", 10);
            const endMs = parseInt(r.endMs || "0", 10);
            const text = (r.snippet?.runs || [])
              .map((x) => x.text || "")
              .join("")
              .trim();

            if (text) {
              parsed.push({
                tStartMs: startMs,
                dDurationMs: endMs > startMs ? endMs - startMs : 2500,
                text
              });
            }
          }

          if (parsed.length > 0) {
            dispatchEvents(parsed, videoId, "tier2_get_transcript");
            return true;
          }
        }
      }
    } catch (_) {}

    return false;
  }

  // Tier 3: Trigger native subtitles
  function tryTriggerPlayerSubtitles() {
    const player = document.getElementById("movie_player");

    if (player) {
      try {
        player.loadModule?.("captions");
        player.toggleSubtitlesOn?.();
      } catch (_) {}
    }

    const ccBtn = document.querySelector(".ytp-subtitles-button");
    if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
      ccBtn.click();
    }
  }

  async function executeExtractionPipeline(retryAttempt = 0) {
    const v = new URLSearchParams(window.location.search).get("v");
    if (!v || v === successfullyExtractedVideoId || isExtracting) return;

    isExtracting = true;

    try {
      const player = document.getElementById("movie_player");
      const playerResponse = player?.getPlayerResponse
        ? player.getPlayerResponse()
        : window.ytInitialPlayerResponse;

      const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      // Accept German tracks (both manual and ASR, and check vssId)
      const deTrack =
        tracks.find((t) => (t.languageCode === "de" || t.vssId === ".de") && t.kind !== "asr") ||
        tracks.find((t) => t.languageCode === "de" || t.vssId === ".de") ||
        tracks.find((t) => String(t.languageCode || "").startsWith("de") || String(t.vssId || "").includes(".de"));

      if (deTrack) {
        const ok1 = await tryDirectCaptionTrack(deTrack, v);
        if (ok1) {
          isExtracting = false;
          return;
        }
      }

      const ok2 = await tryGetTranscriptEndpoint(v);
      if (ok2) {
        isExtracting = false;
        return;
      }

      tryTriggerPlayerSubtitles();
    } catch (err) {
      console.debug("[CleanSubs-Main] Extraction step error:", err);
    } finally {
      isExtracting = false;
    }

    // Exponential retry if captions were not found yet
    if (successfullyExtractedVideoId !== v && retryAttempt < 5) {
      const delays = [600, 1200, 2400, 4000, 6000];
      clearTimeout(retryTimer);
      retryTimer = setTimeout(
        () => executeExtractionPipeline(retryAttempt + 1),
        delays[retryAttempt] || 3000
      );
    }
  }

  // Listen for handshake from isolated content script
  window.addEventListener("message", (event) => {
    if (event.data && event.data.__cleanSubsClientReady) {
      const v = getVideoId();
      if (lastCachedPayload && successfullyExtractedVideoId === v) {
        window.postMessage(lastCachedPayload, "*");
      } else {
        executeExtractionPipeline(0);
      }
    }
  });

  [300, 800, 1600, 3200].forEach((ms) => setTimeout(() => executeExtractionPipeline(0), ms));

  function resetOnNavigation() {
    successfullyExtractedVideoId = "";
    lastCachedPayload = null;
    clearTimeout(retryTimer);
    [200, 700, 1800, 3500].forEach((ms) => setTimeout(() => executeExtractionPipeline(0), ms));
  }

  document.addEventListener("yt-navigate-finish", resetOnNavigation);
  document.addEventListener("yt-page-data-updated", () => {
    const v = getVideoId();
    if (v && v !== successfullyExtractedVideoId) {
      resetOnNavigation();
    }
  });
  window.addEventListener("popstate", () => {
    const v = getVideoId();
    if (v && v !== successfullyExtractedVideoId) {
      resetOnNavigation();
    }
  });
})();