const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  createChartLifecycle,
  createStorageAccess,
} = require('../../src/resources/js/app-state.js');
const LaminarLogView = require('../../src/resources/js/logview.js');

const appPath = path.join(__dirname, '../../src/resources/js/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const progressMixinSource = appSource.slice(0, appSource.indexOf('// Utility methods'));
const chartComponentsSource = appSource.slice(
  appSource.indexOf('const Home ='),
  appSource.indexOf('// Component for the /job/:name/:number endpoint')
);
const runComponentSource = appSource.slice(
  appSource.indexOf('const Run ='),
  appSource.indexOf("Vue.component('RouterLink'")
);

function loadChartComponents(charts, overrides = {}) {
  const context = {
    Charts: charts,
    clearInterval: overrides.clearInterval || (() => {}),
    setInterval: overrides.setInterval || (() => 1),
    window: {
      LaminarAppState: {
        createChartLifecycle: createChartLifecycle,
      },
    },
  };
  vm.runInNewContext(
    chartComponentsSource + '\n;globalThis.HomeComponent = Home; globalThis.JobComponent = Job;',
    context
  );
  return context;
}

function createComponentInstance(definition, overrides = {}) {
  const nextTicks = [];
  const instance = {
    $forceUpdate: () => {},
    $nextTick: callback => nextTicks.push(callback),
    $root: overrides.root || { $emit: () => {} },
  };
  if(definition.created)
    definition.created.call(instance);
  return { instance: instance, nextTicks: nextTicks };
}

function loadRunComponent(overrides = {}) {
  const codeElement = overrides.codeElement || {
    innerHTML: '',
    insertAdjacentHTML: () => {},
  };
  const context = {
    AbortController: AbortController,
    AnsiUp: class {
      ansi_to_html(text) {
        return text;
      }
    },
    Date: Date,
    TextDecoder: TextDecoder,
    clearTimeout: overrides.clearTimeout || (() => {}),
    console: overrides.console || { debug: () => {}, error: () => {}, info: () => {} },
    document: {
      body: {},
      documentElement: overrides.documentElement || { scrollHeight: 100 },
      getElementsByClassName: () => overrides.consoleElement ? [overrides.consoleElement] : [],
      getElementsByTagName: () => [codeElement],
      scrollingElement: null,
    },
    fetch: overrides.fetch,
    setTimeout: overrides.setTimeout || setTimeout,
    storage: createStorageAccess(() => overrides.localStorage || {}),
    window: {
      LaminarLogView: Object.prototype.hasOwnProperty.call(overrides, 'laminarLogView')
        ? overrides.laminarLogView
        : LaminarLogView,
      addEventListener: () => {},
      innerHeight: 100,
      localStorage: overrides.localStorage || {},
      scrollTo: () => {},
      scrollY: 0,
    },
  };
  vm.runInNewContext(
    runComponentSource + '\n;globalThis.RunComponent = Run;',
    context
  );
  return {
    codeElement: codeElement,
    definition: context.RunComponent('#run'),
  };
}

function createRunInstance(definition) {
  return {
    $forceUpdate: () => {},
    _props: { route: { params: { name: 'build', number: '42' } } },
    ensureAutoScrollController: definition.methods.ensureAutoScrollController,
  };
}

function jobStatus() {
  return {
    averageRuntime: 30,
    description: '',
    lastFailed: null,
    lastSuccess: null,
    pages: 1,
    queued: [],
    recent: [],
    running: [],
    sort: { field: 'number', order: 'dsc', page: 0 },
  };
}

function homeStatus() {
  return {
    buildTimeChanges: [],
    buildsPerDay: [],
    buildsPerJob: {},
    completedCounts: {},
    executorsBusy: 0,
    executorsTotal: 1,
    lowPassRates: [],
    queued: [],
    recent: [],
    resultChanged: [],
    running: [],
    timePerJob: {},
    timePerJobCounts: {},
  };
}

test('destroying a component clears its own progress timer', () => {
  const mixins = [];
  const clearedTimers = [];
  const context = {
    clearInterval: timer => clearedTimers.push(timer),
    Vue: {
      filter: () => {},
      mixin: definition => mixins.push(definition),
    },
  };

  vm.runInNewContext(progressMixinSource, context);
  assert.equal(mixins.length, 1);

  mixins[0].beforeDestroy.call({ updateTimer: 1385 });

  assert.deepEqual(clearedTimers, [1385]);
});

test('leaving a job page destroys its runtime chart', () => {
  let destroyCount = 0;
  const context = loadChartComponents({
    createRunTimeChart: () => ({
      destroy: () => destroyCount++,
    }),
  });
  const definition = context.JobComponent('#job');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, jobStatus());
  component.nextTicks.shift()();
  definition.beforeDestroy.call(component.instance);

  assert.equal(destroyCount, 1);
});

