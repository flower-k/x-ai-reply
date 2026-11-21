// 预设回复风格列表
const REPLY_STYLES = [
  { key: "default", label: "⚡ 自然" },
  { key: "agree", label: "👍 赞同" },
  { key: "question", label: "🤔 追问" },
  { key: "humor", label: "😂 玩梗" },
  { key: "insight", label: "💡 见解" },
  { key: "english", label: "🌐 英文" }
];

const STYLE_STORAGE_KEY = "x_ai_reply_style";
let lastClickedReplyChain = [];

// intercept.js（MAIN world）从 X 自己的 GraphQL 响应里捞出来的长帖全文：推文 id -> 完整正文
const noteTweetTexts = new Map();

window.addEventListener("message", (event) => {
  if (event.origin !== "https://x.com") return;
  const data = event.data;
  if (!data || data.__xAiFullText !== "note-tweet" || !Array.isArray(data.entries)) return;

  data.entries.forEach((entry) => {
    if (entry && entry.id && entry.text) noteTweetTexts.set(entry.id, entry.text);
  });
});

// 折叠的长帖 DOM 里只有「显示更多」之前那截，正文一律以接口全文为准
function tweetTextFromEl(el, tweetId) {
  return X_AI_CAPTURE.pickFullText(
    el.innerText,
    (tweetId && noteTweetTexts.get(tweetId)) || ""
  );
}

// 热门帖子池与工作台状态
const hotPostsPool = new Map(); // key: tweetKey -> postItem
let currentThresholdPreset = "balanced"; // balanced | strict | loose
let currentSortBy = "hotScore"; // hotScore | views | replies | likes | engagementRate
let activeRewriteSource = null;
let autoScanTimer = null;

// 捕获用户点击某条推文/评论下方“回复”图标的动作，记录楼中楼上下文链
document.addEventListener(
  "click",
  (e) => {
    const replyBtn = e.target.closest('[data-testid="reply"]');
    if (!replyBtn) return;

    const clickedArticle = replyBtn.closest('article[data-testid="tweet"]');
    if (!clickedArticle) return;

    lastClickedReplyChain = collectPageChainUpTo(clickedArticle);
  },
  true
);

// 监听页面 DOM 变化，动态注入 AI 回复组件、单帖仿写按钮与热门雷达面板
let scanScheduled = false;
const observer = new MutationObserver(() => {
  const toolbars = document.querySelectorAll('[data-testid="toolBar"]');
  toolbars.forEach((toolbar) => {
    if (toolbar.dataset.aiInjected) return;
    toolbar.dataset.aiInjected = "true";
    injectAIControls(toolbar);
  });

  if (!scanScheduled) {
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      ensureHotRadarMounted();
      scanVisibleTweets();
    });
  }
});

observer.observe(document.body, { childList: true, subtree: true });

function getSavedStyle() {
  try {
    return localStorage.getItem(STYLE_STORAGE_KEY) || "default";
  } catch {
    return "default";
  }
}

function saveStyle(style) {
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, style);
  } catch {
    // 忽略隐私模式下的存储异常
  }
}

function injectAIControls(toolbar) {
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `
    display: inline-flex;
    align-items: center;
    margin-left: 8px;
    border-radius: 9999px;
    border: 1px solid rgba(29, 155, 240, 0.65);
    background: rgba(29, 155, 240, 0.08);
    overflow: hidden;
    height: 30px;
    box-sizing: border-box;
  `;

  // 风格下拉选择器
  const styleSelect = document.createElement("select");
  styleSelect.title = "切换 AI 回复风格（切换后立即重新生成）";
  styleSelect.style.cssText = `
    appearance: none;
    -webkit-appearance: none;
    border: none;
    border-right: 1px solid rgba(29, 155, 240, 0.35);
    background: transparent;
    color: #1d9bf0;
    font-size: 12px;
    font-weight: 600;
    padding: 0 8px 0 10px;
    height: 100%;
    cursor: pointer;
    outline: none;
  `;

  const currentStyle = getSavedStyle();
  REPLY_STYLES.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.key;
    opt.innerText = item.label;
    opt.style.color = "#0f1419";
    opt.style.background = "#ffffff";
    if (item.key === currentStyle) opt.selected = true;
    styleSelect.appendChild(opt);
  });

  // 生成 / 换一条 按钮
  const btn = document.createElement("button");
  btn.innerText = "✨ AI 回复";
  btn.type = "button";
  btn.title = "使用当前风格生成回复（已生成时点击将覆盖重写）";
  btn.style.cssText = `
    padding: 0 11px;
    height: 100%;
    border: none;
    background: transparent;
    color: #1d9bf0;
    font-size: 12px;
    font-weight: bold;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s;
  `;

  btn.addEventListener("mouseenter", () => {
    if (!btn.disabled) btn.style.background = "rgba(29, 155, 240, 0.14)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "transparent";
  });

  let hasGenerated = false;

  async function triggerGenerate(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    const selectedStyle = styleSelect.value;
    saveStyle(selectedStyle);

    const { targetTweet, threadContext } = extractTweetContext(toolbar);
    if (!targetTweet || !targetTweet.hasContent) {
      alert("未检测到可回复的推文文本或媒体内容");
      return;
    }

    const originalText = hasGenerated ? "🔄 换一条" : "✨ AI 回复";
    btn.innerText = "⏳ 生成中...";
    btn.disabled = true;
    styleSelect.disabled = true;

    // 趁用户点击事件处于激活态时预先唤醒 Draft.js 编辑器焦点
    const preEditor = findEditorForToolbar(toolbar);
    if (preEditor) preEditor.focus();

    try {
      chrome.runtime.sendMessage(
        {
          action: "GENERATE_REPLY",
          payload: {
            style: selectedStyle,
            targetTweet,
            threadContext
          }
        },
        async (response) => {
          btn.disabled = false;
          styleSelect.disabled = false;

          if (chrome.runtime.lastError) {
            btn.innerText = originalText;
            alert(
              "与插件后台通信失败（可能刚重载过插件），请先刷新当前 X 网页后再试！\n详情: " +
                chrome.runtime.lastError.message
            );
            return;
          }

          if (response && response.success) {
            hasGenerated = true;
            const contextHint =
              threadContext.length > 0 ? `（已结合 ${threadContext.length} 条楼层背景）` : "";
            btn.innerText = "🔄 换一条";
            btn.title = `再次点击将重新生成并覆盖当前草稿 ${contextHint}`;

            const editor = findEditorForToolbar(toolbar);
            await insertTextToDraftJs(editor, response.reply);
          } else {
            btn.innerText = originalText;
            alert("生成失败: " + (response?.error || "未知错误"));
          }
        }
      );
    } catch (err) {
      btn.disabled = false;
      styleSelect.disabled = false;
      btn.innerText = originalText;
      alert("插件已更新，请先按 Cmd+R 刷新当前 X 页面后再试！");
    }
  }

  btn.addEventListener("click", triggerGenerate);

  // 切换风格时直接触发生成并覆盖原有内容
  styleSelect.addEventListener("change", (e) => {
    triggerGenerate(e);
  });
  styleSelect.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  wrapper.appendChild(styleSelect);
  wrapper.appendChild(btn);
  toolbar.appendChild(wrapper);
}

