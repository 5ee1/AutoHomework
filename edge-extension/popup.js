const answersBox = document.querySelector("#answers");
const analysisBox = document.querySelector("#analysis");
const statusBox = document.querySelector("#status");
const bankImportBox = document.querySelector("#bankImport");
const bankCountBox = document.querySelector("#bankCount");
const BANK_KEY = "personalQuestionBank";

function normalizeQuestion(value) {
  const source = String(value || "")
    .replace(/(?:^|\n)\s*[A-H]\s*[.、:：)）]\s*[^\n]*/gim, "")
    .replace(/(?:^|\n)\s*(?:正确答案|参考答案|标准答案|我的答案|你的答案|答案解析|解析|得分)\s*[:：][^\n]*/g, "");
  return source
    .replace(/^\s*\d+\s*[.、)）]\s*/, "")
    .replace(/[（(]\s*(单选题|多选题|判断题|填空题|简答题)\s*[)）]/g, "")
    .replace(/_{2,}\d*_{0,}/g, "空")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function bigrams(value) {
  const normalized = normalizeQuestion(value);
  if (normalized.length < 2) return new Set([normalized]);
  const result = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

async function loadBank() {
  if (chrome.storage?.local) {
    const data = await chrome.storage.local.get(BANK_KEY);
    if (Array.isArray(data[BANK_KEY]) && data[BANK_KEY].length) return data[BANK_KEY];
  }
  try {
    const data = JSON.parse(localStorage.getItem(BANK_KEY) || "[]");
    if (Array.isArray(data) && data.length && chrome.storage?.local) {
      await chrome.storage.local.set({ [BANK_KEY]: data });
    }
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveBank(bank) {
  if (chrome.storage?.local) {
    await chrome.storage.local.set({ [BANK_KEY]: bank });
  } else {
    localStorage.setItem(BANK_KEY, JSON.stringify(bank));
  }
  localStorage.setItem(BANK_KEY, JSON.stringify(bank));
  bankCountBox.textContent = `${bank.length} 题`;
}

function upsertBank(bank, entries) {
  const byKey = new Map(bank.map((entry) => [entry.normalized || normalizeQuestion(entry.question), entry]));
  for (const entry of entries) {
    const normalized = normalizeQuestion(entry.question);
    if (!normalized || !entry.answer) continue;
    byKey.set(normalized, {
      question: String(entry.question).trim(),
      normalized,
      answer: String(entry.answer).trim(),
      updatedAt: new Date().toISOString()
    });
  }
  return [...byKey.values()];
}

function parsePastedBank(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.questions;
    if (Array.isArray(rows)) {
      return rows.map((row) => ({ question: row.question || row.text, answer: row.answer })).filter((row) => row.question && row.answer);
    }
  } catch {}

  const marker = /(?:^|\n)\s*(?:正确答案|参考答案|标准答案|答案)\s*[:：]\s*([^\n]+)/g;
  const matches = [...raw.matchAll(marker)];
  const entries = [];
  let previousEnd = 0;
  for (const match of matches) {
    let question = raw.slice(previousEnd, match.index).trim();
    const numbered = [...question.matchAll(/(?:^|\n)\s*\d+\s*[.、)）]\s*/g)];
    if (numbered.length) question = question.slice(numbered[numbered.length - 1].index).trim();
    question = question
      .replace(/(?:^|\n)\s*(?:我的答案|你的答案|作答结果|得分|解析)\s*[:：][^\n]*/g, "")
      .trim();
    const answer = match[1].replace(/\s*(?:答案解析|解析)\s*[:：].*$/, "").trim();
    if (question && answer) entries.push({ question, answer });
    previousEnd = match.index + match[0].length;
  }
  return entries;
}

function findBankMatch(question, bank) {
  const normalized = normalizeQuestion(question.text);
  const exact = bank.find((entry) => (entry.normalized || normalizeQuestion(entry.question)) === normalized);
  if (exact) return { entry: exact, score: 1 };
  let best = null;
  for (const entry of bank) {
    const score = similarity(question.text, entry.question);
    if (!best || score > best.score) best = { entry, score };
  }
  return best?.score >= 0.88 ? best : null;
}

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
    setBusy(button, true, "正在扫描题目并查询个人题库……");
    const tab = await currentTab();
    const scan = await withTimeout(scanFrames(tab.id), 15000, "Frame scan");
    const questions = scan.frames.flatMap((frame) => frame.questions);
    if (!questions.length) throw new Error("未识别到题目，请先打开包含测验或练习的任务点");

    const bank = await loadBank();
    const rows = Array(questions.length).fill(null);
    const unmatchedQuestions = [];
    const unmatchedIndexes = [];
    let bankHits = 0;
    questions.forEach((question, index) => {
      const match = findBankMatch(question, bank);
      if (match) {
        rows[index] = {
          answer: match.entry.answer,
          confidence: match.score,
          explanation: `来自个人题库（匹配度 ${Math.round(match.score * 100)}%）`
        };
        bankHits += 1;
      } else {
        unmatchedQuestions.push(question);
        unmatchedIndexes.push(index);
      }
    });

    if (unmatchedQuestions.length) {
      statusBox.textContent = `题库命中 ${bankHits}/${questions.length}，其余 ${unmatchedQuestions.length} 道正在调用 AI……`;
      const aiRows = await withTimeout(requestAnalysis(unmatchedQuestions), 180000, "AI analysis");
      unmatchedIndexes.forEach((originalIndex, aiIndex) => {
        rows[originalIndex] = aiRows[aiIndex] || {
          answer: "",
          confidence: 0,
          explanation: "AI 未返回结果"
        };
      });
    }

    answersBox.value = rows.map((row) => row?.answer || "").join("\n");
    analysisBox.value = rows.map((row, index) =>
      `${index + 1}. 答案：${row?.answer || ""}\n置信度：${Math.round((row?.confidence || 0) * 100)}%\n理由：${row?.explanation || ""}`
    ).join("\n\n");
    statusBox.textContent = `已分析 ${rows.length} 道题，个人题库命中 ${bankHits} 道，请检查后填写。`;
  } catch (error) {
    statusBox.textContent = `分析失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#analyzeLegacy")?.addEventListener("click", async (event) => {
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

document.querySelector("#saveBank").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "正在读取当前页面并保存到个人题库……");
    const tab = await currentTab();
    const scan = await withTimeout(scanFrames(tab.id), 15000, "Frame scan");
    const questions = scan.frames.flatMap((frame) => frame.questions);
    const answers = answersBox.value.split(/\r?\n/).map((answer) => answer.trim());
    const entries = questions.map((question, index) => ({
      question: question.text,
      answer: answers[index]
    })).filter((entry) => entry.answer);
    if (!entries.length) throw new Error("没有可保存的题目与答案");
    const bank = upsertBank(await loadBank(), entries);
    await saveBank(bank);
    statusBox.textContent = `已保存或更新 ${entries.length} 道题，题库现有 ${bank.length} 道。`;
  } catch (error) {
    statusBox.textContent = `保存题库失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#importBank").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    setBusy(button, true, "正在解析粘贴内容……");
    const entries = parsePastedBank(bankImportBox.value);
    if (!entries.length) {
      throw new Error("没有识别到“正确答案：”“参考答案：”或可用的 JSON 题库内容");
    }
    const bank = upsertBank(await loadBank(), entries);
    await saveBank(bank);
    statusBox.textContent = `已从粘贴内容导入 ${entries.length} 道题，题库现有 ${bank.length} 道。`;
  } catch (error) {
    statusBox.textContent = `导入失败：${error.message}`;
  } finally {
    setBusy(button, false);
  }
});

document.querySelector("#exportBank").addEventListener("click", async () => {
  try {
    const bank = await loadBank();
    await navigator.clipboard.writeText(JSON.stringify({ questions: bank }, null, 2));
    statusBox.textContent = `已复制 ${bank.length} 道题的 JSON 备份。`;
  } catch (error) {
    statusBox.textContent = `复制题库失败：${error.message}`;
  }
});

loadBank().then((bank) => {
  bankCountBox.textContent = `${bank.length} 题`;
});
