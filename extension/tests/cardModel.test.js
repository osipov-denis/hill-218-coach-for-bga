const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/cardModel.js');
const corpus = require('../../scripts/bga_gamereview_corpus.js');

test('deck totals match Battle for Hill 218 baseline', () => {
  const total = Object.values(model.DECK).reduce((sum, card) => sum + card.total, 0);
  assert.equal(total, 26);
  assert.equal(model.DECK.infantry.total, 7);
  assert.equal(model.DECK.heavy_weapons.total, 5);
  assert.equal(model.DECK.air_strike.total, 2);
});

test('BGA DOM type keys map to card model keys', () => {
  assert.equal(model.typeKeyToCard('air-strike'), 'air_strike');
  assert.equal(model.typeKeyToCard('heavy-weapons'), 'heavy_weapons');
  assert.equal(model.typeKeyToCard('special-forces'), 'special_forces');
  assert.equal(model.typeKeyToCard('paratroopers'), 'paratroopers');
});

test('parseLog counts own and opponent cards', () => {
  const summary = model.parseLog(`
    You played Infantry
    You played Heavy Weapons
    Opponent played Artillery
    Opponent played Special Forces
    Opponent played Tank
  `);
  assert.equal(summary.ownUsed.infantry, 1);
  assert.equal(summary.ownRemaining.infantry, 6);
  assert.equal(summary.opponentUsed.artillery, 1);
  assert.equal(summary.opponentRemaining.artillery, 2);
  assert.equal(summary.opponentUsed.special_forces, 1);
});

test('risk hint triggers when opponent has artillery and special forces remaining', () => {
  const summary = model.parseLog('Opponent played Infantry');
  assert(summary.hints.some((hint) => hint.includes('Artillery + Special Forces')));
});

test('risk hint changes after opponent spends all tank and artillery', () => {
  const summary = model.parseLog(`
    Opponent played Tank
    Opponent played Tank
    Opponent played Tank
    Opponent played Artillery
    Opponent played Artillery
    Opponent played Artillery
  `);
  assert(summary.hints.some((hint) => hint.includes('no Tank and no Artillery')));
});

test('parseLog counts BGA-like played placed and destroyed spent-card events', () => {
  const summary = model.parseLog(`
    You played infantry
    Denis placed heavy-weapons
    Opponent placed artillery
    Enemy destroyed special-forces
    Opponent destroyed tank
    opponent played air-strike
  `);

  assert.equal(summary.ownUsed.infantry, 1);
  assert.equal(summary.ownUsed.heavy_weapons, 1);
  assert.equal(summary.opponentUsed.artillery, 1);
  assert.equal(summary.opponentUsed.special_forces, 1);
  assert.equal(summary.opponentUsed.tank, 1);
  assert.equal(summary.opponentUsed.air_strike, 1);
  assert.equal(summary.events.length, 6);
});

test('parseLog ignores diagnostics visible hand counters and report rows', () => {
  const summary = model.parseLog(`
    Card Total You used You left Opp used Opp left
    Infantry 7 0 7 0 7
    Visible Chrome/BGA DOM state
    Hand cards: 7; battlefield positions: 6; battlefield cards: 6; container: unknown.
    Your visible hand Count
    Special Forces 1
    Tank 1
    Artillery 1
    Paratroopers 2
    Air Strike 2
    Player ID Deck Hand Air strikes Units in play Units destroyed
    85113919 13 5 2 2 3
    86192613 14 4 1 3 4
    Parsed events: 97. Unknown-player card events: 97.
  `);

  assert.equal(summary.events.length, 0);
  assert.equal(Object.values(summary.ownUsed).reduce((sum, value) => sum + value, 0), 0);
  assert.equal(Object.values(summary.opponentUsed).reduce((sum, value) => sum + value, 0), 0);
  assert.equal(Object.values(summary.unknownUsed).reduce((sum, value) => sum + value, 0), 0);
});

