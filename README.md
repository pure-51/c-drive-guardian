# C-Drive Guardian (C 盘卫士)

实时监控 C 盘空间变化的 Windows 桌面工具。检测到空间变化时自动弹窗通知，识别可清理文件，一键清理。

## 功能

- 🛡️ **实时监控** — 每 30 秒检测 C 盘剩余空间
- 🔍 **精准定位** — 自动扫描变化文件，分类识别
- 🗂️ **智能分类** — 临时文件/缓存/日志 → 可安全删除；下载文件 → 建议移动；系统文件 → 跳过
- ⚠️ **风险分析** — 检测文件是否被占用，避免误删
- 💬 **气泡通知** — 变化达到阈值时自动弹窗，支持一键清理
- 🖥️ **系统托盘** — 后台运行，右键菜单管理
- 🔄 **开机自启** — 可选开机自动启动
- 📅 **跨会话检测** — 关机后再次打开，能识别离线期间的变化

## 下载

从 [Releases](https://github.com/你的用户名/c-drive-guardian/releases) 下载最新安装包。

## 从源码运行

```bash
git clone https://github.com/你的用户名/c-drive-guardian.git
cd c-drive-guardian
npm install
npm start
```

## 构建安装包

```bash
npm run build
```

安装包在 `dist/` 目录下。

> **国内用户注意：** electron-builder 构建时会下载 Electron，建议设置镜像加速：
> ```bash
> npm config set electron_mirror https://npmmirror.com/mirrors/electron/
> ```
> 或在构建前设置 `ELECTRON_MIRROR` 环境变量：
> ```bash
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> npm run build
> ```

## 技术栈

- **Electron 41** — 桌面框架
- **Node.js** — 运行时
- **PowerShell** — 磁盘查询和文件扫描
- **electron-builder** — 构建打包

## 许可证

AGPL-3.0
