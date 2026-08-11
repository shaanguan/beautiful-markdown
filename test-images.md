# 图片渲染测试

用 Beautiful Markdown 直接打开本文件（`file://`）验证本地相对路径图片。

## 1. 本地相对路径（修复重点）

同目录下的扩展图标：

![BM logo](./icons/bm-logo.png)

![Icon 128](./icons/icon128.png)

子路径：

![Background](icons/bg.png)

![Open hero bg](./icons/bg-open.webp)

## 2. 网络图片（对照，一般本来就能显示）

![Placeholder](https://picsum.photos/seed/beautiful-md/640/360)

## 3. Obsidian wiki 嵌入（预期：只显示占位符，不是真图）

![[bm-logo.png]]

## 4. 混排

段落里的行内图：前面文字 ![小图标](./icons/icon16.png) 后面文字。

| 说明 | 预览 |
|------|------|
| 48px | ![48](./icons/icon48.png) |
| 16px | ![16](./icons/icon16.png) |

---

**预期：** 第 1、2、4 节应能看到真图；第 3 节是 `📎` 占位。
