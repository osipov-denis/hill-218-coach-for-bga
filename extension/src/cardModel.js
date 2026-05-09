/* Battle for Hill 218 read-only card model. Works in browser and Node tests. */
(function (global) {
  const DECK = Object.freeze({
    infantry: { label: 'Infantry', total: 7, aliases: ['infantry', 'пехота'] },
    heavy_weapons: { label: 'Heavy Weapons', total: 5, aliases: ['heavy weapons', 'heavy-weapons', 'heavy weapon', 'heavy', 'тяжелое оружие'] },
    special_forces: { label: 'Special Forces', total: 3, aliases: ['special forces', 'special-forces', 'special force', 'sf', 'спецназ'] },
    tank: { label: 'Tank', total: 3, aliases: ['tank', 'tanks', 'танк', 'танки'] },
    artillery: { label: 'Artillery', total: 3, aliases: ['artillery', 'артиллерия'] },
    paratroopers: { label: 'Paratroopers', total: 3, aliases: ['paratroopers', 'paratrooper', 'paras', 'десант'] },
    air_strike: { label: 'Air Strike', total: 2, aliases: ['air strike', 'air-strike', 'airstrike', 'air strikes', 'авиаудар'] }
  });

  function emptyCounts() {
    return Object.fromEntries(Object.keys(DECK).map((key) => [key, 0]));
  }

  function normalize(text) {
    return String(text || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  }

  function typeKeyToCard(typeKey) {
    const normalized = normalize(typeKey).replace(/_/g, '-');
    for (const [key, spec] of Object.entries(DECK)) {
      if (key.replace(/_/g, '-') === normalized) return key;
      if (spec.aliases.some((alias) => normalize(alias).replace(/_/g, '-') === normalized)) return key;
    }
    return null;
  }

  function detectCard(line) {
    const normalized = normalize(line);
    const directType = typeKeyToCard(normalized);
    if (directType) return directType;
    for (const [key, spec] of Object.entries(DECK)) {
      if (spec.aliases.some((alias) => normalized.includes(alias))) return key;
    }
    return null;
  }

  function detectPlayer(line, ownNames = ['you', 'me', 'denis', 'дэн', 'денис', 'я'], opponentNames = ['opponent', 'enemy', 'противник', 'соперник']) {
    const normalized = normalize(line);
    if (opponentNames.some((name) => normalized.includes(normalize(name)))) return 'opponent';
    if (ownNames.some((name) => normalized.includes(normalize(name)))) return 'own';
    return 'unknown';
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isSpentCardEvent(line, card) {
    const normalized = normalize(line);
    const aliases = [card.replace(/_/g, '-'), ...(DECK[card]?.aliases || [])]
      .map((alias) => normalize(alias).replace(/_/g, '-'));
    const cardPattern = aliases.map(escapeRegExp).join('|');
    const actionBeforeCard = new RegExp(`\\b(?:played|plays|placed|places|destroyed|destroys)\\s+(?:a |an |the )?(?:${cardPattern})\\b`);
    const destroyedAfterCard = new RegExp(`\\b(?:${cardPattern})\\b\\s+(?:was |is )?(?:destroyed|placed|played)\\b`);
    return actionBeforeCard.test(normalized) || destroyedAfterCard.test(normalized);
  }

  function isIgnorableLogLine(line) {
    const normalized = normalize(line);
    if (!normalized) return true;
    return [
      /replay last moves/,
      /^turn\s+\d+\b/,
      /^move\s+\d+\s*:?\b/,
      /^(?:\d{2}\.\d{2}\.\d{4}\s+)?\d{1,2}:\d{2}(?::\d{2})?$/,
      /^game log$/,
      /^choose your point of view:?$/,
      /^choose this player$/,
      /^end of game$/,
      /must place a card/,
      /must discard a card/,
      /must choose/,
      /would like to think/,
      /^game started/,
      /^game over/,
    ].some((pattern) => pattern.test(normalized));
  }

  function cardNamePattern() {
    const names = [];
    for (const [key, spec] of Object.entries(DECK)) {
      names.push(spec.label, key.replace(/_/g, ' '), key.replace(/_/g, '-'), ...(spec.aliases || []));
    }
    return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
  }

  const CARD_RE = cardNamePattern();
  const COORD_RE = '(-?\\d+)\\s*,\\s*(-?\\d+)';

  function parseLocation(x, y) {
    return { x: Number(x), y: Number(y) };
  }

  function normalizeActor(actor) {
    return String(actor || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeLogInput(input) {
    if (Array.isArray(input)) {
      return input.map((entry, index) => {
        if (typeof entry === 'string') return { id: '', text: entry.trim(), order: index };
        return {
          id: String(entry?.id || ''),
          text: String(entry?.text ?? entry?.innerText ?? entry?.textContent ?? '').trim(),
          order: index,
        };
      }).filter((entry) => entry.text);
    }
    return String(input || '').split(/\r?\n/).map((line, index) => ({ id: '', text: line.trim(), order: index })).filter((entry) => entry.text);
  }

  function canonicalLogKey(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s+(?:(?:\d{2}\.\d{2}\.\d{4}\s+)?\d{1,2}:\d{2})$/, '')
      .toLowerCase();
  }

  function extractReplayOrder(entry) {
    const haystack = `${entry?.id || ''} ${entry?.text || ''}`;
    const match = haystack.match(/\b(?:move|step|turn|goto)[^\d]*(\d+)\b/i)
      || haystack.match(/\b(?:archive|log|notif|dockedlog)[^\d]*(\d+)\b/i);
    return match ? Number(match[1]) : null;
  }

  function normalizeReplayOrder(entries = []) {
    const decorated = entries.map((entry, index) => ({ entry, index, replayOrder: extractReplayOrder(entry) }));
    const orderedCount = decorated.filter((item) => Number.isInteger(item.replayOrder)).length;
    if (orderedCount < 2) return entries;
    return decorated
      .sort((a, b) => {
        if (Number.isInteger(a.replayOrder) && Number.isInteger(b.replayOrder)) {
          return a.replayOrder - b.replayOrder || a.index - b.index;
        }
        if (Number.isInteger(a.replayOrder)) return -1;
        if (Number.isInteger(b.replayOrder)) return 1;
        return a.index - b.index;
      })
      .map((item) => item.entry);
  }

  function classifyPlayer(line, actor, options = {}) {
    const actorPlayer = detectPlayer(actor || '', options.ownNames, options.opponentNames);
    if (actorPlayer !== 'unknown') return actorPlayer;
    return detectPlayer(line, options.ownNames, options.opponentNames);
  }

  function buildEvent(base, extra) {
    const event = { ...base, ...extra };
    if (!event.id) delete event.id;
    return event;
  }

  function parseBgaLogLine(entry, options = {}) {
    const line = String(entry?.text ?? entry ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s+(?:(?:\d{2}\.\d{2}\.\d{4}\s+)?\d{1,2}:\d{2})$/, '');
    if (!line) return null;
    const flags = 'i';
    const base = (match) => {
      const actor = normalizeActor(match.groups?.actor);
      return {
        id: entry?.id || '',
        type: '',
        actor,
        player: classifyPlayer(line, actor, options),
        line,
      };
    };

    let match = line.match(new RegExp(`^(?<actor>.+?)\\s+placed\\s+(?:a|an|the)\\s+(?<card>${CARD_RE})\\s+card\\s+at\\s+${COORD_RE}\\s*$`, flags));
    if (match) {
      return buildEvent(base(match), {
        type: 'place',
        card: detectCard(match.groups.card),
        location: parseLocation(match.at(-2), match.at(-1)),
        count: 1,
      });
    }

    match = line.match(new RegExp(`^(?<actor>.+?)\\s+played\\s+(?:a|an|the)\\s+(?<card>${CARD_RE})\\s+card\\s+destroying\\s+the\\s+(?<targetCard>${CARD_RE})\\s+card\\s+at\\s+${COORD_RE}\\s*$`, flags));
    if (match && detectCard(match.groups.card) === 'air_strike') {
      return buildEvent(base(match), {
        type: 'air_strike',
        card: 'air_strike',
        targetCard: detectCard(match.groups.targetCard),
        targetLocation: parseLocation(match.at(-2), match.at(-1)),
        count: 1,
      });
    }

    match = line.match(/^(?<actor>.+?)\s+has\s+drawn\s+(?<count>\d+)\s+cards?\s*$/i);
    if (match) return buildEvent(base(match), { type: 'draw', count: clampCount(match.groups.count) });

    match = line.match(/^(?<actor>.+?)\s+returned\s+(?<count>\d+)\s+cards?\s+to\s+their\s+deck\s*$/i);
    if (match) return buildEvent(base(match), { type: 'return', count: clampCount(match.groups.count) });

    match = line.match(new RegExp(`^(?<actor>.+?)\\s+attacked\\s+the\\s+(?<targetCard>${CARD_RE})\\s+at\\s+(?<tx>-?\\d+)\\s*,\\s*(?<ty>-?\\d+)\\s+with\\s+the\\s+(?<attackerCard>${CARD_RE})\\s+at\\s+(?<ax>-?\\d+)\\s*,\\s*(?<ay>-?\\d+)\\s*$`, flags));
    if (match) {
      return buildEvent(base(match), {
        type: 'attack',
        targetCard: detectCard(match.groups.targetCard),
        targetLocation: parseLocation(match.groups.tx, match.groups.ty),
        attackerCard: detectCard(match.groups.attackerCard),
        attackerLocation: parseLocation(match.groups.ax, match.groups.ay),
        count: 1,
      });
    }

    return null;
  }

  function emptyNumericCounters() {
    return { drawn: 0, returned: 0, attacks: 0 };
  }

  function parseBgaLogLines(input, options = {}) {
    const own = emptyCounts();
    const opponent = emptyCounts();
    const unknown = emptyCounts();
    const counters = { own: emptyNumericCounters(), opponent: emptyNumericCounters(), unknown: emptyNumericCounters() };
    const seen = new Set();
    const rawLines = normalizeLogInput(input);
    const uniqueLines = [];
    let duplicateLines = 0;

    for (const entry of rawLines) {
      const key = entry.id ? `id:${entry.id}` : '';
      if (key && seen.has(key)) {
        duplicateLines += 1;
        continue;
      }
      if (key) seen.add(key);
      uniqueLines.push(entry);
    }

    const chronologicalLines = normalizeReplayOrder(uniqueLines);
    const events = [];
    for (const entry of chronologicalLines) {
      const event = parseBgaLogLine(entry, options);
      if (!event) continue;
      events.push(event);
      const cardBucket = event.player === 'own' ? own : (event.player === 'opponent' ? opponent : unknown);
      if (event.type === 'place' || event.type === 'air_strike') cardBucket[event.card] += 1;
      const counterBucket = counters[event.player] || counters.unknown;
      if (event.type === 'draw') counterBucket.drawn += event.count;
      else if (event.type === 'return') counterBucket.returned += event.count;
      else if (event.type === 'attack') counterBucket.attacks += 1;
    }

    return summarizeCounts({
      own,
      opponent,
      unknown,
      events,
      sourceLines: uniqueLines.map((entry) => entry.text),
      counters,
      metricOverrides: {
        totalLines: chronologicalLines.length,
        rawLines: rawLines.length,
        duplicateLines,
        parsedEvents: events.length,
        unparsedLines: chronologicalLines.length - events.length,
        parseCoverage: chronologicalLines.length ? events.length / chronologicalLines.length : 1,
        duplicateRate: rawLines.length ? duplicateLines / rawLines.length : 0,
      },
    });
  }

  function parseLog(text, options = {}) {
    const own = emptyCounts();
    const opponent = emptyCounts();
    const unknown = emptyCounts();
    const events = [];
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      const parsedBgaEvent = parseBgaLogLine({ text: line }, options);
      if (parsedBgaEvent && (parsedBgaEvent.type === 'place' || parsedBgaEvent.type === 'air_strike')) {
        const { player, card } = parsedBgaEvent;
        if (player === 'own') own[card] += 1;
        else if (player === 'opponent') opponent[card] += 1;
        else unknown[card] += 1;
        events.push({ player, card, line });
        continue;
      }
      const card = detectCard(line);
      if (!card || !isSpentCardEvent(line, card)) continue;
      const player = detectPlayer(line, options.ownNames, options.opponentNames);
      if (player === 'own') own[card] += 1;
      else if (player === 'opponent') opponent[card] += 1;
      else unknown[card] += 1;
      events.push({ player, card, line });
    }
    return summarizeCounts({ own, opponent, unknown, events, sourceLines: lines });
  }

  function remainingFor(counts) {
    return Object.fromEntries(Object.entries(DECK).map(([key, spec]) => [key, Math.max(0, spec.total - (counts[key] || 0))]));
  }

  function buildReplayLedgerTrace(events = []) {
    const usedByPlayer = { own: 0, opponent: 0, unknown: 0 };
    const leftByPlayer = { own: 26, opponent: 26, unknown: 26 };
    const rows = [];
    events.forEach((event, index) => {
      const player = event.player === 'own' || event.player === 'opponent' ? event.player : 'unknown';
      const spentThisStep = (event.type === 'place' || event.type === 'air_strike') ? clampCount(event.count || 1, 0, 2) : 0;
      if (spentThisStep) {
        usedByPlayer[player] += spentThisStep;
        leftByPlayer[player] = Math.max(0, leftByPlayer[player] - spentThisStep);
      }
      rows.push({
        step: index + 1,
        player,
        type: event.type,
        card: event.card || '',
        spentThisStep,
        cumulativeUsed: usedByPlayer[player],
        totalLeft: leftByPlayer[player],
        line: event.line,
      });
    });
    return {
      rows,
      totals: {
        own: { used: usedByPlayer.own, left: leftByPlayer.own },
        opponent: { used: usedByPlayer.opponent, left: leftByPlayer.opponent },
        unknown: { used: usedByPlayer.unknown, left: leftByPlayer.unknown },
      },
      warnings: rows.some((row) => row.player === 'unknown' && row.spentThisStep > 0) ? ['unknown-player spent-card events affect ledger confidence'] : [],
    };
  }

  function summarizeCounts({ own, opponent, unknown, events = [], sourceLines = [], counters = null, metricOverrides = null }) {
    const ownRemaining = remainingFor(own);
    const opponentRemaining = remainingFor(opponent);
    const replayLedger = buildReplayLedgerTrace(events);
    const parsedEventLines = new Set(events.map((event) => event.line));
    const comparableSourceLine = (line) => String(line || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\s+(?:(?:\d{2}\.\d{2}\.\d{4}\s+)?\d{1,2}:\d{2})$/, '');
    const unparsedLines = sourceLines.filter((line) => !parsedEventLines.has(comparableSourceLine(line)));
    const nonActionableLines = unparsedLines.filter(isIgnorableLogLine);
    const actionableUnparsedLines = unparsedLines.filter((line) => !isIgnorableLogLine(line));
    const actionableLines = events.length + actionableUnparsedLines.length;
    const actionableCoverage = actionableLines ? events.length / actionableLines : 1;
    return {
      deck: DECK,
      ownUsed: own,
      opponentUsed: opponent,
      unknownUsed: unknown,
      ownRemaining,
      opponentRemaining,
      events,
      replayLedger,
      counters,
      metrics: {
        logEventsRead: sourceLines.length,
        logEventsParsed: events.length,
        logEventsUnparsed: unparsedLines.length,
        unparsedSamples: actionableUnparsedLines.slice(0, 5),
        nonActionableLines: nonActionableLines.length,
        actionableLines,
        actionableParsed: events.length,
        actionableUnparsed: actionableUnparsedLines.length,
        actionableCoverage,
        ...(metricOverrides || {}),
      },
      hints: buildHints({ ownRemaining, opponentRemaining })
    };
  }

  function buildHints({ ownRemaining, opponentRemaining }) {
    const hints = [];
    if (opponentRemaining.artillery > 0 && opponentRemaining.special_forces > 0) {
      hints.push('High breakthrough risk: opponent still has Artillery + Special Forces. Secure side hill / avoid thin supply.');
    }
    if (opponentRemaining.tank === 0 && opponentRemaining.artillery === 0) {
      hints.push('Reduced heavy direct threat: opponent has no Tank and no Artillery remaining.');
    }
    if (opponentRemaining.heavy_weapons >= 3) {
      hints.push('Support/kill-zone risk: opponent still has many Heavy Weapons.');
    }
    if (ownRemaining.infantry <= 2) {
      hints.push('Own resilience risk: low Infantry remaining for board fill and supply.');
    }
    if (!hints.length) hints.push('No critical count-based warning yet. Keep tracking card flow.');
    return hints;
  }

  function clampCount(value, min = 0, max = Number.POSITIVE_INFINITY) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.trunc(number)));
  }

  function sumCounts(counts = {}) {
    return Object.values(counts).reduce((sum, value) => sum + clampCount(value), 0);
  }

  function combination(n, k) {
    n = clampCount(n);
    k = clampCount(k);
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    k = Math.min(k, n - k);
    let result = 1;
    for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
    return result;
  }

  function probabilityAtLeastOne(poolSize, wantedCount, handSize) {
    poolSize = clampCount(poolSize);
    wantedCount = clampCount(wantedCount, 0, poolSize);
    handSize = clampCount(handSize, 0, poolSize);
    if (!poolSize || !wantedCount || !handSize) return 0;
    if (wantedCount >= poolSize) return 1;
    const withoutWanted = combination(poolSize - wantedCount, handSize);
    const allHands = combination(poolSize, handSize);
    if (!allHands) return 0;
    return Math.round((1 - withoutWanted / allHands) * 1000) / 1000;
  }

  function normalizeCounters(counters = {}) {
    return {
      deck: clampCount(counters.deck),
      hand: clampCount(counters.hand),
      airStrike: clampCount(counters.airStrike ?? counters['air-strike']),
      unitsInPlay: clampCount(counters.unitsInPlay ?? counters['units-in-play']),
      unitsDestroyed: clampCount(counters.unitsDestroyed ?? counters['units-destroyed'])
    };
  }

  function publicUsageFromCounters(counters = {}) {
    const normalized = normalizeCounters(counters);
    const hasPoolCounters = ['deck', 'hand', 'airStrike'].some((key) => Object.prototype.hasOwnProperty.call(counters || {}, key))
      || ['deck', 'hand', 'air-strike'].some((key) => Object.prototype.hasOwnProperty.call(counters || {}, key));
    const hasUnitCounters = ['unitsInPlay', 'unitsDestroyed', 'units-in-play', 'units-destroyed']
      .some((key) => Object.prototype.hasOwnProperty.call(counters || {}, key));
    if (!hasPoolCounters && !hasUnitCounters) return null;

    const unitUsed = normalized.unitsInPlay + normalized.unitsDestroyed;
    const airUsed = hasPoolCounters ? Math.max(0, DECK.air_strike.total - normalized.airStrike) : 0;
    const usedByBoard = hasUnitCounters ? unitUsed + airUsed : null;
    const leftByPool = hasPoolCounters ? normalized.deck + normalized.hand + normalized.airStrike : null;
    const usedByPool = leftByPool == null ? null : Math.max(0, 26 - leftByPool);
    const used = usedByBoard ?? usedByPool ?? 0;
    return {
      counters: normalized,
      unitUsed,
      airUsed,
      used,
      left: Math.max(0, 26 - used),
      usedByBoard,
      usedByPool,
      leftByPool,
      source: usedByBoard == null ? 'deck-hand-air-public-pool' : 'units-board-destroyed-plus-air',
      warnings: usedByBoard != null && usedByPool != null && usedByBoard !== usedByPool
        ? [`public counter mismatch: board/destroyed says ${usedByBoard} used, deck/hand/air pool says ${usedByPool} used`]
        : [],
    };
  }

  function reconcileKnownUsedWithCounters(knownUsed = emptyCounts(), counters = {}, role = 'player') {
    const knownUsedTotal = sumCounts(knownUsed);
    const publicUsage = publicUsageFromCounters(counters);
    if (!publicUsage) return { role, knownUsedTotal, publicUsage: null, ok: true, warnings: [] };
    const warnings = [...publicUsage.warnings];
    if (knownUsedTotal !== publicUsage.used) {
      warnings.push(`${role} ledger mismatch: parsed ${knownUsedTotal} used, public counters imply ${publicUsage.used} used`);
    }
    return {
      role,
      knownUsedTotal,
      publicUsage,
      ok: warnings.length === 0,
      warnings,
    };
  }

  function estimateOpponentHandProbabilities({ opponentKnownUsed = emptyCounts(), opponentCounters = {} } = {}) {
    const counters = normalizeCounters(opponentCounters);
    const unitDeckTotal = Object.entries(DECK)
      .filter(([key]) => key !== 'air_strike')
      .reduce((sum, [, spec]) => sum + spec.total, 0);
    const knownUnitUsedTotal = Object.entries(opponentKnownUsed)
      .filter(([key]) => key !== 'air_strike')
      .reduce((sum, [, value]) => sum + clampCount(value), 0);
    const counterUnknownPool = counters.deck + counters.hand;
    const fallbackPool = unitDeckTotal - knownUnitUsedTotal;
    const unknownPoolSize = counterUnknownPool || Math.max(0, fallbackPool);
    const handSize = Math.min(counters.hand, unknownPoolSize);
    const rows = {};
    for (const [key, spec] of Object.entries(DECK)) {
      const opponentUsed = clampCount(opponentKnownUsed[key]);
      const publicAirStrikeCount = clampCount(counters.airStrike, 0, spec.total);
      const remainingUnseen = key === 'air_strike'
        ? publicAirStrikeCount
        : Math.max(0, spec.total - opponentUsed);
      rows[key] = {
        label: spec.label,
        total: spec.total,
        opponentUsed,
        remainingUnseen,
        probabilityAtLeastOne: key === 'air_strike'
          ? (publicAirStrikeCount > 0 ? 1 : 0)
          : probabilityAtLeastOne(unknownPoolSize, remainingUnseen, handSize),
        probabilitySource: key === 'air_strike' ? 'public-air-strike-counter' : 'unit-deck-hand-hypergeometric',
      };
    }
    return { unknownPoolSize, handSize, counters, rows };
  }

  function inferPlayerMapping({ url = '', counters = {}, visibleHandCount = 0, visibleUnitHandCount = null, visibleAirStrikeCount = null, viewerName = '' } = {}) {
    const entries = Object.entries(counters || {});
    if (!entries.length) return { ownPlayerId: '', opponentPlayerId: '', ownCounters: {}, opponentCounters: {}, confidence: 0, confidenceLabel: 'no counters', reason: 'No public counter nodes detected.', signals: [], blockers: ['no public counters'] };

    const candidateSignals = new Map(entries.map(([playerId]) => [playerId, []]));
    const blockers = [];
    const addSignal = (playerId, signal) => {
      if (!playerId || !candidateSignals.has(playerId)) return;
      candidateSignals.get(playerId).push(signal);
    };
    const playerParam = String(url || '').match(/[?&]player=(\d+)/)?.[1] || '';
    if (playerParam) {
      if (candidateSignals.has(playerParam)) addSignal(playerParam, { source: 'url-player-id', weight: 45, detail: `player=${playerParam}` });
      else blockers.push('url player parameter not in counters');
    }

    if (viewerName) {
      const normalizedViewer = normalize(viewerName);
      const viewerMatches = entries.filter(([, values]) => normalize(values?.name) === normalizedViewer);
      if (viewerMatches.length === 1) addSignal(viewerMatches[0][0], { source: 'viewer-name', weight: 35, detail: viewerName });
      else if (viewerMatches.length > 1) blockers.push('viewer name matches multiple counter rows');
      else blockers.push('viewer name not in counters');
    }

    const visibleUnits = visibleUnitHandCount == null ? null : clampCount(visibleUnitHandCount);
    const visibleAir = visibleAirStrikeCount == null ? null : clampCount(visibleAirStrikeCount);
    const visibleTotal = clampCount(visibleHandCount);
    const strictHandMatches = entries.filter(([, values]) => {
      if (visibleUnits == null && visibleAir == null) return false;
      const unitOk = visibleUnits == null || clampCount(values.hand) === visibleUnits;
      const airOk = visibleAir == null || clampCount(values.airStrike ?? values['air-strike']) === visibleAir;
      return unitOk && airOk;
    });
    if (strictHandMatches.length === 1) addSignal(strictHandMatches[0][0], { source: 'visible-hand-dom-unit-air-counters', weight: 35, detail: `unit=${visibleUnits ?? '?'} air=${visibleAir ?? '?'}` });
    else if (strictHandMatches.length > 1) blockers.push('visible hand unit/air counters match multiple players');
    else if (visibleUnits != null || visibleAir != null) blockers.push('visible hand unit/air counters match no player');

    const totalHandMatches = visibleTotal ? entries.filter(([, values]) => clampCount(values.hand) + clampCount(values.airStrike ?? values['air-strike']) === visibleTotal) : [];
    if (totalHandMatches.length === 1) addSignal(totalHandMatches[0][0], { source: 'visible-hand-dom-total-counters', weight: 15, detail: `total=${visibleTotal}` });

    const scored = entries.map(([playerId, values]) => {
      const signals = candidateSignals.get(playerId) || [];
      const independentSources = new Set(signals.map((signal) => signal.source)).size;
      const score = signals.reduce((sum, signal) => sum + signal.weight, 0) + (entries.length === 2 ? 5 : 0);
      return { playerId, values, signals, independentSources, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUp = scored[1];
    const margin = best.score - (runnerUp?.score || 0);
    const hardMismatch = Boolean(runnerUp && margin <= 0);
    if (!best.signals.length) blockers.push('no independent own-player signal');
    if (best.independentSources < 2) blockers.push('player mapping needs at least two independent signals before GO');
    if (hardMismatch) blockers.push('conflicting player mapping signals');

    const confidence = Math.max(0, Math.min(100, best.score + (best.independentSources >= 2 ? 10 : 0) + Math.max(0, Math.min(10, margin))));
    const ownMatch = entries.find(([playerId]) => playerId === best.playerId) || entries[0];
    const opponentMatch = entries.find(([playerId]) => playerId !== ownMatch[0]) || entries[1] || ownMatch;
    return {
      ownPlayerId: blockers.length ? '' : ownMatch[0],
      opponentPlayerId: blockers.length ? '' : opponentMatch[0],
      ownCounters: blockers.length ? {} : (ownMatch[1] || {}),
      opponentCounters: blockers.length ? {} : (opponentMatch[1] || {}),
      confidence: blockers.length ? Math.min(confidence, 84) : confidence,
      confidenceLabel: !blockers.length && confidence >= 85 ? 'high' : (confidence >= 60 ? 'medium' : 'low'),
      reason: [...best.signals.map((signal) => signal.source), ...blockers].join('; '),
      signals: best.signals,
      blockers,
      candidates: scored.map(({ playerId, score, independentSources, signals }) => ({ playerId, score, independentSources, signals: signals.map((signal) => signal.source) })),
    };
  }

  function buildPlayerCardTable({
    ownKnownUsed = emptyCounts(),
    opponentKnownUsed = emptyCounts(),
    ownVisibleHand = emptyCounts(),
    ownCounters = {},
    opponentCounters = {},
  } = {}) {
    const ownCounter = normalizeCounters(ownCounters);
    const opponentCounter = normalizeCounters(opponentCounters);
    const opponentProbabilities = estimateOpponentHandProbabilities({ opponentKnownUsed, opponentCounters: opponentCounter });
    const rows = {};
    for (const [key, spec] of Object.entries(DECK)) {
      const ownUsed = clampCount(ownKnownUsed[key]);
      const opponentUsed = clampCount(opponentKnownUsed[key]);
      const ownVisible = clampCount(ownVisibleHand[key]);
      const ownLeftTotal = Math.max(0, spec.total - ownUsed);
      const opponentLeftTotal = Math.max(0, spec.total - opponentUsed);
      rows[key] = {
        label: spec.label,
        total: spec.total,
        ownUsed,
        ownVisibleHand: ownVisible,
        ownLeftTotal,
        ownUnknownLeft: Math.max(0, ownLeftTotal - ownVisible),
        opponentUsed,
        opponentLeftTotal,
        opponentHandProbability: opponentProbabilities.rows[key].probabilityAtLeastOne,
      };
    }
    return {
      rows,
      own: {
        counters: ownCounter,
        visibleHandTotal: sumCounts(ownVisibleHand),
        knownUsedTotal: sumCounts(ownKnownUsed),
        publicUnknownPool: ownCounter.deck + ownCounter.hand,
        reconciliation: reconcileKnownUsedWithCounters(ownKnownUsed, ownCounters, 'you'),
      },
      opponent: {
        counters: opponentCounter,
        knownUsedTotal: sumCounts(opponentKnownUsed),
        publicUnknownPool: opponentProbabilities.unknownPoolSize,
        handSize: opponentProbabilities.handSize,
        reconciliation: reconcileKnownUsedWithCounters(opponentKnownUsed, opponentCounters, 'opponent'),
      },
    };
  }

  const api = { DECK, emptyCounts, typeKeyToCard, detectCard, detectPlayer, parseLog, parseBgaLogLine, parseBgaLogLines, normalizeLogInput, canonicalLogKey, extractReplayOrder, normalizeReplayOrder, remainingFor, buildReplayLedgerTrace, buildHints, isIgnorableLogLine, probabilityAtLeastOne, publicUsageFromCounters, reconcileKnownUsedWithCounters, estimateOpponentHandProbabilities, inferPlayerMapping, buildPlayerCardTable };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Hill218CardModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
