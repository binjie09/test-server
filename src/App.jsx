import React, { useState, useEffect, useRef, useCallback } from 'react';

const API_BASE = '';

const buildUserPath = (suffixOrFull, userId) => {
  if (!userId) return '/test/hello';
  const raw = String(suffixOrFull || '').trim();
  // 已经包含完整前缀则直接返回（去重斜杠）
  if (raw.startsWith(`/test/${userId}/`)) {
    return raw.replace(/\/{2,}/g, '/');
  }
  const cleaned = raw.replace(/^\/+/, '');
  return `/test/${userId}/${cleaned || 'hello'}`.replace(/\/{2,}/g, '/');
};

const normalizeTestPath = (raw, userId) => buildUserPath(raw, userId);

const extractUserSuffix = (path, userId) => {
  if (!path || !userId) return '';
  const re = new RegExp(`^/test/${userId}/?`);
  return path.replace(re, '').replace(/^\/+/, '');
};

function App() {
  const [userInfo, setUserInfo] = useState(null);
  const [endpoints, setEndpoints] = useState([]);
  const [logs, setLogs] = useState([]);
  const [expandedLogs, setExpandedLogs] = useState(new Set());
  const [wsConnections, setWsConnections] = useState({});
  const [wsMessages, setWsMessages] = useState({});
  const wsRef = useRef(null);
  
  // 表单状态
  const [formData, setFormData] = useState({
    path: '',
    method: 'GET',
    response: '{"message": "Hello World", "success": true}',
    statusCode: 200,
    contentType: 'application/json',
    isWebSocket: false
  });
  
  // 编辑状态
  const [editingId, setEditingId] = useState(null);

  const authedFetch = useCallback((url, options = {}) => {
    return fetch(url, { credentials: 'include', ...options });
  }, []);

  // 建立WebSocket连接用于接收日志
  useEffect(() => {
    if (!userInfo) return;
    const connectWs = () => {
      const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?type=logs`;
      wsRef.current = new WebSocket(wsUrl);
      
      wsRef.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLogs(prev => [data.data, ...prev].slice(0, 200));
        }
      };
      
      wsRef.current.onclose = () => {
        setTimeout(connectWs, 3000);
      };
    };
    
    connectWs();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [userInfo]);

  // 加载初始数据 & 获取用户身份
  useEffect(() => {
    const init = async () => {
      try {
        const meRes = await authedFetch(`${API_BASE}/api/me`);
        const me = await meRes.json();
        setUserInfo(me);
        setFormData(prev => ({ ...prev, path: me.defaultPath }));
        await Promise.all([fetchEndpoints(), fetchLogs()]);
      } catch (e) {
        console.error('初始化失败', e);
      }
    };
    init();
  }, [authedFetch]);

  const fetchEndpoints = async () => {
    const res = await authedFetch(`${API_BASE}/api/endpoints`);
    const data = await res.json();
    setEndpoints(data);
  };

  const fetchLogs = async () => {
    const res = await authedFetch(`${API_BASE}/api/logs`);
    const data = await res.json();
    setLogs(data);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!userInfo) return;
    
    const url = editingId 
      ? `${API_BASE}/api/endpoints/${editingId}` 
      : `${API_BASE}/api/endpoints`;
    
    const method = editingId ? 'PUT' : 'POST';
    
    const res = await authedFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formData, path: buildUserPath(formData.path, userInfo?.userId) })
    });
    
    if (res.ok) {
      fetchEndpoints();
      resetForm();
    } else if (res.status === 409) {
      alert('该接口已存在（路径+方法重复）');
    }
  };

  const resetForm = () => {
    setFormData({
      path: userInfo ? `/test/${userInfo.userId}/hello` : '',
      method: 'GET',
      response: '{"message": "Hello World", "success": true}',
      statusCode: 200,
      contentType: 'application/json',
      isWebSocket: false
    });
    setEditingId(null);
  };

  const handleEdit = (endpoint) => {
    setFormData({
      path: endpoint.path,
      method: endpoint.method,
      response: endpoint.response,
      statusCode: endpoint.statusCode,
      contentType: endpoint.contentType,
      isWebSocket: endpoint.isWebSocket
    });
    setEditingId(endpoint._id || endpoint.id);
  };

  const handleDelete = async (id) => {
    if (confirm('确定要删除这个接口吗？')) {
      await authedFetch(`${API_BASE}/api/endpoints/${id}`, { method: 'DELETE' });
      fetchEndpoints();
    }
  };

  const clearLogs = async () => {
    await authedFetch(`${API_BASE}/api/logs`, { method: 'DELETE' });
    setLogs([]);
  };

  const toggleLogExpand = (index) => {
    setExpandedLogs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  const formatJson = (str) => {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return str;
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getDisplayIp = (log) => {
    if (log.ip) return log.ip;
    const xfwd = log.headers && (log.headers['x-forwarded-for'] || log.headers['X-Forwarded-For']);
    if (xfwd) {
      if (Array.isArray(xfwd)) return xfwd[0];
      const parts = String(xfwd).split(',');
      if (parts.length > 0) return parts[0].trim();
    }
    const xreal = log.headers && (log.headers['x-real-ip'] || log.headers['X-Real-IP']);
    if (xreal) return Array.isArray(xreal) ? xreal[0] : xreal;
    return '';
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  // WebSocket测试功能
  const [activeWsEndpoint, setActiveWsEndpoint] = useState(null);
  const [wsTestConnection, setWsTestConnection] = useState(null);
  const [wsTestMessages, setWsTestMessages] = useState([]);
  const [wsInputMessage, setWsInputMessage] = useState('');

  const connectToWsEndpoint = (endpoint) => {
    if (wsTestConnection) {
      wsTestConnection.close();
    }
    
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws?type=test&endpoint=${endpoint._id || endpoint.id}`;
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      setWsTestMessages(prev => [...prev, { 
        type: 'system', 
        message: '已连接到服务器',
        time: new Date().toISOString()
      }]);
    };
    
    ws.onmessage = (event) => {
      setWsTestMessages(prev => [...prev, {
        type: 'received',
        message: event.data,
        time: new Date().toISOString()
      }]);
    };
    
    ws.onclose = () => {
      setWsTestMessages(prev => [...prev, {
        type: 'system',
        message: '连接已断开',
        time: new Date().toISOString()
      }]);
      setWsTestConnection(null);
    };
    
    setWsTestConnection(ws);
    setActiveWsEndpoint(endpoint);
  };

  const disconnectWsEndpoint = () => {
    if (wsTestConnection) {
      wsTestConnection.close();
    }
    setWsTestConnection(null);
    setActiveWsEndpoint(null);
  };

  const sendWsMessage = () => {
    if (wsTestConnection && wsInputMessage) {
      wsTestConnection.send(wsInputMessage);
      setWsTestMessages(prev => [...prev, {
        type: 'sent',
        message: wsInputMessage,
        time: new Date().toISOString()
      }]);
      setWsInputMessage('');
    }
  };

  const pathSuffix = extractUserSuffix(formData.path, userInfo?.userId);

  return (
    <div className="app">
      <header className="header">
        <div className="header-title">
          <div className="header-logo">🚀</div>
          <h1>Test Server</h1>
        </div>
        <div className="header-stats">
          <div className="stat">
            <span className="stat-value">{endpoints.length}</span>
            <span className="stat-label">接口数量</span>
          </div>
          <div className="stat">
            <span className="stat-value">{logs.length}</span>
            <span className="stat-label">请求日志</span>
          </div>
          <div className="stat">
            <div className="live-indicator">
              <span className="live-dot"></span>
              <span>实时监听中</span>
            </div>
          </div>
        </div>
      </header>

      <main className="main">
        {/* 左侧面板 - 接口管理 */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <div className="panel-title-icon" style={{ background: 'linear-gradient(135deg, #39c5cf, #58a6ff)' }}>📡</div>
              接口管理
            </div>
          </div>
          <div className="panel-content">
            {/* 创建表单 */}
            <form className="form" onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label">接口路径（固定前缀 /test/{userInfo?.userId || '...'}/）</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div style={{ 
                    padding: '10px 12px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-primary)',
                    borderRadius: '8px',
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--text-secondary)'
                  }}>
                    {`/test/${userInfo?.userId || '...'}/`}
                  </div>
                  <input
                    type="text"
                    className="form-input mono"
                    value={pathSuffix}
                    onChange={(e) => setFormData({ ...formData, path: buildUserPath(e.target.value, userInfo?.userId) })}
                    placeholder="hello"
                    disabled={!userInfo}
                  />
                </div>
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">请求方法</label>
                  <select
                    className="form-select"
                    value={formData.method}
                    onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                    disabled={formData.isWebSocket}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </div>
                
                <div className="form-group">
                  <label className="form-label">状态码</label>
                  <input
                    type="number"
                    className="form-input"
                    value={formData.statusCode}
                    onChange={(e) => setFormData({ ...formData, statusCode: parseInt(e.target.value) })}
                    disabled={formData.isWebSocket}
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Content-Type</label>
                <select
                  className="form-select"
                  value={formData.contentType}
                  onChange={(e) => setFormData({ ...formData, contentType: e.target.value })}
                  disabled={formData.isWebSocket}
                >
                  <option value="application/json">application/json</option>
                  <option value="text/plain">text/plain</option>
                  <option value="text/html">text/html</option>
                  <option value="application/xml">application/xml</option>
                </select>
              </div>
              
              <div className="form-group">
                <label className="form-label">响应内容</label>
                <textarea
                  className="form-textarea"
                  value={formData.response}
                  onChange={(e) => setFormData({ ...formData, response: e.target.value })}
                  placeholder='{"message": "Hello World"}'
                  disabled={formData.isWebSocket}
                />
              </div>

              <div className="form-group">
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={formData.isWebSocket}
                    onChange={(e) => setFormData({ ...formData, isWebSocket: e.target.checked })}
                  />
                  <span>WebSocket 模式</span>
                </label>
              </div>
              
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={!userInfo}>
                  {editingId ? '💾 更新接口' : '✨ 创建接口'}
                </button>
                {editingId && (
                  <button type="button" className="btn btn-secondary" onClick={resetForm}>
                    取消
                  </button>
                )}
              </div>
            </form>

            {/* 接口列表 */}
            <div style={{ marginTop: '24px' }}>
              <h3 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px', color: 'var(--text-secondary)' }}>
                已创建的接口
              </h3>
              
              {endpoints.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon">📭</div>
                  <div className="empty-text">还没有创建任何接口</div>
                </div>
              ) : (
                <div className="endpoint-list">
                  {endpoints.map((endpoint) => {
                    const eid = endpoint._id || endpoint.id;
                    return (
                    <div key={eid} className="endpoint-item">
                      <div className="endpoint-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
                          <span className={`endpoint-method method-${endpoint.isWebSocket ? 'WS' : endpoint.method}`}>
                            {endpoint.isWebSocket ? 'WS' : endpoint.method}
                          </span>
                          <span className="endpoint-path">{endpoint.path}</span>
                        </div>
                        <div className="endpoint-actions">
                          <button 
                            className="btn btn-secondary btn-sm"
                            onClick={() => copyToClipboard(`${window.location.origin}${endpoint.path}`)}
                            title="复制URL"
                          >
                            📋
                          </button>
                          <button 
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleEdit(endpoint)}
                          >
                            ✏️
                          </button>
                          <button 
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDelete(eid)}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                      
                      {endpoint.isWebSocket ? (
                        <div className="ws-panel">
                          <div className="ws-header">
                            <span>WebSocket 测试</span>
                            {activeWsEndpoint?.id === endpoint.id ? (
                              <button 
                                className="btn btn-danger btn-sm"
                                onClick={disconnectWsEndpoint}
                              >
                                断开连接
                              </button>
                            ) : (
                              <button 
                                className="btn btn-primary btn-sm"
                                onClick={() => connectToWsEndpoint(endpoint)}
                              >
                                连接
                              </button>
                            )}
                          </div>
                          
                          {activeWsEndpoint?.id === endpoint.id && (
                            <>
                              <div style={{ 
                                maxHeight: '150px', 
                                overflow: 'auto', 
                                padding: '10px',
                                background: 'var(--bg-secondary)',
                                fontSize: '12px',
                                fontFamily: 'JetBrains Mono, monospace'
                              }}>
                                {wsTestMessages.map((msg, idx) => (
                                  <div key={idx} style={{ 
                                    marginBottom: '4px',
                                    color: msg.type === 'sent' ? 'var(--accent-cyan)' : 
                                           msg.type === 'received' ? 'var(--accent-green)' : 
                                           'var(--text-muted)'
                                  }}>
                                    <span style={{ color: 'var(--text-muted)' }}>[{formatTime(msg.time)}]</span>
                                    {' '}
                                    <span style={{ fontWeight: '600' }}>
                                      {msg.type === 'sent' ? '➡️' : msg.type === 'received' ? '⬅️' : 'ℹ️'}
                                    </span>
                                    {' '}{msg.message}
                                  </div>
                                ))}
                              </div>
                              <div className="ws-send">
                                <input
                                  type="text"
                                  className="form-input"
                                  value={wsInputMessage}
                                  onChange={(e) => setWsInputMessage(e.target.value)}
                                  placeholder="输入消息..."
                                  onKeyPress={(e) => e.key === 'Enter' && sendWsMessage()}
                                />
                                <button 
                                  className="btn btn-primary btn-sm"
                                  onClick={sendWsMessage}
                                >
                                  发送
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div className="endpoint-meta">
                          <span>状态码: {endpoint.statusCode}</span>
                          <span>{endpoint.contentType}</span>
                        </div>
                      )}
                    </div>
                  )})}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 右侧面板 - 请求日志 */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <div className="panel-title-icon" style={{ background: 'linear-gradient(135deg, #a371f7, #db61a2)' }}>📋</div>
              请求日志
            </div>
            <button className="btn btn-secondary btn-sm" onClick={clearLogs}>
              🗑️ 清空日志
            </button>
          </div>
          <div className="panel-content">
            {logs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📝</div>
                <div className="empty-text">暂无请求日志<br/>调用接口后会在这里显示</div>
              </div>
            ) : (
              <div className="log-list">
                {logs.map((log, index) => (
                  <div 
                    key={index} 
                    className={`log-item ${expandedLogs.has(index) ? 'expanded' : ''}`}
                    onClick={() => toggleLogExpand(index)}
                  >
                    <div className="log-header">
                      <span className={`log-type log-type-${log.type === 'websocket' ? (log.action === 'connect' ? 'connect' : log.action === 'disconnect' ? 'disconnect' : 'ws') : 'http'}`}>
                        {log.type === 'websocket' ? log.action : 'HTTP'}
                      </span>
                      {log.method && (
                        <span className={`log-method method-${log.method}`}>{log.method}</span>
                      )}
                      <span className="log-path">{log.path || log.message || '-'}</span>
                      {getDisplayIp(log) && <span className="log-ip">{getDisplayIp(log)}</span>}
                      <span className="log-time">{formatTime(log.timestamp)}</span>
                    </div>
                    
                    {expandedLogs.has(index) && (
                      <div className="log-details">
                        {log.headers && (
                          <div className="log-section">
                            <div className="log-section-title">请求头 Headers</div>
                            <pre className="log-code">{JSON.stringify(log.headers, null, 2)}</pre>
                          </div>
                        )}
                        
                        {log.query && Object.keys(log.query).length > 0 && (
                          <div className="log-section">
                            <div className="log-section-title">查询参数 Query</div>
                            <pre className="log-code">{JSON.stringify(log.query, null, 2)}</pre>
                          </div>
                        )}
                        
                        {log.body && Object.keys(log.body).length > 0 && (
                          <div className="log-section">
                            <div className="log-section-title">请求体 Body</div>
                            <pre className="log-code">{typeof log.body === 'string' ? log.body : JSON.stringify(log.body, null, 2)}</pre>
                          </div>
                        )}
                        
                        {log.message && log.type === 'websocket' && (
                          <div className="log-section">
                            <div className="log-section-title">WebSocket 消息</div>
                            <pre className="log-code">{log.message}</pre>
                          </div>
                        )}
                        
                        {log.connectionId && (
                          <div className="log-section">
                            <div className="log-section-title">连接 ID</div>
                            <pre className="log-code">{log.connectionId}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;


