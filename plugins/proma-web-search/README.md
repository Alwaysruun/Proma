# Proma Web Search

为 Proma Agent 提供公网搜索和网页正文读取的插件。工具名与 Cindy Web Search 保持一致：

- `search_web`
- `fetch_page`

## 功能

- 零配置搜索：默认使用 Bing，无需 API Key。
- 可选搜索源：Brave、Tavily、DeepSeek。
- 网页正文读取：配置 Tavily Key 时使用 Tavily Extract，否则使用本地 HTML 正文提取。
- 安全限制：拒绝本机/内网地址，限制重定向次数，限制响应体积，网页正文标记为不可信。

Bing 兜底不需要 Key，但可能受地区、人机验证或结果质量影响。日常使用建议至少配置 Brave 或 Tavily。

## 安装

1. 打开 Proma 的「Agent 技能」→「插件」。
2. 选择「从文件夹安装」，选中本目录 `plugins/proma-web-search`。
3. 安装后在 MCP 列表启用 `proma-web-search`。

插件会把 `skills/web-search` 复制到当前工作区，并在工作区 `mcp.json` 中注册 `proma-web-search` 服务。

## 配置 API Key

默认使用 Bing，不需要配置。需要 Brave、Tavily 或 DeepSeek 时，复制 `config.example.json` 到以下任一位置并填写 Key：

- `~/.proma/web-search.json`（正式版）
- `~/.proma-dev/web-search.json`（开发版）
- 本插件目录下的 `config.json`

也可以使用环境变量：

```text
BRAVE_API_KEY
TAVILY_API_KEY
DEEPSEEK_API_KEY
PROMA_WEB_SEARCH_PROVIDER
```

`defaultProvider` 可选：`auto`、`bing`、`brave`、`tavily`、`deepseek`。`auto` 会优先使用已配置 Key 的 Tavily、Brave、DeepSeek，否则使用 Bing。

## 配置提示

Proma 启动 MCP 时只会传入工作区 mcp.json 里的 env，不会自动继承完整 shell 环境；因此更推荐直接写配置文件，或把 Key 加到 mcp.json 的 env 中。

## 配置界面

在 Proma 的「Agent 技能」→「插件」中点击 Web Search 卡片的「配置」按钮，可以直接设置默认搜索源、超时、结果数和 API Key。界面保存的密钥由系统安全存储加密，并通过 MCP 环境变量注入，不会写入 mcp.json。

界面保存的配置会覆盖插件目录或 ~/.proma/web-search.json 中的同名配置。

## 与 Cindy Web Search 的差异

- Cindy 的 `cindy` 搜索源依赖 Cindy 主机的模型原生搜索，Proma 无法复用；本插件把 `cindy`/`auto` 映射到 Proma 本地可用的搜索源。
- Cindy 的插件设置页、`cindy.network` 密钥注入和面板 UI 不在本插件范围内；这里用 JSON 配置和 MCP 环境变量替代。
- 搜索结果和正文的返回结构保持一致，Agent 可以直接按 Cindy 的调用习惯使用。

## 开发

```bash
bun test plugins/proma-web-search
```

直接测试 MCP 握手：

```bash
node plugins/proma-web-search/server/index.mjs
```

然后向 stdin 写入一行 JSON-RPC 请求。
