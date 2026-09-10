# pi-thinking-header

dsh 风格的 pi thinking 显示插件：带 token 计数的单行标题 + 折叠时单行内容预览（参考 dsh `ReasoningRow` 的滚动跟随）。

```
展开时：                                        折叠时（ctrl+t / 点击标题行）：
  Thinking (~2.50k tokens)                        流式中：Thinking (~2.50k tokens) · …尾随最新内容保持可见
  模型思考全文…                                   结束后：Thinking (~2.50k tokens) · 第一行内容…
  正式回复…                                       正式回复…
```

- token 数量为本地估算：`ceil(chars / 4)`，流式输出时实时增长
- 小数点位数可配置（默认 2 位）：`/thinking-header decimals <0-6>`，或直接编辑
  配置文件 `~/.pi/agent/thinking-header.json`（`{"decimals": 2}`）。例如默认效果
  `2.50k`；`decimals: 0` → `3k`；`decimals: 4` → `2.5000k`。两种模式均实时读取
  该文件（mtime 缓存），修改后无需重启 pi
- 折叠预览与 dsh `ReasoningRow` 对齐：**流式期间**显示最新一行的**行尾**（前导省略号，
  相当于 `scrollLeft = scrollWidth - clientWidth`），多行内容在单行内持续滚动跟随；
  **结束后**回到第一行开头（尾部省略号，相当于 `scrollLeft = 0`）
- 截断按终端宽度计算（CJK 全角字符按 2 列计宽），保证严格单行
- 点击标题行或 `Ctrl+T` 切换展开/折叠

## 安装

```bash
# 从 npm 安装（写入 ~/.pi/agent/settings.json）
pi install npm:pi-thinking-header
```

本地开发调试：

```bash
git clone https://github.com/focksor/pi-thinking-header
pi install ./pi-thinking-header
```

## 会话内命令：`/thinking-header`

所有功能的统一入口：

```
/thinking-header                  # 状态总览（模式/补丁状态/decimals）+ 用法
/thinking-header patch           # 应用/修复完整模式补丁（确认后执行）
/thinking-header decimals        # 查看当前小数位
/thinking-header decimals <0-6>  # 设置小数位并持久化（默认 2）
```

补丁安装（`patch` 子命令，内部运行 `node install-patch.mjs`）：

- 已打补丁 → 提示 already applied（含当前 decimals）
- 未打补丁（或补丁版本较旧）→ 确认后执行安装/迁移，输出结果并提醒重启 pi（当前会话仍是旧代码，重启后生效）
- `pi update` 之后补丁丢失时，extension 自动进入降级模式，此时用该命令可一键修复

小数位配置（`decimals` 子命令）：

- 有效范围 0–6 的整数，其它输入会报错且不修改配置
- 写入 `~/.pi/agent/thinking-header.json`（也可直接编辑该文件）；降级模式立即生效，
  完整模式下 patch 在每次渲染时读取该文件（mtime 缓存），同样无需重启
- 尊重 `PI_CODING_AGENT_DIR` 环境变量（支持 `~/...` 形式）

## 两种模式（自动检测）

### 完整模式（推荐）：bundle patch

pi 的 extension API 无法接管内置 thinking 块的折叠渲染，完整效果需要附带
的 bundle patch。推荐直接在 pi 会话内运行 `/thinking-header patch`
（自动定位安装位置）；也可手动执行：

```bash
# npm 安装：~/.pi/agent/npm/pi-thinking-header/install-patch.mjs
# 本地安装：<仓库路径>/install-patch.mjs
node <包目录>/install-patch.mjs
```

- 每条消息独立的 token 计数与预览（含历史消息）
- 折叠态严格单行、宽度感知截断、点击切换
- 流式期间折叠预览滚动跟随最新行行尾（dsh 同款），结束后回到第一行
- 小数点位数渲染时实时读取配置文件（mtime 缓存），与降级模式共享同一份配置
- 幂等；自动从 v1/v2/v3/v3.1 patch 迁移（恢复原始备份后重新应用；早期 v3
  折叠组件缺 `invalidate()`、退出/切换模式时触发 `this.child.invalidate is not
  a function` 崩溃且无备份时，会先原地热修复）；`pi update` 后重跑一次即可；
  插件包更新后也建议重跑 `/thinking-header patch` 使 patch 与 extension 版本一致
- 回滚：
  ```bash
  cp <chunk路径>.pre-thinking-header.bak <chunk路径>
  # 路径见 install-patch.mjs 的输出
  ```

### 纯插件模式：extension 自动降级

extension 启动时探测运行中的 pi bundle：**检测到任意版本的 patch 时**（含旧版本）
extension 保持惰性（避免双标题），请运行 `/thinking-header patch` 迁移到当前 patch 版本；
**未检测到 patch 时**自动进入降级模式：

- 展开的 thinking：通过 markdown transformer 前置 `Thinking (~N tokens)` 标题行
  （按块正确计数，`pi update` 后依然有效，无需维护）
- 折叠的 thinking：pi 的 extension API 只暴露一个全局 label，插件会在每条
  assistant 消息结束后将其更新为最新消息的 `计数 · 预览`。局限：转录里更早的
  折叠块也会显示最新 label —— 需要按消息独立显示请打 bundle patch
- bundle 已打 patch 时 extension 完全惰性，不会产生双标题

## 文件

| 文件 | 说明 |
|------|------|
| `index.js` | pi extension（模式检测 + 降级实现，含流式行尾跟随 label） |
| `install-patch.mjs` | 完整模式安装器（v3.2 bundle patch，渲染时读取 decimals 配置） |
| `package.json` | pi 包清单（`pi.extensions`） |

## License

MIT © focksor
