# Fix model availability, error handling, reliability & performance

## Summary
Full code-review pass over the CleanSubs MV3 extension, followed by fixes for the Gemini API errors users were seeing ("Invalid key or quota" on 503s, 404s for retired models). **No API key is actually invalid in those cases** — the old code masked real errors with hardcoded messages and had no fallback.

## Commits
| Commit | What it does |
|---|---|
| `710f0da` | Broad performance / reliability / security fixes (see below) |
| `1d5ded2` | Stop masking 503s as "Invalid key or quota"; surface real API messages; retry transient 5xx with exponential backoff; remove dead model names from defaults |
| `74e2cb3` | Auto-fallback to a working model on 404 (parses Google's suggested replacement from the error message, persists the override across batches); fix unescaped regex literals that broke Shorts/Embed video-ID detection in `content_main.js` |
| `15ed212` | Route the popup "Test" button through the background worker (`TEST_CONNECTION`) so it benefits from the same retry + model-fallback logic, instead of its own hardcoded fetch that produced misleading "Test failed" errors |

## Key changes in detail
### Correctness / API resilience
- Real HTTP status + parsed API message shown to the user; 404 → "model unavailable", 403 → "key rejected", 503 → "temporarily overloaded, retrying".
- Exponential backoff retries for 429/500/502/503/504 with Retry-After support.
- Automatic model fallback: when Google reports a retired model, the recommended successor is used and saved, and the popup tells you which model ended up being used so you can update the dropdown.
- Popup "Test" now goes through the background worker — single source of truth for API calls.

### Reliability
- Fixed broken regex in `getSoundEffectTranslation` (sound-effect cues like `[upbeat music]` never matched before).
- Service-worker restart recovery: job progress is checkpointed to storage; content-script watchdog now checks job liveness, not just the keepalive port, so subtitles no longer silently freeze.
- Error paths no longer mark a video as "processed", so failures are retried automatically.
- Continuation dedupe fixed: previously new raw events were compared against post-stitch start times, allowing duplicate/overlapping cues at chunk boundaries.

### Performance
- Transcript chunks no longer re-send the entire accumulated transcript each batch (was O(n²) on long videos).
- rAF-based overlay loop throttled; per-frame DOM queries and full-array rebuild/sort on every progress message eliminated.
- Rate-limit slot bookkeeping no longer thrashes `chrome.storage` on every request.

### Security
- API key sent via header-style config instead of query string where possible; model name validated against an allowlist before interpolation into URLs; `postMessage` targets restricted to the page origin instead of `"*"`; cache bounded with LRU eviction (and hash widened beyond 32-bit FNV to avoid collisions serving wrong translations).

## Stats
6 files changed, **+652 / −148** (`background.js`, `content.js`, `content_main.js`, `popup.js`, `popup.html`, `.gitignore`). All JS passes `node --check`.

## Testing
- [x] Syntax check all scripts (`node --check`)
- [x] Verified no stale references to removed helpers
- [ ] Manual smoke test after merge: reload unpacked extension → set key → click **Test** (should succeed even if the selected model is retired, thanks to fallback) → play a German YouTube video → confirm English subs appear and survive a service-worker idle timeout mid-video

## Notes for reviewer
- The branch has no upstream configured in this environment, so it must be pushed before merging:
  `git push -u origin qwen-code-cbc2854b-00f6-4f76-9d5b-8840fc3952c7`
