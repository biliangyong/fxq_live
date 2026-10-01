'use strict';

/**
 * 共享游戏逻辑（服务器权威）
 * ---------------------------------------------------------
 * 这个文件是"唯一的真相来源"：只有服务器会调用它来改状态。
 * 客户端拿到的永远只是 publicState() 的快照，用于渲染。
 *
 * 现在是一个最小骨架：4 个玩家在环形跑道上前进，先跑完 2 圈者获胜。
 * 以后要把飞行棋的完整规则搬进来，就替换/扩展这里的逻辑即可。
 */

const TRACK = 24;          // 环形跑道格数
const LAPS_TO_WIN = 2;     // 跑完几圈获胜
const MAX_PLAYERS = 4;     // 座位数：1 鬼 + 3 人

function createGame() {
  return {
    players: [],           // {id, name, seat, pos, total, connected}
    turn: 0,               // 当前轮到哪个座位
    dice: 0,               // 本回合骰点
    phase: 'wait',         // wait(等人) | roll(等掷骰) | move(等移动) | over(结束)
    round: 1,
    winner: null,
    log: [],
  };
}

function addLog(g, msg) {
  g.log.push(msg);
  if (g.log.length > 60) g.log.shift();
}

function addPlayer(g, id, name) {
  if (g.phase !== 'wait') return { error: '游戏已开始，无法加入' };
  if (g.players.length >= MAX_PLAYERS) return { error: '房间已满（4 人）' };
  if (g.players.some(p => p.id === id)) return { error: '你已在房间中' };
  const seat = g.players.length;
  const finalName = (name && name.trim()) || ('玩家' + (seat + 1));
  g.players.push({ id, name: finalName, seat, pos: 0, total: 0, connected: true });
  addLog(g, `👤 ${finalName} 加入（座位 ${seat + 1}）`);
  if (g.players.length === MAX_PLAYERS) {
    g.phase = 'roll';
    g.turn = 0;
    addLog(g, '🎮 满员，游戏开始！');
  }
  return { seat };
}

function currentPlayer(g) {
  return g.players[g.turn];
}

function roll(g, id) {
  if (g.phase !== 'roll') return { error: '现在不能掷骰' };
  const p = currentPlayer(g);
  if (!p || p.id !== id) return { error: '还没轮到你' };
  g.dice = 1 + Math.floor(Math.random() * 6);   // ★随机数在服务器产生
  g.phase = 'move';
  addLog(g, `🎲 ${p.name} 掷出 ${g.dice}`);
  return { dice: g.dice };
}

function move(g, id) {
  if (g.phase !== 'move') return { error: '请先掷骰' };
  const p = currentPlayer(g);
  if (!p || p.id !== id) return { error: '还没轮到你' };
  p.pos = (p.pos + g.dice) % TRACK;
  p.total += g.dice;
  addLog(g, `➡️ ${p.name} 前进 ${g.dice} 格（第 ${p.pos + 1} 格）`);

  if (p.total >= TRACK * LAPS_TO_WIN) {
    g.phase = 'over';
    g.winner = p.seat;
    addLog(g, `🏆 ${p.name} 跑完 ${LAPS_TO_WIN} 圈，获胜！`);
    return { ok: true };
  }

  g.turn = (g.turn + 1) % MAX_PLAYERS;          // 回合推进（服务器说了算）
  if (g.turn === 0) g.round++;
  g.dice = 0;
  g.phase = 'roll';
  return { ok: true };
}

function reset(g) {
  const ids = g.players.map(p => ({ id: p.id, name: p.name }));
  const fresh = createGame();
  fresh.players = ids.map((x, i) => ({ id: x.id, name: x.name, seat: i, pos: 0, total: 0, connected: true }));
  if (fresh.players.length === MAX_PLAYERS) { fresh.phase = 'roll'; fresh.turn = 0; }
  addLog(fresh, '🔄 重新开始');
  return fresh;
}

function publicState(g) {
  return {
    players: g.players.map(p => ({
      name: p.name, seat: p.seat, pos: p.pos, total: p.total,
      connected: p.connected, isGhost: p.seat === 0,
    })),
    turn: g.turn,
    dice: g.dice,
    phase: g.phase,
    round: g.round,
    winner: g.winner,
    log: g.log.slice(-8),
    track: TRACK,
    lapsToWin: LAPS_TO_WIN,
    maxPlayers: MAX_PLAYERS,
  };
}

module.exports = {
  createGame, addPlayer, currentPlayer, roll, move, reset, publicState,
  TRACK, MAX_PLAYERS, LAPS_TO_WIN,
};
