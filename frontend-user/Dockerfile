FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
# 先拷贝依赖清单做一层缓存；npm ci 按 lockfile 干净安装，保证镜像内依赖可复现
COPY package.json package-lock.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY . .
# 走统一发布流水线：docker 环境默认执行「类型检查 + 打包校验」（安装依赖已在上一层完成）
RUN BUILD_PIPELINE_ENV=docker npm run pipeline

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
