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
    "请写一条简短、自然、接地气的评论（30字以内）。像平时刷推随手留下的真人评论，可以适当赞同、调侃或聊两句。",
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

// 基于 @dukou_dk 账号真实爆款历史数据提炼的 4 种二创改写风格
const REWRITE_STYLE_PROMPTS = {
  info_gap: `【模式：💰 搞钱信息差 / 野路子拆解风】
参考范文语感：
- “卧槽，这哥们做 AI 生意的顺序有点意思！！！\n他先用 n8n 搭了个自动找客户系统，自己先用，后来把服务卖给别人。\n跑通需求后，才花一个月把它做成 SaaS，MRR 约 $11,328。\n先卖出去，再写代码！这思路值得学。\n🥹🥹”
- “想知道最近什么虚拟资料最好卖，根本不用自己瞎猜\n打开闲鱼，搜“全套”“合集”，筛选“最多人想要”\n去海外把同类的最新资源汉化更新一遍，放到小红书卖 39 块，这就是最稳的二道贩子生意！！！”
改写要求：
1. 开头用极具冲击力的发现钩子（如“卧槽！！！”、“发现一个挺有意思的路子！！！”、“这玩意儿真的有点反直觉……”）。
2. 中间用短句分行拆解原帖的核心搞钱/产品/效率逻辑，保留具体数字或对比细节，彻底换用口语化表达。
3. 结尾用一句一针见血的实操铁律（如“先收钱比先写代码更重要！！！”、“不需要开发复杂的东西，就解决一个别人嫌麻烦的小问题！！！”），最后空一行加上 😉😉 或 🥹🥹。`,

  hot_take: `【模式：🔥 暴论 / 扎心认知风】
参考范文语感：
- “为什么很多聪明人反而在互联网上赚不到钱？\n因为他们太喜欢“评判”，而不喜欢“测试”\n在岸上研究一万遍泳姿的人，永远干不过那个直接跳进水里扑腾的傻子。”
- “普通人做副业死得最快的方式，就是追求“仪式感”\n还没赚到一分钱，先买最贵的域名、配顶配的电脑\n真正能跑出来的野路子玩家，往往是先把第一笔钱收进微信钱包！！！\n😉😉”
改写要求：
1. 开头直接亮出犀利反常识观点（如“说个暴论！！！”、“为什么 90% 的人折腾大半年赚不到钱？”）。
2. 中间做强烈反差对比（普通人/蠢人怎么假努力 vs 聪明人/高手怎么抓本质），每句话单独一行，干脆利落。
3. 结尾用一句扎心金句收束，连用感叹号“！！！”，并带上 😉😉 或 🥺🥺。`,

  question_hook: `【模式：❓ 互动提问 / 痛点共鸣风（高评高涨粉）】
参考范文语感：
- “大家都在搞什么副业？？？\n我要求不高\n一个月搞个8000就行！！！\n😉😉”
- “不懂就问：\n听说一千到一千五是一个坎！！！！\n会被限流\n是这样吗？？\n🥹🥹”
- “做个残酷的选择题：\nA：每天工作 12 小时，一年稳赚 100 万\nB：每天只工作 2 小时，一个月 6000 块\n现在的你，会选哪个？”
改写要求：
1. 将原帖的核心话题浓缩提炼成一个极易引发评论区争论或共鸣的短帖（控制在 3~6 行短句）。
2. 善用“不懂就问：”、“真诚发问！！！”、“聊个扎心的话题”或“做个残酷的选择题”，称呼读者为“兄弟们”。
3. 句尾连用“？？？”或“！！！”，最后加上 😉😉 或 🥹🥹，让人看完忍不住想在评论区留下一句。`,

  soft_promo: `【模式：📢 借势带货（植入渡口小店 dukouai.top）】
参考范文语感：
- “赚钱不是很容易吗？\n做AI代理卖铲子就可以了！！！\nAI的市场真的太大了，还有很多人不知道好工具去哪搞\n😉😉”
- “手头同时重度用着 ChatGPT、Claude、Gemini 和 Grok，说句大实话：工欲善其事，货源一定要稳！！！\n不管是自己高频用，还是做代理拿去卖铲子，渡口的小店都能帮到你！！！！！\n传送门：dukouai.top\n😉😉”
改写要求：
1. 前半部分先顺着原帖的话题输出有共鸣的洞察或热点吐槽（单句成行，带“！！！”）。
2. 后半部分丝滑转折到 AI 工具/账号刚需或“卖铲子”逻辑，自然植入“渡口AI货源网：dukouai.top（ChatGPT / Claude / Grok / Gemini 稳定不烧心，自用或做代理卖铲子都稳）”，最后带上 😉😉。`
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

// 爆款推文 AI 二创改写（深度定制 @dukou_dk 账号风格）
async function rewritePost(payload = {}) {
  const { style = "info_gap", sourceTweet = {} } = payload;
  const stylePrompt = REWRITE_STYLE_PROMPTS[style] || REWRITE_STYLE_PROMPTS.info_gap;

  const systemPrompt = [
    "你是 X (Twitter) 中文区高互动博主 @dukou_dk（渡口），主打独立开发、AI 搞钱信息差、副业拆解与蓝V高互动。",
    "你需要将用户抓取到的热门推文进行【爆款二创改写】，使其成为一条能够直接发布、高曝光、高互动且完全去重的原创推文。",
    "【@dukou_dk 核心排版与文风基因（必须严格遵守）】：",
    "1. 单句成行：每句话单独占一行，段落之间适当空行，绝不写超过两行的密集长段，视觉极度清爽。",
    "2. 情绪张力标点：善用连续感叹号“！！！”或连续问号“？？？”强化语气，拒绝温吞的客服腔或教科书味。",
    "3. 标志性表情收尾：推文末尾加上 😉😉 或 🥹🥹 或 🥺🥺。",
    "4. 跨语种/去重重构：若原帖是英文，提取核心洞察用上述中文网感彻底重写；若原帖是中文，提炼其爆款骨架与核心卖点，用全新的切入角度和措辞重写，严禁逐句照抄。",
    "5. 直接输出改写后的推文正文，不要输出任何“改写如下：”等解释性文字。",
    "",
    stylePrompt
  ].join("\n");

  const metricsInfo = sourceTweet.metricsText
    ? `\n【原帖热度数据】：${sourceTweet.metricsText}（爆款标签：${(sourceTweet.tags || []).join("、") || "热门帖"}）`
    : "";

  const userTextPrompt = [
    formatTweetBlock(sourceTweet, "【待改写的热门原帖】"),
    metricsInfo,
    "\n请按照指定的 @dukou_dk 风格模式，将上述热门帖改写为一条全新的爆款推文："
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