# dsh-authless

把本地 DSH Web 的启动令牌校验关掉。装上之后 dsh 打印的是干净的 `http://127.0.0.1:3080/`，
页面不带 cookie 也能打开，`/api` 对已通过 authority 检查的请求不再回 401，界面用的
WebSocket 升级走同一条路。

令牌本来是这台机器上的进程与 harness API 之间唯一那道检查，装它就是降级。装之前先看
[已知限制](#已知限制)。

## 安装

```sh
dsh plugin --profile web add dsh-authless
dsh --profile web
```

打开它打印的地址就行。插件只往 profile 里加一行（`id: authless`），宿主自己的行不动，所以
后面更晚的一层 patch（profile 的 `cordis.patch.yml`、`$DSH_HOME` 的 patch、`--patch`）照样能
覆盖它。卸掉：

```sh
dsh plugin --profile web remove dsh-authless
```

## 改动内容

connection 服务把浏览器鉴权属主放在 `browserAuth` 字段里，令牌、cookie、index 的每个判断都
从这个对象走。插件把自家的属主放进去，鉴权一律回答通过，能到服务的请求就会被服务；卸载时把
原来那个属主放回去。

`admit()` 先判断请求的 authority，再问属主：回环、监听绑定地址，或用 `--trusted-host` 声明过
的 authority 才放进来。别处来的请求照样 403，那段代码插件没碰。

## 已知限制

- 本机上够得到这个端口的进程都能用 harness API，同机其他用户也一样。只适合单用户机器。
- 反代或局域网客户端要先用 `--trusted-host` 声明 authority，不然照旧 403。
- 只按 `@deepseek-ai/dsh-client-connection` 0.2.1-rc.2 写。宿主的 connection 服务没有
  `browserAuth` 字段时，插件打一条警告，令牌门禁留在原地。
- `--host 0.0.0.0` 仍被 dsh 自己拒绝，这个插件不改那处判断。

## 开发

```sh
npm test    # scripts/verify.mjs
```

设计说明见 [docs/design_ZH.md](docs/design_ZH.md)。

## License

[MIT](LICENSE)
