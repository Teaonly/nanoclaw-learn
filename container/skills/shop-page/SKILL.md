---
name: shop-page
description: 店铺网页创建与更新工具，支持创建和更新店铺的 HTML、CSS、JavaScript 三个文件片段，生成完整的店铺展示页面。
---

# Shop Page - 店铺网页创建与更新

创建和更新店铺网页，支持分别编辑 HTML、CSS、JavaScript 三个文件片段。服务端会将这三个片段组合成完整的网页。

## Important environment variables has been set in the system, you can use them directly.

- `BASE_URL`: API 服务基础 URL
- `BOT_ID`: 店铺的唯一标识符

## API 接口

### 上传/更新网页内容

**请求:**

```
POST ${BASE_URL}/api/upload
```

**请求方式:**

支持两种格式：

#### 1. JSON 格式 (推荐)

```bash
curl -X POST "${BASE_URL}/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "${BOT_ID}",
    "html": "<div class=\"container\">...</div>",
    "css": ".container { max-width: 1200px; }",
    "js": "console.log(\"loaded\");"
  }'
```


**参数说明:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 店铺唯一标识符，不能包含 `..`、`/`、`\`，从环境变量读取 'BOT_ID' |
| html | string | 否 | HTML 内容（body 部分的代码） |
| css | string | 否 | CSS 样式代码 |
| js | string | 否 | JavaScript 代码 |

**返回:**

```json
{
  "success": true,
  "message": "文件上传成功",
  "id": "'BOT_ID'"
}
```

## 生成的网页模板

服务端会将三个片段组合成如下完整 HTML 页面：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <link rel="stylesheet" href="/tailwind-classes-min.css">
  <style>
    /* 用户提供的 CSS 代码 */
  </style>
  <script>
    const BOT_ID = "shop_001";
  </script>
  <script src="${WEB_BASE_URL}/skills/index.js" defer></script>
</head>
<body>
  <!-- 用户提供的 HTML 代码 -->
  <script>
    // 用户提供的 JavaScript 代码
  </script>
</body>
</html>
```

## 文件存储位置

上传的文件会保存在服务端：

- `${PUBLIC_BASE_DIR}/${id}/body.html` - HTML 内容
- `${PUBLIC_BASE_DIR}/${id}/style.css` - CSS 样式
- `${PUBLIC_BASE_DIR}/${id}/code.js` - JavaScript 代码

## 使用示例

### 示例 1: 创建新店铺页面

```bash
curl -X POST "${BASE_URL}/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my_shop",
    "html": "<div class=\"shop-header\"><h1>欢迎光临</h1></div><div class=\"products\"><div class=\"product\">商品1</div></div>",
    "css": ".shop-header { background: #f5f5f5; padding: 20px; } .products { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }",
    "js": "document.addEventListener(\"DOMContentLoaded\", () => { console.log(\"Shop loaded\"); });"
  }'
```

### 示例 2: 仅更新 CSS 样式

```bash
curl -X POST "${BASE_URL}/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my_shop",
    "css": ".shop-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }"
  }'
```

### 示例 3: 更新 JavaScript 交互逻辑

```bash
curl -X POST "${BASE_URL}/api/upload" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my_shop",
    "js": "function addToCart(productId) { console.log(\"Added product:\", productId); } document.querySelectorAll(\".product\").forEach(p => p.addEventListener(\"click\", () => addToCart(p.dataset.id)));"
  }'
```

## 注意事项

1. **安全性**: `id` 参数不能包含路径遍历字符 (`..`, `/`, `\`)
2. **部分更新**: 可以只传递需要更新的字段，其他字段保持不变
3. **编码**: 确保所有内容使用 UTF-8 编码
4. **Tailwind CSS**: 页面已内置 Tailwind CSS，可以直接使用 Tailwind 类名

## 最佳实践

### HTML 结构建议

```html
<!-- 使用语义化标签 -->
<header class="shop-header">
  <h1>店铺名称</h1>
  <nav>...</nav>
</header>

<main class="shop-content">
  <section class="products">...</section>
  <section class="about">...</section>
</main>

<footer class="shop-footer">...</footer>
```

### CSS 样式建议

```css
/* 使用响应式设计 */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 16px;
}

@media (min-width: 768px) {
  .products {
    grid-template-columns: repeat(3, 1fr);
  }
}
```

### JavaScript 建议

```javascript
// 使用 BOT_ID 进行标识
console.log('Shop ID:', BOT_ID);

// 等待 DOM 加载完成
document.addEventListener('DOMContentLoaded', () => {
  // 初始化代码
});
```