test('estimateOpponentHandProbabilities uses public unit deck/hand counters and exact air-strike counter', () => {
  const result = model.estimateOpponentHandProbabilities({
    opponentKnownUsed: { ...model.emptyCounts(), artillery: 1, air_strike: 1 },
    opponentCounters: { deck: 10, hand: 6, airStrike: 1 },
  });

  assert.equal(result.unknownPoolSize, 16);
  assert.equal(result.handSize, 6);
  assert.equal(result.rows.artillery.remainingUnseen, 2);
  assert.equal(result.rows.air_strike.remainingUnseen, 1);
  assert.equal(result.rows.air_strike.probabilityAtLeastOne, 1);
  assert.equal(result.rows.air_strike.probabilitySource, 'public-air-strike-counter');
  assert.equal(result.rows.infantry.remainingUnseen, 7);
  assert.equal(result.rows.artillery.probabilityAtLeastOne, 0.625);
});

test('parseLog exposes data-quality event metrics', () => {
  const summary = model.parseLog(`
    You placed a Infantry card at 0,0
    System line without card data
    Opponent played an Air Strike card destroying the Tank card at 1,0
  `);

  assert.equal(summary.metrics.logEventsRead, 3);
  assert.equal(summary.metrics.logEventsParsed, 2);
  assert.equal(summary.metrics.logEventsUnparsed, 1);
  assert.equal(summary.metrics.actionableCoverage, 2 / 3);
  assert.deepEqual(summary.metrics.unparsedSamples, ['System line without card data']);
});

test('buildPlayerCardTable combines used cards, visible hand and counters', () => {
  const table = model.buildPlayerCardTable({
    ownKnownUsed: { ...model.emptyCounts(), infantry: 1 },
    opponentKnownUsed: { ...model.emptyCounts(), artillery: 1 },
    ownVisibleHand: { ...model.emptyCounts(), tank: 1, air_strike: 2 },
    ownCounters: { deck: 11, hand: 3 },
    opponentCounters: { deck: 10, hand: 6 },
  });

  assert.equal(table.rows.infantry.ownUsed, 1);
  assert.equal(table.rows.infantry.ownLeftTotal, 6);
  assert.equal(table.rows.tank.ownVisibleHand, 1);
  assert.equal(table.rows.air_strike.ownVisibleHand, 2);
  assert.equal(table.own.publicUnknownPool, 14);
  assert.equal(table.opponent.publicUnknownPool, 16);
  assert.equal(table.rows.artillery.opponentUsed, 1);
  assert.equal(table.rows.artillery.opponentHandProbability, 0.625);
});

test('parseBgaLogLines normalizes real BGA placed air-strike draw return and attack lines', () => {
  const summary = model.parseBgaLogLines([
    { id: 'log-1', text: 'iozik killer placed a Tank card at 1,0' },
    { id: 'log-2', text: 'malatesto played an Air Strike card destroying the Heavy Weapons card at 1,0' },
    { id: 'log-3', text: 'iozik killer has drawn 2 cards' },
    { id: 'log-4', text: 'iozik killer returned 2 cards to their deck' },
    { id: 'log-5', text: 'iozik killer attacked the Artillery at 1,1 with the Tank at 1,0' },
  ], { ownNames: ['iozik killer'], opponentNames: ['malatesto'] });

  assert.deepEqual(summary.events.map((event) => event.type), ['place', 'air_strike', 'draw', 'return', 'attack']);
  assert.deepEqual(summary.events[0], {
    id: 'log-1',
    type: 'place',
    actor: 'iozik killer',
    player: 'own',
    card: 'tank',
    location: { x: 1, y: 0 },
    count: 1,
    line: 'iozik killer placed a Tank card at 1,0',
  });
  assert.deepEqual(summary.events[1], {
    id: 'log-2',
    type: 'air_strike',
    actor: 'malatesto',
    player: 'opponent',
    card: 'air_strike',
    targetCard: 'heavy_weapons',
    targetLocation: { x: 1, y: 0 },
    count: 1,
    line: 'malatesto played an Air Strike card destroying the Heavy Weapons card at 1,0',
  });
  assert.equal(summary.events[2].count, 2);
  assert.equal(summary.events[3].count, 2);
  assert.equal(summary.events[4].targetCard, 'artillery');
  assert.equal(summary.events[4].attackerCard, 'tank');
  assert.deepEqual(summary.events[4].targetLocation, { x: 1, y: 1 });
  assert.deepEqual(summary.events[4].attackerLocation, { x: 1, y: 0 });
});

