(function(global) {
  const RECENT_RUN_LIMIT = 20;

  function addSampleToMean(mean, sampleCount, sample) {
    return ((sampleCount - 1) * mean + sample) / sampleCount;
  }

  function incrementCount(counts, name) {
    const count = Object.prototype.hasOwnProperty.call(counts, name)
      ? counts[name] + 1
      : 1;
    Object.defineProperty(counts, name, {
      configurable: true,
      enumerable: true,
      value: count,
      writable: true,
    });
    return count;
  }

  function recordSampleToMean(mean, sampleCounts, name, sample) {
    return addSampleToMean(mean, incrementCount(sampleCounts, name), sample);
  }

  function prependRecentRun(recentRuns, run) {
    recentRuns.unshift(run);
    recentRuns.splice(RECENT_RUN_LIMIT);
  }

  function recordJobCompletion(completedCounts, lowPassRates, completion) {
    const completedCount = incrementCount(completedCounts, completion.name);
    const lowPassRate = lowPassRates.find(job => job.name === completion.name);
    if(lowPassRate) {
      lowPassRate.passRate = (
        (completedCount - 1) * lowPassRate.passRate +
        (completion.result === 'success' ? 1 : 0)
      ) / completedCount;
    }
    return completedCount;
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

  function createEventSourceController(options) {
    const initialReconnectDelay = options.initialReconnectDelay || 500;
    const maximumReconnectDelay = options.maximumReconnectDelay || 7500;
    const reconnectBackoffFactor = options.reconnectBackoffFactor || 1.5;
    let generation = 0;
    let reconnectDelay = initialReconnectDelay;
    let reconnectTimer = null;
    let source = null;
    let url;
    let handlers = {};

    function open(expectedGeneration) {
      if(expectedGeneration !== generation)
        return;
      const nextSource = options.createEventSource(url);
      const nextHandlers = handlers;
      source = nextSource;
      nextSource.onmessage = function(message) {
        if(source !== nextSource)
          return;
        reconnectDelay = initialReconnectDelay;
        if(typeof nextHandlers.onMessage === 'function')
          nextHandlers.onMessage(message, nextSource);
      };
      nextSource.onerror = function() {
        if(source !== nextSource)
          return;
        if(typeof nextHandlers.onError === 'function')
          nextHandlers.onError();
        source = null;
        nextSource.close();
        let scheduledTimer = null;
        scheduledTimer = options.setTimeout(function() {
          if(reconnectTimer !== scheduledTimer || expectedGeneration !== generation)
            return;
          reconnectTimer = null;
          open(expectedGeneration);
        }, reconnectDelay);
        reconnectTimer = scheduledTimer;
        reconnectDelay = Math.min(
          reconnectDelay * reconnectBackoffFactor,
          maximumReconnectDelay
        );
      };
    }

    return {
      connect: function(nextUrl, nextHandlers) {
        generation++;
        if(reconnectTimer !== null) {
          options.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if(source)
          source.close();
        url = nextUrl;
        handlers = nextHandlers || {};
        reconnectDelay = initialReconnectDelay;
        open(generation);
      },
      isCurrent: function(candidate) {
        return source === candidate;
      },
    };
  }

  const api = {
    createChartLifecycle: createChartLifecycle,
    createEventSourceController: createEventSourceController,
    incrementCount: incrementCount,
    prependRecentRun: prependRecentRun,
    recordJobCompletion: recordJobCompletion,
    recordSampleToMean: recordSampleToMean,
  };

  global.LaminarAppState = api;

  if(typeof module !== 'undefined' && module.exports)
    module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
