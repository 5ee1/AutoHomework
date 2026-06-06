const answersBox = document.querySelector("#answers");
const analysisBox = document.querySelector("#analysis");
const statusBox = document.querySelector("#status");

function setBusy(button, busy, message) {
  button.disabled = busy;
  if (message) statusBox.textContent = message;
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超时`)), milliseconds))
  ]);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("未找到当前页面");
  return tab;
}

async function extractQuestions(tabId) {
  const result = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_QUESTIONS" });
  if (!result?.questions?.length) throw new Error("当前页面未识别到超星作业题目");
  return result.questions;
}

async function requestAnalysis(questions) {
  const response = await fetch("http://127.0.0.1:3210/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "本地 AI 服务请求失败");
  return result.answers || [];
}

function parseAnswers() {
  return answersBox.value.split(/\r?\n/).map((answer) => answer.trim()).filter(Boolean);
}

async function fillChaoxing(tabId, answers) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    args: [answers],
    func: (allAnswers) => {
      const splitBlanks = (answer, count) => {
        const raw = String(answer || "");
        if (count <= 1) return [raw];
        for (const separator of [/\s*\|\|\s*/, /\s*;;\s*/, /\s*[;；]\s*/, /\s*[,，、]\s*/]) {
          const parts = raw.split(separator).map((part) => part.trim()).filter(Boolean);
          if (parts.length === count) return parts;
        }
        return Array(count).fill(raw);
      };
      const choiceParts = (answer) => String(answer || "").split(/[,|;\s]+/)
        .map((part) => part.trim().toUpperCase()).filter(Boolean);
      const optionLetter = (option) =>
        String(option.innerText || "").trim().match(/^([A-H])(?:\s|[.、:：)])/i)?.[1]?.toUpperCase();
      const details = [];

      [...document.querySelectorAll(".questionLi")].forEach((question, index) => {
        const answer = allAnswers[index];
        const answerType = question.querySelector("input[id^='answertype'],input[name^='answertype']")?.value;
        const questionId = String(question.id || "").replace(/^question/, "");
        if (!answer) {
          details.push({ index: index + 1, ok: false, reason: "missing_answer" });
          return;
        }

        if (answerType === "2") {
          const editors = [...question.querySelectorAll(`textarea[id^="answerEditor${questionId}"]`)]
            .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
          const values = splitBlanks(answer, editors.length);
          let verified = 0;
          editors.forEach((textarea, editorIndex) => {
            const value = values[editorIndex] ?? values[0] ?? "";
            try {
              const editor = window.UE?.getEditor?.(textarea.id);
              editor?.setContent(value);
              editor?.sync();
            } catch {}
            textarea.value = value;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
            if (textarea.value.trim()) verified += 1;
          });
          details.push({ index: index + 1, ok: editors.length > 0 && verified === editors.length });
          return;
        }

        const wanted = choiceParts(answer);
        const hiddenAnswer = question.querySelector(`#answer${CSS.escape(questionId)}`);
        const options = [...question.querySelectorAll(".answerBg[onclick*='addChoice'],[onclick='addChoice(this);']")];
        const matches = options.filter((option) => {
          const letter = optionLetter(option);
          const text = String(option.innerText || "").trim().toUpperCase();
          return wanted.some((part) => part === letter || part === text);
        });
        if (hiddenAnswer) hiddenAnswer.value = "";
        matches.forEach((option) => typeof window.addChoice === "function" ? window.addChoice(option) : option.click());
        hiddenAnswer?.dispatchEvent(new Event("input", { bubbles: true }));
        hiddenAnswer?.dispatchEvent(new Event("change", { bubbles: true }));
        details.push({ index: index + 1, ok: matches.length > 0 && String(hiddenAnswer?.value || "").trim().length > 0 });
      });
      return { completed: details.filter((detail) => detail.ok).length, total: details.length, details };
    }
  });
  return execution?.result;
}

document.querySelector("#analyze").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "正在提取题目并调用 AI 分析……");
    const tab = await currentTab();
    const questions = await withTimeout(extractQuestions(tab.id), 10000, "提取题目");
    const rows = await withTimeout(requestAnalysis(questions), 180000, "AI 分析");
    answersBox.value = rows.map((row) => row.answer).join("\n");
    analysisBox.value = rows.map((row, index) =>
      `${index + 1}. 答案：${row.answer}\n置信度：${Math.round(row.confidence * 100)}%\n理由：${row.explanation}`
    ).join("\n\n");
    statusBox.textContent = `已分析 ${rows.length} 道题，请检查后填写。`;
  } catch (error) {
    statusBox.textContent = `分析失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#fill").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "正在填写并验证页面记录……");
    const tab = await currentTab();
    const answers = parseAnswers();
    if (!answers.length) throw new Error("没有可填写的答案，请先分析题目");
    const result = await withTimeout(fillChaoxing(tab.id, answers), 20000, "填写答案");
    const failed = result.details.filter((detail) => !detail.ok).map((detail) => detail.index);
    statusBox.textContent = `已填写并验证 ${result.completed}/${result.total} 道题。${failed.length ? `失败题号：${failed.join(",")}` : "请提交前自行检查。"}`;
  } catch (error) {
    statusBox.textContent = `填写失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});
