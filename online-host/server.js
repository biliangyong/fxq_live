'use strict';

/**
 * 飞行棋 · 局域网联机 —— 中继服务器（主机权威架构）
 * ---------------------------------------------------------
 * 服务器【不裁决游戏】，只做三件事：
 *   1. 大厅：收集玩家、阵营/角色选择
 *   2. 分配座位（1 鬼 + 3 人）
 *   3. 消息中转：主机 ⇄ 观众 之间转发"状态快照"和"操作"
 *
 * 真正的游戏逻辑跑在【主机玩家】的浏览器里。
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/** roomId -> { hostId, members: Map(id -> {id,name,faction,roleId,seat}) } */
const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { hostId: null, members: new Map() });
  return rooms.get(id);
}
function lobbyState(r) {
  const members = [...r.members.values()].map(m => ({
    id: m.id, name: m.name, faction: m.faction, roleId: m.roleId, isHost: m.id === r.hostId,
  }));
  const ghosts = members.filter(m => m.faction === 'ghost').length;
  return { members, hostId: r.hostId, ghosts, canStart: members.length === 4 && ghosts === 1 };
}
function broadcastLobby(roomId) {
  io.to(roomId).emit('lobby', lobbyState(getRoom(roomId)));
}

io.on('connection', (socket) => {
  socket.on('join', (payload = {}) => {
    const roomId = String(payload.room || 'default').trim() || 'default';
    const r = getRoom(roomId);
    if (r.members.size >= 4) { socket.emit('err', '房间已满（4 人）'); return; }
    if (r.hostId === null) r.hostId = socket.id;                       // 第一个进房的当主机
    const idx = r.members.size;
    r.members.set(socket.id, {
      id: socket.id,
      name: (payload.name || '').trim() || ('玩家' + (idx + 1)),
      faction: idx === 0 ? 'ghost' : 'human',                          // 默认：第一个人当鬼
      roleId: idx === 0 ? 'factory-owner' : 'soldier',
      seat: null,
    });
    socket.join(roomId);
    socket.data.room = roomId;
    socket.emit('you', { id: socket.id, isHost: r.hostId === socket.id, room: roomId });
    broadcastLobby(roomId);
    console.log(`[join] ${payload.name || '?'} -> ${roomId}（共 ${r.members.size} 人）`);
  });

  // 玩家改阵营 / 选角色
  socket.on('pick', ({ faction, roleId } = {}) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    const m = r.members.get(socket.id); if (!m) return;
    if (faction) m.faction = faction === 'ghost' ? 'ghost' : 'human';
    if (roleId) m.roleId = roleId;
    broadcastLobby(socket.data.room);
  });

  // 主机开局 → 分配座位
  socket.on('start', () => {
    const roomId = socket.data.room; const r = rooms.get(roomId); if (!r) return;
    if (r.hostId !== socket.id) { socket.emit('err', '只有主机能开始'); return; }
    const st = lobbyState(r);
    if (!st.canStart) { socket.emit('err', '需要 4 人且恰好 1 名鬼'); return; }
    // 座位：鬼 = 0；人 = 1,2,3（按加入顺序）
    const ghost = st.members.find(m => m.faction === 'ghost');
    const humans = st.members.filter(m => m.faction === 'human');
    const assign = [];
    assign.push({ id: ghost.id, seat: 0, isGhost: true, color: 'red', name: ghost.name, roleId: ghost.roleId });
    ['green', 'yellow', 'blue'].forEach((color, i) => {
      const h = humans[i];
      assign.push({ id: h.id, seat: i + 1, isGhost: false, color, name: h.name, roleId: h.roleId });
    });
    assign.forEach((a) => { const m = r.members.get(a.id); if (m) m.seat = a.seat; });
    io.to(roomId).emit('start', { assign });
    console.log(`[start] ${roomId} 座位分配完成`);
  });

  // 主机广播状态快照
  socket.on('snap', (snap) => {
    socket.to(socket.data.room).emit('snap', snap);
  });

  // 观众操作 → 转发给主机
  socket.on('act', (payload) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    const m = r.members.get(socket.id);
    io.to(r.hostId).emit('act', { ...payload, fromId: socket.id, fromSeat: m ? m.seat : undefined });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.room; const r = rooms.get(roomId); if (!r) return;
    r.members.delete(socket.id);
    if (r.hostId === socket.id) {
      r.hostId = null;
      io.to(roomId).emit('err', '主机已离开，本局结束');
    }
    broadcastLobby(roomId);
    console.log(`[leave] ${roomId}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('================================================');
  console.log(' 飞行棋联机（主机权威）已启动');
  console.log(' 本机：   http://localhost:' + PORT);
  console.log(' 他人：   http://<你的内网IP>:' + PORT);
  console.log('================================================');
});
