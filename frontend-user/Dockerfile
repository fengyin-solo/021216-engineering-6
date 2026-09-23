FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --registry=https://registry.npmmirror.com
COPY . .
# 走上线流水线：RELEASE_ENV=docker 声明镜像构建环境，
# 默认跳过依赖安装（上一步已装），依次执行类型检查与打包校验；任一不通过则镜像构建失败。
RUN RELEASE_ENV=docker npm run release -- -y

FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