test('destroyed home page ignores deferred chart creation', () => {
  const createdCharts = [];
  const createChart = name => () => {
    createdCharts.push(name);
    return { destroy: () => {} };
  };
  const context = loadChartComponents({
    createExecutorUtilizationChart: createChart('utilization'),
    createRunsPerDayChart: createChart('buildsPerDay'),
    createRunsPerJobChart: createChart('buildsPerJob'),
    createTimePerJobChart: createChart('timePerJob'),
    createRunTimeChangesChart: createChart('buildTimeChanges'),
  });
  const definition = context.HomeComponent('#home');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, homeStatus());
  definition.beforeDestroy.call(component.instance);
  component.nextTicks.shift()();

  assert.deepEqual(createdCharts, []);
});

test('home requests a fresh status snapshot every 15 minutes', () => {
  const emittedEvents = [];
  let refreshCallback;
  let refreshDelay;
  const context = loadChartComponents({}, {
    setInterval: (callback, delay) => {
      refreshCallback = callback;
      refreshDelay = delay;
      return 1385;
    },
  });
  const definition = context.HomeComponent('#home');

  createComponentInstance(definition, {
    root: { $emit: event => emittedEvents.push(event) },
  });

  assert.equal(refreshDelay, 900000);
  refreshCallback();
  assert.deepEqual(emittedEvents, ['navigate']);
});

test('leaving home cancels its status refresh interval', () => {
  const clearedIntervals = [];
  const context = loadChartComponents({}, {
    setInterval: () => 1385,
    clearInterval: timer => clearedIntervals.push(timer),
  });
  const definition = context.HomeComponent('#home');
  const component = createComponentInstance(definition);

  definition.beforeDestroy.call(component.instance);

  assert.deepEqual(clearedIntervals, [1385]);
});

test('a queued home status refresh is inert after leaving home', () => {
  const emittedEvents = [];
  let refreshCallback;
  const context = loadChartComponents({}, {
    setInterval: callback => {
      refreshCallback = callback;
      return 1385;
    },
  });
  const definition = context.HomeComponent('#home');
  const component = createComponentInstance(definition, {
    root: { $emit: event => emittedEvents.push(event) },
  });

  definition.beforeDestroy.call(component.instance);
  refreshCallback();

  assert.deepEqual(emittedEvents, []);
});

test('destroyed job page ignores deferred chart creation', () => {
  let createCount = 0;
  const context = loadChartComponents({
    createRunTimeChart: () => {
      createCount++;
      return { destroy: () => {} };
    },
  });
  const definition = context.JobComponent('#job');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, jobStatus());
  definition.beforeDestroy.call(component.instance);
  component.nextTicks.shift()();

  assert.equal(createCount, 0);
});

