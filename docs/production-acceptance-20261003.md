# TongMu 线上验收记录（2026-10-03，待登录后继续）

线上地址：https://tongmu.eren.cc.cd/ 。正式界面测试仅在确认新版部署成功后执行；当前应用版本 `659b06884a9103fa1c21ecc10859ad3e41a34a20`。

[部署成功](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448535)，[CI 与 Docker 验证成功](https://github.com/XYL333FYQ/TongMu/actions/runs/37116448010)。数据库卷、BrowserResolver 与原端口保留。文档提交不触发 VPS 部署。

## 媒体测试

普通游客令牌通过正常公开接口取得。未登录 B 站、未导入账号 Cookie；仅访问公开链接，不绕过付费、DRM 或验证码。解析成功、代理资源可用、浏览器解码和房间内共同播放是不同层次，分别记录。

| 来源 | 影片 / 视频 | 实际输入 | 结果与限制 |
|---|---|---|---|
| 1905 | 冲出亚马逊 | https://www.1905.com/vod/play/85388.shtml | 未找到媒体；VPS 直接访问该页面返回 403 |
| 1905 | 闪闪的红星 | https://www.1905.com/vod/play/86069.shtml | 未找到媒体；没有通过播放验收 |
| Filmzie | The Reality of Time (2025) | https://filmzie.com/content/the-reality-of-time-2025 | 公开页面可访问，自动解析未找到媒体；动态播放链未验证 |
| Internet Archive | Night of the Living Dead | https://archive.org/details/night_of_the_living_dead | VPS 连接超时；接口错误被显示为 CANCELLED，提示分类不准确，待修复 |
| Blender Studio | Sintel | https://studio.blender.org/films/sintel/ | 网页入口未找到媒体 |
| Blender 官方下载 | Sintel 1080P trailer | https://download.blender.org/durian/trailer/sintel_trailer-1080p.mp4 | 解析成功；Windows 内置真实浏览器分别通过 Direct 与 TongMu FULL_PROXY 解码 1920×1080，并播放到 52.208 秒结束，无媒体错误。未进行长片或房间同步验收 |
| 555 电影 | 宝贝老板，高清线路 HD中字 | https://555dyys.com/55vodplay/45899-2-1.html | 从实际影片页进入播放页；解析得到 HLS / FULL_PROXY。源站“高清”标签不等于已验证实际分辨率；未验证房间播放器播放 |
| Bilibili | 大雄兔 4K 60fps | https://www.bilibili.com/video/BV15z4y1U7HS | 修复前自动模式失败；修复后带 H.264/AAC DASH 能力声明的公开接口成功，实际 QN 32 / 480P |
| Bilibili | Big Buck Bunny 720P | https://www.bilibili.com/video/BV1Zs411o7Ee/ | 同上，源站匿名轨道只有 480P/360P；当前可用最高为 480P，未验证登录 B 站后的高清或实际房间播放 |

共五轮接口测试：第一轮显式质量与多站网页，第二轮自动 B 站和官方直链，第三轮实际 555 播放页，第四轮部署后旧式接口，第五轮部署后声明 H.264/AAC DASH 能力。第四轮没有能力声明的旧式 B 站接口仍失败，不能宣称旧客户端兼容已通过。

### 已修复的 B 站问题

源站响应标记 `quality=64`，实际视频轨道却只有 `id=32/16`。自动模式现在根据真实轨道选择当前可用最高画质；显式质量请求仍要求精确匹配，不能以降画质换取成功。服务器只读诊断与实际公开解析接口均确认修复生效。新增及现有媒体协议/B 站测试 56 项、HLS/DASH manifest 测试 9 项通过。

## 新版公共界面

- Windows 内置真实浏览器：1440×900、1920×1080、2560×1080、768×1024、390×844、844×390；大厅没有横向溢出。空大厅不能证明有封面房间卡片的布局通过。
- 中英文切换：公共大厅导航与提示切换成功。
- 账户菜单与外观菜单使用相同的 0.24 秒展开动画；Escape 关闭后焦点返回触发按钮。
- 不存在的房间号：明确提示房间不存在，保留房间号与游客昵称，可以重试。手机横屏短窗口加入弹窗可用。
- 适配结果属于真实 Windows 浏览器的视口测试，不等于 iOS、Android、macOS 或不同浏览器引擎真机验收；200% 缩放、长内容和完整房间布局尚未验收。

截图位于本机临时目录 `C:/Users/ss/AppData/Local/Temp/TongMu-QA-20261003/`，没有提交到 GitHub。包含各大厅比例截图、Direct/Proxy 1080P 播放截图与经过脱敏的解析结果。

## 尚未验收

内置浏览器新版登录页仍未登录。线上当前没有可供游客加入的房间；需要用户自行登录正常账号后，继续创建房间、选片、待播、实际 HLS/DASH 播放、多人同步、重连、权限、一起听、退出和后台活动流程。没有代用户获取密码或伪造登录身份。

游客音乐账号状态接口正常返回未登录；这不等于一起听播放通过。语音、投屏涉及真实权限与设备，也没有标记为通过。现阶段不能承诺任意电影网站都能解析，或者任意来源都能获得高清原画质。
