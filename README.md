# dsh-skills-manager-plus

[English](README.en.md) | 中文 | [更新日志](CHANGELOG.md)

技能与命令管理插件：在 DeepSeek Harness 设置界面的左侧边栏新增「技能与命令」页面，
可直接查看、启用/停用、编辑、删除与添加技能，还能把常用的提示词保存为命令，
在输入框输入 `/` 即可快速调用。

## 截图

| 技能列表 | 添加技能 |
| --- | --- |
| ![技能列表](screenshot1.jpg) | ![添加技能](screenshot2.jpg) |

| 编辑技能 | 命令管理 | 编辑命令 |
| --- | --- | --- |
| ![编辑技能](screenshot3.jpg) | ![命令管理](screenshot4.jpg) | ![编辑命令](screenshot5.jpg) |

## 功能

| 能力 | 说明 |
| --- | --- |
| 列表 | 展示技能目录中的全部技能，按「全局 / 项目」作用域切换 |
| 展开预览 | 点开一行查看该技能正文的 Markdown 预览 |
| 启用 / 停用 | 改写技能 frontmatter（模型可调用 / 用户可调用），目录监视器约一秒内热生效，无需重启 |
| 编辑 | 名称、描述、何时使用、两个调用开关与正文，改名即重命名目录 |
| 删除 | 移除技能的 `SKILL.md`（目录形式连同资源目录一起删除），用插件自己的确认弹窗，危险操作红色高亮 |
| 添加 | 创建一个新的 kebab-case 技能，保存到全局或某个项目；在「项目」标签下打开时默认选中当前项目 |
| 从压缩包安装 | 选择 zip / tar / tar.gz，自动识别常见技能包布局（GitHub「Download ZIP」、skillhub 根 `SKILL.md` 整包），deflate 压缩也能解出；安装后弹出结果窗，列出已安装与跳过清单 |
| 搜索 / 分页 | 按名称或描述搜索，每页 10 条 |
| 命令 | 把常用提示词保存为 `/命令`，选中后即以用户消息发送给模型 |
| 导入设置 | 一键启用 / 停用 `.agents` 技能目录（用户级与项目级），恢复时只还原本页停用的技能 |
| 多语言 | 中文 / English，跟随界面语言，页面右上角可随时切换并记住选择 |

## 安装说明

**版本要求：** DeepSeek Harness（DSH）≥ 0.1.5-rc.1（在 0.1.6-alpha.1 上开发并测试）。DSH 自身依赖 Node.js ≥ 24.2.0 与 Git ≥ 2.31.0。

### 插件市场一键安装

已安装 `https://github.com/dsh-market/dsh-market` 的话，打开 **设置 → 插件市场**，
搜索 `dsh-skills-manager-plus`，点一下安装即可。

### 命令安装

```sh
# 本地目录（以 link 方式安装，改动即时生效，适合开发调试）
dsh plugin --profile web add <本仓库目录>

# 之后重启 dsh（或等待 profile 热重载），在「设置 → 技能与命令」即可看到页面
```

### 验证

打开 dsh web，进入 **设置 → 技能与命令**（侧边栏火花图标的那一项）。
页面没有出现时的排查顺序：

1. 换最新版 Chrome/Edge —— 部分插件的 bundle 在旧内核会加载失败；
2. 确认装进了正在使用的 profile（`dsh plugin --profile web ls` 查看清单）；
3. 浏览器控制台有报错时，附上报错内容提交 issue。

### 更新与卸载

```sh
dsh plugin --profile web ls                          # 查看已装插件
dsh plugin --profile web add <本仓库目录>             # 更新（重新 add 即覆盖）
dsh plugin --profile web remove dsh-skills-manager-plus # 卸载
```

## 配置写在哪里

技能的「唯一真相」是技能文件系统本身 —— 与 DSH 的技能提供者扫描的根目录完全一致：

```
~/.dsh/skills                           用户级技能
~/.agents/skills                        用户级 .agents 技能
<项目>/.dsh/skills                      项目级技能
<项目>/.agents/skills                   项目级 .agents 技能
```

每个技能是一个 `<name>/SKILL.md`（或扁平 `<name>.md`），带 YAML frontmatter。
启用 / 停用开关就是改写 `disable-model-invocation` 与 `user-invocable` 两个键，
其它字段（包括未建模的嵌套字段）在改写时逐字节保留。

命令保存在：

```
$DSH_HOME/commands/<name>.md
```

每个命令一个 Markdown 文件，frontmatter 带 `name`、`description` 与可选的
`argument-hint`，正文即保存的提示词。文件会被监视，增删改后约一秒内重新注册到
DSH 的命令注册表，无需重启。

插件自身仅持有一个状态文件（`$DSH_HOME/skills-manager-plus.json`），记录导入开关、
被停用的命令名，以及哪些技能是本页批量停用的 —— 切换回「启用 .agents 技能目录」时
只会恢复这些技能，手工停用的不受影响。

## 安全约定

- **只响应本机请求。** API 挂在同一个 loopback web server 上，非 loopback 来源直接 403。
- **写入被限定在本插件管理的目录内。** 提交的路径越过技能根目录会被拒绝。
- **状态文件原子改写**，加载时校验，损坏则重置为默认值。
- **命令以用户消息下发。** 调用 `/命令` 时，提示词通过 `agent.followup` 作为普通
  用户消息发送，权限与日志行为与用户本人输入一致。

## 开发

```sh
node test/run.mjs          # 全部测试（88 项，跨多个套件）
```

| 套件 | 覆盖范围 |
| --- | --- |
| `test/store.test.mjs` | `skills.js` 与 `commands.js` 的纯逻辑：frontmatter 解析 / 改写、技能与命令的增删改、校验、根目录解析、压缩包安装 |
| `test/archives.test.mjs` | zip / tar 包解析：目录标记、deflate(method 8)、zip64、中央目录 |
| `test/host.test.mjs` | 宿主端全部 HTTP 路由，用假的 Cordis 上下文驱动真实 `apply()`，覆盖 loopback 限制、`.agents` 开关、压缩包安装 |
| `test/client.test.mjs` | 浏览器 bundle 能否被 shell 加载并注册 `settings.section` 设置页面 |
| `test/add-install-scope.test.mjs` | 添加 / 从压缩包安装弹窗的默认作用域（项目页打开时选中当前项目） |
| `test/install-result.test.mjs` | 安装结果弹窗的四种结果与跳过清单渲染 |
| `test/confirm.test.mjs` | 删除确认弹窗（替代 `window.confirm`）的渲染 |
| `test/project-labels.test.mjs` | 项目标签去重 / 命名，与 zh/en i18n 占位符一致性 |

测试不依赖任何测试框架，只用 Node 内置的 `node:test`。

### 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主端：loopback HTTP API、状态文件、.agents 导入开关 |
| `lib/skills.js` | 技能文件模型：frontmatter 解析 / 改写、技能增删改查、根目录解析 |
| `lib/commands.js` | 命令存储：命令文件读写、文件监视、注册到 DSH 命令注册表 |
| `lib/client.js` | 浏览器端：设置页面 UI（手写 lazy-CJS bundle，无构建步骤） |
| `cordis.patch.yml` | bundle 补丁，把本插件插入 profile 的层栈 |

## License

MIT