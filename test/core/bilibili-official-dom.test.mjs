import test from 'node:test';
import assert from 'node:assert/strict';
import { computeOfficialDomGeometry, OfficialDomObserver, OFFICIAL_DOM_OBSERVER_CAPACITY,
  OFFICIAL_DOM_OBSERVER_INTERVAL_MS, OFFICIAL_DANMAKU_SELECTOR } from '../../src/platforms/bilibili/official-dom-observer.ts';

class FixtureMutationObserver {
  static latest;
  constructor(callback) { this.callback = callback; this.disconnected = false; FixtureMutationObserver.latest = this; }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  deliver(records) { this.callback(records, this); }
}

function fixture({ children = [], clipRight = 290, width = 300, height = 200 } = {}) {
  const documentElement = {
    parentElement: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: width, bottom: height }),
    computedStyle: { display: 'block', visibility: 'visible', opacity: '1', overflow: 'visible' },
  };
  const document = { documentElement, defaultView: {
    innerWidth: width, innerHeight: height, MutationObserver: FixtureMutationObserver,
    getComputedStyle: node => {
      node.styleReads = (node.styleReads ?? 0) + 1;
      return node.computedStyle ?? { display: 'block', visibility: 'visible', opacity: '1', overflow: 'visible' };
    },
  } };
  const clippingParent = {
    ownerDocument: document, parentElement: documentElement,
    getBoundingClientRect: () => ({ left: 50, top: 50, right: clipRight, bottom: 190 }),
    computedStyle: { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'hidden', overflowY: 'hidden' },
  };
  const container = {
    ownerDocument: document, parentElement: clippingParent, children,
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 400, bottom: 300 }),
    computedStyle: { display: 'block', visibility: 'visible', opacity: '1', overflow: 'visible' },
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    },
    querySelectorAll(selector) {
      assert.equal(selector, OFFICIAL_DANMAKU_SELECTOR);
      return this.children.filter(node => node.className.split(/\s+/).includes('bili-danmaku-x-dm'));
    },
  };
  documentElement.ownerDocument = document;
  clippingParent.ownerDocument = document;
  for (const child of children) { child.parentElement = container; child.ownerDocument = document; child.isConnected = true; }
  const video = { currentTime: 1.25 };
  return { document, container, video, clippingParent };
}

function danmaku(text, { left = 280, top = 150, opacity = '0.47' } = {}) {
  const element = {
    nodeType: 1, className: 'bili-danmaku-x-dm bili-danmaku-x-show', textContent: text,
    parentElement: null, ownerDocument: null, isConnected: true,
    style: { cssText: '--opacity: 0.47; --fontSize: 22.232px; --color: #fff;' },
    computedStyle: { display: 'flex', visibility: 'visible', opacity, position: 'absolute', transform: 'none',
      animationName: 'roll', animationPlayState: 'running', zIndex: '200' },
    classList: { contains(name) { return element.className.split(/\s+/).includes(name); } },
    getAttribute(name) { return name === 'class' ? element.className : name === 'style' ? element.style.cssText : null; },
    rectReads: 0,
    getBoundingClientRect() { this.rectReads++; return { left, top, right: left + 50, bottom: top + 25 }; },
  };
  return element;
}

const makeObserver = (f, clock = { mono: 10, epoch: 1000 }) => new OfficialDomObserver({
  container: f.container, video: f.video, now: () => clock.mono, epochNow: () => clock.epoch,
});

test('geometry intersects viewport, player container and overflow ancestor clips', () => {
  const geometry = computeOfficialDomGeometry(
    { left: 280, top: 150, right: 350, bottom: 180 },
    { left: 0, top: 0, right: 300, bottom: 200 },
    { left: 100, top: 100, right: 400, bottom: 300 },
    [{ source: 'overflow-ancestor', rect: { left: 50, top: 50, right: 290, bottom: 190 } }],
  );
  assert.equal(geometry.intersects, true);
  assert.equal(geometry.visibleRect?.left, 280);
  assert.equal(geometry.visibleRect?.right, 290);
  assert.equal(geometry.intersectionAreaPx2, 300);
  const outsideViewport = computeOfficialDomGeometry(
    { left: 310, top: 150, right: 350, bottom: 180 },
    { left: 0, top: 0, right: 300, bottom: 200 },
    { left: 100, top: 100, right: 400, bottom: 300 },
  );
  assert.equal(outsideViewport.intersects, false);
  assert.equal(outsideViewport.visibleRect, null);
});

