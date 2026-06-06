const QUESTION_SELECTORS = [
  ".questionLi",
  ".question-list-item",
  ".subject_node",
  ".TiMu",
  ".mark_item",
  ".question-item",
  "[data-questionid]",
  "[data-question-id]",
  "[id^='question']"
];

const TEXT_SELECTOR = [
  "textarea",
  "input[type='text']",
  "input:not([type])",
  "[contenteditable='true']",
  ".wangEditor-txt",
  ".edui-body-container"
].join(",");

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function usable(element) {
  if (!element || element.disabled || element.readOnly) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width >= 20 &&
    rect.height >= 10;
}

function questionBlocks() {
  for (const selector of QUESTION_SELECTORS) {
    const blocks = [...document.querySelectorAll(selector)].filter(usable);
    if (blocks.length) return unique(blocks);
  }
  return [];
}

function chaoxingAnswerType(block) {
  return block.querySelector("input[id^='answertype'], input[name^='answertype']")?.value ?? null;
}

function optionText(element) {
  const input = element.matches?.("input") ? element : element.querySelector?.("input");
  const id = input?.id && CSS.escape(input.id);
  const label = input?.closest("label") || (id ? document.querySelector(`label[for="${id}"]`) : null);
  return clean(label?.innerText || element.innerText || element.parentElement?.innerText || input?.value);
}

function customOptions(block) {
  const selectors = [
    "label",
    "[role='radio']",
    "[role='checkbox']",
    ".Zy_ulTop > li",
    ".answer_p",
    "[class*='option']",
    "[class*='choose']"
  ];
  const stem = block.querySelector(".stem_answer") || block;
  return unique([...stem.querySelectorAll(selectors.join(","))])
    .filter(usable)
    .filter((element) => {
      const text = optionText(element);
      return text && text.length < 500 &&
        element.querySelectorAll("li, label, [role='radio'], [role='checkbox']").length < 6;
    });
}

function extractStructuredQuestions() {
  return questionBlocks().map((block, index) => {
    const nativeOptions = [...block.querySelectorAll("input[type='radio'], input[type='checkbox']")];
    const options = nativeOptions.length ? nativeOptions : customOptions(block);
    const answerType = chaoxingAnswerType(block);
    return {
      index: index + 1,
      text: clean(block.innerText),
      type: answerType === "2"
        ? "fill_in_the_blank"
        : nativeOptions.some((item) => item.type === "checkbox") || answerType === "1"
        ? "multiple_choice"
        : options.length
          ? "single_choice"
          : "text",
      answerType,
      options: options.map(optionText).filter(Boolean)
    };
  }).filter((question) => question.text.length > 3);
}

function extractQuestions() {
  return extractStructuredQuestions().map((question) => `${question.index}. ${question.text}`);
}

function answerParts(answer) {
  return String(answer)
    .split(/[,|;\s]+/)
    .map((part) => clean(part).toLowerCase())
    .filter(Boolean);
}

function looksLikeChoiceAnswer(answer) {
  const parts = answerParts(answer);
  return parts.length > 0 && parts.every((part) => /^[a-h]$/i.test(part));
}

function textValue(field) {
  return clean(field.isContentEditable ? field.innerText : field.value);
}

function writeText(field, answer) {
  const value = String(answer);
  field.focus();

  if (field.isContentEditable) {
    field.innerHTML = "";
    field.textContent = value;
    try {
      document.execCommand("insertText", false, value);
    } catch {
      // The direct textContent assignment above remains the fallback.
    }
  } else {
    const prototype = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
  }

  field.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: value
  }));
  field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Enter" }));
  field.blur();
  return textValue(field).length > 0;
}

function allTextFields() {
  const fields = [...document.querySelectorAll(TEXT_SELECTOR)];
  if (document.body?.isContentEditable) fields.unshift(document.body);
  return unique(fields)
    .filter(usable)
    .filter((field) => {
      const identity = clean([
        field.name,
        field.id,
        field.className,
        field.getAttribute("placeholder")
      ].join(" ")).toLowerCase();
      return !/search|keyword|phone|mobile|account|username|password|captcha|verify|code/.test(identity);
    });
}

function fillTextSequence(answers) {
  const fields = allTextFields();
  let verified = 0;
  fields.slice(0, answers.length).forEach((field, index) => {
    if (writeText(field, answers[index])) verified += 1;
  });
  return { capacity: fields.length, attempted: Math.min(fields.length, answers.length), verified };
}

function optionMatches(element, wanted) {
  const text = optionText(element).toLowerCase();
  const input = element.matches?.("input") ? element : element.querySelector?.("input");
  const value = clean(input?.value).toLowerCase();
  const letter = text.match(/^\s*([a-z])(?:[.\s):]|$)/i)?.[1]?.toLowerCase();
  return wanted.some((part) =>
    part === letter ||
    part === value ||
    part === text ||
    text.startsWith(`${part}.`) ||
    text.startsWith(`${part} `) ||
    (part.length > 1 && text.includes(part))
  );
}

