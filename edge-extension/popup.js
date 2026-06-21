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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds))
  ]);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Current page was not found");
  return tab;
}

function frameScanner() {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const unique = (items) => [...new Set(items.filter(Boolean))];
  const selectors = [
    ".questionLi",
    ".TiMu",
    ".mark_item",
    ".question-item",
    ".questionItem",
    "[data-questionid]",
    "[data-question-id]",
    "[id^='question']"
  ];
  let blocks = [];
  for (const selector of selectors) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length) {
      blocks = found;
      break;
    }
  }
  if (!blocks.length) {
    const controls = [...document.querySelectorAll("input[type='radio'],input[type='checkbox'],textarea,[contenteditable='true']")];
    blocks = unique(controls.map((control) =>
      control.closest(".TiMu,.mark_item,.question-item,.questionItem,fieldset,li,.clearfix")
    ));
  }

  const questions = blocks.map((block, index) => {
    const answerType = block.querySelector("input[id^='answertype'],input[name^='answertype']")?.value ?? null;
    const nativeOptions = [...block.querySelectorAll("input[type='radio'],input[type='checkbox']")];
    const customOptions = [...block.querySelectorAll(
      ".answerBg[onclick*='addChoice'],[onclick='addChoice(this);'],.Zy_ulTop > li,.answer_p,[role='radio'],[role='checkbox']"
    )];
    const options = (nativeOptions.length ? nativeOptions : customOptions)
      .map((option) => {
        if (!option.matches("input")) return clean(option.innerText);
        const label = option.closest("label") ||
          (option.id ? document.querySelector(`label[for="${CSS.escape(option.id)}"]`) : null);
        return clean(label?.innerText || option.parentElement?.innerText || option.value);
      })
      .filter(Boolean);
    const text = clean(
      block.querySelector(".mark_name,.question-title,.subject,.stem,.topic")?.innerText ||
      block.innerText
    );
    const hasTextField = !!block.querySelector("textarea,input[type='text'],[contenteditable='true']");
    return {
      index: index + 1,
      type: answerType === "2" || (!options.length && hasTextField)
        ? "fill_in_the_blank"
        : answerType === "1" || nativeOptions.some((input) => input.type === "checkbox")
          ? "multiple_choice"
          : "single_choice",
      answerType,
      text,
      options
    };
  }).filter((question) => question.text && (question.options.length || question.type === "fill_in_the_blank"));
  return { url: location.href, title: document.title, questions };
}

async function scanFrames(tabId) {
  const navigationFrames = await chrome.webNavigation.getAllFrames({ tabId });
  const scans = await Promise.all((navigationFrames || [{ frameId: 0 }]).map(async (frame) => {
    try {
      const [execution] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: frameScanner
      }), 2500, `Frame ${frame.frameId}`);
      return execution?.result
        ? { frameId: frame.frameId, ...execution.result, skipped: false }
        : null;
    } catch (error) {
      return { frameId: frame.frameId, url: frame.url, questions: [], skipped: true, error: error.message };
    }
  }));
  const available = scans.filter(Boolean);
  return {
    frames: available
      .filter((frame) => frame.questions?.length)
      .sort((a, b) => a.frameId - b.frameId),
    scanned: available.length,
    skipped: available.filter((frame) => frame.skipped).length
  };
}

async function requestAnalysis(questions) {
  const response = await fetch("http://127.0.0.1:3210/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questions })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Local AI service request failed");
  return result.answers || [];
}

function parseAnswers() {
  return answersBox.value.split(/\r?\n/).map((answer) => answer.trim()).filter(Boolean);
}

