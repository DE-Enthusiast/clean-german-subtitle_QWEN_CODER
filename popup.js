document.addEventListener("DOMContentLoaded", async () => {
  const keyInput = document.getElementById("apiKey");
  const modelSelect = document.getElementById("modelSelect");
  const fontSizeSelect = document.getElementById("fontSizeSelect");
  const toggle = document.getElementById("extToggle");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const clearCacheBtn = document.getElementById("clearCacheBtn");
  const msg = document.getElementById("msg");

  const data = await chrome.storage.local.get([
    "geminiApiKey",
    "extensionEnabled",
    "selectedModel",
    "fontSize"
  ]);

  if (data.geminiApiKey) {
    keyInput.value = data.geminiApiKey;
  }

  if (data.selectedModel) {
    // Users may have saved a model that has since been deprecated/renamed
    // (e.g. the old "gemini-3.1-flash-lite" option). If it isn't in the
    // current list, add it as a "(legacy)" entry instead of silently
    // discarding their choice — they can switch to a supported model.
    if (![...modelSelect.options].some((o) => o.value === data.selectedModel)) {
      const opt = document.createElement("option");
      opt.value = data.selectedModel;
      opt.textContent = `${data.selectedModel} (legacy — may be unavailable)`;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = data.selectedModel;
  }

  if (data.fontSize) {
    fontSizeSelect.value = data.fontSize;
  }

  toggle.checked = data.extensionEnabled !== false;

  function showMessage(text, color = "#16a34a", duration = 3000) {
    msg.style.color = color;
    msg.textContent = text;
    if (duration > 0) {
      setTimeout(() => {
        if (msg.textContent === text) {
          msg.textContent = "";
        }
      }, duration);
    }
  }

  saveBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    const model = modelSelect.value;

    if (!key) {
      showMessage("Please enter a Gemini API key.", "#dc2626");
      return;
    }

    await chrome.storage.local.set({
      geminiApiKey: key,
      selectedModel: model,
      fontSize: fontSizeSelect.value,
      extensionEnabled: toggle.checked
    });

    showMessage("Settings saved successfully!");
  });

  fontSizeSelect.addEventListener("change", async () => {
    await chrome.storage.local.set({ fontSize: fontSizeSelect.value });
    showMessage("Subtitle size updated!");
  });

  toggle.addEventListener("change", async () => {
    await chrome.storage.local.set({
      extensionEnabled: toggle.checked
    });
    showMessage(toggle.checked ? "Extension enabled." : "Extension disabled.");
  });

  testBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    const model = modelSelect.value;

    if (!key) {
      showMessage("Enter an API key first.", "#dc2626");
      return;
    }

    showMessage("Testing API connection...", "#0284c7", 0);

    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(key)}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Translate German 'Guten Tag' to English JSON: ['Hello']" }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      });

      if (res.ok) {
        showMessage("Connection verified! Model active.", "#16a34a");
      } else {
        // The old code claimed "Invalid key or quota" for EVERY failure,
        // which was misleading — a 503 usually means Google's servers are
        // overloaded or the selected model is unavailable, not that the key
        // is bad. Surface the real API error message instead.
        const errorText = await res.text().catch(() => "");
        let detail = "";
        try {
          const parsed = JSON.parse(errorText);
          detail = String(parsed?.error?.message || "").trim();
        } catch (_) {}
        if (!detail) {
          detail = errorText.replace(/\s+/g, " ").trim().slice(0, 200);
        }

        let hint;
        if (res.status === 400 && /not found|unsupported/i.test(detail)) {
          hint = "The selected model doesn't exist. Pick another one.";
        } else if (res.status === 403) {
          hint = "Key rejected — check it is enabled for Generative Language API.";
        } else if (res.status === 429) {
          hint = "Rate limit / free-tier quota reached. Wait and retry.";
        } else if (res.status >= 500) {
          hint = "Google server issue — your key is fine. Try again shortly.";
        } else {
          hint = "Request failed.";
        }

        showMessage(`Error (${res.status}): ${hint}`, "#dc2626", 8000);
        console.error("Test failed:", detail || errorText);
      }
    } catch (err) {
      showMessage("Network test failed: " + (err?.message || err), "#dc2626", 8000);
    }
  });

  clearCacheBtn.addEventListener("click", async () => {
    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter((k) => k.startsWith("cleanSubsCache:"));

    if (keysToRemove.length === 0) {
      showMessage("Cache already empty.", "#64748b");
      return;
    }

    await chrome.storage.local.remove(keysToRemove);
    showMessage(`Cleared ${keysToRemove.length} cached subtitles!`);
  });
});