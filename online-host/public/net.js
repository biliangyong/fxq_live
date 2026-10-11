/* ============================================================
 * 飞行棋 · 联机层（主机权威）
 * ------------------------------------------------------------
 * 本文件在游戏主脚本之后加载，复用单机版全部规则与渲染函数。
 *
 * 主机：运行完整游戏，定时广播状态快照。
 * 观众：按快照渲染棋盘，把自己的操作转发给主机执行。
 * ============================================================ */
(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  let myId = null;
  let isHost = false;
  let roomId = null;
  let mySeat = null;
  let hostSeat = null;
  let hostAssign = null;
  let started = false;
  let bypass = false;
  let viewerSeated = false;
  let lastSeatsKey = '';
  let lastEndKey = '';
  let hostSnapTimer = null;
  const SESSION_KEY = 'fxq-online-session-v1';
  let savedSession = loadSession();
  let pendingJoin = null;

  function loadSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!value || typeof value !== 'object') return null;
      return {
        room: String(value.room || '').trim(),
        name: String(value.name || '').trim(),
        token: String(value.token || '').trim(),
        auto: value.auto !== false,
      };
    } catch (e) {
      return null;
    }
  }

  function saveSession(next) {
    savedSession = next;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch (e) {}
  }

  function requestJoin(payload) {
    pendingJoin = payload;
    if (socket.connected) flushPendingJoin();
  }

  function flushPendingJoin() {
    if (!pendingJoin) return;
    const payload = pendingJoin;
    pendingJoin = null;
    socket.emit('join', payload);
  }

  function showReconnectState() {
    if (savedSession && savedSession.name) $('netName').value = savedSession.name;
    if (savedSession && savedSession.room) {
      $('netRoom').value = savedSession.room;
      roomId = savedSession.room;
      $('netRoomLabel').textContent = savedSession.room;
    }
    $('joinForm').style.display = 'none';
    $('lobbyPanel').style.display = 'block';
    $('netMsg2').textContent = '正在恢复上次的座位和对局…';
  }

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
  .netMember.offline{opacity:.55}
  .netMember select{padding:4px;border-radius:8px;border:1px solid #d5dbe3;font-size:12px}
  .netMember.host{outline:2px solid #f0b400}
  .netBadge{font-size:11px;padding:1px 6px;border-radius:6px;background:#e3f0fb;color:#1f7fd1}
  #netMsg{font-size:12px;color:#e04a3a;min-height:16px;margin-top:8px}
  #netTurn{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9998;background:#1d2733;color:#fff;
    padding:8px 18px;border-radius:20px;font-size:14px;display:none;box-shadow:0 8px 24px rgba(20,30,40,.25)}
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

  /* ---------- 连接与大厅 ---------- */
  $('netJoin').onclick = () => {
    const name = $('netName').value.trim();
    roomId = $('netRoom').value.trim() || 'default';
    const sameRoomToken = savedSession && savedSession.room === roomId ? savedSession.token : '';
    saveSession({ room: roomId, name, token: sameRoomToken || '', auto: true });
    requestJoin({ room: roomId, name, reconnectToken: sameRoomToken || undefined });
    $('joinForm').style.display = 'none';
    $('lobbyPanel').style.display = 'block';
    $('netRoomLabel').textContent = roomId;
    $('netMsg2').textContent = '';
  };
  socket.on('connect', () => {
    if (savedSession && savedSession.auto && savedSession.token && savedSession.room) {
      showReconnectState();
      requestJoin({
        room: savedSession.room,
        name: savedSession.name || $('netName').value.trim() || '玩家',
        reconnectToken: savedSession.token,
      });
      return;
    }
    flushPendingJoin();
  });
  socket.on('you', (d) => {
    myId = d.id;
    isHost = !!d.isHost;
    roomId = d.room || roomId;
    const name = $('netName').value.trim() || (savedSession && savedSession.name) || '玩家';
    if (d.token) saveSession({ room: roomId, name, token: d.token, auto: true });
    if (d.resumed) $('netMsg2').textContent = '已重新连接，正在恢复对局。';
  });
  socket.on('err', (m) => { $('netMsg').textContent = m; $('netMsg2').textContent = m; });
  socket.on('lobby', (st) => renderLobby(st));
  socket.on('start', ({ assign }) => startMatch(assign));
  socket.on('resume', ({ assign, snapshot } = {}) => resumeMatch(assign, snapshot));
  socket.on('alert', (payload) => {
    if (!payload || bypass) return;
    showStatusAlert(payload.icon || 'ℹ️', payload.text || '', payload.kind || 'info');
  });
  socket.on('act', handleRemoteAction);
  socket.on('command', handleRemoteCommand);

  function renderLobby(st) {
    const wrap = $('netMembers');
    wrap.innerHTML = '';
    st.members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'netMember' + (m.isHost ? ' host' : '') + (m.connected === false ? ' offline' : '');
      const mine = m.id === myId;
      const rolePool = m.faction === 'ghost' ? ROLE_POOLS.ghost : ROLE_POOLS.human;
      row.innerHTML = `<span class="nm">${esc(m.name)}</span>
        ${m.isHost ? '<span class="netBadge">主机</span>' : ''}
        ${m.connected === false ? '<span class="netBadge">离线</span>' : ''}
        <select data-f="faction" ${mine ? '' : 'disabled'}>
          <option value="ghost" ${m.faction === 'ghost' ? 'selected' : ''}>👻 鬼</option>
          <option value="human" ${m.faction === 'human' ? 'selected' : ''}>✈ 人</option>
        </select>
        <select data-f="role" ${mine ? '' : 'disabled'}>
          ${rolePool.map((r) => `<option value="${r.id}" ${m.roleId === r.id ? 'selected' : ''}>${r.charName}</option>`).join('')}
        </select>`;
      if (mine) {
        row.querySelector('[data-f="faction"]').onchange = (e) => {
          const nextPool = e.target.value === 'ghost' ? ROLE_POOLS.ghost : ROLE_POOLS.human;
          socket.emit('pick', { faction: e.target.value, roleId: nextPool[0].id });
        };
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
  function startMatch(assign) {
    hostAssign = assign;
    started = true;
    mySeat = null;
    lastEndKey = '';
    lobby.style.display = 'none';
    setupModal.classList.add('hidden');
    endModal.classList.add('hidden');
    clearStatusAlerts();
    const me = assign.find((a) => a.id === myId);
    if (isHost) startAsHost(assign, me ? me.seat : 0);
    else startAsViewer(assign, me ? me.seat : null);
  }

  function resumeMatch(assign, snapshot) {
    if (!Array.isArray(assign)) return;
    hostAssign = assign;
    started = true;
    mySeat = null;
    lastEndKey = '';
    lobby.style.display = 'none';
    setupModal.classList.add('hidden');
    endModal.classList.add('hidden');
    clearStatusAlerts();
    const me = assign.find((a) => a.id === myId);
    mySeat = me ? me.seat : null;

    if (isHost) {
      hostSeat = mySeat === null ? 0 : mySeat;
      mySeat = hostSeat;
      installSeatApi();
      applyRoleAssignment(assign);

      // 页面刷新后从服务器缓存恢复；同一页面短暂断网时保留更新的本地状态。
      if (typeof G === 'undefined' || !G) {
        if (snapshot) {
          if (Array.isArray(snapshot.seats)) viewerBuildSeats(snapshot.seats);
          applySnapshot(snapshot);
        } else {
          startGame();
          applySeatNames(assign);
        }
      }
      installHostRuntime();
      $('netMsg2').textContent = '已重新连接，恢复为主机。';
      return;
    }

    installSeatApi();
    installInputBridge();
    if (snapshot) applySnapshot(snapshot);
    else startAsViewer(assign, mySeat);
    $('netMsg2').textContent = '已重新连接，座位和角色已恢复。';
    showTurnBar();
  }

  /* ============ 主机 ============ */
  function startAsHost(assign, seat) {
    hostSeat = seat;
    mySeat = seat;
    installSeatApi();
    applyRoleAssignment(assign);
    startGame();
    applySeatNames(assign);
    installHostRuntime();
  }

  function installHostRuntime() {
    wrapHostGuards();
    installInputBridge();

    window.netEmitStatusAlert = (icon, text, kind) => socket.emit('alert', { icon, text, kind });
    clearInterval(hostSnapTimer);
    hostSnapTimer = setInterval(() => {
      if (started && G) socket.emit('snap', makeSnapshot());
    }, 250);
    socket.emit('snap', makeSnapshot());
    showTurnBar();
  }

  function applyRoleAssignment(assign) {
    rolePick.ghost = assign[0].roleId;
    const colors = ['green', 'yellow', 'blue'];
    assign.slice(1).forEach((a, i) => { rolePick[colors[i]] = a.roleId; });
  }

  function applySeatNames(assign) {
    assign.forEach((a, i) => {
      if (!SEATS[i]) return;
      SEATS[i].name = a.name || SEATS[i].name;
      SEATS[i].seat = a.seat;
    });
    renderPieces();
    renderActions();
    updateUI();
  }

  const LOCAL_FNS = ['doRoll', 'choosePlus', 'undoPlus', 'endTurn', 'declineLongJump', 'confirmLongJump',
    'enterLane', 'cancelHook', 'chooseHookTarget', 'chooseMindWarningDir', 'placeDoll', 'swapWithDoll',
    'useAdjacentAttack', 'chooseDir', 'chooseExtraDir', 'declineReaction'];

  function hostMayUseReaction(fn) {
    return !!(G && G.pendingReaction && G.pendingReaction.ownerSeat === hostSeat
      && (fn === 'useSkill' || fn === 'declineReaction'));
  }

  // 「随时可用」的技能（如军人晕眩弹）：技能所有者可在任意回合直接插入，无需询问
  function isInstantSkill(skill) {
    return !!skill && skill.type === 'stunShot';
  }
  function instantSkillOwnedBy(id, seat) {
    const skill = findSkillById(String(id || ''));
    if (!isInstantSkill(skill)) return false;
    const owner = skillSeat(skill);
    return !!owner && SEATS.indexOf(owner) === Number(seat);
  }

  function wrapHostGuards() {
    LOCAL_FNS.forEach((name) => {
      const orig = window[name];
      if (typeof orig !== 'function' || orig.__fxqGuard) return;
      const guarded = function (...args) {
        if (started && G && G.turn !== hostSeat && !bypass && !hostMayUseReaction(name)) return;
        return orig.apply(this, args);
      };
      guarded.__fxqGuard = true;
      window[name] = guarded;
    });
    const origUse = window.useSkill;
    if (typeof origUse === 'function' && !origUse.__fxqGuard) {
      const guardedUse = function (...args) {
        if (started && G && !bypass) {
          const owner = skillSeat(args[0]);
          const ownerSeat = owner ? SEATS.indexOf(owner) : -1;
          const instant = ownerSeat === hostSeat && isInstantSkill(args[0]);
          if (!instant) {
            if (ownerSeat !== hostSeat && !hostMayUseReaction('useSkill')) return;
            if (G.turn !== hostSeat && !hostMayUseReaction('useSkill')) return;
          }
        }
        return origUse.apply(this, args);
      };
      guardedUse.__fxqGuard = true;
      window.useSkill = guardedUse;
    }
  }

  function handleRemoteAction({ fn, args, fromSeat } = {}) {
    if (!isHost || !started || !G || G.over) return;
    if (fromSeat === undefined) return;
    const pending = G.pendingReaction;
    const instantFromSender = fn === 'useSkill' && instantSkillOwnedBy(args && args[0], fromSeat);
    if (pending) {
      const reactionAction = fromSeat === pending.ownerSeat
        && (fn === 'useSkill' || fn === 'declineReaction');
      if (!reactionAction && !instantFromSender) return;
      if (reactionAction && fn === 'useSkill') {
        const skill = findSkillById(String((args && args[0]) || ''));
        if (!skill || skill.id !== pending.skillId || skillSeat(skill) !== SEATS[pending.ownerSeat]) return;
      }
    } else {
      if (!instantFromSender && fromSeat !== G.turn) return;
      if (fn === 'useSkill' && !instantFromSender) {
        const skill = findSkillById(String((args && args[0]) || ''));
        if (!skill || skillSeat(skill) !== SEATS[fromSeat]) return;
      }
    }
    if (!REMOTE_ACTIONS.has(fn)) return;
    bypass = true;
    try {
      applyRemoteAction(fn, Array.isArray(args) ? args : []);
    } finally {
      bypass = false;
    }
  }

  function handleRemoteCommand(command) {
    if (!isHost || !started || !command) return;
    if (command.type === 'restart') restartAssignedGame();
  }

  function restartAssignedGame() {
    if (!hostAssign) return;
    endModal.classList.add('hidden');
    clearStatusAlerts();
    applyRoleAssignment(hostAssign);
    startGame();
    applySeatNames(hostAssign);
    socket.emit('snap', makeSnapshot());
  }

  const REMOTE_ACTIONS = new Set(['useSkill', 'moveTarget', ...LOCAL_FNS]);

  function applyRemoteAction(fn, args) {
    if (fn === 'useSkill') {
      const skill = findSkillById(String(args[0] || ''));
      if (skill) useSkill(skill);
      return;
    }
    if (fn === 'declineReaction') {
      declineReaction(true);
      return;
    }
    if (fn === 'moveTarget') {
      doMoveTarget(args[0]);
      return;
    }
    const target = window[fn];
    if (typeof target === 'function' && REMOTE_ACTIONS.has(fn)) target(...args);
  }

  function findSkillById(id) {
    for (const seat of SEATS) {
      const skill = (seat.skills || []).find((item) => item.id === id);
      if (skill) return skill;
    }
    return null;
  }

  function doMoveTarget(raw) {
    if (!G || G.animating || !['dir', 'post', 'jump'].includes(G.phase) || !raw) return;
    const p = G.phase === 'jump' ? jumpPiece() : seatPiece();
    if (!p || p.status !== 'free') return;
    const target = moveDestinationOptions(p).find((option) => sameTarget(option, raw));
    if (!target) return;
    if (target.kind === 'noJump') return declineLongJump();
    if (target.kind === 'jump') return confirmLongJump(target.target);
    if (target.kind === 'lane') return enterLane();
    if (p.seat.isGhost && G.phase === 'dir') {
      G.dice = Number(target.dice);
      G.plusUsed = !!target.plusUsed;
      setDice(G.dice);
    }
    if (G.pendingExtra > 0) chooseExtraDir(Number(target.dir));
    else chooseDir(Number(target.dir));
  }

  function sameTarget(a, b) {
    if (!a || !b || a.kind !== String(b.kind || '')) return false;
    if (a.kind === 'noJump' || a.kind === 'lane') return true;
    if (a.kind === 'jump') return Number(a.target) === Number(b.target);
    if (a.kind === 'move') {
      return Number(a.dir) === Number(b.dir)
        && Number(a.dice) === Number(b.dice)
        && !!a.plusUsed === (String(b.plus) === '1');
    }
    return false;
  }

  function makeSnapshot() {
    const end = G && G.over ? {
      emoji: $('#endEmoji').textContent,
      title: $('#endText').textContent,
      sub: $('#endSub').textContent,
    } : null;
    return {
      seats: SEATS.map((seat) => ({
        name: seat.name,
        isGhost: seat.isGhost,
        color: seat.color,
        roleId: seat.roleKey,
        charName: seat.charName,
        roleDesc: seat.roleDesc,
        skills: (seat.skills || []).map((skill) => ({ ...skill })),
        passives: (seat.passives || []).map((passive) => ({ ...passive })),
      })),
      pieces: pieces.map(pieceSnapshot),
      g: JSON.parse(JSON.stringify(G)),
      logs: logs.slice(0, 4),
      end,
    };
  }

  function pieceSnapshot(p) {
    return {
      loc: p.loc ? { ...p.loc } : null,
      status: p.status,
      color: p.color,
      carryT: p.carryT,
      prisonT: p.prisonT,
      holdTimer: !!p.holdTimer,
      stunTurns: p.stunTurns || 0,
      slowTurns: p.slowTurns || 0,
      flashTurns: p.flashTurns || 0,
      shield: p.shield || 0,
      immune: p.immune || 0,
    };
  }

  /* ============ 观众 ============ */
  const FORWARD = {
    doRoll: () => [],
    choosePlus: (use) => [!!use],
    undoPlus: () => [],
    endTurn: () => [],
    declineLongJump: () => [],
    confirmLongJump: (target) => [Number(target)],
    enterLane: () => [],
    cancelHook: () => [],
    chooseHookTarget: (index) => [Number(index)],
    chooseMindWarningDir: (dir) => [Number(dir)],
    placeDoll: () => [],
    swapWithDoll: (index) => [Number(index)],
    useAdjacentAttack: (index) => [Number(index)],
    chooseDir: (dir) => [Number(dir)],
    chooseExtraDir: (dir) => [Number(dir)],
    useSkill: (id) => [String(id)],
    declineReaction: () => [],
  };

  function startAsViewer(assign, seat) {
    mySeat = seat;
    viewerBuildSeats(assign);
    installInputBridge();
    installSeatApi();
    showTurnBar();
  }

  function installSeatApi() {
    window.netMySeat = () => (isHost ? hostSeat : mySeat);
    window.netIsMySeat = (seat) => Number(seat) === Number(window.netMySeat());
    window.netIsHost = () => isHost;
    window.netMatchActive = () => started;
    window.netRefreshTurnBar = showTurnBar;
  }

  function viewerBuildSeats(seats) {
    SEATS = seats.map((source) => {
      const owner = source.isGhost ? 'ghost' : source.color;
      const seat = makeSeat(source.color, roleById(owner, source.roleId || source.roleKey), source.isGhost);
      seat.name = source.name || seat.name;
      seat.charName = source.charName || seat.charName;
      seat.roleDesc = source.roleDesc || seat.roleDesc;
      if (Array.isArray(source.skills)) seat.skills = source.skills.map((skill) => ({ ...skill }));
      if (Array.isArray(source.passives)) seat.passives = source.passives.map((passive) => ({ ...passive }));
      return seat;
    });
    createPieces();
    viewerSeated = true;
    lastSeatsKey = seatKey(seats);
  }

  function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.g || !Array.isArray(snapshot.pieces) || !Array.isArray(snapshot.seats)) return;
    const key = seatKey(snapshot.seats);
    if (!viewerSeated || key !== lastSeatsKey) viewerBuildSeats(snapshot.seats);
    syncSeats(snapshot.seats);
    syncPieces(snapshot.pieces);
    G = snapshot.g;
    logs.length = 0;
    (snapshot.logs || []).forEach((line) => logs.push(line));
    if (statusEl) {
      statusEl.innerHTML = logs.map((line, index) => '<div' + (index === 0 ? ' style="font-weight:700"' : '') + '>' + line + '</div>').join('');
    }
    try { renderPieces(); } catch (e) {}
    try { renderDolls(); } catch (e) {}
    try { setDice(G.dice); } catch (e) {}
    try { updateObjective(); } catch (e) {}
    try { updateUI(); } catch (e) {}
    try { renderActions(); } catch (e) {}
    applyEndState(snapshot.end);
    showTurnBar();
  }

  function syncSeats(seats) {
    seats.forEach((source, index) => {
      const seat = SEATS[index];
      if (!seat) return;
      seat.name = source.name || seat.name;
      seat.charName = source.charName || seat.charName;
      seat.roleDesc = source.roleDesc || seat.roleDesc;
      if (Array.isArray(source.skills)) seat.skills = source.skills.map((skill) => ({ ...skill }));
      if (Array.isArray(source.passives)) seat.passives = source.passives.map((passive) => ({ ...passive }));
    });
  }

  function syncPieces(list) {
    list.forEach((source, index) => {
      const piece = pieces[index];
      if (!piece) return;
      piece.loc = source.loc ? { ...source.loc } : null;
      piece.status = source.status;
      piece.carryT = source.carryT || 0;
      piece.prisonT = source.prisonT || 0;
      piece.holdTimer = !!source.holdTimer;
      piece.stunTurns = source.stunTurns || 0;
      piece.slowTurns = source.slowTurns || 0;
      piece.flashTurns = source.flashTurns || 0;
      piece.shield = source.shield || 0;
      piece.immune = source.immune || 0;
    });
  }

  function seatKey(seats) {
    return JSON.stringify(seats.map((seat) => ({
      name: seat.name,
      isGhost: !!seat.isGhost,
      color: seat.color,
      roleId: seat.roleId || seat.roleKey,
    })));
  }

  function applyEndState(end) {
    if (!end) {
      lastEndKey = '';
      endModal.classList.add('hidden');
      return;
    }
    const key = JSON.stringify(end);
    if (key === lastEndKey) return;
    lastEndKey = key;
    $('#endEmoji').textContent = end.emoji || '🏆';
    $('#endText').textContent = end.title || '对局结束';
    $('#endSub').textContent = end.sub || '';
    endModal.classList.remove('hidden');
  }

  /* ---------- 统一输入桥 ---------- */
  let bridgeInstalled = false;
  function installInputBridge() {
    if (bridgeInstalled) return;
    bridgeInstalled = true;
    document.addEventListener('click', (event) => {
      const again = event.target.closest && event.target.closest('#againBtn, #resetBtn');
      if (again && started) {
        event.preventDefault();
        event.stopImmediatePropagation();
        socket.emit('command', { type: 'restart' });
        return;
      }

      const actionNode = event.target.closest && event.target.closest('[data-net-action]');
      const moveNode = event.target.closest && event.target.closest('.move-target');
      if (!actionNode && !moveNode) return;
      const fn = actionNode ? actionNode.dataset.netAction : null;

      if (isHost) {
        if (!G) return;
        const reaction = G.pendingReaction && G.pendingReaction.ownerSeat === hostSeat
          && (fn === 'useSkill' || fn === 'declineReaction');
        if (G.turn === hostSeat || reaction) return;
        if (fn === 'useSkill' && actionNode) {
          let rawArgs = [];
          try { rawArgs = JSON.parse(actionNode.dataset.netArgs || '[]'); } catch (e) {}
          if (instantSkillOwnedBy(rawArgs[0], hostSeat)) return;   // 主机本人的常亮技能
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (moveNode) {
        socket.emit('act', { fn: 'moveTarget', args: [moveTargetPayload(moveNode)] });
        return;
      }
      if (!FORWARD[fn]) return;
      let rawArgs = [];
      try { rawArgs = JSON.parse(actionNode.dataset.netArgs || '[]'); } catch (e) {}
      socket.emit('act', { fn, args: FORWARD[fn](...rawArgs) });
    }, true);
  }

  function moveTargetPayload(node) {
    return {
      kind: node.getAttribute('data-target-kind'),
      target: node.getAttribute('data-target'),
      dir: node.getAttribute('data-dir'),
      dice: node.getAttribute('data-dice'),
      plus: node.getAttribute('data-plus'),
    };
  }

  socket.on('snap', applySnapshot);

  /* ---------- 回合提示条 ---------- */
  function showTurnBar() {
    if (!started || !G || !SEATS[G.turn]) {
      turnBar.style.display = 'none';
      return;
    }
    const seat = SEATS[G.turn];
    const pending = G.pendingReaction;
    const reactionOwner = pending ? SEATS[pending.ownerSeat] : null;
    const mine = pending
      ? pending.ownerSeat === (isHost ? hostSeat : mySeat)
      : (mySeat !== null && G.turn === mySeat) || (isHost && G.turn === hostSeat);
    turnBar.style.display = 'block';
    if (G.over) {
      turnBar.textContent = '🏁 对局结束';
      turnBar.style.background = '#1d2733';
      return;
    }
    if (pending && reactionOwner) {
      turnBar.textContent = (mine ? '👉 轮到你决定：' : `等待 ${reactionOwner.name} 决定：`) + (pending.skillName || '技能') + `（第 ${G.round} 轮）`;
      turnBar.style.background = mine ? '#b77900' : '#1d2733';
      return;
    }
    turnBar.textContent = (mine ? '👉 轮到你行动' : `等待 ${seat.name} 行动…`) + `（第 ${G.round} 轮）`;
    turnBar.style.background = mine ? '#2c7a2a' : '#1d2733';
  }
  setInterval(showTurnBar, 500);

  if (savedSession && savedSession.auto && savedSession.token && savedSession.room) {
    showReconnectState();
    requestJoin({
      room: savedSession.room,
      name: savedSession.name || $('netName').value.trim() || '玩家',
      reconnectToken: savedSession.token,
    });
  }

  function esc(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[char]));
  }
})();
