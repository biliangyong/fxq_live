'use strict';
/* 中继服务器 + 联机协议测试（不开浏览器，纯验证通信层） */
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ROOM = 't' + Date.now();

function mk(name) {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'] });
    s.cname = name; s.lobbies = []; s.acts = []; s.snaps = []; s.starts = [];
    s.on('lobby', (l) => s.lobbies.push(l));
    s.on('act', (a) => s.acts.push(a));
    s.on('snap', (x) => s.snaps.push(x));
    s.on('start', (x) => s.starts.push(x));
    s.on('you', (d) => { s.you = d; res(s); });
    s.on('connect', () => s.emit('join', { room: ROOM, name }));
  });
}

(async () => {
  const cs = await Promise.all(['A', 'B', 'C', 'D'].map(mk));
  await wait(300);
  const host = cs.find((c) => c.you.isHost);
  console.log('① 主机 =', host.cname, '| 大厅人数 =', host.lobbies.slice(-1)[0].members.length);

  host.emit('pick', { faction: 'ghost', roleId: 'deer-head' });
  cs.filter((c) => c !== host).forEach((c, i) => c.emit('pick', { faction: 'human', roleId: ['soldier', 'blind-girl', 'spectrum'][i] }));
  await wait(300);
  const st = host.lobbies.slice(-1)[0];
  console.log('② 选好阵营后 canStart =', st.canStart, '| 鬼数 =', st.ghosts);

  host.emit('start');
  await wait(300);
  console.log('③ 收到 start 事件数 =', host.starts.length);
  const assign = host.starts[0].assign;
  console.log('   座位分配:', assign.map((a) => `${a.name}=#${a.seat}(${a.isGhost ? '鬼' : a.color})`).join(' '));

  host.emit('snap', { hello: 1 });
  await wait(200);
  console.log('④ 3 名观众都收到快照吗 =', cs.filter((c) => c !== host).every((c) => c.snaps.length > 0));

  const seat1 = assign.find((a) => a.seat === 1);
  const v = cs.find((c) => c.you.id === seat1.id);
  v.emit('act', { fn: 'doRoll', args: [] });
  await wait(200);
  console.log('⑤ 主机收到观众操作 =', host.acts.length > 0, '| fromSeat =', host.acts[0] && host.acts[0].fromSeat, '(应为 1)');

  const ok = st.canStart && host.starts.length === 1 && assign.length === 4 && host.acts[0] && host.acts[0].fromSeat === 1;
  console.log('\n' + (ok ? '✅ 中继协议全部正常（大厅 / 座位分配 / 快照广播 / 操作转发+来源座位）' : '⚠️ 需检查'));
  process.exit(0);
})();
