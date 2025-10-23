import http from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 启动端口号
const DEFAULT_PORT = 3000;

const parsePort = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
};

const extractCliPort = () => {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--port' || arg === '-p') {
      return parsePort(args[index + 1]);
    }
    if (arg.startsWith('--port=')) {
      return parsePort(arg.split('=')[1]);
    }
  }
  return null;
};

const cliPort = extractCliPort();
const envPort = parsePort(process.env.PORT);
const PORT = cliPort ?? envPort ?? DEFAULT_PORT;
const HEARTBEAT_INTERVAL = 30000;

const ADJECTIVES = [
  '敏捷的',
  '迅捷的',
  '快乐的',
  '安静的',
  '温暖的',
  '璀璨的',
  '闪亮的',
  '勇敢的',
  '机智的',
  '悠然的',
  '灵动的',
  '轻盈的',
];

const NOUNS = [
  '西兰花',
  '星辰',
  '雨燕',
  '青竹',
  '微风',
  '山峦',
  '清泉',
  '花火',
  '晨露',
  '向日葵',
  '海豚',
  '薄荷',
];

const usedDisplayNames = new Set();

const generateUniqueDisplayName = () => {
  const totalCombinations = ADJECTIVES.length * NOUNS.length;
  for (let attempt = 0; attempt < totalCombinations; attempt += 1) {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const name = `${adjective}${noun}`;
    if (!usedDisplayNames.has(name)) {
      usedDisplayNames.add(name);
      return name;
    }
  }
  let fallback;
  do {
    fallback = `设备${uuid().slice(0, 4)}`;
  } while (usedDisplayNames.has(fallback));
  usedDisplayNames.add(fallback);
  return fallback;
};

const app = express();
const clientDir = path.resolve(__dirname, 'client');
const serveStatic = (fileName) => path.join(clientDir, fileName);

app.use(express.static(clientDir));

