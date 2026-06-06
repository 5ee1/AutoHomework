const enabled = document.querySelector("#enabled");
const targetUrl = document.querySelector("#targetUrl");
const answers = document.querySelector("#answers");
const questions = document.querySelector("#questions");
const analysis = document.querySelector("#analysis");
const status = document.querySelector("#status");

function resultKey(url) {
  try {
    const parsed = new URL(url);
    return `analysis:${parsed.origin}${parsed.pathname}?workId=${parsed.searchParams.get("workId") || ""}`;
  } catch {
    return "";
  }
}

function showAnalysis(rows) {
  analysis.value = rows.map((row, index) =>
    `${index + 1}. 答案：${row.answer}\n置信度：${Math.round(row.confidence * 100)}%\n理由：${row.explanation}`
  ).join("\n\n");
  answers.value = rows.map((row) => row.answer).join("\n");
}

function parseAnswers(text) {
  return text
    .split(/\r?\n/)
    .map((answer) => answer.trim())
    .filter(Boolean);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
      milliseconds
    ))
  ]);
}

async function injectedEditableScan(tabId) {
  const results = await withTimeout(chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const visible = (element) => {
        if (!element || element.disabled || element.readOnly) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          rect.width >= 20 && rect.height >= 10;
      };
      const collect = (root, output) => {
        const selector = [
          "textarea",
          "input[type='text']",
          "input:not([type])",
          "[contenteditable='true']",
          ".cke_editable",
          ".tox-edit-area",
          ".wangEditor-txt",
          ".edui-body-container"
        ].join(",");
        output.push(...root.querySelectorAll(selector));
        for (const element of [...root.querySelectorAll("*")].slice(0, 3000)) {
          if (element.shadowRoot) collect(element.shadowRoot, output);
        }
      };
      const fields = [];
      collect(document, fields);
      if (document.body?.isContentEditable) fields.unshift(document.body);
      const usable = [...new Set(fields)].filter(visible).filter((field) => {
        const identity = `${field.name || ""} ${field.id || ""} ${field.className || ""} ${field.getAttribute?.("placeholder") || ""}`.toLowerCase();
        return !/search|keyword|phone|mobile|account|username|password|captcha|verify|code/.test(identity);
      });
      return {
        url: location.href,
        title: document.title,
        capacity: usable.length,
        fields: usable.slice(0, 12).map((field) => ({
          tag: field.tagName,
          id: field.id,
          className: String(field.className).slice(0, 120)
        }))
      };
    }
  }), 8000, "Editable frame scan");
  return results || [];
}

async function injectedFillFrame(tabId, frameId, answers) {
  const [result] = await withTimeout(chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    args: [answers],
    func: (values) => {
      const visible = (element) => {
        if (!element || element.disabled || element.readOnly) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          rect.width >= 20 && rect.height >= 10;
      };
      const collect = (root, output) => {
        const selector = "textarea,input[type='text'],input:not([type]),[contenteditable='true'],.cke_editable,.wangEditor-txt,.edui-body-container";
        output.push(...root.querySelectorAll(selector));
        for (const element of [...root.querySelectorAll("*")].slice(0, 3000)) {
          if (element.shadowRoot) collect(element.shadowRoot, output);
        }
      };
      const fields = [];
      collect(document, fields);
      if (document.body?.isContentEditable) fields.unshift(document.body);
      const usable = [...new Set(fields)].filter(visible).filter((field) => {
        const identity = `${field.name || ""} ${field.id || ""} ${field.className || ""} ${field.getAttribute?.("placeholder") || ""}`.toLowerCase();
        return !/search|keyword|phone|mobile|account|username|password|captcha|verify|code/.test(identity);
      });

      let verified = 0;
      usable.slice(0, values.length).forEach((field, index) => {
        const value = String(values[index]);
        field.focus();
        if (field.isContentEditable) {
          field.innerHTML = "";
          field.textContent = value;
        } else {
          const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          setter ? setter.call(field, value) : field.value = value;
        }
        for (const type of ["input", "change", "keyup", "blur"]) {
          field.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
        }
        const actual = String(field.isContentEditable ? field.innerText : field.value).trim();
        if (actual) verified += 1;
      });
      return { attempted: Math.min(usable.length, values.length), verified, capacity: usable.length };
    }
  }), 5000, "Editable frame fill");
  return result?.result || { attempted: 0, verified: 0, capacity: 0 };
}

