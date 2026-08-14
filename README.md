# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面客户端，基于 [Tauri](https://tauri.app) 构建。

## ✨ 功能

- 🖥️ **原生桌面体验** — Tauri v2 + WebView2，轻量原生窗口
- 🔌 **完全离线运行** — 内置 Node 24 运行时和完整 dsh 运行时，无需预装 Node 或任何依赖
- 📌 **系统托盘** — 关闭窗口时可选择最小化到系统托盘（后台运行）或直接退出
- 🤖 **DeepSeek AI 驱动** — 内置 DeepSeek Harness 全部能力（Agent、工具、会话管理）
- 🐳 **DeepSeek 品牌设计** — 鲸鱼 Logo

## 📥 下载安装

### 方式一：直接下载安装包（推荐）

1. 前往 [Releases 页面](https://github.com/flyrae/dsh-desktop/releases)
2. 下载最新版的 `DeepSeek-Harness_x.x.x_x64-setup.exe`
3. 双击运行安装

### 系统要求

| 要求 | 说明 |
|------|------|
| 操作系统 | Windows 10 / 11 (x64) |
| WebView2 | Win10/11 自带，安装包会自动引导安装 |
| 磁盘空间 | ~500MB（安装包 170MB + 运行时解压） |
| 网络 | 仅首次启动需要联网激活，之后可离线使用 |

## 🚀 使用

1. 安装完成后从开始菜单或桌面快捷方式启动
2. 首次启动会自动解压运行时（约 10-15 秒），之后启动秒开
3. 在设置中填入你的 DeepSeek API Key 即可开始对话

### 系统托盘

- **关闭窗口** → 弹出选择：点"是"最小化到托盘，点"否"完全退出
- **左键点击托盘图标** → 恢复窗口
- **右键托盘图标** → 菜单：显示窗口 / 退出

## 🔨 从源码构建

```sh
git clone https://github.com/flyrae/dsh-desktop.git
cd dsh-desktop

# 1. 安装依赖
pnpm install

# 2. 下载 Node 24 二进制（构建安装包需要）
pnpm run desktop:fetch-node

# 3. 打包 dsh 运行时
pnpm run build
pnpm run desktop:build-runtime

# 4. 构建 NSIS 安装包
cd apps/desktop/src-tauri
cargo tauri build
```

安装包输出在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。

## 📁 项目结构

```
apps/desktop/
├── src-tauri/          Tauri Rust 工程
│   ├── src/
│   │   ├── main.rs     入口：托盘、窗口、IPC
│   │   └── spawn.rs    Node 子进程管理
│   ├── tauri.conf.json Tauri 配置
│   └── icons/          应用图标
├── desktop-runtime/    闭包清单（定义打包哪些 dsh 包）
└── package.json
scripts/
├── fetch-node-for-desktop.ts    下载 Node 二进制
└── build-desktop-runtime.ts     打包运行时闭包
```

## 📄 License

MIT
