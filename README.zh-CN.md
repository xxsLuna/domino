<div align="center">

# domino

[English](README.md) · **简体中文**

**打开一个 `.domino` 文件，LLM 即时为你构建整个应用。**

一个跨平台运行时：纯文本的 *domino* 定义（DOM + 智能体）会被你自己的 LLM API Key
实时转换成可交互的应用界面。无需手写页面、无需模板 —— 定义描述应用，智能体负责渲染。

[![Build](https://github.com/xxsLuna/domino/actions/workflows/build.yml/badge.svg)](https://github.com/xxsLuna/domino/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/xxsLuna/domino?display_name=tag&sort=semver)](https://github.com/xxsLuna/domino/releases)
[![Tests](https://img.shields.io/badge/tests-116%20passed-brightgreen)](https://github.com/xxsLuna/domino/actions/workflows/build.yml)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-lightgrey)](#下载)

macOS · Windows · Linux · Android（Web 构建）

[下载](#下载) · [快速开始](#快速开始) · [domino 格式](#domino-文件格式v1) · [文档](#目录)

</div>

---

## 目录

- [这是什么？](#这是什么)
- [特性](#特性)
- [工作原理](#工作原理)
- [下载](#下载)
- [快速开始](#快速开始)
- [使用 domino](#使用-domino)
  - [打开定义](#1-打开定义)
  - [注册 LLM Key（BYOK）](#2-注册-llm-keybyok)
  - [交互 —— 智能体实时渲染下一屏](#3-交互--智能体实时渲染下一屏)
- [domino 文件格式（v1）](#domino-文件格式v1)
- [支持的 LLM 提供商](#支持的-llm-提供商)
- [生成的界面：HeroUI + 应用模式](#生成的界面heroui--应用模式)
- [设计主题](#设计主题)
- [本地演示（无需 API Key）](#本地演示无需-api-key)
- [开发](#开发)
- [架构](#架构)
- [贡献](#贡献)
- [许可证](#许可证)

## 这是什么？

**domino**（可以理解为 *DOM* + *agent*）是一个小型运行时应用。你给它一个 `.domino`
文件 —— 一种 INI 风格、带微型条件脚本的文本文件 —— 它就会打开一个窗口，看起来就像
一个早已存在的应用：定义要求登录就先出现登录页，自动加载应用 Logo，用实时组件铺满
网格，仪表盘的数据来自真实的 API 调用。

你看到的一切都由你自己配置的 LLM 在运行时生成（**自带密钥，bring your own key**）。
每次点击按钮，当前上下文都会发回给智能体，由它实时渲染出下一屏。

## 特性

- **`.domino` 定义** —— INI 分节（`[meta]`、`[auth]`、`[api]`、`[ui]`、`[script]`）
  加上布尔条件 DSL（`when logged_in -> goto main`）。解析错误附带行号。
- **LLM 实时生成界面** —— 智能体流式输出经过校验的界面规格，生成过程中即渐进渲染；
  每张卡片在完整到达时只挂载一次。
- **HeroUI 组件注册表** —— 基于 [HeroUI v3](https://heroui.com)（React Aria + Tailwind CSS v4）
  的 36 个具名组件：页头、卡片、表格、列表、KPI、表单、标签页、对话框、面包屑、分页……
  没有拖拽、没有自由 CSS —— 规格先校验再渲染。
- **原生应用模式** —— 智能体遵循仪表盘 / 列表 / 详情 / 表单 / 设置 / 登录等模式，运行时
  负责应用外壳：桌面端侧边栏、平板图标导航栏、手机底部标签栏。
- **天然响应式** —— 模型只按 12 列网格设计一次，运行时为平板和手机自动重排（KPI 行保持
  并排、宽分栏改为上下堆叠、表格变为卡片）。
- **认证流程** —— 定义声明了 `auth`，智能体就生成登录页；运行时拦截表单，调用你的
  `login_endpoint`，保存 token；设置 `skip_if_logged_in` 后下次启动自动跳过登录。
- **白名单 API 访问** —— 智能体只能调用定义中 `[api] allow` 列出的接口，token 自动附带。
- **会话历史** —— 已渲染页面的前进/后退（应用栏 + `⌘[` / `⌘]`）。
- **会话渲染缓存** —— 重访同一屏幕状态直接复用缓存，不再消耗 LLM 调用；缓存在程序
  重启时丢弃，每次启动都是全新生成。
- **设计主题** —— `[ui]` 分节控制主题色、强调色、圆角风格（`sharp` / `soft`）、半径、
  密度，以及分步状态色（Tailwind 风格调色板）。
- **跨平台** —— Electron 桌面端（macOS/Windows/Linux）+ Capacitor 包装的纯 Web 构建
  （Android），三端共享同一套平台无关核心。
- **最近打开与设置** —— 不打开定义直接启动时，显示基本信息、最近的 domino 列表，以及
  BYOK 提供商设置面板入口。
- **domino maker** —— 用自然语言描述想要的应用（是什么服务、每个 API 接收和返回什么、需要
  哪些页面），缺少关键信息时会先提问，补全后生成经过校验的 `.domino` 文件，可直接运行、保存或继续修改。
- **拖放打开** —— 把 `.domino` 文件拖到窗口任意位置即可打开。
- **自动更新** —— 启动时检查 GitHub Releases，一键完成下载 → 安装 → 重启（桌面端）；Android
  会下载新的 APK 交给系统安装程序。

## 工作原理

```
 .domino 文件 ──解析──▶ 应用上下文（auth · api 白名单 · 主题 · 脚本）
                                │
                                ▼
       ┌───────────── 智能体循环（你的 LLM Key）─────────────┐
       │  工具: render_ui · call_api（白名单）· navigate       │
       │  流式输出 UiSpec JSON → 校验 → 渲染                    │
       └──────────────────────┬──────────────────────────────┘
                              ▼
     响应式 12 列网格上的 HeroUI 组件 + 应用外壳
                              │
       点击 / 提交 ───────────┼─────── 前进 / 后退
                              ▼
       上下文 + ACTION 发给智能体 → 下一屏实时渲染
```

## 下载

在 [**Releases**](https://github.com/xxsLuna/domino/releases) 页面获取对应系统的最新构建
（每次推送到 `main`，CI 都会构建；当 `package.json` 的版本号是新的时，会以 `v<版本号>` 标签发布
Release —— 想发布新版本就提升版本号）：

| 平台 | 产物 |
|------|------|
| macOS（Apple 芯片） | `domino-<版本号>-arm64.dmg`、`domino-<版本号>-arm64-mac.zip` |
| Windows | `domino-<版本号>-win-x64.exe`（NSIS 安装包） |
| Linux | `domino-<版本号>.AppImage`、`domino_<版本号>_amd64.deb` |
| Android | `domino-<版本号>-android.apk` |

## 快速开始

1. 从 [Releases](https://github.com/xxsLuna/domino/releases) 安装（或按下方说明从源码构建）。
2. 启动 **domino**。欢迎页会显示最近打开的定义和 ⚙ 设置按钮。
3. 打开设置面板，注册你的 LLM 提供商（API Key 只保存在本机）。
4. 打开一个 `.domino` 文件 —— URL、`domino://` 链接、文件选择器或最近列表均可。

想不花一分钱先试试？见[本地演示](#本地演示无需-api-key)。

## 使用 domino

### 1. 打开定义

三种加载方式：

- **URL** —— 在欢迎页粘贴 `https://…/app.domino` 或 `domino://app.example.com/crm.domino`。
- **文件** —— 从磁盘选择 `*.domino` 文件，或直接拖到窗口上（桌面端双击文件也可以直接打开）。
- **domino maker** —— 还没有文件？在欢迎页用自然语言描述应用，让 LLM 帮你写一个。
- **最近打开** —— 一键重新打开之前加载过的任何定义。

首次打开后，domino 会把定义记入最近列表。

### 2. 注册 LLM Key（BYOK）

按 ⚙ → 选择提供商 → 粘贴 Key → 保存。桌面端密钥使用系统钥匙串加密（`safeStorage`），
Web 端保存在 `localStorage`。支持的端点见[支持的提供商](#支持的-llm-提供商)。

### 3. 交互 —— 智能体实时渲染下一屏

点击任意按钮或提交表单：运行时把当前屏幕上下文和操作发给智能体，智能体调用 API
（仅限白名单内）并流式渲染下一屏。用工具栏箭头（或 `⌘[` / `⌘]`）在历史中穿行 ——
访问过的屏幕直接从会话缓存读取，不再消耗 token。

## domino 文件格式（v1）

```ini
[meta]
name = ExampleCRM
description = Lead tracking for a small sales team
logo = https://example.com/logo.png
home = main

[auth]
required = true
login_endpoint = https://api.example.com/auth/login
token_key = access_token
skip_if_logged_in = true

[api]
base_url = https://api.example.com
allow = /login, /leads, /leads/*

[ui]
theme = auto            ; light | dark | auto（跟随系统）
primary = #4f46e5       ; 强调色（按钮、链接、卡片标题）
style = sharp           ; soft（默认，圆角）| sharp（直角）
radius = 0              ; 直接指定圆角像素（优先于 style）
density = compact       ; comfortable（默认）| compact
success = #10b981       ; 分步颜色（Tailwind 风格调色板）
warning = #f59e0b
danger = #ef4444

[script]
when not logged_in -> goto login
when logged_in -> goto main
on auth_failed -> goto login

[guide]
; 给界面智能体的自由文本，原样保留。描述服务、每个 API（方法、路径、请求/响应字段、要显示什么）和需要的页面。
Sales reps log in and see their pipeline.
GET /leads returns [{id, name, company, stage, value}] — show it as a table, newest first.
POST /leads {name, company, value} creates a lead; afterwards return to the list.
```

`[guide]` 会和 `[meta] description` 一起作为应用说明交给智能体，页面、数据和文案都会据此生成；
白名单和由运行时负责的登录规则依然生效。

`[script]` 条件 DSL 支持标识符（`logged_in`）、`not`、比较（`==`、`!=`、`<`、`>`）、
`and` / `or`、括号和点路径（`param.plan == "pro"`）。命令为 `goto <page>`、
`render <page>`、`call <endpoint>`。`on <event>` 规则优先于 `when` 规则求值。

更多示例见 [`samples/`](samples/) —— 需要登录、免登录、条件路由各一个。

## 支持的 LLM 提供商

任何暴露以下 API 之一的端点都可以 —— 只需把 domino 指过去：

| 提供商 | 端点 | 典型后端 |
|--------|------|----------|
| **OpenAI Responses** | `/responses` | OpenAI |
| **Chat Completions** | `/v1/chat/completions` | OpenAI 兼容 API、Ollama、LM Studio、自定义 Base URL |
| **Anthropic Messages** | `/v1/messages` | Claude |

> **注意** —— 完整的智能体循环（API 调用、导航）需要模型支持工具/函数调用。
> 纯聊天模型仍可通过 JSON 回退方式渲染界面。

## 生成的界面：HeroUI + 应用模式

每一屏都是智能体通过 `render_ui` 流式输出的 `UiSpec`。节点只声明注册的组件名和桌面网格
位置，其余交给运行时。

```jsonc
{
  "version": 1,
  "page": "leads",
  "nav": [                                   // 主导航（可选，未给出时沿用上一屏）
    { "id": "main", "label": "Dashboard", "icon": "dashboard" },
    { "id": "leads", "label": "Leads", "icon": "users", "badge": 3 }
  ],
  "pages": [{ "id": "leads", "name": "Leads", "layout": [
    { "name": "PageHeader", "id": "head", "grid": { "x": 0, "y": 0, "w": 12, "h": 1 },
      "props": { "title": "Leads", "description": "8 leads" },
      "children": [{ "name": "Button", "id": "new-lead", "props": { "text": "New lead", "icon": "plus" } }] },
    { "name": "Table", "id": "table", "grid": { "x": 0, "y": 1, "w": 12, "h": 6 },
      "props": { "columns": ["Name", "Stage"], "rows": [["Ana", { "text": "Won", "variant": "success" }]], "rowAction": true } }
  ]}]
}
```

- **组件** —— 布局（`PageHeader`、`Card`、`Columns`、`Stack`、`Tabs`、`Accordion`、`Divider`）、
  文本（`Heading`、`Paragraph`、`Badge`、`Link`）、表单（`Form`、`Input`、`Textarea`、`Select`、
  `Checkbox`、`RadioGroup`、`Switch`、`SearchField`、可带 `confirm` 确认对话框的 `Button`）、
  数据（`Table`、`List`、`StatCard`、`KeyValue`、`Avatar`、`EmptyState`）、反馈（`Alert`、
  `Progress`、`Spinner`、`Skeleton`）、导航（`Breadcrumbs`、`Pagination`）以及 `Image`。
  图标使用 lucide 风格的名称（`home`、`users`、`settings` 等）或任意 emoji。
- **应用外壳** —— `nav` 在桌面（≥1024px）显示为侧边栏、平板（≥640px）为图标导航栏、手机为
  带「More」菜单的底部标签栏。选择后发送 `ACTION navigate`；智能体已经给出的页面会立即切换。
- **事件** —— `click`、`submit`（按 name 收集的表单值）、`navigate`、`select`（表格行 / 列表项）、
  `search`、`change`（表单外的选择类控件）、`page` 都以 `ACTION …` 消息回传给智能体。
- **响应式布局** —— 断点按内容区宽度计算（侧边栏、分屏都会计入）：桌面保持原网格，平板让
  小卡片并排、宽分栏堆叠，手机单列（KPI 两列，标题 + 操作同行）。
- **流式渲染** —— 生成过程中已完成的卡片立即显示，正在写入的卡片显示占位；同一页面重新渲染
  时按 id 原地更新卡片，而不是清空整屏。

## 设计主题

`[ui]` 分节是一套轻量、Tailwind 风格的主题系统，映射到 HeroUI 的主题变量
（`--accent`、`--success`、`--radius` 等）：

- **`theme`** —— `light` / `dark` 配色，或 `auto`（默认）跟随系统深浅色。
- **`primary`** —— 贯穿全应用的强调色。
- **`style = sharp`** —— 全局直角（无圆角）、边框更实、卡片扁平。
- **`radius`** —— 精确指定圆角像素。
- **`density = compact`** —— 网格间距、内边距更紧凑，控件更小。
- **`success` / `warning` / `danger`** —— 徽章、警告条、涨跌等语义色。

## 本地演示（无需 API Key）

内置的模拟后端 + 模拟 LLM 让你在不配置任何 API Key 的情况下体验完整流程 ——
登录 → 仪表盘 → 线索列表 → 详情 → 新建表单 → 设置 → 退出登录，以及前进/后退和缓存命中：

```bash
npm run mock                   # 模拟 API + 流式 LLM：http://127.0.0.1:8787
npm run dev                    # 启动 domino → 点击「예시로 시작하기」（从示例开始）
```

然后打开 ⚙ 设置并保存：Base URL `http://127.0.0.1:8787/v1`，模型 `mock-model`，
任意 Key。内置的 ExampleCRM 演示会自动登录并渲染实时仪表盘。

模拟服务还在 `http://127.0.0.1:8787/app.domino` 提供自己的定义
（可加 `?theme=dark&density=compact&primary=%23059669` 试主题）。`PORT=…` 修改端口，
`CHUNK_MS=…` 调整流式速度（`0` 表示一次性发送）。在浏览器中使用时，用 `npm run dev:web`
代替 `npm run dev`。

## 开发

```bash
npm install
npm run dev          # Electron 桌面应用（热重载）
npm run dev:web      # 在浏览器中运行同一渲染层（Vite 开发服务器）
npm run mock         # 本地模拟后端 + 流式模拟 LLM（见本地演示）
npm run build        # 构建 Electron 应用（out/）
npm run build:web    # 构建纯 Web 包（dist-web/）
npm run dist         # electron-builder 打包桌面安装包（release/）
npm run typecheck    # TypeScript 严格检查（node + web 两套配置）
npm test             # vitest 单元测试（解析器、会话、智能体、布局、流式渲染）
npm run android:sync # 构建 Web 包并同步到 Android 壳
```

### Android

Web 构建可以直接在 Capacitor 壳中运行：

```bash
npm run android:sync    # build:web + cap sync android
npx cap open android    # 在 Android Studio 中打开，然后在设备/模拟器上运行
```

## 架构

```
src/core/              平台无关核心（Electron、Web、Android 三端共用）
├─ domino/             文件格式类型、解析器、条件 DSL、脚本引擎
├─ spec/               UiSpec JSON 模式（zod 校验）
├─ ui/                 HeroUI 组件注册表（36 个具名组件）、响应式 12 列 CardGrid
│                      与布局引擎、应用导航、主题变量
├─ llm/                提供商适配器（3 种 API → 统一的归一化流）
├─ agent/              智能体循环、部分 JSON 抢救式渐进渲染、
│                      API 白名单强制执行
└─ session/            前进/后退历史、会话渲染缓存、偏好/token 存储

src/renderer/          React 应用壳（欢迎 / 设置 / 运行时三个界面）
src/shell-electron/    Electron 主进程 + preload（domino:// 协议、IPC、safeStorage）
android/               Capacitor Android 壳
samples/               示例 .domino 定义 + 模拟 E2E 服务
```

关键设计决策：

- **核心是纯 Web** —— 桌面端和 Android 只是同一套代码之上的薄壳，每个功能天然全平台可用。
- **规格先校验，绝不信任** —— LLM 输出经过 zod 模式校验；未知组件渲染为可见占位符，
  而不会崩溃。
- **渐进渲染** —— 单遍解析流式工具调用参数中的部分 JSON，模型还在生成时界面就已开始成形；
  预览经过节流、以 React transition 运行，且只挂载已完整的卡片。
- **一份规格，适配所有设备** —— 模型只为桌面网格设计，平板和手机布局由运行时推导，
  而不是让模型生成三套布局。
- **安全** —— API Key 永不离开本机（BYOK）；`call_api` 被硬性限制在定义的白名单内；
  发给 LLM 的内容会脱敏（redact）。

## 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 并创建特性分支。
2. 运行 `npm run typecheck && npm test` —— 两者必须通过。
3. 保持核心平台无关；平台相关代码放在各壳工程中。
4. 提交信息请清晰描述改动内容。

## 许可证

MIT —— 详见 [LICENSE](LICENSE)。
