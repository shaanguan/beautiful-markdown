# Changelog

## v1.2 — 2026-05-29

### 新增
- **分栏视图**：支持左右分栏对比两个 Markdown 文件，独立滚动，不强制同步
- **换文件按钮**：分栏模式下 doc-tools 行新增「换文件」按钮，可随时替换右侧文件
- **双栏对照增强**：原文侧也显示编辑/复制工具栏，双栏体验更一致
- 分栏空态 UI：右侧空白时显示「Open markdown file」按钮，风格与设置面板统一

### 更改
- theme-switcher 上下文标识从 `bilingualEnabled` 改为 `context: "viewer"`，逻辑更清晰
- 分栏模式下 TOC 自动隐藏，swap 按钮占位
- 清理部分冗余 title 属性

### 修复
- 修复 doc-tools 按钮清理时未移除 swap 按钮的问题

## v1.1 — 2026-05-28

### 新增
- 支持文字颜色和背景色渲染，识别 `{c:#0089FF}文字{/c}`、`{bg:#fff59d}文字{/bg}`
- 支持 Bullet Point 展开与折叠，点击列表小圆点，展开/收起子列表
- 自动识别文本语言，并根据文本语言自动设置默认的翻译目标语言

### 更改
- 项目更名为 **Beautiful Markdown**

## v0.1.2 — 2026-05-27

### 新增
- 初始发布版本
- Obsidian Baseline 主题渲染
- Preset 系统（Baseline、Claude、Minimal、Stone + 自定义导入）
- KaTeX 数学公式、Mermaid 图表、highlight.js 代码高亮
- Obsidian 风格语法：wikilinks、embeds、tags、highlights
- 内置翻译器（Gemini / OpenAI）
- Auto / Light / Dark 颜色模式
