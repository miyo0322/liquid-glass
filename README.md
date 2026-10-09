# Aletheia · Liquid Glass

从 Aletheia.html 原样拆出的液体玻璃模块，三部分：

- **GlassMotion** — 光斑跟随指针 / 陀螺仪
- **LiquidGlass v5** — WebGL + SDF 折射引擎（Chromium 走 SVG 位移图真折射，Safari/Firefox 用透镜暗示环；带性能档位与自动降档）
- **GlassLens** — 弹性拖拽 + 凸透镜放大手感

## 使用

```html
<link rel="stylesheet" href="liquid-glass.css">
<script src="liquid-glass.js"></script>
<div data-glass>任何想要玻璃效果的元素</div>
<script>
  GlassMotion.init(); LiquidGlass.init(); GlassLens.init();
  applyGlassIntensity(38);   // 0 清透 ~ 100 浓郁
</script>
```

`demo.html` 是可直接打开的最小示例。

## 调试参数
`?lg=off` 关闭引擎 · `?lgr=0` 关 SVG 折射 · `?lgtier=low|mid|high|ultra` 强制档位

## 宿主依赖
`$`、`clamp`、`Store` 在 js 顶部有垫片；主题变量（`--bg-card`、`--accent` 等）在 css 顶部有默认值，可由宿主覆盖。
