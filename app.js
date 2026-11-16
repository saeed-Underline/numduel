(function () {
  'use strict';

  // Excludes 0/1/I/O/L to avoid visual ambiguity.
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 4;

  // ---------- WebSocket-backed peer shim (replaces PeerJS) ----------
  // We use a tiny relay server over wss:// to route messages between peers, so
  // the app keeps working in networks where WebRTC traffic is blocked.
  //
  // The WsPeer / WsConn classes match the slice of the PeerJS API the rest of
  // app.js relies on:
  //   peer.on('open' | 'connection' | 'error', fn), peer.connect(otherId),
  //   peer.id, peer.destroy()
  //   conn.on('open' | 'data' | 'close' | 'error', fn), conn.send(msg),
  //   conn.peer, conn.open, conn.close()
  //
  // The host claims a room by sending {type:'host', code}; the server assigns the
  // host's logical id = code. A guest sends {type:'join', code} and gets back
  // {type:'joined', id, hostId}. From then on, peer-to-peer traffic is wrapped as
  // {type:'msg', to, payload} and the server routes by id.

  function wsUrlForBroker() {
    const h = location.hostname || 'localhost';
    if (!location.hostname || h === 'localhost' || h === '127.0.0.1') {
      // Local dev: relay listens on a separate port (configurable via window.NUMDUEL_WS).
      const port = (window.NUMDUEL_WS_PORT) || 9001;
      return 'ws://' + h + ':' + port + '/ws';
    }
    // Production: served via nginx at /ws on the same origin (auto-uses wss when the page is on https).
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  class WsConn {
    constructor(peer, otherId) {
      this._peer = peer;
      this.peer = otherId;
      this.open = false;
      this._handlers = { open: [], data: [], close: [], error: [] };
    }
    on(event, fn) {
      (this._handlers[event] = this._handlers[event] || []).push(fn);
      return this;
    }
    _emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      (this._handlers[event] || []).forEach(fn => { try { fn.apply(null, args); } catch (e) { console.error(e); } });
    }
    send(msg) {
      const ws = this._peer && this._peer._ws;
      if (ws && ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'msg', to: this.peer, payload: msg }));
      }
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this._peer && this._peer._conns.delete(this.peer);
      this._emit('close');
    }
  }

  class WsPeer {
    constructor(id) {
      // id !== undefined → host claiming this id as the room code.
      // id === undefined → guest (server assigns an id on join).
      this.id = id || null;
      this._role = id ? 'host' : 'guest';
      this._ws = null;
      this._conns = new Map();
      this._handlers = { open: [], connection: [], error: [], close: [] };
      this._opened = false;
      this._destroyed = false;
      this._connect();
    }
    on(event, fn) {
      (this._handlers[event] = this._handlers[event] || []).push(fn);
      return this;
    }
    _emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      (this._handlers[event] || []).forEach(fn => { try { fn.apply(null, args); } catch (e) { console.error(e); } });
    }
    _connect() {
      let ws;
      try { ws = new WebSocket(wsUrlForBroker()); }
      catch (e) {
        setTimeout(() => this._emit('error', { type: 'network', message: e.message }), 0);
        return;
      }
      this._ws = ws;
      ws.addEventListener('open', () => {
        if (this._destroyed) { try { ws.close(); } catch (_) {} return; }
        if (this._role === 'host') {
          ws.send(JSON.stringify({ type: 'host', code: this.id }));
          // peer.open fires when 'hosted' confirmation arrives.
        } else {
          // Guest: peer.open fires immediately so the caller can invoke peer.connect().
          this._opened = true;
          this._emit('open', this.id);
        }
      });
      ws.addEventListener('message', (e) => this._onServerMessage(e));
      ws.addEventListener('close', () => this._onWsClose());
      ws.addEventListener('error', () => {
        if (!this._opened) this._emit('error', { type: 'network', message: 'ws-open-failed' });
      });
    }
    _onServerMessage(event) {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hosted') {
        this.id = msg.id;
        this._opened = true;
        this._emit('open', this.id);
      } else if (msg.type === 'joined') {
        this.id = msg.id;
        const conn = this._conns.get(msg.hostId);
        if (conn) {
          conn.open = true;
          conn._emit('open');
        }
      } else if (msg.type === 'peer-joined') {
        const conn = new WsConn(this, msg.id);
        this._conns.set(msg.id, conn);
        this._emit('connection', conn);
        setTimeout(() => {
          if (this._conns.has(msg.id)) {
            conn.open = true;
            conn._emit('open');
          }
        }, 0);
      } else if (msg.type === 'peer-left') {
        const conn = this._conns.get(msg.id);
        if (conn) {
          conn.open = false;
          this._conns.delete(msg.id);
          conn._emit('close');
        }
      } else if (msg.type === 'msg') {
        const conn = this._conns.get(msg.from);
        if (conn) conn._emit('data', msg.payload);
      } else if (msg.type === 'error') {
        this._emit('error', { type: msg.errorType || 'server-error', message: msg.reason || 'error' });
      }
    }
    _onWsClose() {
      const conns = Array.from(this._conns.values());
      this._conns.clear();
      conns.forEach(conn => {
        if (conn.open) {
          conn.open = false;
          conn._emit('close');
        }
      });
    }
    connect(otherId /*, opts */) {
      const conn = new WsConn(this, otherId);
      this._conns.set(otherId, conn);
      const doSend = () => {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send(JSON.stringify({ type: 'join', code: otherId }));
        }
      };
      if (this._ws && this._ws.readyState === 1) doSend();
      else if (this._ws) this._ws.addEventListener('open', doSend, { once: true });
      return conn;
    }
    destroy() {
      this._destroyed = true;
      if (this._ws) { try { this._ws.close(); } catch (_) {} }
      this._ws = null;
      this._conns.clear();
    }
  }

  function newPeer(id) { return new WsPeer(id); }

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
      tagline: 'Two players, four rounds. Keep the fewest werewolves in your village.',
      peerPrefix: 'silver-v3-',
      minPlayers: 2,
      maxPlayers: 2,
    },
  };

  // ---------- State ----------
  const state = {
    game: null,
    role: null,
    peer: null,
    conn: null,
    code: null,
    digits: 4,
    mySecret: null,
    iAmReady: false,
    opponentReady: false,
    myTurn: false,
    gameOver: false,
    myId: null,                 // 'host' for host; relay-assigned id for guest
  };

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function setText(id, text) { $(id).textContent = text; }
  function show(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = s.dataset.screen !== name;
    });
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
    show('hosting');
    setText('host-status', 'Connecting…');
    $('room-code').textContent = '····';
    setCodeButtonsEnabled(false);
    tryHost(5);
  }

  function tryHost(retriesLeft) {
    const code = genCode();
    const peer = newPeer(GAMES[state.game].peerPrefix + code);

    peer.on('open', () => {
      state.peer = peer;
      state.code = code;
      $('room-code').textContent = code;
      setCodeButtonsEnabled(true);
      setText('host-status', 'Waiting for opponent…');
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        state.conn = conn;
        wireConnection(conn);
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
      conn.on('open', () => {
        state.myId = peer.id;
        wireConnection(conn);
      });
    });
  }

  // ---------- Connection wiring ----------
  function wireConnection(conn) {
    conn.on('data', handleMessage);
    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);

    if (state.game === 'silver') {
      silverOnConnected();
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
  // ============       SILVER (2-player PvP)        ============
  // ============================================================
  // Game rules and table UI live in silver/silver.js (window.SilverPvP).
  // The host runs the authoritative engine as player 0; the guest is player 1.
  // Guests send {type:'silver:action'}; the host replies with a redacted
  // {type:'silver:state'} view, so face-down cards never reach the other browser.
  let silverEngine = null;
  let silverClient = null;

  function silverEnsureClient() {
    if (!silverClient) silverClient = window.SilverPvP.createClient($('silver-root'), silverDispatch);
    return silverClient;
  }

  function silverOnConnected() {
    show('game-silver');
    silverEnsureClient();
    if (state.role === 'host') {
      silverEngine = window.SilverPvP.createEngine(silverPublish);
      silverEngine.newGame();
      silverPublish();
    } else {
      silverClient.waiting('Connected. Waiting for the host to deal…');
    }
  }

  function silverPublish() {
    if (!silverEngine) return;
    silverEnsureClient().render(silverEngine.viewFor(0));
    send({ type: 'silver:state', view: silverEngine.viewFor(1) });
  }

  function silverDispatch(action) {
    if (state.role === 'host') {
      if (silverEngine) silverEngine.handle(0, action);
    } else {
      send({ type: 'silver:action', action });
    }
  }

  function silverStop() {
    silverEngine = null;
    if (silverClient) { silverClient.destroy(); silverClient = null; }
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
    state.myId = null;
    silverStop();

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
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'silver:state':
        // Guest: redacted view from the host.
        if (state.role === 'guest' && state.game === 'silver') {
          show('game-silver');
          silverEnsureClient().render(msg.view);
        }
        break;
      case 'silver:action':
        // Host: the guest (player 1) acted.
        if (state.role === 'host' && silverEngine) silverEngine.handle(1, msg.action);
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
        startGame(msg.firstPlayer === state.role);
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