async function fillChaoxingUEditors(tabId, answers, failedIndexes) {
  const [execution] = await withTimeout(chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    args: [answers, failedIndexes],
    func: (allAnswers, indexes) => {
      const splitForBlanks = (answer, count) => {
        const raw = String(answer || "");
        if (count <= 1) return [raw];
        const separators = [/\s*\|\|\s*/, /\s*;;\s*/, /\s*[;；]\s*/, /\s*[,，、]\s*/];
        for (const separator of separators) {
          const parts = raw.split(separator).map((part) => part.trim()).filter(Boolean);
          if (parts.length === count) return parts;
        }
        return Array(count).fill(raw);
      };

      let verified = 0;
      const details = [];
      for (const oneBasedIndex of indexes) {
        const answer = allAnswers[oneBasedIndex - 1];
        const questions = [...document.querySelectorAll(".questionLi")];
        const question = questions[oneBasedIndex - 1];
        if (!question || !answer) {
          details.push({ index: oneBasedIndex, ok: false, reason: "question_or_answer_missing" });
          continue;
        }

        const questionId = String(question.id || "").replace(/^question/, "");
        const answerType = question.querySelector("input[id^='answertype'], input[name^='answertype']")?.value;
        if (answerType !== "2") {
          details.push({ index: oneBasedIndex, ok: false, skipped: true, reason: `answerType_${answerType}` });
          continue;
        }
        const editors = [...question.querySelectorAll(`textarea[id^="answerEditor${questionId}"]`)]
          .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
        const values = splitForBlanks(answer, editors.length);
        let questionVerified = 0;

        editors.forEach((textarea, editorIndex) => {
          const value = values[editorIndex] ?? values[0] ?? "";
          try {
            const editor = window.UE?.getEditor?.(textarea.id);
            if (editor) {
              editor.setContent(value);
              editor.sync();
            }
          } catch {
            // Hidden textarea write below is still required by the form.
          }
          textarea.value = value;
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
          textarea.dispatchEvent(new Event("change", { bubbles: true }));
          if (textarea.value.trim()) questionVerified += 1;
        });

        verified += questionVerified;
        details.push({
          index: oneBasedIndex,
          questionId,
          editors: editors.length,
          verified: questionVerified,
          ok: editors.length > 0 && questionVerified === editors.length
        });
      }
      return { verified, details };
    }
  }), 8000, "Chaoxing UEditor fill");
  return execution?.result || { verified: 0, details: [] };
}

async function fillChaoxingChoices(tabId, answers) {
  const [execution] = await withTimeout(chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    args: [answers],
    func: (allAnswers) => {
      const parts = (answer) => String(answer || "")
        .split(/[,|;\s]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
      const optionLetter = (option) =>
        String(option.innerText || "").trim().match(/^([A-H])(?:\s|[.、:：)])/i)?.[1]?.toUpperCase();

      const details = [];
      const questions = [...document.querySelectorAll(".questionLi")];
      questions.forEach((question, index) => {
        const answerType = question.querySelector("input[id^='answertype'],input[name^='answertype']")?.value;
        if (answerType === "2") return;

        const answer = allAnswers[index];
        const wanted = parts(answer);
        const questionId = String(question.id || "").replace(/^question/, "");
        const hiddenAnswer = question.querySelector(`#answer${CSS.escape(questionId)}`);
        const options = [...question.querySelectorAll(".answerBg[onclick*='addChoice'], [onclick='addChoice(this);']")];
        const matches = options.filter((option) => {
          const letter = optionLetter(option);
          const text = String(option.innerText || "").trim().toUpperCase();
          return wanted.some((item) => item === letter || item === text || (item.length > 1 && text.includes(item)));
        });

        if (hiddenAnswer) hiddenAnswer.value = "";
        options.forEach((option) => {
          option.classList.remove("check_answer", "answer_active", "active", "cur", "checked");
        });

        let invoked = 0;
        matches.forEach((option) => {
          try {
            if (typeof window.addChoice === "function") window.addChoice(option);
            else option.click();
            invoked += 1;
          } catch {
            option.click();
            invoked += 1;
          }
        });

        hiddenAnswer?.dispatchEvent(new Event("input", { bubbles: true }));
        hiddenAnswer?.dispatchEvent(new Event("change", { bubbles: true }));
        const recorded = String(hiddenAnswer?.value || "").trim();
        details.push({
          index: index + 1,
          answerType,
          wanted,
          options: options.length,
          matches: matches.length,
          invoked,
          recorded,
          ok: matches.length > 0 && recorded.length > 0
        });
      });
      return {
        completed: details.filter((detail) => detail.ok).length,
        total: details.length,
        details
      };
    }
  }), 8000, "Chaoxing choice fill");
  return execution?.result || { completed: 0, total: 0, details: [] };
}

