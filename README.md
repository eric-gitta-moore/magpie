> 本文由 OpenAI Codex（GPT-6.1 Sol）生成。

# Magpie 路由监控

在 Magpie 主窗口侧栏的“插件”区域增加“路由监控”页面，显示全局在途、排队、路由 QPS、路由图与最近请求。界面使用 Magpie 的主题；后台服务运行在 Magpie 的插件宿主内。

## 指标口径

- **在途**：官方 `/v1/magpie/concurrency` 的 `requests`，包含等待并发槽的请求
- **排队**：同接口的 `waiting`，是在途请求的一部分
- **路由 QPS**：按记录携带的请求开始时间，统计最近 60 秒路由记录数量并除以 60；同一路由的重试不重复计数
- **未知值**：首次启动或无法恢复的事件缺口后，连续观察满 60 秒前显示 `—`；在途读取失败也显示 `—`

路由 QPS 与网关入口 QPS 的统计对象不同。长期排队时，Magpie 可能为等待与正式执行分别建立路由记录。延迟建立的记录若原始开始时间已在窗口外，不计入当前窗口。此插件不将这个数解释为唯一客户端请求的入口速率。

页面隐藏时暂停界面轮询，后台继续采集。重新打开页面会立即获取当前状态。事件无法从游标补回、网关进程更换或统计时钟异常时，重新开始统计窗口。

## 安装

将测试验收后的包解压为插件目录，再安装该目录：

```sh
mkdir -p ~/workspace/magpie-route-monitor
tar -xzf /absolute/path/magpie-route-monitor-0.1.0.tgz --strip-components=1 -C ~/workspace/magpie-route-monitor
magpie plugin add ~/workspace/magpie-route-monitor
```

Magpie 的本地文件入口不会自动解压 tar 包，因此要传目录。

然后在主窗口侧栏“插件”区域打开“路由监控”。插件不注册供应商，也不修改模型请求。

源码保存分支：

```sh
magpie plugin add github:eric-gitta-moore/magpie#codex/live-monitor-plugin-1106
```

该分支根目录是独立插件包，与此前修改 Magpie 核心的分支分开保存。

## 配置

默认本地页面服务端口为 `3491`。插件选项 `port` 可以修改它。网关地址默认使用 Magpie 注入宿主的 `MAGPIE_ADDR`；插件选项 `gateway` 可指定另一回环 HTTP 地址。

页面只读取本地网关，不提供请求正文、账号密钥或配置写入接口。所有模型请求仍由 Magpie 原有链路处理。

## 本地验证

需要 Node.js 22+；Magpie 的插件宿主使用 Bun。

```sh
npm test
npm pack
```

浏览器用例运行 `npm run test:ui`，使用 Playwright，并通过真实 Magpie 的页面服务代理验证侧栏入口、主题、隐藏恢复和数据展示。截图验收记录另见交付报告。

## 参考

- [官方页面服务接口](https://github.com/yetone/magpie/tree/main/internal/plugin/testdata/pageservice)
- [官方路由事件协议](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-routing.md#route-events-for-a-display)
- [官方全局在途接口](https://github.com/yetone/magpie/blob/main/internal/gateway/concurrency.go)
