# X AI 评论助手

一个 Chrome 扩展（Manifest V3）：读取 X（Twitter）当前推文，调用你自己的大模型 API 生成评论或改写爆款推文。BYOK（Bring Your Own Key）模式，不收集任何数据，Key 只存在你本地。

## 功能

- 提取当前推文正文与图片，一键生成多条候选评论
- 多风格评论指令预设，可选不同语气
- 爆款推文二创改写：先拆解原帖的创作风格（句式、排版、标点、emoji、钩子），再用这套写法重讲一遍原帖——只换文笔，题材、故事和数字都跟着原帖走，改写结果可直接填入 X 发帖框
- 博主主页帖子采集：在博主主页点「⏺ 采集本页」后正常往下滑动，刷到的每条帖子都按浏览顺序记录下来（浏览量、点赞、评论、转发、收藏、发布时间、原帖链接），停止时导出成一个本地 Markdown 文件
- 长帖全文补齐：`intercept.js` 跑在页面自己的运行环境里，顺带读取 X 本来就要发的 GraphQL 响应，把 `note_tweet` 的完整正文按推文 id 存下来。被「显示更多」折叠的长帖不用点展开，采集、仿写、回复拿到的都是全文；插件自身不发任何额外请求
- 支持 DeepSeek / Kimi / 智谱 GLM / 阿里云百炼 等 OpenAI 兼容接口
- 自动探测可用的接口与模型名，并缓存结果
- 可选开启视觉（Vision）模式，让模型真正"看图评论"

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本项目目录
3. 复制 `config.example.js` 为 `config.js`，填入你的 API Key
4. 回到 `chrome://extensions`，点本插件右下角的「刷新」按钮

## 配置

所有密钥都写在 `config.js` 里，该文件已被 `.gitignore` 忽略，不会被提交。

```js
self.AI_CONFIG = {
  API_URL: "https://api.moonshot.cn/v1/chat/completions",
  API_KEY: "YOUR_KIMI_API_KEY",
  MODEL_NAME: "kimi-k3.1-pro-highspeed",
};
```

`config.example.js` 里另有 DeepSeek、智谱 GLM-4-Flash、阿里云百炼 的预设，取消注释换用即可。
若要使用支持视觉的模型（如 gpt-4o-mini、gemini-2.0-flash），把 `background.js` 顶部的 `ENABLE_VISION` 设为 `true`。

## 采集导出

采集只收当前主页博主本人的帖子，广告和穿插的推荐帖会自动跳过；不在主页时则收录所有非广告帖。X 换页是不刷新页面的，所以中途点进别的主页，采集目标仍锁在原博主，条数不再增长时重新点一次「采集本页」即可换人。每条帖子之间用一行 `-----------` 分隔：

```
# @elonmusk 主页采集（2026-11-16 21:30 · 共 2 条）
来源：https://x.com/elonmusk

👀 12.3K · ❤️ 456 · 💬 89 · 🔁 12 · 🔖 34
2026-11-15 21:04 · https://x.com/elonmusk/status/123
正文……
-----------
```

文件写到浏览器下载目录下的 `x博主采集/@博主名-日期.md`，同名不覆盖（自动加 `(1)`）。已采集内容会暂存在页面本地存储里，误刷新能找回来；单文件上限 2000 条，采满自动停止并导出。长帖的全文是接口响应晚于 DOM 到的，所以先按折叠版入库、全文到达后就地替换那一条，不会重复记两条。

## 安全提示

- 不要把 `config.js` 提交或截图分享出去
- 修改 `config.js` 或 `background.js` 后必须刷新插件，改动才会生效
- 若 Key 意外泄露，请立即到对应模型平台吊销并重新生成

## 常见问题

**提示 Key 认证失败**：确认 `config.js` 里的 `API_KEY` 与 `API_URL`、`MODEL_NAME` 属于同一平台，刷新插件后重试。

**改了配置没反应**：`chrome://extensions` 里插件图标右下角的刷新按钮必须点一次，service worker 才会重新加载。

**插件报错加载失败**：多半是缺少 `config.js`，打开 service worker 控制台可以看到具体提示。

**长帖正文还是截断的**：全文补齐靠注入页面自身的运行环境，需要 Chrome 111 及以上。打开 F12，把控制台顶部的上下文从 `content.js (isolated)` 切到页面本身，输入 `typeof X_AI_FULLTEXT`，返回 `"object"` 才说明拦截器装上了；返回 `"undefined"` 就是浏览器版本或站点脚本太早锁住了 `fetch`，此时插件退回只读 DOM，即「显示更多」之前的那截。

## 许可

MIT
