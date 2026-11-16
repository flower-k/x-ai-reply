// 博主主页帖子采集：纯逻辑（路径识别、收录判定、去重、Markdown 渲染、文件名）
// 本文件不接触任何 DOM，保证在浏览器内容脚本与 node 测试里都能直接加载
const X_AI_CAPTURE = (() => {
  const MAX_CAPTURE = 2000;

  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  // 个人主页的时间线标签后缀，出现在第二段说明还在同一主页内
  const PROFILE_TABS = new Set([
    "with_replies",
    "replies",
    "media",
    "likes",
    "highlights",
    "articles",
    "affiliates",
    "circle",
    "schedule"
  ]);

  // 一级路径里的固定路由，不是任何人的 handle
  const RESERVED = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "search",
    "settings",
    "compose",
    "hashtag",
    "share",
    "login",
    "logout",
    "onboarding",
    "account",
    "saved",
    "activity",
    "analytics",
    "grok",
    "communities",
    "following",
    "followers",
    "verified",
    "premium",
    "jobs",
    "about",
    "ads",
    "download",
    "i",
    "d",
    "dm",
    "f",
    "s",
    "list",
    "lists",
    "group",
    "intent",
    "gif",
    "moments",
    "local",
    "tos",
    "privacy"
  ]);

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatLocalMinute(date) {
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  // 只在博主主页返回该主页的 handle，其余页面返回 null
  function resolveProfileHandle(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0 || segments.length > 2) return null;

    const candidate = segments[0].replace(/^@/, "");
    if (!HANDLE_RE.test(candidate)) return null;
    if (RESERVED.has(candidate.toLowerCase())) return null;
    if (segments.length === 2 && !PROFILE_TABS.has(segments[1])) return null;

    return candidate;
  }

  // 从 User-Name 的显示文本（"Elon Musk @elonmusk"）里取出 handle
  function handleFromAuthorText(authorText) {
    const match = /@([A-Za-z0-9_]{1,15})/.exec(authorText || "");
    return match ? match[1] : "";
  }

  function dedupeKey(postItem) {
    return (
      postItem.tweetUrl ||
      `${postItem.authorHandle || ""}::${postItem.text || ""}`
    );
  }

  // 时间线里每条帖子都挂着 /status/<id> 链接，这个 id 与接口侧 note_tweet 的 rest_id 同源
  function statusIdFromHref(href) {
    const match = /\/status\/(\d+)/.exec(String(href || ""));
    return match ? match[1] : "";
  }

  // X 折叠长帖时把「显示更多」塞在正文末尾，只清尾巴，不动正文中间的词
  const FOLD_TAIL_RE =
    /\s*(?:显示更多|顯示更多|查看更多|Show more|Read more)\s*$/i;

  function stripFoldTail(text) {
    return String(text || "").replace(FOLD_TAIL_RE, "").trim();
  }

  // 接口里的 note_tweet 全文优先；只有 DOM 更长（已手动展开或帖子被编辑过）才留 DOM
  function pickFullText(domText, noteText) {
    const dom = stripFoldTail(domText);
    const note = stripFoldTail(noteText);
    if (!note) return dom;
    if (!dom) return note;
    return note.length > dom.length ? note : dom;
  }

  // 有正文/引用/媒体之一，且不是广告；在博主主页时还要求作者就是该博主
  function shouldCapture(postItem, profileHandle) {
    if (!postItem || postItem.isAd) return false;

    const hasContent =
      String(postItem.text || "").trim() ||
      String(postItem.quotedText || "").trim() ||
      (postItem.mediaSummary || []).length > 0;
    if (!hasContent) return false;

    if (!profileHandle) return true;
    return String(postItem.authorHandle || "").toLowerCase() === profileHandle.toLowerCase();
  }

  function createCaptureBuffer() {
    // index: dedupeKey -> 已入库的那条对象，全文补到时能就地升级
    return { posts: [], index: new Map() };
  }

  // 全文是异步补到的：同一条帖子先按折叠版入库，接口正文到达后就地升级
  function upgradeCapturedPost(existing, incoming) {
    const mergedText = pickFullText(existing.text, incoming.text);
    if (mergedText.length <= stripFoldTail(existing.text).length) return false;

    existing.text = mergedText;
    if (incoming.quotedText) {
      existing.quotedText = pickFullText(existing.quotedText, incoming.quotedText);
    }
    if (incoming.datetime) existing.datetime = incoming.datetime;
    if (incoming.metricsText) existing.metricsText = incoming.metricsText;
    if (Array.isArray(incoming.mediaSummary) && incoming.mediaSummary.length > 0) {
      existing.mediaSummary = incoming.mediaSummary;
    }
    return true;
  }

  function addCapture(buffer, postItem) {
    if (!buffer.index || typeof buffer.index.get !== "function") {
      buffer.index = new Map(buffer.posts.map((p) => [dedupeKey(p), p]));
    }

    const key = dedupeKey(postItem);
    const existing = buffer.index.get(key);
    if (existing) return upgradeCapturedPost(existing, postItem);

    if (buffer.posts.length >= MAX_CAPTURE) return false;

    buffer.index.set(key, postItem);
    buffer.posts.push(postItem);
    return true;
  }

  function buildCaptureFilename(handle, date) {
    const safeHandle = String(handle || "").replace(/[^A-Za-z0-9._-]/g, "-") || "unknown";
    return `@${safeHandle}-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
  }

  function renderPostBlock(postItem) {
    const lines = [];

    // 指标串里条目之间是两个空格，emoji 与数字之间只有一个，只压条目间隔
    const metrics = String(postItem.metricsText || "").trim().replace(/\s{2,}/g, " · ");
    if (metrics) lines.push(metrics);

    const stamp = [
      postItem.datetime ? formatLocalMinute(new Date(postItem.datetime)) : "",
      postItem.tweetUrl || ""
    ]
      .filter(Boolean)
      .join(" · ");
    if (stamp) lines.push(stamp);

    if (String(postItem.text || "").trim()) lines.push(String(postItem.text).trim());
    if (String(postItem.quotedText || "").trim()) {
      lines.push(`↳ 引用：${String(postItem.quotedText).trim()}`);
    }

    return lines.join("\n");
  }

  function renderPostsToMarkdown(posts, meta = {}) {
    const handle = meta.handle || "unknown";
    const header =
      `# @${handle} 主页采集（${formatLocalMinute(meta.collectedAt || new Date())} · 共 ${posts.length} 条）\n` +
      `来源：${meta.profileUrl || `https://x.com/${handle}`}`;

    if (posts.length === 0) return `${header}\n`;
    return `${header}\n\n${posts.map(renderPostBlock).join("\n-----------\n")}\n`;
  }

  return {
    MAX_CAPTURE,
    resolveProfileHandle,
    handleFromAuthorText,
    dedupeKey,
    shouldCapture,
    statusIdFromHref,
    stripFoldTail,
    pickFullText,
    createCaptureBuffer,
    addCapture,
    buildCaptureFilename,
    renderPostsToMarkdown
  };
})();

// 内容脚本里挂到全局供 content.js 调用；node 测试里从 self.X_AI_CAPTURE 取
if (typeof self !== "undefined") self.X_AI_CAPTURE = X_AI_CAPTURE;
