# dsh-authless 设计

给本机 DSH Web 去掉启动令牌（launch token）那一层：`http://127.0.0.1:3080/` 与 `/api`
不带 `?token=`、不带 cookie 也能用。只去鉴权那一层，Host/Origin 信任墙留在原处。

靶子：`@deepseek-ai/dsh-web-app@0.2.1-rc.2` 与它拉起的
`@deepseek-ai/dsh-client-connection@0.2.1-rc.2`、`@deepseek-ai/dsh-host-webserver@0.2.1-rc.2`。
本文档的英文版见 [design.md](design.md)。

## 1. 上游行为（0.2.1-rc.2）

| 面 | 位置 | 代码在做什么 |
| --- | --- | --- |
| 启动令牌 | `dsh-client-connection/lib/index.js:294-300` `processLaunchToken()` | 每个进程一枚随机令牌，没有 env / 配置开关可关 |
| 令牌换 cookie | 同上 `:440-446`（`authenticatedUrl` 把 `?token=` 拼进 URL）、`:458-497`（`authorizeIndex` 用令牌换签名 cookie） | 浏览器首次访问必须带令牌，之后凭 cookie |
| `/api` 闸门 | 同上 `:742-752` `admit(request)` | 先 `isTrusted(request)`（不过 → 403），再问鉴权属主（不过 → 401） |
| 鉴权属主 | 同上 `:694-712`（`HostConnectionService.browserAuth`，由 `apply` 里 `BrowserAuth.create(...)` 造出）、`:797-814` | `/connect`、index、`/api`、`authenticatedUrl` 全部经它 |
| 打印/打开 URL | `dsh-web-app/lib/index.js:160-165` | 二者都取 `connection.authenticatedUrl(webUrl)`：属主怎么回答，印出来与打开的就是什么 |
| WebSocket 升级 | `dsh-client-connection/lib/index.js:756-757` | `admitConnection()` 先走 `this.admit(request)`，与 `/api` 同一条闸（403 → 401 → 放行） |
| 通配绑定 | `dsh-web-app/lib/startup.js:48` + `dsh-host-webserver/lib/index.js:255` | 两处都拒绝 `0.0.0.0`，错误文本给的理由是：绑所有网卡就把 RCE 面暴露到网络 |
| `--public-url` | `dsh-web-app/lib/startup.js:25` | 0.2.1 起上游已有，本插件无需处理 |

## 2. 去令牌：做法与边界

换掉 connection 服务持有的鉴权属主，服务、路由、peers 都不换：

```
connection = ctx.get('connection')            // HostConnectionService（上游注册的）
connection.browserAuth = new OpenAuth()       // 只写这一个字段
```

`OpenAuth` 实现上游属主被调用的那五个方法，每个都回答「放行」：

| 方法 | 上游语义 | 本插件的语义 |
| --- | --- | --- |
| `isAuthenticated(req, secure)` | 校验签名 cookie | `true` |
| `authenticateApi(req, secure)` | 校验 API 凭据 | `undefined`（第一道已经是 true，走不到） |
| `authorizeIndex(req, res, secure)` | 令牌换 cookie / 凭 cookie 放行 index | `true`，不写 401 |
| `authorizeConnect(req, res, secure, publish)` | 令牌换 operator + 302 | 校验 `interactions` 声明后 `publish()` + 302，无 token、无 cookie |
| `authenticatedUrl(baseUrl)` | 把 `?token=` 拼上 | 去掉 `token` 与 `#`，其余原样 |

这样就够，是因为 `admit()`（`:742-746`）先做 `isTrusted(request)`。403 那一层是
`HostConnectionService` 自己的逻辑，不经过属主，所以换属主只去掉 401 那一层。回环、监听绑定
地址、`--trusted-host` 组成的信任墙逐字未变。

本插件不改写 `admit`、`requestRejection`、路由与升级路径，不往 index.html 注入任何东西，也不
伪造 cookie。令牌与 cookie 变成不必要的东西，没有任何一道校验被绕过。

