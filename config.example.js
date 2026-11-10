// 本地模型配置模板：请把本文件复制为 config.js（config.js 已被 .gitignore 忽略，不会上传），
// 然后填入你自己的 API Key。改完 config.js 记得去 chrome://extensions 刷新插件。

self.AI_CONFIG = {
  // === 方案 1：Kimi 高速版（当前默认，可完全关闭思考，响应快） ===
  // 注：Kimi 官方命名不叫 flash，其对应的高速版叫 kimi-k3.1-pro-highspeed（或可关闭思考的 kimi-k2.5）
  API_URL: "https://api.moonshot.cn/v1/chat/completions",
  API_KEY: "YOUR_KIMI_API_KEY", // https://platform.moonshot.cn/
  MODEL_NAME: "kimi-k3.1-pro-highspeed",

  // === 方案 2：DeepSeek（非思考直出模型，1~2 秒） ===
  // API_URL: "https://api.deepseek.com/chat/completions",
  // API_KEY: "YOUR_DEEPSEEK_API_KEY", // https://platform.deepseek.com/
  // MODEL_NAME: "deepseek-chat",

  // === 方案 3：智谱 GLM-4-Flash（官方免费，0.5~1 秒出字） ===
  // API_URL: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  // API_KEY: "YOUR_ZHIPU_API_KEY", // https://open.bigmodel.cn/
  // MODEL_NAME: "glm-4-flash",

  // === 方案 4：阿里云百炼 Qwen-Flash（极速 Flash 模型，0.5~1 秒出字） ===
  // API_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  // API_KEY: "YOUR_DASHSCOPE_API_KEY", // https://bailian.console.aliyun.com/
  // MODEL_NAME: "qwen-flash",
};
