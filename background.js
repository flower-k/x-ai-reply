// 模型配置来自本地 config.js（该文件不入库）；克隆仓库后请复制 config.example.js 为 config.js 并填入自己的 Key
try {
  importScripts("config.js");
} catch (e) {
  console.error("[X AI 评论助手] 缺少 config.js：请复制 config.example.js 为 config.js，填入 API Key 后刷新插件");
  throw e;
}
const { API_URL, API_KEY, MODEL_NAME } = self.AI_CONFIG;

// 缓存自动探测到的可用接口与模型名称（避免每次重复探测）
let cachedWorkingEndpoint = null;
let cachedWorkingModel = null;

// 如果你切换到了支持视觉(Vision)的多模态模型（如 gpt-4o-mini, gemini-2.0-flash, qwen-vl-max 等），
// 可将 ENABLE_VISION 设为 true，插件会自动把推文图片 URL 传给大模型进行真正的“看图评论”
const ENABLE_VISION = false;

// 预设评论多风格指令
const STYLE_PROMPTS = {
  default:
    "请写一条简短、自然、接地气的评论（15字以内）。像平时刷推随手留下的真人评论，可以适当赞同、调侃或聊两句。",
  agree:
    "请写一条真诚赞同、产生共鸣的评论（30字以内）。顺着对方的核心观点补充一个小细节或切身体会，自然不吹捧。",
  question:
    "请针对推文或评论中的某个具体细节，提出一个轻巧、有深度、能让推主有回复欲的追问（30字以内）。",
  humor:
    "请写一条轻松幽默、接梗或善意小吐槽的评论（30字以内）。网感好，像熟人朋友之间的风趣互动。",
  insight:
    "请围绕推文话题补充一个独到的小视角、实操经验或延伸思考（40字以内），显得专业、内行且有建设性。",
  english:
    "Write a short, natural, casual English reply (under 20 words) with authentic tech Twitter / indie hacker vibes. No corporate tone, no period at the end."
};

// 二创改写时，模型输出风格画像与正文之间的分隔符
const STYLE_PROFILE_SEPARATOR = '<<<STYLE|TEXT>>>';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GENERATE_REPLY") {
    generateReply(request.payload)
      .then((reply) => sendResponse({ success: true, reply }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // 保持异步消息通道开启
  }
  if (request.action === "REWRITE_POST") {
    rewritePost(request.payload)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === "SAVE_MARKDOWN") {
    saveMarkdown(request.payload)
      .then((filename) => sendResponse({ success: true, filename }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// MV3 service worker 里没有 URL.createObjectURL，只能走 data URL，
// 而 Chrome 对下载 URL 有约 2M 字符的硬上限，这里留出余量
const MAX_DOWNLOAD_URL_LENGTH = 1_500_000;

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// 把采集到的 Markdown 存成本地文件，落在浏览器下载目录的 x博主采集/ 子目录下
async function saveMarkdown({ markdown, filename } = {}) {
  if (!markdown || !markdown.trim()) throw new Error("没有可导出的内容");
  if (typeof chrome.downloads?.download !== "function") {
    throw new Error("插件拿不到 downloads 权限，请在 chrome://extensions 重新加载本插件");
  }

  const dataUrl = `data:text/markdown;charset=utf-8;base64,${toBase64Utf8(markdown)}`;
  if (dataUrl.length > MAX_DOWNLOAD_URL_LENGTH) {
    throw new Error(
      `本次采集内容过大（约 ${(dataUrl.length / 1048576).toFixed(1)}MB，单次导出上限约 1.4MB），请点「✕ 清空」后分几批滚动采集再导出`
    );
  }

  return new Promise((resolve, reject) => {
    let downloadId = null;

    const finish = (error) => {
      if (downloadId !== null) chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error);
      else resolve(filename);
    };

    // chrome.downloads.onChanged 给的是 { id, state: { previous, current } }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      const state = delta.state.current;
      if (state === "complete") return finish();
      if (state === "interrupted" || state === "cancelled") {
        return finish(new Error(state === "cancelled" ? "下载已取消" : "下载被打断"));
      }
    }

    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false, conflictAction: "uniquify" },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        downloadId = id;
        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
  });
}

function formatTweetBlock(tweet, label) {
  if (!tweet) return "";
  const lines = [];
  const header = tweet.author ? `${label}（作者: ${tweet.author}）` : label;
  lines.push(`${header}：`);
  lines.push(tweet.text ? tweet.text : "[无纯文本配文]");

  if (tweet.quotedText) {
    lines.push(`  ↳ [引用推文]: ${tweet.quotedText}`);
  }
  if (tweet.mediaSummary && tweet.mediaSummary.length > 0) {
    lines.push(`  ↳ [媒体与附件]: ${tweet.mediaSummary.join(" | ")}`);
  }
  return lines.join("\n");
}

async function generateReply(payload = {}) {
  const {
    style = "default",
    targetTweet,
    threadContext = [],
    tweetText // 兼容旧版纯文本字段
  } = payload;

  const styleInstruction = STYLE_PROMPTS[style] || STYLE_PROMPTS.default;

  const systemPrompt = [
    "你是一个活跃在 X (Twitter) 上的独立开发者。",
    styleInstruction,
    "通用要求：不要用客服腔调或说教口吻，不要用句号结尾，不要加引号包裹回复内容，直接输出评论正文。"
  ].join("\n");

  // 构建上下文文本（支持楼中楼多层对话链 + 媒体描述）
  let userTextPrompt = "";
  if (targetTweet) {
    const sections = [];
    if (threadContext.length > 0) {
      const contextLines = threadContext.map((item, idx) =>
        formatTweetBlock(item, idx === 0 ? "【原帖/1楼背景】" : `【上级对话 #${idx + 1}】`)
      );
      sections.push(
        "以下是当前帖子的前文背景（仅供理解上下文，请勿直接当作回复对象）：\n" +
          contextLines.join("\n\n")
      );
    }
    sections.push(
      formatTweetBlock(
        targetTweet,
        threadContext.length > 0
          ? "【当前你要直接回复的目标评论/推文】"
          : "【当前你要回复的推文】"
      )
    );
    if (threadContext.length > 0) {
      sections.push(
        "请注意：你正在“楼中楼”里回复最后一条【当前你要直接回复的目标评论/推文】，请结合前文背景，直接针对该目标评论作出回应。"
      );
    }
    userTextPrompt = sections.join("\n\n---\n\n");
  } else {
    userTextPrompt = `推文内容：\n${tweetText || ""}`;
  }

  // 构建 user message content（若开启 ENABLE_VISION 且存在图片，则使用多模态数组格式）
  let userContent = userTextPrompt;
  const imageUrls = targetTweet?.imageUrls || [];
  if (ENABLE_VISION && imageUrls.length > 0) {
    userContent = [
      { type: "text", text: userTextPrompt },
      ...imageUrls.slice(0, 4).map((url) => ({
        type: "image_url",
        image_url: { url }
      }))
    ];
  }

  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: userContent
    }
  ];

  return executeChatMessages(messages);
}

