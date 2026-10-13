# Proxy Sub Distributor

一个面向个人使用的代理订阅整理与再分发工具。

它从上游 Clash/Mihomo 订阅地址定时拉取 YAML，完成格式校验、节点健康检查、
历史版本保留和策略组整理，然后通过独立令牌为路由器、电脑、手机等设备提供稳定的
订阅地址。上游订阅只需拉取一次，各设备从自己的私有地址获取整理后的配置。

## 功能

- 定时拉取一个通用 Clash/Mihomo 上游订阅。
- 支持自定义上游 HTTP 请求头。
- 下载后校验 YAML，异常内容不会覆盖最后一次正常版本。
- 按节点 DNS 与 TCP 连通性进行健康检查。
- 保存历史版本；当前版本异常时可回退到最近的健康版本。
- 为不同设备生成带独立令牌的订阅地址。
- 全局生成 `fallback` 故障转移策略组。
- 使用 Mihomo `dialer-proxy` 生成链式代理及其故障转移组。
- 策略文件支持热加载，无需重启或重新构建容器。
- 使用 JSONL 记录同步、健康检查和订阅访问事件，不记录设备令牌。

## 目录

```text
src/                              服务源码
test/                             自动化测试
data/config.example.json          主配置示例
data/clash-strategies.example.json 策略配置示例
compose.yml                       Docker Compose 配置
```

运行时产生的账号配置、订阅缓存、历史、事件日志和自定义策略文件均已加入
`.gitignore`，不会进入版本库。

## 快速开始

要求：

- Node.js 20 及以上，或 Docker / Docker Compose
- 一个可直接下载 Clash/Mihomo YAML 的上游订阅地址

复制配置：

```bash
cp data/config.example.json data/config.json
cp data/clash-strategies.example.json data/clash-strategies.json
```

生成随机令牌：

```bash
openssl rand -hex 24
```

编辑 `data/config.json`，填写：

- `server.syncToken`：管理接口令牌。
- `upstream.url`：上游 Clash/Mihomo 订阅地址。
- `upstream.headers`：可选的上游请求头。
- `sync.intervalMinutes`：定时同步间隔。
- `health.*`：节点健康检查参数。
- `devices.<设备名>.token`：每台设备的独立订阅令牌。

Docker 启动：

```bash
docker compose up -d --build
docker logs -f proxy-sub-distributor
```

本地启动：

```bash
npm install
npm start
```

## 设备订阅

设备名来自 `data/config.json` 中 `devices` 的键：

```text
http://nas.local:7899/sub/router?token=<router-token>
http://nas.local:7899/sub/laptop?token=<laptop-token>
http://nas.local:7899/sub/phone?token=<phone-token>
```

建议仅在局域网、VPN 或可信反向代理内使用。不要将带令牌的明文 HTTP 地址直接暴露到公网。

## 策略热加载

全局策略位于：

```text
data/clash-strategies.json
```

每次设备请求订阅时，服务都会读取并验证该文件：

- 新配置有效：立即用于本次订阅，无需重启容器。
- JSON、正则或节点匹配无效：拒绝新配置，继续使用最后一次有效版本。
- 设备级 `devices.<设备名>.clash` 配置会覆盖同名的全局策略。

`fallbackGroups` 示例：

```json
{
  "fallbackGroups": [
    {
      "name": "Region A Fallback",
      "targetGroup": "PROXY",
      "includePattern": "^Region A ",
      "excludePattern": "Deprecated|Unavailable",
      "url": "https://www.gstatic.com/generate_204",
      "interval": 60
    }
  ],
  "chainGroups": []
}
```

`targetGroup` 必须与上游订阅中的策略组名称一致。`includePattern` 和
`excludePattern` 使用 JavaScript 正则表达式。

## 链式代理

当前 Mihomo 已移除旧的 `relay` 策略组。本项目通过克隆出口节点并设置
`dialer-proxy` 来生成链式代理：

```json
{
  "fallbackGroups": [],
  "chainGroups": [
    {
      "name": "Chained Exit Fallback",
      "targetGroup": "PROXY",
      "secondHopPattern": "^Exit Node ",
      "firstHops": [
        {
          "name": "Chain Primary",
          "includePattern": "^Entry Primary "
        },
        {
          "name": "Chain Backup",
          "includePattern": "^Entry Backup "
        }
      ],
      "url": "https://www.gstatic.com/generate_204",
      "interval": 60
    }
  ]
}
```

链路为：

```text
设备 → Entry 节点 → Exit 节点 → 目标网站
```

链式代理的匹配正则最多只能命中一个节点；命中多个节点时仍拒绝新策略配置。
出口节点不存在时跳过整组链路；入口节点不存在时仅跳过该入口，保留其余可用入口。
所有入口均不存在时不生成链式代理组，原有节点和策略组继续保留。

## 管理接口

健康状态：

```bash
curl http://nas.local:7899/health
```

缓存和设备列表：

```bash
curl http://nas.local:7899/status
```

立即从配置的上游地址同步：

```bash
curl -X POST 'http://nas.local:7899/sync?token=<sync-token>'
```

临时从另一个订阅地址同步：

```bash
curl -X POST 'http://nas.local:7899/sync-url?token=<sync-token>' \
  -H 'content-type: application/json' \
  -d '{"url":"https://provider.example/subscription.yaml"}'
```

## 数据与安全

不会提交到 Git 的运行时文件包括：

```text
data/config.json
data/clash-strategies.json
data/latest.yaml
data/metadata.json
data/history/
data/rejected/
data/events.jsonl
```

订阅地址通常包含访问凭据。请勿把真实 `config.json`、日志、缓存 YAML 或截图提交到公开仓库。

## 测试

```bash
npm test
```

## 开源许可

本项目采用 [MIT License](LICENSE)。
