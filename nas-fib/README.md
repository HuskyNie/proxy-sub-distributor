# NAS FIB 订阅同步服务

此目录以 2026-11-11 从 NAS `fib-sub-sync` 运行容器提取的 `/app/src`、
`package.json`、`package-lock.json` 为基线，独立维护 FIB 账号登录与订阅领取适配。
原镜像：`fib-sub-sync:chain-fix-20260927`，镜像 ID：
`sha256:f7b4eba00a9fccc6f9c8eb4f9c2b6dbd655f521a03dc67e142d318bf88959fbf`。
测试取自 NAS 部署目录；策略示例仅作为测试 fixture，不能覆盖运行时策略。
仓库根目录的通用 URL 订阅分发服务保持独立。

## 行为

- 保留账号登录、签到、设备独立令牌、手动 URL 同步、历史缓存、健康检查和回退。
- 保留地区 fallback、链式代理、缺失节点兼容与策略热加载。
- 兼容旧 `data-clipboard-text` 和新 `data-url` / `data-import` 链接。
- 新页面先读取 `/user/sublink/box`；已有 Clash 链接直接使用。
- 无链接且领取按钮可用时，获取 challenge，在 Worker 计算 SHA-256 工作量证明，
  提交 issue，再读取 box。每轮最多提交一次，不因丢失响应重复领取。
- PoW 限制为 1–24 位、30 秒；每个 HTTP 请求超时 30 秒。
- `data/issue-state.json` 持久化本地领取尝试数及时间：间隔至少 65 秒，
  北京时间每天最多 8 次尝试。失败尝试也计数，服务端实际额度始终优先。
- 同步、手动同步、健康回退串行执行；同一正在执行的同步共享结果。
- 上游一次下载得到的正文用于所有后续校验。任何失败保留最后有效缓存。
- 各设备仍只访问 NAS 缓存，不消耗上游领取额度。
- 同一次下载采集上游 Subscription-Userinfo，校验后随有效缓存保存；设备 GET/HEAD 返回该响应头。
- 历史版本各自保存订阅信息；旧历史没有信息时不套用其他版本的数据。信息按同步周期更新（默认 6 小时），并非实时流量。

## 测试与部署

```sh
npm ci
npm test
```

NAS 升级使用 `Dockerfile.nas`，复用旧镜像中的 Node/YAML 依赖；用
`--build-arg BASE_IMAGE=<已核实镜像ID>` 可锁定基础版本。
普通 `Dockerfile` 用于从 Node 22 重新构建，不是本次 NAS 升级路径。

部署目录保持 `/volume1/docker/fib-sub-sync`，配置和数据保持原位。
先在独立发布目录测试构建，再停止旧容器，备份源码、Compose 和完整 data，
复制通过测试的源码及 Compose，执行 `docker compose up -d --no-build`。
不要同时启动两个挂载同一 data 的同步容器；本地领取次数保护面向单实例。

回退时使用本次备份的 compose 与旧镜像重建服务；必要时从备份恢复源码与缓存。
不要倒退 `issue-state.json` 中的领取记录，否则可能重复申请。
账号配置、设备令牌、订阅 YAML、事件日志与完整订阅 URL 不进入 Git。
