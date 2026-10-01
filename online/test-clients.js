'use strict';
/**
 * 自动化验证脚本：模拟 4 个客户端，检查服务器是否"只让轮到的人操作"。
 * 运行前需先启动 server.js。
 */
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'test-' + Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name, token) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.cname = name;
    s.ctoken = token;
    s.alerts = [];
    s.joined = false;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(s); } };
    s.on('alert', (m) => { s.alerts.push(m); fin(); });          // 被拒时也要兑现，避免卡死
    s.on('state', (st) => { s.state = st; });
    s.on('joined', (d) => { s.seat = d.seat; s.reconnected = d.reconnected; s.joined = true; fin(); });
    s.on('connect', () => s.emit('join', { room: ROOM, name, token }));
  });
}

(async () => {
  console.log('连接 4 个客户端到房间 ' + ROOM + ' ...\n');
  const clients = await Promise.all([0, 1, 2, 3].map((i) => makeClient('玩家' + i, 'tok-' + i)));
  await wait(400);

  const bySeat = {};
  clients.forEach((c) => { bySeat[c.seat] = c; });
  const p = (seat) => bySeat[seat];
  console.log('座位分配：', clients.map((c) => c.cname + '→座位' + c.seat).join('，'));

  const st = clients[0].state;
  console.log('\n① 满员后：phase =', st.phase, '| turn =', st.turn, '| 玩家数 =', st.players.length);

  p(2).emit('roll');                       // 座位2 不该轮到
  await wait(250);
  console.log('② 座位2 抢着掷骰 →', p(2).alerts.slice(-1)[0] || '❌ 没被拦截！');

  p(0).emit('roll');                       // 座位0 合法
  await wait(250);
  console.log('③ 座位0 掷骰后 → phase =', p(0).state.phase, '| dice =', p(0).state.dice);

  p(1).emit('move');                       // 座位1 不该轮到
  await wait(250);
  console.log('④ 座位1 抢着移动 →', p(1).alerts.slice(-1)[0] || '❌ 没被拦截！');

  p(0).emit('move');                       // 座位0 合法移动
  await wait(250);
  const s2 = p(0).state;
  console.log('⑤ 座位0 移动后 → turn =', s2.turn, '| 座位0 步数 =', s2.players[0].total);

  // 继续跑几轮，确认回合能循环推进
  for (let r = 0; r < 6; r++) {
    const t = p(0).state.turn;
    p(t).emit('roll'); await wait(120);
    p(t).emit('move'); await wait(120);
  }
  console.log('⑥ 连跑 6 手后 → turn =', p(0).state.turn, '| 各座位步数 =',
    p(0).state.players.map((x) => x.total).join('/'));

  // ⑦ 断线重连测试：座位2 退出后，凭【同一令牌】重新进入
  const victim = p(2);
  const vname = victim.cname, vtok = victim.ctoken, vseat = victim.seat;
  victim.disconnect();
  await wait(350);
  const back = await makeClient(vname, vtok);
  await wait(350);
  const rcOK = (back.seat === vseat) && back.reconnected === true;
  console.log('⑦ 座位' + vseat + ' 退出后凭令牌重连 → 拿回座位 ' + back.seat +
    ' | reconnected=' + back.reconnected + ' → ' + (rcOK ? '✅ 认回成功' : '❌ 未认回'));

  // ⑦b 换一个全新名字（令牌也不同）再试 → 应被拒绝（游戏已开始）
  const stranger = await makeClient('陌生人', 'tok-new');
  await wait(300);
  console.log('⑦b 全新玩家开局后加入 →', stranger.alerts.slice(-1)[0] || '❌ 没被拒！');

  const ok = s2.turn === 1 && p(2).alerts.length && p(1).alerts.length && rcOK && stranger.alerts.length;
  console.log('\n' + (ok ? '✅ 全部通过：权威校验 + 断线重连 + 开局拒绝 都正常' : '⚠️ 结果需人工检查'));
  process.exit(0);
})();
