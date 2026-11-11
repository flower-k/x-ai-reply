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

// 基于 @dukou_dk 账号真实爆款历史数据提炼的 4 种二创改写风格（字数严格跟随原文 ±10 字）
const REWRITE_STYLE_PROMPTS = {
  info_gap: `【模式：💰 搞钱信息差 / 野路子拆解风】
参考语感：
- “卧槽！！！\n小红书卖虚拟资料这么挣钱！！！\n有人卖拼豆图纸干了10W销售额！！！\n🥹🥹”
- “发现一个野路子！！！\n先帮客户做自动获客，跑通才写代码，月入 $11,328。\n先卖出去再写代码！！！\n😉😉”
改写要求：
1. 必须严格遵守【字数硬性铁律】（控制在原文 ±10 字范围内）。
2. 抓核心信息差/搞钱逻辑/数字，用大白话短句分行写，结尾加 😉😉 或 🥹🥹。`,

  hot_take: `【模式：🔥 暴论 / 扎心认知风】
参考语感：
- “程序员创业最容易犯的错：\n先开发好产品，后找用户！！！\n先收钱比先写代码更重要！！！\n😉😉”
- “做副业死得最快的方式，就是追求仪式感！！！\n真玩家都是先把第一笔钱收进微信钱包！！！\n🥺🥺”
改写要求：
1. 必须严格遵守【字数硬性铁律】（控制在原文 ±10 字范围内）。
2. 亮出犀利观点或反差对比，刀刀见血，连用“！！！”，结尾加 😉😉 或 🥺🥺。`,

  question_hook: `【模式：❓ 互动提问 / 痛点共鸣风】
参考语感：
- “大家都在搞什么副业？？？\n我要求不高\n一个月搞个8000就行！！！\n😉😉”
- “不懂就问：\n为什么发个石头都能有这么大流量？？？\n🥹🥹”
改写要求：
1. 必须严格遵守【字数硬性铁律】（控制在原文 ±10 字范围内）。
2. 转化为直白痛点提问或二选一，连用“？？？”或“！！！”，末尾带 😉😉 或 🥹🥹。`,

  soft_promo: `【模式：📢 借势带货（植入 dukouai.top）】
参考语感：
- “赚钱不是很容易吗？\n做AI代理卖铲子就可以了！！！\n低价稳货源：dukouai.top\n😉😉”
改写要求：
1. 必须严格遵守【字数硬性铁律】（控制在原文 ±10 字范围内）。
2. 顺着原帖点出痛点并自然带出“dukouai.top” + 😉😉。`
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GENERATE_REPLY") {
    generateReply(request.payload)
      .then((reply) => sendResponse({ success: true, reply }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // 保持异步消息通道开启
  }
  if (request.action === "REWRITE_POST") {
    rewritePost(request.payload)
      .then((text) => sendResponse({ success: true, text }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

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

// 爆款推文 AI 二创改写（深度定制 @dukou_dk 账号风格，字数严格匹配原文 ±10 字）
async function rewritePost(payload = {}) {
  const { style = "info_gap", sourceTweet = {} } = payload;
  const stylePrompt = REWRITE_STYLE_PROMPTS[style] || REWRITE_STYLE_PROMPTS.info_gap;

  // 计算原文有效字数（去除空白符后的字符数），设定 ±10 字的目标区间
  const rawOriginal = (sourceTweet.text || sourceTweet.quotedText || "").replace(/\s+/g, "");
  const origLen = rawOriginal.length > 0 ? rawOriginal.length : 20;
  const minLen = Math.max(5, origLen - 10);
  const maxLen = origLen + 10;

  const systemPrompt = [
    "你是 X (Twitter) 中文区高互动博主 @dukou_dk（渡口）。",
    "请将用户抓到的热门推文进行【等长爆款二创改写】。",
    `【字数硬性铁律（最高优先级）】：原帖字数为 ${origLen} 字，你改写后的文案总字数必须严格控制在 ${minLen} ~ ${maxLen} 个字之间（与原文字数上下浮动绝对不能超过 10 个字）！`,
    "【排版与文风要求】：",
    "1. 如果原帖只有一两句话（如 20 字左右），你也只写一两句短话（10~30 字），绝不扩写啰嗦！",
    "2. 单句成行：每句话单独一行，善用“！！！”或“？？？”拉满情绪，结尾带 😉😉 或 🥹🥹。",
    "3. 彻底去重：保留原帖核心意思与节奏，换用大白话重写，严禁照抄原句。",
    "4. 直接输出改写后的推文正文，不要输出字数统计或任何解释说明。",
    "",
    stylePrompt
  ].join("\n");

  const metricsInfo = sourceTweet.metricsText
    ? `\n【原帖热度数据】：${sourceTweet.metricsText}`
    : "";

  const userTextPrompt = [
    formatTweetBlock(sourceTweet, "【待改写的热门原帖】"),
    metricsInfo,
    `\n【再次提醒字数限制】：原帖共 ${origLen} 字，请务必将改写后的总字数严格控制在 ${minLen}~${maxLen} 字以内（上下不超过 10 个字），直接输出改写正文：`
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

  return executeChatMessages(messages);
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