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

## 地区自动选择（2026-11-12）

运行策略仍由 NAS `data/clash-strategies.json` 管理，设备请求时加载。
历史字段 `fallbackGroups` 下每组可设置 `type: "url-test"` 和 `tolerance: 300`；
省略 type 保持 fallback，url-test 省略 tolerance 默认 300 ms，允许 0–65535 整数。
当前八个地区组使用 url-test / 300 ms；保留组名、节点过滤、60 秒检测及 lazy=false，
日本链式组仍为 fallback。组名中的“故障转移”为兼容已保存选择而保留。
容差减少小幅延迟差引发的切换，不保证连续多轮确认或修复实际丢包。
修改源应是分发项目及运行策略，不应只改路由器下载的 YAML。

## 多上游与 Kitty

在 NAS 私有目录中的 `data/config.json` 增加 `upstreams` 即可启用第二个来源。FIB 继续提供基础 YAML、规则和既有策略。每个追加上游有单独的同步周期和缓存，成功的节点在设备下载时附加到指定的 `select` 组。示例使用当前 FIB 的 `🔰国外流量`。

```json
{
  "upstreams": [
    {
      "id": "kitty",
      "name": "Kitty",
      "socketPath": "/run/kitty/subscription.sock",
      "targetGroup": "🔰国外流量",
      "intervalMinutes": 360,
      "excludePattern": "^(?:🇦🇱\\s*)?(?:剩余流量|距离下次重置剩余|套餐到期|官网)[：:]"
    }
  ]
}
```

- Kitty 节点按订阅名称的地域旗标分组，每组使用 `url-test`、300 ms 容差、60 秒间隔和 `lazy: false`。四种账户提示可以通过示例的 `excludePattern` 过滤。缺少地域旗标的真实节点归入「其他」。
- 普通 YAML 来源可填写 `url` 和可选的 `headers`。每个源应指定自己的 `id` 和显示名称。附加节点统一加上来源前缀。
- 非法响应、会话失效或健康检查不通过时，继续分发该源上次成功的节点。`GET /status` 提供每个源的最近成功时间、节点数和错误。设备的 `Subscription-Userinfo` 仍显示 FIB 账户信息。

Kitty 浏览器每轮刷新仪表盘并用当前登录态下载最新的订阅。可以用 `compose.kitty.yml` 部署可选的浏览器服务。

1. 将 `KITTY_PROFILE_DIR` 指向 NAS 专用 Chromium 的持久化目录。目录保留 `kitty-profile`，使用浏览器在 Kitty 官方页面登录一次并勾选「记住我」。同一个 profile 仅供一个 Chromium 实例使用。
2. 将 `KITTY_RUNTIME_DIR` 指向另一个 NAS 私有目录并设为 `0700`。目录由 `KITTY_PUID` / `KITTY_PGID` 指定的浏览器用户持有。浏览器的 YAML 服务使用 `0600` 的 Unix 套接字，分发服务只读挂载该目录。
3. 使用 `docker compose -f compose.yml -f compose.kitty.yml config` 核对配置。发布构建时使用同一组 Compose 文件，并按上面的 NAS 发布流程启动。会话到期时，在该 NAS 浏览器中重新登录，下轮同步即可恢复。

浏览器服务不发布端口。`KITTY_SUBSCRIPTION_HOSTS` 指定允许的订阅主机，如果 Kitty 官方更换域名，可核对后更新。运行目录里的浏览器会话数据、订阅内容和缓存均保存在 NAS。
