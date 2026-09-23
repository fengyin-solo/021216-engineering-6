# PDF Viewer

基于 Vue 3 + Vite + PDF.js 构建的高精度 PDF 阅读器。

核心特性：
- PDF.js TextLayer 实现文字位置与原始 PDF 像素级对齐
- 选中 PDF 文字如同选中 HTML 文字一样自然准确
- 高 DPI 屏幕（Retina）清晰渲染
- 缩放、适合宽度、页码导航
- 文件选择和拖拽上传
- 滚动懒加载 + LRU 页面回收，大文件（200+ 页）不卡顿
- CMap 和标准字体支持，确保中文等复杂字体正确渲染

## 项目目录结构

```
├── docker-compose.yml          # Docker 编排配置
├── docs/
│   └── project_design.md       # 项目设计文档
├── frontend-user/              # Vue 3 前端项目
│   ├── Dockerfile              # 前端 Docker 构建文件
│   ├── nginx.conf              # Nginx 部署配置
│   ├── package.json            # 前端依赖与脚本
│   ├── vite.config.ts          # Vite 构建配置
│   ├── tsconfig.json           # TypeScript 配置
│   ├── index.html              # 入口 HTML
│   ├── public/                 # 静态资源
│   │   ├── pdfjs/              # PDF.js 库文件（含 cmaps、标准字体）
│   │   ├── sample.pdf          # 示例 PDF — 学术论文
│   │   ├── test.pdf            # 示例 PDF — 200 页压测
│   │   └── document.pdf        # 示例 PDF — 图文混排
│   └── src/
│       ├── App.vue             # 根组件
│       ├── main.ts             # 应用入口
│       ├── components/
│       │   └── PdfViewer.vue   # PDF 阅读器核心组件
│       ├── styles/
│       │   └── global.scss     # 全局样式
│       └── utils/
│           └── pdf-engine.ts   # PDF.js 引擎封装
└── README.md                   # 项目说明
```

## 快速启动

### 方式一：Docker（推荐）

```bash
docker-compose up --build -d
```

访问 http://localhost:8081

### 方式二：本地开发

```bash
cd frontend-user
npm install
npm run dev
```

访问 http://localhost:8081

## 上线前检查（依赖安装 → 类型检查 → 打包校验）

本地改完代码后，执行一条命令把三个环节串成流水线，避免类型报错、样式编译失败到最后一刻才发现：

```bash
cd frontend-user
npm run release
```

- 在交互终端中会打开**设置面板**，三个环节的开关集中在一栏里，可逐项开关：
  - `1. 安装依赖` — `npm install`，同步依赖
  - `2. 类型检查` — `vue-tsc --noEmit`，拦截 TS / `.vue` 类型错误
  - `3. 打包校验` — `vite build`（含 SCSS 编译），成功后原子替换 `dist/`
- 开关**按当前环境自动给默认值**，并**自动记住上次的选择**（保存在本地
  `frontend-user/.release-pipeline.json`，已 gitignore，不影响他人）：
  - 本地（local）：三步默认全开
  - Docker 构建（`RELEASE_ENV=docker`）：已在镜像分层中装好依赖，默认跳过安装
  - CI：默认跳过安装（依赖由流水线预置）
- 按 `e` 可在面板中临时切换环境查看/调整对应开关；`↑↓` 移动、空格/数字键切换、`r` 执行。
- 任何一步不通过都会指出**卡在第几步和原因**，完整输出同时落盘到
  `node_modules/.release-pipeline/logs/`；打包失败会删除半成品临时目录、保留上次成功的
  `dist/`，修复后重跑 `npm run release` 即可，不残留失败中间产物。

常用参数：

```bash
npm run release -- --settings      # 强制打开设置面板（即使之前选了“不再显示”）
npm run release -- -y              # 非交互执行（Docker 构建使用，按默认/记忆的开关跑）
npm run release -- --env docker    # 临时指定环境：local | docker | ci
npm run release -- --no-install    # 本次跳过某环节（不修改记忆）
npm run release -- --typecheck-only
npm run release -- --force-install # 删除 node_modules 后重装
```

原有的 `npm run dev` 本地启动与 `docker-compose up --build -d` 部署方式保持不变；
Docker 镜像构建内部已改为走同一条流水线（类型检查不通过则镜像构建失败）。

## PDF 示例文件

将 PDF 文件放入 `frontend-user/public/` 目录，然后在页面中点击对应按钮加载：

| 文件 | 页数 | 内容说明 |
|------|------|----------|
| `sample.pdf` | 14 页 | Mozilla TracemonKey 学术论文，双栏布局、图表、公式、参考文献 |
| `test.pdf` | ~200 页 | 大文件压力测试，密集英文段落 + 数据行 |
| `document.pdf` | ~50 页 | 图文混排测试，色块、圆形、提示框、正文 |

也可在页面中选择本地 PDF 文件，或直接拖拽 PDF 文件到页面。

## 技术方案

PDF.js 三层渲染架构：
- Canvas Layer — 视觉渲染
- Text Layer — 透明文字选择层，像素级对齐
- Annotation Layer — 链接交互

性能优化：
- LRU 页面回收（最多 15 个已渲染页面）
- 逐页尺寸预计算，支持混合页面大小
- 渲染版本控制，缩放时取消过期任务
- rAF 滚动节流 + CSS GPU 加速

## 测试要点

1. 文字选择精度 — 选区与 Canvas 渲染文字位置精确对齐
2. 文字复制 — Ctrl+C 复制后粘贴内容正确
3. 大文件滚动 — 200 页快速滚动不卡顿，页码实时更新
4. 内存管理 — DOM 节点数稳定，离屏页面被回收
5. 缩放功能 — 缩放后文字选择仍然精确
6. 多字号渲染 — 8pt~28pt 各字号选择精度
7. 图文混排 — 图形区域不干扰文字选择
8. 文件加载 — 示例按钮、手动选择、拖拽上传

## 服务

| 服务 | 端口 | 说明 |
|------|------|------|
| frontend-user | 8081 | PDF Viewer 前端 |
