(function () {
  const WIDGET_VERSION = '2026-05-10-visible-hand-reconcile-v1';
  const existingPanel = document.querySelector('#hill218-coach-panel');
  if (existingPanel && existingPanel.dataset.version !== WIDGET_VERSION) {
    existingPanel.remove();
    window.__hill218CoachInjected = false;
  }
  if (window.__hill218CoachInjected) return;
  window.__hill218CoachInjected = true;

  const model = window.Hill218CardModel;
  if (!model) return;

  const BGA_SELECTORS = [
    '#logs', '#game_log', '#gamelog', '#pagesection_logs', '.log', '.gamelog', '.roundedbox',
    '#game-container', '#battlefield-panel', '.battlefield-position', '.battlefield-card',
    '.card', '.hand-card[data-id][data-type][data-color]', '.deck-count', '.hand-count',
    '.air-strike-count', '.units-in-play', '.units-destroyed'
  ];

  const panel = document.createElement('section');
  panel.id = 'hill218-coach-panel';
  panel.dataset.version = WIDGET_VERSION;
  panel.innerHTML = `
    <header id="hill218-coach-header">
      <strong>Hill 218 Coach</strong>
      <span class="hill218-subtitle">read-only Chrome/Arc card counter</span>
      <button id="hill218-minimize" title="Minimize">–</button>
    </header>
    <div id="hill218-body">
      <p class="hill218-note">Read-only auto-scan: watches visible replay/page changes. No moves, hidden APIs, or network calls.</p>
      <div id="hill218-scan-status" class="hill218-status-line">Auto-scan starting…</div>
      <details class="hill218-log-details">
        <summary>Captured visible log text</summary>
        <textarea id="hill218-log-input" placeholder="Captured visible log appears here after Scan page."></textarea>
      </details>
      <div class="hill218-actions hill218-user-actions">
        <button id="hill218-scan">Scan page</button>
        <button id="hill218-copy-status" class="hill218-secondary">Copy status</button>
        <button id="hill218-clear" class="hill218-secondary">Clear</button>
      </div>
      <details class="hill218-dev-tools">
        <summary>Developer tools</summary>
        <div class="hill218-actions">
          <button id="hill218-parse" class="hill218-secondary">Parse text</button>
          <button id="hill218-sample" class="hill218-secondary">Sample</button>
          <button id="hill218-copy-diag" class="hill218-secondary">Copy diagnostics</button>
        </div>
      </details>
      <div id="hill218-output"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  const header = panel.querySelector('#hill218-coach-header');
  const body = panel.querySelector('#hill218-body');
  const output = panel.querySelector('#hill218-output');
  const input = panel.querySelector('#hill218-log-input');
  const scanStatus = panel.querySelector('#hill218-scan-status');
  const detailsStateStorageKey = `hill218CoachDetailsState:${location.origin}${location.pathname}${location.search}`;
  let detailsOpenState = loadDetailsOpenState();

  function loadDetailsOpenState() {
    try {
      return JSON.parse(sessionStorage.getItem(detailsStateStorageKey) || '{}');
    } catch (_error) {
      return {};
    }
  }

  function saveDetailsOpenState() {
    try {
      sessionStorage.setItem(detailsStateStorageKey, JSON.stringify(detailsOpenState));
    } catch (_error) {
      // Ignore blocked storage; in-memory state still preserves open details during this injection.
    }
  }

  function detailsStateId(details) {
    const classKey = Array.from(details.classList || []).find((className) => className.startsWith('hill218-'));
    const summaryText = (details.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return classKey || summaryText || '';
  }

  function captureDetailsOpenState(scope = panel) {
    for (const details of Array.from(scope.querySelectorAll('details'))) {
      const stateId = detailsStateId(details);
      if (stateId) detailsOpenState[stateId] = details.open;
    }
    saveDetailsOpenState();
  }

  function applyDetailsOpenState(scope = panel) {
    for (const details of Array.from(scope.querySelectorAll('details'))) {
      const stateId = detailsStateId(details);
      if (stateId && Object.prototype.hasOwnProperty.call(detailsOpenState, stateId)) {
        details.open = !!detailsOpenState[stateId];
      }
    }
  }

  panel.addEventListener('toggle', (event) => {
    if (event.target?.tagName !== 'DETAILS') return;
    const stateId = detailsStateId(event.target);
    if (!stateId) return;
    detailsOpenState[stateId] = event.target.open;
    saveDetailsOpenState();
  }, true);

  applyDetailsOpenState(panel);

  function pageDiagnostics() {
    const selectors = BGA_SELECTORS.map((selector) => {
      const allNodes = Array.from(document.querySelectorAll(selector));
      const nodes = allNodes.filter(isNodeVisible).slice(0, 20);
      return {
        selector,
        count: nodes.length,
        totalMatches: allNodes.length,
        samples: nodes.map((node) => ({
          tag: node.tagName,
          id: node.id || '',
          className: String(node.className || '').slice(0, 160),
          dataset: { ...node.dataset },
          text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
        }))
      };
    });
    return {
      url: location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      visibleState: collectBgaVisibleState(),
      selectors
    };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function isNodeVisible(node) {
    return !!(node && (node.offsetWidth || node.offsetHeight || node.getClientRects().length));
  }

  function extractReviewPlayersFromText(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const players = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^(?:1st|2nd|3rd|4th)$/.test(lines[index])) continue;
      const name = lines[index + 1] || '';
      if (name && !/^\(|choose this player$/i.test(name)) players.push(name);
      if (players.length >= 2) break;
    }
    return players;
  }

  function isReviewActionLine(line) {
    return /\b(?:placed|played\s+an?\s+Air Strike|has drawn|returned\s+\d+\s+cards?|attacked\s+the)\b/i.test(line);
  }

  function collectReviewLogEvents() {
    if (!/gamereview/i.test(location.href) && !/^Replay The Battle for Hill 218/i.test(document.title || '')) return [];
    const text = document.body?.innerText || document.body?.textContent || '';
    const start = text.search(/\bGame log\b/i);
    if (start < 0) return [];
    const tail = text.slice(start);
    const end = tail.search(/\b(?:End of game|Thinking time evolution)\b/i);
    const logText = end >= 0 ? tail.slice(0, end) : tail;
    const lines = logText.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const events = [];
    let move = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const moveMatch = lines[index].match(/^Move\s+(\d+)\s*:?\s*$/i);
      if (moveMatch) {
        move = Number(moveMatch[1]);
        continue;
      }
      if (!isReviewActionLine(lines[index])) continue;
      events.push({
        id: `review-move-${move || 'unknown'}-${index}`,
        text: lines[index],
        source: 'review-game-log',
        selector: 'body',
        visible: true,
      });
    }
    return events;
  }

  function collectLogEvents() {
    const reviewEvents = collectReviewLogEvents();
    if (reviewEvents.length) return reviewEvents;

    const selectors = [
      // Intentionally exclude BGA's cumulative replay/chat caches from normal scans: they can be hidden,
      // stale, or for a different replay/viewpoint. Only visible, current-page log rows feed the model.
      { selector: '#logs .log', label: 'visible-log' },
      { selector: '#logs .gamelog', label: 'visible-gamelog' },
      { selector: '[id^="dockedlog_"] .game_move_notif', label: 'docked-tablelog' },
      { selector: '.game_move_notif', label: 'move-notif' },
    ];
    const seen = new Set();
    const events = [];
    for (const { selector, label } of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector)).slice(0, 400)) {
        const visible = isNodeVisible(node);
        if (!visible) continue;
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const id = node.id || node.dataset?.notifId || node.dataset?.id || '';
        const key = id ? `${label}:${id}` : `${label}:${text}`;
        if (seen.has(key) || seen.has(text)) continue;
        seen.add(key);
        seen.add(text);
        events.push({ id, text, source: label, selector, visible });
      }
    }
    return events;
  }

  function visibleCandidateText() {
    const logEvents = collectLogEvents();
    if (logEvents.length) return logEvents.map((event) => event.text).join('\n').slice(0, 60000);
    const chunks = [];
    for (const selector of BGA_SELECTORS) {
      for (const node of Array.from(document.querySelectorAll(selector)).slice(0, 100)) {
        if (!isNodeVisible(node)) continue;
        const text = (node.innerText || node.textContent || '').trim();
        if (text) chunks.push(`[${selector}]\n${text}`);
      }
    }
    if (!chunks.length) chunks.push(document.body.innerText || document.body.textContent || '');
    return chunks.join('\n\n').slice(0, 60000);
  }

  function extractReplayMoveNumber() {
    const url = new URL(location.href);
    for (const param of ['goto', 'move', 'step', 'turn']) {
      const value = url.searchParams.get(param);
      const number = Number(value);
      if (Number.isInteger(number) && number > 0) return number;
    }

    const archiveControlText = [
      document.querySelector('#archivecontrol')?.innerText,
      document.querySelector('#archive_goto')?.value,
      document.querySelector('#archive_goto')?.getAttribute('value'),
      document.querySelector('#archive_current_move')?.innerText,
      document.querySelector('#archive_move')?.innerText,
    ].filter(Boolean).join(' ');
    const match = archiveControlText.match(/\b(?:move|step|turn|goto)\s*#?\s*(\d+)\b/i)
      || archiveControlText.match(/\b(\d+)\s*\/\s*\d+\b/);
    return match ? Number(match[1]) : 0;
  }

  function collectBgaVisibleState() {
    const ownHand = model.emptyCounts();
    const handCards = Array.from(document.querySelectorAll('.hand-card[data-id][data-type][data-color]')).filter(isNodeVisible).map((node) => {
      const card = model.typeKeyToCard(node.dataset.type);
      if (card) ownHand[card] += 1;
      return {
        id: node.dataset.id || '',
        type: node.dataset.type || '',
        card,
        color: node.dataset.color || ''
      };
    });

    const counters = {};
    for (const node of Array.from(document.querySelectorAll('.deck-count, .hand-count, .air-strike-count, .units-in-play, .units-destroyed'))) {
      if (!isNodeVisible(node)) continue;
      const match = String(node.id || '').match(/^(deck|hand|air-strike|units-in-play|units-destroyed)-count-(\d+)$/);
      if (!match) continue;
      const [, kind, playerId] = match;
      counters[playerId] ||= {};
      counters[playerId][kind] = Number((node.innerText || node.textContent || '').trim());
    }

    for (const node of Array.from(document.querySelectorAll('[id^="player_name_"]'))) {
      if (!isNodeVisible(node)) continue;
      const match = String(node.id || '').match(/^player_name_(\d+)$/);
      if (!match) continue;
      const playerId = match[1];
      counters[playerId] ||= {};
      counters[playerId].name = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    }

    return {
      gameContainerClass: document.querySelector('#game-container')?.className || '',
      viewerName: (document.querySelector('#archiveViewerName')?.innerText || document.querySelector('#archiveViewerName')?.textContent || '').replace(/\s+/g, ' ').trim(),
      reviewPlayers: extractReviewPlayersFromText(document.body?.innerText || document.body?.textContent || ''),
      battlefieldPositions: Array.from(document.querySelectorAll('.battlefield-position[data-x][data-y]')).filter(isNodeVisible).length,
      battlefieldCards: Array.from(document.querySelectorAll('.battlefield-card')).filter(isNodeVisible).length,
      handCards,
      ownHand,
      visibleUnitHandCount: handCards.filter((card) => card.card && card.card !== 'air_strike').length,
      visibleAirStrikeCount: handCards.filter((card) => card.card === 'air_strike').length,
      counters,
      replayMoveNumber: extractReplayMoveNumber()
    };
  }

  function inferPlayerCounters(visibleState) {
    return model.inferPlayerMapping({
      url: location.href,
      counters: visibleState?.counters || {},
      visibleHandCount: visibleState?.handCards?.length || 0,
      visibleUnitHandCount: visibleState?.visibleUnitHandCount ?? null,
      visibleAirStrikeCount: visibleState?.visibleAirStrikeCount ?? null,
      viewerName: visibleState?.viewerName || '',
    });
  }

  function tentativeParserNames(visibleState, inferred) {
    const counters = visibleState?.counters || {};
    const entries = Object.entries(counters);
    const playerParam = String(location.href || '').match(/[?&]player=(\d+)/)?.[1] || '';
    const viewerName = visibleState?.viewerName || '';
    const ownEntry = entries.find(([playerId]) => playerId === inferred?.ownPlayerId)
      || entries.find(([playerId]) => playerId === playerParam)
      || entries.find(([, values]) => viewerName && values?.name === viewerName)
      || null;
    const opponentEntry = entries.find(([playerId]) => playerId === inferred?.opponentPlayerId)
      || entries.find(([playerId]) => ownEntry && playerId !== ownEntry[0])
      || null;
    const reviewPlayers = visibleState?.reviewPlayers || [];
    return {
      ownNames: ownEntry?.[1]?.name ? [ownEntry[1].name] : (reviewPlayers[0] ? [reviewPlayers[0]] : undefined),
      opponentNames: opponentEntry?.[1]?.name ? [opponentEntry[1].name] : (reviewPlayers[1] ? [reviewPlayers[1]] : undefined),
      source: ownEntry || opponentEntry
        ? 'counter-name parser attribution; advice still gated by mapping confidence'
        : (reviewPlayers.length >= 2 ? 'gamereview player-list parser attribution; advice still gated by mapping confidence' : 'default parser attribution'),
    };
  }

  function inspectReplayControls() {
    const textOf = (node) => `${node.innerText || node.textContent || ''} ${node.title || ''} ${node.getAttribute('aria-label') || ''} ${node.id || ''} ${node.className || ''}`.replace(/\s+/g, ' ').trim();
    const replayEntry = Array.from(document.querySelectorAll('#logs .replay_last_move_button, .replay_last_move_button')).find((node) => /replay last moves|last moves/i.test(textOf(node)));
    const href = replayEntry?.getAttribute('href') || '';
    if (href && /replayLastTurnPlayer=-\d+/.test(href)) {
      return {
        entryFound: true,
        controls: { back: false, playPause: false, forward: false },
        status: 'entry visible but unsupported: spectator-negative-player-id',
        source: 'tight replay-entry selector; no replay transport controls clicked',
      };
    }
    const archive = document.querySelector('#archivecontrol');
    const archiveVisible = !!archive && !!(archive.offsetWidth || archive.offsetHeight || archive.getClientRects().length);
    const isVisible = (node) => !!node && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    const restart = archiveVisible ? document.querySelector('#archive_restart') : null;
    const next = archiveVisible ? document.querySelector('#archive_next') : null;
    const endGame = archiveVisible ? document.querySelector('#archive_end_game') : null;
    const nextTurn = archiveVisible ? document.querySelector('#archive_next_turn') : null;
    const controls = {
      back: isVisible(restart),
      playPause: false,
      forward: isVisible(next) || isVisible(nextTurn) || isVisible(endGame),
    };
    const labels = [restart, next, nextTurn, endGame].filter(isVisible).map((node) => `#${node.id}`).join(', ');
    const foundCount = Object.values(controls).filter(Boolean).length;
    return {
      entryFound: !!replayEntry,
      controls,
      status: archiveVisible ? `archive controls ${foundCount}/3 (${labels || 'none'})` : (replayEntry ? 'entry visible; archive controls not visible' : 'archive controls not visible'),
      source: archiveVisible ? 'explicit #archivecontrol selectors; no clicks performed' : (replayEntry ? 'tight replay-entry + #archivecontrol scan only; no clicks performed' : 'DOM scan only; no replay entry clicked'),
    };
  }


  function percent(value) {
    return `${Math.round(Number(value || 0) * 100)}%`;
  }

  function render(summary, visibleState = null) {
    const inferred = visibleState ? inferPlayerCounters(visibleState) : { ownPlayerId: '', opponentPlayerId: '', ownCounters: {}, opponentCounters: {}, confidence: 0, confidenceLabel: 'manual text', reason: 'Page counters were not scanned.' };
    const cardTable = model.buildPlayerCardTable({
      ownKnownUsed: summary.ownUsed,
      opponentKnownUsed: summary.opponentUsed,
      ownVisibleHand: visibleState?.ownHand || model.emptyCounts(),
      ownCounters: inferred.ownCounters,
      opponentCounters: inferred.opponentCounters,
    });
    const rows = Object.entries(cardTable.rows).map(([key, row]) => {
      const ownHandMismatch = row.ownVisibleHand !== row.ownLeftTotal && cardTable.own.counters.deck === 0 && (key !== 'air_strike' || cardTable.own.counters.airStrike === 0);
      const sourceMark = row.ownVerifiedSource === 'parsed-ledger' ? '' : ' *';
      const opponentHandCell = cardTable.opponent.probabilityOk ? percent(row.opponentHandProbability) : 'blocked';
      return `<tr${ownHandMismatch ? ' class="hill218-mismatch-row"' : ''}><td>${row.label}</td><td>${row.ownVisibleHand}</td><td>${row.ownVerifiedUsed} / ${row.ownVerifiedLeft}${sourceMark}</td><td>${row.opponentUsed} / ${row.opponentLeftTotal}</td><td>${opponentHandCell}</td></tr>`;
    }).join('');
    const spentLedgerRows = (summary.replayLedger?.rows || []).filter((row) => row.spentThisStep > 0);
    const latestSpentStep = spentLedgerRows.at(-1)?.step || 0;
    const ownLedgerTotal = summary.replayLedger?.totals?.own || { used: 0, left: 26 };
    const opponentLedgerTotal = summary.replayLedger?.totals?.opponent || { used: 0, left: 26 };
    const unknownLedgerTotal = summary.replayLedger?.totals?.unknown || { used: 0, left: 26 };
    const replayMoveNumber = visibleState?.replayMoveNumber || 0;
    const totalLabelParts = [];
    if (replayMoveNumber) totalLabelParts.push(`move ${replayMoveNumber}`);
    if (latestSpentStep && latestSpentStep !== replayMoveNumber) totalLabelParts.push(`parsed ${latestSpentStep}`);
    else if (latestSpentStep && !replayMoveNumber) totalLabelParts.push(`step ${latestSpentStep}`);
    const ownVerifiedLeftTotal = Object.values(cardTable.rows).reduce((sum, row) => sum + row.ownVerifiedLeft, 0);
    const ownVerifiedUsedTotal = Object.values(cardTable.rows).reduce((sum, row) => sum + row.ownVerifiedUsed, 0);
    const totalRow = `<tr><td><strong>Total${totalLabelParts.length ? ` (${totalLabelParts.join('; ')})` : ''}</strong></td><td><strong>${cardTable.own.visibleHandTotal}</strong></td><td><strong>${ownVerifiedUsedTotal} / ${ownVerifiedLeftTotal}</strong></td><td><strong>${opponentLedgerTotal.used} / ${opponentLedgerTotal.left}</strong></td><td>—</td></tr>`;
    const unknownLedgerRow = unknownLedgerTotal.used > 0
      ? `<tr class="hill218-unmapped-row"><td><strong>Unmapped parsed events</strong></td><td>—</td><td colspan="2"><strong>${unknownLedgerTotal.used} / ${unknownLedgerTotal.left}</strong><br><span>blocked until player mapping passes</span></td><td>—</td></tr>`
      : '';
    const handRows = visibleState ? Object.entries(model.DECK).map(([key, spec]) => {
      return `<tr><td>${spec.label}</td><td>${visibleState.ownHand[key]}</td></tr>`;
    }).join('') : '';
    const exactVisibleHand = cardTable.own.visibleHandLabels.length
      ? cardTable.own.visibleHandLabels.join(', ')
      : 'none detected';
    const counterRows = visibleState ? Object.entries(visibleState.counters).map(([playerId, values]) => {
      const role = playerId === inferred.ownPlayerId ? 'you?' : (playerId === inferred.opponentPlayerId ? 'opponent?' : 'unknown');
      return `<tr><td>${escapeHtml(playerId)}</td><td>${escapeHtml(values.name || '')}</td><td>${escapeHtml(role)}</td><td>${values.deck ?? ''}</td><td>${values.hand ?? ''}</td><td>${values['air-strike'] ?? ''}</td><td>${values['units-in-play'] ?? ''}</td><td>${values['units-destroyed'] ?? ''}</td></tr>`;
    }).join('') : '';
    const logEvents = visibleState ? collectLogEvents() : [];
    const sourceCounts = logEvents.reduce((counts, event) => {
      counts[event.source] = (counts[event.source] || 0) + 1;
      return counts;
    }, {});
    const sourceRows = Object.entries(sourceCounts).map(([source, count]) => `<tr><td>${escapeHtml(source)}</td><td>${count}</td></tr>`).join('') || `<tr><td>${visibleState ? 'fallback page text' : 'manual textarea'}</td><td>${summary.metrics?.logEventsRead ?? 0}</td></tr>`;
    const replay = visibleState ? inspectReplayControls() : { status: 'not scanned', source: 'manual textarea parse', controls: { back: false, playPause: false, forward: false } };
    const metrics = summary.metrics || { logEventsRead: summary.events.length, logEventsParsed: summary.events.length, logEventsUnparsed: 0, unparsedSamples: [] };
    const reconciliationWarnings = [
      ...(cardTable.own.reconciliation?.warnings || []),
      ...(cardTable.opponent.reconciliation?.warnings || []),
    ];
    const parseRate = metrics.logEventsRead ? Math.round((metrics.logEventsParsed / metrics.logEventsRead) * 100) : 0;
    const actionableRate = Math.round(Number(metrics.actionableCoverage ?? 0) * 100);
    const unknownCardEvents = Object.values(summary.unknownUsed).reduce((a, b) => a + b, 0);
    const attributionRate = summary.events.length ? Math.round(((summary.events.length - unknownCardEvents) / summary.events.length) * 100) : 100;
    const qualityOk = metrics.logEventsRead > 0 && actionableRate >= 90 && attributionRate >= 95 && inferred.confidence >= 85 && unknownCardEvents === 0 && reconciliationWarnings.length === 0;
    const topOpponentRisks = Object.entries(cardTable.rows)
      .map(([key, row]) => ({ key, label: row.label, probability: row.opponentHandProbability, left: row.opponentLeftTotal }))
      .filter((row) => cardTable.opponent.probabilityOk && row.left > 0 && row.probability > 0)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 3);
    const adviceItems = qualityOk ? [
      ...summary.hints.map((hint) => ({ kind: 'Count risk', text: hint, evidence: `${actionableRate}% actionable / ${attributionRate}% attribution / player map ${inferred.confidence}%` })),
      ...topOpponentRisks.map((risk) => ({ kind: 'Opponent hand probability', text: `${risk.label}: ${percent(risk.probability)} chance opponent holds at least one copy.`, evidence: `Opponent left total ${risk.left}; public pool ${cardTable.opponent.publicUnknownPool}; opponent hand ${cardTable.opponent.counters.hand}` })),
    ] : [];
    const adviceBlock = qualityOk
      ? `<details class="hill218-advice-details"><summary>Read-only expert/risk advice</summary><div class="hill218-advice"><p class="hill218-note">Gate passed. Informational only; no game actions are automated.</p><ol>${adviceItems.map((item) => `<li><strong>${escapeHtml(item.kind)}:</strong> ${escapeHtml(item.text)}<br><span>Evidence: ${escapeHtml(item.evidence)}</span></li>`).join('')}</ol></div></details>`
      : `<details class="hill218-advice-details"><summary>Read-only expert/risk advice</summary><p class="hill218-note">Hidden until gates pass: actionable ≥90%, attribution ≥95%, player mapping ≥85% with ≥2 independent signals (URL/viewer/player id + visible hand DOM + public counter row), unknown-player events = 0.</p></details>`;
    const unparsedSamples = metrics.unparsedSamples?.length ? `<details><summary>Actionable unparsed samples</summary><ol>${metrics.unparsedSamples.map((line) => `<li>${escapeHtml(line).slice(0, 220)}</li>`).join('')}</ol></details>` : '';
    captureDetailsOpenState(output);
    output.innerHTML = `
      <div class="hill218-quality-compact ${qualityOk ? 'hill218-quality-ok' : 'hill218-quality-warn'}">
        Quality: ${qualityOk ? 'OK' : 'Check'} · actions ${actionableRate}% · attribution ${attributionRate}% · player map ${inferred.confidence}%
      </div>
      <details class="hill218-card-details">
        <summary>Public card counter</summary>
        <p class="hill218-note"><strong>Your exact visible hand (${cardTable.own.visibleHandTotal})</strong>: ${escapeHtml(exactVisibleHand)}.</p>
        ${visibleState ? `<table><thead><tr><th>Your exact visible hand</th><th>DOM count</th></tr></thead><tbody>${handRows}</tbody></table>` : ''}
        <p class="hill218-note">Your used / left is corrected from visible hand when your deck is empty; * marks a correction over incomplete live log. Opponent hand is probability only, using ${escapeHtml(cardTable.opponent.hiddenHandLabel)} and ${escapeHtml(cardTable.opponent.probabilityPoolLabel)}.</p>
        <table class="hill218-card-table">
          <thead><tr><th>Card</th><th>You<br><span>exact hand</span></th><th>You<br><span>log used / left</span></th><th>Opp<br><span>log used / left</span></th><th>Opp hidden hand<br><span>${cardTable.opponent.hiddenHandTotal} cards total</span></th></tr></thead>
          <tbody>${rows}${totalRow}${unknownLedgerRow}</tbody>
        </table>
      </details>
      ${adviceBlock}
      <details class="hill218-scan-details">
        <summary>Read-only scan / visible replay state</summary>
        <p class="hill218-note">Parsed card/action events: ${summary.events.length}. Unknown-player card events: ${unknownCardEvents}.</p>
        ${visibleState ? `
          <p class="hill218-note">Hand cards: ${visibleState.handCards.length}; battlefield positions: ${visibleState.battlefieldPositions}; battlefield cards: ${visibleState.battlefieldCards}; container: ${escapeHtml(visibleState.gameContainerClass || 'unknown')}.</p>
          <p class="hill218-note">Public pools — you: deck ${cardTable.own.counters.deck}, hand ${cardTable.own.counters.hand}, visible hand ${cardTable.own.visibleHandTotal}; opponent: deck ${cardTable.opponent.counters.deck}, hidden hand ${cardTable.opponent.counters.hand}, probability pool ${cardTable.opponent.publicUnknownPool}, possible-by-log ${cardTable.opponent.possibleLeftTotal}.</p>
        ` : ''}
      </details>
      <details class="hill218-metrics-details">
        <summary>Data-quality details</summary>
        <div class="hill218-quality">
          <div><strong>Log events</strong><span>${metrics.logEventsRead} read / ${metrics.logEventsParsed} parsed / ${metrics.logEventsUnparsed} unparsed (${parseRate}% raw)</span></div>
          <div><strong>Actionable coverage</strong><span>${metrics.actionableParsed ?? metrics.logEventsParsed}/${metrics.actionableLines ?? metrics.logEventsRead} parsed (${actionableRate}%); non-actionable ${metrics.nonActionableLines ?? 0}; actionable-unparsed ${metrics.actionableUnparsed ?? 0}</span></div>
          <div><strong>Card attribution</strong><span>${attributionRate}% — ${summary.events.length - unknownCardEvents}/${summary.events.length} card/action events mapped to player, unknown ${unknownCardEvents}</span></div>
          <div><strong>Player mapping</strong><span>${inferred.confidence}% ${escapeHtml(inferred.confidenceLabel)} — ${escapeHtml(inferred.reason || 'no signals')} ${inferred.blockers?.length ? ` BLOCKED: ${escapeHtml(inferred.blockers.join('; '))}` : ''}</span></div>
          <div><strong>Public reconciliation</strong><span>${reconciliationWarnings.length ? `BLOCKED: ${escapeHtml(reconciliationWarnings.join('; '))}` : 'OK — parsed used totals match public counters when counters are visible'}</span></div>
          <div><strong>Replay move</strong><span>${replayMoveNumber ? `move ${replayMoveNumber}` : 'not detected'}${latestSpentStep ? `; parsed spent step ${latestSpentStep}` : ''}</span></div>
          <div><strong>Replay controls</strong><span>${escapeHtml(replay.status)}; back ${replay.controls.back ? 'yes' : 'no'}, play/pause ${replay.controls.playPause ? 'yes' : 'no'}, forward ${replay.controls.forward ? 'yes' : 'no'}</span></div>
          <div><strong>Sources</strong><span>${escapeHtml(replay.source)}</span></div>
        </div>
        <table class="hill218-source-table"><thead><tr><th>Source label</th><th>Events</th></tr></thead><tbody>${sourceRows}</tbody></table>
        ${unparsedSamples}
      </details>
    `;
    applyDetailsOpenState(output);
  }

  function parseNow() { render(model.parseLog(input.value)); }

  function currentPageSignature() {
    const counterText = Array.from(document.querySelectorAll('.deck-count, .hand-count, .air-strike-count, .units-in-play, .units-destroyed'))
      .filter(isNodeVisible)
      .map((node) => `${node.id}:${(node.innerText || node.textContent || '').trim()}`)
      .join('|');
    const replayText = collectLogEvents()
      .map((event) => event.text)
      .filter(Boolean)
      .join('\n')
      .slice(-4000);
    const visibleHandCount = Array.from(document.querySelectorAll('.hand-card[data-id][data-type][data-color]')).filter(isNodeVisible).length;
    const visibleBattlefieldCount = Array.from(document.querySelectorAll('.battlefield-card')).filter(isNodeVisible).length;
    return `${location.href}|${document.title}|${counterText}|${replayText}|h${visibleHandCount}|b${visibleBattlefieldCount}`;
  }

  function scanNow(reason = 'manual') {
    const logEvents = collectLogEvents();
    input.value = logEvents.length ? logEvents.map((event) => event.text).join('\n') : visibleCandidateText();
    const visibleState = collectBgaVisibleState();
    const inferred = inferPlayerCounters(visibleState);
    const tentativeNames = tentativeParserNames(visibleState, inferred);
    const parserOptions = {
      ownNames: tentativeNames.ownNames,
      opponentNames: tentativeNames.opponentNames,
    };
    const summary = logEvents.length ? model.parseBgaLogLines(logEvents, parserOptions) : model.parseLog(input.value, parserOptions);
    render(summary, visibleState);
    const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const sources = [...new Set(logEvents.map((event) => event.source))].join(', ') || 'fallback text';
    scanStatus.textContent = `${reason === 'auto' ? 'Auto' : 'Manual'} scan ${stamp}: ${logEvents.length} rows from ${sources}`;
    lastScanSignature = currentPageSignature();
  }

  function buildStatusReport() {
    const text = output.textContent || output.innerText || '';
    const quality = text.match(/Quality:[^\n]+/)?.[0] || 'Quality: unknown';
    const total = text.match(/Total \([^)]+\)\d+ \/ \d+\d+ \/ \d+/)?.[0]
      || text.match(/Total[^\n]+/)?.[0]
      || 'Total: not available';
    const replayMove = text.match(/Replay move\s*(move \d+(?:; parsed spent step \d+)?|not detected[^\n]*)/)?.[1]
      || text.match(/Total \(([^)]+)\)/)?.[1]
      || 'not detected';
    const logEvents = text.match(/Log events\s*([^\n]+)/)?.[1] || 'not available';
    const mapping = text.match(/Player mapping\s*([^\n]+)/)?.[1] || 'not available';
    return [
      'BGA status',
      `URL: ${location.href}`,
      quality,
      `Replay: ${replayMove}`,
      `Cards: ${total.replace(/\s+/g, ' ')}`,
      `Logs: ${logEvents.replace(/\s+/g, ' ')}`,
      `Mapping: ${mapping.replace(/\s+/g, ' ')}`,
    ].join('\n');
  }

  let lastScanSignature = '';
  let scanTimer = null;
  function scheduleScan(reason = 'auto') {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const signature = currentPageSignature();
      if (reason !== 'manual' && signature === lastScanSignature) return;
      scanNow(reason);
    }, 750);
  }

  panel.querySelector('#hill218-scan').addEventListener('click', () => scanNow('manual'));
  panel.querySelector('#hill218-parse').addEventListener('click', parseNow);
  panel.querySelector('#hill218-sample').addEventListener('click', () => {
    input.value = [
      'You placed a Infantry card at 0,0',
      'You placed a Heavy Weapons card at 1,0',
      'Opponent placed a Artillery card at 0,1',
      'Opponent placed a Special Forces card at 1,1',
      'Opponent placed a Tank card at 2,1',
      'Opponent played an Air Strike card destroying the Infantry card at 0,0'
    ].join('\n');
    parseNow();
  });
  panel.querySelector('#hill218-clear').addEventListener('click', () => { input.value = ''; parseNow(); });
  panel.querySelector('#hill218-copy-status').addEventListener('click', async () => {
    const status = buildStatusReport();
    try {
      await navigator.clipboard.writeText(status);
      scanStatus.textContent = 'Status copied.';
    } catch (_error) {
      input.value = status;
      scanStatus.textContent = 'Clipboard blocked; status pasted into captured text.';
    }
  });
  panel.querySelector('#hill218-copy-diag').addEventListener('click', async () => {
    const diagnostics = JSON.stringify(pageDiagnostics(), null, 2);
    try {
      await navigator.clipboard.writeText(diagnostics);
      output.insertAdjacentHTML('beforeend', '<p class="hill218-note">Diagnostics copied to clipboard.</p>');
    } catch (error) {
      input.value = diagnostics;
      output.insertAdjacentHTML('beforeend', '<p class="hill218-note">Clipboard blocked; diagnostics pasted into textarea.</p>');
    }
  });
  panel.querySelector('#hill218-minimize').addEventListener('click', () => {
    body.hidden = !body.hidden;
    panel.querySelector('#hill218-minimize').textContent = body.hidden ? '+' : '–';
  });

  let drag = null;
  header.addEventListener('mousedown', (event) => {
    if (event.target.tagName === 'BUTTON') return;
    const rect = panel.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!drag) return;
    panel.style.left = `${Math.max(0, event.clientX - drag.x)}px`;
    panel.style.top = `${Math.max(0, event.clientY - drag.y)}px`;
    panel.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => { drag = null; });

  const observer = new MutationObserver((mutations) => {
    if (mutations.every((mutation) => panel.contains(mutation.target))) return;
    scheduleScan('auto');
  });
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-type', 'data-id']
  });
  window.setInterval(() => scheduleScan('auto'), 3000);
  window.setTimeout(() => scanNow('auto'), 1000);

  render(model.parseLog(''));
})();