test('parseBgaLogLines derives numeric counters without counting destroyed target or attack cards as spent', () => {
  const summary = model.parseBgaLogLines(`
    iozik killer placed a Tank card at 1,0
    malatesto played an Air Strike card destroying the Heavy Weapons card at 1,0
    iozik killer has drawn 2 cards
    iozik killer returned 2 cards to their deck
    iozik killer attacked the Artillery at 1,1 with the Tank at 1,0
  `, { ownNames: ['iozik killer'], opponentNames: ['malatesto'] });

  assert.equal(summary.ownUsed.tank, 1);
  assert.equal(summary.ownUsed.artillery, 0);
  assert.equal(summary.opponentUsed.air_strike, 1);
  assert.equal(summary.opponentUsed.heavy_weapons, 0);
  assert.deepEqual(summary.counters.own, { drawn: 2, returned: 2, attacks: 1 });
  assert.deepEqual(summary.counters.opponent, { drawn: 0, returned: 0, attacks: 0 });
  assert.equal(summary.metrics.totalLines, 5);
  assert.equal(summary.metrics.parsedEvents, 5);
  assert.equal(summary.metrics.unparsedLines, 0);
});

test('live BGA table counters make Air Strike deterministic, not 60 percent random', () => {
  const table = model.buildPlayerCardTable({
    opponentKnownUsed: { ...model.emptyCounts(), air_strike: 1 },
    opponentCounters: { airStrike: 1, hand: 6, deck: 4, unitsInPlay: 3, unitsDestroyed: 11 },
  });

  assert.equal(table.opponent.publicUnknownPool, 10);
  assert.equal(table.opponent.handSize, 6);
  assert.equal(table.rows.air_strike.opponentLeftTotal, 1);
  assert.equal(table.rows.air_strike.opponentHandProbability, 1);
});

test('public counter reconciliation catches a missed placed Infantry event', () => {
  const table = model.buildPlayerCardTable({
    ownKnownUsed: { ...model.emptyCounts(), heavy_weapons: 1, artillery: 1 },
    ownCounters: { deck: 19, hand: 2, airStrike: 2, unitsInPlay: 3, unitsDestroyed: 0 },
  });

  assert.equal(table.own.reconciliation.ok, false);
  assert.equal(table.own.reconciliation.knownUsedTotal, 2);
  assert.equal(table.own.reconciliation.publicUsage.used, 3);
  assert.match(table.own.reconciliation.warnings.join('\n'), /parsed 2 used, public counters imply 3 used/);
});

test('public counter reconciliation accepts matching unit and air-strike usage', () => {
  const table = model.buildPlayerCardTable({
    ownKnownUsed: { ...model.emptyCounts(), infantry: 2, air_strike: 1 },
    ownCounters: { deck: 17, hand: 5, airStrike: 1, unitsInPlay: 2, unitsDestroyed: 0 },
  });

  assert.equal(table.own.reconciliation.ok, true);
  assert.equal(table.own.reconciliation.publicUsage.used, 3);
  assert.equal(table.own.reconciliation.publicUsage.left, 23);
});

test('probability examples match M5 used-left math', () => {
  const allAirStrikesUsed = model.estimateOpponentHandProbabilities({
    opponentKnownUsed: { ...model.emptyCounts(), air_strike: model.DECK.air_strike.total },
    opponentCounters: { deck: 10, hand: 5 },
  });

  assert.equal(allAirStrikesUsed.rows.air_strike.probabilityAtLeastOne, 0);
  assert.equal(model.probabilityAtLeastOne(15, 1, 5), 0.333);
  assert.equal(model.probabilityAtLeastOne(15, 2, 5), 0.571);
});

