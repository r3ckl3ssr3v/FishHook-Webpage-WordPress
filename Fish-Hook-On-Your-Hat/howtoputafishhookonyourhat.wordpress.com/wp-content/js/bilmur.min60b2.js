(function() {
    "use strict";

    function observePerformance(type, callback) {
        var observer = new PerformanceObserver(function(list) {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i++) {
                callback(entries[i]);
            }
        });
        observer.observe({ type: type, buffered: true });
        return function() {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
        };
    }

    var disconnectLayoutShiftObserver, disconnectLCPObserver, disconnectElementTimingObserver, disconnectMarkObserver, disconnectMeasureObserver;

    function cleanup() {
        disconnectLayoutShiftObserver && disconnectLayoutShiftObserver();
        disconnectLCPObserver && disconnectLCPObserver();
        disconnectElementTimingObserver && disconnectElementTimingObserver();
        disconnectMarkObserver && disconnectMarkObserver();
        disconnectMeasureObserver && disconnectMeasureObserver();
    }

    function getNestedProperty(obj, keys) {
        for (var i = 0; i < keys.length; i++) {
            if (obj === undefined) return obj;
            obj = obj[keys[i]];
        }
        return obj;
    }

    function parseCustomProperties(jsonString) {
        var result;
        if (jsonString) {
            try {
                var parsed = JSON.parse(jsonString);
                result = JSON.stringify(Object.keys(parsed).reduce(function(acc, key) {
                    if (typeof parsed[key] === 'string') acc[key] = parsed[key];
                    return acc;
                }, {}));
            } catch (e) {}
        }
        return result;
    }

    function getAttributeValue(attribute, element, defaultValue) {
        return getNestedProperty(element.t, ["dataset", attribute]) || defaultValue;
    }

    function splitString(attribute, element) {
        var value = getAttributeValue(attribute, element, "");
        return typeof value === 'string' ? value.split(",") : value;
    }

    var customMarks = {},
        customMeasures = {};

    function isPrefixMatch(name, prefixes) {
        return prefixes.some(function(prefix) {
            return name.indexOf(prefix) === 0;
        });
    }

    function customObserverCallback(element, prefixes) {
        return function(entry) {
            var name = entry.name.replace(/^\d/, "_").replace(/\W/g, "_");
            if (entry.entryType === "mark" && isPrefixMatch(name, prefixes.o)) {
                customMarks[name] = Math.round(entry.startTime) || 0;
            } else if (entry.entryType === "measure" && isPrefixMatch(name, prefixes.i)) {
                customMeasures[name] = Math.round(entry.duration) || 0;
            }
            name = element;
            if (Object.keys(customMarks).length) {
                name.custom_marks = JSON.stringify(customMarks);
            }
            if (Object.keys(customMeasures).length) {
                name.custom_measures = JSON.stringify(customMeasures);
            }
        };
    }

    function cleanupObservers() {
        disconnectMarkObserver && disconnectMarkObserver();
        disconnectMeasureObserver && disconnectMeasureObserver();
    }

    function setupObservers(element, prefixes) {
        var lcpValue = 0;

        if (window.LayoutShift) {
            try {
                disconnectLayoutShiftObserver = observePerformance("layout-shift", function(entry) {
                    lcpValue += entry.hadRecentInput ? 0 : entry.value;
                    element.cumulative_layout_shift = Math.round(1000 * lcpValue) / 1000;
                });
                element.cumulative_layout_shift = Math.round(1000 * lcpValue) / 1000;
            } catch (e) {
                cleanup();
            }
        }

        if (window.LargestContentfulPaint) {
            try {
                disconnectLCPObserver = observePerformance("largest-contentful-paint", function(entry) {
                    element.largest_contentful_paint = Math.round(entry.startTime);
                });
            } catch (e) {
                cleanup();
            }
        }

        if (window.PerformanceElementTiming) {
            try {
                var targetElement = document.querySelector("[data-bilmur-mie]");
                if (targetElement && targetElement.hasAttribute("elementtiming")) {
                    disconnectElementTimingObserver = observePerformance("element", function(entry) {
                        if (entry.element === targetElement) {
                            element.mie_renderTime = Math.round(entry.renderTime);
                            cleanup();
                        }
                    });
                }
            } catch (e) {
                cleanup();
            }
        }

        if (window.PerformanceMeasure && window.PerformanceMark) {
            prefixes.i = splitString("customMeasuresPrefixes", prefixes);
            prefixes.o = splitString("customMarksPrefixes", prefixes);
            var callback = customObserverCallback(element, prefixes);
            try {
                disconnectMarkObserver = observePerformance("mark", callback);
                disconnectMeasureObserver = observePerformance("measure", callback);
            } catch (e) {
                cleanupObservers();
            }
        }
    }

    function setCustomProperties(element, config) {
        element.provider = getAttributeValue("provider", config);
        element.service = getAttributeValue("service", config);
        element.custom_properties = parseCustomProperties(getNestedProperty(config.t, ["dataset", "customproperties"]));
    }

    function isPositive(value) {
        return value > 0 || value === 0;
    }

    function setTimingMetrics(element) {
        var timing = getNestedProperty(performance, ["timing"]) || {};
        if (timing.navigationStart) {
            var navType = performance.getEntriesByType("navigation")[0] || {};
            var apiLevel = navType.startTime === 0 ? 2 : 1;
            [
                "unloadEventStart", "unloadEventEnd", "redirectStart", "redirectEnd", "fetchStart",
                "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd", "secureConnectionStart",
                "requestStart", "responseStart", "responseEnd", "domLoading", "domInteractive",
                "domContentLoadedEventStart", "domContentLoadedEventEnd", "domComplete", "loadEventStart",
                "loadEventEnd"
            ].forEach(function(metric) {
                element["nt_" + metric] = typeof timing[metric] === 'number' &&
                    typeof timing.navigationStart === 'number' &&
                    timing[metric] > 0 && timing.navigationStart > 0 &&
                    (timing[metric] - timing.navigationStart) >= 0 ?
                    timing[metric] - timing.navigationStart : undefined;
            });
            if (apiLevel === 2 && typeof navType.secureConnectionStart === 'number' && navType.secureConnectionStart > 0) {
                element.nt_secureConnectionStart = Math.floor(navType.secureConnectionStart);
            }
            element.nt_redirectCount = navType.redirectCount;
            element.nt_nextHopProtocol = navType.nextHopProtocol;
            element.nt_api_level = apiLevel;
        }
    }

    function setResourceMetrics(element, config) {
        function updateResourceMetrics(entry, metrics) {
            metrics.u += entry.decodedBodySize || 0;
            if (entry.deliveryType === "cache" || entry.duration === 0 || (entry.encodedBodySize > 0 && entry.transferSize > 0 && entry.transferSize < entry.encodedBodySize) || !(entry.transferSize > 0) && (entry.decodedBodySize > 0 || entry.duration < 30)) {
                metrics.m += entry.decodedBodySize || 0;
            } else {
                metrics.v += entry.transferSize || 0;
            }
        }

        function setMetricValues(metrics, type) {
            element[type + "_size"] = metrics.u;
            element[type + "_transferred"] = metrics.v;
            if (metrics.u > 0) {
                element[type + "_cache_percent"] = Math.floor(metrics.m / metrics.u * 100);
            }
        }

        if (element.nt_domContentLoadedEventStart) {
            var resources = performance.getEntriesByType("resource") || [];
            var resourceMetrics = { h: "resource", v: 0, u: 0, m: 0 },
                jsMetrics = { h: "js", v: 0, u: 0, m: 0 },
                blockingMetrics = { h: "blocking", v: 0, u: 0, m: 0 };

            resources.forEach(function(resource) {
                if (resource.responseEnd < element.nt_domContentLoadedEventStart) {
                    updateResourceMetrics(resource, resourceMetrics);
                    if (resource.initiatorType === "script") {
                        updateResourceMetrics(resource, jsMetrics);
                    }
                    if (resource.renderBlockingStatus === "blocking") {
                        updateResourceMetrics(resource, blockingMetrics);
                    }
                }
            });

            setMetricValues(resourceMetrics, "resource");
            setMetricValues(jsMetrics, "js");
            setMetricValues(blockingMetrics, "blocking");

            if (config.p) {
                element.last_resource_end = Math.round(resources.reduce(function(max, resource) {
                    return Math.max(max, resource.responseEnd);
                }, 0));
            }
        }
    }

    function collectMetrics(element, config) {
        try {
            var batcacheHit = 0;
            document.createNodeIterator(document, NodeFilter.SHOW_COMMENT, {
                acceptNode: function(node) {
                    return node.nodeValue.indexOf("served from batcache in") > -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }).nextNode() && (batcacheHit = 1);
            element.batcache_hit = batcacheHit;
        } catch (e) {}

        setCustomProperties(element, config);

        var connection = getNestedProperty(navigator, ["connection"]) || {};
        element.effective_connection_type = connection.effectiveType;
        if (isPositive(connection.rtt)) element.rtt = connection.rtt;
        if (isPositive(connection.downlink)) element.downlink = Math.round(1000 * connection.downlink);

        element.host_name = getNestedProperty(location, ["hostname"]);
        element.url_path = getNestedProperty(location, ["pathname"]);

        setTimingMetrics(element);

        var paintMetrics = performance.getEntriesByType("paint") || [];
        paintMetrics.forEach(function(paint) {
            if (paint.name === "first-paint") {
                element.start_render = Math.round(paint.startTime);
            }
            if (paint.name === "first-contentful-paint") {
                element.first_contentful_paint = Math.round(paint.startTime);
            }
        });

        setResourceMetrics(element, config);
    }

    function sendMetrics(config, element) {
        var url = "https://pixel.wp.com/boom.gif?bilmur=1";
        for (var key in element) {
            if (element.hasOwnProperty(key) && element[key] !== undefined) {
                url += "&" + key + "=" + encodeURIComponent(element[key]);
            }
        }
        new Image().src = url;
    }

    var isFirstLoad = false;
    var metrics = {};

    function onDocumentReady(config) {
        if (config.l) isFirstLoad = true;
        cleanup();

        if (!isFirstLoad && document.readyState !== "loading") {
            isFirstLoad = true;
            collectMetrics(metrics, config);
            sendMetrics(config, metrics);
        }
    }

    function setupDocumentReadyListener(callback, config) {
        if (document.readyState === "complete") {
            setTimeout(callback, 2000);
        } else {
            window.addEventListener("load", function() {
                setTimeout(callback, 2000);
            });
        }
    }

    function onVisibilityChange(callback, config) {
        if (document.visibilityState === "hidden") {
            config.l = true;
            callback(config);
        } else {
            var handleVisibilityChange = function() {
                if (document.visibilityState === "hidden") {
                    document.removeEventListener("visibilitychange", handleVisibilityChange);
                    config.l = false;
                    callback(config);
                }
            };
            document.addEventListener("visibilitychange", handleVisibilityChange);
        }
    }

    if (window.performance && window.performance.getEntriesByType) {
        var sendMetricsConfig = sendMetrics;
        var config = { t: document.getElementById("bilmur") || {}, p: false };

        setupObservers(metrics, config);

        var callback = onDocumentReady.bind(null, config);

        onVisibilityChange(callback, config);
        setupDocumentReadyListener(callback, config);

        var interval = function() {
            var delay = 2000;
            var lastResourceEnd = performance.getEntriesByType("resource").reduce(function(max, resource) {
                return Math.max(max, resource.responseEnd);
            }, 0);
            var timeSinceLastResource = Math.floor(performance.now()) - Math.floor(lastResourceEnd);

            if (delay < timeSinceLastResource) {
                config.p = true;
                callback(config);
            } else {
                setTimeout(interval, Math.min(0.75 * delay, 0.25 * delay));
            }
        };

        interval();
    }
})();
