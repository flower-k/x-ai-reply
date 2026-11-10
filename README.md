# X AI 评论助手

一个 Chrome 扩展（Manifest V3）：读取 X（Twitter）当前推文，调用你自己的大模型 API 生成评论或改写爆款推文。BYOK（Bring Your Own Key）模式，不收集任何数据，Key 只存在你本地。

## 功能

- 提取当前推文正文与图片，一键生成多条候选评论
- 多风格评论指令预设，可选不同语气
- 爆款推文改写，结果可直接填入 X 发帖框
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

## 安全提示

- 不要把 `config.js` 提交或截图分享出去
- 修改 `config.js` 或 `background.js` 后必须刷新插件，改动才会生效
- 若 Key 意外泄露，请立即到对应模型平台吊销并重新生成

## 常见问题

**提示 Key 认证失败**：确认 `config.js` 里的 `API_KEY` 与 `API_URL`、`MODEL_NAME` 属于同一平台，刷新插件后重试。

**改了配置没反应**：`chrome://extensions` 里插件图标右下角的刷新按钮必须点一次，service worker 才会重新加载。

**插件报错加载失败**：多半是缺少 `config.js`，打开 service worker 控制台可以看到具体提示。

## 许可

MIT
