/* Silver — 2-player PvP for Number Duel.
 *
 * Two parts:
 *   createEngine(onChange)  host-only, authoritative game state. Player 0 = host, 1 = guest.
 *                           engine.handle(p, action) validates and applies a player's action;
 *                           engine.viewFor(p) returns a JSON-safe, redacted view for that player
 *                           (face-down cards only carry a value if that player has seen them).
 *   createClient(root, dispatch)  renders a view with drag & drop + move animations and turns
 *                           user gestures into actions, which app.js routes to the host engine.
 *
 * The engine has no DOM dependencies, so it can also be loaded in Node for testing.
 */
(function (root) {
  'use strict';

  /* ===================== Card data (edit to match your rulebook) =====================
     when: 'always'   active for everyone while face up in any village
           'faceup'   usable by its owner, once per turn, while face up in their village
           'discard'  usable when drawn from the deck and discarded straight away
           'exchange' matters when exchanging cards                                      */
  const CARDS = {
    0:  { name: 'Villager',        when: 'always',   text: 'If both Villagers are face up (in any villages), the round ends immediately.' },
    1:  { name: 'Squire',          when: 'always',   text: 'While any Squire is face up, the top card of the deck is face up. A card drawn that way enters a village face up.' },
    2:  { name: 'Empath',          when: 'faceup',   text: 'Once per turn, look at one of your face-down cards.' },
    3:  { name: 'Bodyguard',       when: 'faceup',   text: 'The cards next to it cannot be viewed or moved by opponents.' },
    4:  { name: 'Rascal',          when: 'faceup',   text: 'Once per turn, look at the top card of the deck.' },
    5:  { name: 'Exposer',         when: 'discard',  text: 'Turn one of your face-down cards face up.' },
    6:  { name: 'Revealer',        when: 'discard',  text: "Turn one of an opponent's face-down cards face up." },
    7:  { name: 'Beholder',        when: 'discard',  text: 'Look at two of your cards.' },
    8:  { name: 'Apprentice Seer', when: 'discard',  text: "Look at one of an opponent's cards." },
    9:  { name: 'Seer',            when: 'discard',  text: "Look at one of your cards and one of an opponent's cards." },
    10: { name: 'Master',          when: 'discard',  text: 'Flip any one card in any village (face up ↔ face down).' },
    11: { name: 'Witch',           when: 'discard',  text: "Look at one of your cards and one of an opponent's; you may swap them." },
    12: { name: 'Robber',          when: 'discard',  text: "Swap one of your cards with one of an opponent's, then look at your new card." },
    13: { name: 'Doppelgänger',    when: 'exchange', text: 'Matches any value in a multi-card exchange. Scores 13.' },
  };
  const COUNT = v => (v === 0 || v === 13) ? 2 : 4; // 52 cards
  const ROUNDS = 4, CALL_PENALTY = 10, MAX_CALL_CARDS = 4;
  const IMG = v => 'silver/cards/' + v + '.jpg';

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function abilitySteps(v) {
    switch (v) {
      case 5:  return [{ owner: 'self', faceDown: true, label: 'Pick one of your face-down cards to turn face up' }];
      case 6:  return [{ owner: 'opp', faceDown: true, label: "Pick one of your opponent's face-down cards to turn face up" }];
      case 7:  return [{ owner: 'self', label: 'Pick a card of yours to look at' }, { owner: 'self', label: 'Pick a second card of yours to look at', optional: true }];
      case 8:  return [{ owner: 'opp', label: "Pick one of your opponent's cards to look at" }];
      case 9:  return [{ owner: 'self', label: 'Pick one of your cards to look at' }, { owner: 'opp', label: "Now pick one of your opponent's cards" }];
      case 10: return [{ owner: 'any', label: 'Pick any card to flip' }];
      case 11: return [{ owner: 'self', label: 'Pick one of your cards' }, { owner: 'opp', label: "Pick one of your opponent's cards" }];
      case 12: return [{ owner: 'self', label: 'Pick one of your cards to give away' }, { owner: 'opp', label: "Pick one of your opponent's cards to take" }];
    }
    return null;
  }

  /* ================================ ENGINE (host) ================================ */
  function createEngine(onChange) {
    let g = null, uid = 0;
    const opp = p => 1 - p;
    const changed = () => { if (onChange) onChange(); };
    // log tokens: {P0}/{P1} → "You"/"Opponent", {S0}/{S1} → "your"/"Opponent's"
    const log = (p, t) => { g.log.push({ p, t }); if (g.log.length > 120) g.log.shift(); };
    const cn = c => '<b>' + c.v + '</b> ' + CARDS[c.v].name;

    function newGame() {
      g = { round: 0, totals: [0, 0], history: [], amulet: null, starter: Math.random() < 0.5 ? 0 : 1, log: [] };
      startRound();
    }

    function startRound() {
      g.round++;
      const deck = [];
      for (let v = 0; v <= 13; v++) for (let i = 0; i < COUNT(v); i++) deck.push({ id: ++uid, v, faceUp: false });
      shuffle(deck);
      g.deck = deck;
      g.villages = [[], []];
      for (let i = 0; i < 5; i++) { g.villages[0].push(deck.pop()); g.villages[1].push(deck.pop()); }
      const first = deck.pop(); first.faceUp = true;
      g.discard = [first];
      g.knows = [new Set(), new Set()];
      g.flash = [new Set(), new Set()];
      g.deckPeek = [null, null];
      g.amuletOn = null; g.caller = null; g.finalTurns = 0;
      g.drawn = null; g.hl = new Set();
      g.turn = g.starter; g.phase = 'peek'; g.peeks = [[], []]; g.ready = [false, false];
      g.stage = null; g.pending = null; g.flags = {}; g.lastRound = null;
      log(null, 'Round ' + g.round + ' begins. First turn: {P' + g.starter + '}.' +
        (g.amulet !== null ? ' {P' + g.amulet + '} hold the Silver Amulet.' : ''));
    }

    // ---- helpers ----
    const knowsCard = (p, c) => c.faceUp || g.knows[p].has(c.id);
    const hasFaceUp = (p, v) => g.villages[p].some(c => c.faceUp && c.v === v);
    const squireActive = () => g.deck.length > 0 && g.villages.some(vil => vil.some(c => c.faceUp && c.v === 1));
    function find(id) {
      for (const o of [0, 1]) { const c = g.villages[o].find(x => x.id === id); if (c) return { owner: o, card: c }; }
      return null;
    }
    function guarded(owner, idx) {
      const vil = g.villages[owner];
      return [idx - 1, idx + 1].some(j => vil[j] && vil[j].faceUp && vil[j].v === 3);
    }
    function targetable(actor, owner, card) {
      if (card.id === g.amuletOn) return false;
      if (owner !== actor && guarded(owner, g.villages[owner].indexOf(card))) return false;
      return true;
    }
    function toDiscard(c) { c.faceUp = true; g.discard.push(c); }
    function setFaceDown(c) { if (c.faceUp) { g.knows[0].add(c.id); g.knows[1].add(c.id); } c.faceUp = false; }
    function swapCards(a, b) {
      const A = find(a.id), B = find(b.id);
      const ia = g.villages[A.owner].indexOf(a), ib = g.villages[B.owner].indexOf(b);
      g.villages[A.owner][ia] = b; g.villages[B.owner][ib] = a;
    }
    const myTurn = p => g.phase === 'play' && g.turn === p;
    const canCall = p => myTurn(p) && g.stage === 'main' && g.caller === null &&
      g.villages[p].length <= MAX_CALL_CARDS && !g.flags.noCall;

    function candidates(actor, step, pickedIds) {
      const owners = step.owner === 'self' ? [actor] : step.owner === 'opp' ? [opp(actor)] : [0, 1];
      const out = [];
      for (const o of owners) for (const c of g.villages[o]) {
        if (!targetable(actor, o, c)) continue;
        if (step.faceDown && c.faceUp) continue;
        if (pickedIds.includes(c.id)) continue;
        out.push({ owner: o, card: c });
      }
      return out;
    }
    function abilityPossible(actor, v) {
      const steps = abilitySteps(v); if (!steps) return false;
      const picked = [];
      for (const s of steps) {
        const c = candidates(actor, s, picked);
        if (!c.length) { if (s.optional) break; return false; }
        picked.push(c[0].card.id);
      }
      return true;
    }

    // ---- exchange ----
    function doExchange(p, cards) {
      const d = g.drawn, vil = g.villages[p], card = d.card;
      const vals = cards.map(c => c.v).filter(v => v !== 13);
      const ok = cards.length === 1 || vals.every(v => v === vals[0]);
      const enterFaceUp = d.from === 'discard' || !!d.revealed;
      if (ok) {
        const idxs = cards.map(c => vil.indexOf(c)).sort((a, b) => a - b);
        const pos = idxs[0];
        idxs.slice().reverse().forEach(i => { const c = vil.splice(i, 1)[0]; toDiscard(c); });
        card.faceUp = enterFaceUp;
        vil.splice(pos, 0, card);
        g.knows[p].add(card.id);
        if (enterFaceUp) { g.knows[0].add(card.id); g.knows[1].add(card.id); }
        g.hl = new Set([card.id]);
        log(p, '{P' + p + '} exchanged ' + (cards.length > 1 ? cards.length + ' cards' : 'a card') + ' (' +
          cards.map(cn).join(', ') + ') for ' + (enterFaceUp ? cn(card) : 'the drawn card') + '.');
      } else {
        cards.forEach(c => { g.knows[0].add(c.id); g.knows[1].add(c.id); c.faceUp = false; });
        card.faceUp = enterFaceUp; vil.push(card); g.knows[p].add(card.id);
        if (enterFaceUp) { g.knows[0].add(card.id); g.knows[1].add(card.id); }
        let pen = '';
        if (cards.length >= 3 && g.deck.length) { const x = g.deck.pop(); x.faceUp = false; vil.push(x); pen = ' plus a penalty card'; }
        g.hl = new Set(cards.map(c => c.id).concat(card.id));
        log(p, '{P' + p + '} tried to exchange ' + cards.map(cn).join(', ') +
          " — they don't match! They go back face down, and the drawn card is added" + pen + '.');
      }
      g.drawn = null;
    }

    // ---- abilities ----
    function applyAbility(actor, v, cards, witchSwap) {
      const P = '{P' + actor + '}', T = '{S' + opp(actor) + '}';
      g.hl = new Set(cards.map(c => c.id));
      const see = cs => cs.forEach(c => { g.knows[actor].add(c.id); g.flash[actor].add(c.id); });
      switch (v) {
        case 5: cards[0].faceUp = true; log(actor, P + ' turned ' + cn(cards[0]) + ' face up (Exposer).'); break;
        case 6: cards[0].faceUp = true; log(actor, P + ' turned ' + T + ' ' + cn(cards[0]) + ' face up (Revealer).'); break;
        case 7: see(cards); log(actor, P + ' looked at ' + cards.length + ' of {S' + actor + '} own cards (Beholder).'); break;
        case 8: see(cards); log(actor, P + ' looked at one of ' + T + ' cards (Apprentice Seer).'); break;
        case 9: see(cards); log(actor, P + ' looked at one own card and one of ' + T + ' cards (Seer).'); break;
        case 10: {
          const c = cards[0];
          if (c.faceUp) { setFaceDown(c); log(actor, P + ' flipped ' + cn(c) + ' face down (Master).'); }
          else { c.faceUp = true; log(actor, P + ' flipped ' + cn(c) + ' face up (Master).'); }
          break;
        }
        case 11:
          cards.forEach(c => g.knows[actor].add(c.id));
          if (witchSwap) { swapCards(cards[0], cards[1]); log(actor, P + ' looked at two cards and swapped them (Witch).'); }
          else log(actor, P + ' looked at two cards and kept them (Witch).');
          break;
        case 12:
          swapCards(cards[0], cards[1]); see([cards[1]]);
          log(actor, P + ' swapped a card with ' + T + ' village and looked at the new one (Robber).');
          break;
      }
    }

    // ---- turn flow ----
    function beginTurn() {
      if (g.caller !== null && g.finalTurns <= 0) return endRound('vote');
      if (g.deck.length === 0) return endRound('deck');
      g.flags = { noCall: false, empath: false, rascal: false };
      g.stage = 'main'; g.pending = null;
    }
    function endTurn(wasCall) {
      g.drawn = null; g.pending = null;
      if (checkVillagers()) return;
      if (g.caller !== null && !wasCall) g.finalTurns--;
      g.turn = opp(g.turn);
      beginTurn();
    }
    function checkVillagers() {
      const up = g.villages[0].concat(g.villages[1]).filter(c => c.faceUp && c.v === 0).length;
      if (up >= 2) { log(null, 'Both Villagers are face up — the round ends immediately!'); endRound('villagers'); return true; }
      return false;
    }
    function endRound(reason) {
      g.drawn = null; g.stage = null; g.pending = null;
      const sums = [0, 1].map(p => g.villages[p].reduce((s, c) => s + c.v, 0));
      const score = sums.slice();
      let note;
      if (g.caller !== null) {
        const c = g.caller, ok = sums[c] <= sums[opp(c)];
        if (ok) { score[c] = 0; note = '{P' + c + '} called the vote and had the lowest total → 0 points'; }
        else { score[c] = sums[c] + CALL_PENALTY; note = '{P' + c + '} called the vote but did not have the lowest total → ' + sums[c] + ' + ' + CALL_PENALTY; }
        g.amulet = ok ? c : null;
      } else {
        g.amulet = null;
        note = reason === 'deck' ? 'The deck ran out' : 'Both Villagers were revealed';
      }
      g.totals[0] += score[0]; g.totals[1] += score[1];
      g.history.push({ sums, score });
      g.starter = score[0] < score[1] ? 0 : score[1] < score[0] ? 1 : (g.caller !== null ? g.caller : g.starter);
      g.lastRound = { sums, score, note };
      g.phase = g.round >= ROUNDS ? 'gameOver' : 'roundEnd';
      log(null, 'Round ' + g.round + ' over. ' + note + '.');
      if (g.phase === 'gameOver') {
        const w = g.totals[0] < g.totals[1] ? 0 : g.totals[1] < g.totals[0] ? 1 : null;
        log(null, w === null ? 'The game is a tie!' : '{P' + w + '} win the game!');
      }
    }

    // ---- action handler ----
    function handle(p, a) {
      if (!g || !a || (p !== 0 && p !== 1)) return;
      g.hl = new Set();
      if (g.phase === 'play' && g.turn === p) g.flash[p].clear();
      const ids = Array.isArray(a.ids) ? a.ids : [];
      const ownCards = () => {
        const out = [];
        for (const id of ids) {
          const f = find(id);
          if (!f || f.owner !== p || !targetable(p, p, f.card) || out.includes(f.card)) return null;
          out.push(f.card);
        }
        return out.length ? out : null;
      };

      switch (a.kind) {
        case 'peek': {
          if (g.phase !== 'peek' || g.peeks[p].length >= 2) break;
          const f = find(a.id);
          if (!f || f.owner !== p || g.peeks[p].includes(f.card.id)) break;
          g.peeks[p].push(f.card.id); g.knows[p].add(f.card.id); g.flash[p].add(f.card.id);
          break;
        }
        case 'ready':
          // the two peeked cards stay visible until the player says they've memorised them
          if (g.phase !== 'peek' || g.peeks[p].length < 2 || g.ready[p]) break;
          g.ready[p] = true; g.flash[p].clear();
          if (g.ready[0] && g.ready[1]) { g.phase = 'play'; beginTurn(); }
          break;
        case 'next':
          if (g.phase === 'roundEnd') startRound();
          else if (g.phase === 'gameOver') { log(null, '— New game —'); newGame(); }
          break;
      }
      if (!myTurn(p)) return changed();

      const P = '{P' + p + '}';
      switch (a.kind) {
        case 'call':
          if (!canCall(p)) break;
          g.caller = p; g.finalTurns = 1;
          log(p, P + ' called for a vote! {P' + opp(p) + '} get one last turn.');
          endTurn(true);
          break;
        case 'empath': {
          if (g.stage !== 'main' || !hasFaceUp(p, 2) || g.flags.empath) break;
          const f = find(a.id);
          if (!f || f.owner !== p || f.card.faceUp || !targetable(p, p, f.card)) break;
          g.knows[p].add(f.card.id); g.flash[p].add(f.card.id);
          g.flags.empath = true; g.flags.noCall = true;
          log(p, P + ' used the Empath to look at one of {S' + p + '} cards.');
          break;
        }
        case 'rascal': {
          if (g.stage !== 'main' || !hasFaceUp(p, 4) || g.flags.rascal || !g.deck.length || squireActive()) break;
          const top = g.deck[g.deck.length - 1];
          g.knows[p].add(top.id); g.deckPeek[p] = top.id;
          g.flags.rascal = true; g.flags.noCall = true;
          log(p, P + ' used the Rascal to look at the top of the deck.');
          break;
        }
        case 'amulet': {
          if (g.stage !== 'main' || g.amulet !== p || g.amuletOn !== null) break;
          const f = find(a.id);
          if (!f || f.owner !== p) break;
          g.amuletOn = f.card.id; g.flags.noCall = true; g.hl = new Set([f.card.id]);
          log(p, P + ' placed the Silver Amulet on one of {S' + p + '} cards.');
          break;
        }
        case 'draw': {
          if (g.stage !== 'main' || !g.deck.length) break;
          const revealed = squireActive();
          const card = g.deck.pop();
          g.drawn = { card, from: 'deck', revealed };
          g.knows[p].add(card.id); if (revealed) g.knows[opp(p)].add(card.id);
          g.flags.noCall = true; g.stage = 'drawn';
          log(p, P + ' drew from the deck' + (revealed ? ' (face up: ' + cn(card) + ')' : '') + '.');
          break;
        }
        case 'take': {
          if (g.stage !== 'main' || !g.discard.length) break;
          const cards = ownCards(); if (!cards) break;
          const card = g.discard.pop();
          g.drawn = { card, from: 'discard' }; g.flags.noCall = true;
          log(p, P + ' took ' + cn(card) + ' from the discard pile.');
          doExchange(p, cards); endTurn();
          break;
        }
        case 'exchange': {
          if (g.stage !== 'drawn') break;
          const cards = ownCards(); if (!cards) break;
          doExchange(p, cards); endTurn();
          break;
        }
        case 'discard': {
          if (g.stage !== 'drawn') break;
          const card = g.drawn.card; g.drawn = null; toDiscard(card);
          g.hl = new Set([card.id]);
          if (a.use && CARDS[card.v].when === 'discard' && abilityPossible(p, card.v)) {
            log(p, P + ' discarded ' + cn(card) + ' to use its ability.');
            g.stage = 'ability'; g.pending = { v: card.v };
          } else {
            log(p, P + ' discarded ' + cn(card) + '.');
            endTurn();
          }
          break;
        }
        case 'skip':
          if (g.stage !== 'ability') break;
          log(p, P + ' skipped the ability.');
          endTurn();
          break;
        case 'ability': {
          if (g.stage !== 'ability') break;
          const v = g.pending.v, steps = abilitySteps(v), picks = [], pickedIds = [];
          let valid = true;
          for (let i = 0; i < steps.length; i++) {
            const id = ids[i];
            if (id === undefined) { if (!steps[i].optional) valid = false; break; }
            const c = candidates(p, steps[i], pickedIds).find(x => x.card.id === id);
            if (!c) { valid = false; break; }
            picks.push(c.card); pickedIds.push(id);
          }
          if (!valid || !picks.length) break;
          if (v === 11) {
            picks.forEach(c => { g.knows[p].add(c.id); g.flash[p].add(c.id); });
            g.hl = new Set(pickedIds);
            g.stage = 'witch'; g.pending = { v, picks };
          } else {
            applyAbility(p, v, picks);
            endTurn();
          }
          break;
        }
        case 'witch':
          if (g.stage !== 'witch') break;
          applyAbility(p, 11, g.pending.picks, !!a.swap);
          endTurn();
          break;
      }
      changed();
    }

    // ---- redacted view ----
    function viewFor(p) {
      if (!g) return null;
      const reveal = g.phase === 'roundEnd' || g.phase === 'gameOver';
      const villages = [0, 1].map(o => g.villages[o].map((c, i) => {
        const seen = c.faceUp || reveal || g.flash[p].has(c.id);
        return { id: c.id, v: seen ? c.v : null, up: c.faceUp || reveal, peeked: g.peeks[p].includes(c.id),
                 t: targetable(p, o, c), g: guarded(o, i) };
      }));
      const top = g.deck[g.deck.length - 1];
      const showTop = !!top && (squireActive() || g.deckPeek[p] === top.id);
      const dt = g.discard[g.discard.length - 1];
      const mine = myTurn(p);
      const view = {
        me: p, round: g.round, rounds: ROUNDS, phase: g.phase, stage: mine ? g.stage : null,
        turn: g.turn, caller: g.caller, amulet: g.amulet, amuletOn: g.amuletOn,
        totals: g.totals, history: g.history, villages,
        deck: { count: g.deck.length, topId: top ? top.id : null, topV: showTop ? top.v : null, squire: squireActive() },
        discardTop: dt ? { id: dt.id, v: dt.v } : null,
        drawn: g.drawn ? { id: g.drawn.card.id, from: g.drawn.from,
                           v: (g.turn === p || g.drawn.from === 'discard' || g.drawn.revealed) ? g.drawn.card.v : null } : null,
        flash: Array.from(g.flash[p]), hl: Array.from(g.hl),
        peeks: g.peeks[p].length, ready: !!g.ready[p], oppReady: !!g.ready[opp(p)],
        canCall: canCall(p),
        empath: mine && g.stage === 'main' && hasFaceUp(p, 2) && !g.flags.empath &&
                g.villages[p].some(c => !c.faceUp && targetable(p, p, c)),
        rascal: mine && g.stage === 'main' && hasFaceUp(p, 4) && !g.flags.rascal && g.deck.length > 0 && !squireActive(),
        amuletReady: mine && g.stage === 'main' && g.amulet === p && g.amuletOn === null,
        callBlocked: mine && g.stage === 'main' && g.caller === null && !canCall(p)
          ? (g.villages[p].length > MAX_CALL_CARDS ? 'Need ' + MAX_CALL_CARDS + ' or fewer cards to call' : 'You cannot call after using an ability or the Amulet this turn')
          : null,
        drawnAbility: mine && g.stage === 'drawn' && CARDS[g.drawn.card.v].when === 'discard'
          ? { possible: abilityPossible(p, g.drawn.card.v) } : null,
        ability: mine && g.stage === 'ability'
          ? { v: g.pending.v, steps: abilitySteps(g.pending.v).map(s => ({ label: s.label, optional: !!s.optional, owner: s.owner, faceDown: !!s.faceDown })) }
          : null,
        witch: mine && g.stage === 'witch' ? g.pending.picks.map(c => c.id) : null,
        lastRound: g.lastRound,
        log: g.log.slice(-60).map(e => ({
          who: e.p === null ? 'sys' : e.p === p ? 'you' : 'opp',
          t: e.t.replace(/\{P(\d)\}/g, (m, i) => +i === p ? 'You' : 'Opponent')
                .replace(/\{S(\d)\}/g, (m, i) => +i === p ? 'your' : "Opponent's"),
        })),
      };
      return view;
    }

    return { newGame, handle, viewFor, _state: () => g };
  }

  /* ================================ CLIENT (UI) ================================ */
  function createClient(rootEl, dispatch, opts) {
    opts = opts || {};
    let view = null, sel = [], picks = [], localMode = null, uiKey = '', drag = null, dropFrom = null;

    rootEl.innerHTML = `
      <div class="sv">
        <div class="sv-top">
          <span class="sv-round" data-r="round"></span>
          <span class="sv-turn" data-r="turn"></span>
          <span class="sv-score" data-r="scoreChip"></span>
          <span class="sv-spacer"></span>
          <button class="sv-mini" data-r="scoresBtn">Scores</button>
          <button class="sv-mini" data-r="logBtn">Log</button>
          <button class="sv-mini" data-r="rulesBtn">Rules</button>
          <button class="sv-mini sv-leave" data-r="leaveBtn">Leave</button>
        </div>
        <div class="sv-zone" data-r="oppZone">
          <div class="sv-zlabel"><b>Opponent</b> <span data-r="oppInfo"></span></div>
          <div class="sv-village" data-r="oppVillage"></div>
        </div>
        <div class="sv-mid">
          <div class="sv-table">
            <div class="sv-pile"><div data-r="deck"></div><small data-r="deckLabel"></small></div>
            <div class="sv-pile"><div data-r="discard"></div><small>Discard</small></div>
            <div class="sv-pile"><div data-r="drawn"></div><small data-r="drawnLabel">&nbsp;</small></div>
            <div class="sv-pile" data-r="amuletPile"><div data-r="amulet"></div><small data-r="amuletLabel">&nbsp;</small></div>
          </div>
          <div class="sv-say">
            <div class="sv-prompt" data-r="prompt"></div>
            <div class="sv-actions" data-r="actions"></div>
          </div>
        </div>
        <div class="sv-zone" data-r="myZone">
          <div class="sv-zlabel"><b>Your village</b> <span data-r="myInfo"></span></div>
          <div class="sv-village" data-r="myVillage"></div>
        </div>
        <div class="sv-overlay" data-r="overlay" hidden><div class="sv-box" data-r="box"></div></div>
      </div>`;
    const R = {};
    rootEl.querySelectorAll('[data-r]').forEach(el => { R[el.dataset.r] = el; });
    R.scores = document.createElement('div');   // rendered off-screen, shown in the Scores pop-up
    R.log = document.createElement('div');
    R.rulesBtn.onclick = showRules;
    R.scoresBtn.onclick = () => showPanel('Scores', R.scores.innerHTML);
    R.logBtn.onclick = () => showPanel('Log', '<div class="sv-log">' + R.log.innerHTML + '</div>');
    R.leaveBtn.onclick = () => { if (opts.onLeave) opts.onLeave(); };
    R.overlay.addEventListener('click', e => { if (e.target === R.overlay) R.overlay.hidden = true; });

    const isMine = () => view && view.phase === 'play' && view.turn === view.me;
    const myCard = id => view.villages[view.me].find(c => c.id === id);
    const cardName = v => '<b>' + v + '</b> ' + CARDS[v].name;

    // ---- card elements ----
    function faceEl(v, extra) {
      const d = document.createElement('div');
      d.className = 'sv-card sv-face ' + (extra || '');
      d.title = v + ' ' + CARDS[v].name + ' — ' + CARDS[v].text;
      // text underneath, picture on top: if the picture is missing the value/name still shows
      d.innerHTML = '<span class="sv-fallback">' + v + '<small>' + CARDS[v].name + '</small></span>' +
        '<img class="sv-img" alt="" draggable="false" src="' + IMG(v) + '" onerror="this.remove()">';
      return d;
    }
    function backEl(extra) { const d = document.createElement('div'); d.className = 'sv-card sv-back ' + (extra || ''); return d; }
    function emptyEl(text, cls) { const d = document.createElement('div'); d.className = 'sv-empty ' + (cls || ''); d.textContent = text; return d; }

    function stepCandidates(step) {
      // mirror of engine.candidates using the view's per-card targetable flag
      const owners = step.owner === 'self' ? [view.me] : step.owner === 'opp' ? [1 - view.me] : [0, 1];
      const out = [];
      for (const o of owners) for (const c of view.villages[o]) {
        if (!c.t) continue;
        if (step.faceDown && c.up) continue;
        if (picks.includes(c.id)) continue;
        out.push(c.id);
      }
      return out;
    }
    function clickable(owner, c) {
      if (!view) return false;
      if (view.phase === 'peek') return owner === view.me && view.peeks < 2 && !c.peeked;
      if (!isMine()) return false;
      if (localMode === 'empath') return owner === view.me && !c.up && c.t;
      if (view.stage === 'ability') { const s = view.ability.steps[picks.length]; return !!s && stepCandidates(s).includes(c.id); }
      if (view.stage === 'main' || view.stage === 'drawn') return owner === view.me && c.t;
      return false;
    }
    function onCardClick(owner, c) {
      if (view.phase === 'peek') return dispatch({ kind: 'peek', id: c.id });
      if (localMode === 'empath') { localMode = null; return dispatch({ kind: 'empath', id: c.id }); }
      if (view.stage === 'ability') {
        picks.push(c.id);
        const next = view.ability.steps[picks.length];
        if (!next || (next.optional && !stepCandidates(next).length)) return sendAbility();
        return render(view);
      }
      const i = sel.indexOf(c.id);
      if (i >= 0) sel.splice(i, 1); else sel.push(c.id);
      render(view);
    }
    function sendAbility() { const ids = picks.slice(); picks = []; dispatch({ kind: 'ability', ids }); }

    function cardView(owner, c) {
      const flash = view.flash.includes(c.id);
      let el;
      el = c.v !== null ? faceEl(c.v) : backEl();
      el.dataset.id = c.id;
      if (owner === view.me) el.dataset.drop = 'village';
      if (flash) el.classList.add('sv-flash');
      if (view.hl.includes(c.id)) el.classList.add('sv-hl');
      if (sel.includes(c.id) || picks.includes(c.id)) el.classList.add('sv-selected');
      if (c.id === view.amuletOn) el.insertAdjacentHTML('beforeend', '<span class="sv-amulet-on" title="Protected by the Silver Amulet">✧</span>');
      if (c.g) el.insertAdjacentHTML('beforeend', '<span class="sv-guard" title="Guarded by an adjacent Bodyguard">🛡</span>');
      if (clickable(owner, c)) { el.classList.add('sv-click'); el.addEventListener('click', () => onCardClick(owner, c)); }
      return el;
    }

    // ---- main render ----
    function render(v) {
      if (!v) return;
      const snap = snapshot();
      view = v;
      const key = [v.round, v.turn, v.stage, v.phase].join('|');
      if (key !== uiKey) { uiKey = key; sel = []; picks = []; localMode = null; }
      sel = sel.filter(id => myCard(id) && myCard(id).t);
      const me = v.me, op = 1 - me, mine = isMine();

      R.round.textContent = 'Round ' + v.round + ' / ' + v.rounds + (v.caller !== null && v.phase === 'play' ? ' · ' + (v.caller === me ? 'you' : 'opponent') + ' called a vote' : '');
      R.turn.textContent = v.phase === 'peek' ? 'Peek' : v.phase === 'play' ? (mine ? 'Your turn' : "Opponent's turn") : 'Round over';
      R.turn.className = 'sv-turn' + (mine ? ' sv-turn-mine' : '');

      R.oppVillage.innerHTML = ''; v.villages[op].forEach(c => R.oppVillage.appendChild(cardView(op, c)));
      R.myVillage.innerHTML = ''; v.villages[me].forEach(c => R.myVillage.appendChild(cardView(me, c)));
      R.oppInfo.textContent = v.villages[op].length + ' cards' + (v.amulet === op ? ' · holds the Silver Amulet ✧' : '');
      R.myInfo.textContent = v.villages[me].length + ' cards' + (v.amulet === me ? ' · you hold the Silver Amulet ✧' : '');
      R.myZone.classList.toggle('sv-active', mine);
      R.oppZone.classList.toggle('sv-active', v.phase === 'play' && !mine);

      // deck
      R.deck.innerHTML = '';
      if (v.deck.count) {
        const de = v.deck.topV !== null ? faceEl(v.deck.topV) : backEl();
        de.dataset.id = v.deck.topId;
        if (mine && v.stage === 'main' && !localMode) de.dataset.drag = 'deck';
        R.deck.appendChild(de);
      } else R.deck.appendChild(emptyEl('empty'));
      R.deckLabel.textContent = 'Deck · ' + v.deck.count + (v.deck.squire ? ' · top revealed' : '');
      // discard
      R.discard.innerHTML = '';
      const dte = v.discardTop ? faceEl(v.discardTop.v) : emptyEl('empty');
      if (v.discardTop) {
        dte.dataset.id = v.discardTop.id;
        if (mine && v.stage === 'main' && !localMode && v.villages[me].some(c => c.t)) dte.dataset.drag = 'discard';
        if (v.hl.includes(v.discardTop.id)) dte.classList.add('sv-hl');
      }
      if (mine && v.stage === 'drawn') dte.dataset.drop = 'discard';
      R.discard.appendChild(dte);
      // drawn
      R.drawn.innerHTML = '';
      if (v.drawn) {
        const dre = v.drawn.v !== null ? faceEl(v.drawn.v, 'sv-hl') : backEl('sv-hl');
        dre.dataset.id = v.drawn.id;
        if (mine && v.stage === 'drawn') dre.dataset.drag = 'drawn';
        R.drawn.appendChild(dre);
        R.drawnLabel.textContent = v.turn === me ? 'Your card' : "Opponent's card";
      } else {
        const slot = emptyEl(mine && v.stage === 'main' ? 'drop deck here' : '', 'sv-slot');
        if (mine && v.stage === 'main') slot.dataset.drop = 'draw';
        R.drawn.appendChild(slot); R.drawnLabel.innerHTML = '&nbsp;';
      }
      // amulet token
      R.amulet.innerHTML = '';
      if (v.amulet !== null && v.amuletOn === null) {
        const t = document.createElement('div'); t.className = 'sv-amulet'; t.textContent = '✧'; t.dataset.id = 'amulet';
        t.title = v.amulet === me ? 'Drag onto one of your cards to protect it' : "Opponent's Silver Amulet";
        if (v.amuletReady && !localMode) t.dataset.drag = 'amulet';
        R.amulet.appendChild(t);
        R.amuletLabel.textContent = v.amulet === me ? 'Your Amulet' : "Their Amulet";
      } else R.amuletLabel.innerHTML = '&nbsp;';

      renderPrompt();
      renderScores();
      R.scoreChip.textContent = 'You ' + v.totals[me] + ' · Opp ' + v.totals[op];
      R.amuletPile.hidden = !(v.amulet !== null && v.amuletOn === null);
      R.log.innerHTML = v.log.slice().reverse().map(e => '<div class="sv-log-' + e.who + '">' + e.t + '</div>').join('');
      fit();
      animateFrom(snap);

      if (v.phase === 'roundEnd' || v.phase === 'gameOver') showSummary();
      else R.overlay.hidden = true;
    }

    function btn(label, fn, opts) {
      opts = opts || {};
      const b = document.createElement('button');
      b.className = 'sv-btn ' + (opts.cls || ''); b.textContent = label; b.onclick = fn;
      if (opts.disabled) b.disabled = true; if (opts.title) b.title = opts.title;
      R.actions.appendChild(b); return b;
    }
    function renderPrompt() {
      const v = view, P = R.prompt; R.actions.innerHTML = '';
      const selNote = sel.length ? '<br><span class="sv-sel-note">' + sel.length + ' card(s) selected — drop onto one of them to exchange them all.</span>' : '';
      if (v.phase === 'peek') {
        if (v.peeks < 2) P.innerHTML = 'Secretly look at <b>two</b> of your cards — click them (' + v.peeks + '/2).';
        else if (!v.ready) {
          P.innerHTML = 'Memorise these two cards — they will be hidden again when you press Ready.';
          btn('Ready', () => dispatch({ kind: 'ready' }), { cls: 'sv-primary' });
        } else P.innerHTML = 'Waiting for your opponent' + (v.oppReady ? '…' : ' to memorise their cards…');
        return;
      }
      if (v.phase !== 'play') { P.textContent = 'Round over.'; return; }
      if (!isMine()) {
        P.innerHTML = (v.caller === v.me ? 'You called a vote. ' : '') + "Opponent's turn…";
        return;
      }
      if (localMode === 'empath') {
        P.innerHTML = '<span class="sv-muted">Empath</span><br>Click one of your face-down cards to look at it.';
        btn('Cancel', () => { localMode = null; render(view); });
        return;
      }
      switch (v.stage) {
        case 'main':
          P.innerHTML = (v.caller !== null ? '<b>Your opponent called a vote — this is your last turn!</b><br>' : '') +
            'Drag the <b>deck</b> to the empty slot (or tap it) to draw, or drag the <b>discard</b> onto one of your cards.' +
            (sel.length ? selNote : '<br><span class="sv-muted">Tip: tap several of your cards first to exchange a matching set.</span>') +
            (v.amuletReady ? '<br><span class="sv-muted">Drag your Silver Amulet onto a card to protect it.</span>' : '');
          if (v.caller === null) btn('Call for a vote', () => dispatch({ kind: 'call' }), { cls: 'sv-danger', disabled: !v.canCall, title: v.callBlocked || 'End the round: your opponent gets one last turn' });
          if (v.empath) btn('Use Empath', () => { localMode = 'empath'; render(view); });
          if (v.rascal) btn('Use Rascal (peek deck)', () => dispatch({ kind: 'rascal' }));
          if (sel.length) btn('Clear selection', () => { sel = []; render(view); });
          break;
        case 'drawn': {
          const c = v.drawn.v;
          const ab = v.drawnAbility;
          P.innerHTML = 'You drew ' + cardName(c) + '.' + (ab ? ' <span class="sv-muted">Ability: ' + CARDS[c].text + '</span>' : '') +
            '<br>Drag it onto one of your cards to exchange, or onto the <b>discard pile</b> to discard' +
            (ab ? (ab.possible ? ' and use its ability' : ' (no valid targets for its ability)') : '') + '.' + selNote;
          if (sel.length) btn('Clear selection', () => { sel = []; render(view); });
          break;
        }
        case 'ability': {
          const s = v.ability.steps[picks.length];
          P.innerHTML = '<span class="sv-muted">' + CARDS[v.ability.v].name + ': ' + CARDS[v.ability.v].text + '</span><br>' + (s ? s.label : '');
          if (s && s.optional) btn('Done', sendAbility, { cls: 'sv-primary' });
          btn('Skip ability', () => { picks = []; dispatch({ kind: 'skip' }); });
          break;
        }
        case 'witch':
          P.innerHTML = 'Witch: swap these two cards?';
          btn('Swap them', () => dispatch({ kind: 'witch', swap: true }), { cls: 'sv-primary' });
          btn('Keep as is', () => dispatch({ kind: 'witch', swap: false }));
          break;
      }
    }
    function renderScores() {
      const v = view, me = v.me, op = 1 - me;
      let h = '<table class="sv-scores"><tr><th>Round</th><th>You</th><th>Opponent</th></tr>';
      for (let r = 0; r < v.rounds; r++) {
        const x = v.history[r];
        h += '<tr><td>' + (r + 1) + '</td><td>' + (x ? x.score[me] : '') + '</td><td>' + (x ? x.score[op] : '') + '</td></tr>';
      }
      h += '<tr><th>Total</th><th>' + v.totals[me] + '</th><th>' + v.totals[op] + '</th></tr></table>';
      R.scores.innerHTML = h;
    }
    function miniRow(o) {
      return '<div class="sv-mini-row">' + view.villages[o].map(c => '<div class="sv-card sv-face sv-small" style="background-image:url(&quot;' + IMG(c.v) + '&quot;)"></div>').join('') + '</div>';
    }
    function showSummary() {
      const v = view, me = v.me, op = 1 - me, lr = v.lastRound;
      if (!lr) return;
      const note = lr.note.replace(/\{P(\d)\}/g, (m, i) => +i === me ? 'You' : 'Your opponent');
      let head = '';
      if (v.phase === 'gameOver') {
        head = v.totals[me] < v.totals[op] ? '<h2 class="sv-win">You win! ✧</h2>'
             : v.totals[op] < v.totals[me] ? '<h2 class="sv-lose">Your opponent wins.</h2>' : '<h2>It\'s a tie!</h2>';
      }
      R.box.innerHTML = head + '<h3>Round ' + v.round + ' results</h3><p>' + note + '.</p>' +
        '<p><b>Your village</b> — total ' + lr.sums[me] + ' → <b>' + lr.score[me] + '</b></p>' + miniRow(me) +
        '<p><b>Opponent</b> — total ' + lr.sums[op] + ' → <b>' + lr.score[op] + '</b></p>' + miniRow(op) +
        '<p>Totals — You: <b>' + v.totals[me] + '</b> · Opponent: <b>' + v.totals[op] + '</b></p>' +
        (v.amulet !== null && v.phase !== 'gameOver' ? '<p>' + (v.amulet === me ? 'You receive' : 'Your opponent receives') + ' the Silver Amulet for the next round.</p>' : '') +
        '<div class="sv-box-actions"></div>';
      const actions = R.box.querySelector('.sv-box-actions');
      const b1 = document.createElement('button'); b1.className = 'sv-btn sv-primary';
      b1.textContent = v.phase === 'gameOver' ? 'Play again' : 'Start round ' + (v.round + 1);
      b1.onclick = () => dispatch({ kind: 'next' });
      const b2 = document.createElement('button'); b2.className = 'sv-btn'; b2.textContent = 'Look at the table';
      b2.onclick = () => { R.overlay.hidden = true; };
      actions.append(b1, b2);
      if (R.overlay.dataset.shownFor !== String(v.round) + v.phase) { R.overlay.hidden = false; R.overlay.dataset.shownFor = String(v.round) + v.phase; }
    }
    function showPanel(title, html) {
      R.box.innerHTML = '<h2>' + title + '</h2>' + html + '<div class="sv-box-actions"><button class="sv-btn sv-primary">Close</button></div>';
      R.box.querySelector('.sv-box-actions button').onclick = () => { R.overlay.hidden = true; };
      R.overlay.dataset.shownFor = 'panel'; R.overlay.hidden = false;
    }

    /* ---- sizing: cards as big as the window allows, no scrolling ----
       Three card rows (opponent, table, you) share the height left after the bars;
       five cards must fit side by side. Bigger villages overlap instead of wrapping. */
    const GAP = 6;
    function fit() {
      const sv = rootEl.firstElementChild;
      const H = rootEl.clientHeight, W = rootEl.clientWidth;
      if (!sv || !H || !W) return;
      const top = sv.querySelector('.sv-top'), table = sv.querySelector('.sv-table'), say = sv.querySelector('.sv-say');
      const nMax = Math.max(5, R.oppVillage.children.length, R.myVillage.children.length);
      let layout = { r: 1, per: nMax };
      for (let pass = 0; pass < 4; pass++) {
        const cw = parseFloat(sv.style.getPropertyValue('--cw')) || 60, ch = cw * 1.5;
        // height of everything that is not a card: bars, labels, paddings, prompt
        const zoneExtra = (R.oppZone.offsetHeight - R.oppVillage.offsetHeight) + (R.myZone.offsetHeight - R.myVillage.offsetHeight);
        const tableExtra = table.offsetHeight - ch;
        const wrapped = say.offsetTop > table.offsetTop + 4;           // prompt sits under the piles
        const midExtra = wrapped ? tableExtra + 4 + say.offsetHeight : Math.max(tableExtra, say.offsetHeight - ch);
        const other = top.offsetHeight + zoneExtra + midExtra + GAP * 3 + 2;
        const rowW = R.myZone.clientWidth - 16;
        // one row per village, or two rows (tall, narrow screens) if that makes cards clearly bigger
        let best = null;
        for (const r of [1, 2]) {
          const per = Math.ceil(nMax / r);
          const byWidth = (rowW - (per - 1) * GAP) / per;
          const byHeight = (H - other - 2 * (r - 1) * GAP) / ((2 * r + 1) * 1.5);
          const w = Math.max(28, Math.min(byWidth, byHeight, 170));
          if (!best || w > best.w * 1.12) best = { w, r, per };
        }
        layout = best;
        sv.dataset.rows = best.r;
        const done = Math.abs(best.w - cw) < 0.5;
        sv.style.setProperty('--cw', best.w.toFixed(1) + 'px');
        if (done) break;
      }
      const w = parseFloat(sv.style.getPropertyValue('--cw'));
      for (const row of [R.oppVillage, R.myVillage]) {
        row.style.maxWidth = layout.r === 2 ? (layout.per * w + (layout.per - 1) * GAP) + 'px' : '';
      }
      overlapRows(layout.r);
    }
    function overlapRows(rows) {
      for (const row of [R.oppVillage, R.myVillage]) {
        const cards = Array.from(row.children), n = cards.length;
        if (!n) continue;
        if (rows === 2) { cards.forEach(c => { c.style.marginLeft = ''; }); continue; }
        const w = cards[0].offsetWidth, avail = row.clientWidth;
        const need = n * w + (n - 1) * GAP;
        const m = need > avail && n > 1 ? (avail - n * w) / (n - 1) : GAP;
        cards.forEach((c, i) => { c.style.marginLeft = i ? m + 'px' : '0'; });
      }
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;
    if (ro) ro.observe(rootEl);

    function showRules() {
      let ref = '';
      for (let v = 0; v <= 13; v++) ref += '<li><b>' + v + ' ' + CARDS[v].name + '</b> ×' + COUNT(v) + ' — ' + CARDS[v].text + '</li>';
      R.box.innerHTML = '<h2>How to play Silver</h2>' +
        '<p>Lowest total after ' + ROUNDS + ' rounds wins. Each village starts with 5 face-down cards; at the start of a round you look at 2 of yours — then you have to remember them.</p>' +
        '<ul><li><b>Draw from the deck</b>, then exchange it into your village or discard it (cards 5–12 let you use their ability when discarded this way).</li>' +
        '<li><b>Take the top discard</b> and exchange it into your village.</li>' +
        '<li><b>Call for a vote</b> with ' + MAX_CALL_CARDS + ' or fewer cards: your opponent gets one last turn, then all cards are revealed. Lowest (or tied) caller scores 0 and gets the Silver Amulet; otherwise the caller scores their total +' + CALL_PENALTY + '.</li>' +
        '<li><b>Matching sets:</b> exchange several cards of the same value for one card (13 matches anything). A wrong guess keeps them all, adds the drawn card, and 3+ cards also add a penalty card.</li></ul>' +
        '<h3>Cards</h3><ul class="sv-ref">' + ref + '</ul>' +
        '<div class="sv-box-actions"><button class="sv-btn sv-primary">Got it</button></div>';
      R.box.querySelector('button').onclick = () => { R.overlay.hidden = true; };
      R.overlay.dataset.shownFor = 'rules'; R.overlay.hidden = false;
    }

    // ---- drag & drop (pointer events: works with mouse and touch) ----
    function validDrop(kind, el) {
      const t = el.dataset.drop; if (!t) return false;
      const c = t === 'village' ? myCard(+el.dataset.id) : null;
      switch (kind) {
        case 'deck': return t === 'draw' || t === 'village';
        case 'discard': return t === 'village' && !!c && c.t;
        case 'drawn': return t === 'discard' || (t === 'village' && !!c && c.t);
        case 'amulet': return t === 'village' && !!c;
      }
      return false;
    }
    function markTargets(kind, on) {
      rootEl.querySelectorAll('[data-drop]').forEach(el => {
        el.classList.toggle('sv-droppable', on && validDrop(kind, el));
        if (!on) el.classList.remove('sv-drop-hover');
      });
    }
    function dropAt(x, y, kind) {
      const el = document.elementFromPoint(x, y); const t = el && el.closest('[data-drop]');
      return t && rootEl.contains(t) && validDrop(kind, t) ? t : null;
    }
    function exchangeIds(targetId) {
      return sel.length > 1 && sel.includes(targetId) ? sel.slice() : [targetId];
    }
    const onDown = e => {
      const src = e.target.closest('[data-drag]');
      if (!src || !rootEl.contains(src) || e.button > 0) return;
      e.preventDefault();
      drag = { src, kind: src.dataset.drag, x: e.clientX, y: e.clientY, moved: false };
    };
    const onMove = e => {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
        drag.moved = true;
        const r = drag.src.getBoundingClientRect();
        const gh = drag.src.cloneNode(true); gh.classList.add('sv-ghost'); gh.removeAttribute('data-id');
        gh.style.width = r.width + 'px'; gh.style.height = r.height + 'px';
        drag.ox = drag.x - r.left; drag.oy = drag.y - r.top;
        rootEl.appendChild(gh); drag.ghost = gh;
        drag.src.classList.add('sv-dragging'); markTargets(drag.kind, true);
      }
      drag.ghost.style.left = (e.clientX - drag.ox) + 'px'; drag.ghost.style.top = (e.clientY - drag.oy) + 'px';
      rootEl.querySelectorAll('.sv-drop-hover').forEach(x => x.classList.remove('sv-drop-hover'));
      const t = dropAt(e.clientX, e.clientY, drag.kind); if (t) t.classList.add('sv-drop-hover');
    };
    const onUp = e => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved) { if (d.kind === 'deck') dispatch({ kind: 'draw' }); return; }
      const t = dropAt(e.clientX, e.clientY, d.kind);
      const gr = d.ghost.getBoundingClientRect();
      d.ghost.remove(); d.src.classList.remove('sv-dragging'); markTargets(d.kind, false);
      if (!t) return; // dropped nowhere: nothing happens
      dropFrom = { id: d.src.dataset.id, rect: gr };
      const id = t.dataset.drop === 'village' ? +t.dataset.id : null;
      switch (d.kind) {
        case 'deck': dispatch({ kind: 'draw' }); break;
        case 'discard': dispatch({ kind: 'take', ids: exchangeIds(id) }); break;
        case 'drawn':
          if (t.dataset.drop === 'discard') dispatch({ kind: 'discard', use: !!(view.drawnAbility && view.drawnAbility.possible) });
          else dispatch({ kind: 'exchange', ids: exchangeIds(id) });
          break;
        case 'amulet': dispatch({ kind: 'amulet', id }); break;
      }
    };
    const onCancel = () => {
      if (!drag) return;
      if (drag.ghost) drag.ghost.remove();
      drag.src.classList.remove('sv-dragging'); markTargets(drag.kind, false); drag = null;
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);

    // ---- move animations (FLIP) ----
    function snapshot() {
      const m = new Map();
      rootEl.querySelectorAll('[data-id]').forEach(el => {
        if (el.closest('.sv-overlay')) return;
        m.set(el.dataset.id, { r: el.getBoundingClientRect(), face: el.classList.contains('sv-face') });
      });
      if (dropFrom) { const o = m.get(dropFrom.id); m.set(dropFrom.id, { r: dropFrom.rect, face: o ? o.face : true }); dropFrom = null; }
      return m;
    }
    function animateFrom(before) {
      if (!before.size || !Element.prototype.animate) return;
      const deckEl = R.deck.firstElementChild;
      const deckR = deckEl ? deckEl.getBoundingClientRect() : R.deck.getBoundingClientRect();
      rootEl.querySelectorAll('[data-id]').forEach(el => {
        if (el.closest('.sv-overlay')) return;
        const now = el.getBoundingClientRect(); const b = before.get(el.dataset.id);
        const from = b ? b.r : (el.closest('[data-r="deck"]') ? null : deckR); // new cards come from the deck
        if (from) {
          const dx = from.left - now.left, dy = from.top - now.top;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
            el.style.zIndex = 20;
            el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }],
              { duration: 520, easing: 'cubic-bezier(.22,.8,.25,1)' });
            setTimeout(() => { el.style.zIndex = ''; }, 540);
          }
        }
        const isFace = el.classList.contains('sv-face');
        if (b && b.face !== isFace) {
          el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)', offset: 0.5 }, { transform: 'scaleX(1)' }],
            { duration: 420, easing: 'ease-in-out', composite: 'add' });
        }
      });
    }

    function waiting(text) {
      R.prompt.textContent = text || 'Waiting for the host to deal…';
    }
    function destroy() {
      if (ro) ro.disconnect();
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      rootEl.innerHTML = '';
    }
    return { render, waiting, destroy };
  }

  const api = { createEngine, createClient, CARDS, abilitySteps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SilverPvP = api;
})(typeof window !== 'undefined' ? window : globalThis);
