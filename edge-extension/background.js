function resultKey(url) {
  try {
    const parsed = new URL(url);
    return `analysis:${parsed.origin}${parsed.pathname}?workId=${parsed.searchParams.get("workId") || ""}`;
  } catch {
    return "";
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "AUTO_ANALYZE" || !message.questions?.length) return;

  fetch("http://127.0.0.1:3210/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions: message.questions })
  })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "本地 AI 服务请求失败");
      const key = resultKey(message.url);
      if (key) await chrome.storage.local.set({ [key]: result });
      if (sender.tab?.id) {
        await chrome.action.setBadgeText({ tabId: sender.tab.id, text: "AI" });
        await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#2563eb" });
      }
    })
    .catch(async () => {
      if (sender.tab?.id) {
        await chrome.action.setBadgeText({ tabId: sender.tab.id, text: "!" });
        await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#dc2626" });
      }
    });
});
