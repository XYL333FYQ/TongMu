# TongMu 品牌与动效

品牌文字保持 **TongMu**；产品支持中文和英文，首次进入默认中文。语言选择在浏览器保存，切换只改变产品文案，不改变房间名称、用户名、媒体标题、来源内容或正在进行的播放。

## 生成的标识

使用内置 **imagegen** 图像生成工具生成透明背景位图，原图保存在 [tongmu-mark-source.png](tongmu-mark-source.png)。产品使用 256px 标识、64px favicon 和 180px Apple 图标；这些文件仅从生成原图缩放导出，没有用代码绘制替代图案。

2026-10-03 按用户提供的 [品牌参考图](tongmu-brand-reference.png) 更新：两片相对的圆角玻璃面板，左侧青蓝到紫色，右侧蜜桃、粉色到紫色，中间为白色播放符号。保留参考中的柔和高光与轻微立体感，输出单个透明图形，适配实际导航和网页图标尺寸。TongMu 文字仍由界面显示，不把整张品牌展示板塞进导航。深色主题不再对白色和渐变图标套用旧 T 图标的提亮去色滤镜。

用于生成的英文提示内容：

> Use case: logo-brand. The input is the user's authoritative visual reference. Create one standalone TongMu brand icon matching its symbol: two opposing softly beveled rounded glass panels, left cyan through cobalt blue to violet, right pale golden peach through pink to violet. A white translucent right-pointing play triangle bridges the central gap. Preserve the friendly rounded proportions, smooth glossy highlights and gentle depth. Center the icon on a transparent square canvas with about 8 percent margins. No words, lettering, container tile, floor, cast shadow, mockup or multiple variations. Keep a legible silhouette at 32 and 64 pixels; do not replace it with a T monogram.

此前的 T 标识由本次参考方案替换。验收应看完整界面中实际尺寸的标识，而不是单独放大的图片。房间封面和本次验证见 [封面整改记录](room-cover-refresh.md)。

## 共用的交互节奏

头像、外观设置、导航、下拉框与弹窗使用相同入场/收起节奏：入场 240ms、退出 160ms，统一缓动，菜单条目相隔 50ms 逐项出现。页面、通知、列表和临时覆盖层使用同一组时长变量。位移轻且短；加载旋转、播放进度和通知倒计时仍按功能需要计时。

菜单支持 Escape 收起并把焦点还给触发按钮。快速重复开关会取消旧的移除计时，避免刚打开的菜单被旧计时关闭。系统减少动画偏好和个人减少动画设置均取消逐项延迟，并大幅缩短展示/移除时间。

相关实现：`frontend/src/styles/tokens.css`、`frontend/src/index.css`、`frontend/src/components/ui/motion.ts`、`frontend/src/components/ui/useDisclosureMotion.ts`。

## 行为验证

`e2e/localization-motion.spec.ts` 验证默认中文、即时切换及持久化、表单草稿保留、同一播放器和 Socket 会话持续运行，以及两个菜单的实际 CSS 动画、逐项延迟、退出、键盘焦点和减少动画行为。最终截图和不同浏览器结果记录于交付文档。