test('parseBgaLogLines tolerates BGA trailing timestamps and separates non-actionable rows', () => {
  const summary = model.parseBgaLogLines([
    'Replay last moves',
    'iozik killer placed a Artillery card at -1,0 15:07',
    'malatesto returned 2 cards to their deck 01.05.2026 15:34',
    'Did you know? If the game seems stopped or buggy, please refresh the webpage or press F5.',
  ], { ownNames: ['iozik killer'], opponentNames: ['malatesto'] });

  assert.equal(summary.events.length, 2);
  assert.equal(summary.ownUsed.artillery, 1);
  assert.equal(summary.counters.opponent.returned, 2);
  assert.equal(summary.metrics.logEventsRead, 4);
  assert.equal(summary.metrics.logEventsParsed, 2);
  assert.equal(summary.metrics.nonActionableLines, 1);
  assert.equal(summary.metrics.actionableUnparsed, 1);
  assert.deepEqual(summary.metrics.unparsedSamples, ['Did you know? If the game seems stopped or buggy, please refresh the webpage or press F5.']);
});

test('replay ledger trace exposes cumulative used-left drift control for multi-card turns', () => {
  const summary = model.parseBgaLogLines([
    'Denis placed a Infantry card at 0,0',
    'Denis placed a Heavy Weapons card at 1,0',
    'Opponent placed a Tank card at 0,1',
    'Opponent played an Air Strike card destroying the Infantry card at 0,0',
    'Opponent attacked the Heavy Weapons at 1,0 with the Tank at 0,1',
  ], { ownNames: ['Denis'], opponentNames: ['Opponent'] });

  const spentRows = summary.replayLedger.rows.filter((row) => row.spentThisStep > 0);
  assert.deepEqual(spentRows.map((row) => [row.step, row.player, row.card, row.spentThisStep, row.cumulativeUsed, row.totalLeft]), [
    [1, 'own', 'infantry', 1, 1, 25],
    [2, 'own', 'heavy_weapons', 1, 2, 24],
    [3, 'opponent', 'tank', 1, 1, 25],
    [4, 'opponent', 'air_strike', 1, 2, 24],
  ]);
  assert.equal(summary.replayLedger.totals.own.used, 2);
  assert.equal(summary.replayLedger.totals.own.left, 24);
  assert.equal(summary.replayLedger.totals.opponent.used, 2);
  assert.equal(summary.replayLedger.totals.opponent.left, 24);
});

test('replay ledger normalizes BGA move rows to chronological spend order', () => {
  const summary = model.parseBgaLogLines([
    { id: 'move-20', text: 'Opponent played an Air Strike card destroying the Infantry card at 0,0' },
    { id: 'move-18', text: 'Denis placed a Infantry card at 0,0' },
  ], { ownNames: ['Denis'], opponentNames: ['Opponent'] });

  const spentRows = summary.replayLedger.rows.filter((row) => row.spentThisStep > 0);
  assert.deepEqual(spentRows.map((row) => [row.step, row.player, row.card, row.cumulativeUsed, row.totalLeft]), [
    [1, 'own', 'infantry', 1, 25],
    [2, 'opponent', 'air_strike', 1, 25],
  ]);
  assert.equal(summary.replayLedger.totals.own.used, 1);
  assert.equal(summary.replayLedger.totals.own.left, 25);
  assert.equal(summary.replayLedger.totals.opponent.used, 1);
  assert.equal(summary.replayLedger.totals.opponent.left, 25);
});

test('parseBgaLogLines counts repeated same-card same-coordinate placements when moves differ', () => {
  const summary = model.parseBgaLogLines([
    { id: 'review-move-7', text: 'vmorelle placed a Infantry card at 1,1' },
    { id: 'review-move-13', text: 'vmorelle placed a Infantry card at 1,1' },
    { id: 'review-move-33', text: 'vmorelle placed a Infantry card at 1,1' },
  ], { opponentNames: ['vmorelle'] });

  assert.equal(summary.opponentUsed.infantry, 3);
  assert.equal(summary.replayLedger.totals.opponent.used, 3);
  assert.equal(summary.metrics.duplicateLines, 0);
});

