import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3131;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/test-server';
const USER_COOKIE = 'x-user-id';
console.log('MONGODB_URI', MONGODB_URI)
// 连接数据库
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB 已连接'))
  .catch((err) => {
    console.error('❌ MongoDB 连接失败', err);
    process.exit(1);
  });

// 数据模型
const endpointSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  path: { type: String, required: true },
  method: { type: String, required: true },
  response: { type: String, default: '{"message": "Hello World"}' },
  statusCode: { type: Number, default: 200 },
  contentType: { type: String, default: 'application/json' },
  sseDurationSeconds: { type: Number, default: 0 },
  isWebSocket: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
endpointSchema.index({ path: 1, method: 1 }, { unique: true });
endpointSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
endpointSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_, ret) => {
    delete ret._id;
  }
});
const Endpoint = mongoose.model('Endpoint', endpointSchema);

// 中间件
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.set('trust proxy', true); // 让 req.ip 使用代理后的真实IP
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text());
app.use(bodyParser.raw());

// 用户识别中间件
function ensureUser(req, res, next) {
  let userId = req.cookies[USER_COOKIE];
  if (!userId) {
    userId = uuidv4();
    res.cookie(USER_COOKIE, userId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
  }
  req.userId = userId;
  next();
}
app.use(ensureUser);

// 存储请求日志（内存，仅当前进程）
const requestLogs = [];
const MAX_LOGS = 500;

function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) {
    const parts = Array.isArray(xfwd) ? xfwd : String(xfwd).split(',');
    if (parts.length > 0) return parts[0].trim();
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return req.ip || req.socket.remoteAddress;
}

function getClientIpFromWs(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) {
    const parts = Array.isArray(xfwd) ? xfwd : String(xfwd).split(',');
    if (parts.length > 0) return parts[0].trim();
  }
  if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
  return req.socket.remoteAddress;
}

// 存储WebSocket连接（分用户推送日志）
const logClients = new Map(); // userId -> Set<ws>
// 存储测试WebSocket连接
const testWsConnections = new Map(); // endpointId -> Map<connectionId, ws>

// 统一将路径规范化为以 /test/ 开头
function normalizeTestPath(rawPath) {
  if (rawPath === undefined || rawPath === null) return null;
  const cleaned = String(rawPath).trim().replace(/^\/+/, '');
  const withoutPrefix = cleaned.startsWith('test/') ? cleaned.slice('test/'.length) : cleaned;
  const suffix = withoutPrefix.replace(/^\/+/, '');
  // 允许为空后缀时返回 /test/，否则拼接
  return `/test/${suffix || ''}`.replace(/\/{2,}/g, '/');
}

function normalizeWsPath(rawPath) {
  if (rawPath === undefined || rawPath === null) return null;
  const cleaned = String(rawPath).trim().replace(/^\/+/, '');
  const withoutPrefix = cleaned.startsWith('testws/') ? cleaned.slice('testws/'.length) : cleaned;
  const suffix = withoutPrefix.replace(/^\/+/, '');
  return `/testws/${suffix || ''}`.replace(/\/{2,}/g, '/');
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, pair) => {
    const [k, v] = pair.trim().split('=');
    if (k && v !== undefined) acc[k] = decodeURIComponent(v);
    return acc;
  }, {});
}

function isEventStreamContentType(contentType) {
  if (!contentType) return false;
  const mediaType = String(contentType).split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'text/event-stream';
}

function normalizeSseDurationSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function buildSseEventsFromResponse(raw) {
  const text = raw === undefined || raw === null ? '' : String(raw);
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) lines.push('');

  const events = [];
  for (let i = 0; i < lines.length; i += 2) {
    const line1 = lines[i] ?? '';
    const line2 = lines[i + 1] ?? '';
    events.push(`data: ${line1}\ndata: ${line2}\n\n`);
  }
  return events.length > 0 ? events : ['data: \ndata: \n\n'];
}

