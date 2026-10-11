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
const { randomUUID } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
app.get('/', (req, res) => res.redirect('/game.html'));
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/**
 * roomId -> {
 *   hostId: stableMemberId|null,
 *   members: Map(stableMemberId -> {id,token,socketId,name,faction,roleId,seat,connected}),
 *   assign: 开局座位分配|null,
 *   lastSnapshot: 主机最近一次状态快照|null,
 * }
 */
const rooms = new Map();
const ACTIONS = new Set([
  'doRoll', 'choosePlus', 'undoPlus', 'endTurn', 'declineLongJump', 'confirmLongJump',
  'enterLane', 'cancelHook', 'chooseHookTarget', 'chooseMindWarningDir', 'placeDoll',
  'swapWithDoll', 'useAdjacentAttack', 'chooseDir', 'chooseExtraDir', 'useSkill',
  'declineReaction', 'moveTarget',
]);

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { hostId: null, members: new Map(), assign: null, lastSnapshot: null });
  }
  return rooms.get(id);
}
function lobbyState(r) {
  const members = [...r.members.values()].map(m => ({
    id: m.id, name: m.name, faction: m.faction, roleId: m.roleId, connected: !!m.connected,
    isHost: m.id === r.hostId,
  }));
  const ghosts = members.filter(m => m.faction === 'ghost').length;
  return { members, hostId: r.hostId, ghosts, canStart: members.length === 4 && ghosts === 1 };
}
function broadcastLobby(roomId) {
  io.to(roomId).emit('lobby', lobbyState(getRoom(roomId)));
}
function hostSocketId(r) {
  const host = r.hostId ? r.members.get(r.hostId) : null;
  return host && host.connected ? host.socketId : null;
}

io.on('connection', (socket) => {
  socket.on('join', (payload = {}) => {
    const roomId = String(payload.room || 'default').trim() || 'default';
    const r = getRoom(roomId);
    const reconnectToken = String(payload.reconnectToken || '').trim();

    // 有稳定 token 时优先恢复原成员，保留原来的座位、角色和阵营。
    const existing = reconnectToken ? r.members.get(reconnectToken) : null;
    if (existing) {
      const oldSocket = existing.socketId && existing.socketId !== socket.id
        ? io.sockets.sockets.get(existing.socketId)
        : null;
      if (oldSocket) oldSocket.disconnect(true);
      existing.socketId = socket.id;
      existing.connected = true;
      socket.join(roomId);
      socket.data.room = roomId;
      socket.data.member = existing;
      socket.emit('you', {
        id: existing.id,
        token: existing.token,
        socketId: socket.id,
        isHost: existing.id === r.hostId,
        room: roomId,
        resumed: true,
      });
      if (r.assign) {
        socket.emit('resume', { assign: r.assign, snapshot: r.lastSnapshot || null });
      }
      broadcastLobby(roomId);
      console.log(`[resume] ${existing.name} -> ${roomId}`);
      return;
    }

    if (r.members.size >= 4) { socket.emit('err', '房间已满（4 人）'); return; }
    const idx = r.members.size;
    const token = randomUUID();
    const member = {
      id: token,
      token,
      socketId: socket.id,
      name: (payload.name || '').trim() || ('玩家' + (idx + 1)),
      faction: idx === 0 ? 'ghost' : 'human',                          // 默认：第一个人当鬼
      roleId: idx === 0 ? 'factory-owner' : 'soldier',
      seat: null,
      connected: true,
    };
    if (r.hostId === null) r.hostId = member.id;                       // 第一个进房的当主机
    r.members.set(member.id, member);
    socket.join(roomId);
    socket.data.room = roomId;
    socket.data.member = member;
    socket.emit('you', {
      id: member.id,
      token: member.token,
      socketId: socket.id,
      isHost: member.id === r.hostId,
      room: roomId,
      resumed: false,
    });
    broadcastLobby(roomId);
    console.log(`[join] ${payload.name || '?'} -> ${roomId}（共 ${r.members.size} 人）`);
  });

  // 玩家改阵营 / 选角色
  socket.on('pick', ({ faction, roleId } = {}) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    const m = socket.data.member; if (!m) return;
    if (faction) m.faction = faction === 'ghost' ? 'ghost' : 'human';
    if (roleId) m.roleId = roleId;
    broadcastLobby(socket.data.room);
  });

  // 主机开局 → 分配座位
  socket.on('start', () => {
    const roomId = socket.data.room; const r = rooms.get(roomId); if (!r) return;
    const member = socket.data.member;
    if (!member || member.id !== r.hostId) { socket.emit('err', '只有主机能开始'); return; }
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
    r.assign = assign;
    r.lastSnapshot = null;
    io.to(roomId).emit('start', { assign });
    console.log(`[start] ${roomId} 座位分配完成`);
  });

  // 主机广播状态快照
  socket.on('snap', (snap) => {
    const r = rooms.get(socket.data.room);
    const member = socket.data.member;
    if (!r || !member || member.id !== r.hostId) return;
    r.lastSnapshot = snap;
    socket.to(socket.data.room).emit('snap', snap);
  });

  // 主机广播一次性提示（抓人、眩晕、救援、胜负等）
  socket.on('alert', (payload) => {
    const r = rooms.get(socket.data.room);
    const member = socket.data.member;
    if (!r || !member || member.id !== r.hostId) return;
    socket.to(socket.data.room).emit('alert', payload);
  });

  // 观众操作 → 转发给主机
  socket.on('act', (payload) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    if (!payload || !ACTIONS.has(payload.fn) || !Array.isArray(payload.args)) return;
    const m = socket.data.member;
    if (!m || m.seat === null || m.seat === undefined) return;
    const targetHost = hostSocketId(r);
    if (!targetHost) return;
    io.to(targetHost).emit('act', {
      fn: payload.fn,
      args: payload.args,
      fromId: m.id,
      fromSeat: m.seat,
    });
  });

  // 重开等全局命令只允许由主机确认后执行
  socket.on('command', (payload) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    const m = socket.data.member;
    if (!m || m.seat === null || m.seat === undefined) return;
    const targetHost = hostSocketId(r);
    if (!targetHost) return;
    io.to(targetHost).emit('command', {
      type: payload && payload.type,
      fromId: m.id,
      fromSeat: m.seat,
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.room; const r = rooms.get(roomId); if (!r) return;
    const member = socket.data.member;
    if (!member || member.socketId !== socket.id) return;
    member.connected = false;
    broadcastLobby(roomId);
    console.log(`[offline] ${member.name} -> ${roomId}`);
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
