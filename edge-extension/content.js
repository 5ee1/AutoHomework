function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractQuestions() {
  return [...document.querySelectorAll(".questionLi")].map((question, index) => {
    const answerType = question.querySelector("input[id^='answertype'],input[name^='answertype']")?.value;
    const options = answerType === "2"
      ? []
      : [...question.querySelectorAll(".answerBg[onclick*='addChoice'],[onclick='addChoice(this);']")]
        .map((option) => clean(option.innerText))
        .filter(Boolean);
    return {
      index: index + 1,
      type: answerType === "2" ? "fill_in_the_blank" : answerType === "1" ? "multiple_choice" : "single_choice",
      answerType,
      text: clean(question.querySelector(".mark_name")?.innerText || question.innerText),
      options
    };
  }).filter((question) => question.text);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_QUESTIONS") sendResponse({ questions: extractQuestions() });
});