test('gamereview corpus analysis extracts players actions and repeated placements', () => {
  const reviewText = `
    Replay The Battle for Hill 218 #845846846
    Choose your point of view:
    1st
    iozik killer
    (0 )
    Choose this player
    2nd
    vmorelle
    (0 )
    Choose this player
    Game log
    Move 1 :
    04.05.2026 02:53:22
    vmorelle returned 2 cards to their deck
    Move 2 :
    iozik killer placed a Infantry card at 1,1
    Move 3 :
    iozik killer attacked the Infantry at 1,1 with the Infantry at 1,1
    Move 4 :
    iozik killer placed a Infantry card at 1,1
    Move 5 :
    vmorelle played an Air Strike card destroying the Infantry card at 1,1
    End of game
  `;

  const result = corpus.analyzeReviewText({ tableId: '845846846', text: reviewText });

  assert.deepEqual(result.players, ['iozik killer', 'vmorelle']);
  assert.equal(result.eventRows, 5);
  assert.equal(result.parsedEvents, 5);
  assert.equal(result.perCard.own.infantry, 2);
  assert.equal(result.perCard.opponent.air_strike, 1);
  assert.equal(result.repeatedPlacements.length, 1);
  assert.equal(result.repeatedPlacements[0].count, 2);
  assert.equal(result.ok, true);
});

test('gamereview corpus args support seed files limits and soft blocked batches', () => {
  const args = corpus.parseArgs([
    '--tables-file', '/tmp/soul-tables.txt',
    '--limit', '2',
    '--allow-blocked',
    '--delay-ms', '15000',
    '--stop-on-rate-limit',
    '--fixture-dir', 'Evidence/Corpus-Runs/fixtures',
    '--cache-dir', 'Evidence/Corpus-Runs/fixtures/cache',
    '--fixture-manifest',
    '--fixture-intake',
    '--promote-dir', 'Evidence/Corpus-Runs/fixtures',
    'https://boardgamearena.com/gamereview?table=845846846',
  ]);

  assert.deepEqual(args.tables, ['https://boardgamearena.com/gamereview?table=845846846']);
  assert.equal(args.file, '/tmp/soul-tables.txt');
  assert.equal(args.limit, 2);
  assert.equal(args.fixtureDir, 'Evidence/Corpus-Runs/fixtures');
  assert.equal(args.cacheDir, 'Evidence/Corpus-Runs/fixtures/cache');
  assert.equal(args.fixtureManifest, true);
  assert.equal(args.fixtureIntake, true);
  assert.equal(args.promoteDir, 'Evidence/Corpus-Runs/fixtures');
  assert.equal(args.allowBlocked, true);
  assert.equal(args.delayMs, 15000);
  assert.equal(args.stopOnRateLimit, true);
  assert.equal(corpus.tableIdFrom('https://boardgamearena.com/archive/replay/260423-1459/?table=842586712&player=84656591'), '842586712');
});

test('gamereview fixtures derive table ids from saved review text', () => {
  const text = `
    Replay The Battle for Hill 218 #845846846
    Choose your point of view:
    Game log
  `;

  assert.equal(corpus.tableIdFromReviewText(text), '845846846');
  assert.equal(corpus.fixtureSafeName('Replay #845846846 / iozik'), 'Replay-845846846-iozik');
});

test('gamereview corpus can load offline fixture directories with limits', () => {
  const fixtures = corpus.loadFixturePaths({
    fixtureDir: 'Evidence/Corpus-Runs/fixtures',
    limit: 1,
  });

  assert.equal(fixtures.length, 1);
  assert.match(fixtures[0], /\.txt$/);
});

test('gamereview classifier can classify offline fixture text', () => {
  const text = `
    # Replay The Battle for Hill 218 #845846846
    Choose your point of view:
    1st
    iozik killer
    Choose this player
    2nd
    vmorelle
    Choose this player
    Game log
    Move 1 :
    iozik killer placed a Infantry card at 1,1
    Move 9 :
    iozik killer placed a Infantry card at 2,1
  `;

  const result = corpus.classifyFixtureText({
    fixturePath: 'Evidence/Corpus-Runs/fixtures/cache-test/845846846.txt',
    text,
  });

  assert.equal(result.tableId, '845846846');
  assert.equal(result.classification, 'readable-gamereview');
  assert.deepEqual(result.players, ['iozik killer', 'vmorelle']);
  assert.equal(result.actionRows, 2);
});