function streamSseEvents(req, res, events, durationSeconds) {
  const totalMs = normalizeSseDurationSeconds(durationSeconds) * 1000;
  const startTime = Date.now();
  const denom = Math.max(1, events.length - 1);

  let index = 0;
  let timer = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const writeNext = () => {
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    if (index >= events.length) {
      cleanup();
      res.end();
      return;
    }

    res.write(events[index]);
    index += 1;

    if (index >= events.length) {
      cleanup();
      res.end();
      return;
    }

    const nextTarget = startTime + Math.round((index * totalMs) / denom);
    const delay = Math.max(0, nextTarget - Date.now());
    timer = setTimeout(writeNext, delay);
  };

  req.on('close', cleanup);
  writeNext();
}

// WebSocket连接处理
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type');
  const cookies = parseCookies(req.headers.cookie || '');
  const clientUserId = cookies[USER_COOKIE] || 'guest';
  
  if (type === 'logs') {
    // 日志订阅连接（按用户）
    if (!logClients.has(clientUserId)) {
      logClients.set(clientUserId, new Set());
    }
    logClients.get(clientUserId).add(ws);
    ws.on('close', () => {
      logClients.get(clientUserId)?.delete(ws);
    });
  } else {
    // 业务 WebSocket 连接，使用路径匹配
    const pathname = url.pathname;
    const connectionId = uuidv4();

    try {
      const endpoint = await Endpoint.findOne({ path: pathname, isWebSocket: true });
      if (!endpoint) {
        ws.close(4004, '未找到对应的 WebSocket 接口');
        return;
      }

      const endpointId = endpoint._id.toString();
      if (!testWsConnections.has(endpointId)) {
        testWsConnections.set(endpointId, new Map());
      }
      testWsConnections.get(endpointId).set(connectionId, ws);
      
      // 发送连接成功消息
      ws.send(JSON.stringify({
        type: 'connected',
        connectionId,
        message: '连接成功'
      }));
      
      // 记录连接日志
      addLog({
        type: 'websocket',
        action: 'connect',
        endpointId,
        connectionId,
        userId: endpoint.userId, // 日志归属接口创建者，保证他能看到
        clientUserId,
        ip: getClientIpFromWs(req),
        headers: req.headers,
        timestamp: new Date().toISOString()
      });
      
      ws.on('message', (data) => {
        const messageStr = data.toString();
        // 记录消息日志
        addLog({
          type: 'websocket',
          action: 'message',
          endpointId,
          connectionId,
          userId: endpoint.userId,
          clientUserId,
          ip: getClientIpFromWs(req),
          message: messageStr,
          timestamp: new Date().toISOString()
        });
      });
      
      ws.on('close', () => {
        testWsConnections.get(endpointId)?.delete(connectionId);
        addLog({
          type: 'websocket',
          action: 'disconnect',
          endpointId,
          connectionId,
          userId: endpoint.userId,
          clientUserId,
          timestamp: new Date().toISOString()
        });
      });
    } catch (err) {
      ws.close(1011, '内部错误');
    }
  }
});

// 添加日志
function addLog(log) {
  requestLogs.unshift(log);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.pop();
  }
  broadcastLog(log);
}

