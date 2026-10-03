# TongMu 线上验收记录（2026-10-03，持续验收中）

## 网易云登录后读取失败：新增复核

用户已通过手机授权，线上界面显示已连接；实际私人歌单请求返回 `NCM_PRIVATE_ACCOUNT_DATA`，并非正常的空歌单。公共搜索可返回结果，不代表私人账号功能可用。

只读对照 `references/ZViewer-main/backend/src/routes/music.ts` 与 `frontend/src/modules/music/pages/MusicMyPage.tsx`：参考项目在二维码授权或旧凭据缺少资料时通过 `/user/account` 补全身份，然后读取用户歌单和收藏。TongMu 原实现保存凭据却可能没有保存用户编号，导致私人目录不能读取。

提交 `a8cae32` 补齐账号身份查询，并让已保存的旧凭据在读取私人目录时按需补全，无需要求用户重新扫码。[部署 37119251905 成功](https://github.com/XYL333FYQ/TongMu/actions/runs/37119251905)，[CI 37119249531 成功](https://github.com/XYL333FYQ/TongMu/actions/runs/37119249531)。公共健康接口确认应用 SHA 为 `a8cae32`。真实 Windows 内置浏览器使用既有账号、无需再次扫码：私人歌单及喜欢歌曲接口均返回 200，列表实际显示，喜欢歌曲加入房间待播成功。证明截图保存在本机临时目录，未上传私人库截图到 GitHub。

提交 `676b2c9` 修复二维码接口被内置服务缓存的问题，以及前端过期反馈和专门的刷新二维码入口；已包含在 `a8cae32` 中。前端相关测试 8 项及构建通过，真实手机扫码、过期和刷新流程尚未重新验收。

整合缺口已进入下一批修复：参考项目有收藏专辑、收藏歌手接口；此前对应标签只是搜索入口。现已实现私人收藏列表与现有详情入口、登录限制、空状态和加载提示，本地后端鉴权/分页/归一化测试通过；上线和真实收藏验收仍待执行。

真实音频尚未通过：`晴天(深情版)`（Lucky小爱）和 `Falling Down (feat. James Delaney)`（Wild Cards / James Delaney）进入待播；切歌可以更新当前歌曲，但播放解析出现 `502 / NCM_UPSTREAM_ERROR`，音频元素没有来源。已确认普通同步心跳会错误清除媒体失败提示，下一批修复保留错误、支持重新解析，并仅把 `NotAllowedError` 分类为浏览器播放限制。采用 ZViewer 的旧歌曲地址接口回退能力，但仅请求相同 MP3 码率，并以返回码率验证真实音质，不采用参考项目的降音质链或按请求值伪造实际音质。下一批相关后端测试 17 项、前端音乐/翻译测试 10 项及前后端构建通过；真实播放未验收，不得标为成功。

另一条真实失败：Bilibili 大雄兔 `BV15z4y1U7HS` 在 `d998f15` 房间解析成功（854×480），添加成功；DASH init segment 502，video readyState 0、分辨率 0×0、时间 0，房间实际播放未通过。

线上地址：https://tongmu.eren.cc.cd/ 。正式界面测试仅在确认新版部署成功后执行；本次记录已确认应用版本 `a8cae3203d2377b43ddb45b4350d3309da646281`。下面早期媒体测试另有各自版本与验证边界。

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
