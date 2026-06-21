const fs = require("fs");
const http = require("http");
const path = require("path");

const root = __dirname;
const configPath = path.join(root, "config.json");
const keyPath = path.join(root, "api-key.txt");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function parseModelJson(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const extracted = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const candidates = [
    extracted,
    extracted
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/(["}\]])\s+("[A-Za-z_][^"]*"\s*:)/g, "$1,$2")
  ];
  let lastError;
  for (const candidate of candidates) {
    try {
      const result = JSON.parse(candidate);
      if (!Array.isArray(result.answers)) throw new Error("Model response does not contain an answers array");
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function callDeepSeek(config, apiKey, messages) {
  const response = await fetch(config.baseUrl || "https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model || "deepseek-chat",
      messages,
      response_format: { type: "json_object" },
      stream: false
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `DeepSeek API returned ${response.status}`);
  return data.choices?.[0]?.message?.content || "";
}

async function analyze(questions) {
  const config = readJson(configPath);
  const apiKey = fs.readFileSync(keyPath, "utf8").trim();
  if (!apiKey || apiKey.startsWith("REPLACE_") || apiKey.startsWith("sk-your-")) {
    throw new Error("Put a valid DeepSeek API key in api-key.txt");
  }

  const systemPrompt = [
    "Analyze every supplied question carefully.",
    "Return JSON only, with this exact shape:",
    '{"answers":[{"index":1,"answer":"B","explanation":"short reason","confidence":0.9}]}',
    "For every question that includes options, answer only with the option letter.",
    "For multiple-choice questions, answer only with option letters separated by English commas, for example A,C.",
    "For text questions, provide a concise answer.",
    "For fill-in-the-blank questions with multiple blanks, put each blank answer in order and separate them with ||.",
    "confidence must be a number from 0 to 1.",
    "When information is insufficient, lower confidence and explain why.",
    "Keep every question in the original order and do not omit any question."
  ].join("\n");

  const content = await callDeepSeek(config, apiKey, [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify({ questions }) }
  ]);
  try {
    return parseModelJson(content);
  } catch (firstError) {
    const repaired = await callDeepSeek(config, apiKey, [
      {
        role: "system",
        content: "Repair the supplied malformed JSON. Return valid JSON only. Preserve every answer, explanation, confidence, and index exactly; do not solve or change content."
      },
      { role: "user", content }
    ]);
    try {
      return parseModelJson(repaired);
    } catch {
      throw new Error(`DeepSeek returned invalid JSON after retry: ${firstError.message}`);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  if (req.method === "GET" && req.url === "/health") {
    const config = readJson(configPath);
    return sendJson(res, 200, {
      ok: true,
      provider: "deepseek",
      model: config.model || "deepseek-chat"
    });
  }
  if (req.method !== "POST" || req.url !== "/analyze") {
    return sendJson(res, 404, { error: "Not found" });
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload.questions) || !payload.questions.length) {
        throw new Error("No questions received");
      }
      sendJson(res, 200, await analyze(payload.questions));
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
});

const config = readJson(configPath);
server.listen(config.port || 3210, "127.0.0.1", () => {
  console.log(`DeepSeek homework AI service: http://127.0.0.1:${config.port || 3210}`);
  console.log("Keep this window open while using the Edge extension.");
});
