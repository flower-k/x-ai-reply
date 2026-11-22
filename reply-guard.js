// 评论正文校验：后台生成后与内容脚本自动发送前共用。
// 纯逻辑，不接触 DOM / chrome API，service worker 与内容脚本都能直接加载。
const X_AI_REPLY_GUARD = (() => {
  const MAX_REPLY_CHARS = 400;

  // 备选版本 / 语气说明 / 字数统计等模型“草稿痕迹”
  const ALT_HINT_RE = new RegExp(
    [
      "[（(【\\[][^）)】\\]]{0,40}(?:或者|更活泼|更自然|更正式|更口语|另一版|另一条|另一个|备选|换一版|版本\\s*[0-9一二三]?|方案\\s*[0-9一二三]?|选项|字数|共\\s*\\d+\\s*字)",
      "另一版|另一个版本|备选方案|备选版本|换个说法|换一版|alternative\\s+version|another\\s+version|option\\s*[12]",
      "(?:版本|方案|选项)\\s*[0-9一二三１２３]\\s*[:：]"
    ].join("|"),
    "i"
  );

  const META_LINE_RE = /^(?:版本|方案|选项|备选|字数)[^。！？!?]{0,20}[:：]?$/;
  const CODE_OR_HEADING_RE = /^(?:```|#{1,6}\s|[-*]\s+\S)/;

  function stripOuterQuotes(text) {
    const pairs = [
      ['"', '"'],
      ["“", "”"],
      ["「", "」"],
      ["『", "』"],
      ["'", "'"]
    ];
    for (const [open, close] of pairs) {
      if (
        text.length > open.length + close.length &&
        text.startsWith(open) &&
        text.endsWith(close)
      ) {
        const inner = text.slice(open.length, text.length - close.length).trim();
        if (inner) return inner;
      }
    }
    return text;
  }

  // 返回 { ok, text, reason }：ok 为 false 时调用方不得发送该文本
  function check(raw) {
    let text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").trim();
    if (!text) return { ok: false, reason: "内容为空", text: "" };

    text = stripOuterQuotes(text);
    if (!text) return { ok: false, reason: "内容为空", text: "" };

    if (ALT_HINT_RE.test(text)) {
      return { ok: false, reason: "含备选版本或语气说明", text };
    }
    if (/[\n\r]/.test(text)) {
      return { ok: false, reason: "含换行或多段输出", text };
    }
    if (META_LINE_RE.test(text) || CODE_OR_HEADING_RE.test(text)) {
      return { ok: false, reason: "含标题/列表/说明性文字", text };
    }
    if (text.length > MAX_REPLY_CHARS) {
      return { ok: false, reason: `正文过长（${text.length} 字）`, text };
    }

    return { ok: true, text, reason: "" };
  }

  return { MAX_REPLY_CHARS, check };
})();

// 内容脚本里挂到全局供 content.js 调用；service worker 里从 self.X_AI_REPLY_GUARD 取
if (typeof self !== "undefined") self.X_AI_REPLY_GUARD = X_AI_REPLY_GUARD;
if (typeof module !== "undefined" && module.exports) module.exports = X_AI_REPLY_GUARD;
