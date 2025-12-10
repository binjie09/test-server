# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 安装所有依赖（包括devDependencies用于构建）
RUN npm install

# 复制源代码
COPY . .

# 构建前端
RUN npm run build

# 生产阶段
FROM node:20-alpine AS production

WORKDIR /app

# 复制依赖文件
COPY package*.json ./

# 只安装生产依赖
RUN npm install --omit=dev

# 从构建阶段复制构建产物
COPY --from=builder /app/dist ./dist

# 复制服务器代码
COPY server.js ./

# 暴露端口
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/api/endpoints || exit 1

# 启动服务器
CMD ["node", "server.js"]


