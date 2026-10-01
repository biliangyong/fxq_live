'use strict';

/**
 * 局域网联机服务器（服务器权威 + Socket.IO）
 * ---------------------------------------------------------
 * - 静态托管 public/ 下的客户端页面
 * - 用房间(room)隔离每一局
 * - 所有游戏状态由服务器持有；客户端只能"发指令"，不能直接改状态
 * - 任何状态变化 → 广播最新快照给房间内所有人
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

/** roomId -> 游戏状态 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, game.createGame());
  return rooms.get(roomId);
}

function broadcast(roomId) {
  io.to(roomId).emit('state', game.publicState(getRoom(roomId)));
}

io.on('connection', (socket) => {
  // 加入房间
  socket.on('join', (payload = {}) => {
    const roomId = String(payload.room || 'default').trim() || 'default';
    const g = getRoom(roomId);
    const res = game.join(g, socket.id, payload.name, payload.token);
    if (res.error) { socket.emit('alert', res.error); return; }
    socket.join(roomId);
    socket.data.room = roomId;
    socket.emit('joined', { seat: res.seat, room: roomId, reconnected: !!res.reconnected });
    broadcast(roomId);
    console.log(`[join] ${payload.name || '?'} -> ${roomId}（座位 ${res.seat + 1}）`);
  });

  // 掷骰子
  socket.on('roll', () => {
    const roomId = socket.data.room;
    if (!roomId) return;
    const res = game.roll(getRoom(roomId), socket.id);
    if (res.error) { socket.emit('alert', res.error); return; }
    broadcast(roomId);
  });

  // 移动
  socket.on('move', () => {
    const roomId = socket.data.room;
    if (!roomId) return;
    const res = game.move(getRoom(roomId), socket.id);
    if (res.error) { socket.emit('alert', res.error); return; }
    broadcast(roomId);
  });

  // 重开（任意玩家可发起，MVP 简化）
  socket.on('reset', () => {
    const roomId = socket.data.room;
    if (!roomId) return;
    rooms.set(roomId, game.reset(getRoom(roomId)));
    broadcast(roomId);
  });

  // 掉线
  socket.on('disconnect', () => {
    const roomId = socket.data.room;
    if (!roomId) return;
    const p = getRoom(roomId).players.find((x) => x.id === socket.id);
    if (p) { p.connected = false; broadcast(roomId); }
    console.log(`[disconnect] ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log(' 飞行棋联机服务器已启动');
  console.log(' 本机访问：   http://localhost:' + PORT);
  console.log(' 他人访问：   http://<你的内网IP>:' + PORT);
  console.log(' （用 ipconfig 查看 IPv4 地址，同一 WiFi 下可访问）');
  console.log('==============================================');
});