async function diagnoseEditableFrame(tabId, frameId) {
  return withTimeout(chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: () => {
      const brief = (element) => ({
        tag: element.tagName,
        type: element.getAttribute("type"),
        id: element.id,
        name: element.getAttribute("name"),
        className: String(element.className || "").slice(0, 160),
        role: element.getAttribute("role"),
        contenteditable: element.getAttribute("contenteditable"),
        placeholder: element.getAttribute("placeholder"),
        src: element.getAttribute("src")?.slice(0, 180),
        text: String(element.innerText || element.value || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120)
      });
      const selector = [
        "input",
        "textarea",
        "iframe",
        "[contenteditable]",
        "[class*='blank']",
        "[class*='fill']",
        "[class*='editor']",
        "[class*='answer']"
      ].join(",");
      const controls = [...document.querySelectorAll(selector)].slice(-50).map(brief);
      const questions = [
        ...document.querySelectorAll(".questionLi,.question-list-item,.subject_node,.TiMu,.mark_item,.question-item,[data-questionid],[data-question-id],[id^='question']")
      ].slice(-4).map((element, index) => ({
        index,
        tag: element.tagName,
        id: element.id,
        className: String(element.className || "").slice(0, 160),
        text: String(element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
        html: element.innerHTML.slice(0, 600)
      }));
      return {
        url: location.href,
        title: document.title,
        bodyEditable: document.body?.isContentEditable || false,
        controls,
        questions
      };
    }
  }), 1500, `Diagnostic frame ${frameId}`);
}

