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
        const errorText = await res.text();
        showMessage(`Error (${res.status}): Invalid key or quota.`, "#dc2626");
        console.error("Test failed:", errorText);
      }
    } catch (err) {
      showMessage("Network test failed.", "#dc2626");
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