// 查找与当前工具栏对应的输入框（防止详情页与弹窗输入框混淆）
function findEditorForToolbar(toolbar) {
  let node = toolbar.parentElement;
  while (node && node !== document.body) {
    const editor = node.querySelector('[data-testid="tweetTextarea_0"]');
    if (editor) return editor;
    node = node.parentElement;
  }
  const modal = toolbar.closest('[role="dialog"]');
  if (modal) {
    const modalEditor = modal.querySelector('[data-testid="tweetTextarea_0"]');
    if (modalEditor) return modalEditor;
  }
  return document.querySelector('[data-testid="tweetTextarea_0"]');
}

// 从单个推文 DOM 节点提取作者、正文、引用推文、图片/视频/卡片等结构化信息
function extractSingleTweet(article) {
  if (!article) return null;

  // 1. 提取作者
  const userNameEl = article.querySelector('[data-testid="User-Name"]');
  const author = userNameEl
    ? userNameEl.innerText.replace(/\s+/g, " ").trim()
    : "";

  // 2. 区分主推文文本与内嵌引用推文文本 (Quote Tweet)
  const textEls = Array.from(article.querySelectorAll('[data-testid="tweetText"]'));
  const timeEl = article.querySelector("time[datetime]");
  const ownLink = timeEl ? timeEl.closest('a[href*="/status/"]') : null;
  const ownId = X_AI_CAPTURE.statusIdFromHref(ownLink ? ownLink.getAttribute("href") : "");

  const text = textEls.length >= 1 ? tweetTextFromEl(textEls[0], ownId) : "";

  const quotedText = textEls
    .slice(1)
    .map((el) => {
      // 引用卡片自身是个 role="link" 容器，里面另有一条指向被引用推文的链接
      const card = el.closest('[role="link"]');
      const link = card ? card.querySelector('a[href*="/status/"]') : null;
      return tweetTextFromEl(el, X_AI_CAPTURE.statusIdFromHref(link ? link.getAttribute("href") : ""));
    })
    .filter(Boolean)
    .join(" / ");

  // 3. 提取图片、视频、外链卡片、投票等媒体信息
  const mediaSummary = [];
  const imageUrls = [];

  const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'));
  if (photos.length > 0) {
    const altTexts = [];
    photos.forEach((img) => {
      if (img.src) imageUrls.push(img.src);
      const alt = (img.getAttribute("alt") || "").trim();
      if (alt && !["Image", "图像", "图片"].includes(alt)) {
        altTexts.push(alt);
      }
    });
    if (altTexts.length > 0) {
      mediaSummary.push(`包含 ${photos.length} 张图片（图片描述: ${altTexts.join("；")}）`);
    } else {
      mediaSummary.push(`包含 ${photos.length} 张图片`);
    }
  }

  const videoEl = article.querySelector(
    '[data-testid="videoPlayer"], [data-testid="videoComponent"], video'
  );
  if (videoEl) {
    mediaSummary.push("包含视频/动图");
    const rawVideo = videoEl.tagName === "VIDEO" ? videoEl : videoEl.querySelector("video");
    if (rawVideo && rawVideo.poster) {
      imageUrls.push(rawVideo.poster);
    }
  }

  const cardEl = article.querySelector('[data-testid="card.wrapper"]');
  if (cardEl) {
    const cardText = cardEl.innerText.replace(/\s+/g, " ").trim();
    if (cardText) {
      mediaSummary.push(`分享外链卡片: ${cardText.slice(0, 120)}`);
    }
  }

  const pollEl = article.querySelector('[data-testid="cardPoll"]');
  if (pollEl) {
    const pollText = pollEl.innerText.replace(/\s+/g, " ").trim();
    if (pollText) {
      mediaSummary.push(`发起投票: ${pollText.slice(0, 120)}`);
    }
  }

  const hasContent = Boolean(text || quotedText || mediaSummary.length > 0);
  const signature = `${author}::${text}::${quotedText}::${mediaSummary.join(",")}`;

  return {
    author,
    text,
    quotedText,
    mediaSummary,
    imageUrls,
    hasContent,
    signature
  };
}

// 收集页面上直到指定推文为止的上下文链（主帖 + 楼中楼上级评论）
function collectPageChainUpTo(targetArticle) {
  const allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const targetIdx = allArticles.indexOf(targetArticle);
  if (targetIdx === -1) {
    const single = extractSingleTweet(targetArticle);
    return single && single.hasContent ? [single] : [];
  }

  const chain = [];
  // 1. 始终纳入页面第一条主帖（原帖 1 楼）
  const rootTweet = extractSingleTweet(allArticles[0]);
  if (rootTweet && rootTweet.hasContent) {
    chain.push(rootTweet);
  }

  // 2. 如果目标在评论区较深位置，纳入紧邻目标上方的 1~2 条前置楼层作为直接对话上下文
  const startIdx = Math.max(1, targetIdx - 2);
  for (let i = startIdx; i <= targetIdx; i++) {
    const item = extractSingleTweet(allArticles[i]);
    if (item && item.hasContent && !chain.some((c) => c.signature === item.signature)) {
      chain.push(item);
    }
  }

  return chain;
}

// 获取当前正在回复的目标推文及楼中楼上下文
function extractTweetContext(toolbar) {
  // 场景 1：弹窗回复（Modal）
  const modal = toolbar.closest('[role="dialog"]');
  if (modal) {
    const modalArticles = Array.from(modal.querySelectorAll('article[data-testid="tweet"]'));
    const modalTweets = modalArticles
      .map(extractSingleTweet)
      .filter((t) => t && t.hasContent);

    // 兼容弹窗内未包裹在 article 中的简版推文结构
    if (modalTweets.length === 0) {
      const fallbackTweet = extractSingleTweet(modal);
      if (fallbackTweet && fallbackTweet.hasContent) {
        modalTweets.push(fallbackTweet);
      }
    }

    const targetTweet = modalTweets[modalTweets.length - 1] || null;
    const threadContext = [];

    // 如果在推文详情页点开楼中楼弹窗，合并之前捕获的主帖与上级评论链
    if (window.location.pathname.includes("/status/") && lastClickedReplyChain.length > 0) {
      lastClickedReplyChain.forEach((item) => {
        if (
          targetTweet &&
          item.signature !== targetTweet.signature &&
          !threadContext.some((c) => c.signature === item.signature)
        ) {
          threadContext.push(item);
        }
      });
    } else if (window.location.pathname.includes("/status/")) {
      // 兜底：若未触发点击捕获，提取详情页主推文作为 1 楼背景
      const rootArticle = document.querySelector('main article[data-testid="tweet"]');
      const rootTweet = extractSingleTweet(rootArticle);
      if (
        rootTweet &&
        rootTweet.hasContent &&
        targetTweet &&
        rootTweet.signature !== targetTweet.signature
      ) {
        threadContext.push(rootTweet);
      }
    }

    // 合并弹窗自身展示的多级上级推文
    modalTweets.slice(0, -1).forEach((item) => {
      if (
        targetTweet &&
        item.signature !== targetTweet.signature &&
        !threadContext.some((c) => c.signature === item.signature)
      ) {
        threadContext.push(item);
      }
    });

    return { targetTweet, threadContext: threadContext.slice(-4) };
  }

  // 场景 2：推文详情页内嵌回复框（取位于回复框上方的推文链，最后一条为当前主推文，前面为上级推文）
  const allArticles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const precedingArticles = allArticles.filter(
    (article) =>
      Boolean(article.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING)
  );

  const candidates = (precedingArticles.length > 0 ? precedingArticles : allArticles.slice(0, 1))
    .map(extractSingleTweet)
    .filter((t) => t && t.hasContent);

  if (candidates.length === 0) {
    return { targetTweet: null, threadContext: [] };
  }

  const targetTweet = candidates[candidates.length - 1];
  const threadContext = candidates.slice(0, -1).slice(-4);

  return { targetTweet, threadContext };
}