test('gamereview fixture manifest records hashes and duplicates', () => {
  const text = `
    # Replay The Battle for Hill 218 #845846846
    Choose your point of view:
    1st
    iozik killer
    Choose this player
    2nd
    vmorelle
    Choose this player
    Game log
    Move 1 :
    iozik killer placed a Infantry card at 1,1
  `;

  const manifest = corpus.buildFixtureManifestRecords([
    { fixturePath: 'Evidence/Corpus-Runs/fixtures/a/845846846.txt', text },
    { fixturePath: 'Evidence/Corpus-Runs/fixtures/b/845846846-copy.txt', text },
  ]);

  assert.equal(manifest.aggregate.fixtures, 2);
  assert.equal(manifest.aggregate.uniqueHashes, 1);
  assert.equal(manifest.aggregate.duplicateFiles, 1);
  assert.equal(manifest.aggregate.readable, 2);
  assert.equal(manifest.aggregate.parseOk, 2);
  assert.equal(manifest.aggregate.byClassification['readable-gamereview'], 2);
  assert.equal(manifest.results[0].duplicateOf, '');
  assert.equal(manifest.results[1].duplicateOf, 'Evidence/Corpus-Runs/fixtures/a/845846846.txt');
  assert.match(manifest.results[0].sha256, /^[a-f0-9]{64}$/);
});

test('gamereview fixture intake plan blocks duplicates and promotes clean new tables', () => {
  const existingText = `
    # Replay The Battle for Hill 218 #845846846
    Choose your point of view:
    1st
    iozik killer
    Choose this player
    2nd
    vmorelle
    Choose this player
    Game log
    Move 1 :
    iozik killer placed a Infantry card at 1,1
  `;
  const newText = `
    # Replay The Battle for Hill 218 #900000002
    Choose your point of view:
    1st
    iozik killer
    Choose this player
    2nd
    vmorelle
    Choose this player
    Game log
    Move 1 :
    vmorelle placed a Tank card at 0,1
  `;

  const plan = corpus.buildFixtureIntakePlan({
    existingItems: [{ fixturePath: 'Evidence/Corpus-Runs/fixtures/845846846.txt', text: existingText }],
    intakeItems: [
      { fixturePath: 'Evidence/Corpus-Runs/fixture-intake/duplicate.txt', text: existingText },
      { fixturePath: 'Evidence/Corpus-Runs/fixture-intake/900000002.txt', text: newText },
    ],
    promoteDir: 'Evidence/Corpus-Runs/fixtures',
  });

  assert.equal(plan.aggregate.intakeFixtures, 2);
  assert.equal(plan.aggregate.existingFixtures, 1);
  assert.equal(plan.aggregate.promotable, 1);
  assert.equal(plan.aggregate.duplicateHash, 1);
  assert.equal(plan.results[0].intakeStatus, 'SKIP_DUPLICATE_HASH');
  assert.equal(plan.results[1].intakeStatus, 'PROMOTE');
  assert.equal(plan.results[1].promoteTarget, 'Evidence/Corpus-Runs/fixtures/900000002.txt');
});

test('gamereview fixture intake blocked rows do not make the CLI fail', () => {
  const aggregate = { blocked: 1 };

  assert.equal(corpus.shouldFailForBlockedAggregate({ fixtureIntake: true }, aggregate), false);
  assert.equal(corpus.shouldFailForBlockedAggregate({ classifyBlocked: true }, aggregate), false);
  assert.equal(corpus.shouldFailForBlockedAggregate({ fixtureManifest: true }, aggregate), false);
  assert.equal(corpus.shouldFailForBlockedAggregate({ allowBlocked: true }, aggregate), false);
  assert.equal(corpus.shouldFailForBlockedAggregate({}, aggregate), true);
});

