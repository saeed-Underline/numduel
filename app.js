(function () {
  'use strict';

  // Excludes 0/1/I/O/L to avoid visual ambiguity.
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 4;

  // Broker auto-detection:
  // - localhost / 127.0.0.1 / file:// : use the PeerJS public broker (no setup for local dev).
  // - any other hostname: assume a self-hosted broker is reachable at /peerjs on the same origin.
  const BROKER_OPTS = (function () {
    const h = location.hostname;
    if (!h || h === 'localhost' || h === '127.0.0.1') return null;
    return {
      host: h,
      port: location.port ? Number(location.port) : (location.protocol === 'https:' ? 443 : 80),
      path: '/peerjs',
      secure: location.protocol === 'https:',
    };
  })();

  function newPeer(id) {
    if (id && BROKER_OPTS) return new Peer(id, BROKER_OPTS);
    if (id) return new Peer(id);
    if (BROKER_OPTS) return new Peer(BROKER_OPTS);
    return new Peer();
  }

  // Each game gets its own peer-ID prefix so a code from one game can't accidentally
  // connect to a host of another. minPlayers/maxPlayers: 2/2 means a 1-on-1 game
  // (existing path); maxPlayers > 2 takes the Silver-style lobby path.
  const GAMES = {
    guess4: {
      title: 'Guess 4 Digit',
      tagline: "Crack your opponent's 4-digit number with color-coded feedback.",
      peerPrefix: 'guess4-v1-',
      fixedDigits: 4,
      minPlayers: 2,
      maxPlayers: 2,
    },
    hilo: {
      title: 'Higher or Lower',
      tagline: 'Each guess gets a higher / lower hint until someone hits the number.',
      peerPrefix: 'hilo-v1-',
      fixedDigits: null,
      minPlayers: 2,
      maxPlayers: 2,
    },
    silver: {
      title: 'Silver',
      tagline: 'Up to four players. Game logic coming soon.',
      peerPrefix: 'silver-v1-',
      minPlayers: 2,
      maxPlayers: 4,
    },
  };

  const state = {
    game: null,           // 'guess4' | 'hilo' | 'silver'
    role: null,           // 'host' | 'guest'
    peer: null,
    conn: null,           // guest's connection to host (single-conn path)
    conns: new Map(),     // host: peerId -> DataConnection (multi-player path)
    code: null,
    digits: 4,            // Guess 4 / Higher-or-Lower digit length
    mySecret: null,
    iAmReady: false,
    opponentReady: false,
    myTurn: false,
    gameOver: false,
    playerCount: 2,       // host's chosen N for Silver
    players: [],          // [{id, name, isHost}]; host populates, broadcasts, guest mirrors
  };

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function setText(id, text) { $(id).textContent = text; }
  function show(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = s.dataset.screen !== name;
    });
  }
  function isMultiPlayer() {
    return !!(state.game && GAMES[state.game].maxPlayers > 2);
  }

  // ---------- Code generation ----------
  function genCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
      s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return s;
  }

  // ---------- Menu navigation ----------
  function selectGame(gameId) {
    state.game = gameId;
    const g = GAMES[gameId];
    setText('game-menu-title', g.title);
    setText('game-menu-tagline', g.tagline);
    show('game-menu');
  }

  function backToMainMenu() {
    state.game = null;
    quitConnection();
    show('main-menu');
  }

  function backToGameMenu() {
    quitConnection();
    if (state.game) {
      const g = GAMES[state.game];
      setText('game-menu-title', g.title);
      setText('game-menu-tagline', g.tagline);
      show('game-menu');
    } else {
      show('main-menu');
    }
  }

  // ---------- Hosting ----------
  function host() {
    if (!state.game) return;
    state.role = 'host';
    if (isMultiPlayer()) {
      enterPlayersPick();
    } else {
      show('hosting');
      setText('host-status', 'Connecting…');
      $('room-code').textContent = '····';
      tryHost(5);
    }
  }

  function tryHost(retriesLeft) {
    const code = genCode();
    const peer = newPeer(GAMES[state.game].peerPrefix + code);

    peer.on('open', () => {
      state.peer = peer;
      state.code = code;
      $('room-code').textContent = code;
      if (isMultiPlayer()) {
        updateHostingLobby();
      } else {
        setText('host-status', 'Waiting for opponent…');
      }
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (isMultiPlayer()) {
          onMultiPlayerGuestJoined(conn);
        } else {
          state.conn = conn;
          wireConnection(conn);
        }
      });
    });

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && retriesLeft > 0) {
        peer.destroy();
        tryHost(retriesLeft - 1);
      } else if (err.type === 'peer-unavailable') {
        // not relevant for host
      } else {
        setText('host-status', 'Error: ' + err.type);
      }
    });
  }

  // ---------- Joining ----------
  function joinScreen() {
    if (!state.game) return;
    state.role = 'guest';
    show('joining');
    setText('join-status', '');
    $('join-code').value = '';
    setTimeout(() => $('join-code').focus(), 50);
  }

  function connectTo(code) {
    setText('join-status', 'Connecting…');
    const peer = newPeer();
    state.peer = peer;
    state.code = code;

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        setText('join-status', 'No game found with code ' + code);
      } else {
        setText('join-status', 'Error: ' + err.type);
      }
    });

    peer.on('open', () => {
      const conn = peer.connect(GAMES[state.game].peerPrefix + code, { reliable: true });
      state.conn = conn;
      conn.on('open', () => wireConnection(conn));
    });
  }

  // ---------- Connection wiring ----------
  // Used by both:
  //   - Single-conn games (guest's connection to host, OR host's connection to its one guest)
  //   - Silver guests' connection to the host (host side uses onMultiPlayerGuestJoined instead)
  function wireConnection(conn) {
    conn.on('data', handleMessage);
    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);

    if (state.game === 'silver') {
      // Silver guest enters the lobby waiting state; transitions when host broadcasts 'start'.
      enterGuestLobby();
    } else if (state.game === 'hilo') {
      enterDigitsPick(state.role === 'host');
    } else {
      state.digits = GAMES.guess4.fixedDigits;
      enterSetup();
    }
  }

  function send(msg) {
    if (state.conn && state.conn.open) state.conn.send(msg);
  }

  // Host: send to all guests. Guest: send to host. (Silver / multi-player.)
  function broadcast(msg) {
    if (state.role === 'host') {
      for (const conn of state.conns.values()) {
        if (conn.open) conn.send(msg);
      }
    } else if (state.conn && state.conn.open) {
      state.conn.send(msg);
    }
  }

  // ---------- Multi-player host: lobby management ----------
  function onMultiPlayerGuestJoined(conn) {
    state.conns.set(conn.peer, conn);
    conn.on('data', (msg) => handleHostInboundMessage(conn.peer, msg));
    conn.on('close', () => onGuestLeft(conn.peer));
    conn.on('error', () => onGuestLeft(conn.peer));

    const slot = state.players.length + 1;
    state.players.push({ id: conn.peer, name: 'Player ' + slot, isHost: false });

    broadcast({ type: 'lobby', players: state.players, playerCount: state.playerCount });
    updateHostingLobby();

    if (state.players.length === state.playerCount) {
      broadcast({ type: 'start', players: state.players });
      enterSilverPlaceholder();
    }
  }

  function onGuestLeft(peerId) {
    if (!state.conns.has(peerId)) return;
    state.conns.delete(peerId);
    state.players = state.players.filter(p => p.id !== peerId);
    // Renumber remaining guests so slots stay 1..N.
    let slot = 1;
    state.players = state.players.map(p => ({ ...p, name: 'Player ' + (slot++) }));
    broadcast({ type: 'lobby', players: state.players, playerCount: state.playerCount });
    broadcast({ type: 'player-left', id: peerId });
    updateHostingLobby();
    updateSilverRoster();
  }

  // ---------- Players-pick (Silver host) ----------
  function enterPlayersPick() {
    setText('players-pick-title', 'How many players?');
    setText('players-pick-hint', 'Pick 2, 3, or 4. Game starts once everyone joins.');
    show('players-pick');
  }

  function onPlayersPick(n) {
    state.playerCount = n;
    state.players = [{ id: 'host', name: 'Player 1', isHost: true }];
    state.conns = new Map();
    show('hosting');
    $('room-code').textContent = '····';
    setText('host-status', 'Connecting…');
    tryHost(5);
  }

  // Host's hosting screen status + roster.
  function updateHostingLobby() {
    if (!isMultiPlayer()) return;
    const joined = state.players.length;
    const need = state.playerCount;
    if (joined < need) {
      setText('host-status', 'Player ' + joined + ' of ' + need + ' joined. Waiting for ' + (need - joined) + ' more…');
    } else {
      setText('host-status', 'All players joined. Starting…');
    }
    renderRoster('host-roster', state.players);
  }

  // ---------- Multi-player guest: lobby ----------
  function enterGuestLobby() {
    setText('join-status', 'Connected. Waiting for host…');
    // Note: stays on `joining` screen; the lobby element below the input is shown via JS.
    $('join-lobby').hidden = false;
    renderRoster('guest-roster', state.players);
    setText('guest-lobby-status', state.players.length
      ? state.players.length + ' / ' + (state.playerCount || '?') + ' players'
      : 'Connecting to lobby…');
    // Hide the connect form now that we're connected.
    $('join-code').disabled = true;
    $('btn-connect').disabled = true;
  }

  function updateGuestLobby() {
    if (state.game !== 'silver') return;
    renderRoster('guest-roster', state.players);
    setText('guest-lobby-status', state.players.length + ' / ' + (state.playerCount || '?') + ' players');
  }

  function renderRoster(listId, players) {
    const ul = $(listId);
    if (!ul) return;
    ul.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'roster-row';
      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = p.name;
      li.appendChild(name);
      if (p.isHost) {
        const tag = document.createElement('span');
        tag.className = 'roster-tag';
        tag.textContent = 'Host';
        li.appendChild(tag);
      }
      ul.appendChild(li);
    });
  }

  // ---------- Higher or Lower: digit count picker ----------
  function enterDigitsPick(asHost) {
    if (asHost) {
      setText('digits-pick-title', 'Choose number length');
      setText('digits-pick-hint', 'How many digits should each secret number have?');
      $('digits-options').hidden = false;
      setText('digits-status', '');
    } else {
      setText('digits-pick-title', 'Connected!');
      setText('digits-pick-hint', 'Waiting for the host to choose number length.');
      $('digits-options').hidden = true;
      setText('digits-status', '');
    }
    show('digits-pick');
  }

  function onDigitsPick(n) {
    state.digits = n;
    send({ type: 'digits', value: n });
    enterSetup();
  }

  // ---------- Setup (Guess 4 / Higher or Lower) ----------
  function enterSetup() {
    state.iAmReady = false;
    state.opponentReady = false;
    state.gameOver = false;
    state.mySecret = null;

    const placeholder = '•'.repeat(state.digits);
    const input = $('secret-input');
    input.value = '';
    input.setAttribute('maxlength', String(state.digits));
    input.setAttribute('placeholder', placeholder);
    setText('setup-hint', state.digits + ' digits. Your opponent will try to guess this.');
    $('btn-ready').disabled = false;
    setText('setup-status', 'Enter your number and tap Ready.');
    show('setup');
    setTimeout(() => input.focus(), 50);
  }

  function onReady() {
    const v = $('secret-input').value.trim();
    const re = new RegExp('^\\d{' + state.digits + '}$');
    if (!re.test(v)) {
      setText('setup-status', 'Enter exactly ' + state.digits + ' digits.');
      return;
    }
    state.mySecret = v;
    state.iAmReady = true;
    $('btn-ready').disabled = true;
    send({ type: 'ready' });

    if (state.opponentReady) {
      maybeStart();
    } else {
      setText('setup-status', 'Waiting for opponent…');
    }
  }

  function maybeStart() {
    if (!(state.iAmReady && state.opponentReady)) return;
    if (state.role === 'host') {
      const firstPlayer = Math.random() < 0.5 ? 'host' : 'guest';
      send({ type: 'start', firstPlayer });
      startGame(firstPlayer === 'host');
    }
  }

  // ---------- Per-game UI ids ----------
  function gameIds() {
    if (state.game === 'guess4') {
      return {
        screen: 'game-guess4',
        secret: 'g4-my-secret',
        indicator: 'g4-turn-indicator',
        input: 'g4-guess-input',
        btn: 'btn-g4-guess',
        myList: 'g4-my-guesses',
        theirList: 'g4-their-guesses',
      };
    }
    return {
      screen: 'game-hilo',
      secret: 'hilo-my-secret',
      indicator: 'hilo-turn-indicator',
      input: 'hilo-guess-input',
      btn: 'btn-hilo-guess',
      myList: 'hilo-my-guesses',
      theirList: 'hilo-their-guesses',
    };
  }

  // ---------- Gameplay (Guess 4 / Higher or Lower) ----------
  function startGame(myTurn) {
    state.myTurn = myTurn;
    state.gameOver = false;

    const ids = gameIds();
    $(ids.myList).innerHTML = '';
    $(ids.theirList).innerHTML = '';
    const input = $(ids.input);
    input.value = '';
    input.setAttribute('maxlength', String(state.digits));
    input.setAttribute('placeholder', '•'.repeat(state.digits));
    $(ids.secret).textContent = state.mySecret;
    show(ids.screen);
    updateTurnUI();
  }

  function updateTurnUI() {
    const ids = gameIds();
    const indicator = $(ids.indicator);
    const input = $(ids.input);
    const btn = $(ids.btn);
    if (state.myTurn) {
      indicator.textContent = 'Your turn';
      indicator.classList.remove('waiting');
      input.disabled = false;
      btn.disabled = false;
      setTimeout(() => input.focus(), 50);
    } else {
      indicator.textContent = "Opponent's turn";
      indicator.classList.add('waiting');
      input.disabled = true;
      btn.disabled = true;
    }
  }

  function onGuess() {
    if (!state.myTurn || state.gameOver) return;
    const ids = gameIds();
    const v = $(ids.input).value.trim();
    const re = new RegExp('^\\d{' + state.digits + '}$');
    if (!re.test(v)) {
      $(ids.input).focus();
      return;
    }
    $(ids.input).value = '';
    send({ type: 'guess', digits: v });
    state.myTurn = false;
    $(ids.input).disabled = true;
    $(ids.btn).disabled = true;
    $(ids.indicator).textContent = 'Checking…';
    $(ids.indicator).classList.add('waiting');
  }

  function handleOpponentGuess(digits) {
    if (state.game === 'guess4') {
      const feedback = scoreGuess(digits, state.mySecret);
      const won = feedback.every(c => c === 'green');
      appendGuess4Row('g4-their-guesses', digits, feedback);
      send({ type: 'result', digits, feedback, won });
      if (won) { state.gameOver = true; endGame(false, digits); }
      else { state.myTurn = true; updateTurnUI(); }
    } else {
      const hint = compareNumbers(digits, state.mySecret);
      const won = hint === 'correct';
      appendHiloRow('hilo-their-guesses', digits, hint);
      send({ type: 'result', digits, hint, won });
      if (won) { state.gameOver = true; endGame(false, digits); }
      else { state.myTurn = true; updateTurnUI(); }
    }
  }

  function handleResult(msg) {
    if (state.game === 'guess4') {
      appendGuess4Row('g4-my-guesses', msg.digits, msg.feedback);
    } else {
      appendHiloRow('hilo-my-guesses', msg.digits, msg.hint);
    }
    if (msg.won) { state.gameOver = true; endGame(true, msg.digits); }
    else { state.myTurn = false; updateTurnUI(); }
  }

  function appendGuess4Row(listId, digits, feedback) {
    const ul = $(listId);
    const li = document.createElement('li');
    li.className = 'guess-row';
    for (let i = 0; i < digits.length; i++) {
      const cell = document.createElement('span');
      cell.className = 'guess-cell ' + feedback[i];
      cell.textContent = digits[i];
      li.appendChild(cell);
    }
    ul.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function appendHiloRow(listId, digits, hint) {
    const ul = $(listId);
    const li = document.createElement('li');
    li.className = 'hilo-row';

    const num = document.createElement('span');
    num.className = 'hilo-digits';
    num.textContent = digits;
    li.appendChild(num);

    const tag = document.createElement('span');
    tag.className = 'hilo-hint ' + hint;
    if (hint === 'higher') {
      tag.innerHTML = '<span class="hilo-arrow">↑</span> Higher';
    } else if (hint === 'lower') {
      tag.innerHTML = '<span class="hilo-arrow">↓</span> Lower';
    } else {
      tag.textContent = 'Correct!';
    }
    li.appendChild(tag);

    ul.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // Wordle-style: greens first, then yellows that consume unmatched secret digits.
  function scoreGuess(guess, secret) {
    const len = guess.length;
    const result = new Array(len).fill('red');
    const used = new Array(len).fill(false);
    for (let i = 0; i < len; i++) {
      if (guess[i] === secret[i]) { result[i] = 'green'; used[i] = true; }
    }
    for (let i = 0; i < len; i++) {
      if (result[i] === 'green') continue;
      for (let j = 0; j < len; j++) {
        if (!used[j] && guess[i] === secret[j]) { result[i] = 'yellow'; used[j] = true; break; }
      }
    }
    return result;
  }

  function compareNumbers(guess, secret) {
    const g = parseInt(guess, 10);
    const s = parseInt(secret, 10);
    if (g === s) return 'correct';
    return s > g ? 'higher' : 'lower';
  }

  // ---------- Silver placeholder ----------
  function enterSilverPlaceholder() {
    show('game-silver');
    updateSilverRoster();
  }

  function updateSilverRoster() {
    if (state.game !== 'silver') return;
    renderRoster('silver-roster', state.players);
  }

  // ---------- Game over (Guess 4 / Higher or Lower) ----------
  function endGame(iWon, finalDigits) {
    show('gameover');
    const stage = $('gameover-stage');
    stage.classList.remove('won', 'lost');
    void stage.offsetWidth;
    stage.classList.add(iWon ? 'won' : 'lost');

    setText('gameover-title', iWon ? 'You won!' : 'You lost');
    setText('gameover-detail', iWon
      ? 'You cracked their number: ' + finalDigits
      : 'They guessed your number (' + state.mySecret + ') with ' + finalDigits);

    if (iWon) showConfetti();
    else clearConfetti();
  }

  function showConfetti() {
    const c = $('confetti');
    c.innerHTML = '';
    const colors = ['#22c55e', '#3b82f6', '#eab308', '#ef4444', '#a855f7'];
    const count = 28;
    for (let i = 0; i < count; i++) {
      const dot = document.createElement('span');
      dot.className = 'confetti-dot';
      dot.style.left = (Math.random() * 100) + '%';
      dot.style.background = colors[i % colors.length];
      dot.style.animationDelay = (Math.random() * 0.4).toFixed(2) + 's';
      dot.style.animationDuration = (1.4 + Math.random() * 0.9).toFixed(2) + 's';
      const size = 6 + Math.floor(Math.random() * 6);
      dot.style.width = size + 'px';
      dot.style.height = size + 'px';
      c.appendChild(dot);
    }
  }

  function clearConfetti() {
    $('confetti').innerHTML = '';
  }

  function onRematch() {
    send({ type: 'rematch' });
    enterSetup();
    setText('setup-status', 'Rematch! Pick a new number and tap Ready.');
  }

  // ---------- Connection lifecycle ----------
  function quitConnection() {
    // Clear state BEFORE destroying the peer, so close events fired during destroy()
    // see a cleaned-up state and don't re-show the disconnect banner.
    const peer = state.peer;
    state.peer = null;
    state.conn = null;
    state.role = null;
    state.gameOver = false;
    state.iAmReady = false;
    state.opponentReady = false;
    state.playerCount = 2;
    state.players = [];

    if (state.conns) {
      for (const conn of state.conns.values()) {
        try { conn.close(); } catch (_) {}
      }
      state.conns.clear();
    }

    // Reset the join screen's lobby UI in case we left mid-Silver-lobby.
    const joinLobby = $('join-lobby');
    if (joinLobby) joinLobby.hidden = true;
    const joinCode = $('join-code');
    if (joinCode) joinCode.disabled = false;
    const btnConnect = $('btn-connect');
    if (btnConnect) btnConnect.disabled = false;

    $('disconnect-banner').hidden = true;
    clearConfetti();
    if (peer) { try { peer.destroy(); } catch (_) {} }
  }

  function handleDisconnect() {
    if (state.gameOver) return;
    if (!state.peer) return;
    $('disconnect-banner').hidden = false;
  }

  // ---------- Message routers ----------
  // Host receives messages from individual guests (Silver). Phase 1: nothing
  // game-specific yet — guests don't send actionable messages during the lobby.
  function handleHostInboundMessage(fromId, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Phase 2 (Silver gameplay) will dispatch on msg.type here and may relay
    // via broadcast({ ...msg, from: fromId }).
  }

  // Guest's main router (and the existing 1-on-1 router for Guess 4 / Higher or Lower).
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      // ---- Multi-player (Silver) lobby messages, guest-side ----
      case 'lobby':
        state.players = msg.players || [];
        state.playerCount = msg.playerCount || state.playerCount;
        updateGuestLobby();
        break;
      case 'player-left':
        // Roster already arrives via the matching 'lobby' broadcast; nothing extra to do for v1.
        break;

      // ---- 1-on-1 game messages (Guess 4 / Higher or Lower) ----
      case 'digits':
        state.digits = msg.value;
        enterSetup();
        break;
      case 'ready':
        state.opponentReady = true;
        if (state.iAmReady) maybeStart();
        else setText('setup-status', 'Opponent is ready. Waiting for you…');
        break;
      case 'start':
        if (state.game === 'silver') {
          state.players = msg.players || state.players;
          enterSilverPlaceholder();
        } else {
          startGame(msg.firstPlayer === state.role);
        }
        break;
      case 'guess':
        handleOpponentGuess(msg.digits);
        break;
      case 'result':
        handleResult(msg);
        break;
      case 'rematch':
        if (state.gameOver) {
          enterSetup();
          setText('setup-status', 'Opponent wants a rematch. Pick your number.');
        }
        break;
    }
  }

  // ---------- Wire up UI ----------
  document.querySelectorAll('.game-card').forEach(b =>
    b.addEventListener('click', () => selectGame(b.dataset.game)));

  document.querySelectorAll('.digits-options [data-digits]').forEach(b =>
    b.addEventListener('click', () => onDigitsPick(parseInt(b.dataset.digits, 10))));

  document.querySelectorAll('.players-options [data-players]').forEach(b =>
    b.addEventListener('click', () => onPlayersPick(parseInt(b.dataset.players, 10))));

  $('btn-host').addEventListener('click', host);
  $('btn-join').addEventListener('click', joinScreen);
  $('btn-connect').addEventListener('click', () => {
    const v = $('join-code').value.trim().toUpperCase();
    if (v.length !== CODE_LEN) {
      setText('join-status', 'Enter the ' + CODE_LEN + '-character code.');
      return;
    }
    connectTo(v);
  });
  $('btn-ready').addEventListener('click', onReady);
  $('btn-g4-guess').addEventListener('click', onGuess);
  $('btn-hilo-guess').addEventListener('click', onGuess);
  $('btn-rematch').addEventListener('click', onRematch);
  $('btn-quit').addEventListener('click', backToGameMenu);

  document.querySelectorAll('[data-action="back-to-game-menu"]').forEach(b =>
    b.addEventListener('click', backToGameMenu));
  document.querySelectorAll('[data-action="back-to-main-menu"]').forEach(b =>
    b.addEventListener('click', backToMainMenu));

  // Submit on Enter
  $('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-connect').click();
  });
  $('secret-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-ready').click();
  });
  $('g4-guess-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-g4-guess').click();
  });
  $('hilo-guess-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-hilo-guess').click();
  });

  // Restrict digit inputs to numerics, capped at the active digit count.
  ['secret-input', 'g4-guess-input', 'hilo-guess-input'].forEach(id => {
    $(id).addEventListener('input', (e) => {
      const max = state.digits || 4;
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, max);
    });
  });

  // Uppercase + filter the room code as the user types.
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
  });

  show('main-menu');
})();