// 向 X 的 Draft.js 编辑器写入文本（支持清空覆盖已有内容并触发内部状态更新）
async function insertTextToDraftJs(editor, text) {
  if (!editor || !text) return;

  const editable =
    editor.getAttribute("contenteditable") === "true"
      ? editor
      : editor.querySelector('[contenteditable="true"]') || editor;

  editable.focus();

  const existingText = (editable.innerText || "").trim();
  if (existingText.length > 0) {
    // 1. 选中编辑器内全部已有文本并通知 Draft.js 同步 SelectionState
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("selectAll", false, null);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    editable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // 等待 Draft.js 内部完成选区状态同步后执行删除
    await new Promise((resolve) => setTimeout(resolve, 35));
    document.execCommand("delete", false, null);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  editable.focus();

  // 2. 使用伪造的剪贴板粘贴事件写入新生成的回复，点亮“回复”按钮
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  const pasteEvent = new ClipboardEvent("paste", {
    clipboardData: dataTransfer,
    bubbles: true,
    cancelable: true
  });
  editable.dispatchEvent(pasteEvent);

  // 3. 兜底校验：若因失焦导致粘贴事件未被 Draft.js 接收，使用 execCommand('insertText') 补写
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (!(editable.innerText || "").trim()) {
    editable.focus();
    document.execCommand("insertText", false, text);
  }
}

// ============================================================================
// 模块二：多维度热门帖抓取雷达 + 单帖「🪄 仿写」按钮 + 右侧「🔥 热门选题改写台」
// ============================================================================

// 解析 X 上的紧凑数字格式（如 "1.2万", "3.5K", "2.1M", "1,234"）
function parseCompactNumber(raw) {
  if (!raw) return 0;
  const cleaned = String(raw).replace(/,/g, "").trim();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*([万亿KkMmBb])?/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  if (Number.isNaN(num)) return 0;
  const unit = match[2];
  if (unit === "万") return Math.round(num * 10000);
  if (unit === "亿") return Math.round(num * 100000000);
  if (unit === "K" || unit === "k") return Math.round(num * 1000);
  if (unit === "M" || unit === "m") return Math.round(num * 1000000);
  if (unit === "B" || unit === "b") return Math.round(num * 1000000000);
  return Math.round(num);
}

function formatCompactNumber(num) {
  if (!num || num <= 0) return "0";
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(num);
}

// 从单条推文 DOM 提取曝光、点赞、评论、转发、收藏、发布时长及链接
function extractTweetMetrics(article) {
  const group = article.querySelector('[role="group"]');
  let replies = 0;
  let reposts = 0;
  let likes = 0;
  let bookmarks = 0;
  let views = 0;

  // 1. 从各按钮节点提取数值
  const replyEl = article.querySelector('[data-testid="reply"]');
  const retweetEl = article.querySelector(
    '[data-testid="retweet"], [data-testid="unretweet"]'
  );
  const likeEl = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
  const bookmarkEl = article.querySelector(
    '[data-testid="bookmark"], [data-testid="removeBookmark"]'
  );
  const viewsEl = article.querySelector('a[href*="/analytics"]');

  if (replyEl) replies = parseCompactNumber(replyEl.innerText || replyEl.getAttribute("aria-label"));
  if (retweetEl)
    reposts = parseCompactNumber(retweetEl.innerText || retweetEl.getAttribute("aria-label"));
  if (likeEl) likes = parseCompactNumber(likeEl.innerText || likeEl.getAttribute("aria-label"));
  if (bookmarkEl)
    bookmarks = parseCompactNumber(bookmarkEl.innerText || bookmarkEl.getAttribute("aria-label"));
  if (viewsEl) views = parseCompactNumber(viewsEl.innerText || viewsEl.getAttribute("aria-label"));

  // 2. 从操作栏汇总 aria-label 兜底提取（例如："15 回复、4 转帖、89 喜欢、12 书签、12345 查看"）
  const groupAria = (group && group.getAttribute("aria-label")) || "";
  if (groupAria) {
    const extractFromAria = (regex) => {
      const m = groupAria.match(regex);
      return m ? parseCompactNumber(m[1]) : 0;
    };
    if (!replies)
      replies = extractFromAria(/(\d+(?:\.\d+)?[万亿KkMm]?)\s*(?:回复|回覆|repl)/i);
    if (!reposts)
      reposts = extractFromAria(/(\d+(?:\.\d+)?[万亿KkMm]?)\s*(?:转帖|轉帖|转发|repost|retweet)/i);
    if (!likes)
      likes = extractFromAria(/(\d+(?:\.\d+)?[万亿KkMm]?)\s*(?:喜欢|喜歡|赞|like)/i);
    if (!bookmarks)
      bookmarks = extractFromAria(/(\d+(?:\.\d+)?[万亿KkMm]?)\s*(?:书签|書籤|bookmark)/i);
    if (!views)
      views = extractFromAria(/(\d+(?:\.\d+)?[万亿KkMm]?)\s*(?:查看|观看|觀看|view)/i);
  }

  // 3. 发布时间与直达链接
  let ageHours = null;
  let datetime = "";
  let tweetUrl = "";
  const timeEl = article.querySelector("time[datetime]");
  if (timeEl) {
    datetime = timeEl.getAttribute("datetime") || "";
    const dt = new Date(timeEl.getAttribute("datetime")).getTime();
    if (!Number.isNaN(dt)) {
      ageHours = Math.max(0.1, (Date.now() - dt) / 3600000);
    }
    const linkParent = timeEl.closest('a[href*="/status/"]');
    if (linkParent) {
      tweetUrl = linkParent.href;
    }
  }
  if (!tweetUrl) {
    const fallbackLink = article.querySelector('a[href*="/status/"]');
    if (fallbackLink) tweetUrl = fallbackLink.href.split("/photo/")[0].split("/analytics")[0];
  }

  // 4. 识别是否为广告推广帖
  const isAd =
    Boolean(article.querySelector('[data-testid="placementTracking"]')) ||
    Array.from(article.querySelectorAll("span")).some((sp) =>
      ["Ad", "推广", "Promoted"].includes((sp.innerText || "").trim())
    );

  return {
    views,
    likes,
    replies,
    reposts,
    bookmarks,
    ageHours,
    datetime,
    tweetUrl,
    isAd
  };
}

// 热门帖曝光量上限：只抓取少于 10 万曝光（views < 100000）的潜力热门帖
const MAX_HOT_VIEWS = 100000;

// 多维度热门度评估算法（曝光 + 点赞 + 评论 + 转发 + 收藏 + 互动率 + 时间爆发力）
function evaluateTweetHotness(metrics, preset = "balanced") {
  const { views, likes, replies, reposts, bookmarks, ageHours } = metrics;

  // 互动转化率（加权互动 / 曝光）
  const weightedEngagements = likes + replies * 2 + reposts * 2 + bookmarks;
  const engagementRate = views > 0 ? Number(((weightedEngagements / views) * 100).toFixed(2)) : 0;

  // 综合热度分计算：曝光*0.01 + 赞*3 + 评论*6 + 转发*5 + 收藏*4，6小时内新帖享受 1.4x 爆发加成
  const baseScore =
    views * 0.01 + likes * 3 + replies * 6 + reposts * 5 + bookmarks * 4;
  const freshnessMultiplier = ageHours !== null && ageHours <= 6 ? 1.4 : 1.0;
  const hotScore = Math.round(baseScore * freshnessMultiplier);

  // 多维入选判定（硬性条件：曝光量必须少于 10 万，过滤已经泛滥的百万级大V老帖）
  let isHot = false;
  if (views >= MAX_HOT_VIEWS) {
    isHot = false;
  } else if (preset === "strict") {
    isHot =
      (views >= 10000 && (likes >= 40 || replies >= 15)) ||
      likes >= 80 ||
      replies >= 30 ||
      bookmarks >= 40;
  } else if (preset === "loose") {
    isHot = views >= 200 || likes >= 4 || replies >= 2 || bookmarks >= 3;
  } else {
    // 默认 balanced（智能多维判定，且 views < 100000）：
    // 维度A: 曝光过千且赞/评达标
    // 维度B: 评论区讨论热烈（评论>=8）
    // 维度C: 高赞或高收藏干货（赞>=20 或 收藏>=10）
    // 维度D: 高转化黑马（曝光>=300 且 互动率>=3% 且 赞+评>=6）
    isHot =
      (views >= 1500 && (likes >= 12 || replies >= 5)) ||
      replies >= 8 ||
      likes >= 20 ||
      bookmarks >= 10 ||
      (views >= 300 && engagementRate >= 3.0 && likes + replies >= 6);
  }

  // 生成多维爆款归因标签
  const tags = [];
  if (views >= 10000 && (likes >= 30 || replies >= 12)) {
    tags.push("🔥 高曝大爆款");
  }
  if (replies >= 8 && (replies >= likes * 0.35 || replies >= 20)) {
    tags.push("💬 评论区炸锅");
  }
  if (bookmarks >= 8 && bookmarks >= likes * 0.25) {
    tags.push("📌 干货高收藏");
  }
  if (engagementRate >= 3.0 && likes + replies >= 8) {
    tags.push("📈 高转化黑马");
  }
  if (ageHours !== null && ageHours <= 4 && (views >= 1000 || likes >= 10 || replies >= 5)) {
    tags.push("🚀 新帖飙升");
  }
  if (isHot && tags.length === 0) {
    tags.push("🔥 多维热门");
  }

  const metricsText = `👀 ${formatCompactNumber(views)}  ❤️ ${formatCompactNumber(
    likes
  )}  💬 ${formatCompactNumber(replies)}  🔁 ${formatCompactNumber(
    reposts
  )}  🔖 ${formatCompactNumber(bookmarks)}${
    engagementRate > 0 ? ` · 互动率 ${engagementRate}%` : ""
  }`;

  return {
    isHot,
    hotScore,
    engagementRate,
    tags,
    metricsText
  };
}

// 扫描当前可视区域推文：注入单帖「🪄 仿写」按钮 + 自动收录多维热门帖
function scanVisibleTweets() {
  const articles = document.querySelectorAll('article[data-testid="tweet"]');
  let poolUpdated = false;

  articles.forEach((article) => {
    const baseTweet = extractSingleTweet(article);
    if (!baseTweet || !baseTweet.hasContent) return;

    const metrics = extractTweetMetrics(article);
    if (metrics.isAd) return;

    const evaluation = evaluateTweetHotness(metrics, currentThresholdPreset);
    const tweetKey = metrics.tweetUrl || baseTweet.signature;

    const enrichedPost = {
      ...baseTweet,
      ...metrics,
      ...evaluation,
      tweetKey
    };

    // 注入或更新每条推文底部的「🪄 仿写 / 🔥 爆款仿写」按钮
    injectOrUpdateRewriteBtnOnArticle(article, enrichedPost);

    // 采集模式：滚动刷到的帖子一律记录，不受热门门槛影响
    if (captureState.active) captureScannedPost(enrichedPost);

    // 若满足多维热门标准（含曝光 < 10万），且正文字数 >= 10，加入热门池
    const contentLength = (baseTweet.text || "").length + (baseTweet.quotedText || "").length;
    if (evaluation.isHot && contentLength >= 10) {
      const existing = hotPostsPool.get(tweetKey);
      // 全文是后到的：正文变长时也要刷新池子里那份，否则仿写台拿到的还是截断版
      if (!existing || existing.hotScore !== evaluation.hotScore || existing.text !== baseTweet.text) {
        hotPostsPool.set(tweetKey, enrichedPost);
        poolUpdated = true;
      }
    } else if (hotPostsPool.has(tweetKey)) {
      hotPostsPool.delete(tweetKey);
      poolUpdated = true;
    }
  });

  if (poolUpdated) {
    updateRadarBadgeAndList();
  }
}

// 入口1：在每条推文底部工具栏注入「🪄 仿写」/「🔥 爆款仿写」按钮
function injectOrUpdateRewriteBtnOnArticle(article, enrichedPost) {
  const actionGroup = article.querySelector('[role="group"]');
  if (!actionGroup) return;

  let btn = actionGroup.querySelector(".x-ai-rewrite-inline-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "x-ai-rewrite-inline-btn";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const latestData = btn._postData || enrichedPost;
      openRewriteWorkbench(latestData, true);
    });
    actionGroup.appendChild(btn);
  }

  btn._postData = enrichedPost;

  if (enrichedPost.isHot) {
    btn.innerText = `🔥 爆款仿写`;
    btn.title = `${enrichedPost.tags.join(" | ")}（热度分: ${enrichedPost.hotScore}）\n${
      enrichedPost.metricsText
    }\n点击按原帖的创作风格一键仿写`;
    btn.style.cssText = `
      align-self: center;
      margin-left: 6px;
      padding: 2px 9px;
      border-radius: 9999px;
      border: 1px solid #f97316;
      background: rgba(249, 115, 22, 0.12);
      color: #f97316;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    `;
  } else {
    btn.innerText = "🪄 仿写";
    btn.title = `将此帖用 AI 改写为你的原创推文\n${enrichedPost.metricsText}`;
    btn.style.cssText = `
      align-self: center;
      margin-left: 6px;
      padding: 2px 8px;
      border-radius: 9999px;
      border: 1px solid rgba(113, 118, 123, 0.45);
      background: transparent;
      color: #71767b;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    `;
  }
}

