const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createEventSourceController,
} = require('../../src/resources/js/app-state.js');

function createHarness() {
  const sources = [];
  const timers = [];
  let nextTimerId = 1;

  const controller = createEventSourceController({
    createEventSource: url => {
      const source = {
        url: url,
        closed: false,
        close: function() {
          this.closed = true;
        },
      };
      sources.push(source);
      return source;
    },
    setTimeout: (callback, delay) => {
      const timer = {
        id: nextTimerId++,
        callback: callback,
        delay: delay,
        cancelled: false,
      };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: id => {
      const timer = timers.find(candidate => candidate.id === id);
      if(timer)
        timer.cancelled = true;
    },
  });

  return { controller, sources, timers };
}

test('reconnect uses the exact URL including its query', () => {
  const harness = createHarness();
  const url = 'https://ci.example/jobs/build?page=2&field=started&order=asc';

  harness.controller.connect(url, {});
  harness.sources[0].onerror(new Error('connection lost'));
  harness.timers[0].callback();

  assert.equal(harness.timers[0].delay, 500);
  assert.equal(harness.sources[0].closed, true);
  assert.equal(harness.sources[1].url, url);
});

test('an error from a superseded source cannot close the current source', () => {
  const harness = createHarness();

  harness.controller.connect('https://ci.example/jobs/first', {});
  const firstSource = harness.sources[0];
  harness.controller.connect('https://ci.example/jobs/second', {});
  const secondSource = harness.sources[1];
  firstSource.onerror(new Error('late error'));

  assert.equal(firstSource.closed, true);
  assert.equal(secondSource.closed, false);
  assert.equal(harness.timers.length, 0);
});

test('a stale timer cannot clear or trigger a newer pending retry', () => {
  const harness = createHarness();

  harness.controller.connect('https://ci.example/jobs/first', {});
  harness.sources[0].onerror(new Error('connection lost'));
  const staleRetry = harness.timers[0];

  harness.controller.connect('https://ci.example/jobs/second?page=3', {});
  assert.equal(staleRetry.cancelled, true);
  harness.sources[1].onerror(new Error('second connection lost'));
  const currentRetry = harness.timers[1];

  staleRetry.callback();
  harness.controller.connect('https://ci.example/jobs/third', {});
  assert.equal(currentRetry.cancelled, true);

  currentRetry.callback();
  assert.equal(harness.sources.length, 3);
  assert.equal(harness.sources[2].url, 'https://ci.example/jobs/third');
  assert.equal(harness.sources[2].closed, false);
});

test('repeated errors from one source schedule only one retry', () => {
  const harness = createHarness();

  harness.controller.connect('https://ci.example/', {});
  const source = harness.sources[0];
  source.onerror(new Error('first error'));
  source.onerror(new Error('duplicate error'));

  assert.equal(harness.timers.length, 1);
});

test('only the current source can deliver messages or connection errors', () => {
  const harness = createHarness();
  const events = [];

  harness.controller.connect('https://ci.example/first', {
    onMessage: () => events.push('first message'),
    onError: () => events.push('first error'),
  });
  const firstSource = harness.sources[0];
  harness.controller.connect('https://ci.example/second', {
    onMessage: () => events.push('second message'),
    onError: () => events.push('second error'),
  });
  const secondSource = harness.sources[1];

  assert.equal(harness.controller.isCurrent(firstSource), false);
  assert.equal(harness.controller.isCurrent(secondSource), true);

  firstSource.onmessage({ data: 'late' });
  firstSource.onerror(new Error('late error'));
  secondSource.onmessage({ data: 'current' });
  secondSource.onerror(new Error('connection lost'));

  assert.deepEqual(events, ['second message', 'second error']);
});

test('reconnect delay backs off to a bounded maximum', () => {
  const harness = createHarness();
  const delays = [];

  harness.controller.connect('https://ci.example/', {});
  for(let attempt = 0; attempt < 12; ++attempt) {
    harness.sources.at(-1).onerror(new Error('connection lost'));
    const retry = harness.timers.at(-1);
    delays.push(retry.delay);
    retry.callback();
  }

  assert.deepEqual(delays.slice(0, 4), [500, 750, 1125, 1687.5]);
  assert.equal(delays.at(-1), 7500);
  assert.equal(delays.every(delay => delay <= 7500), true);
});

test('a received message resets reconnect backoff', () => {
  const harness = createHarness();

  harness.controller.connect('https://ci.example/', {});
  harness.sources[0].onerror(new Error('first failure'));
  harness.timers[0].callback();
  harness.sources[1].onerror(new Error('second failure'));
  harness.timers[1].callback();

  harness.sources[2].onmessage({ data: 'connected' });
  harness.sources[2].onerror(new Error('failure after recovery'));

  assert.deepEqual(
    harness.timers.map(timer => timer.delay),
    [500, 750, 500]
  );
});