// 广播日志到所有订阅者
function broadcastLog(log) {
  const message = JSON.stringify({ type: 'log', data: log });
  const targets = log.userId ? logClients.get(log.userId) : null;
  if (targets) {
    targets.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

// API路由 - 获取当前用户的所有接口
app.get('/api/endpoints', async (req, res) => {
  const endpoints = await Endpoint.find({ userId: req.userId }).sort({ createdAt: -1 });
  res.json(endpoints);
});

// API路由 - 获取当前用户信息
app.get('/api/me', (req, res) => {
  res.json({
    userId: req.userId,
    defaultPath: `/test/${req.userId}/hello`
  });
});

// API路由 - 创建新接口
app.post('/api/endpoints', async (req, res) => {
  const { path: endpointPath, method, response, statusCode, contentType, sseDurationSeconds, isWebSocket } = req.body;
  
  const normalizedPath = isWebSocket ? normalizeWsPath(endpointPath) : normalizeTestPath(endpointPath);
  
  if (!normalizedPath || !(isWebSocket ? normalizedPath.startsWith('/testws/') : normalizedPath.startsWith('/test/'))) {
    return res.status(400).json({ error: isWebSocket ? '路径必须以/testws/开头' : '路径必须以/test/开头' });
  }

  // 检查重复（全局唯一，避免匹配冲突）
  const exists = await Endpoint.findOne({ path: normalizedPath, method: method || 'GET' });
  if (exists) {
    return res.status(409).json({ error: '该接口已存在（路径+方法重复）' });
  }
  
  const endpoint = await Endpoint.create({
    userId: req.userId,
    path: normalizedPath,
    method: method || 'GET',
    response: response || '{"message": "Hello World"}',
    statusCode: statusCode || 200,
    contentType: contentType || 'application/json',
    sseDurationSeconds: isEventStreamContentType(contentType) ? normalizeSseDurationSeconds(sseDurationSeconds) : 0,
    isWebSocket: isWebSocket || false
  });
  
  res.json(endpoint);
});

// API路由 - 更新接口
app.put('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params;
  const endpoint = await Endpoint.findOne({ _id: id, userId: req.userId });
  
  if (!endpoint) {
    return res.status(404).json({ error: '接口不存在' });
  }
  
  let nextPath = endpoint.path;
  if (req.body.path !== undefined) {
    const normalizedPath = (req.body.isWebSocket ?? endpoint.isWebSocket)
      ? normalizeWsPath(req.body.path)
      : normalizeTestPath(req.body.path);
    if (!normalizedPath || ((req.body.isWebSocket ?? endpoint.isWebSocket)
      ? !normalizedPath.startsWith('/testws/')
      : !normalizedPath.startsWith('/test/'))) {
      return res.status(400).json({ error: (req.body.isWebSocket ?? endpoint.isWebSocket) ? '路径必须以/testws/开头' : '路径必须以/test/开头' });
    }
    nextPath = normalizedPath;

    const exists = await Endpoint.findOne({ path: nextPath, method: req.body.method || endpoint.method, _id: { $ne: id } });
    if (exists) {
      return res.status(409).json({ error: '该接口已存在（路径+方法重复）' });
    }
  }

  endpoint.path = nextPath;
  endpoint.method = req.body.method || endpoint.method;
  endpoint.response = req.body.response ?? endpoint.response;
  endpoint.statusCode = req.body.statusCode ?? endpoint.statusCode;
  endpoint.contentType = req.body.contentType ?? endpoint.contentType;
  endpoint.isWebSocket = req.body.isWebSocket ?? endpoint.isWebSocket;
  endpoint.sseDurationSeconds = isEventStreamContentType(endpoint.contentType)
    ? normalizeSseDurationSeconds(req.body.sseDurationSeconds ?? endpoint.sseDurationSeconds)
    : 0;
  await endpoint.save();

  res.json(endpoint);
});

// API路由 - 删除接口
app.delete('/api/endpoints/:id', async (req, res) => {
  const { id } = req.params;
  const deleted = await Endpoint.deleteOne({ _id: id, userId: req.userId });
  if (deleted.deletedCount === 0) {
    return res.status(404).json({ error: '接口不存在' });
  }
  res.json({ success: true });
});

// API路由 - 获取当前用户日志
app.get('/api/logs', (req, res) => {
  const filtered = requestLogs.filter(log => log.userId === req.userId);
  res.json(filtered);
});

// API路由 - 清空当前用户日志
app.delete('/api/logs', (req, res) => {
  for (let i = requestLogs.length - 1; i >= 0; i--) {
    if (requestLogs[i].userId === req.userId) {
      requestLogs.splice(i, 1);
    }
  }
  res.json({ success: true });
});

// API路由 - 向WebSocket连接发送消息
app.post('/api/ws/send', async (req, res) => {
  const { endpointId, connectionId, message } = req.body;

  const endpoint = await Endpoint.findOne({ _id: endpointId, userId: req.userId });
  if (!endpoint) {
    return res.status(404).json({ error: '没有找到该接口或无权限' });
  }
  
  const connections = testWsConnections.get(endpointId);
  if (!connections) {
    return res.status(404).json({ error: '没有找到该接口的连接' });
  }
  
  if (connectionId) {
    const ws = connections.get(connectionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
      res.json({ success: true, sent: 1 });
    } else {
      res.status(404).json({ error: '连接不存在或已关闭' });
    }
  } else {
    // 广播给所有连接
    let sent = 0;
    connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
        sent++;
      }
    });
    res.json({ success: true, sent });
  }
});

