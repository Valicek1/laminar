const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChartLifecycle,
  prependRecentRun,
} = require('../../src/resources/js/app-state.js');

test('replacing charts releases their canvases before creating replacements', () => {
  const lifecycle = createChartLifecycle();
  const canvasIds = ['utilization', 'builds-per-day', 'builds-per-job'];
  const canvasesInUse = new Set();
  const generations = [];

  const createCharts = own => {
    const charts = canvasIds.map(id => {
      if(canvasesInUse.has(id))
        throw new Error(`Canvas ${id} is already in use`);
      canvasesInUse.add(id);
      const chart = {
        destroy: () => canvasesInUse.delete(id),
      };
      own(id, chart);
      return chart;
    });
    generations.push(charts);
  };

  lifecycle.replace(createCharts);
  lifecycle.replace(createCharts);

  assert.equal(generations.length, 2);
  assert.equal(canvasesInUse.size, canvasIds.length);
  assert.equal(lifecycle.get('utilization'), generations[1][0]);
});

test('destroying a chart lifecycle releases all current charts', () => {
  const lifecycle = createChartLifecycle();
  const destroyed = [];

  lifecycle.replace(own => {
    own('utilization', { destroy: () => destroyed.push('utilization') });
    own('builds-per-day', { destroy: () => destroyed.push('builds-per-day') });
  });
  lifecycle.destroy();

  assert.deepEqual(destroyed, ['utilization', 'builds-per-day']);
  assert.equal(lifecycle.get('utilization'), undefined);
});

test('failed chart replacement releases charts created before the failure', () => {
  const lifecycle = createChartLifecycle();
  const canvasesInUse = new Set();
  const createChart = id => {
    if(canvasesInUse.has(id))
      throw new Error(`Canvas ${id} is already in use`);
    canvasesInUse.add(id);
    return { destroy: () => canvasesInUse.delete(id) };
  };

  assert.throws(() => lifecycle.replace(own => {
    own('utilization', createChart('utilization'));
    own('builds-per-day', createChart('builds-per-day'));
    throw new Error('invalid chart data');
  }), /invalid chart data/);
  assert.equal(canvasesInUse.size, 0);

  assert.doesNotThrow(() => lifecycle.replace(own => {
    own('utilization', createChart('utilization'));
    own('builds-per-day', createChart('builds-per-day'));
  }));
});

test('recent runs retain only the 20 newest completions', () => {
  const recentRuns = [];

  for(let number = 1; number <= 300; ++number)
    prependRecentRun(recentRuns, { number: number });

  assert.deepEqual(
    recentRuns.map(run => run.number),
    [
      300, 299, 298, 297, 296, 295, 294, 293, 292, 291,
      290, 289, 288, 287, 286, 285, 284, 283, 282, 281,
    ]
  );
});

test('recent runs are prepended without padding a short list', () => {
  const recentRuns = [{ number: 2 }, { number: 1 }];

  prependRecentRun(recentRuns, { number: 3 });

  assert.deepEqual(recentRuns, [
    { number: 3 },
    { number: 2 },
    { number: 1 },
  ]);
});