// 入口2：右侧悬浮「🔥 热门选题与 AI 改写工作台」
let radarUI = null;

function ensureHotRadarMounted() {
  if (document.getElementById("x-ai-hot-radar-root")) return;

  const root = document.createElement("div");
  root.id = "x-ai-hot-radar-root";
  root.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 20px;
    z-index: 99999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;

  // 悬浮触发胶囊按钮
  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.style.cssText = `
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 15px;
    border-radius: 9999px;
    border: 1px solid rgba(249, 115, 22, 0.6);
    background: linear-gradient(135deg, #0f1419 0%, #1e293b 100%);
    color: #ffffff;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
    transition: transform 0.15s;
  `;
  toggleBtn.innerHTML = `<span>🔥 热门改写台</span><span id="x-ai-hot-count-badge" style="background:#f97316;color:#fff;padding:1px 7px;border-radius:999px;font-size:11px;">0</span>`;

  // 抽屉主面板
  const panel = document.createElement("div");
  panel.style.cssText = `
    display: none;
    flex-direction: column;
    width: 390px;
    max-height: 86vh;
    margin-bottom: 10px;
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: #15202b;
    color: #f7f9f9;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
    overflow-y: auto;
  `;

  // 1. 顶部标题栏
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    background: #1e2732;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  `;
  header.innerHTML = `
    <div style="font-size:14px;font-weight:800;display:flex;align-items:center;gap:6px;">
      <span>🔥 爆款捕手 · 仿原帖文风改写台</span>
    </div>
    <button type="button" id="x-ai-panel-close" style="background:transparent;border:none;color:#8b98a5;font-size:16px;cursor:pointer;padding:2px 6px;">✕</button>
  `;

  // 2. AI 改写工作区（上半部分）
  const studioBox = document.createElement("div");
  studioBox.style.cssText = `
    padding: 12px 14px;
    background: #192734;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
    gap: 8px;
  `;

  const sourceHint = document.createElement("div");
  sourceHint.style.cssText = `
    font-size: 11px;
    color: #8b98a5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `;
  sourceHint.innerText = "💡 点击任意推文下方「🪄 仿写」或下方热门榜单，即按原帖创作风格仿写";

  // 博主主页帖子采集控制条
  const pillCss =
    "padding:5px 10px;border-radius:999px;border:1px solid rgba(255,255,255,0.2);" +
    "background:transparent;color:#e7e9ea;font-size:11px;font-weight:700;cursor:pointer;";

  const captureBar = document.createElement("div");
  captureBar.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

  const captureToggleBtn = document.createElement("button");
  captureToggleBtn.type = "button";
  captureToggleBtn.style.cssText = pillCss;
  captureToggleBtn.addEventListener("click", toggleCapture);

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.innerText = "⬇ 导出 MD";
  exportBtn.style.cssText = pillCss;
  exportBtn.addEventListener("click", () => exportCaptureToMarkdown());

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.innerText = "✕ 清空";
  clearBtn.style.cssText = pillCss;
  clearBtn.addEventListener("click", () => {
    if (confirm("确定清空已采集的帖子？未导出的内容会丢失。")) clearCapturePosts();
  });

  const captureStatus = document.createElement("span");
  captureStatus.style.cssText = "font-size:11px;color:#8b98a5;";

  captureBar.appendChild(captureToggleBtn);
  captureBar.appendChild(exportBtn);
  captureBar.appendChild(clearBtn);
  captureBar.appendChild(captureStatus);

  // 手动粘贴原帖改写区（支持直接粘贴任意帖子文本一键改写）
  const pasteBox = document.createElement("div");
  pasteBox.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(15, 20, 25, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.12);
  `;

  const pasteTextarea = document.createElement("textarea");
  pasteTextarea.rows = 3;
  pasteTextarea.placeholder = "📥 在此粘贴你要改写的原帖内容，点击下方「🪄 改写此帖」即可按原帖风格二创...";
  pasteTextarea.style.cssText = `
    width: 100%;
    box-sizing: border-box;
    padding: 7px 9px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: #0f1419;
    color: #f7f9f9;
    font-size: 12px;
    line-height: 1.45;
    resize: vertical;
    outline: none;
  `;

  const pasteActionRow = document.createElement("div");
  pasteActionRow.style.cssText = `
    display: flex;
    align-items: center;
    gap: 6px;
  `;

  const manualRewriteBtn = document.createElement("button");
  manualRewriteBtn.type = "button";
  manualRewriteBtn.innerText = "🪄 改写此帖";
  manualRewriteBtn.style.cssText = `
    flex: 1;
    padding: 6px 12px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(90deg, #f97316 0%, #ea580c 100%);
    color: #ffffff;
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
  `;
  manualRewriteBtn.addEventListener("click", () => {
    const pastedText = pasteTextarea.value.trim();
    if (!pastedText) {
      alert("请先在输入框中粘贴要改写的原帖内容");
      pasteTextarea.focus();
      return;
    }
    const customPost = {
      text: pastedText,
      hasContent: true,
      metricsText: "手动粘贴原帖",
      isManualPaste: true
    };
    openRewriteWorkbench(customPost, true);
  });

  const manualClearBtn = document.createElement("button");
  manualClearBtn.type = "button";
  manualClearBtn.innerText = "✕ 清空";
  manualClearBtn.style.cssText = `
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
    color: #8b98a5;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  `;
  manualClearBtn.addEventListener("click", () => {
    pasteTextarea.value = "";
    pasteTextarea.focus();
  });

  pasteActionRow.appendChild(manualRewriteBtn);
  pasteActionRow.appendChild(manualClearBtn);
  pasteBox.appendChild(pasteTextarea);
  pasteBox.appendChild(pasteActionRow);

  // 展示 AI 从原帖拆解出的创作风格（改写成功后填充）
  const styleHint = document.createElement("div");
  styleHint.style.cssText = `
    font-size: 11px;
    line-height: 1.45;
    color: #06b6d4;
    background: rgba(6, 182, 212, 0.08);
    border: 1px solid rgba(6, 182, 212, 0.25);
    border-radius: 8px;
    padding: 5px 8px;
    display: none;
    word-break: break-word;
  `;

  // 改写结果可编辑文本框
  const rewriteTextarea = document.createElement("textarea");
  rewriteTextarea.rows = 5;
  rewriteTextarea.placeholder = "AI 改写后的爆款推文会显示在这里，你可以直接微调修改，然后一键填入 X 发帖框...";
  rewriteTextarea.style.cssText = `
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: #0f1419;
    color: #f7f9f9;
    font-size: 13px;
    line-height: 1.45;
    resize: vertical;
    outline: none;
  `;

  // 改写区底部操作按钮栏
  const studioActionRow = document.createElement("div");
  studioActionRow.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
  `;

  const fillComposerBtn = document.createElement("button");
  fillComposerBtn.type = "button";
  fillComposerBtn.innerText = "🚀 一键填入发帖框";
  fillComposerBtn.style.cssText = `
    flex: 1;
    padding: 7px 12px;
    border-radius: 999px;
    border: none;
    background: linear-gradient(90deg, #1d9bf0 0%, #0ea5e9 100%);
    color: #ffffff;
    font-size: 12px;
    font-weight: 800;
    cursor: pointer;
  `;
  fillComposerBtn.addEventListener("click", async () => {
    const content = rewriteTextarea.value.trim();
    if (!content) {
      alert("请先选择一条推文生成改写文案，或在文本框中输入内容");
      return;
    }
    await fillIntoGlobalPostComposer(content);
  });

  const regenBtn = document.createElement("button");
  regenBtn.type = "button";
  regenBtn.innerText = "🔄 换一版";
  regenBtn.style.cssText = `
    padding: 7px 11px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
    color: #e7e9ea;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  `;
  regenBtn.addEventListener("click", () => {
    const pastedText = pasteTextarea.value.trim();
    if ((!activeRewriteSource || activeRewriteSource.isManualPaste) && pastedText) {
      activeRewriteSource = {
        text: pastedText,
        hasContent: true,
        metricsText: "手动粘贴原帖",
        isManualPaste: true
      };
    }
    if (!activeRewriteSource) {
      alert("请先粘贴原帖点击「🪄 改写此帖」，或在下方热门榜/页面推文中点选一条要改写的原帖");
      return;
    }
    triggerRewriteGeneration(activeRewriteSource);
  });

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.innerText = "📋 复制";
  copyBtn.style.cssText = `
    padding: 7px 11px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: transparent;
    color: #e7e9ea;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  `;
  copyBtn.addEventListener("click", async () => {
    const content = rewriteTextarea.value.trim();
    if (!content) return;
    await navigator.clipboard.writeText(content).catch(() => {});
    copyBtn.innerText = "✅ 已复制";
    setTimeout(() => {
      copyBtn.innerText = "📋 复制";
    }, 1500);
  });

  studioActionRow.appendChild(fillComposerBtn);
  studioActionRow.appendChild(regenBtn);
  studioActionRow.appendChild(copyBtn);

  studioBox.appendChild(sourceHint);
  studioBox.appendChild(captureBar);
  studioBox.appendChild(pasteBox);
  studioBox.appendChild(styleHint);
  studioBox.appendChild(rewriteTextarea);
  studioBox.appendChild(studioActionRow);

  // 3. 热门帖扫描与多维排序控制栏
  const filterBar = document.createElement("div");
  filterBar.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 12px;
    background: #1e2732;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  `;

  const autoScanBtn = document.createElement("button");
  autoScanBtn.type = "button";
  autoScanBtn.innerText = "🔍 自动滚屏抓热帖";
  autoScanBtn.style.cssText = `
    padding: 5px 10px;
    border-radius: 999px;
    border: 1px solid #f97316;
    background: rgba(249, 115, 22, 0.15);
    color: #fb923c;
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
  `;
  autoScanBtn.addEventListener("click", () => {
    toggleAutoTimelineScan(autoScanBtn);
  });

  const thresholdSelect = document.createElement("select");
  thresholdSelect.title = "调整多维热门判定门槛";
  thresholdSelect.style.cssText = `
    padding: 4px 6px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: #0f1419;
    color: #e7e9ea;
    font-size: 11px;
    outline: none;
  `;
  [
    { value: "balanced", text: "🌟 智能多维门槛" },
    { value: "strict", text: "🔥 严选大爆款" },
    { value: "loose", text: "🌱 宽松全收集" }
  ].forEach((optItem) => {
    const o = document.createElement("option");
    o.value = optItem.value;
    o.innerText = optItem.text;
    thresholdSelect.appendChild(o);
  });
  thresholdSelect.addEventListener("change", () => {
    currentThresholdPreset = thresholdSelect.value;
    hotPostsPool.clear();
    scanVisibleTweets();
    updateRadarBadgeAndList();
  });

  const sortSelect = document.createElement("select");
  sortSelect.title = "切换热门帖排序维度";
  sortSelect.style.cssText = `
    padding: 4px 6px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: #0f1419;
    color: #e7e9ea;
    font-size: 11px;
    outline: none;
  `;
  [
    { value: "hotScore", text: "按综合热度" },
    { value: "views", text: "按曝光量 👀" },
    { value: "replies", text: "按评论数 💬" },
    { value: "likes", text: "按点赞数 ❤️" },
    { value: "engagementRate", text: "按互动率 📈" }
  ].forEach((optItem) => {
    const o = document.createElement("option");
    o.value = optItem.value;
    o.innerText = optItem.text;
    sortSelect.appendChild(o);
  });
  sortSelect.addEventListener("change", () => {
    currentSortBy = sortSelect.value;
    updateRadarBadgeAndList();
  });

  filterBar.appendChild(autoScanBtn);
  filterBar.appendChild(thresholdSelect);
  filterBar.appendChild(sortSelect);

  // 4. 热门帖子列表容器
  const listContainer = document.createElement("div");
  listContainer.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 360px;
  `;

  panel.appendChild(header);
  panel.appendChild(studioBox);
  panel.appendChild(filterBar);
  panel.appendChild(listContainer);

  root.appendChild(panel);
  root.appendChild(toggleBtn);
  document.body.appendChild(root);

  toggleBtn.addEventListener("click", () => {
    const isHidden = panel.style.display === "none";
    panel.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
      scanVisibleTweets();
      updateRadarBadgeAndList();
    }
  });

  header.querySelector("#x-ai-panel-close").addEventListener("click", () => {
    panel.style.display = "none";
  });

  radarUI = {
    root,
    panel,
    toggleBtn,
    sourceHint,
    styleHint,
    captureToggleBtn,
    exportBtn,
    clearBtn,
    captureStatus,
    pasteTextarea,
    manualRewriteBtn,
    rewriteTextarea,
    regenBtn,
    listContainer
  };

  restoreCaptureBuffer();
  updateCaptureUi();
  updateRadarBadgeAndList();
}

// 自动向下滚屏扫描当前时间线热门帖
function toggleAutoTimelineScan(btnEl) {
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
    btnEl.innerText = "🔍 自动滚屏抓热帖";
    return;
  }

  let steps = 0;
  const maxSteps = 8;
  btnEl.innerText = `⏹ 扫描中 (0/${maxSteps})...`;

  scanVisibleTweets();
  autoScanTimer = setInterval(() => {
    steps += 1;
    window.scrollBy({ top: window.innerHeight * 0.85, behavior: "smooth" });
    setTimeout(() => {
      scanVisibleTweets();
    }, 450);

    if (steps >= maxSteps) {
      clearInterval(autoScanTimer);
      autoScanTimer = null;
      btnEl.innerText = "🔍 自动滚屏抓热帖";
    } else {
      btnEl.innerText = `⏹ 扫描中 (${steps}/${maxSteps})...`;
    }
  }, 1100);
}

// 刷新热门池角标与列表渲染
function updateRadarBadgeAndList() {
  if (!radarUI) return;
  const badge = document.getElementById("x-ai-hot-count-badge");
  const items = Array.from(hotPostsPool.values());
  if (badge) badge.innerText = String(items.length);

  items.sort((a, b) => (b[currentSortBy] || 0) - (a[currentSortBy] || 0));

  const container = radarUI.listContainer;
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;color:#8b98a5;font-size:12px;padding:24px 10px;">
        当前还没抓到满足条件的热门帖。<br/>你可以点击上方 <b>「🔍 自动滚屏抓热帖」</b>，或将门槛切换为「🌱 宽松全收集」。
      </div>
    `;
    return;
  }

  items.slice(0, 30).forEach((item) => {
    const card = document.createElement("div");
    card.style.cssText = `
      padding: 10px 11px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: #1e2732;
      display: flex;
      flex-direction: column;
      gap: 6px;
    `;

    const topRow = document.createElement("div");
    topRow.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      flex-wrap: wrap;
    `;

    const tagsHtml = (item.tags || [])
      .map(
        (t) =>
          `<span style="background:rgba(249,115,22,0.18);color:#fb923c;border:1px solid rgba(249,115,22,0.4);padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;">${t}</span>`
      )
      .join(" ");

    topRow.innerHTML = `
      <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">${tagsHtml}</div>
      <span style="font-size:11px;color:#38bdf8;font-weight:700;">热度分 ${item.hotScore}</span>
    `;

    const textPreview = document.createElement("div");
    textPreview.style.cssText = `
      font-size: 12px;
      color: #e7e9ea;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    `;
    textPreview.innerText =
      (item.author ? `[${item.author}] ` : "") +
      (item.text || item.quotedText || "[富媒体推文]");

    const bottomRow = document.createElement("div");
    bottomRow.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-top: 2px;
    `;

    const metricsSpan = document.createElement("span");
    metricsSpan.style.cssText = `font-size: 10px; color: #8b98a5;`;
    metricsSpan.innerText = item.metricsText;

    const btnGroup = document.createElement("div");
    btnGroup.style.cssText = `display: flex; gap: 5px; flex-shrink: 0;`;

    const rewriteBtn = document.createElement("button");
    rewriteBtn.type = "button";
    rewriteBtn.innerText = "🪄 改写";
    rewriteBtn.style.cssText = `
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid #1d9bf0;
      background: rgba(29, 155, 240, 0.15);
      color: #38bdf8;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    `;
    rewriteBtn.addEventListener("click", () => {
      openRewriteWorkbench(item, true);
    });

    btnGroup.appendChild(rewriteBtn);

    if (item.tweetUrl) {
      const openLinkBtn = document.createElement("a");
      openLinkBtn.href = item.tweetUrl;
      openLinkBtn.target = "_blank";
      openLinkBtn.innerText = "🔗 原帖";
      openLinkBtn.style.cssText = `
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        color: #8b98a5;
        font-size: 11px;
        text-decoration: none;
      `;
      btnGroup.appendChild(openLinkBtn);
    }

    bottomRow.appendChild(metricsSpan);
    bottomRow.appendChild(btnGroup);

    card.appendChild(topRow);
    card.appendChild(textPreview);
    card.appendChild(bottomRow);
    container.appendChild(card);
  });
}

// 打开改写工作台并立即调用 AI 按原帖创作风格二创改写
function openRewriteWorkbench(postItem, autoTrigger = true) {
  ensureHotRadarMounted();
  activeRewriteSource = postItem;
  radarUI.panel.style.display = "flex";

  const snippet = (postItem.text || postItem.quotedText || "[媒体帖]")
    .replace(/\s+/g, " ")
    .slice(0, 42);
  radarUI.sourceHint.innerText = `🎯 原帖 (${postItem.metricsText || "已选中"}): ${snippet}...`;

  if (autoTrigger) {
    triggerRewriteGeneration(postItem);
  }
}

function triggerRewriteGeneration(sourceTweet) {
  if (!radarUI || !sourceTweet) return;

  radarUI.styleHint.style.display = "none";
  radarUI.rewriteTextarea.value = "⏳ 正在拆解原帖创作风格并仿写...";
  radarUI.rewriteTextarea.disabled = true;
  radarUI.regenBtn.disabled = true;
  if (radarUI.manualRewriteBtn) {
    radarUI.manualRewriteBtn.disabled = true;
    radarUI.manualRewriteBtn.innerText = "⏳ 改写中...";
  }

  try {
    chrome.runtime.sendMessage(
      {
        action: "REWRITE_POST",
        payload: { sourceTweet }
      },
      (response) => {
        radarUI.rewriteTextarea.disabled = false;
        radarUI.regenBtn.disabled = false;
        if (radarUI.manualRewriteBtn) {
          radarUI.manualRewriteBtn.disabled = false;
          radarUI.manualRewriteBtn.innerText = "🪄 改写此帖";
        }

        if (chrome.runtime.lastError) {
          radarUI.rewriteTextarea.value = "";
          alert("插件刚更新过，请先按 Cmd+R 刷新当前 X 页面后再试！");
          return;
        }

        if (response && response.success) {
          radarUI.rewriteTextarea.value = response.text;
          if (response.styleProfile) {
            radarUI.styleHint.innerText = `🪞 识别到的原帖风格：${response.styleProfile}`;
            radarUI.styleHint.style.display = "block";
          }
        } else {
          radarUI.rewriteTextarea.value = "";
          alert("改写失败: " + (response?.error || "未知错误"));
        }
      }
    );
  } catch {
    radarUI.rewriteTextarea.disabled = false;
    radarUI.regenBtn.disabled = false;
    if (radarUI.manualRewriteBtn) {
      radarUI.manualRewriteBtn.disabled = false;
      radarUI.manualRewriteBtn.innerText = "🪄 改写此帖";
    }
    radarUI.rewriteTextarea.value = "";
    alert("插件已更新，请先按 Cmd+R 刷新当前 X 页面后再试！");
  }
}

// 一键唤起 X 全局发帖框并将改写后的推文填入（由真人确认后点击发送）
async function fillIntoGlobalPostComposer(text) {
  // 1. 优先检查是否已经打开了发帖弹窗 ([role="dialog"] 内的编辑器)
  let modalEditor = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');

  // 2. 如果未打开弹窗，自动点击左侧导航栏的「发帖 (Post)」按钮唤起全新原创发帖弹窗
  if (!modalEditor) {
    const newPostBtn =
      document.querySelector('[data-testid="SideNav_NewTweet_Button"]') ||
      document.querySelector('a[href="/compose/post"]');
    if (newPostBtn) {
      newPostBtn.click();
      // 等待发帖弹窗渲染完成
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 80));
        modalEditor = document.querySelector(
          '[role="dialog"] [data-testid="tweetTextarea_0"]'
        );
        if (modalEditor) break;
      }
    }
  }

  // 3. 若弹窗仍未出现，回退使用首页顶部的发帖输入框
  const targetEditor =
    modalEditor || document.querySelector('main [data-testid="tweetTextarea_0"]');

  if (!targetEditor) {
    await navigator.clipboard.writeText(text).catch(() => {});
    alert("未找到发帖输入框，已自动为你复制到剪贴板，可直接按 Cmd+V 粘贴发帖！");
    return;
  }

  await insertTextToDraftJs(targetEditor, text);
}

