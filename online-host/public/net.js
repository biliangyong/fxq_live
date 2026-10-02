/* ============================================================
 * 飞行棋 · 联机层（主机权威）
 * ------------------------------------------------------------
 * 本文件在游戏主脚本【之后】加载，直接复用游戏的全部逻辑函数。
 *
 * 主机(第一个进房的人)：浏览器里跑完整游戏，定期广播状态快照。
 * 观众：用快照渲染同一块棋盘；轮到自己时，把操作转发给主机。
 * ============================================================ */
(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  let myId = null, isHost = false, roomId = null, mySeat = null, started = false, bypass = false;
  let hostSeat = null, hostAssign = null;
  let viewerSeated = false, lastSeatsKey = '';

  /* ---------- 注入大厅 UI ---------- */
  const style = document.createElement('style');
  style.textContent = `
  #netLobby{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(135deg,#e8e4f0,#f6f1e7);font-family:"Microsoft YaHei",system-ui,sans-serif;color:#1d2733}
  #netLobby .box{background:#fff;border-radius:20px;box-shadow:0 24px 60px rgba(30,42,60,.3);padding:26px;width:380px}
  #netLobby h2{margin:0 0 14px;font-size:20px}
  #netLobby label{display:block;font-size:13px;color:#5a6675;margin:10px 0 4px}
  #netLobby input{width:100%;padding:10px;border:1px solid #d5dbe3;border-radius:10px;font-size:14px;box-sizing:border-box}
  #netLobby button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:10px;background:#1f7fd1;color:#fff;font-size:15px;cursor:pointer}
  #netLobby button:disabled{opacity:.45;cursor:default}
  .netMember{display:flex;gap:8px;align-items:center;padding:8px;border-radius:10px;background:#f3f5f8;margin-bottom:8px;font-size:13px;flex-wrap:wrap}
  .netMember .nm{font-weight:700;min-width:60px}
  .netMember select{padding:4px;border-radius:8px;border:1px solid #d5dbe3;font-size:12px}
  .netMember.host{outline:2px solid #f0b400}
  .netBadge{font-size:11px;padding:1px 6px;border-radius:6px;background:#e3f0fb;color:#1f7fd1}
  #netMsg{font-size:12px;color:#e04a3a;min-height:16px;margin-top:8px}
  #netTurn{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9998;background:#1d2733;color:#fff;
    padding:8px 18px;border-radius:20px;font-size:14px;display:none}
  `;
  document.head.appendChild(style);

  const lobby = document.createElement('div');
  lobby.id = 'netLobby';
  lobby.innerHTML = `
    <div class="box">
      <h2>🎲 飞行棋 · 联机</h2>
      <div id="joinForm">
        <label>你的名字</label><input id="netName" maxlength="8" placeholder="玩家">
        <label>房间号</label><input id="netRoom" value="default" maxlength="16">
        <button id="netJoin">加入房间</button>
        <div id="netMsg"></div>
      </div>
      <div id="lobbyPanel" style="display:none">
        <div style="font-size:13px;color:#5a6675;margin-bottom:6px">房间：<b id="netRoomLabel"></b>（4 人满员，恰好 1 名鬼）</div>
        <div id="netMembers"></div>
        <button id="netStart" disabled>等待玩家…</button>
        <div id="netMsg2" style="font-size:12px;color:#e04a3a;min-height:16px;margin-top:8px"></div>
      </div>
    </div>`;
  document.body.appendChild(lobby);
  const turnBar = document.createElement('div');
  turnBar.id = 'netTurn';
  document.body.appendChild(turnBar);

  const ROLE_LABEL = {};
  ROLE_POOLS.ghost.concat(ROLE_POOLS.human).forEach((r) => { ROLE_LABEL[r.id] = r.charName; });

  /* ---------- 连接与大厅 ---------- */
  $('netJoin').onclick = () => {
    const name = $('netName').value.trim();
    roomId = $('netRoom').value.trim() || 'default';
    socket.emit('join', { room: roomId, name });
    $('joinForm').style.display = 'none';
    $('lobbyPanel').style.display = 'block';
    $('netRoomLabel').textContent = roomId;
  };
  socket.on('you', (d) => { myId = d.id; isHost = d.isHost; });
  socket.on('err', (m) => { $('netMsg').textContent = m; $('netMsg2').textContent = m; });
  socket.on('lobby', (st) => renderLobby(st));

  function renderLobby(st) {
    mySeat = null;
    const wrap = $('netMembers');
    wrap.innerHTML = '';
    st.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'netMember' + (m.isHost ? ' host' : '');
      const mine = m.id === myId;
      const rolePool = m.faction === 'ghost' ? ROLE_POOLS.ghost : ROLE_POOLS.human;
      row.innerHTML = `<span class="nm">${esc(m.name)}</span>
        ${m.isHost ? '<span class="netBadge">主机</span>' : ''}
        <select data-f="faction" ${mine ? '' : 'disabled'}>
          <option value="ghost" ${m.faction === 'ghost' ? 'selected' : ''}>👻 鬼</option>
          <option value="human" ${m.faction === 'human' ? 'selected' : ''}>✈ 人</option>
        </select>
        <select data-f="role" ${mine ? '' : 'disabled'}>
          ${rolePool.map((r) => `<option value="${r.id}" ${m.roleId === r.id ? 'selected' : ''}>${r.charName}</option>`).join('')}
        </select>`;
      if (mine) {
        row.querySelector('[data-f="faction"]').onchange = (e) => socket.emit('pick', { faction: e.target.value, roleId: rolePool[0].id });
        row.querySelector('[data-f="role"]').onchange = (e) => socket.emit('pick', { roleId: e.target.value });
      }
      wrap.appendChild(row);
    });
    const startBtn = $('netStart');
    startBtn.disabled = !(isHost && st.canStart);
    startBtn.textContent = isHost ? (st.canStart ? '开始游戏' : `等待玩家… (${st.members.length}/4，鬼 ${st.ghosts}/1)`) : '等待主机开始…';
  }
  $('netStart').onclick = () => socket.emit('start');

  /* ---------- 开局 ---------- */
  socket.on('start', ({ assign }) => {
    hostAssign = assign;
    lobby.style.display = 'none';
    setupModal.classList.add('hidden');
    const me = assign.find((a) => a.id === myId);
    const myViewerSeat = me ? me.seat : null;
    if (isHost) startAsHost(assign); else startAsViewer(assign, myViewerSeat);
  });

  /* ============ 主机 ============ */
  function startAsHost(assign) {
    started = true;
    hostSeat = assign.find((a) => a.id === myId).seat;
    // 用大厅的选择覆盖 rolePick，并让座位带上玩家名字
    rolePick.ghost = assign[0].roleId;
    const colors = ['green', 'yellow', 'blue'];
    assign.slice(1).forEach((a, i) => { rolePick[colors[i]] = a.roleId; });
    const _buildSeats = buildSeats;
    buildSeats = function () {
      _buildSeats();
      assign.forEach((a, i) => { if (SEATS[i]) SEATS[i].name = a.name; });
    };
    startGame();
    wrapHostGuards();
    // 广播快照
    setInterval(() => { if (started) socket.emit('snap', makeSnapshot()); }, 250);
    // 接收观众操作
    socket.on('act', ({ fn, args, fromSeat }) => {
      if (!started || G == null) return;
      if (fromSeat === undefined || fromSeat !== G.turn) return;   // 只接受"当前回合玩家"的操作
      bypass = true;
      try { applyRemoteAction(fn, args); } finally { bypass = false; }
    });
    showTurnBar();
  }

  const LOCAL_FNS = ['doRoll', 'choosePlus', 'undoPlus', 'endTurn', 'declineLongJump', 'confirmLongJump',
    'enterLane', 'cancelHook', 'chooseHookTarget', 'chooseMindWarningDir', 'placeDoll', 'swapWithDoll',
    'useAdjacentAttack', 'chooseDir', 'chooseExtraDir'];
  function wrapHostGuards() {
    LOCAL_FNS.forEach((name) => {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      window[name] = function (...args) {
        if (started && G && G.turn !== hostSeat && !bypass) return;   // 不是主机的回合，忽略本地点击
        return orig.apply(this, args);
      };
    });
    const origUse = window.useSkill;
    window.useSkill = function () {
      if (started && G && G.turn !== hostSeat && !bypass) return;
      return origUse.apply(this, arguments);
    };
  }
  function applyRemoteAction(fn, args) {
    if (fn === 'useSkill') { const sk = findSkillById(args[0]); if (sk) useSkill(sk); return; }
    if (fn === 'moveTarget') { doMoveTarget(args[0]); return; }
    const f = window[fn];
    if (typeof f === 'function') f(...args);
  }
  function findSkillById(id) {
    const p = pieces[G.turn];
    if (!p) return null;
    return (p.seat.skills || []).find((sk) => sk.id === id) || null;
  }
  function doMoveTarget(t) {
    if (!G || G.animating || !['dir', 'post', 'jump'].includes(G.phase)) return;
    const p = G.phase === 'jump' ? jumpPiece() : seatPiece();
    if (!p) return;
    if (t.kind === 'noJump') return declineLongJump();
    if (t.kind === 'jump') return confirmLongJump(Number(t.target));
    if (t.kind === 'lane') return enterLane();
    if (p.seat.isGhost && G.phase === 'dir') { G.dice = Number(t.dice); G.plusUsed = (t.plus === '1'); setDice(G.dice); }
    const dir = Number(t.dir);
    if (G.pendingExtra > 0) chooseExtraDir(dir); else chooseDir(dir);
  }
  function makeSnapshot() {
    return {
      seats: SEATS.map((s) => ({ name: s.name, isGhost: s.isGhost, color: s.color, roleId: s.roleKey })),
      pieces: pieces.map((p) => ({ loc: p.loc, status: p.status })),
      g: JSON.parse(JSON.stringify(G)),
      logs: logs.slice(0, 4),
      turn: G.turn,
    };
  }

  /* ============ 观众 ============ */
  const FORWARD = {
    doRoll: () => [], choosePlus: (u) => [u], undoPlus: () => [], endTurn: () => [],
    declineLongJump: () => [], confirmLongJump: (t) => [t], enterLane: () => [],
    cancelHook: () => [], chooseHookTarget: (i) => [i], chooseMindWarningDir: (d) => [d],
    placeDoll: () => [], swapWithDoll: (i) => [i], useAdjacentAttack: (i) => [i],
    chooseDir: (d) => [d], chooseExtraDir: (d) => [d],
  };
  function startAsViewer(assign, seat) {
    started = true; mySeat = seat;
    viewerBuildSeats(assign);
    // 拦截所有操作 → 转发给主机
    Object.keys(FORWARD).forEach((name) => {
      window[name] = function (...args) { socket.emit('act', { fn: name, args: FORWARD[name](...args) }); };
    });
    window.useSkill = function (skill) { socket.emit('act', { fn: 'useSkill', args: [skill.id] }); };
    // 棋盘落点点击 → 转发
    if (moveTargetsLayer) {
      moveTargetsLayer.addEventListener('click', (e) => {
        const g = e.target.closest && e.target.closest('.move-target');
        if (!g) return;
        e.stopPropagation(); e.preventDefault();
        socket.emit('act', { fn: 'moveTarget', args: [{
          kind: g.getAttribute('data-target-kind'),
          target: g.getAttribute('data-target'),
          dir: g.getAttribute('data-dir'),
          dice: g.getAttribute('data-dice'),
          plus: g.getAttribute('data-plus'),
        }] });
      }, true);
    }
    socket.on('snap', (s) => applySnapshot(s));
    showTurnBar();
  }
  function viewerBuildSeats(assign) {
    SEATS = assign.map((a) => {
      const owner = a.isGhost ? 'ghost' : a.color;
      const seat = makeSeat(a.color, roleById(owner, a.roleId), a.isGhost);
      seat.name = a.name;
      return seat;
    });
    createPieces();
    viewerSeated = true;
    lastSeatsKey = JSON.stringify(assign);
  }
  function applySnapshot(s) {
    const key = JSON.stringify(s.seats);
    if (!viewerSeated || key !== lastSeatsKey) viewerBuildSeats(s.seats);
    for (let i = 0; i < s.pieces.length; i++) {
      if (pieces[i]) { pieces[i].loc = s.pieces[i].loc; pieces[i].status = s.pieces[i].status; }
    }
    G = s.g;
    logs.length = 0; (s.logs || []).forEach((l) => logs.push(l));
    if (statusEl) statusEl.innerHTML = logs.map((x, i) => '<div' + (i === 0 ? ' style="font-weight:700"' : '') + '>' + x + '</div>').join('');
    try { renderPieces(); } catch (e) {}
    try { renderDolls(); } catch (e) {}
    try { setDice(G.dice); } catch (e) {}
    try { updateObjective(); } catch (e) {}
    try { updateUI(); } catch (e) {}
    try { renderActions(); } catch (e) {}
    showTurnBar();
  }

  /* ---------- 回合提示条 ---------- */
  function showTurnBar() {
    if (!started || !G) return;
    const seat = SEATS[G.turn];
    if (!seat) { turnBar.style.display = 'none'; return; }
    const mine = (mySeat !== null && G.turn === mySeat) || (isHost && G.turn === hostSeat);
    turnBar.style.display = 'block';
    turnBar.textContent = (G.over ? '🏁 对局结束' : (mine ? '👉 轮到你行动' : `等待 ${seat.name} 行动…`)) + `（第 ${G.round} 轮）`;
    turnBar.style.background = mine ? '#2c7a2a' : '#1d2733';
  }
  setInterval(showTurnBar, 500);

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
