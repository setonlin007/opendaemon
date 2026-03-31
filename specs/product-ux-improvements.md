# 产品体验优化记录

> 记录产品体验相关的优化需求、方案和实施状态。

---

## UX-001: 多语言切换功能

**状态:** 📋 方案已定，待实施
**提出日期:** 2026-03-31
**优先级:** 中

### 现状

- 前端单文件 `index.html`（4800+ 行），纯 vanilla JS，无构建工具
- 文本全部硬编码，UI 英文 + About 面板中文混合
- 约 150+ 个可翻译字符串
- 后端无任何 locale 处理
- 登录页 `login.html` 也是硬编码英文

### 方案

#### 1. 语言资源文件

```
public/i18n/
  ├── en.json
  └── zh.json
```

按模块分 key，如 `sidebar.newChat`、`chat.placeholder`、`status.ready` 等。

#### 2. 前端轻量 i18n 模块（无第三方依赖）

```js
const i18n = {
  locale: localStorage.getItem('lang') || 'en',
  messages: {},
  async load(lang) { ... },
  t(key, fallback) { return this.messages[key] || fallback || key; }
};
```

#### 3. HTML 标记 + 自动翻译

- `data-i18n` 属性标记静态文本
- `data-i18n-placeholder` 标记 placeholder
- 统一 `applyTranslations()` 函数刷新所有标记元素

#### 4. JS 动态文本

动态生成的文本（如 `renderAboutIntro()`、状态消息等）替换为 `i18n.t('key')` 调用。

#### 5. 语言切换 UI

侧边栏底部（Logout 按钮旁）加语言切换按钮 `🌐 EN / 中文`，点击切换后重新应用翻译。

#### 6. 登录页同步

`login.html` 读取 `localStorage('lang')` 并应用翻译。

### 设计原则

- 不引入 i18next 等重型库，保持 vanilla JS 一致性
- 不做后端翻译，API 返回数据，前端负责展示语言
- 不做浏览器语言自动检测，用户手动选择，存 localStorage

### 实施步骤

| 步骤 | 内容 | 工作量 | 状态 |
|------|------|--------|------|
| 1 | 创建 `en.json` / `zh.json`，提取所有字符串 | 中 | ⬜ |
| 2 | 实现 `i18n` 模块 + `applyTranslations()` | 小 | ⬜ |
| 3 | HTML 元素加 `data-i18n` 标记 | 中 | ⬜ |
| 4 | JS 动态文本替换为 `i18n.t()` | 大 | ⬜ |
| 5 | 添加语言切换 UI | 小 | ⬜ |
| 6 | 登录页适配 | 小 | ⬜ |

---

<!-- 后续优化项在此追加 -->