// ============================================================================
// 模块三：博主主页帖子采集（滚动即记录，导出为本地 Markdown）
// ============================================================================

const CAPTURE_STORAGE_KEY = "x_ai_capture_buffer";

const captureState = {
  active: false,
  handle: "",
  profileUrl: "",
  buffer: X_AI_CAPTURE.createCaptureBuffer()
};

let capturePersistTimer = null;

function persistCaptureBuffer() {
  try {
    localStorage.setItem(
      CAPTURE_STORAGE_KEY,
      JSON.stringify({
        handle: captureState.handle,
        profileUrl: captureState.profileUrl,
        posts: captureState.buffer.posts
      })
    );
  } catch {
    // 超出 localStorage 配额时降级为只在内存保留，导出依旧可用
  }
}

function scheduleCapturePersist() {
  if (capturePersistTimer) return;
  capturePersistTimer = setTimeout(() => {
    capturePersistTimer = null;
    persistCaptureBuffer();
  }, 1200);
}

// 刷新页面后找回上一批没导出的帖子
function restoreCaptureBuffer() {
  let raw = "";
  try {
    raw = localStorage.getItem(CAPTURE_STORAGE_KEY) || "";
  } catch {
    return;
  }
  if (!raw) return;

  try {
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.posts) || saved.posts.length === 0) return;
    captureState.handle = saved.handle || "";
    captureState.profileUrl = saved.profileUrl || "";
    saved.posts.forEach((item) => X_AI_CAPTURE.addCapture(captureState.buffer, item));
  } catch {
    try {
      localStorage.removeItem(CAPTURE_STORAGE_KEY);
    } catch {
      // 存储不可用，忽略
    }
  }
}

