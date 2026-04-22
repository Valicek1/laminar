(function(global) {
  function createLogger(logger) {
    if(logger && typeof logger.debug === 'function')
      return logger;
    return {
      debug: function() {},
    };
  }

  function readScrollHeight(source) {
    return source && typeof source.scrollHeight === 'number' ? source.scrollHeight : 0;
  }

  function writeScrollPosition(target, top) {
    if(target && typeof target.scrollTo === 'function')
      target.scrollTo(0, top);
    else if(target)
      target.scrollTop = top;
  }

  function createFallbackAutoScrollController(element) {
    return createAutoScrollController(element);
  }

  function createAutoScrollPreference(storage, key) {
    return {
      load: function(defaultValue) {
        if(!storage || typeof storage.getItem !== 'function')
          return defaultValue;
        const value = storage.getItem(key);
        if(value === 'true')
          return true;
        if(value === 'false')
          return false;
        return defaultValue;
      },
      save: function(enabled) {
        if(storage && typeof storage.setItem === 'function')
          storage.setItem(key, enabled ? 'true' : 'false');
      },
    };
  }

  function createAutoScrollController(element, options) {
    let enabled = !!(options && options.enabled);
    const scrollTarget = (options && options.scrollTarget) || element;
    const scrollHeightSource = (options && options.scrollHeightSource) || scrollTarget;
    const logger = createLogger(options && options.logger);

    function log(event, details) {
      logger.debug(event, Object.assign({
        enabled: enabled,
        elementScrollTop: element.scrollTop,
        elementScrollHeight: element.scrollHeight,
        targetScrollTop: scrollTarget.scrollTop,
        targetScrollHeight: readScrollHeight(scrollTarget),
        sourceScrollHeight: readScrollHeight(scrollHeightSource),
      }, details));
    }

    return {
      isEnabled: function() {
        return enabled;
      },
      setEnabled: function(nextEnabled) {
        enabled = !!nextEnabled;
        log('Laminar log autoscroll toggle', { nextEnabled: enabled });
        if(enabled)
          this.scrollToBottom();
        return enabled;
      },
      scrollToBottom: function() {
        const nextTop = readScrollHeight(scrollHeightSource);
        writeScrollPosition(scrollTarget, nextTop);
        log('Laminar log autoscroll scrollToBottom', { nextTop: nextTop });
      },
      onContentAppended: function() {
        log('Laminar log autoscroll update');
        if(enabled)
          this.scrollToBottom();
      },
    };
  }

  function resolveAutoScrollControllerFactory(globalObject) {
    if(
      globalObject &&
      globalObject.LaminarLogView &&
      typeof globalObject.LaminarLogView.createAutoScrollController === 'function'
    ) {
      return globalObject.LaminarLogView.createAutoScrollController;
    }

    return createFallbackAutoScrollController;
  }

  const api = {
    createAutoScrollController: createAutoScrollController,
    createAutoScrollPreference: createAutoScrollPreference,
    resolveAutoScrollControllerFactory: resolveAutoScrollControllerFactory,
  };

  global.LaminarLogView = api;

  if(typeof module !== 'undefined' && module.exports)
    module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
