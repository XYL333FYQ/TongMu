# Legacy Docker Compose

`compose.browser.yml` 和 `compose.single.yml` 是迁移前的兼容配置，默认部署入口已经改为仓库根目录的 `docker-compose.yml`。

旧配置中的 volume 名称保持不变，以便已有部署继续使用原来的 `/app/config` 数据。除非需要兼容旧版单文件产物，否则不要使用这里的配置。

如确需使用旧配置，请从仓库根目录执行，例如：

```bash
docker compose -f docker/legacy/compose.browser.yml up -d
```
