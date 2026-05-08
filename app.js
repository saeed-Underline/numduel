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

  // ---------- Game registry ----------
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
      tagline: 'Lower scores win. Use card abilities to learn or shuffle the village.',
      peerPrefix: 'silver-v2-',
      minPlayers: 2,
      maxPlayers: 4,
    },
  };

  // ---------- Silver card metadata ----------
  // values: 0..13. Each card has a name, a count in the deck, and a description.
  // Triggers:
  //   faceUp   — passive while face-up in your village
  //   onDiscard— activates when this card is drawn from the deck and immediately discarded
  //   onExchange — activates when used in an exchange (only Doppelgänger)
  const SILVER_CARDS = {
    0:  { name: 'Villager',         count: 2, trigger: 'faceUp' },
    1:  { name: 'Squire',           count: 4, trigger: 'faceUp' },     // simplified: just value (face-up draw pile mechanic skipped)
    2:  { name: 'Empath',           count: 4, trigger: 'faceUp' },     // simplified: just value (per-turn bonus peek skipped)
    3:  { name: 'Bodyguard',        count: 4, trigger: 'faceUp' },     // simplified: just value (protect-other-card mechanic skipped)
    4:  { name: 'Rascal',           count: 4, trigger: 'faceUp' },     // simplified: just value (extra-draws mechanic skipped)
    5:  { name: 'Exposer',          count: 4, trigger: 'onDiscard' },  // turn one of YOUR face-down cards face-up
    6:  { name: 'Revealer',         count: 4, trigger: 'onDiscard' },  // turn ANY face-down card face-up
    7:  { name: 'Beholder',         count: 4, trigger: 'onDiscard' },  // peek two of YOUR face-down cards
    8:  { name: 'Apprentice Seer',  count: 4, trigger: 'onDiscard' },  // peek one OTHER player's face-down card
    9:  { name: 'Seer',             count: 4, trigger: 'onDiscard' },  // peek any one face-down card (yours or theirs)
    10: { name: 'Master',           count: 4, trigger: 'onDiscard' },  // simplified: pick any card from discard pile and put it face-up into your village
    11: { name: 'Witch',            count: 4, trigger: 'onDiscard' },  // simplified: swap top of deck face-down with any face-down card in any village
    12: { name: 'Robber',           count: 4, trigger: 'onDiscard' },  // steal a face-down card from another player; replace with one of yours
    13: { name: 'Doppelgänger',     count: 2, trigger: 'onExchange' }, // wild for matching during multi-card exchange
  };

  // Build a fresh shuffled Silver deck.
  function buildSilverDeck() {
    const deck = [];
    for (const valStr of Object.keys(SILVER_CARDS)) {
      const v = Number(valStr);
      for (let i = 0; i < SILVER_CARDS[v].count; i++) deck.push(v);
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // ---------- State ----------
  const state = {
    game: null,
    role: null,
    peer: null,
    conn: null,
    conns: new Map(),
    code: null,
    digits: 4,
    mySecret: null,
    iAmReady: false,
    opponentReady: false,
    myTurn: false,
    gameOver: false,
    playerCount: 2,
    players: [],
    myId: null,                 // 'host' for host; PeerJS id (or 'guest') for guest
    silver: null,               // host: full state. guest: redacted view received from host.
    pendingClientChoice: null,  // guest: ability-prompt context the UI is currently in
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

  // ---------- Share / copy helpers ----------
  function buildShareUrl(game, code) {
    // Reuse the current page URL but replace its query string with game+code so a
    // friend tapping the link lands on the join screen with everything pre-filled.
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('game', game);
    url.searchParams.set('code', code);
    return url.toString();
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for non-secure contexts (file://, plain http on a LAN).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function flashCopyFeedback(btn, label) {
    if (!btn) return;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
    btn.textContent = label;
    btn.classList.add('copy-feedback');
    clearTimeout(btn._feedbackTimer);
    btn._feedbackTimer = setTimeout(() => {
      btn.textContent = btn.dataset.originalText;
      btn.classList.remove('copy-feedback');
    }, 1500);
  }

  function onCopyCode() {
    const code = state.code;
    if (!code || !state.game) return;
    const url = buildShareUrl(state.game, code);
    copyToClipboard(url)
      .then(() => flashCopyFeedback($('btn-copy-code'), 'Copied!'))
      .catch(() => flashCopyFeedback($('btn-copy-code'), 'Copy failed'));
  }

  function onShareCode() {
    const code = state.code;
    if (!code || !state.game) return;
    const url = buildShareUrl(state.game, code);
    const game = GAMES[state.game];
    const shareData = {
      title: 'Join my ' + game.title + ' game',
      text: 'Join my ' + game.title + ' game with code ' + code,
      url: url,
    };
    if (navigator.share) {
      navigator.share(shareData).catch(() => { /* user cancelled or unsupported */ });
    } else {
      // Desktop browsers without Web Share: copy the link instead.
      copyToClipboard(url)
        .then(() => flashCopyFeedback($('btn-share-code'), 'Link copied!'))
        .catch(() => flashCopyFeedback($('btn-share-code'), 'Copy failed'));
    }
  }

  function setCodeButtonsEnabled(enabled) {
    const c = $('btn-copy-code');
    const s = $('btn-share-code');
    if (c) c.disabled = !enabled;
    if (s) s.disabled = !enabled;
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
    state.myId = 'host';
    if (isMultiPlayer()) {
      enterPlayersPick();
    } else {
      show('hosting');
      setText('host-status', 'Connecting…');
      $('room-code').textContent = '····';
      setCodeButtonsEnabled(false);
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
      setCodeButtonsEnabled(true);
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
      state.myId = peer.id;
      const conn = peer.connect(GAMES[state.game].peerPrefix + code, { reliable: true });
      state.conn = conn;
      conn.on('open', () => wireConnection(conn));
    });
  }

  // ---------- Connection wiring ----------
  function wireConnection(conn) {
    conn.on('data', handleMessage);
    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);

    if (state.game === 'silver') {
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

  function broadcast(msg) {
    if (state.role === 'host') {
      for (const conn of state.conns.values()) {
        if (conn.open) conn.send(msg);
      }
    } else if (state.conn && state.conn.open) {
      state.conn.send(msg);
    }
  }

  function sendTo(peerId, msg) {
    // Used by host to send a per-player redacted state to one specific guest.
    if (state.role !== 'host') return;
    if (peerId === 'host') return; // host renders directly from its own state
    const conn = state.conns.get(peerId);
    if (conn && conn.open) conn.send(msg);
  }

  // ---------- Multi-player host: lobby management ----------
  function onMultiPlayerGuestJoined(conn) {
    state.conns.set(conn.peer, conn);
    conn.on('data', (msg) => handleHostInboundMessage(conn.peer, msg));
    conn.on('close', () => onGuestLeft(conn.peer));
    conn.on('error', () => onGuestLeft(conn.peer));

    const slot = state.players.length + 1;
    state.players.push({ id: conn.peer, name: 'Player ' + slot, isHost: false, knownCards: {} });

    broadcast({ type: 'lobby', players: serializeLobbyRoster(), playerCount: state.playerCount });
    updateHostingLobby();

    if (state.players.length === state.playerCount) {
      broadcast({ type: 'start', players: serializeLobbyRoster() });
      silverStartGame();
    }
  }

  function onGuestLeft(peerId) {
    if (!state.conns.has(peerId)) return;
    state.conns.delete(peerId);
    state.players = state.players.filter(p => p.id !== peerId);
    let slot = 1;
    state.players = state.players.map(p => ({ ...p, name: 'Player ' + (slot++) }));
    broadcast({ type: 'lobby', players: serializeLobbyRoster(), playerCount: state.playerCount });
    broadcast({ type: 'player-left', id: peerId });
    updateHostingLobby();
    if (state.silver) {
      // mid-game disconnect: end the game with current standings rather than corrupting state
      silverAbortToFinish('A player left the game.');
    }
  }

  function serializeLobbyRoster() {
    return state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));
  }

  // ---------- Players-pick (Silver host) ----------
  function enterPlayersPick() {
    setText('players-pick-title', 'How many players?');
    setText('players-pick-hint', 'Pick 2, 3, or 4. Game starts once everyone joins.');
    show('players-pick');
  }

  function onPlayersPick(n) {
    state.playerCount = n;
    state.players = [{ id: 'host', name: 'Player 1', isHost: true, knownCards: {} }];
    state.conns = new Map();
    show('hosting');
    $('room-code').textContent = '····';
    setCodeButtonsEnabled(false);
    setText('host-status', 'Connecting…');
    tryHost(5);
  }

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

  function enterGuestLobby() {
    setText('join-status', 'Connected. Waiting for host…');
    $('join-lobby').hidden = false;
    renderRoster('guest-roster', state.players);
    setText('guest-lobby-status', state.players.length
      ? state.players.length + ' / ' + (state.playerCount || '?') + ' players'
      : 'Connecting to lobby…');
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

  // ---------- 1-on-1 setup (Guess 4 / Higher or Lower) ----------
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

  // ---------- Per-game UI ids (1-on-1 games) ----------
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
    if (hint === 'higher') tag.innerHTML = '<span class="hilo-arrow">↑</span> Higher';
    else if (hint === 'lower') tag.innerHTML = '<span class="hilo-arrow">↓</span> Lower';
    else tag.textContent = 'Correct!';
    li.appendChild(tag);
    ul.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

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

  // ============================================================
  // ============           SILVER GAMEPLAY           ============
  // ============================================================
  // Host is authoritative. Guests render the redacted state they receive.
  // Per-player secrecy: a slot's value is sent only when the slot is face-up,
  // OR when that specific player has peeked it (tracked in player.knownCards).

  // ---------- Silver game start ----------
  function silverStartGame() {
    if (state.role !== 'host') return; // only host runs game logic
    state.silver = {
      phase: 'play',
      round: 1,
      deck: [],
      discard: [],
      villages: {},                 // playerId -> [{value, faceUp}, ...]
      currentTurnIdx: 0,
      voteCallerIdx: null,
      finalTurnsRemaining: 0,
      cumulativeScores: {},         // playerId -> total
      lastRoundScores: null,        // for display
      amuletHolderId: null,
      drawnCard: null,              // {value, source: 'deck' | 'discard'} during the active player's mid-turn
      pendingAbility: null,         // {card, byPlayerId, ...} when an ability needs interaction
      message: '',                  // latest event text for status line
    };
    for (const p of state.players) {
      state.silver.cumulativeScores[p.id] = 0;
      p.knownCards = {};
    }
    silverStartRound(0);
  }

  function silverStartRound(startIdx) {
    if (state.role !== 'host') return;
    const s = state.silver;
    s.phase = 'play';
    s.deck = buildSilverDeck();
    s.discard = [s.deck.pop()]; // top of discard starts face-up
    s.villages = {};
    s.currentTurnIdx = startIdx;
    s.voteCallerIdx = null;
    s.finalTurnsRemaining = 0;
    s.drawnCard = null;
    s.pendingAbility = null;
    s.message = '';
    for (const p of state.players) {
      const village = [];
      for (let i = 0; i < 5; i++) {
        village.push({ value: s.deck.pop(), faceUp: false });
      }
      s.villages[p.id] = village;
      // Each player auto-peeks 2 random of their cards (interactive peek would be Phase 3).
      p.knownCards = {};
      const slots = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5).slice(0, 2);
      for (const slot of slots) {
        p.knownCards[p.id + ':' + slot] = village[slot].value;
      }
    }
    // Show the game-silver screen (host) and broadcast initial state.
    show('game-silver');
    silverBroadcastState();
    silverHostMaybeAdvance(); // in case starting state already triggered something (unlikely)
  }

  // ---------- Per-player redacted view ----------
  function silverViewFor(playerId) {
    const s = state.silver;
    const player = state.players.find(p => p.id === playerId);
    const known = player ? player.knownCards : {};
    const villages = {};
    for (const pid of Object.keys(s.villages)) {
      villages[pid] = s.villages[pid].map((card, slotIdx) => {
        const key = pid + ':' + slotIdx;
        const visible = card.faceUp || (key in known);
        return {
          value: visible ? card.value : null,
          faceUp: card.faceUp,
          peeked: !card.faceUp && (key in known),
        };
      });
    }
    return {
      phase: s.phase,
      round: s.round,
      deckCount: s.deck.length,
      discardTop: s.discard.length ? s.discard[s.discard.length - 1] : null,
      villages,
      players: state.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
      currentTurnId: state.players[s.currentTurnIdx] ? state.players[s.currentTurnIdx].id : null,
      voteCallerId: s.voteCallerIdx != null ? state.players[s.voteCallerIdx].id : null,
      finalTurnsRemaining: s.finalTurnsRemaining,
      drawnCard: (state.players[s.currentTurnIdx] && state.players[s.currentTurnIdx].id === playerId) ? s.drawnCard : null,
      pendingAbility: (s.pendingAbility && s.pendingAbility.byPlayerId === playerId) ? s.pendingAbility : null,
      cumulativeScores: { ...s.cumulativeScores },
      lastRoundScores: s.lastRoundScores,
      amuletHolderId: s.amuletHolderId,
      message: s.message,
      myId: playerId,
      gameOver: s.phase === 'finished',
    };
  }

  function silverBroadcastState() {
    if (state.role !== 'host') return;
    // Host renders directly from its own view.
    silverRender(silverViewFor('host'));
    // Each guest gets a personalized redaction.
    for (const p of state.players) {
      if (p.id === 'host') continue;
      sendTo(p.id, { type: 'silver:state', view: silverViewFor(p.id) });
    }
  }

  // ---------- Round-end checks ----------
  function silverCheckRoundEnd() {
    const s = state.silver;
    // Both Villagers face-up in any village(s)
    let villagersFaceUp = 0;
    for (const pid of Object.keys(s.villages)) {
      for (const card of s.villages[pid]) {
        if (card.faceUp && card.value === 0) villagersFaceUp++;
      }
    }
    if (villagersFaceUp >= 2) {
      silverEndRound('Both Villagers revealed.');
      return true;
    }
    // Deck depleted with no pending action
    if (s.deck.length === 0 && s.drawnCard === null && s.pendingAbility === null) {
      silverEndRound('The deck is empty.');
      return true;
    }
    return false;
  }

  function silverEndRound(reason) {
    const s = state.silver;
    s.phase = 'reveal';
    s.message = reason + ' Revealing villages…';
    // Flip every card face-up.
    for (const pid of Object.keys(s.villages)) {
      for (const card of s.villages[pid]) card.faceUp = true;
    }
    // Score: sum of card values per player.
    const roundScores = {};
    for (const p of state.players) {
      roundScores[p.id] = s.villages[p.id].reduce((sum, c) => sum + c.value, 0);
    }
    // Find lowest score.
    let lowest = Infinity;
    for (const pid of Object.keys(roundScores)) {
      if (roundScores[pid] < lowest) lowest = roundScores[pid];
    }
    const lowestIds = Object.keys(roundScores).filter(pid => roundScores[pid] === lowest);
    // Vote-caller penalty: +10 if not lowest.
    if (s.voteCallerIdx != null) {
      const callerId = state.players[s.voteCallerIdx].id;
      if (!lowestIds.includes(callerId)) {
        roundScores[callerId] += 10;
      }
    }
    // Amulet to a lowest-score winner (vote-caller wins ties; otherwise current holder wins ties; else first lowest).
    let amuletWinner = null;
    if (s.voteCallerIdx != null && lowestIds.includes(state.players[s.voteCallerIdx].id)) {
      amuletWinner = state.players[s.voteCallerIdx].id;
    } else if (s.amuletHolderId && lowestIds.includes(s.amuletHolderId)) {
      amuletWinner = s.amuletHolderId;
    } else {
      amuletWinner = lowestIds[0];
    }
    s.amuletHolderId = amuletWinner;
    // Apply scores.
    for (const pid of Object.keys(roundScores)) {
      s.cumulativeScores[pid] += roundScores[pid];
    }
    s.lastRoundScores = roundScores;
    silverBroadcastState();
    // After 4 rounds: game over. Otherwise: next round in 4 seconds.
    if (s.round >= 4) {
      setTimeout(silverEndGame, 4000);
    } else {
      setTimeout(silverNextRound, 4000);
    }
  }

  function silverNextRound() {
    if (state.role !== 'host') return;
    const s = state.silver;
    s.round += 1;
    // Start player: holder of the Silver Amulet (i.e., previous round's winner).
    let startIdx = 0;
    if (s.amuletHolderId) {
      const idx = state.players.findIndex(p => p.id === s.amuletHolderId);
      if (idx >= 0) startIdx = idx;
    }
    silverStartRound(startIdx);
  }

  function silverEndGame() {
    if (state.role !== 'host') return;
    const s = state.silver;
    s.phase = 'finished';
    // Winner: lowest cumulative; ties broken by holder of Silver Amulet.
    let lowest = Infinity;
    for (const pid of Object.keys(s.cumulativeScores)) {
      if (s.cumulativeScores[pid] < lowest) lowest = s.cumulativeScores[pid];
    }
    const lowestIds = Object.keys(s.cumulativeScores).filter(pid => s.cumulativeScores[pid] === lowest);
    let winnerId = lowestIds[0];
    if (lowestIds.length > 1 && s.amuletHolderId && lowestIds.includes(s.amuletHolderId)) {
      winnerId = s.amuletHolderId;
    }
    s.winnerId = winnerId;
    s.message = '';
    silverBroadcastState();
  }

  function silverAbortToFinish(reason) {
    if (state.role !== 'host' || !state.silver) return;
    state.silver.phase = 'finished';
    state.silver.message = reason;
    state.silver.winnerId = null;
    silverBroadcastState();
  }

  // ---------- Action handlers (host receives from guest or own UI) ----------
  function silverHandlePlayerAction(playerId, action) {
    if (state.role !== 'host' || !state.silver) return;
    const s = state.silver;
    if (s.phase !== 'play') return;
    const currentId = state.players[s.currentTurnIdx].id;
    if (playerId !== currentId) return; // not your turn

    if (action.kind === 'draw') {
      if (s.drawnCard) return;
      if (!s.deck.length) return;
      const value = s.deck.pop();
      s.drawnCard = { value, source: 'deck' };
      s.message = state.players[s.currentTurnIdx].name + ' drew from the deck.';
      silverBroadcastState();
    } else if (action.kind === 'take-discard') {
      if (s.drawnCard) return;
      if (!s.discard.length) return;
      const value = s.discard.pop();
      s.drawnCard = { value, source: 'discard' };
      s.message = state.players[s.currentTurnIdx].name + ' picked up the discard.';
      silverBroadcastState();
    } else if (action.kind === 'call-vote') {
      if (s.drawnCard || s.pendingAbility) return;
      const villageSize = s.villages[currentId].length;
      if (villageSize > 4) return; // rule: must have ≤4 cards
      s.voteCallerIdx = s.currentTurnIdx;
      s.finalTurnsRemaining = state.players.length - 1;
      s.message = state.players[s.currentTurnIdx].name + ' called for a vote!';
      silverAdvanceTurn();
    } else if (action.kind === 'discard-drawn') {
      if (!s.drawnCard) return;
      // From a discard-pile pickup, you cannot just put it back on discard — must exchange.
      if (s.drawnCard.source === 'discard') return;
      const card = s.drawnCard;
      s.drawnCard = null;
      s.discard.push(card.value);
      s.message = state.players[s.currentTurnIdx].name + ' discarded ' + cardLabel(card.value) + '.';
      // Trigger ability for cards 5..12.
      if (SILVER_CARDS[card.value].trigger === 'onDiscard') {
        silverTriggerOnDiscardAbility(card.value, currentId);
      }
      if (silverCheckRoundEnd()) return;
      silverHostMaybeAdvance();
    } else if (action.kind === 'exchange') {
      // payload: { slot: 0..4 } — single-card exchange (multi-card exchange not yet implemented)
      if (!s.drawnCard) return;
      const slot = action.slot;
      if (slot < 0 || slot >= s.villages[currentId].length) return;
      const oldCard = s.villages[currentId][slot];
      const newFaceUp = (s.drawnCard.source === 'discard'); // discard-pickup goes face-up; deck-draw goes face-down
      s.villages[currentId][slot] = { value: s.drawnCard.value, faceUp: newFaceUp };
      // Player no longer "knows" the slot if the new card is face-down (they exchanged in a card whose value they DO know — preserve known)
      const player = state.players.find(p => p.id === currentId);
      if (player) {
        // The new card's value is known to the player (they just placed it).
        player.knownCards[currentId + ':' + slot] = s.drawnCard.value;
      }
      s.discard.push(oldCard.value);
      s.drawnCard = null;
      s.message = state.players[s.currentTurnIdx].name + ' exchanged a card.';
      // Discard's face-up exchange triggers the ability of the discarded card if it's an onDiscard card.
      // Per rulebook, abilities on cards 5..12 trigger when they are "placed face-up onto the discard
      // pile immediately after drawing it from the deck." Exchange-to-discard does NOT trigger.
      if (silverCheckRoundEnd()) return;
      silverHostMaybeAdvance();
    } else if (action.kind === 'ability-resolve') {
      silverResolveAbility(playerId, action);
    }
  }

  // ---------- On-discard abilities ----------
  function silverTriggerOnDiscardAbility(cardValue, byPlayerId) {
    const s = state.silver;
    s.pendingAbility = { card: cardValue, byPlayerId };
    s.message = state.players.find(p => p.id === byPlayerId).name + ' triggered ' + cardLabel(cardValue) + '.';
    // Abilities that are auto-resolvable (no choice) don't need pendingAbility — but all
    // current onDiscard abilities require a choice. So we just set pendingAbility and wait.
    silverBroadcastState();
  }

  // Resolve an ability based on the player's choice.
  // action: { kind: 'ability-resolve', card, payload: {...} }
  function silverResolveAbility(playerId, action) {
    const s = state.silver;
    if (!s.pendingAbility) return;
    if (s.pendingAbility.byPlayerId !== playerId) return;
    const card = s.pendingAbility.card;
    if (action.card !== card) return;
    const payload = action.payload || {};

    const player = state.players.find(p => p.id === playerId);

    if (card === 5) {
      // Exposer: turn one of YOUR face-down cards face-up.
      const slot = payload.slot;
      const village = s.villages[playerId];
      if (slot >= 0 && slot < village.length && !village[slot].faceUp) {
        village[slot].faceUp = true;
        s.message = player.name + ' exposed slot ' + (slot + 1) + ' (' + cardLabel(village[slot].value) + ').';
      }
    } else if (card === 6) {
      // Revealer: turn ANY face-down card face-up.
      const targetId = payload.targetId;
      const slot = payload.slot;
      const village = s.villages[targetId];
      if (village && slot >= 0 && slot < village.length && !village[slot].faceUp) {
        village[slot].faceUp = true;
        const targetPlayer = state.players.find(p => p.id === targetId);
        s.message = player.name + ' revealed ' + targetPlayer.name + "'s slot " + (slot + 1) + '.';
      }
    } else if (card === 7) {
      // Beholder: peek 2 of YOUR face-down cards.
      const slots = (payload.slots || []).slice(0, 2);
      for (const slot of slots) {
        const v = s.villages[playerId][slot];
        if (v && !v.faceUp) {
          player.knownCards[playerId + ':' + slot] = v.value;
        }
      }
      s.message = player.name + ' beheld their own cards.';
    } else if (card === 8) {
      // Apprentice Seer: peek 1 OTHER player's face-down card.
      const targetId = payload.targetId;
      const slot = payload.slot;
      if (targetId !== playerId) {
        const v = s.villages[targetId] && s.villages[targetId][slot];
        if (v && !v.faceUp) {
          player.knownCards[targetId + ':' + slot] = v.value;
        }
      }
      s.message = player.name + ' peeked at an opponent.';
    } else if (card === 9) {
      // Seer: peek any one face-down card.
      const targetId = payload.targetId;
      const slot = payload.slot;
      const v = s.villages[targetId] && s.villages[targetId][slot];
      if (v && !v.faceUp) {
        player.knownCards[targetId + ':' + slot] = v.value;
      }
      s.message = player.name + ' peeked at a card.';
    } else if (card === 10) {
      // Master (simplified): pick any value from discard pile and put it face-up into your village.
      // Add it as a 6th slot — village can grow temporarily until next exchange. (Simplification.)
      // Actually: per rulebook, you exchange. So we'll just exchange it for a slot you choose.
      const discardIdx = payload.discardIdx;
      const slot = payload.slot;
      if (discardIdx == null || discardIdx < 0 || discardIdx >= s.discard.length) {
        // skip
      } else {
        const drawnVal = s.discard[discardIdx];
        s.discard.splice(discardIdx, 1);
        const oldCard = s.villages[playerId][slot];
        s.villages[playerId][slot] = { value: drawnVal, faceUp: true };
        player.knownCards[playerId + ':' + slot] = drawnVal;
        s.discard.push(oldCard.value);
        s.message = player.name + ' used Master to swap from the discard.';
      }
    } else if (card === 11) {
      // Witch (simplified): swap the top of the deck with any face-down card in any village (face-down).
      const targetId = payload.targetId;
      const slot = payload.slot;
      if (s.deck.length && s.villages[targetId] && s.villages[targetId][slot] && !s.villages[targetId][slot].faceUp) {
        const top = s.deck.pop();
        const old = s.villages[targetId][slot];
        s.villages[targetId][slot] = { value: top, faceUp: false };
        s.deck.push(old.value);
        // The Witch user does NOT know the new card's value — it's just a swap with the top of the deck.
        // The targeted player loses any knowledge they had of that slot.
        for (const otherP of state.players) {
          delete otherP.knownCards[targetId + ':' + slot];
        }
        s.message = player.name + ' used Witch.';
      }
    } else if (card === 12) {
      // Robber: steal a face-down card from another player; replace with one face-down card from your village.
      const targetId = payload.targetId;
      const targetSlot = payload.targetSlot;
      const mySlot = payload.mySlot;
      if (targetId !== playerId
          && s.villages[targetId] && s.villages[targetId][targetSlot] && !s.villages[targetId][targetSlot].faceUp
          && s.villages[playerId][mySlot] && !s.villages[playerId][mySlot].faceUp) {
        const stolen = s.villages[targetId][targetSlot];
        const mine   = s.villages[playerId][mySlot];
        s.villages[playerId][mySlot]   = stolen;
        s.villages[targetId][targetSlot] = mine;
        // Knowledge: the robber now knows what they took (they viewed it during the steal); they no longer know mySlot's content.
        player.knownCards[playerId + ':' + mySlot] = stolen.value;
        // The victim loses knowledge of their stolen slot, gains nothing on the new one.
        for (const otherP of state.players) {
          if (otherP.id === targetId) {
            delete otherP.knownCards[targetId + ':' + targetSlot];
          }
          // Other players who happened to know either slot lose that knowledge on swap.
          delete otherP.knownCards[targetId + ':' + targetSlot];
          if (otherP.id !== playerId) delete otherP.knownCards[playerId + ':' + mySlot];
        }
        s.message = player.name + ' robbed ' + state.players.find(p => p.id === targetId).name + '!';
      }
    }

    s.pendingAbility = null;
    if (silverCheckRoundEnd()) return;
    silverHostMaybeAdvance();
  }

  function silverHostMaybeAdvance() {
    const s = state.silver;
    if (s.drawnCard || s.pendingAbility) return;
    silverAdvanceTurn();
  }

  function silverAdvanceTurn() {
    const s = state.silver;
    // If a vote was called, count down final turns.
    if (s.voteCallerIdx != null) {
      if (s.finalTurnsRemaining <= 0) {
        silverEndRound('All final turns taken.');
        return;
      }
      s.finalTurnsRemaining -= 1;
    }
    s.currentTurnIdx = (s.currentTurnIdx + 1) % state.players.length;
    silverBroadcastState();
  }

  // ---------- UI rendering ----------
  function cardLabel(value) {
    return SILVER_CARDS[value] ? SILVER_CARDS[value].name + ' (' + value + ')' : '?';
  }

  function silverRender(view) {
    if (!view) return;
    show('game-silver');

    // Header
    setText('silver-round-label', 'Round ' + view.round + ' / 4');
    const indicator = $('silver-turn-indicator');
    const myTurn = view.currentTurnId === view.myId && view.phase === 'play';
    if (view.phase === 'reveal') {
      indicator.textContent = 'Round over';
      indicator.classList.add('waiting');
    } else if (view.phase === 'finished') {
      indicator.textContent = 'Game over';
      indicator.classList.add('waiting');
    } else if (myTurn) {
      indicator.textContent = 'Your turn';
      indicator.classList.remove('waiting');
    } else {
      const cur = view.players.find(p => p.id === view.currentTurnId);
      indicator.textContent = cur ? cur.name + "'s turn" : 'Waiting…';
      indicator.classList.add('waiting');
    }
    setText('silver-deck-count', String(view.deckCount));
    const discardEl = $('silver-discard-top');
    discardEl.innerHTML = '';
    if (view.discardTop != null) {
      discardEl.appendChild(silverCardEl({ value: view.discardTop, faceUp: true }));
    } else {
      discardEl.textContent = '—';
    }

    // Other players (everyone except me)
    const othersEl = $('silver-others');
    othersEl.innerHTML = '';
    for (const p of view.players) {
      if (p.id === view.myId) continue;
      const wrap = document.createElement('div');
      wrap.className = 'silver-other';
      const head = document.createElement('div');
      head.className = 'silver-other-head';
      const nameEl = document.createElement('span');
      nameEl.className = 'silver-other-name';
      nameEl.textContent = p.name;
      if (view.amuletHolderId === p.id) {
        const tag = document.createElement('span');
        tag.className = 'silver-amulet-tag';
        tag.textContent = 'Amulet';
        nameEl.appendChild(tag);
      }
      head.appendChild(nameEl);
      const scoreEl = document.createElement('span');
      scoreEl.className = 'silver-other-score';
      scoreEl.textContent = (view.cumulativeScores[p.id] || 0) + ' pts';
      head.appendChild(scoreEl);
      wrap.appendChild(head);
      const villageEl = document.createElement('div');
      villageEl.className = 'silver-village silver-village-other';
      const v = view.villages[p.id] || [];
      v.forEach((card, slot) => {
        villageEl.appendChild(silverCardEl(card, { otherPlayerId: p.id, slot, view, owner: p.id }));
      });
      wrap.appendChild(villageEl);
      othersEl.appendChild(wrap);
    }

    // Self village
    const me = view.players.find(p => p.id === view.myId);
    setText('silver-self-name', (me ? me.name : 'You') + ' — ' + (view.cumulativeScores[view.myId] || 0) + ' pts'
      + (view.amuletHolderId === view.myId ? ' • Amulet' : ''));
    const selfEl = $('silver-village-self');
    selfEl.innerHTML = '';
    const selfVillage = view.villages[view.myId] || [];
    selfVillage.forEach((card, slot) => {
      selfEl.appendChild(silverCardEl(card, { slot, mine: true, view, owner: view.myId }));
    });

    // Action area: drawn card + buttons + ability prompts
    silverRenderActions(view);
    setText('silver-status', view.message || '');

    // Reveal phase: show round summary inline.
    if (view.phase === 'reveal' && view.lastRoundScores) {
      const lines = view.players.map(p =>
        p.name + ': ' + view.lastRoundScores[p.id] + ' pts (total ' + (view.cumulativeScores[p.id] || 0) + ')'
      );
      setText('silver-status', (view.message ? view.message + ' ' : '') + lines.join(' • '));
    }

    // Game over: show final winner banner (overlays the silver screen).
    if (view.phase === 'finished') {
      silverShowFinish(view);
    }
  }

  function silverCardEl(card, opts) {
    opts = opts || {};
    const el = document.createElement('div');
    el.className = 'silver-card';
    if (opts.mine) el.classList.add('silver-card-mine');
    if (card.faceUp) {
      el.classList.add('silver-card-faceup');
      const v = document.createElement('span');
      v.className = 'silver-card-value';
      v.textContent = String(card.value);
      el.appendChild(v);
      const n = document.createElement('span');
      n.className = 'silver-card-name';
      n.textContent = SILVER_CARDS[card.value] ? SILVER_CARDS[card.value].name : '';
      el.appendChild(n);
    } else if (card.peeked && card.value != null) {
      el.classList.add('silver-card-peeked');
      const v = document.createElement('span');
      v.className = 'silver-card-value';
      v.textContent = String(card.value);
      el.appendChild(v);
      const n = document.createElement('span');
      n.className = 'silver-card-name';
      n.textContent = SILVER_CARDS[card.value].name;
      el.appendChild(n);
    } else {
      el.classList.add('silver-card-back');
    }
    if (opts.slot != null) el.dataset.slot = String(opts.slot);
    if (opts.owner) el.dataset.owner = opts.owner;
    // Click handlers depend on what we're prompting for; wired in renderActions.
    return el;
  }

  function silverRenderActions(view) {
    const actionsEl = $('silver-actions-area');
    actionsEl.innerHTML = '';

    const me = view.players.find(p => p.id === view.myId);
    const myTurn = view.currentTurnId === view.myId && view.phase === 'play';

    // Drawn-card panel (the active player only).
    if (view.drawnCard && myTurn) {
      const panel = document.createElement('div');
      panel.className = 'silver-drawn-panel';
      const label = document.createElement('div');
      label.className = 'silver-drawn-label';
      label.textContent = 'You drew ' + cardLabel(view.drawnCard.value) + (view.drawnCard.source === 'discard' ? ' (from discard)' : ' (from deck)');
      panel.appendChild(label);
      const card = silverCardEl({ value: view.drawnCard.value, faceUp: true });
      card.classList.add('silver-card-drawn');
      panel.appendChild(card);
      const btnRow = document.createElement('div');
      btnRow.className = 'silver-drawn-buttons';
      // Discard button only valid for deck draws.
      if (view.drawnCard.source === 'deck') {
        const dBtn = document.createElement('button');
        dBtn.className = 'secondary';
        dBtn.textContent = 'Discard';
        dBtn.addEventListener('click', () => silverDispatchAction({ kind: 'discard-drawn' }));
        btnRow.appendChild(dBtn);
      }
      const eBtn = document.createElement('button');
      eBtn.className = 'primary';
      eBtn.textContent = 'Tap a slot in your village to exchange';
      eBtn.disabled = true;
      btnRow.appendChild(eBtn);
      panel.appendChild(btnRow);
      actionsEl.appendChild(panel);
      // Wire self-village clicks for exchange.
      attachExchangeClickHandlers();
      return;
    }

    // Pending ability prompt.
    if (view.pendingAbility && view.pendingAbility.byPlayerId === view.myId) {
      silverRenderAbilityPrompt(view, actionsEl);
      return;
    }

    // Normal action buttons (this player's turn).
    if (myTurn) {
      const drawBtn = document.createElement('button');
      drawBtn.className = 'primary';
      drawBtn.textContent = 'Draw from deck (' + view.deckCount + ')';
      drawBtn.disabled = view.deckCount === 0;
      drawBtn.addEventListener('click', () => silverDispatchAction({ kind: 'draw' }));
      actionsEl.appendChild(drawBtn);

      const takeBtn = document.createElement('button');
      takeBtn.className = 'secondary';
      takeBtn.textContent = 'Take discard (' + (view.discardTop != null ? cardLabel(view.discardTop) : 'empty') + ')';
      takeBtn.disabled = view.discardTop == null;
      takeBtn.addEventListener('click', () => silverDispatchAction({ kind: 'take-discard' }));
      actionsEl.appendChild(takeBtn);

      const voteBtn = document.createElement('button');
      voteBtn.className = 'secondary';
      voteBtn.textContent = 'Call vote';
      const myVillage = view.villages[view.myId] || [];
      voteBtn.disabled = myVillage.length > 4 || view.voteCallerId != null;
      voteBtn.addEventListener('click', () => silverDispatchAction({ kind: 'call-vote' }));
      actionsEl.appendChild(voteBtn);
    }
  }

  function attachExchangeClickHandlers() {
    const selfEl = $('silver-village-self');
    if (!selfEl) return;
    selfEl.querySelectorAll('.silver-card').forEach((cardEl) => {
      cardEl.classList.add('silver-card-clickable');
      cardEl.addEventListener('click', () => {
        const slot = parseInt(cardEl.dataset.slot, 10);
        silverDispatchAction({ kind: 'exchange', slot });
      }, { once: true });
    });
  }

  function silverRenderAbilityPrompt(view, container) {
    const card = view.pendingAbility.card;
    const wrap = document.createElement('div');
    wrap.className = 'silver-ability-prompt';
    const title = document.createElement('div');
    title.className = 'silver-ability-title';
    title.textContent = SILVER_CARDS[card].name + ': ';
    const hint = document.createElement('span');
    hint.className = 'silver-ability-hint';
    hint.textContent = silverAbilityPromptText(card);
    title.appendChild(hint);
    wrap.appendChild(title);

    const skip = document.createElement('button');
    skip.className = 'secondary';
    skip.textContent = 'Skip ability';
    skip.addEventListener('click', () => {
      silverDispatchAction({ kind: 'ability-resolve', card, payload: { skip: true } });
    });
    wrap.appendChild(skip);
    container.appendChild(wrap);

    // Wire click behavior on the appropriate cards.
    silverWireAbilityClicks(card, view);
  }

  function silverAbilityPromptText(card) {
    switch (card) {
      case 5:  return 'tap one of your face-down cards to flip it face-up.';
      case 6:  return 'tap any face-down card to flip it face-up.';
      case 7:  return 'tap two of your face-down cards to peek (one at a time).';
      case 8:  return "tap one of another player's face-down cards to peek.";
      case 9:  return 'tap any face-down card (yours or theirs) to peek.';
      case 10: return 'tap any card on the discard pile, then tap one of your slots to put it there.';
      case 11: return "tap any face-down card; it'll be swapped face-down with the top of the deck.";
      case 12: return "tap one of your face-down cards (yours), then one of theirs, to steal.";
      default: return '';
    }
  }

  // Track multi-step ability inputs (e.g. Beholder picks two slots).
  let silverAbilityBuffer = null;

  function silverWireAbilityClicks(card, view) {
    silverAbilityBuffer = null;

    function wireCard(cardEl, ownerId, slot, predicate, onPick) {
      if (!predicate(ownerId, slot, cardEl)) return;
      cardEl.classList.add('silver-card-clickable');
      cardEl.addEventListener('click', () => {
        onPick(ownerId, slot);
      }, { once: true });
    }

    function forEachVillageCard(callback) {
      // Self
      const selfEl = $('silver-village-self');
      if (selfEl) selfEl.querySelectorAll('.silver-card').forEach((el) => {
        callback(el, view.myId, parseInt(el.dataset.slot, 10));
      });
      // Others
      const othersEl = $('silver-others');
      if (othersEl) othersEl.querySelectorAll('.silver-other').forEach((otherEl, idx) => {
        const otherCards = otherEl.querySelectorAll('.silver-card');
        otherCards.forEach((cardEl) => {
          const ownerId = cardEl.dataset.owner;
          callback(cardEl, ownerId, parseInt(cardEl.dataset.slot, 10));
        });
      });
    }

    if (card === 5) {
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => oId === view.myId && e.classList.contains('silver-card-back'),
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { slot: s } })));
    } else if (card === 6) {
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => e.classList.contains('silver-card-back'),
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { targetId: oId, slot: s } })));
    } else if (card === 7) {
      const picked = [];
      forEachVillageCard((el, ownerId, slot) => {
        if (ownerId !== view.myId || !el.classList.contains('silver-card-back')) return;
        el.classList.add('silver-card-clickable');
        el.addEventListener('click', () => {
          if (picked.includes(slot)) return;
          picked.push(slot);
          el.classList.remove('silver-card-clickable');
          el.classList.add('silver-card-picked');
          if (picked.length === 2) {
            silverDispatchAction({ kind: 'ability-resolve', card, payload: { slots: picked } });
          }
        });
      });
      // Allow shorter peeks via skip if user only wants 1
    } else if (card === 8) {
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => oId !== view.myId && e.classList.contains('silver-card-back'),
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { targetId: oId, slot: s } })));
    } else if (card === 9) {
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => e.classList.contains('silver-card-back'),
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { targetId: oId, slot: s } })));
    } else if (card === 10) {
      // Master simplified: pick top of discard (no other choice for v1) → exchange with one of your slots.
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => oId === view.myId,
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { discardIdx: state.silver ? state.silver.discard.length - 1 : view.discardTop, slot: s } })));
    } else if (card === 11) {
      forEachVillageCard((el, ownerId, slot) => wireCard(el, ownerId, slot,
        (oId, s, e) => e.classList.contains('silver-card-back'),
        (oId, s) => silverDispatchAction({ kind: 'ability-resolve', card, payload: { targetId: oId, slot: s } })));
    } else if (card === 12) {
      // Robber: two-step pick (mySlot, then targetSlot).
      let myPick = null;
      forEachVillageCard((el, ownerId, slot) => {
        if (!el.classList.contains('silver-card-back')) return;
        el.classList.add('silver-card-clickable');
        el.addEventListener('click', () => {
          if (myPick == null) {
            if (ownerId !== view.myId) return;
            myPick = slot;
            el.classList.add('silver-card-picked');
          } else {
            if (ownerId === view.myId) return;
            silverDispatchAction({ kind: 'ability-resolve', card, payload: { mySlot: myPick, targetId: ownerId, targetSlot: slot } });
          }
        });
      });
    }
  }

  function silverShowFinish(view) {
    show('gameover');
    const stage = $('gameover-stage');
    stage.classList.remove('won', 'lost');
    void stage.offsetWidth;
    const iWon = view.winnerId === view.myId;
    stage.classList.add(iWon ? 'won' : 'lost');
    setText('gameover-title', iWon ? 'You won Silver!' : 'You lost Silver');
    if (view.winnerId) {
      const winner = view.players.find(p => p.id === view.winnerId);
      const lines = view.players.map(p =>
        p.name + ': ' + (view.cumulativeScores[p.id] || 0)
      ).join(' • ');
      setText('gameover-detail', 'Winner: ' + (winner ? winner.name : '?') + ' • Final scores: ' + lines);
    } else {
      setText('gameover-detail', view.message || 'Game ended.');
    }
    if (iWon) showConfetti();
    else clearConfetti();
  }

  // Dispatch a player action. On host, runs locally; on guest, sends to host.
  function silverDispatchAction(action) {
    if (state.role === 'host') {
      silverHandlePlayerAction('host', action);
    } else {
      send({ type: 'silver:action', action });
    }
  }

  // ---------- Game over (1-on-1 games) ----------
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
    if (state.game === 'silver') {
      // Silver rematch: restart the multi-round game with same players.
      if (state.role === 'host') silverStartGame();
      return;
    }
    send({ type: 'rematch' });
    enterSetup();
    setText('setup-status', 'Rematch! Pick a new number and tap Ready.');
  }

  // ---------- Connection lifecycle ----------
  function quitConnection() {
    const peer = state.peer;
    state.peer = null;
    state.conn = null;
    state.role = null;
    state.gameOver = false;
    state.iAmReady = false;
    state.opponentReady = false;
    state.playerCount = 2;
    state.players = [];
    state.silver = null;
    state.myId = null;

    if (state.conns) {
      for (const conn of state.conns.values()) {
        try { conn.close(); } catch (_) {}
      }
      state.conns.clear();
    }

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
  function handleHostInboundMessage(fromId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'silver:action') {
      silverHandlePlayerAction(fromId, msg.action);
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'lobby':
        state.players = msg.players || [];
        state.playerCount = msg.playerCount || state.playerCount;
        updateGuestLobby();
        break;
      case 'player-left':
        break;
      case 'silver:state':
        // Guest receives a redacted view from host.
        silverRender(msg.view);
        break;
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
          // Guest waits for the first silver:state to render. Show the silver screen so the user knows we're past lobby.
          show('game-silver');
          setText('silver-status', 'Game starting…');
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
  $('btn-copy-code').addEventListener('click', onCopyCode);
  $('btn-share-code').addEventListener('click', onShareCode);
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

  ['secret-input', 'g4-guess-input', 'hilo-guess-input'].forEach(id => {
    $(id).addEventListener('input', (e) => {
      const max = state.digits || 4;
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, max);
    });
  });

  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
  });

  // ---------- Deep link: ?game=<id>&code=<code> drops the user straight into Join ----------
  function tryAutoJoinFromUrl() {
    const params = new URLSearchParams(location.search);
    const game = params.get('game');
    const codeRaw = params.get('code');
    if (!game || !codeRaw || !GAMES[game]) return false;
    const code = codeRaw.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
    if (code.length !== CODE_LEN) return false;
    // Clean the URL so a refresh later doesn't re-trigger the auto-join.
    history.replaceState({}, '', location.pathname);
    state.game = game;
    state.role = 'guest';
    setText('game-menu-title', GAMES[game].title);
    setText('game-menu-tagline', GAMES[game].tagline);
    show('joining');
    setText('join-status', 'Connecting to ' + GAMES[game].title + ' (' + code + ')…');
    $('join-code').value = code;
    setTimeout(() => connectTo(code), 400);
    return true;
  }

  if (!tryAutoJoinFromUrl()) {
    show('main-menu');
  }
})();
