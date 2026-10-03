# 参考品牌与房间封面整改

2026-10-03 用户提供品牌样式后追加，基线为已交付的 `5900e0a`。只调整品牌资产、房间卡片与封面管理，不改变媒体播放或加入规则。最终提交及远程 CI 结果绑定交付回复。

## 卡片与封面

- 封面区采用 16:10，房间名称和加入信息集中在紧凑底部；活动、在线和访问限制以图片上的标签表达。房间名最多展示两行，完整名称保留在 DOM 和 title；同排按钮底边对齐。
- 房主在“房间设置 → 房间封面”上传 JPG、PNG 或 WebP，最大 5 MB。封面立即独立保存，不覆盖其他设置草稿；可恢复默认。普通成员、游客和临时代理不能更改封面；平台管理员按既有房间管理权限处理。
- 未设置封面的房间按房间号稳定选择四张默认图片之一；换活动、改名和刷新不会随机换图。上传图片加载失败时回退默认图片。图片懒加载、异步解码，默认素材导出为 960×540 WebP，约 43–86 KB/张。
- 上传文件位于既有 `config/uploads/room-covers` 持久卷目录，使用服务器生成的文件名。元数据保存在既有 `policyJson` 的服务器字段中，无新增表或列；旧房间无需迁移。其他规则保存会保留当前封面。
- 服务器认证、上传体积和格式检查后，在既有房间锁内再次读取所有权和用户角色；排队期间转交或撤权会拒绝写入。替换、恢复默认及房间删除时清理对应文件。
- 不自动从个人网盘、视频或音乐来源提取图片。大厅只显示明确设置的封面，不增加私人媒体内容披露。

## 图像生成来源

使用内置 **imagegen**，没有用代码绘制替代标识或封面。标识原图见 [原图](tongmu-mark-source.png)，参考和提示见 [品牌与动效](brand-and-motion.md)。产品资产：`frontend/public/tongmu-mark.png`、`favicon-64.png`、`apple-touch-icon.png`、`room-covers/*.webp`。

默认封面共用提示：

> Create one complete wide 16:9 room cover for TongMu, a social watching/listening/sharing app with a softly frosted pale blue interface and cyan/cobalt/peach/violet glass logo. Sophisticated calm cinematic 3D illustration, gently rounded forms, ambient lighting, tactile surfaces and soft depth, detailed but uncluttered. Desaturated ice blue, cobalt and lavender, subtle warm peach highlights, not neon. Fill the canvas edge to edge. No text, letters, logos, UI, borders, people or watermark. Keep the bottom quarter slightly darker for white activity chips; make the subject legible at small card size.

分别加入的场景：

| 文件 | 场景提示 |
| --- | --- |
| `aurora.webp` | Quiet surreal blue and lavender glass mountains reflected in turquoise water, a small warm peach sun, soft cloud wisps, wide open composition. |
| `cinema.webp` | Cozy private cinema, large glowing pale blue screen, plush deep blue seats, warm peach indirect lights and violet shadows. |
| `music.webp` | Sunlit listening corner, vinyl player and headphones on a wood table beside a wide window, soft blue walls, peach curtain and lavender shadows. |
| `studio.webp` | Serene creative loft desk, window onto pale blue hills, blue display, sketchbook and green plant, peach sunset light and lavender glass accents. |

## 验证

- 后端类型检查和构建通过；真实 HTTP/JWT、SQL.js、房间处理器和文件读写测试 33 PASS / 0 FAIL，其中新增 3 项封面集成测试。
- 前端既有测试 80 PASS，生产构建通过；本次五个相关组件/模块的严格 ESLint 通过。全站历史 lint 状态不因此改变。
- Chromium：封面上传、草稿保留、保存后大厅展示、真正图片解码、404 回退、恢复默认、错误输入和响应式检查通过；连同中英文和共用动效回归共 5 PASS。Firefox 与 WebKit 各 2 PASS；不是这些系统或手机的真机认证。
- WebKit 首次验证暴露文件选择器的 WebP 类型差异，在发送请求前就拒绝了有效图片。客户端改为读取真实图片格式并正常解码验证，然后使用明确的类型上传；修正后的 WebKit 两项检查均通过。服务端仍独立验证格式和权限。
- 内置浏览器完成 16 种宽高、英文、暗色、触摸和短窗口键盘操作检查；几何记录与完整截图见 [截图说明](../screenshots/room-covers/README.md)。演示房间在独立测试目录中，日常数据库未写入演示房间或封面。
- 日志 `.backend-room-covers-tests.log`、`.frontend-test-room-covers.log`、`.frontend-build-room-covers.log`、`.e2e-room-covers-final.log`、`.e2e-room-covers-firefox-final.log`、`.e2e-room-covers-webkit-fixed.log` 留在本地并被忽略，运行数据不进入 Git。