// API路由 - 获取WebSocket连接列表
app.get('/api/ws/connections/:endpointId', async (req, res) => {
  const { endpointId } = req.params;
  const endpoint = await Endpoint.findOne({ _id: endpointId, userId: req.userId });
  if (!endpoint) {
    return res.status(404).json({ error: '接口不存在或无权限' });
  }

  const connections = testWsConnections.get(endpointId);
  if (!connections) {
    return res.json([]);
  }
  
  const list = [];
  connections.forEach((ws, id) => {
    list.push({
      id,
      readyState: ws.readyState
    });
  });
  res.json(list);
});

// 动态接口处理中间件
app.use('/test/*', async (req, res) => {
  // 跳过预检请求，避免产生重复日志
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  const requestPath = '/test/' + req.params[0];
  
  // 查找匹配的接口（全局唯一，已限制去重）
  const matchedEndpoint = await Endpoint.findOne({ path: requestPath, method: req.method });
  
  if (!matchedEndpoint) {
    // 记录未匹配的请求日志，归属于当前访问用户
    addLog({
      userId: req.userId,
      type: 'http',
      matched: false,
      method: req.method,
      path: requestPath,
      ip: getClientIp(req),
      headers: req.headers,
      query: req.query,
      body: req.body,
      timestamp: new Date().toISOString()
    });
    return res.status(404).json({ error: '接口不存在', path: requestPath });
  }
  
  // 记录请求日志，归属为接口所有者
  addLog({
    userId: matchedEndpoint.userId,
    type: 'http',
    matched: true,
    endpointId: matchedEndpoint.id,
    method: req.method,
    path: requestPath,
    ip: getClientIp(req),
    headers: req.headers,
    query: req.query,
    body: req.body,
    timestamp: new Date().toISOString()
  });
  
  // 如果端点标记为 WebSocket，提示使用 ws
  if (matchedEndpoint.isWebSocket) {
    return res.status(400).json({ error: '该端点为 WebSocket，请通过 WS 连接', path: requestPath });
  }

  // 返回自定义响应
  res.status(matchedEndpoint.statusCode);
  res.set('Content-Type', matchedEndpoint.contentType);

  if (isEventStreamContentType(matchedEndpoint.contentType)) {
    res.set({
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();

    const events = buildSseEventsFromResponse(matchedEndpoint.response);
    streamSseEvents(req, res, events, matchedEndpoint.sseDurationSeconds);
    return;
  }
  
  try {
    if (matchedEndpoint.contentType === 'application/json') {
      res.send(matchedEndpoint.response);
    } else {
      res.send(matchedEndpoint.response);
    }
  } catch (e) {
    res.send(matchedEndpoint.response);
  }
});

// 静态文件服务 (生产环境)
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`🚀 Test Server 运行在 http://localhost:${PORT}`);
  console.log(`📡 WebSocket 服务运行在 ws://localhost:${PORT}/ws`);
});