app.get('/', (req, res) => {
  res.sendFile(serveStatic('index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(serveStatic('index.html'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(serveStatic('app.js'));
});

app.get('/styles.css', (req, res) => {
  res.sendFile(serveStatic('styles.css'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();

const getPeerSnapshot = (excludeId) =>
  [...clients.entries()]
    .filter(([id]) => id !== excludeId)
    .map(([id, client]) => ({
      id,
      displayName: client.displayName,
      lastSeen: client.lastSeen,
    }));

const send = (ws, type, payload = {}) => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
};

const broadcast = (type, payload, exceptId) => {
  for (const [id, client] of clients.entries()) {
    if (id === exceptId) continue;
    send(client.ws, type, payload);
  }
};

wss.on('connection', (ws, req) => {
  const clientId = uuid();
  const clientRecord = {
    id: clientId,
    ws,
    displayName: generateUniqueDisplayName(),
    lastSeen: Date.now(),
    autoName: true,
  };
  clients.set(clientId, clientRecord);

  send(ws, 'welcome', {
    id: clientId,
    displayName: clientRecord.displayName,
    peers: getPeerSnapshot(clientId),
  });

  broadcast(
    'peer-joined',
    {
      id: clientId,
      displayName: clientRecord.displayName,
      lastSeen: clientRecord.lastSeen,
    },
    clientId,
  );

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      send(ws, 'error', { message: 'Invalid JSON payload.' });
      return;
    }

    const { type, payload } = data;
    clientRecord.lastSeen = Date.now();

    switch (type) {
      case 'register': {
        const { displayName } = payload || {};
        if (typeof displayName === 'string') {
          const trimmed = displayName.trim();
          if (trimmed) {
            if (clientRecord.autoName) {
              usedDisplayNames.delete(clientRecord.displayName);
              clientRecord.autoName = false;
            }
            clientRecord.displayName = trimmed.slice(0, 80);
          } else if (!clientRecord.autoName) {
            clientRecord.displayName = generateUniqueDisplayName();
            clientRecord.autoName = true;
          }
        }
        send(ws, 'registered', {
          id: clientId,
          displayName: clientRecord.displayName,
        });
        broadcast(
          'peer-updated',
          {
            id: clientId,
            displayName: clientRecord.displayName,
            lastSeen: clientRecord.lastSeen,
          },
          clientId,
        );
        break;
      }
      case 'signal': {
        const { targetId, data: signalData } = payload || {};
        if (!targetId || !signalData) break;
        const target = clients.get(targetId);
        if (!target) {
          send(ws, 'signal-error', { targetId, message: 'Target unavailable.' });
          break;
        }
        send(target.ws, 'signal', {
          from: clientId,
          data: signalData,
        });
        break;
      }
      case 'poke': {
        const { targetId } = payload || {};
        if (!targetId) break;
        const target = clients.get(targetId);
        if (!target) {
          send(ws, 'delivery-error', {
            targetId,
            message: 'Target unavailable.',
          });
          break;
        }
        send(target.ws, 'poke', {
          from: clientId,
          displayName: clientRecord.displayName,
          timestamp: Date.now(),
        });
        break;
      }
      case 'text-message': {
        const { message, targetId } = payload || {};
        if (typeof message !== 'string' || !message.trim()) break;
        if (targetId) {
          const target = clients.get(targetId);
          if (!target) {
            send(ws, 'delivery-error', {
              targetId,
              message: 'Target unavailable.',
            });
            break;
          }
          send(target.ws, 'text-message', {
            from: clientId,
            displayName: clientRecord.displayName,
            message,
            timestamp: Date.now(),
          });
        } else {
          broadcast(
            'text-message',
            {
              from: clientId,
              displayName: clientRecord.displayName,
              message,
              timestamp: Date.now(),
            },
            clientId,
          );
        }
        break;
      }
      case 'clipboard-update': {
        const { content, targetId, items } = payload || {};
        const packetPayload = {};
        if (typeof content === 'string') {
          packetPayload.content = content;
        }
        if (Array.isArray(items)) {
          const sanitizedItems = items
            .filter((entry) => entry && typeof entry.mime === 'string' && typeof entry.data === 'string')
            .map((entry) => ({
              mime: entry.mime,
              data: entry.data,
              encoding: entry.encoding === 'base64' ? 'base64' : 'text',
            }));
          if (sanitizedItems.length) {
            packetPayload.items = sanitizedItems;
          }
        }
        if (
          typeof packetPayload.content !== 'string' &&
          !Array.isArray(packetPayload.items)
        ) {
          break;
        }
        const packet = {
          from: clientId,
          displayName: clientRecord.displayName,
          timestamp: Date.now(),
          ...packetPayload,
        };
        if (targetId) {
          const target = clients.get(targetId);
          if (!target) {
            send(ws, 'delivery-error', {
              targetId,
              message: 'Target unavailable.',
            });
            break;
          }
          send(target.ws, 'clipboard-update', packet);
        } else {
          broadcast('clipboard-update', packet, clientId);
        }
        break;
      }
      case 'file-transfer-meta': {
        const { targetId, transferId, name, size, mime } = payload || {};
        if (!targetId || !transferId) break;
        const target = clients.get(targetId);
        if (!target) {
          send(ws, 'file-transfer-error', {
            transferId,
            targetId,
            message: 'Target unavailable.',
          });
          break;
        }
        send(target.ws, 'file-transfer-meta', {
          from: clientId,
          displayName: clientRecord.displayName,
          transferId,
          name,
          size,
          mime,
          timestamp: Date.now(),
        });
        break;
      }
      case 'file-transfer-chunk': {
        const { targetId, transferId, index, data, size } = payload || {};
        if (!targetId || !transferId || typeof data !== 'string') break;
        const target = clients.get(targetId);
        if (!target) {
          send(ws, 'file-transfer-error', {
            transferId,
            targetId,
            message: 'Target unavailable.',
          });
          break;
        }
        send(target.ws, 'file-transfer-chunk', {
          from: clientId,
          transferId,
          index,
          data,
          size,
        });
        break;
      }
      case 'file-transfer-complete': {
        const { targetId, transferId, name, mime } = payload || {};
        if (!targetId || !transferId) break;
        const target = clients.get(targetId);
        if (!target) {
          send(ws, 'file-transfer-error', {
            transferId,
            targetId,
            message: 'Target unavailable.',
          });
          break;
        }
        send(target.ws, 'file-transfer-complete', {
          from: clientId,
          transferId,
          name,
          mime,
          timestamp: Date.now(),
        });
        break;
      }
      case 'file-transfer-error': {
        const { targetId, transferId, message: errorMessage } = payload || {};
        if (!targetId || !transferId) break;
        const target = clients.get(targetId);
        if (target) {
          send(target.ws, 'file-transfer-error', {
            from: clientId,
            displayName: clientRecord.displayName,
            transferId,
            message: errorMessage,
          });
        }
        break;
      }
      case 'ping': {
        send(ws, 'pong', { timestamp: Date.now() });
        break;
      }
      case 'pong': {
        break;
      }
      default: {
        send(ws, 'error', { message: `Unrecognized message type: ${type}` });
      }
    }
  });

  ws.on('close', () => {
    if (clientRecord.autoName) {
      usedDisplayNames.delete(clientRecord.displayName);
    }
    clients.delete(clientId);
    broadcast('peer-left', { id: clientId });
  });

  ws.on('error', () => {
    ws.close();
  });
});

setInterval(() => {
  const expiry = Date.now() - HEARTBEAT_INTERVAL * 2;
  for (const [id, client] of clients.entries()) {
    if (client.lastSeen < expiry) {
      client.ws.terminate();
      if (client.autoName) {
        usedDisplayNames.delete(client.displayName);
      }
      clients.delete(id);
      broadcast('peer-left', { id });
    } else {
      send(client.ws, 'ping', { timestamp: Date.now() });
    }
  }
}, HEARTBEAT_INTERVAL);

server.listen(PORT, () => {
  console.log(`SnapSend server listening on http://localhost:${PORT}`);
  const interfaces = os.networkInterfaces();
  const lanUrls = new Set();
  for (const infos of Object.values(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        lanUrls.add(`http://${info.address}:${PORT}`);
      }
    }
  }
  if (lanUrls.size > 0) {
    console.log('在本地网络访问:');
    for (const url of lanUrls) {
      console.log(`  • ${url}`);
    }
  }
});