function clickOption(element) {
  const input = element.matches?.("input") ? element : element.querySelector?.("input");
  const target = element.closest?.("label, li, a, [role='radio'], [role='checkbox'], [onclick]") || element;
  target.click();
  if (input && !input.checked) input.click();
  input?.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return input ? input.checked : true;
}

function fillChoice(block, answer) {
  const native = [...block.querySelectorAll("input[type='radio'], input[type='checkbox']")];
  const options = native.length ? native : customOptions(block);
  const wanted = answerParts(answer);
  const matches = options.filter((option) => optionMatches(option, wanted));
  const clicked = matches.filter(clickOption).length;
  return {
    ok: clicked > 0,
    kind: native.length ? "native_choice" : "custom_choice",
    options: options.length,
    matches: clicked
  };
}

function directTextFields(block) {
  return unique([...block.querySelectorAll(TEXT_SELECTOR)]).filter(usable);
}

function fillAnswers(answers) {
  const blocks = questionBlocks();
  const globalFields = allTextFields();
  const claimed = new Set();
  const details = [];

  blocks.forEach((block, index) => {
    const answer = answers[index];
    const answerType = chaoxingAnswerType(block);
    if (!answer) {
      details.push({ index: index + 1, ok: false, reason: "missing_answer" });
      return;
    }

    const directFields = directTextFields(block).filter((field) => !claimed.has(field));
    if (answerType === "2") {
      details.push({ index: index + 1, ok: false, reason: "chaoxing_fill", answerType });
      return;
    }

    if (directFields.length && !looksLikeChoiceAnswer(answer)) {
      const verified = directFields.filter((field) => {
        claimed.add(field);
        return writeText(field, answer);
      }).length;
      details.push({
        index: index + 1,
        ok: verified > 0,
        kind: "direct_text",
        textFields: directFields.length,
        verifiedTextFields: verified
      });
      return;
    }

    if (looksLikeChoiceAnswer(answer) || customOptions(block).length) {
      details.push({ index: index + 1, ...fillChoice(block, answer) });
      return;
    }

    details.push({ index: index + 1, ok: false, reason: "needs_global_text" });
  });

  const pendingText = details.filter((detail, index) =>
    !detail.ok &&
    detail.reason === "needs_global_text" &&
    answers[index] &&
    !looksLikeChoiceAnswer(answers[index])
  );
  const availableFields = globalFields.filter((field) => !claimed.has(field));

  pendingText.forEach((detail, pendingIndex) => {
    const field = availableFields[pendingIndex];
    if (!field) return;
    claimed.add(field);
    const verified = writeText(field, answers[detail.index - 1]);
    detail.ok = verified;
    detail.kind = "ordered_global_text";
    detail.textFields = 1;
    detail.verifiedTextFields = verified ? 1 : 0;
    delete detail.reason;
  });

  return {
    filled: details.filter((detail) => detail.ok).length,
    total: blocks.length,
    globalTextFields: globalFields.length,
    details
  };
}

function targetMatches(targetUrl) {
  if (!targetUrl) return false;
  try {
    const target = new URL(targetUrl);
    const current = new URL(location.href);
    return target.origin === current.origin &&
      target.pathname === current.pathname &&
      (!target.searchParams.get("workId") ||
        target.searchParams.get("workId") === current.searchParams.get("workId"));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT") sendResponse({ questions: extractQuestions() });
  if (message.type === "EXTRACT_STRUCTURED") sendResponse({ questions: extractStructuredQuestions() });
  if (message.type === "TEXT_CAPACITY") sendResponse({ capacity: allTextFields().length });
  if (message.type === "FILL_TEXT_SEQUENCE") sendResponse(fillTextSequence(message.answers || []));
  if (message.type === "FILL") {
    const result = fillAnswers(message.answers || []);
    const text = result.details.reduce((sum, item) => sum + (item.textFields || 0), 0);
    const verified = result.details.reduce((sum, item) => sum + (item.verifiedTextFields || 0), 0);
    const choices = result.details.reduce((sum, item) => sum + (item.matches || 0), 0);
    const failures = result.details.filter((item) => !item.ok).map((item) => item.index).join(",");
    sendResponse({
      ...result,
      message: `Filled ${result.filled}/${result.total}; text fields ${text}, verified ${verified}, choice matches ${choices}.${failures ? ` Failed: ${failures}` : ""}`
    });
  }
});

chrome.storage.local.get(["enabled", "targetUrl"]).then((data) => {
  if (window.top === window && data.enabled === true && targetMatches(data.targetUrl)) {
    setTimeout(() => {
      const questions = extractStructuredQuestions();
      if (questions.length) chrome.runtime.sendMessage({ type: "AUTO_ANALYZE", url: location.href, questions });
    }, 2500);
  }
});
