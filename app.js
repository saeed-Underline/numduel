(function () {
  'use strict';

  // Namespace prefix avoids collisions with other PeerJS users on the public broker.
  const PEER_PREFIX = 'numduel-v1-';
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

  const state = {
    role: null,           // 'host' | 'guest'
    peer: null,
    conn: null,
    code: null,
    mySecret: null,
    iAmReady: false,
    opponentReady: false,
    myTurn: false,
    gameOver: false,
  };

  // ---------- Screen helpers ----------
  function show(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.hidden = s.dataset.screen !== name;
    });
  }
  function setText(id, text) {
    document.getElementById(id).textContent = text;
  }
  function $(id) { return document.getElementById(id); }

  // ---------- Code generation ----------
  function genCode() {
    let s = '';
    for (let i = 0; i < CODE_LEN; i++) {
      s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return s;
  }

  // ---------- Hosting ----------
  function host() {
    state.role = 'host';
    show('hosting');
    setText('host-status', 'Connecting…');
    $('room-code').textContent = '····';
    tryHost(5);
  }

  function tryHost(retriesLeft) {
    const code = genCode();
    const peer = newPeer(PEER_PREFIX + code);

    peer.on('open', () => {
      state.peer = peer;
      state.code = code;
      $('room-code').textContent = code;
      setText('host-status', 'Waiting for opponent…');
    });

    peer.on('connection', (conn) => {
      state.conn = conn;
      conn.on('open', () => wireConnection(conn));
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
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      state.conn = conn;
      conn.on('open', () => wireConnection(conn));
    });
  }

  // ---------- Connection wiring ----------
  function wireConnection(conn) {
    conn.on('data', handleMessage);
    conn.on('close', handleDisconnect);
    conn.on('error', handleDisconnect);
    enterSetup();
  }

  function send(msg) {
    if (state.conn && state.conn.open) state.conn.send(msg);
  }

  // ---------- Setup phase ----------
  function enterSetup() {
    state.iAmReady = false;
    state.opponentReady = false;
    state.gameOver = false;
    state.mySecret = null;
    $('secret-input').value = '';
    $('btn-ready').disabled = false;
    setText('setup-status', 'Enter your number and tap Ready.');
    show('setup');
    setTimeout(() => $('secret-input').focus(), 50);
  }

  function onReady() {
    const v = $('secret-input').value.trim();
    if (!/^\d{4}$/.test(v)) {
      setText('setup-status', 'Enter exactly 4 digits.');
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

    // Host is the single source of truth for who goes first.
    if (state.role === 'host') {
      const firstPlayer = Math.random() < 0.5 ? 'host' : 'guest';
      send({ type: 'start', firstPlayer });
      startGame(firstPlayer === 'host');
    }
    // Guest waits for the 'start' message.
  }

  // ---------- Gameplay ----------
  function startGame(myTurn) {
    state.myTurn = myTurn;
    state.gameOver = false;
    $('my-guesses').innerHTML = '';
    $('their-guesses').innerHTML = '';
    $('guess-input').value = '';
    $('my-secret').textContent = state.mySecret;
    show('game');
    updateTurnUI();
  }

  function updateTurnUI() {
    const indicator = $('turn-indicator');
    const input = $('guess-input');
    const btn = $('btn-guess');
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
    const v = $('guess-input').value.trim();
    if (!/^\d{4}$/.test(v)) {
      $('guess-input').focus();
      return;
    }
    $('guess-input').value = '';
    send({ type: 'guess', digits: v });
    state.myTurn = false;
    $('guess-input').disabled = true;
    $('btn-guess').disabled = true;
    $('turn-indicator').textContent = 'Checking…';
    $('turn-indicator').classList.add('waiting');
  }

  function handleOpponentGuess(digits) {
    const feedback = scoreGuess(digits, state.mySecret);
    const won = feedback.every(c => c === 'green');

    appendGuess('their-guesses', digits, feedback);
    send({ type: 'result', digits, feedback, won });

    if (won) {
      state.gameOver = true;
      endGame(false, digits);
    } else {
      state.myTurn = true;
      updateTurnUI();
    }
  }

  function handleResult(msg) {
    appendGuess('my-guesses', msg.digits, msg.feedback);
    if (msg.won) {
      state.gameOver = true;
      endGame(true, msg.digits);
    } else {
      state.myTurn = false;
      updateTurnUI();
    }
  }

  function appendGuess(listId, digits, feedback) {
    const ul = $(listId);
    const li = document.createElement('li');
    li.className = 'guess-row';
    for (let i = 0; i < 4; i++) {
      const cell = document.createElement('span');
      cell.className = 'guess-cell ' + feedback[i];
      cell.textContent = digits[i];
      li.appendChild(cell);
    }
    ul.appendChild(li);
    li.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // Wordle-style feedback: greens first, then yellows that consume unmatched secret digits.
  function scoreGuess(guess, secret) {
    const result = ['red', 'red', 'red', 'red'];
    const used = [false, false, false, false];

    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) {
        result[i] = 'green';
        used[i] = true;
      }
    }
    for (let i = 0; i < 4; i++) {
      if (result[i] === 'green') continue;
      for (let j = 0; j < 4; j++) {
        if (!used[j] && guess[i] === secret[j]) {
          result[i] = 'yellow';
          used[j] = true;
          break;
        }
      }
    }
    return result;
  }

  function endGame(iWon, finalDigits) {
    show('gameover');
    if (iWon) {
      setText('gameover-title', 'You won!');
      setText('gameover-detail', 'You cracked their number: ' + finalDigits);
    } else {
      setText('gameover-title', 'You lost');
      setText('gameover-detail', 'They guessed your number (' + state.mySecret + ') with ' + finalDigits);
    }
  }

  function onRematch() {
    send({ type: 'rematch' });
    enterSetup();
    setText('setup-status', 'Rematch! Pick a new number and tap Ready.');
  }

  function quit() {
    // Clear state BEFORE destroying the peer, so the close events that fire
    // during destroy() see a cleaned-up state and don't re-show the banner.
    const peer = state.peer;
    state.peer = null;
    state.conn = null;
    state.role = null;
    state.gameOver = false;
    $('disconnect-banner').hidden = true;
    show('menu');
    if (peer) { try { peer.destroy(); } catch (_) {} }
  }

  function handleDisconnect() {
    if (state.gameOver) return;
    if (!state.peer) return; // we've already left intentionally
    $('disconnect-banner').hidden = false;
  }

  // ---------- Message router ----------
  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        state.opponentReady = true;
        if (state.iAmReady) {
          maybeStart();
        } else {
          setText('setup-status', 'Opponent is ready. Waiting for you…');
        }
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
        if (state.gameOver || document.querySelector('.screen[data-screen="gameover"]:not([hidden])')) {
          enterSetup();
          setText('setup-status', 'Opponent wants a rematch. Pick your number.');
        }
        break;
    }
  }

  // ---------- Wire up UI ----------
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
  $('btn-guess').addEventListener('click', onGuess);
  $('btn-rematch').addEventListener('click', onRematch);
  $('btn-quit').addEventListener('click', quit);

  document.querySelectorAll('[data-action="back-to-menu"]').forEach(b =>
    b.addEventListener('click', () => {
      $('disconnect-banner').hidden = true;
      quit();
    })
  );

  // Submit on Enter
  $('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-connect').click();
  });
  $('secret-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-ready').click();
  });
  $('guess-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-guess').click();
  });

  // Restrict digit inputs to numeric characters
  ['secret-input', 'guess-input'].forEach(id => {
    $(id).addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    });
  });

  // Uppercase + filter the room code as the user types
  $('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, CODE_LEN);
  });

  show('menu');
})();