test('gamestats source extracts only Hill 218 table links from mixed BGA links', () => {
  const ids = corpus.extractHill218CandidateIdsFromLinks([
    { text: 'The Battle for Hill 218', href: 'https://boardgamearena.com/table?table=847787805' },
    { text: '#847787805', href: 'https://boardgamearena.com/table?table=847787805' },
    { text: 'Replay Love Letter', href: 'https://boardgamearena.com/table?table=845772646' },
    { text: 'The Battle for Hill 218', href: 'https://boardgamearena.com/table?table=845846846' },
    { text: '/gamepanel?game=cantstop&table=848697080', href: 'https://boardgamearena.com/13/cantstop?table=848697080' },
  ]);

  assert.deepEqual(ids, ['847787805', '845846846']);
});

test('gamereview corpus blocked table result preserves navigation failure as evidence row', () => {
  const result = corpus.blockedTableResult({
    tableId: '123456789',
    url: 'https://boardgamearena.com/gamereview?table=123456789',
    error: 'CDP timeout after 20000ms: Page.navigate',
  });

  assert.equal(result.ok, false);
  assert.equal(result.tableId, '123456789');
  assert.equal(result.totals.own.left, 26);
  assert.deepEqual(result.blockers, ['CDP timeout after 20000ms: Page.navigate']);
});

test('gamereview blocker classifier separates empty review shell from parser failure', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '845772646',
    title: 'Replay The Battle for Hill 218 #845772646 • Board Game Arena',
    text: `
      Replay The Battle for Hill 218 #845772646
      Choose your point of view:
      1st
      vicelike teapot
      Choose this player
      2nd
      inhocsignovinces
      Choose this player
    `,
  });

  assert.equal(result.classification, 'review-shell-without-game-log');
  assert.deepEqual(result.players, ['vicelike teapot', 'inhocsignovinces']);
  assert.equal(result.actionRows, 0);
  assert.equal(result.markers.hasReplay, true);
  assert.equal(result.markers.hasGameLog, false);
});

test('gamereview blocker classifier detects readable action rows', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '845846846',
    title: 'Replay The Battle for Hill 218 #845846846 • Board Game Arena',
    text: `
      Replay The Battle for Hill 218 #845846846
      Choose your point of view:
      1st
      iozik killer
      Choose this player
      2nd
      vmorelle
      Choose this player
      Game log
      Move 1 :
      iozik killer placed a Infantry card at 1,1
      End of game
    `,
  });

  assert.equal(result.classification, 'readable-gamereview');
  assert.equal(result.actionRows, 1);
});

test('gamereview blocker classifier rejects wrong-game and never-started pages', () => {
  const wrongGame = corpus.classifyGamereviewPage({
    tableId: '845772646',
    title: 'Replay Love Letter #845772646 • Board Game Arena',
    text: 'Replay Love Letter #845772646 Choose your point of view: Game log End of game',
  });
  const neverStarted = corpus.classifyGamereviewPage({
    tableId: '845773839',
    text: 'Sorry, an unexpected error has occurred... This game never started and cannot be replayed',
  });

  assert.equal(wrongGame.classification, 'wrong-game');
  assert.equal(wrongGame.markers.hasOtherReplayGame, true);
  assert.equal(neverStarted.classification, 'never-started');
  assert.equal(neverStarted.markers.hasNeverStarted, true);
});

test('gamereview blocker classifier separates archive-not-ready from parser failure', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '847787805',
    title: 'Replay The Battle for Hill 218 #847787805 • Board Game Arena',
    text: `
      Replay The Battle for Hill 218 #847787805
      Searching for the game archive
      Please wait a few centuri... seconds.
    `,
  });

  assert.equal(result.classification, 'archive-not-ready');
  assert.equal(result.markers.hasArchiveNotReady, true);
  assert.equal(result.actionRows, 0);
});

test('gamereview blocker classifier keeps CDP timeouts out of generic redirects', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '843705630',
    title: 'navigation/read error',
    text: 'CDP timeout after 20000ms: Page.navigate',
    navigationError: 'CDP timeout after 20000ms: Page.navigate',
  });

  assert.equal(result.classification, 'navigation-read-error');
  assert.equal(result.markers.hasNavigationReadError, true);
  assert.match(result.evidence.join('\n'), /CDP timeout/);
});