// 爆款推文 AI 二创改写：先拆解原帖创作风格，再用该风格仿写（不带任何预设账号腔）
async function rewritePost(payload = {}) {
  const { sourceTweet = {} } = payload;

  const originalBody = sourceTweet.text || sourceTweet.quotedText || "";
  const origLen = originalBody.replace(/\s+/g, "").length || 20;
  const minLen = Math.max(5, origLen - 10);
  const maxLen = origLen + 10;
  const origLines = (originalBody.match(/\S[^\n]*/g) || [""]).length;

  const systemPrompt = [
    "你是文案仿写专家，擅长把一个陌生作者的写法拆到可复用的颗粒度，再用这套写法重写内容。",
    "本次改写的定义是【换文笔，不换内容】：原帖写的事情必须原样保留，只是换成另一种写法来讲。",
    "",
    "【第一步：风格拆解】只分析原帖的写法（不是它讲了什么事），提炼创作风格，覆盖：",
    "1. 语言（中/英/混用）与整体语气（亢奋、冷静、毒舌、自嘲、真诚…）。",
    "2. 结构：共几行、每行大约几个字、是否单句成行、有没有列表或编号。",
    "3. 标点习惯：感叹号问号是否连用、是否用省略号或空格断句、是否加引号或书名号。",
    "4. 表情符号：用不用、具体哪些、放在句中还是收尾、是否成对重复。",
    "5. 钩子结构：第一行靠什么抓注意力（抛结论、抛数字、抛问题、抛反差、自嘲起笔…）。",
    "6. 人称视角：第一人称、第二人称还是无主语陈述，有没有称呼语。",
    "7. 句式节奏：短促堆叠还是长句铺陈，有没有反复出现的口头禅或句型模板。",
    "",
    "【第二步：同风格仿写】按第一步的风格重写原帖，遵守以下硬性要求：",
    "1. 题材锁死：原帖写什么就写什么。原帖讲约炮就还是讲约炮，讲失恋就还是讲失恋；原帖讲了一个具体故事，就复述同一个故事，起因、经过、转折、结局、人物关系和立场都不许改。",
    "2. 禁止软化或升华：不许把露骨、出格、争议的内容改成安全中立的说法，不许把具体事件抽象成人生道理或干货总结。原帖的情绪强度和多大胆就写多大胆。",
    "3. 事实原样保留：数字、金额、时间、地点、平台和品牌等专有名词照原帖保留，不得替换或编造。",
    "4. 只许改文笔：换措辞、换句式、换节奏、换开头钩子，严禁照抄原句，但信息点必须能逐条对上原帖。",
    "5. 语言必须与原帖一致：原帖英文就写英文，中文就写中文。",
    `6. 排版与篇幅跟随原帖：原帖约 ${origLen} 字 ${origLines} 行，改写后总字数控制在 ${minLen}~${maxLen} 字，行数和分行方式与原帖保持一致。`,
    "7. 第一步的风格画像必须落到具体写法上，不要写成“生动活泼”这类空泛形容词。",
    "",
    `【输出格式，严格遵守】：第 1 行只输出风格画像（单行不换行，60 字以内）；第 2 行只输出分隔符 ${STYLE_PROFILE_SEPARATOR}；之后只输出改写后的推文正文，正文前后不得出现任何解释、标题、引号或字数统计。`
  ].join("\n");

  const metricsInfo = sourceTweet.metricsText
    ? `\n【原帖热度数据】：${sourceTweet.metricsText}`
    : "";

  const userTextPrompt = [
    formatTweetBlock(sourceTweet, "【待改写的热门原帖】"),
    metricsInfo,
    `\n【再次提醒】：先输出风格画像一行，再输出分隔符 ${STYLE_PROFILE_SEPARATOR}，最后输出改写正文。正文的题材、故事和事实必须与原帖完全一致（只换文笔，不改内容、不软化、不升华），语言、行数与字数（${minLen}~${maxLen} 字）都跟随原帖：`
  ].join("\n");

  let userContent = userTextPrompt;
  const imageUrls = sourceTweet?.imageUrls || [];
  if (ENABLE_VISION && imageUrls.length > 0) {
    userContent = [
      { type: "text", text: userTextPrompt },
      ...imageUrls.slice(0, 4).map((url) => ({
        type: "image_url",
        image_url: { url }
      }))
    ];
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  const raw = await executeChatMessages(messages);
  const [stylePart, ...bodyParts] = raw.split(STYLE_PROFILE_SEPARATOR);

  // 模型没按格式来时，整段当正文，不阻塞出稿
  if (bodyParts.length === 0) return { text: raw, styleProfile: "" };

  const text = bodyParts.join("").trim();
  if (!text) {
    throw new Error("模型只输出了风格分析，没有给出改写正文，请重试");
  }

  return { text, styleProfile: stylePart.trim() };
}

async function executeChatMessages(messages) {
  // 若是首次调用 Kimi 接口，先快速查询 /models 获取该 Key 真正拥有权限的最快模型，避免盲猜 404 或卡在慢速推理模型
  if (!cachedWorkingModel && (API_URL.includes("moonshot") || API_URL.includes("kimi"))) {
    await detectBestKimiModel();
  }

  const activeUrl = cachedWorkingEndpoint || API_URL;
  const activeModel = cachedWorkingModel || MODEL_NAME;

  let response = await sendCompletionRequest(activeUrl, activeModel, messages);

  // 如果遇到 404 (Not found the model or Permission denied)，自动探测该 Key 可用的接口与模型名称并重试
  if (response.status === 404) {
    const recovered = await autoDiscoverModelAndRetry(messages);
    if (recovered) {
      return recovered;
    }
  }

  if (!response.ok) {
    let detail = "";
    try {
      const errData = await response.json();
      detail = errData?.error?.message || JSON.stringify(errData);
    } catch {
      detail = await response.text().catch(() => "");
    }

    let hint = "";
    if (response.status === 401) {
      hint =
        "（Key 认证失败：1. 修改 config.js 后请务必去 chrome://extensions 点插件右下角的「刷新🔄」按钮；2. 请检查当前 API_KEY 是否与当前启用的模型平台匹配）";
    } else if (response.status === 402 || response.status === 429) {
      hint = "（账户余额不足或触发请求频率限制，请检查对应开放平台额度）";
    } else if (response.status === 404) {
      hint =
        "（未找到模型或该 Key 无权访问此模型：请确认 Key 来自 Kimi 开放平台且账户余额 > 0）";
    }

    throw new Error(
      `API 请求失败 (${response.status})${hint}${detail ? `\n服务端详情: ${detail}` : ""}`
    );
  }

  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  const reply = (message.content || "").trim();

  if (!reply) {
    throw new Error(
      `模型返回内容为空（finish_reason: ${data?.choices?.[0]?.finish_reason || "unknown"}）`
    );
  }

  return reply;
}

async function sendCompletionRequest(url, model, messages) {
  // Kimi K3 / K2.5 等推理模型会将思考过程 (reasoning_content) 计入 max_tokens，
  // 因此需要留足 max_tokens (2048)，并开启轻量思考模式以加快响应速度、避免正文被截断为空
  const requestBody = {
    model,
    messages,
    max_tokens: 2048
  };

  if (model.startsWith("kimi-k3")) {
    requestBody.reasoning_effort = "low";
  } else if (model.startsWith("kimi-k2.5") || model.startsWith("kimi-k2.6")) {
    requestBody.thinking = { type: "disabled" };
  }

  let resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    },
    body: JSON.stringify(requestBody)
  });

  // 如果部分兼容模型不支持 reasoning_effort / thinking 参数返回 400，自动退回基础参数重试
  if (resp.status === 400 && (requestBody.reasoning_effort || requestBody.thinking)) {
    delete requestBody.reasoning_effort;
    delete requestBody.thinking;
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
  }

  return resp;
}