function frameFiller(frameAnswers) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const choiceParts = (answer) => String(answer || "").split(/[,|;\s]+/)
    .map((part) => part.trim().toUpperCase()).filter(Boolean);
  const optionLetter = (option) =>
    clean(option.innerText).match(/^([A-H])(?:\s|[.、:：)])/i)?.[1]?.toUpperCase();
  const splitBlanks = (answer, count) => {
    const raw = String(answer || "");
    if (count <= 1) return [raw];
    for (const separator of [/\s*\|\|\s*/, /\s*;;\s*/, /\s*[;；]\s*/, /\s*[,，、]\s*/]) {
      const parts = raw.split(separator).map((part) => part.trim()).filter(Boolean);
      if (parts.length === count) return parts;
    }
    return Array(count).fill(raw);
  };
  const selectors = [
    ".questionLi", ".TiMu", ".mark_item", ".question-item", ".questionItem",
    "[data-questionid]", "[data-question-id]", "[id^='question']"
  ];
  let blocks = [];
  for (const selector of selectors) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length) {
      blocks = found;
      break;
    }
  }
  const details = [];

  blocks.forEach((block, index) => {
    const answer = frameAnswers[index];
    if (!answer) return;
    const answerType = block.querySelector("input[id^='answertype'],input[name^='answertype']")?.value;
    const questionId = String(block.id || "").replace(/^question/, "");

    if (answerType === "2") {
      const editors = [...block.querySelectorAll(`textarea[id^="answerEditor${questionId}"]`)]
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
    const hiddenAnswer = questionId ? block.querySelector(`#answer${CSS.escape(questionId)}`) : null;
    const nativeOptions = [...block.querySelectorAll("input[type='radio'],input[type='checkbox']")];
    const customOptions = [...block.querySelectorAll(
      ".answerBg[onclick*='addChoice'],[onclick='addChoice(this);'],.Zy_ulTop > li,.answer_p,[role='radio'],[role='checkbox']"
    )];
    const options = nativeOptions.length ? nativeOptions : customOptions;
    const matches = options.filter((option) => {
      const label = option.matches("input")
        ? option.closest("label") || (option.id ? document.querySelector(`label[for="${CSS.escape(option.id)}"]`) : null)
        : option;
      const text = clean(label?.innerText || option.parentElement?.innerText || option.value).toUpperCase();
      const letter = optionLetter(label || option);
      return wanted.some((part) => part === letter || part === text);
    });
    if (hiddenAnswer) hiddenAnswer.value = "";
    matches.forEach((option) => {
      if (typeof window.addChoice === "function" && option.matches(".answerBg,[onclick*='addChoice']")) {
        window.addChoice(option);
      } else {
        const target = option.matches("input") ? option.closest("label") || option : option;
        target.click();
      }
    });
    const recorded = hiddenAnswer
      ? String(hiddenAnswer.value || "").trim().length > 0
      : matches.every((option) => !option.matches("input") || option.checked);
    if (matches.length) {
      details.push({ index: index + 1, ok: recorded });
      return;
    }

    const fields = [...block.querySelectorAll("textarea,input[type='text'],[contenteditable='true']")];
    const values = splitBlanks(answer, fields.length);
    let verified = 0;
    fields.forEach((field, fieldIndex) => {
      const value = values[fieldIndex] ?? values[0] ?? "";
      if (field.isContentEditable) field.textContent = value;
      else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      if (clean(field.isContentEditable ? field.innerText : field.value)) verified += 1;
    });
    details.push({ index: index + 1, ok: fields.length > 0 && verified === fields.length });
  });
  return { completed: details.filter((detail) => detail.ok).length, total: frameAnswers.length, details };
}

async function fillFrames(tabId, frames, answers) {
  let cursor = 0;
  let completed = 0;
  const failed = [];
  for (const frame of frames) {
    const batch = answers.slice(cursor, cursor + frame.questions.length);
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frame.frameId] },
      world: "MAIN",
      args: [batch],
      func: frameFiller
    });
    const result = execution?.result || { completed: 0, details: [] };
    completed += result.completed;
    result.details.filter((detail) => !detail.ok).forEach((detail) => failed.push(cursor + detail.index));
    cursor += frame.questions.length;
  }
  return { completed, total: cursor, failed };
}

document.querySelector("#analyze").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "正在扫描当前页面及任务点……");
    const tab = await currentTab();
    const scan = await withTimeout(scanFrames(tab.id), 15000, "Frame scan");
    const frames = scan.frames;
    const questions = frames.flatMap((frame) => frame.questions);
    if (!questions.length) throw new Error("未识别到题目，请先打开包含测验或练习的任务点");
    statusBox.textContent = `已在 ${frames.length} 个页面区域识别 ${questions.length} 道题，跳过 ${scan.skipped} 个超时区域，正在调用 AI……`;
    const rows = await withTimeout(requestAnalysis(questions), 180000, "AI analysis");
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
    setBusy(button, true, "正在扫描并填写当前页面及任务点……");
    const tab = await currentTab();
    const scan = await withTimeout(scanFrames(tab.id), 15000, "Frame scan");
    const frames = scan.frames;
    const answers = parseAnswers();
    if (!answers.length) throw new Error("没有可填写的答案，请先分析题目");
    const result = await withTimeout(fillFrames(tab.id, frames, answers), 30000, "Fill");
    statusBox.textContent = `已填写并验证 ${result.completed}/${result.total} 道题。${result.failed.length ? `失败题号：${result.failed.join(",")}` : "请提交前自行检查。"}`;
  } catch (error) {
    statusBox.textContent = `填写失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});