test('gamereview blocker classifier detects BGA replay rate limits', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '845846846',
    title: '',
    text: 'Sorry, an unexpected error has occurred... You have reached a limit (replay)',
  });

  assert.equal(result.classification, 'replay-rate-limited');
  assert.equal(result.markers.hasReplayRateLimit, true);
  assert.equal(corpus.hasReplayRateLimitResult(result), true);
  assert.equal(corpus.hasReplayRateLimitResult({
    blockers: ['BGA replay rate limit reached', 'no gamereview action rows found'],
  }), true);
});

test('gamereview page markers expose game-log without action rows for slow-loading reviews', () => {
  const result = corpus.classifyGamereviewPage({
    tableId: '844615431',
    title: 'Replay The Battle for Hill 218 #844615431 • Board Game Arena',
    text: `
      Replay The Battle for Hill 218 #844615431
      Choose your point of view:
      1st
      iozik killer
      Choose this player
      2nd
      Jonhinch
      Choose this player
      Game log
    `,
  });

  assert.equal(result.classification, 'game-log-without-action-rows');
  assert.equal(result.markers.hasGameLog, true);
  assert.equal(result.actionRows, 0);
});

test('inferPlayerMapping uses replay player parameter plus viewer and visible unit/air hand signals', () => {
  const mapping = model.inferPlayerMapping({
    url: 'https://boardgamearena.com/archive/replay/260423-1459/?table=841126720&player=85113919&comments=85113919;',
    visibleHandCount: 7,
    visibleUnitHandCount: 5,
    visibleAirStrikeCount: 2,
    counters: {
      85113919: { name: 'iozik killer', deck: 19, hand: 5, airStrike: 2 },
      98832018: { name: 'FabulouslyEvilBrian', deck: 19, hand: 7, airStrike: 0 },
    },
    viewerName: 'iozik killer',
  });

  assert.equal(mapping.ownPlayerId, '85113919');
  assert.equal(mapping.opponentPlayerId, '98832018');
  assert.equal(mapping.confidenceLabel, 'high');
  assert(mapping.confidence >= 85);
  assert.equal(mapping.blockers.length, 0);
  assert.match(mapping.reason, /url-player-id/);
  assert.match(mapping.reason, /viewer-name/);
  assert.match(mapping.reason, /visible-hand-dom-unit-air-counters/);
});

test('inferPlayerMapping blocks GO on visible-hand-only fallback without independent confirmation', () => {
  const mapping = model.inferPlayerMapping({
    url: 'https://boardgamearena.com/1/battleforhill?table=844763757',
    visibleHandCount: 6,
    visibleUnitHandCount: 6,
    visibleAirStrikeCount: 0,
    counters: {
      111: { name: 'Own Name', deck: 17, hand: 6, airStrike: 0 },
      222: { name: 'Other Name', deck: 18, hand: 5, airStrike: 1 },
    },
  });

  assert.equal(mapping.ownPlayerId, '');
  assert.equal(mapping.opponentPlayerId, '');
  assert(mapping.confidence < 85);
  assert.match(mapping.reason, /player mapping needs at least two independent signals/);
});

test('inferPlayerMapping avoids own/opponent swap when total hand count matches opponent but unit-air hand matches own', () => {
  const mapping = model.inferPlayerMapping({
    url: 'https://boardgamearena.com/archive/replay/260423-1459/?table=841126720&player=111',
    viewerName: 'Denis',
    visibleHandCount: 7,
    visibleUnitHandCount: 5,
    visibleAirStrikeCount: 2,
    counters: {
      111: { name: 'Denis', deck: 14, hand: 5, airStrike: 2 },
      222: { name: 'Opponent', deck: 11, hand: 7, airStrike: 0 },
    },
  });

  assert.equal(mapping.ownPlayerId, '111');
  assert.equal(mapping.opponentPlayerId, '222');
  assert.equal(mapping.blockers.length, 0);
  assert.deepEqual(mapping.candidates[0].signals, ['url-player-id', 'viewer-name', 'visible-hand-dom-unit-air-counters']);
});
