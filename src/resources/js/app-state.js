(function(global) {
  const RECENT_RUN_LIMIT = 20;

  function prependRecentRun(recentRuns, run) {
    recentRuns.unshift(run);
    recentRuns.splice(RECENT_RUN_LIMIT);
  }

  function createChartLifecycle() {
    let charts = {};

    function destroy() {
      Object.values(charts).forEach(chart => chart.destroy());
      charts = {};
    }

    return {
      replace: function(createCharts) {
        destroy();
        try {
          createCharts(function(name, chart) {
            charts[name] = chart;
          });
        } catch(error) {
          destroy();
          throw error;
        }
      },
      destroy: destroy,
      get: function(name) {
        return charts[name];
      },
    };
  }

  const api = {
    createChartLifecycle: createChartLifecycle,
    prependRecentRun: prependRecentRun,
  };

  global.LaminarAppState = api;

  if(typeof module !== 'undefined' && module.exports)
    module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