async function sendToPage(message) {
  const tab = await currentTab();
  if (!tab?.id) throw new Error("未找到当前页面");
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const results = await Promise.all((frames || [{ frameId: 0 }]).map(async (frame) => {
    try {
      return await chrome.tabs.sendMessage(tab.id, message, { frameId: frame.frameId });
    } catch {
      return null;
    }
  }));

  const valid = results.filter(Boolean);
  if (!valid.length) throw new Error("页面中没有找到扩展脚本，请刷新作业页面后重试");
  if (message.type === "FILL") {
    const best = valid.sort((a, b) => (b.filled || 0) - (a.filled || 0))[0];
    let chaoxingChoices = { completed: 0, total: 0, details: [] };
    try {
      chaoxingChoices = await fillChaoxingChoices(tab.id, message.answers);
      best.message += ` Chaoxing choices recorded: ${chaoxingChoices.completed}/${chaoxingChoices.total}.`;
    } catch (error) {
      best.message += ` Choice error: ${error.message}.`;
    }
    const failedAnswers = (best.details || [])
      .filter((detail) => !detail.ok)
      .map((detail) => message.answers[detail.index - 1])
      .filter((answer) => answer && !/^[A-H](?:\s*[,|;]\s*[A-H])*$/i.test(answer));

    if (failedAnswers.length) {
      const failedIndexes = (best.details || [])
        .filter((detail) => !detail.ok)
        .map((detail) => detail.index)
        .filter((index) => {
          const answer = message.answers[index - 1];
          return answer && !/^[A-H](?:\s*[,|;]\s*[A-H])*$/i.test(answer);
        });
      try {
        const ueditor = await fillChaoxingUEditors(tab.id, message.answers, failedIndexes);
        const completedQuestions = ueditor.details.filter((detail) => detail.ok).length;
        best.filled = chaoxingChoices.completed + completedQuestions;
        best.message = `Final filled ${best.filled}/${best.total}; Chaoxing choices recorded ${chaoxingChoices.completed}/${chaoxingChoices.total}, UEditor ${completedQuestions}/${failedIndexes.length} questions, ${ueditor.verified} blanks verified.`;
        if (completedQuestions === failedIndexes.length) return best;
      } catch (error) {
        best.message += ` UEditor error: ${error.message}.`;
      }

      let cursor = 0;
      let iframeVerified = 0;
      for (const frame of frames || []) {
        if (frame.frameId === 0 || cursor >= failedAnswers.length) continue;
        try {
          const capacity = await chrome.tabs.sendMessage(
            tab.id,
            { type: "TEXT_CAPACITY" },
            { frameId: frame.frameId }
          );
          if (!capacity?.capacity) continue;
          const batch = failedAnswers.slice(cursor, cursor + capacity.capacity);
          const result = await chrome.tabs.sendMessage(
            tab.id,
            { type: "FILL_TEXT_SEQUENCE", answers: batch },
            { frameId: frame.frameId }
          );
          cursor += result?.attempted || 0;
          iframeVerified += result?.verified || 0;
        } catch {
          // Ignore frames without an accessible editor.
        }
      }
      if (iframeVerified < failedAnswers.length) {
        try {
          const scans = await injectedEditableScan(tab.id);
          let remainingCursor = iframeVerified;
          for (const scan of scans) {
            if (!scan.result?.capacity || remainingCursor >= failedAnswers.length) continue;
            const batch = failedAnswers.slice(
              remainingCursor,
              remainingCursor + scan.result.capacity
            );
            const result = await injectedFillFrame(tab.id, scan.frameId, batch);
            remainingCursor += result.attempted || 0;
            iframeVerified += result.verified || 0;
          }
          best.message += ` Injected frame capacities: ${scans.map((scan) => scan.result?.capacity || 0).join(",")}.`;
        } catch (error) {
          best.message += ` Injection error: ${error.message}.`;
        }
      }
      best.filled += iframeVerified;
      best.message = `Final filled ${best.filled}/${best.total}. ${best.message} Rich-text iframe verified: ${iframeVerified}/${failedAnswers.length}.`;
    }
    return best;
  }
  if (message.type === "EXTRACT_STRUCTURED" || message.type === "EXTRACT") {
    return valid.sort((a, b) => (b.questions?.length || 0) - (a.questions?.length || 0))[0];
  }
  return valid[0];
}

async function fillWithTimeout(message) {
  return withTimeout(sendToPage(message), 20000, "Whole fill operation");
}

async function load() {
  const tab = await currentTab();
  const data = await chrome.storage.local.get(["enabled", "targetUrl", "answers"]);
  enabled.checked = data.enabled === true;
  targetUrl.value = data.targetUrl || tab?.url || "";
  answers.value = (data.answers || []).join("\n");
  const key = resultKey(tab?.url || "");
  if (key) {
    const cached = await chrome.storage.local.get(key);
    const result = cached[key];
    if (result?.answers?.length) {
      showAnalysis(result.answers);
      status.textContent = "已加载当前页面的自动 AI 分析结果，请检查后填写。";
    }
  }
}