function clearCapturePosts() {
  captureState.buffer = X_AI_CAPTURE.createCaptureBuffer();
  persistCaptureBuffer();
  updateCaptureUi();
}

function captureScannedPost(enrichedPost) {
  const item = {
    authorHandle: X_AI_CAPTURE.handleFromAuthorText(enrichedPost.author),
    author: enrichedPost.author,
    text: enrichedPost.text,
    quotedText: enrichedPost.quotedText,
    mediaSummary: enrichedPost.mediaSummary,
    tweetUrl: enrichedPost.tweetUrl,
    datetime: enrichedPost.datetime,
    metricsText: enrichedPost.metricsText,
    isAd: enrichedPost.isAd
  };
  if (!X_AI_CAPTURE.shouldCapture(item, captureState.handle)) return;
  if (!X_AI_CAPTURE.addCapture(captureState.buffer, item)) return;

  scheduleCapturePersist();
  updateCaptureUi();

  if (captureState.buffer.posts.length >= X_AI_CAPTURE.MAX_CAPTURE) {
    stopCapture();
    alert(`已采满 ${X_AI_CAPTURE.MAX_CAPTURE} 条（单文件上限），自动停止并导出。`);
    exportCaptureToMarkdown();
  }
}

function startCapture() {
  const pageHandle = X_AI_CAPTURE.resolveProfileHandle(location.href);
  const buffered = captureState.buffer.posts.length;

  if (buffered > 0 && pageHandle !== captureState.handle) {
    const from = captureState.handle ? `@${captureState.handle}` : "上一批";
    const to = pageHandle ? `@${pageHandle}` : "当前页（不限作者）";
    if (!confirm(`缓冲区里还有 ${from} 的 ${buffered} 条未导出，改成采集${to}会清空，继续吗？`)) return;
    clearCapturePosts();
  }

  captureState.handle = pageHandle || "";
  captureState.profileUrl = pageHandle
    ? `https://x.com/${pageHandle}`
    : location.href.split("?")[0];
  captureState.active = true;
  updateCaptureUi();

  // 立即把当前屏幕上的帖子收进来，不等下一次滚动
  scanVisibleTweets();
}

