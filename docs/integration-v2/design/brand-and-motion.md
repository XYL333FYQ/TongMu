# TongMu 品牌与动效

品牌文字保持 **TongMu**；产品支持中文和英文，首次进入默认中文。语言选择在浏览器保存，切换只改变产品文案，不改变房间名称、用户名、媒体标题、来源内容或正在进行的播放。

## 生成的标识

使用内置 **imagegen** 图像生成工具生成透明背景位图，原图保存在 [tongmu-mark-source.png](tongmu-mark-source.png)。产品使用 256px 标识、64px favicon 和 180px Apple 图标；这些文件仅从生成原图缩放导出，没有用代码绘制替代图案。

最终生成方向：单个简洁的深蓝色圆角 T 字母，顶部左右两块有很小的分隔，表达同步参与。参考实际界面的浅蓝灰背景、细边框、蓝色线条图标；避免人物、播放三角、圆形徽章、厚重立体效果、装饰文字和多方案拼图。图形占方形画布约 82%，保留透明边距，确保在实际网页图标和导航尺寸上清晰。

用于生成的英文提示内容：

> Create one minimal architectural rounded T monogram for TongMu. Dark navy blue #315F78. The top bar consists of two rounded pill blocks with a small central separation, suggesting synchronized participants. Quiet pale ice-blue #E6EDF7 interface, thin borders and simple blue line icons. Flat, clean, restrained. One centered mark occupying about 82% of a square transparent canvas. No humans, no play triangle, no circular badge, no 3D, no shadow, no wordmark, no multiple variants.

第一版人物与渐变方案已弃用。验收应看完整界面中实际尺寸的标识，而不是单独放大的图片。

## 共用的交互节奏

头像、外观设置、导航、下拉框与弹窗使用相同入场/收起节奏：入场 240ms、退出 160ms，统一缓动，菜单条目相隔 50ms 逐项出现。页面、通知、列表和临时覆盖层使用同一组时长变量。位移轻且短；加载旋转、播放进度和通知倒计时仍按功能需要计时。

菜单支持 Escape 收起并把焦点还给触发按钮。快速重复开关会取消旧的移除计时，避免刚打开的菜单被旧计时关闭。系统减少动画偏好和个人减少动画设置均取消逐项延迟，并大幅缩短展示/移除时间。

相关实现：`frontend/src/styles/tokens.css`、`frontend/src/index.css`、`frontend/src/components/ui/motion.ts`、`frontend/src/components/ui/useDisclosureMotion.ts`。

## 行为验证

`e2e/localization-motion.spec.ts` 验证默认中文、即时切换及持久化、表单草稿保留、同一播放器和 Socket 会话持续运行，以及两个菜单的实际 CSS 动画、逐项延迟、退出、键盘焦点和减少动画行为。最终截图和不同浏览器结果记录于交付文档。
