// MAIN world 拦截器：X 的长帖（note_tweet）在时间线 DOM 里是折叠的，只渲染「显示更多」之前的那截。
// 这里不主动发任何请求，只顺着页面本来就要发的 GraphQL 响应，把完整正文按推文 id 暂存并广播给内容脚本。
const X_AI_FULLTEXT = (() => {
  const MESSAGE_TYPE = "note-tweet";

  // 推文 id 是纯数字 snowflake，user.id_str 之类同形字段靠层级区分
  const TWEET_ID_RE = /^\d{5,}$/;

  // 单条正文与单个响应的体量上限，异常数据直接丢掉，不把浏览器内存拖垮
  const MAX_NOTE_TEXT = 50000;
  const MAX_BODY_TEXT = 8000000;

  function isGraphqlUrl(url) {
    return typeof url === "string" && url.indexOf("/i/api/") !== -1;
  }

  function idOf(value) {
    return typeof value === "string" && TWEET_ID_RE.test(value) ? value : "";
  }

  // note_tweet 两种历史结构：note_tweet.text 与 note_tweet.note_tweet_results.result.text
  function textOfNote(note) {
    if (!note || typeof note !== "object") return "";
    const direct = note.text;
    if (typeof direct === "string" && direct.trim()) return direct;
    const result = note.note_tweet_results && note.note_tweet_results.result;
    if (result && typeof result.text === "string" && result.text.trim()) return result.text;
    return "";
  }

  function pushEntry(out, id, text) {
    if (!id || !text) return;
    if (text.length > MAX_NOTE_TEXT) return;
    out.push({ id, text });
  }

  // 深度遍历一次响应，遇到带 note_tweet 的推文对象就记下它自己的 id
  function extractNoteTextEntries(root) {
    const out = [];
    if (!root || typeof root !== "object") return out;

    const visited = new Set();
    const stack = [[root, ""]];

    while (stack.length > 0) {
      const [node, inheritedId] = stack.pop();
      if (!node || typeof node !== "object" || visited.has(node)) continue;
      visited.add(node);

      let currentId = inheritedId;

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) stack.push([node[i], currentId]);
        continue;
      }

      currentId =
        idOf(node.rest_id) || idOf(node.id_str) || idOf(node.id) || inheritedId;

      if (node.note_tweet) {
        const text = textOfNote(node.note_tweet);
        const noteId = idOf(node.note_tweet.id) || idOf(node.note_tweet.rest_id);
        pushEntry(out, currentId || noteId, text);
      }

      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const child = node[keys[i]];
        if (child && typeof child === "object") stack.push([child, currentId]);
      }
    }

    return out;
  }

  function urlOfRequest(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function makeBroadcaster(win) {
    const knownIds = new Set();

    const broadcast = (entries) => {
      const fresh = entries.filter((entry) => !knownIds.has(entry.id));
      if (fresh.length === 0) return;
      for (const entry of fresh) knownIds.add(entry.id);
      try {
        win.postMessage({ __xAiFullText: MESSAGE_TYPE, entries: fresh }, "*");
      } catch {
        // 跨世界通信失败只影响全文补齐，不能连带影响页面
      }
    };

    const emitFromText = (body) => {
      if (typeof body !== "string" || body.length === 0 || body.length > MAX_BODY_TEXT) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return;
      }
      broadcast(extractNoteTextEntries(payload));
    };

    return { broadcast, emitFromText };
  }

  function isJsonContent(getter) {
    try {
      return /json/i.test(getter() || "");
    } catch {
      return false;
    }
  }

  function patchFetch(win, emitFromText) {
    if (win.__xAiFetchPatched || typeof win.fetch !== "function") return;
    win.__xAiFetchPatched = true;

    const originalFetch = win.fetch;

    win.fetch = function (...args) {
      const url = urlOfRequest(args[0]);
      const result = originalFetch.apply(this, args);

      if (isGraphqlUrl(url)) {
        Promise.resolve(result)
          .then((response) => {
            if (response && typeof response.clone === "function") {
              const readType = () =>
                response.headers && typeof response.headers.get === "function"
                  ? response.headers.get("content-type")
                  : "";
              if (isJsonContent(readType)) {
                // 只读副本，页面自己还要再读一次原始 body
                response.clone().text().then(emitFromText, () => {});
              }
            }
            return response;
          })
          .catch(() => {});
      }

      return result;
    };
  }

  function patchXhr(win, emitFromText) {
    const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (!proto || proto.__xAiXhrPatched || typeof proto.open !== "function") return;
    proto.__xAiXhrPatched = true;

    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function (method, url) {
      this.__xAiUrl = url;
      return originalOpen.apply(this, arguments);
    };

    proto.send = function (...args) {
      const xhr = this;
      if (isGraphqlUrl(xhr.__xAiUrl) && typeof xhr.addEventListener === "function") {
        xhr.addEventListener("load", () => {
          if (
            isJsonContent(() =>
              typeof xhr.getResponseHeader === "function"
                ? xhr.getResponseHeader("content-type")
                : ""
            )
          ) {
            emitFromText(xhr.responseText);
          }
        });
      }
      return originalSend.apply(this, args);
    };
  }

  // 内容脚本跑在 ISOLATED world，收不到这里的变量，只能用 window.postMessage 传
  function install(win) {
    if (!win) return;
    if (!win.__xAiFullTextEmit) {
      const { emitFromText } = makeBroadcaster(win);
      win.__xAiFullTextEmit = emitFromText;
    }
    patchFetch(win, win.__xAiFullTextEmit);
    patchXhr(win, win.__xAiFullTextEmit);
  }

  return {
    MESSAGE_TYPE,
    MAX_NOTE_TEXT,
    isGraphqlUrl,
    extractNoteTextEntries,
    install
  };
})();

if (typeof self !== "undefined") self.X_AI_FULLTEXT = X_AI_FULLTEXT;
if (typeof window !== "undefined" && window) X_AI_FULLTEXT.install(window);