契约：`inject = ['connection']`，属主在 inject 回调里换。宿主 reload 会重建 connection 服务与
属主，回调随之重跑，所以用 `Symbol.for('dsh-authless.open-auth')` 标记判重，第二次 inject 不会
叠上第二个属主。全程不 `await`，不用 `ctx.root` 之外的能力，卸载时由 `ctx.effect` 把原来那个
属主放回去。

## 3. 范围

只做免 token。这个决定同时去掉了 `startup.js`、`commander` 与 `@deepseek-ai/dsh-cmdline`：
startup 那一半原本是用来反转 `--no-open`（要改 `web-runtime` 行）和重开 `--host 0.0.0.0`
的，后者见 §5。`--public-url` 不用做，上游已有。

`cordis.patch.yml` 因此只有一条 insert（`id: authless`，`name: dsh-authless`），包也没有
运行期依赖。

## 4. 威胁模型

| 面 | 去掉令牌之前 | 之后 |
| --- | --- | --- |
| 本机浏览器误访（DNS rebinding / 恶意网页打 127.0.0.1） | Host 不匹配 → 403；匹配但无 cookie → 401 | Host 不匹配 → 403（不变）；匹配 → 放行 |
| 同机其他用户进程 | 拿不到令牌就 401 | 可直连；本机多用户环境请勿使用 |
| 网络上的其他机器 | 绑定就不是通配，且 Host 不匹配 → 403 | 不变，仍然 403，除非你 `--trusted-host` 主动放行 |

这是一次自觉的降级。装上以后，同机的浏览器与进程都不需要会话就能进；非本机 authority
仍然进不来。默认只监听 `127.0.0.1`。

## 5. 为什么不放开 `0.0.0.0`

dsh 在两处拒绝通配绑定：CLI（`startup.js:48`）与 webserver 的配置校验
（`webserver/lib/index.js:255`）。错误文本给的理由是绑所有网卡会把 RCE 面暴露到网络。要放开
就得替换 `web-startup` 与 `webserver` 两个上游行，后者等于自己实现一个 webserver，远超一个
「去令牌」插件的边界。局域网访问照旧走反代到 `127.0.0.1`；`--public-url` 用来告知客户端该用
哪个 URL，`--trusted-host` 用来放行那个 authority。

## 6. 验证（`npm test` 跑 `scripts/verify.mjs`）

1. 声明闸门：`package.json` 的 `dsh.bundle.patch` 指向存在的文件；patch 里只有一条 `insert`
   （`id: authless`、`name: dsh-authless`），不含 `web-startup` / `web-runtime` / `webserver`
   行，不设 `disabled: true`；`dependencies` 为空。
2. 属主契约：用假 connection 服务驱动 `apply`，断言五个方法的行为（全放行、URL 去 token、
   `/connect` 的 `interactions` 声明校验仍然生效），以及幂等，第二次 inject 不会叠属主。
3. 不越界：断言 `admit`、`requestRejection`、路由注册没有被改写（只赋值 `browserAuth`
   一个字段），并且 disposer 会把原来的属主还原。
4. 信任墙还在：读上游 `admit` 的源码，断言 403 判断发生在访问 `browserAuth` 之前，且
   `admitConnection()` 调的是 `admit()`。上游改顺序或把升级路径挪走，测试就红，不会静默通过。
5. 文档与代码一致：两份 README 都提到 403 信任墙还在、同机的其他用户或进程可以直接用；三份
   文档里至少有一处写明这是降级。

## 7. 兼容性

- 只承诺 `@deepseek-ai/dsh-client-connection` 0.2.1-rc.2。属主的方法名与字段名由上游
  `HostConnectionService` 决定，行号记在 §1，上游改了这份文档跟着改。
- 不依赖任何第三方包，ESM，Node `^22.19 || >=24`，与上游一致。
- 版本探测：`browserAuth` 字段不存在时插件打一条警告，把令牌门禁留在原地，不会记一条自己并
  没有做到的安装成功。