function stopCapture() {
  captureState.active = false;
  persistCaptureBuffer();
  updateCaptureUi();
}

function toggleCapture() {
  if (captureState.active) {
    stopCapture();
    exportCaptureToMarkdown();
  } else {
    startCapture();
  }
}

async function exportCaptureToMarkdown() {
  if (!radarUI) return;

  const posts = captureState.buffer.posts;
  if (posts.length === 0) {
    radarUI.captureStatus.innerText = "缓冲区是空的，先开始采集再滑动浏览";
    return;
  }

  const now = new Date();
  const markdown = X_AI_CAPTURE.renderPostsToMarkdown(posts, {
    handle: captureState.handle,
    profileUrl: captureState.profileUrl || location.href.split("?")[0],
    collectedAt: now
  });
  const filename = `x博主采集/${X_AI_CAPTURE.buildCaptureFilename(captureState.handle, now)}`;

  radarUI.exportBtn.disabled = true;
  radarUI.captureStatus.innerText = "⏳ 正在写出 MD 文件...";

  try {
    const response = await chrome.runtime.sendMessage({
      action: "SAVE_MARKDOWN",
      payload: { markdown, filename }
    });

    if (response && response.success) {
      radarUI.captureStatus.innerText = `✅ 已导出 ${posts.length} 条到「下载/${response.filename}」`;
    } else {
      radarUI.captureStatus.innerText = "";
      alert("导出失败：" + (response?.error || "未知错误"));
    }
  } catch (err) {
    radarUI.captureStatus.innerText = "";
    alert(`导出失败：${err.message}\n改动 manifest.json 后需在 chrome://extensions 重新加载插件，并刷新 X 页面。`);
  } finally {
    radarUI.exportBtn.disabled = false;
  }
}

function updateCaptureUi() {
  if (!radarUI) return;

  const count = captureState.buffer.posts.length;
  const scope = captureState.handle ? `@${captureState.handle}` : "不限作者";

  radarUI.captureToggleBtn.innerText = captureState.active ? "⏹ 停止并导出" : "⏺ 采集本页";
  radarUI.captureToggleBtn.style.background = captureState.active ? "#ef4444" : "transparent";
  radarUI.captureToggleBtn.style.borderColor = captureState.active ? "#ef4444" : "rgba(255,255,255,0.2)";
  radarUI.captureToggleBtn.style.color = captureState.active ? "#ffffff" : "#e7e9ea";
  radarUI.captureStatus.innerText = `已采 ${count} 条 · ${scope}${captureState.active ? " · 滚动即记录" : ""}`;
  radarUI.exportBtn.disabled = count === 0;
  radarUI.clearBtn.disabled = count === 0;
}