// 优先尝试的 Kimi 模型顺序（优先选择响应最快的非深度思考/高速模型）
const PREFERRED_KIMI_MODELS = [
  "kimi-k2-turbo-preview",
  "kimi-k2-0905-preview",
  "kimi-k2-0711-preview",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k3.1-pro-highspeed",
  "kimi-k3.1-pro",
  "kimi-k3",
  "kimi-latest",
  "moonshot-v1-8k",
  "moonshot-v1-32k",
  "kimi-for-coding"
];

function rankAvailableModels(availableIds) {
  const filtered = availableIds.filter(
    (id) => id && !id.includes("embedding") && !id.includes("vision")
  );
  const nonThinking = filtered.filter((id) => !id.includes("thinking"));
  const pool = nonThinking.length > 0 ? nonThinking : filtered;

  const matchedPreferred = PREFERRED_KIMI_MODELS.filter((p) => pool.includes(p));
  const remaining = pool.filter((id) => !matchedPreferred.includes(id));
  return [...matchedPreferred, ...remaining];
}

// 首次调用时快速查询 /models（耗时约 100ms），直接锁定账号下可用的最快模型
async function detectBestKimiModel() {
  const base = API_URL.replace(/\/chat\/completions$/, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const modelsResp = await fetch(`${base}/models`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${API_KEY}` },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (modelsResp.ok) {
      const modelsJson = await modelsResp.json();
      const availableIds = (modelsJson?.data || []).map((m) => m.id);
      if (availableIds.includes(MODEL_NAME)) {
        cachedWorkingEndpoint = API_URL;
        cachedWorkingModel = MODEL_NAME;
        return;
      }
      const ranked = rankAvailableModels(availableIds);
      if (ranked.length > 0) {
        cachedWorkingEndpoint = API_URL;
        cachedWorkingModel = ranked[0];
      }
    }
  } catch {
    // 忽略预探测异常，交由后续主请求处理
  }
}

// 自动查询 /models 接口或候选端点，匹配当前 API Key 有权限调用的模型并自动完成请求
async function autoDiscoverModelAndRetry(messages) {
  const candidateBases = [
    API_URL.replace(/\/chat\/completions$/, ""),
    "https://api.moonshot.cn/v1",
    "https://api.kimi.com/coding/v1",
    "https://api.moonshot.ai/v1"
  ];
  const uniqueBases = [...new Set(candidateBases)];

  for (const base of uniqueBases) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const modelsResp = await fetch(`${base}/models`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${API_KEY}`
        },
        signal: controller.signal
      });
      clearTimeout(timer);

      let modelsToTry = [];
      if (modelsResp.ok) {
        const modelsJson = await modelsResp.json();
        const availableIds = (modelsJson?.data || []).map((m) => m.id);
        modelsToTry = rankAvailableModels(availableIds);
      } else if (base.includes("api.kimi.com/coding")) {
        modelsToTry = ["kimi-for-coding"];
      }

      const completionUrl = `${base}/chat/completions`;
      for (const candidateModel of modelsToTry.slice(0, 3)) {
        const retryResp = await sendCompletionRequest(completionUrl, candidateModel, messages);
        if (retryResp.ok) {
          const data = await retryResp.json();
          const reply = data?.choices?.[0]?.message?.content?.trim();
          if (reply) {
            cachedWorkingEndpoint = completionUrl;
            cachedWorkingModel = candidateModel;
            return reply;
          }
        }
      }
    } catch {
      // 忽略单个候选端点的探测异常，继续尝试下一个
    }
  }

  return null;
}