document.querySelector("#saveFill").addEventListener("click", async () => {
  const button = document.querySelector("#saveFill");
  try {
    button.disabled = true;
    status.textContent = "正在填写并检查页面，请稍候……";
    const data = {
      enabled: enabled.checked,
      targetUrl: targetUrl.value.trim(),
      answers: parseAnswers(answers.value)
    };
    await chrome.storage.local.set(data);
    const result = await fillWithTimeout({ type: "FILL", answers: data.answers });
    status.textContent = result?.message || "已保存。";
  } catch (error) {
    status.textContent = "填写失败：" + error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#extract").addEventListener("click", async () => {
  try {
    const result = await sendToPage({ type: "EXTRACT" });
    questions.value = (result?.questions || []).join("\n\n");
    status.textContent = `已提取 ${result?.questions?.length || 0} 道题。`;
  } catch (error) {
    status.textContent = "提取失败：" + error.message;
  }
});

document.querySelector("#diagnose").addEventListener("click", async () => {
  try {
    status.textContent = "正在扫描填空控件……";
    const tab = await currentTab();
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const report = [];
    const skipped = [];
    for (const frame of frames || [{ frameId: 0 }]) {
      try {
        const [result] = await diagnoseEditableFrame(tab.id, frame.frameId);
        if (result?.result) report.push({ frameId: frame.frameId, ...result.result });
      } catch (error) {
        skipped.push({ frameId: frame.frameId, error: error.message });
      }
    }
    report.push({ skipped });
    analysis.value = JSON.stringify(report, null, 2);
    await navigator.clipboard.writeText(analysis.value);
    status.textContent = `诊断完成，成功 ${report.length - 1} 个，跳过 ${skipped.length} 个 frame；报告已复制。`;
  } catch (error) {
    status.textContent = "诊断失败：" + error.message;
  }
});

document.querySelector("#diagnoseChoices").addEventListener("click", async () => {
  try {
    status.textContent = "正在扫描选择题控件……";
    const tab = await currentTab();
    const [execution] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: () => {
        const brief = (element) => ({
          tag: element.tagName,
          type: element.getAttribute("type"),
          id: element.id,
          name: element.getAttribute("name"),
          value: element.getAttribute("value"),
          checked: "checked" in element ? element.checked : undefined,
          className: String(element.className || "").slice(0, 180),
          onclick: element.getAttribute("onclick")?.slice(0, 240),
          text: String(element.innerText || element.parentElement?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240)
        });
        return [...document.querySelectorAll(".questionLi")].slice(0, 20).map((question, index) => ({
          index: index + 1,
          id: question.id,
          answerType: question.querySelector("input[id^='answertype'],input[name^='answertype']")?.value,
          text: String(question.querySelector(".mark_name")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 260),
          controls: [...question.querySelectorAll("input, label, .stem_answer li, .stem_answer a, [onclick]")]
            .slice(0, 40)
            .map(brief)
        }));
      }
    }), 5000, "Choice diagnostic");
    analysis.value = JSON.stringify(execution?.result || [], null, 2);
    await navigator.clipboard.writeText(analysis.value);
    status.textContent = "选择题诊断完成，报告已复制到剪贴板。";
  } catch (error) {
    status.textContent = "选择题诊断失败：" + error.message;
  }
});

document.querySelector("#analyze").addEventListener("click", async () => {
  try {
    status.textContent = "AI 正在分析，请稍候……";
    const extracted = await sendToPage({ type: "EXTRACT_STRUCTURED" });
    if (!extracted?.questions?.length) throw new Error("当前页面未提取到题目");

    const response = await fetch("http://127.0.0.1:3210/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions: extracted.questions })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "本地 AI 服务请求失败");

    const rows = result.answers || [];
    showAnalysis(rows);
    status.textContent = `AI 已分析 ${rows.length} 道题。请检查结果后点击“保存并立即填写”。`;
  } catch (error) {
    status.textContent = "AI 分析失败：" + error.message;
  }
});

enabled.addEventListener("change", async () => {
  const tab = await currentTab();
  const url = targetUrl.value.trim() || tab?.url || "";
  targetUrl.value = url;
  await chrome.storage.local.set({ enabled: enabled.checked, targetUrl: url });
  status.textContent = enabled.checked
    ? "已启用：下次打开目标作业页时会自动提取并 AI 分析。"
    : "已关闭自动分析。";
});

load();
