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

    // Route the test through the background service worker, which uses the
    // same resilient path as real translation jobs: transient 5xx errors are
    // retried with backoff, and if the selected model has been retired
    // (404 "no longer available"), we automatically fall back to a working
    // model instead of failing with a misleading "Test failed" message.
    try {
      const res = await chrome.runtime.sendMessage({
        action: "TEST_CONNECTION",
        apiKey: key,
        model
      });

      if (res?.ok) {
        if (res.modelUsed && res.modelUsed !== model) {
          showMessage(
            `Connection verified! "${model}" is unavailable, so "${res.modelUsed}" was used — update the model dropdown and save.`,
            "#d97706",
            10000
          );
        } else {
          showMessage("Connection verified! Model active.", "#16a34a");
        }
      } else {
        showMessage(
          `Test failed: ${res?.message || "Unknown error."}${res?.details ? ` (${res.details.slice(0, 160)})` : ""}`,
          "#dc2626",
          10000
        );
      }
    } catch (err) {
      showMessage("Could not reach the extension background worker: " + (err?.message || err), "#dc2626", 8000);
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