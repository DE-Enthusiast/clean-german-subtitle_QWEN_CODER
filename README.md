# Clean German Subtitles for YouTube v4.4.0 (Production Release)

Ultra-reliable German to English subtitle translation for YouTube powered by Google Gemini, engineered for instant startup, zero race conditions, and marathon 3+ hour videos.

---

## 🛠️ Summary of Fixes in v4.4.0

### 1. Instant Startup & Elimination of Race Conditions
- **Fixed lastVideoId Premature Locking**: In earlier versions, lastVideoId was locked on the very first 700ms timer before the YouTube player had loaded caption data. When later fallback attempts fired, they aborted thinking the video had already been processed. Now, the video ID is committed only when captions are verified, with 5 exponential backoff retries.
- **Client-Ready Handshake**: content.js runs at document_start alongside content_main.js and broadcasts a __cleanSubsClientReady ping. If content_main.js extracted captions first, it immediately flushes the cached payload, guaranteeing no dropped initial messages.
- **Active Keep-Alive Heartbeat**: Sends a { type: "PING" } every 20 seconds across the clean-subs-keepalive port. The service worker replies { type: "PONG" }, actively resetting Chrome Manifest V3's 30-second worker termination timer.

### 2. 3-Hour+ Video & Long Stream Fixes
- **Continuous Timestamp Merging**: In 3+ hour videos, YouTube serves captions in delayed, chunked /api/timedtext queries as the video progresses or when you seek. The engine now detects chunk continuations, deduplicates by millisecond start time, and merges new segments without wiping out existing subtitles.
- **Priority Window Translation**: Sorts uncached batches so that cues closest to the current video playback position (video.currentTime) are prioritized first. You never wait 20 minutes for batch #150 when skipping to a later point in the video.
- **Storage Quota Resilience**: Added "unlimitedStorage" to manifest.json. Batched cache writes are wrapped in safe error handlers, preventing QUOTA_BYTES exceptions from stopping translations.
- **Non-Destructive Watchdog**: Replaced the previous 120s kill-switch with a 5-minute health probe that verifies port health instead of prematurely aborting active jobs.

---

## 🚀 Installation

1. Open Google Chrome (or any Chromium browser like Brave, Edge, Opera).
2. Go to chrome://extensions/.
3. Toggle on Developer mode in the top-right corner.
4. Click Load unpacked.
5. Select this extension folder.
6. Click the extension icon in the toolbar, enter your free Gemini API Key from aistudio.google.com, and click Save Settings.
7. Open any German YouTube video and enjoy clean, synchronized English subtitles!