test('start snapshots initial nodes and labels geometry/style evidence without claiming pixels or dmid', () => {
  const element = danmaku('first');
  const f = fixture({ children: [element] });
  const observer = makeObserver(f);
  observer.start();

  const [row] = observer.snapshot();
  assert.equal(row.identity, 'unavailable-dom-only');
  assert.equal(row.dmid, null);
  assert.equal(row.elementId, 1);
  assert.equal(row.occurrence, 1);
  assert.equal(row.text, 'first');
  assert.equal(row.firstSeenAtEpochMs, 1000);
  assert.equal(row.firstSeenMediaMs, 1250);
  assert.equal(row.visibleAtEpochMs, 1000);
  assert.equal(row.visibleAtMediaMs, 1250);
  assert.equal(row.visibleEvidence?.geometry.visibleRect?.right, 290);
  assert.equal(row.visibleEvidence?.style.renderableByStyle, true);
  assert.equal(row.visibleEvidence?.visibilityBasis, 'geometry-and-computed-style-not-pixel-proof');
  assert.equal(OFFICIAL_DOM_OBSERVER_INTERVAL_MS, 100);
  assert.equal(FixtureMutationObserver.latest.options.subtree, true);
  assert.deepEqual(FixtureMutationObserver.latest.options.attributeFilter, ['class']);
  const rectReads = element.rectReads, styleReads = element.styleReads;
  FixtureMutationObserver.latest.deliver([{ type: 'attributes', attributeName: 'style', target: element }]);
  assert.equal(element.rectReads, rectReads, 'style mutations do not cause geometry reads');
  assert.equal(element.styleReads, styleReads, 'style mutations do not cause computed-style reads');
  observer.stop();
});

test('100ms sampling records the first geometry-visible time and stop ends rows and disconnects', async () => {
  const element = danmaku('moves in', { left: 500 });
  const f = fixture({ children: [element] });
  const clock = { mono: 10, epoch: 1000 };
  const observer = makeObserver(f, clock);
  observer.start();
  assert.equal(observer.snapshot()[0].visibleAtEpochMs, null);

  element.getBoundingClientRect = () => ({ left: 150, top: 150, right: 200, bottom: 175 });
  f.video.currentTime = 2;
  clock.mono = 110; clock.epoch = 1100;
  await new Promise(resolve => setTimeout(resolve, OFFICIAL_DOM_OBSERVER_INTERVAL_MS + 35));

  const [visible] = observer.snapshot();
  assert.equal(visible.visibleAtEpochMs, 1100);
  assert.equal(visible.visibleAtMediaMs, 2000);
  assert.equal(visible.visibleEvidence?.geometry.intersects, true);
  observer.stop();
  const [ended] = observer.snapshot();
  assert.equal(ended.endReason, 'observer-stopped');
  assert.equal(ended.endedAtEpochMs, 1100);
  assert.equal(FixtureMutationObserver.latest.disconnected, true);
});

test('pooled node class exit and re-entry creates a new occurrence without a text join', () => {
  const element = danmaku('same text');
  const f = fixture({ children: [element] });
  const observer = makeObserver(f);
  observer.start();
  const mutationObserver = FixtureMutationObserver.latest;
  const firstClass = element.className;

  element.className = 'bili-danmaku-x-17'; element.textContent = '';
  const exit = { type: 'attributes', attributeName: 'class', target: element, oldValue: firstClass };
  element.textContent = 'same text'; element.className = 'bili-danmaku-x-dm bili-danmaku-x-show';
  const enter = { type: 'attributes', attributeName: 'class', target: element, oldValue: 'bili-danmaku-x-17' };
  mutationObserver.deliver([exit, enter]);

  const rows = observer.snapshot();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endReason, 'class-exit');
  assert.equal(rows[1].text, 'same text');
  assert.equal(rows[1].elementId, rows[0].elementId);
  assert.equal(rows[1].occurrence, 2);
  assert.equal(rows[1].identity, 'unavailable-dom-only');
  assert.equal(rows[1].dmid, null);
  observer.stop();
});

test('text changes create occurrences even when the same pooled element is reused', () => {
  const element = danmaku('A');
  const f = fixture({ children: [element] });
  const observer = makeObserver(f);
  observer.start();
  const mutationObserver = FixtureMutationObserver.latest;

  for (const [before, after] of [['A', 'B'], ['B', 'A']]) {
    element.textContent = after;
    mutationObserver.deliver([{ type: 'childList', target: element,
      removedNodes: [{ textContent: before }], addedNodes: [{ textContent: after }] }]);
  }
  const rows = observer.snapshot();
  assert.deepEqual(rows.map(row => row.text), ['A', 'B', 'A']);
  assert.deepEqual(rows.map(row => row.occurrence), [1, 2, 3]);
  assert.ok(rows.every(row => row.elementId === rows[0].elementId && row.dmid === null));
  observer.stop();
});

test('capacity stops observation at 20,000 plain rows', () => {
  assert.equal(OFFICIAL_DOM_OBSERVER_CAPACITY, 20_000);
  const children = Array.from({ length: OFFICIAL_DOM_OBSERVER_CAPACITY + 1 }, (_, index) => danmaku('row-' + index));
  const f = fixture({ children });
  const observer = makeObserver(f);
  observer.start();
  assert.equal(observer.capacityExceeded, true);
  assert.equal(observer.snapshot().length, OFFICIAL_DOM_OBSERVER_CAPACITY);
  assert.equal(FixtureMutationObserver.latest.disconnected, true);
  observer.stop();
});