test('leaving a run page cancels its pending log render', async () => {
  const pendingTimers = new Map();
  const clearedTimers = [];
  const insertedHtml = [];
  let nextTimer = 1;
  let fetchSignal;
  let readCount = 0;
  const component = loadRunComponent({
    codeElement: {
      innerHTML: '',
      insertAdjacentHTML: (position, html) => insertedHtml.push([position, html]),
    },
    clearTimeout: timer => {
      clearedTimers.push(timer);
      pendingTimers.delete(timer);
    },
    fetch: (url, options) => {
      fetchSignal = options.signal;
      return Promise.resolve({
        body: {
          getReader: () => ({
            read: () => {
              readCount++;
              if(readCount === 1)
                return Promise.resolve({ done: false, value: new Uint8Array([108, 111, 103]) });
              return new Promise(() => {});
            },
          }),
        },
      });
    },
    setTimeout: callback => {
      const timer = nextTimer++;
      pendingTimers.set(timer, callback);
      return timer;
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(pendingTimers.size, 1);
  assert.equal(typeof component.definition.beforeDestroy, 'function');
  const staleRender = pendingTimers.values().next().value;
  component.definition.beforeDestroy.call(instance);

  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(clearedTimers, [1]);
  assert.equal(instance.logstream, null);
  staleRender();
  assert.deepEqual(insertedHtml, []);
});

test('leaving a run page cancels its pending final log render', async () => {
  const pendingTimers = new Map();
  const clearedTimers = [];
  let nextTimer = 1;
  const component = loadRunComponent({
    clearTimeout: timer => {
      clearedTimers.push(timer);
      pendingTimers.delete(timer);
    },
    fetch: () => Promise.resolve({
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true }),
        }),
      },
    }),
    setTimeout: callback => {
      const timer = nextTimer++;
      pendingTimers.set(timer, callback);
      return timer;
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(pendingTimers.size, 1);
  component.definition.beforeDestroy.call(instance);

  assert.deepEqual(clearedTimers, [1]);
  assert.equal(pendingTimers.size, 0);
});

test('leaving a run page does not report its expected fetch abort', async () => {
  const errors = [];
  const component = loadRunComponent({
    console: {
      debug: () => {},
      error: (...args) => errors.push(args),
      info: () => {},
    },
    fetch: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  component.definition.beforeDestroy.call(instance);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(errors, []);
});

test('an unsolicited log fetch abort is still reported', async () => {
  const errors = [];
  const error = new Error('The response body was aborted');
  error.name = 'AbortError';
  const component = loadRunComponent({
    console: {
      debug: () => {},
      error: (...args) => errors.push(args),
      info: () => {},
    },
    fetch: () => Promise.reject(error),
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '[Laminar][logstream] failed');
  assert.equal(errors[0][1], error);
});

test('autoscroll debug is disabled by default and announces how to enable it', () => {
  const debugMessages = [];
  const infoMessages = [];
  const component = loadRunComponent({
    console: {
      debug: (...args) => debugMessages.push(args),
      error: () => {},
      info: (...args) => infoMessages.push(args),
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 0 });

  assert.equal(infoMessages.length, 1);
  assert.match(infoMessages[0][0], /autoscroll.*debug.*disabled/i);
  assert.match(infoMessages[0][0], /laminar\.debug\.autoscroll/);
  assert.deepEqual(debugMessages, []);
});

test('autoscroll debug can be enabled persistently in production', () => {
  const debugMessages = [];
  const infoMessages = [];
  const component = loadRunComponent({
    console: {
      debug: (...args) => debugMessages.push(args),
      error: () => {},
      info: (...args) => infoMessages.push(args),
    },
    localStorage: {
      getItem: key => key === 'laminar.debug.autoscroll' ? 'true' : null,
      setItem: () => {},
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 0 });

  assert.equal(infoMessages.length, 1);
  assert.match(infoMessages[0][0], /autoscroll.*debug.*enabled/i);
  assert.match(infoMessages[0][0], /removeItem/);
  assert.equal(debugMessages.length, 1);
  assert.equal(debugMessages[0][0], '[Laminar][autoscroll] run status updated');
});

test('blocked local storage safely leaves autoscroll debug disabled', () => {
  const infoMessages = [];

  assert.doesNotThrow(() => loadRunComponent({
    console: {
      debug: () => {},
      error: () => {},
      info: (...args) => infoMessages.push(args),
    },
    localStorage: {
      getItem: () => {
        throw new Error('storage access denied');
      },
    },
  }));

  assert.equal(infoMessages.length, 1);
  assert.match(infoMessages[0][0], /autoscroll.*debug.*disabled.*localStorage.*unavailable/i);
  assert.doesNotMatch(infoMessages[0][0], /setItem/);
});

test('missing logview script uses a quiet autoscroll fallback', () => {
  const debugMessages = [];
  let diagnosticReads = 0;
  const documentElement = {};
  Object.defineProperties(documentElement, {
    scrollHeight: {
      get: () => {
        diagnosticReads++;
        return 320;
      },
    },
  });
  const component = loadRunComponent({
    console: {
      debug: (...args) => debugMessages.push(args),
      error: () => {},
      info: () => {},
    },
    consoleElement: { scrollHeight: 320, scrollTop: 0 },
    documentElement: documentElement,
    laminarLogView: null,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 0 });

  assert.equal(instance.autoScrollController.isEnabled(), false);
  assert.equal(diagnosticReads, 0);
  assert.deepEqual(debugMessages, []);
});
