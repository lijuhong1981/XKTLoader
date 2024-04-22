(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.xktloader = factory());
})(this, (function () { 'use strict';

    // Fast queue that avoids using potentially inefficient array .shift() calls
    // Based on https://github.com/creationix/fastqueue

    /** @private */
    class Queue {

        constructor() {

            this._head = [];
            this._headLength = 0;
            this._tail = [];
            this._index = 0;
            this._length = 0;
        }

        get length() {
            return this._length;
        }

        shift() {
            if (this._index >= this._headLength) {
                const t = this._head;
                t.length = 0;
                this._head = this._tail;
                this._tail = t;
                this._index = 0;
                this._headLength = this._head.length;
                if (!this._headLength) {
                    return;
                }
            }
            const value = this._head[this._index];
            if (this._index < 0) {
                delete this._head[this._index++];
            }
            else {
                this._head[this._index++] = undefined;
            }
            this._length--;
            return value;
        }

        push(item) {
            this._length++;
            this._tail.push(item);
            return this;
        };

        unshift(item) {
            this._head[--this._index] = item;
            this._length++;
            return this;
        }
    }

    /** @private */
    class Map {

        constructor(items, baseId) {
            this.items = items || [];
            this._lastUniqueId = (baseId || 0) + 1;
        }

        /**
         * Usage:
         *
         * id = myMap.addItem("foo") // ID internally generated
         * id = myMap.addItem("foo", "bar") // ID is "foo"
         */
        addItem() {
            let item;
            if (arguments.length === 2) {
                const id = arguments[0];
                item = arguments[1];
                if (this.items[id]) { // Won't happen if given ID is string
                    throw "ID clash: '" + id + "'";
                }
                this.items[id] = item;
                return id;

            } else {
                item = arguments[0] || {};
                while (true) {
                    const findId = this._lastUniqueId++;
                    if (!this.items[findId]) {
                        this.items[findId] = item;
                        return findId;
                    }
                }
            }
        }

        removeItem(id) {
            const item = this.items[id];
            delete this.items[id];
            return item;
        }
    }

    const scenesRenderInfo = {}; // Used for throttling FPS for each Scene
    const sceneIDMap = new Map(); // Ensures unique scene IDs
    const taskQueue = new Queue(); // Task queue, which is pumped on each frame; tasks are pushed to it with calls to xeokit.schedule
    const tickEvent = {sceneId: null, time: null, startTime: null, prevTime: null, deltaTime: null};
    const taskBudget = 10; // Millisecs we're allowed to spend on tasks in each frame


    /**
     * @private
     */
    function Core() {

        /**
         Semantic version number. The value for this is set by an expression that's concatenated to
         the end of the built binary by the xeokit build script.
         @property version
         @namespace xeokit
         @type {String}
         */
        this.version = "1.0.0";

        /**
         Existing {@link Scene}s , mapped to their IDs
         @property scenes
         @namespace xeokit
         @type {Scene}
         */
        this.scenes = {};

        this._superTypes = {}; // For each component type, a list of its supertypes, ordered upwards in the hierarchy.

        /**
         * Registers a scene on xeokit.
         * This is called within the xeokit.Scene constructor.
         * @private
         */
        this._addScene = function (scene) {
            if (scene.id) { // User-supplied ID
                if (core.scenes[scene.id]) {
                    console.error(`[ERROR] Scene ${utils.inQuotes(scene.id)} already exists`);
                    return;
                }
            } else { // Auto-generated ID
                scene.id = sceneIDMap.addItem({});
            }
            core.scenes[scene.id] = scene;
            const ticksPerOcclusionTest = scene.ticksPerOcclusionTest;
            const ticksPerRender = scene.ticksPerRender;
            scenesRenderInfo[scene.id] = {
                ticksPerOcclusionTest: ticksPerOcclusionTest,
                ticksPerRender: ticksPerRender,
                renderCountdown: ticksPerRender
            };
            scene.once("destroyed", () => { // Unregister destroyed scenes
                sceneIDMap.removeItem(scene.id);
                delete core.scenes[scene.id];
                delete scenesRenderInfo[scene.id];
            });
        };

        /**
         * @private
         */
        this.clear = function () {
            let scene;
            for (const id in core.scenes) {
                if (core.scenes.hasOwnProperty(id)) {
                    scene = core.scenes[id];
                    // Only clear the default Scene
                    // but destroy all the others
                    if (id === "default.scene") {
                        scene.clear();
                    } else {
                        scene.destroy();
                        delete core.scenes[scene.id];
                    }
                }
            }
        };

        /**
         * Schedule a task to run at the next frame.
         *
         * Internally, this pushes the task to a FIFO queue. Within each frame interval, xeokit processes the queue
         * for a certain period of time, popping tasks and running them. After each frame interval, tasks that did not
         * get a chance to run during the task are left in the queue to be run next time.
         *
         * @param {Function} callback Callback that runs the task.
         * @param {Object} [scope] Scope for the callback.
         */
        this.scheduleTask = function (callback, scope = null) {
            taskQueue.push(callback);
            taskQueue.push(scope);
        };

        this.runTasks = function (until = -1) { // Pops and processes tasks in the queue, until the given number of milliseconds has elapsed.
            let time = (new Date()).getTime();
            let callback;
            let scope;
            let tasksRun = 0;
            while (taskQueue.length > 0 && (until < 0 || time < until)) {
                callback = taskQueue.shift();
                scope = taskQueue.shift();
                if (scope) {
                    callback.call(scope);
                } else {
                    callback();
                }
                time = (new Date()).getTime();
                tasksRun++;
            }
            return tasksRun;
        };

        this.getNumTasks = function () {
            return taskQueue.length;
        };
    }

    /**
     * @private
     * @type {Core}
     */
    const core = new Core();

    const frame = function () {
        let time = Date.now();
        for (let id in core.scenes) {
            core.scenes[id].compile();
        }
        runTasks(time);
    };

    function customSetInterval(callback, interval) {
        let expected = Date.now() + interval;
        function loop() {
            const elapsed = Date.now() - expected;
            callback();
            expected += interval;
            setTimeout(loop, Math.max(0, interval - elapsed));
        }
        loop();
        return {
            cancel: function() {
                // No need to do anything, setTimeout cannot be directly cancelled
            }
        };
    }

    customSetInterval(() => {
        frame();
    }, 100);

    const renderFrame = function () {
        let time = Date.now();
        runTasks(time);
        fireTickEvents(time);
        renderScenes();
        (window.requestPostAnimationFrame !== undefined) ? window.requestPostAnimationFrame(frame) : requestAnimationFrame(renderFrame);
    };

    renderFrame();

    function runTasks(time) { // Process as many enqueued tasks as we can within the per-frame task budget
        core.runTasks(time + taskBudget);
        core.getNumTasks();
    }

    function fireTickEvents(time) { // Fire tick event on each Scene
        tickEvent.time = time;
        for (var id in core.scenes) {
            if (core.scenes.hasOwnProperty(id)) {
                var scene = core.scenes[id];
                tickEvent.sceneId = id;
                tickEvent.startTime = scene.startTime;
                tickEvent.deltaTime = tickEvent.prevTime != null ? tickEvent.time - tickEvent.prevTime : 0;
                /**
                 * Fired on each game loop iteration.
                 *
                 * @event tick
                 * @param {String} sceneID The ID of this Scene.
                 * @param {Number} startTime The time in seconds since 1970 that this Scene was instantiated.
                 * @param {Number} time The time in seconds since 1970 of this "tick" event.
                 * @param {Number} prevTime The time of the previous "tick" event from this Scene.
                 * @param {Number} deltaTime The time in seconds since the previous "tick" event from this Scene.
                 */
                scene.fire("tick", tickEvent, true);
            }
        }
        tickEvent.prevTime = time;
    }

    function renderScenes() {
        const scenes = core.scenes;
        const forceRender = false;
        let scene;
        let renderInfo;
        let ticksPerOcclusionTest;
        let ticksPerRender;
        let id;
        for (id in scenes) {
            if (scenes.hasOwnProperty(id)) {

                scene = scenes[id];
                renderInfo = scenesRenderInfo[id];

                if (!renderInfo) {
                    renderInfo = scenesRenderInfo[id] = {}; // FIXME
                }

                ticksPerOcclusionTest = scene.ticksPerOcclusionTest;
                if (renderInfo.ticksPerOcclusionTest !== ticksPerOcclusionTest) {
                    renderInfo.ticksPerOcclusionTest = ticksPerOcclusionTest;
                    renderInfo.renderCountdown = ticksPerOcclusionTest;
                }
                if (--scene.occlusionTestCountdown <= 0) {
                    scene.doOcclusionTest();
                    scene.occlusionTestCountdown = ticksPerOcclusionTest;
                }

                ticksPerRender = scene.ticksPerRender;
                if (renderInfo.ticksPerRender !== ticksPerRender) {
                    renderInfo.ticksPerRender = ticksPerRender;
                    renderInfo.renderCountdown = ticksPerRender;
                }
                if (--renderInfo.renderCountdown === 0) {
                    scene.render(forceRender);
                    renderInfo.renderCountdown = ticksPerRender;
                }
            }
        }
    }

    /**
     * @private
     */

    function xmlToJson(node, attributeRenamer) {
        if (node.nodeType === node.TEXT_NODE) {
            var v = node.nodeValue;
            if (v.match(/^\s+$/) === null) {
                return v;
            }
        } else if (node.nodeType === node.ELEMENT_NODE ||
            node.nodeType === node.DOCUMENT_NODE) {
            var json = {type: node.nodeName, children: []};

            if (node.nodeType === node.ELEMENT_NODE) {
                for (var j = 0; j < node.attributes.length; j++) {
                    var attribute = node.attributes[j];
                    var nm = attributeRenamer[attribute.nodeName] || attribute.nodeName;
                    json[nm] = attribute.nodeValue;
                }
            }

            for (var i = 0; i < node.childNodes.length; i++) {
                var item = node.childNodes[i];
                var j = xmlToJson(item, attributeRenamer);
                if (j) json.children.push(j);
            }

            return json;
        }
    }

    /**
     * @private
     */
    function clone(ob) {
        return JSON.parse(JSON.stringify(ob));
    }

    /**
     * @private
     */
    var guidChars = [["0", 10], ["A", 26], ["a", 26], ["_", 1], ["$", 1]].map(function (a) {
        var li = [];
        var st = a[0].charCodeAt(0);
        var en = st + a[1];
        for (var i = st; i < en; ++i) {
            li.push(i);
        }
        return String.fromCharCode.apply(null, li);
    }).join("");

    /**
     * @private
     */
    function b64(v, len) {
        var r = (!len || len === 4) ? [0, 6, 12, 18] : [0, 6];
        return r.map(function (i) {
            return guidChars.substr(parseInt(v / (1 << i)) % 64, 1)
        }).reverse().join("");
    }

    /**
     * @private
     */
    function compressGuid(g) {
        var bs = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30].map(function (i) {
            return parseInt(g.substr(i, 2), 16);
        });
        return b64(bs[0], 2) + [1, 4, 7, 10, 13].map(function (i) {
            return b64((bs[i] << 16) + (bs[i + 1] << 8) + bs[i + 2]);
        }).join("");
    }

    /**
     * @private
     */
    function findNodeOfType(m, t) {
        var li = [];
        var _ = function (n) {
            if (n.type === t) li.push(n);
            (n.children || []).forEach(function (c) {
                _(c);
            });
        };
        _(m);
        return li;
    }

    /**
     * @private
     */
    function timeout(dt) {
        return new Promise(function (resolve, reject) {
            setTimeout(resolve, dt);
        });
    }

    /**
     * @private
     */
    function httpRequest(args) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(args.method || "GET", args.url, true);
            xhr.onload = function (e) {
                if (xhr.readyState === 4) {
                    if (xhr.status === 200) {
                        resolve(xhr.responseXML);
                    } else {
                        reject(xhr.statusText);
                    }
                }
            };
            xhr.send(null);
        });
    }

    /**
     * @private
     */
    const queryString = function () {
        // This function is anonymous, is executed immediately and
        // the return value is assigned to QueryString!
        var query_string = {};
        var query = window.location.search.substring(1);
        var vars = query.split("&");
        for (var i = 0; i < vars.length; i++) {
            var pair = vars[i].split("=");
            // If first entry with this name
            if (typeof query_string[pair[0]] === "undefined") {
                query_string[pair[0]] = decodeURIComponent(pair[1]);
                // If second entry with this name
            } else if (typeof query_string[pair[0]] === "string") {
                var arr = [query_string[pair[0]], decodeURIComponent(pair[1])];
                query_string[pair[0]] = arr;
                // If third or later entry with this name
            } else {
                query_string[pair[0]].push(decodeURIComponent(pair[1]));
            }
        }
        return query_string;
    }();

    /**
     * @private
     */
    function loadJSON(url, ok, err) {
        // Avoid checking ok and err on each use.
        var defaultCallback = (_value) => undefined;
        ok = ok || defaultCallback;
        err = err || defaultCallback;

        var request = new XMLHttpRequest();
        request.overrideMimeType("application/json");
        request.open('GET', url, true);
        request.addEventListener('load', function (event) {
            var response = event.target.response;
            if (this.status === 200) {
                var json;
                try {
                    json = JSON.parse(response);
                } catch (e) {
                    err(`utils.loadJSON(): Failed to parse JSON response - ${e}`);
                }
                ok(json);
            } else if (this.status === 0) {
                // Some browsers return HTTP Status 0 when using non-http protocol
                // e.g. 'file://' or 'data://'. Handle as success.
                console.warn('loadFile: HTTP Status 0 received.');
                try {
                    ok(JSON.parse(response));
                } catch (e) {
                    err(`utils.loadJSON(): Failed to parse JSON response - ${e}`);
                }
            } else {
                err(event);
            }
        }, false);

        request.addEventListener('error', function (event) {
            err(event);
        }, false);
        request.send(null);
    }

    /**
     * @private
     */
    function loadArraybuffer(url, ok, err) {
        // Check for data: URI
        var defaultCallback = (_value) => undefined;
        ok = ok || defaultCallback;
        err = err || defaultCallback;
        const dataUriRegex = /^data:(.*?)(;base64)?,(.*)$/;
        const dataUriRegexResult = url.match(dataUriRegex);
        if (dataUriRegexResult) { // Safari can't handle data URIs through XMLHttpRequest
            const isBase64 = !!dataUriRegexResult[2];
            var data = dataUriRegexResult[3];
            data = window.decodeURIComponent(data);
            if (isBase64) {
                data = window.atob(data);
            }
            try {
                const buffer = new ArrayBuffer(data.length);
                const view = new Uint8Array(buffer);
                for (var i = 0; i < data.length; i++) {
                    view[i] = data.charCodeAt(i);
                }
                core.scheduleTask(() => {
                    ok(buffer);
                });
            } catch (error) {
                core.scheduleTask(() => {
                    err(error);
                });
            }
        } else {
            const request = new XMLHttpRequest();
            request.open('GET', url, true);
            request.responseType = 'arraybuffer';
            request.onreadystatechange = function () {
                if (request.readyState === 4) {
                    if (request.status === 200) {
                        ok(request.response);
                    } else {
                        err('loadArrayBuffer error : ' + request.response);
                    }
                }
            };
            request.send(null);
        }
    }

    /**
     Tests if the given object is an array
     @private
     */
    function isArray(value) {
        return value && !(value.propertyIsEnumerable('length')) && typeof value === 'object' && typeof value.length === 'number';
    }

    /**
     Tests if the given value is a string
     @param value
     @returns {Boolean}
     @private
     */
    function isString(value) {
        return (typeof value === 'string' || value instanceof String);
    }

    /**
     Tests if the given value is a number
     @param value
     @returns {Boolean}
     @private
     */
    function isNumeric(value) {
        return !isNaN(parseFloat(value)) && isFinite(value);
    }

    /**
     Tests if the given value is an ID
     @param value
     @returns {Boolean}
     @private
     */
    function isID(value) {
        return utils.isString(value) || utils.isNumeric(value);
    }

    /**
     Tests if the given components are the same, where the components can be either IDs or instances.
     @param c1
     @param c2
     @returns {Boolean}
     @private
     */
    function isSameComponent(c1, c2) {
        if (!c1 || !c2) {
            return false;
        }
        const id1 = (utils.isNumeric(c1) || utils.isString(c1)) ? `${c1}` : c1.id;
        const id2 = (utils.isNumeric(c2) || utils.isString(c2)) ? `${c2}` : c2.id;
        return id1 === id2;
    }

    /**
     Tests if the given value is a function
     @param value
     @returns {Boolean}
     @private
     */
    function isFunction(value) {
        return (typeof value === "function");
    }

    /**
     Tests if the given value is a JavaScript JSON object, eg, ````{ foo: "bar" }````.
     @param value
     @returns {Boolean}
     @private
     */
    function isObject(value) {
        const objectConstructor = {}.constructor;
        return (!!value && value.constructor === objectConstructor);
    }

    /** Returns a shallow copy
     */
    function copy(o) {
        return utils.apply(o, {});
    }

    /** Add properties of o to o2, overwriting them on o2 if already there
     */
    function apply(o, o2) {
        for (const name in o) {
            if (o.hasOwnProperty(name)) {
                o2[name] = o[name];
            }
        }
        return o2;
    }

    /**
     Add non-null/defined properties of o to o2
     @private
     */
    function apply2(o, o2) {
        for (const name in o) {
            if (o.hasOwnProperty(name)) {
                if (o[name] !== undefined && o[name] !== null) {
                    o2[name] = o[name];
                }
            }
        }
        return o2;
    }

    /**
     Add properties of o to o2 where undefined or null on o2
     @private
     */
    function applyIf(o, o2) {
        for (const name in o) {
            if (o.hasOwnProperty(name)) {
                if (o2[name] === undefined || o2[name] === null) {
                    o2[name] = o[name];
                }
            }
        }
        return o2;
    }

    /**
     Returns true if the given map is empty.
     @param obj
     @returns {Boolean}
     @private
     */
    function isEmptyObject(obj) {
        for (const name in obj) {
            if (obj.hasOwnProperty(name)) {
                return false;
            }
        }
        return true;
    }

    /**
     Returns the given ID as a string, in quotes if the ID was a string to begin with.

     This is useful for logging IDs.

     @param {Number| String} id The ID
     @returns {String}
     @private
     */
    function inQuotes(id) {
        return utils.isNumeric(id) ? (`${id}`) : (`'${id}'`);
    }

    /**
     Returns the concatenation of two typed arrays.
     @param a
     @param b
     @returns {*|a}
     @private
     */
    function concat(a, b) {
        const c = new a.constructor(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
    }

    function flattenParentChildHierarchy(root) {
        var list = [];

        function visit(node) {
            node.id = node.uuid;
            delete node.oid;
            list.push(node);
            var children = node.children;

            if (children) {
                for (var i = 0, len = children.length; i < len; i++) {
                    const child = children[i];
                    child.parent = node.id;
                    visit(children[i]);
                }
            }
            node.children = [];
        }

        visit(root);
        return list;
    }

    /**
     * @private
     */
    const utils = {
        xmlToJson: xmlToJson,
        clone: clone,
        compressGuid: compressGuid,
        findNodeOfType: findNodeOfType,
        timeout: timeout,
        httpRequest: httpRequest,
        loadJSON: loadJSON,
        loadArraybuffer: loadArraybuffer,
        queryString: queryString,
        isArray: isArray,
        isString: isString,
        isNumeric: isNumeric,
        isID: isID,
        isSameComponent: isSameComponent,
        isFunction: isFunction,
        isObject: isObject,
        copy: copy,
        apply: apply,
        apply2: apply2,
        applyIf: applyIf,
        isEmptyObject: isEmptyObject,
        inQuotes: inQuotes,
        concat: concat,
        flattenParentChildHierarchy: flattenParentChildHierarchy
    };

    /**
     * @desc Base class for all xeokit components.
     *
     * ## Component IDs
     *
     * Every Component has an ID that's unique within the parent {@link Scene}. xeokit generates
     * the IDs automatically by default, however you can also specify them yourself. In the example below, we're creating a
     * scene comprised of {@link Scene}, {@link Material}, {@link ReadableGeometry} and
     * {@link Mesh} components, while letting xeokit generate its own ID for
     * the {@link ReadableGeometry}:
     *
     *````JavaScript
     * import {Viewer, Mesh, buildTorusGeometry, ReadableGeometry, PhongMaterial, Texture, Fresnel} from "xeokit-sdk.es.js";
     *
     * const viewer = new Viewer({
     *        canvasId: "myCanvas"
     *    });
     *
     * viewer.scene.camera.eye = [0, 0, 5];
     * viewer.scene.camera.look = [0, 0, 0];
     * viewer.scene.camera.up = [0, 1, 0];
     *
     * new Mesh(viewer.scene, {
     *      geometry: new ReadableGeometry(viewer.scene, buildTorusGeometry({
     *          center: [0, 0, 0],
     *          radius: 1.5,
     *          tube: 0.5,
     *          radialSegments: 32,
     *          tubeSegments: 24,
     *          arc: Math.PI * 2.0
     *      }),
     *      material: new PhongMaterial(viewer.scene, {
     *          id: "myMaterial",
     *          ambient: [0.9, 0.3, 0.9],
     *          shininess: 30,
     *          diffuseMap: new Texture(viewer.scene, {
     *              src: "textures/diffuse/uvGrid2.jpg"
     *          }),
     *          specularFresnel: new Fresnel(viewer.scene, {
     *              leftColor: [1.0, 1.0, 1.0],
     *              rightColor: [0.0, 0.0, 0.0],
     *              power: 4
     *          })
     *     })
     * });
     *````
     *
     * We can then find those components like this:
     *
     * ````javascript
     * // Find the Material
     * var material = viewer.scene.components["myMaterial"];
     *
     * // Find all PhongMaterials in the Scene
     * var phongMaterials = viewer.scene.types["PhongMaterial"];
     *
     * // Find our Material within the PhongMaterials
     * var materialAgain = phongMaterials["myMaterial"];
     * ````
     *
     * ## Restriction on IDs
     *
     * Auto-generated IDs are of the form ````"__0"````, ````"__1"````, ````"__2"```` ... and so on.
     *
     * Scene maintains a map of these IDs, along with a counter that it increments each time it generates a new ID.
     *
     * If Scene has created the IDs listed above, and we then destroy the ````Component```` with ID ````"__1"````,
     * Scene will mark that ID as available, and will reuse it for the next default ID.
     *
     * Therefore, two restrictions your on IDs:
     *
     * * don't use IDs that begin with two underscores, and
     * * don't reuse auto-generated IDs of destroyed Components.
     *
     * ## Logging
     *
     * Components have methods to log ID-prefixed messages to the JavaScript console:
     *
     * ````javascript
     * material.log("Everything is fine, situation normal.");
     * material.warn("Wait, whats that red light?");
     * material.error("Aw, snap!");
     * ````
     *
     * The logged messages will look like this in the console:
     *
     * ````text
     * [LOG]   myMaterial: Everything is fine, situation normal.
     * [WARN]  myMaterial: Wait, whats that red light..
     * [ERROR] myMaterial: Aw, snap!
     * ````
     *
     * ## Destruction
     *
     * Get notification of destruction of Components:
     *
     * ````javascript
     * material.once("destroyed", function() {
     *     this.log("Component was destroyed: " + this.id);
     * });
     * ````
     *
     * Or get notification of destruction of any Component within its {@link Scene}:
     *
     * ````javascript
     * scene.on("componentDestroyed", function(component) {
     *     this.log("Component was destroyed: " + component.id);
     * });
     * ````
     *
     * Then destroy a component like this:
     *
     * ````javascript
     * material.destroy();
     * ````
     */
    class Component {

        /**
         @private
         */
        get type() {
            return "Component";
        }

        /**
         * @private
         */
        get isComponent() {
            return true;
        }

        // @reviser lijuhong 移除参数owner
        constructor(cfg = {}) {

            /**
             * The parent {@link Scene} that contains this Component.
             *
             * @property scene
             * @type {Scene}
             * @final
             */
            // @reviser lijuhong 注释scene相关代码
            // this.scene = null;

            // @reviser lijuhong 注释owner、scene相关代码
            // if (this.type === "Scene") {
            //     this.scene = this;
            //     /**
            //      * The viewer that contains this Scene.
            //      * @property viewer
            //      * @type {Viewer}
            //      */
            //     this.viewer = cfg.viewer;
            // } else {
            //     if (owner.type === "Scene") {
            //         this.scene = owner;
            //     } else if (owner instanceof Component) {
            //         this.scene = owner.scene;
            //     } else {
            //         throw "Invalid param: owner must be a Component"
            //     }
            //     this._owner = owner;
            // }

            this._dontClear = !!cfg.dontClear; // Prevent Scene#clear from destroying this component

            // @reviser lijuhong 注释scene相关代码
            // this._renderer = this.scene._renderer;

            /**
             Arbitrary, user-defined metadata on this component.

             @property metadata
             @type Object
             */
            this.meta = cfg.meta || {};


            /**
             * ID of this Component, unique within the {@link Scene}.
             *
             * Components are mapped by this ID in {@link Scene#components}.
             *
             * @property id
             * @type {String|Number}
             */
            this.id = cfg.id; // Auto-generated by Scene by default

            /**
             True as soon as this Component has been destroyed

             @property destroyed
             @type {Boolean}
             */
            this.destroyed = false;

            this._attached = {}; // Attached components with names.
            this._attachments = null; // Attached components keyed to IDs - lazy-instantiated
            this._subIdMap = null; // Subscription subId pool
            this._subIdEvents = null; // Subscription subIds mapped to event names
            this._eventSubs = null; // Event names mapped to subscribers
            this._eventSubsNum = null;
            this._events = null; // Maps names to events
            this._eventCallDepth = 0; // Helps us catch stack overflows from recursive events
            this._ownedComponents = null; // // Components created with #create - lazy-instantiated

            // @reviser lijuhong 注释scene相关代码
            // if (this !== this.scene) { // Don't add scene to itself
            //     this.scene._addComponent(this); // Assigns this component an automatic ID if not yet assigned
            // }

            this._updateScheduled = false; // True when #_update will be called on next tick

            // @reviser lijuhong 注释owner相关代码
            // if (owner) {
            //     owner._own(this);
            // }
        }

        // /**
        //  * Unique ID for this Component within its {@link Scene}.
        //  *
        //  * @property
        //  * @type {String}
        //  */
        // get id() {
        //     return this._id;
        // }

        /**
         Indicates that we need to redraw the scene.

         This is called by certain subclasses after they have made some sort of state update that requires the
         renderer to perform a redraw.

         For example: a {@link Mesh} calls this on itself whenever you update its
         {@link Mesh#layer} property, which manually controls its render order in
         relation to other Meshes.

         If this component has a ````castsShadow```` property that's set ````true````, then this will also indicate
         that the renderer needs to redraw shadow map associated with this component. Components like
         {@link DirLight} have that property set when they produce light that creates shadows, while
         components like {@link Mesh"}}layer{{/crossLink}} have that property set when they cast shadows.

         @protected
         */
        glRedraw() {
            if (!this._renderer) { // Called from a constructor
                return;
            }
            this._renderer.imageDirty();
            if (this.castsShadow) { // Light source or object
                this._renderer.shadowsDirty();
            }
        }

        /**
         Indicates that we need to re-sort the renderer's state-ordered drawables list.

         For efficiency, the renderer keeps its list of drawables ordered so that runs of the same state updates can be
         combined.  This method is called by certain subclasses after they have made some sort of state update that would
         require re-ordering of the drawables list.

         For example: a {@link DirLight} calls this on itself whenever you update {@link DirLight#dir}.

         @protected
         */
        glResort() {
            if (!this._renderer) { // Called from a constructor
                return;
            }
            this._renderer.needStateSort();
        }

        /**
         * The {@link Component} that owns the lifecycle of this Component, if any.
         *
         * When that component is destroyed, this component will be automatically destroyed also.
         *
         * Will be null if this Component has no owner.
         *
         * @property owner
         * @type {Component}
         */
        // @reviser lijuhong 注释owner相关代码
        // get owner() {
        //     return this._owner;
        // }

        /**
         * Tests if this component is of the given type, or is a subclass of the given type.
         * @type {Boolean}
         */
        isType(type) {
            return this.type === type;
        }

        /**
         * Fires an event on this component.
         *
         * Notifies existing subscribers to the event, optionally retains the event to give to
         * any subsequent notifications on the event as they are made.
         *
         * @param {String} event The event type name
         * @param {Object} value The event parameters
         * @param {Boolean} [forget=false] When true, does not retain for subsequent subscribers
         */
        fire(event, value, forget) {
            if (!this._events) {
                this._events = {};
            }
            if (!this._eventSubs) {
                this._eventSubs = {};
                this._eventSubsNum = {};
            }
            if (forget !== true) {
                this._events[event] = value || true; // Save notification
            }
            const subs = this._eventSubs[event];
            let sub;
            if (subs) { // Notify subscriptions
                for (const subId in subs) {
                    if (subs.hasOwnProperty(subId)) {
                        sub = subs[subId];
                        this._eventCallDepth++;
                        if (this._eventCallDepth < 300) {
                            sub.callback.call(sub.scope, value);
                        } else {
                            this.error("fire: potential stack overflow from recursive event '" + event + "' - dropping this event");
                        }
                        this._eventCallDepth--;
                    }
                }
            }
        }

        /**
         * Subscribes to an event on this component.
         *
         * The callback is be called with this component as scope.
         *
         * @param {String} event The event
         * @param {Function} callback Called fired on the event
         * @param {Object} [scope=this] Scope for the callback
         * @return {String} Handle to the subscription, which may be used to unsubscribe with {@link #off}.
         */
        on(event, callback, scope) {
            if (!this._events) {
                this._events = {};
            }
            if (!this._subIdMap) {
                this._subIdMap = new Map(); // Subscription subId pool
            }
            if (!this._subIdEvents) {
                this._subIdEvents = {};
            }
            if (!this._eventSubs) {
                this._eventSubs = {};
            }
            if (!this._eventSubsNum) {
                this._eventSubsNum = {};
            }
            let subs = this._eventSubs[event];
            if (!subs) {
                subs = {};
                this._eventSubs[event] = subs;
                this._eventSubsNum[event] = 1;
            } else {
                this._eventSubsNum[event]++;
            }
            const subId = this._subIdMap.addItem(); // Create unique subId
            subs[subId] = {
                callback: callback,
                scope: scope || this
            };
            this._subIdEvents[subId] = event;
            const value = this._events[event];
            if (value !== undefined) { // A publication exists, notify callback immediately
                callback.call(scope || this, value);
            }
            return subId;
        }

        /**
         * Cancels an event subscription that was previously made with {@link Component#on} or {@link Component#once}.
         *
         * @param {String} subId Subscription ID
         */
        off(subId) {
            if (subId === undefined || subId === null) {
                return;
            }
            if (!this._subIdEvents) {
                return;
            }
            const event = this._subIdEvents[subId];
            if (event) {
                delete this._subIdEvents[subId];
                const subs = this._eventSubs[event];
                if (subs) {
                    delete subs[subId];
                    this._eventSubsNum[event]--;
                }
                this._subIdMap.removeItem(subId); // Release subId
            }
        }

        /**
         * Subscribes to the next occurrence of the given event, then un-subscribes as soon as the event is subIdd.
         *
         * This is equivalent to calling {@link Component#on}, and then calling {@link Component#off} inside the callback function.
         *
         * @param {String} event Data event to listen to
         * @param {Function} callback Called when fresh data is available at the event
         * @param {Object} [scope=this] Scope for the callback
         */
        once(event, callback, scope) {
            const self = this;
            const subId = this.on(event,
                function (value) {
                    self.off(subId);
                    callback.call(scope || this, value);
                },
                scope);
        }

        /**
         * Returns true if there are any subscribers to the given event on this component.
         *
         * @param {String} event The event
         * @return {Boolean} True if there are any subscribers to the given event on this component.
         */
        hasSubs(event) {
            return (this._eventSubsNum && (this._eventSubsNum[event] > 0));
        }

        /**
         * Logs a console debugging message for this component.
         *
         * The console message will have this format: *````[LOG] [<component type> <component id>: <message>````*
         *
         * Also fires the message as a "log" event on the parent {@link Scene}.
         *
         * @param {String} message The message to log
         */
        log(message) {
            message = "[LOG]" + this._message(message);
            window.console.log(message);
            // @reviser lijuhong 注释scene相关代码
            // this.scene.fire("log", message);
        }

        _message(message) {
            return " [" + this.type + " " + utils.inQuotes(this.id) + "]: " + message;
        }

        /**
         * Logs a warning for this component to the JavaScript console.
         *
         * The console message will have this format: *````[WARN] [<component type> =<component id>: <message>````*
         *
         * Also fires the message as a "warn" event on the parent {@link Scene}.
         *
         * @param {String} message The message to log
         */
        warn(message) {
            message = "[WARN]" + this._message(message);
            window.console.warn(message);
            // @reviser lijuhong 注释scene相关代码
            // this.scene.fire("warn", message);
        }

        /**
         * Logs an error for this component to the JavaScript console.
         *
         * The console message will have this format: *````[ERROR] [<component type> =<component id>: <message>````*
         *
         * Also fires the message as an "error" event on the parent {@link Scene}.
         *
         * @param {String} message The message to log
         */
        error(message) {
            message = "[ERROR]" + this._message(message);
            window.console.error(message);
            // @reviser lijuhong 注释scene相关代码
            // this.scene.fire("error", message);
        }

        /**
         * Adds a child component to this.
         *
         * When component not given, attaches the scene's default instance for the given name (if any).
         * Publishes the new child component on this component, keyed to the given name.
         *
         * @param {*} params
         * @param {String} params.name component name
         * @param {Component} [params.component] The component
         * @param {String} [params.type] Optional expected type of base type of the child; when supplied, will
         * cause an exception if the given child is not the same type or a subtype of this.
         * @param {Boolean} [params.sceneDefault=false]
         * @param {Boolean} [params.sceneSingleton=false]
         * @param {Function} [params.onAttached] Optional callback called when component attached
         * @param {Function} [params.onAttached.callback] Callback function
         * @param {Function} [params.onAttached.scope] Optional scope for callback
         * @param {Function} [params.onDetached] Optional callback called when component is detached
         * @param {Function} [params.onDetached.callback] Callback function
         * @param {Function} [params.onDetached.scope] Optional scope for callback
         * @param {{String:Function}} [params.on] Callbacks to subscribe to properties on component
         * @param {Boolean} [params.recompiles=true] When true, fires "dirty" events on this component
         * @private
         */
        _attach(params) {

            const name = params.name;

            if (!name) {
                this.error("Component 'name' expected");
                return;
            }

            let component = params.component;
            params.sceneDefault;
            params.sceneSingleton;
            params.type;
            const on = params.on;
            const recompiles = params.recompiles !== false;

            // True when child given as config object, where parent manages its instantiation and destruction
            let managingLifecycle = false;

            // @reviser lijuhong 注释scene相关代码
            /* if (component) {

                if (utils.isNumeric(component) || utils.isString(component)) {

                    // Component ID given
                    // Both numeric and string IDs are supported

                    const id = component;

                    component = this.scene.components[id];

                    if (!component) {

                        // Quote string IDs in errors

                        this.error("Component not found: " + utils.inQuotes(id));
                        return;
                    }
                }
            }

            if (!component) {

                if (sceneSingleton === true) {

                    // Using the first instance of the component type we find

                    const instances = this.scene.types[type];
                    for (const id2 in instances) {
                        if (instances.hasOwnProperty) {
                            component = instances[id2];
                            break;
                        }
                    }

                    if (!component) {
                        this.error("Scene has no default component for '" + name + "'");
                        return null;
                    }

                } else if (sceneDefault === true) {

                    // Using a default scene component

                    component = this.scene[name];

                    if (!component) {
                        this.error("Scene has no default component for '" + name + "'");
                        return null;
                    }
                }
            }

            if (component) {

                if (component.scene.id !== this.scene.id) {
                    this.error("Not in same scene: " + component.type + " " + utils.inQuotes(component.id));
                    return;
                }

                if (type) {

                    if (!component.isType(type)) {
                        this.error("Expected a " + type + " type or subtype: " + component.type + " " + utils.inQuotes(component.id));
                        return;
                    }
                }
            } */

            if (!this._attachments) {
                this._attachments = {};
            }

            const oldComponent = this._attached[name];
            let subs;
            let i;
            let len;

            if (oldComponent) {

                if (component && oldComponent.id === component.id) {

                    // Reject attempt to reattach same component
                    return;
                }

                const oldAttachment = this._attachments[oldComponent.id];

                // Unsubscribe from events on old component

                subs = oldAttachment.subs;

                for (i = 0, len = subs.length; i < len; i++) {
                    oldComponent.off(subs[i]);
                }

                delete this._attached[name];
                delete this._attachments[oldComponent.id];

                const onDetached = oldAttachment.params.onDetached;
                if (onDetached) {
                    if (utils.isFunction(onDetached)) {
                        onDetached(oldComponent);
                    } else {
                        onDetached.scope ? onDetached.callback.call(onDetached.scope, oldComponent) : onDetached.callback(oldComponent);
                    }
                }

                if (oldAttachment.managingLifecycle) {

                    // Note that we just unsubscribed from all events fired by the child
                    // component, so destroying it won't fire events back at us now.

                    oldComponent.destroy();
                }
            }

            if (component) {

                // Set and publish the new component on this component

                const attachment = {
                    params: params,
                    component: component,
                    subs: [],
                    managingLifecycle: managingLifecycle
                };

                attachment.subs.push(
                    component.once("destroyed",
                        function () {
                            attachment.params.component = null;
                            this._attach(attachment.params);
                        },
                        this));

                if (recompiles) {
                    attachment.subs.push(
                        component.on("dirty",
                            function () {
                                this.fire("dirty", this);
                            },
                            this));
                }

                this._attached[name] = component;
                this._attachments[component.id] = attachment;

                // Bind destruct listener to new component to remove it
                // from this component when destroyed

                const onAttached = params.onAttached;
                if (onAttached) {
                    if (utils.isFunction(onAttached)) {
                        onAttached(component);
                    } else {
                        onAttached.scope ? onAttached.callback.call(onAttached.scope, component) : onAttached.callback(component);
                    }
                }

                if (on) {

                    let event;
                    let subIdr;
                    let callback;
                    let scope;

                    for (event in on) {
                        if (on.hasOwnProperty(event)) {

                            subIdr = on[event];

                            if (utils.isFunction(subIdr)) {
                                callback = subIdr;
                                scope = null;
                            } else {
                                callback = subIdr.callback;
                                scope = subIdr.scope;
                            }

                            if (!callback) {
                                continue;
                            }

                            attachment.subs.push(component.on(event, callback, scope));
                        }
                    }
                }
            }

            if (recompiles) {
                this.fire("dirty", this); // FIXME: May trigger spurous mesh recompilations unless able to limit with param?
            }

            this.fire(name, component); // Component can be null

            return component;
        }

        _checkComponent(expectedType, component) {
            // @reviser lijuhong 注释scene相关代码
            /* if (!component.isComponent) {
                if (utils.isID(component)) {
                    const id = component;
                    component = this.scene.components[id];
                    if (!component) {
                        this.error("Component not found: " + id);
                        return;
                    }
                } else {
                    this.error("Expected a Component or ID");
                    return;
                }
            } */
            if (expectedType !== component.type) {
                this.error("Expected a " + expectedType + " Component");
                return;
            }
            // @reviser lijuhong 注释scene相关代码
            /* if (component.scene.id !== this.scene.id) {
                this.error("Not in same scene: " + component.type);
                return;
            } */
            return component;
        }

        _checkComponent2(expectedTypes, component) {
            // @reviser lijuhong 注释scene相关代码
            /* if (!component.isComponent) {
                if (utils.isID(component)) {
                    const id = component;
                    component = this.scene.components[id];
                    if (!component) {
                        this.error("Component not found: " + id);
                        return;
                    }
                } else {
                    this.error("Expected a Component or ID");
                    return;
                }
            }
            if (component.scene.id !== this.scene.id) {
                this.error("Not in same scene: " + component.type);
                return;
            } */
            for (var i = 0, len = expectedTypes.length; i < len; i++) {
                if (expectedTypes[i] === component.type) {
                    return component;
                }
            }
            this.error("Expected component types: " + expectedTypes);
            return null;
        }

        _own(component) {
            if (!this._ownedComponents) {
                this._ownedComponents = {};
            }
            if (!this._ownedComponents[component.id]) {
                this._ownedComponents[component.id] = component;
            }
            component.once("destroyed", () => {
                delete this._ownedComponents[component.id];
            }, this);
        }

        /**
         * Protected method, called by sub-classes to queue a call to _update().
         * @protected
         * @param {Number} [priority=1]
         */
        _needUpdate(priority) {
            if (!this._updateScheduled) {
                this._updateScheduled = true;
                if (priority === 0) {
                    this._doUpdate();
                } else {
                    core.scheduleTask(this._doUpdate, this);
                }
            }
        }

        /**
         * @private
         */
        _doUpdate() {
            if (this._updateScheduled) {
                this._updateScheduled = false;
                if (this._update) {
                    this._update();
                }
            }
        }

        /**
         * Schedule a task to perform on the next browser interval
         * @param task
         */
        scheduleTask(task) {
            core.scheduleTask(task, null);
        }

        /**
         * Protected virtual template method, optionally implemented
         * by sub-classes to perform a scheduled task.
         *
         * @protected
         */
        _update() {
        }

        /**
         * Destroys all {@link Component}s that are owned by this. These are Components that were instantiated with
         * this Component as their first constructor argument.
         */
        clear() {
            if (this._ownedComponents) {
                for (var id in this._ownedComponents) {
                    if (this._ownedComponents.hasOwnProperty(id)) {
                        const component = this._ownedComponents[id];
                        component.destroy();
                        delete this._ownedComponents[id];
                    }
                }
            }
        }

        /**
         * Destroys this component.
         */
        destroy() {

            if (this.destroyed) {
                return;
            }

            /**
             * Fired when this Component is destroyed.
             * @event destroyed
             */
            this.fire("destroyed", this.destroyed = true); // Must fire before we blow away subscription maps, below

            // Unsubscribe from child components and destroy then

            let id;
            let attachment;
            let component;
            let subs;
            let i;
            let len;

            if (this._attachments) {
                for (id in this._attachments) {
                    if (this._attachments.hasOwnProperty(id)) {
                        attachment = this._attachments[id];
                        component = attachment.component;
                        subs = attachment.subs;
                        for (i = 0, len = subs.length; i < len; i++) {
                            component.off(subs[i]);
                        }
                        if (attachment.managingLifecycle) {
                            component.destroy();
                        }
                    }
                }
            }

            if (this._ownedComponents) {
                for (id in this._ownedComponents) {
                    if (this._ownedComponents.hasOwnProperty(id)) {
                        component = this._ownedComponents[id];
                        component.destroy();
                        delete this._ownedComponents[id];
                    }
                }
            }

            // @reviser lijuhong 注释scene相关代码
            // this.scene._removeComponent(this);

            // Memory leak avoidance
            this._attached = {};
            this._attachments = null;
            this._subIdMap = null;
            this._subIdEvents = null;
            this._eventSubs = null;
            this._events = null;
            this._eventCallDepth = 0;
            this._ownedComponents = null;
            this._updateScheduled = false;
        }
    }

    // Some temporary vars to help avoid garbage collection

    let doublePrecision = true;
    let FloatArrayType = doublePrecision ? Float64Array : Float32Array;

    const tempVec3a$2 = new FloatArrayType(3);

    const tempMat1 = new FloatArrayType(16);
    const tempMat2 = new FloatArrayType(16);
    const tempVec4 = new FloatArrayType(4);


    /**
     * @private
     */
    const math = {

        setDoublePrecisionEnabled(enable) {
            doublePrecision = enable;
            FloatArrayType = doublePrecision ? Float64Array : Float32Array;
        },

        getDoublePrecisionEnabled() {
            return doublePrecision;
        },

        MIN_DOUBLE: -Number.MAX_SAFE_INTEGER,
        MAX_DOUBLE: Number.MAX_SAFE_INTEGER,

        MAX_INT: 10000000,

        /**
         * The number of radiians in a degree (0.0174532925).
         * @property DEGTORAD
         * @type {Number}
         */
        DEGTORAD: 0.0174532925,

        /**
         * The number of degrees in a radian.
         * @property RADTODEG
         * @type {Number}
         */
        RADTODEG: 57.295779513,

        unglobalizeObjectId(modelId, globalId) {
            const idx = globalId.indexOf("#");
            return (idx === modelId.length && globalId.startsWith(modelId)) ? globalId.substring(idx + 1) : globalId;
        },

        globalizeObjectId(modelId, objectId) {
            return (modelId + "#" + objectId)
        },

        /**
         * Returns:
         * - x != 0 => 1/x,
         * - x == 1 => 1
         *
         * @param {number} x
         */
        safeInv(x) {
            const retVal = 1 / x;
            if (isNaN(retVal) || !isFinite(retVal)) {
                return 1;
            }
            return retVal;
        },

        /**
         * Returns a new, uninitialized two-element vector.
         * @method vec2
         * @param [values] Initial values.
         * @static
         * @returns {Number[]}
         */
        vec2(values) {
            return new FloatArrayType(values || 2);
        },

        /**
         * Returns a new, uninitialized three-element vector.
         * @method vec3
         * @param [values] Initial values.
         * @static
         * @returns {Number[]}
         */
        vec3(values) {
            return new FloatArrayType(values || 3);
        },

        /**
         * Returns a new, uninitialized four-element vector.
         * @method vec4
         * @param [values] Initial values.
         * @static
         * @returns {Number[]}
         */
        vec4(values) {
            return new FloatArrayType(values || 4);
        },

        /**
         * Returns a new, uninitialized 3x3 matrix.
         * @method mat3
         * @param [values] Initial values.
         * @static
         * @returns {Number[]}
         */
        mat3(values) {
            return new FloatArrayType(values || 9);
        },

        /**
         * Converts a 3x3 matrix to 4x4
         * @method mat3ToMat4
         * @param mat3 3x3 matrix.
         * @param mat4 4x4 matrix
         * @static
         * @returns {Number[]}
         */
        mat3ToMat4(mat3, mat4 = new FloatArrayType(16)) {
            mat4[0] = mat3[0];
            mat4[1] = mat3[1];
            mat4[2] = mat3[2];
            mat4[3] = 0;
            mat4[4] = mat3[3];
            mat4[5] = mat3[4];
            mat4[6] = mat3[5];
            mat4[7] = 0;
            mat4[8] = mat3[6];
            mat4[9] = mat3[7];
            mat4[10] = mat3[8];
            mat4[11] = 0;
            mat4[12] = 0;
            mat4[13] = 0;
            mat4[14] = 0;
            mat4[15] = 1;
            return mat4;
        },

        /**
         * Returns a new, uninitialized 4x4 matrix.
         * @method mat4
         * @param [values] Initial values.
         * @static
         * @returns {Number[]}
         */
        mat4(values) {
            return new FloatArrayType(values || 16);
        },

        /**
         * Converts a 4x4 matrix to 3x3
         * @method mat4ToMat3
         * @param mat4 4x4 matrix.
         * @param mat3 3x3 matrix
         * @static
         * @returns {Number[]}
         */
        mat4ToMat3(mat4, mat3) { // TODO
            //return new FloatArrayType(values || 9);
        },

        /**
         * Converts a list of double-precision values to a list of high-part floats and a list of low-part floats.
         * @param doubleVals
         * @param floatValsHigh
         * @param floatValsLow
         */
        doublesToFloats(doubleVals, floatValsHigh, floatValsLow) {
            const floatPair = new FloatArrayType(2);
            for (let i = 0, len = doubleVals.length; i < len; i++) {
                math.splitDouble(doubleVals[i], floatPair);
                floatValsHigh[i] = floatPair[0];
                floatValsLow[i] = floatPair[1];
            }
        },

        /**
         * Splits a double value into two floats.
         * @param value
         * @param floatPair
         */
        splitDouble(value, floatPair) {
            const hi = FloatArrayType.from([value])[0];
            const low = value - hi;
            floatPair[0] = hi;
            floatPair[1] = low;
        },

        /**
         * Returns a new UUID.
         * @method createUUID
         * @static
         * @return string The new UUID
         */
        createUUID: ((() => {
            const lut = [];
            for (let i = 0; i < 256; i++) {
                lut[i] = (i < 16 ? '0' : '') + (i).toString(16);
            }
            return () => {
                const d0 = Math.random() * 0xffffffff | 0;
                const d1 = Math.random() * 0xffffffff | 0;
                const d2 = Math.random() * 0xffffffff | 0;
                const d3 = Math.random() * 0xffffffff | 0;
                return `${lut[d0 & 0xff] + lut[d0 >> 8 & 0xff] + lut[d0 >> 16 & 0xff] + lut[d0 >> 24 & 0xff]}-${lut[d1 & 0xff]}${lut[d1 >> 8 & 0xff]}-${lut[d1 >> 16 & 0x0f | 0x40]}${lut[d1 >> 24 & 0xff]}-${lut[d2 & 0x3f | 0x80]}${lut[d2 >> 8 & 0xff]}-${lut[d2 >> 16 & 0xff]}${lut[d2 >> 24 & 0xff]}${lut[d3 & 0xff]}${lut[d3 >> 8 & 0xff]}${lut[d3 >> 16 & 0xff]}${lut[d3 >> 24 & 0xff]}`;
            };
        }))(),

        /**
         * Clamps a value to the given range.
         * @param {Number} value Value to clamp.
         * @param {Number} min Lower bound.
         * @param {Number} max Upper bound.
         * @returns {Number} Clamped result.
         */
        clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        },

        /**
         * Floating-point modulus
         * @method fmod
         * @static
         * @param {Number} a
         * @param {Number} b
         * @returns {*}
         */
        fmod(a, b) {
            if (a < b) {
                console.error("math.fmod : Attempting to find modulus within negative range - would be infinite loop - ignoring");
                return a;
            }
            while (b <= a) {
                a -= b;
            }
            return a;
        },

        /**
         * Returns true if the two 3-element vectors are the same.
         * @param v1
         * @param v2
         * @returns {Boolean}
         */
        compareVec3(v1, v2) {
            return (v1[0] === v2[0] && v1[1] === v2[1] && v1[2] === v2[2]);
        },

        /**
         * Negates a three-element vector.
         * @method negateVec3
         * @static
         * @param {Array(Number)} v Vector to negate
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        negateVec3(v, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = -v[0];
            dest[1] = -v[1];
            dest[2] = -v[2];
            return dest;
        },

        /**
         * Negates a four-element vector.
         * @method negateVec4
         * @static
         * @param {Array(Number)} v Vector to negate
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        negateVec4(v, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = -v[0];
            dest[1] = -v[1];
            dest[2] = -v[2];
            dest[3] = -v[3];
            return dest;
        },

        /**
         * Adds one four-element vector to another.
         * @method addVec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        addVec4(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] + v[0];
            dest[1] = u[1] + v[1];
            dest[2] = u[2] + v[2];
            dest[3] = u[3] + v[3];
            return dest;
        },

        /**
         * Adds a scalar value to each element of a four-element vector.
         * @method addVec4Scalar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        addVec4Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] + s;
            dest[1] = v[1] + s;
            dest[2] = v[2] + s;
            dest[3] = v[3] + s;
            return dest;
        },

        /**
         * Adds one three-element vector to another.
         * @method addVec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        addVec3(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] + v[0];
            dest[1] = u[1] + v[1];
            dest[2] = u[2] + v[2];
            return dest;
        },

        /**
         * Adds a scalar value to each element of a three-element vector.
         * @method addVec4Scalar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        addVec3Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] + s;
            dest[1] = v[1] + s;
            dest[2] = v[2] + s;
            return dest;
        },

        /**
         * Subtracts one four-element vector from another.
         * @method subVec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Vector to subtract
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        subVec4(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] - v[0];
            dest[1] = u[1] - v[1];
            dest[2] = u[2] - v[2];
            dest[3] = u[3] - v[3];
            return dest;
        },

        /**
         * Subtracts one three-element vector from another.
         * @method subVec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Vector to subtract
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        subVec3(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] - v[0];
            dest[1] = u[1] - v[1];
            dest[2] = u[2] - v[2];
            return dest;
        },

        /**
         * Subtracts one two-element vector from another.
         * @method subVec2
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Vector to subtract
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        subVec2(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] - v[0];
            dest[1] = u[1] - v[1];
            return dest;
        },

        /**
         * Get the geometric mean of the vectors.
         * @method geometricMeanVec2
         * @static
         * @param {...Array(Number)} vectors Vec2 to mean
         * @return {Array(Number)} The geometric mean vec2
         */
        geometricMeanVec2(...vectors) {
            const geometricMean = new FloatArrayType(vectors[0]);
            for (let i = 1; i < vectors.length; i++) {
                geometricMean[0] += vectors[i][0];
                geometricMean[1] += vectors[i][1];
            }
            geometricMean[0] /= vectors.length;
            geometricMean[1] /= vectors.length;
            return geometricMean;
        },

        /**
         * Subtracts a scalar value from each element of a four-element vector.
         * @method subVec4Scalar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        subVec4Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] - s;
            dest[1] = v[1] - s;
            dest[2] = v[2] - s;
            dest[3] = v[3] - s;
            return dest;
        },

        /**
         * Sets each element of a 4-element vector to a scalar value minus the value of that element.
         * @method subScalarVec4
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        subScalarVec4(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = s - v[0];
            dest[1] = s - v[1];
            dest[2] = s - v[2];
            dest[3] = s - v[3];
            return dest;
        },

        /**
         * Multiplies one three-element vector by another.
         * @method mulVec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        mulVec4(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] * v[0];
            dest[1] = u[1] * v[1];
            dest[2] = u[2] * v[2];
            dest[3] = u[3] * v[3];
            return dest;
        },

        /**
         * Multiplies each element of a four-element vector by a scalar.
         * @method mulVec34calar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        mulVec4Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] * s;
            dest[1] = v[1] * s;
            dest[2] = v[2] * s;
            dest[3] = v[3] * s;
            return dest;
        },

        /**
         * Multiplies each element of a three-element vector by a scalar.
         * @method mulVec3Scalar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        mulVec3Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] * s;
            dest[1] = v[1] * s;
            dest[2] = v[2] * s;
            return dest;
        },

        /**
         * Multiplies each element of a two-element vector by a scalar.
         * @method mulVec2Scalar
         * @static
         * @param {Array(Number)} v The vector
         * @param {Number} s The scalar
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, v otherwise
         */
        mulVec2Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] * s;
            dest[1] = v[1] * s;
            return dest;
        },

        /**
         * Divides one three-element vector by another.
         * @method divVec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        divVec3(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] / v[0];
            dest[1] = u[1] / v[1];
            dest[2] = u[2] / v[2];
            return dest;
        },

        /**
         * Divides one four-element vector by another.
         * @method divVec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @param  {Array(Number)} [dest] Destination vector
         * @return {Array(Number)} dest if specified, u otherwise
         */
        divVec4(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            dest[0] = u[0] / v[0];
            dest[1] = u[1] / v[1];
            dest[2] = u[2] / v[2];
            dest[3] = u[3] / v[3];
            return dest;
        },

        /**
         * Divides a scalar by a three-element vector, returning a new vector.
         * @method divScalarVec3
         * @static
         * @param v vec3
         * @param s scalar
         * @param dest vec3 - optional destination
         * @return [] dest if specified, v otherwise
         */
        divScalarVec3(s, v, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = s / v[0];
            dest[1] = s / v[1];
            dest[2] = s / v[2];
            return dest;
        },

        /**
         * Divides a three-element vector by a scalar.
         * @method divVec3Scalar
         * @static
         * @param v vec3
         * @param s scalar
         * @param dest vec3 - optional destination
         * @return [] dest if specified, v otherwise
         */
        divVec3Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] / s;
            dest[1] = v[1] / s;
            dest[2] = v[2] / s;
            return dest;
        },

        /**
         * Divides a four-element vector by a scalar.
         * @method divVec4Scalar
         * @static
         * @param v vec4
         * @param s scalar
         * @param dest vec4 - optional destination
         * @return [] dest if specified, v otherwise
         */
        divVec4Scalar(v, s, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = v[0] / s;
            dest[1] = v[1] / s;
            dest[2] = v[2] / s;
            dest[3] = v[3] / s;
            return dest;
        },


        /**
         * Divides a scalar by a four-element vector, returning a new vector.
         * @method divScalarVec4
         * @static
         * @param s scalar
         * @param v vec4
         * @param dest vec4 - optional destination
         * @return [] dest if specified, v otherwise
         */
        divScalarVec4(s, v, dest) {
            if (!dest) {
                dest = v;
            }
            dest[0] = s / v[0];
            dest[1] = s / v[1];
            dest[2] = s / v[2];
            dest[3] = s / v[3];
            return dest;
        },

        /**
         * Returns the dot product of two four-element vectors.
         * @method dotVec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @return The dot product
         */
        dotVec4(u, v) {
            return (u[0] * v[0] + u[1] * v[1] + u[2] * v[2] + u[3] * v[3]);
        },

        /**
         * Returns the cross product of two four-element vectors.
         * @method cross3Vec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @return The cross product
         */
        cross3Vec4(u, v) {
            const u0 = u[0];
            const u1 = u[1];
            const u2 = u[2];
            const v0 = v[0];
            const v1 = v[1];
            const v2 = v[2];
            return [
                u1 * v2 - u2 * v1,
                u2 * v0 - u0 * v2,
                u0 * v1 - u1 * v0,
                0.0];
        },

        /**
         * Returns the cross product of two three-element vectors.
         * @method cross3Vec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @return The cross product
         */
        cross3Vec3(u, v, dest) {
            if (!dest) {
                dest = u;
            }
            const x = u[0];
            const y = u[1];
            const z = u[2];
            const x2 = v[0];
            const y2 = v[1];
            const z2 = v[2];
            dest[0] = y * z2 - z * y2;
            dest[1] = z * x2 - x * z2;
            dest[2] = x * y2 - y * x2;
            return dest;
        },


        sqLenVec4(v) { // TODO
            return math.dotVec4(v, v);
        },

        /**
         * Returns the length of a four-element vector.
         * @method lenVec4
         * @static
         * @param {Array(Number)} v The vector
         * @return The length
         */
        lenVec4(v) {
            return Math.sqrt(math.sqLenVec4(v));
        },

        /**
         * Returns the dot product of two three-element vectors.
         * @method dotVec3
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @return The dot product
         */
        dotVec3(u, v) {
            return (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
        },

        /**
         * Returns the dot product of two two-element vectors.
         * @method dotVec4
         * @static
         * @param {Array(Number)} u First vector
         * @param {Array(Number)} v Second vector
         * @return The dot product
         */
        dotVec2(u, v) {
            return (u[0] * v[0] + u[1] * v[1]);
        },


        sqLenVec3(v) {
            return math.dotVec3(v, v);
        },


        sqLenVec2(v) {
            return math.dotVec2(v, v);
        },

        /**
         * Returns the length of a three-element vector.
         * @method lenVec3
         * @static
         * @param {Array(Number)} v The vector
         * @return The length
         */
        lenVec3(v) {
            return Math.sqrt(math.sqLenVec3(v));
        },

        distVec3: ((() => {
            const vec = new FloatArrayType(3);
            return (v, w) => math.lenVec3(math.subVec3(v, w, vec));
        }))(),

        /**
         * Returns the length of a two-element vector.
         * @method lenVec2
         * @static
         * @param {Array(Number)} v The vector
         * @return The length
         */
        lenVec2(v) {
            return Math.sqrt(math.sqLenVec2(v));
        },

        distVec2: ((() => {
            const vec = new FloatArrayType(2);
            return (v, w) => math.lenVec2(math.subVec2(v, w, vec));
        }))(),

        /**
         * @method rcpVec3
         * @static
         * @param v vec3
         * @param dest vec3 - optional destination
         * @return [] dest if specified, v otherwise
         *
         */
        rcpVec3(v, dest) {
            return math.divScalarVec3(1.0, v, dest);
        },

        /**
         * Normalizes a four-element vector
         * @method normalizeVec4
         * @static
         * @param v vec4
         * @param dest vec4 - optional destination
         * @return [] dest if specified, v otherwise
         *
         */
        normalizeVec4(v, dest) {
            const f = 1.0 / math.lenVec4(v);
            return math.mulVec4Scalar(v, f, dest);
        },

        /**
         * Normalizes a three-element vector
         * @method normalizeVec4
         * @static
         */
        normalizeVec3(v, dest) {
            const f = 1.0 / math.lenVec3(v);
            return math.mulVec3Scalar(v, f, dest);
        },

        /**
         * Normalizes a two-element vector
         * @method normalizeVec2
         * @static
         */
        normalizeVec2(v, dest) {
            const f = 1.0 / math.lenVec2(v);
            return math.mulVec2Scalar(v, f, dest);
        },

        /**
         * Gets the angle between two vectors
         * @method angleVec3
         * @param v
         * @param w
         * @returns {number}
         */
        angleVec3(v, w) {
            let theta = math.dotVec3(v, w) / (Math.sqrt(math.sqLenVec3(v) * math.sqLenVec3(w)));
            theta = theta < -1 ? -1 : (theta > 1 ? 1 : theta);  // Clamp to handle numerical problems
            return Math.acos(theta);
        },

        /**
         * Creates a three-element vector from the rotation part of a sixteen-element matrix.
         * @param m
         * @param dest
         */
        vec3FromMat4Scale: ((() => {

            const tempVec3 = new FloatArrayType(3);

            return (m, dest) => {

                tempVec3[0] = m[0];
                tempVec3[1] = m[1];
                tempVec3[2] = m[2];

                dest[0] = math.lenVec3(tempVec3);

                tempVec3[0] = m[4];
                tempVec3[1] = m[5];
                tempVec3[2] = m[6];

                dest[1] = math.lenVec3(tempVec3);

                tempVec3[0] = m[8];
                tempVec3[1] = m[9];
                tempVec3[2] = m[10];

                dest[2] = math.lenVec3(tempVec3);

                return dest;
            };
        }))(),

        /**
         * Converts an n-element vector to a JSON-serializable
         * array with values rounded to two decimal places.
         */
        vecToArray: ((() => {
            function trunc(v) {
                return Math.round(v * 100000) / 100000
            }

            return v => {
                v = Array.prototype.slice.call(v);
                for (let i = 0, len = v.length; i < len; i++) {
                    v[i] = trunc(v[i]);
                }
                return v;
            };
        }))(),

        /**
         * Converts a 3-element vector from an array to an object of the form ````{x:999, y:999, z:999}````.
         * @param arr
         * @returns {{x: *, y: *, z: *}}
         */
        xyzArrayToObject(arr) {
            return {"x": arr[0], "y": arr[1], "z": arr[2]};
        },

        /**
         * Converts a 3-element vector object of the form ````{x:999, y:999, z:999}```` to an array.
         * @param xyz
         * @param  [arry]
         * @returns {*[]}
         */
        xyzObjectToArray(xyz, arry) {
            arry = arry || math.vec3();
            arry[0] = xyz.x;
            arry[1] = xyz.y;
            arry[2] = xyz.z;
            return arry;
        },

        /**
         * Duplicates a 4x4 identity matrix.
         * @method dupMat4
         * @static
         */
        dupMat4(m) {
            return m.slice(0, 16);
        },

        /**
         * Extracts a 3x3 matrix from a 4x4 matrix.
         * @method mat4To3
         * @static
         */
        mat4To3(m) {
            return [
                m[0], m[1], m[2],
                m[4], m[5], m[6],
                m[8], m[9], m[10]
            ];
        },

        /**
         * Returns a 4x4 matrix with each element set to the given scalar value.
         * @method m4s
         * @static
         */
        m4s(s) {
            return [
                s, s, s, s,
                s, s, s, s,
                s, s, s, s,
                s, s, s, s
            ];
        },

        /**
         * Returns a 4x4 matrix with each element set to zero.
         * @method setMat4ToZeroes
         * @static
         */
        setMat4ToZeroes() {
            return math.m4s(0.0);
        },

        /**
         * Returns a 4x4 matrix with each element set to 1.0.
         * @method setMat4ToOnes
         * @static
         */
        setMat4ToOnes() {
            return math.m4s(1.0);
        },

        /**
         * Returns a 4x4 matrix with each element set to 1.0.
         * @method setMat4ToOnes
         * @static
         */
        diagonalMat4v(v) {
            return new FloatArrayType([
                v[0], 0.0, 0.0, 0.0,
                0.0, v[1], 0.0, 0.0,
                0.0, 0.0, v[2], 0.0,
                0.0, 0.0, 0.0, v[3]
            ]);
        },

        /**
         * Returns a 4x4 matrix with diagonal elements set to the given vector.
         * @method diagonalMat4c
         * @static
         */
        diagonalMat4c(x, y, z, w) {
            return math.diagonalMat4v([x, y, z, w]);
        },

        /**
         * Returns a 4x4 matrix with diagonal elements set to the given scalar.
         * @method diagonalMat4s
         * @static
         */
        diagonalMat4s(s) {
            return math.diagonalMat4c(s, s, s, s);
        },

        /**
         * Returns a 4x4 identity matrix.
         * @method identityMat4
         * @static
         */
        identityMat4(mat = new FloatArrayType(16)) {
            mat[0] = 1.0;
            mat[1] = 0.0;
            mat[2] = 0.0;
            mat[3] = 0.0;

            mat[4] = 0.0;
            mat[5] = 1.0;
            mat[6] = 0.0;
            mat[7] = 0.0;

            mat[8] = 0.0;
            mat[9] = 0.0;
            mat[10] = 1.0;
            mat[11] = 0.0;

            mat[12] = 0.0;
            mat[13] = 0.0;
            mat[14] = 0.0;
            mat[15] = 1.0;

            return mat;
        },

        /**
         * Returns a 3x3 identity matrix.
         * @method identityMat3
         * @static
         */
        identityMat3(mat = new FloatArrayType(9)) {
            mat[0] = 1.0;
            mat[1] = 0.0;
            mat[2] = 0.0;

            mat[3] = 0.0;
            mat[4] = 1.0;
            mat[5] = 0.0;

            mat[6] = 0.0;
            mat[7] = 0.0;
            mat[8] = 1.0;

            return mat;
        },

        /**
         * Tests if the given 4x4 matrix is the identity matrix.
         * @method isIdentityMat4
         * @static
         */
        isIdentityMat4(m) {
            if (m[0] !== 1.0 || m[1] !== 0.0 || m[2] !== 0.0 || m[3] !== 0.0 ||
                m[4] !== 0.0 || m[5] !== 1.0 || m[6] !== 0.0 || m[7] !== 0.0 ||
                m[8] !== 0.0 || m[9] !== 0.0 || m[10] !== 1.0 || m[11] !== 0.0 ||
                m[12] !== 0.0 || m[13] !== 0.0 || m[14] !== 0.0 || m[15] !== 1.0) {
                return false;
            }
            return true;
        },

        /**
         * Negates the given 4x4 matrix.
         * @method negateMat4
         * @static
         */
        negateMat4(m, dest) {
            if (!dest) {
                dest = m;
            }
            dest[0] = -m[0];
            dest[1] = -m[1];
            dest[2] = -m[2];
            dest[3] = -m[3];
            dest[4] = -m[4];
            dest[5] = -m[5];
            dest[6] = -m[6];
            dest[7] = -m[7];
            dest[8] = -m[8];
            dest[9] = -m[9];
            dest[10] = -m[10];
            dest[11] = -m[11];
            dest[12] = -m[12];
            dest[13] = -m[13];
            dest[14] = -m[14];
            dest[15] = -m[15];
            return dest;
        },

        /**
         * Adds the given 4x4 matrices together.
         * @method addMat4
         * @static
         */
        addMat4(a, b, dest) {
            if (!dest) {
                dest = a;
            }
            dest[0] = a[0] + b[0];
            dest[1] = a[1] + b[1];
            dest[2] = a[2] + b[2];
            dest[3] = a[3] + b[3];
            dest[4] = a[4] + b[4];
            dest[5] = a[5] + b[5];
            dest[6] = a[6] + b[6];
            dest[7] = a[7] + b[7];
            dest[8] = a[8] + b[8];
            dest[9] = a[9] + b[9];
            dest[10] = a[10] + b[10];
            dest[11] = a[11] + b[11];
            dest[12] = a[12] + b[12];
            dest[13] = a[13] + b[13];
            dest[14] = a[14] + b[14];
            dest[15] = a[15] + b[15];
            return dest;
        },

        /**
         * Adds the given scalar to each element of the given 4x4 matrix.
         * @method addMat4Scalar
         * @static
         */
        addMat4Scalar(m, s, dest) {
            if (!dest) {
                dest = m;
            }
            dest[0] = m[0] + s;
            dest[1] = m[1] + s;
            dest[2] = m[2] + s;
            dest[3] = m[3] + s;
            dest[4] = m[4] + s;
            dest[5] = m[5] + s;
            dest[6] = m[6] + s;
            dest[7] = m[7] + s;
            dest[8] = m[8] + s;
            dest[9] = m[9] + s;
            dest[10] = m[10] + s;
            dest[11] = m[11] + s;
            dest[12] = m[12] + s;
            dest[13] = m[13] + s;
            dest[14] = m[14] + s;
            dest[15] = m[15] + s;
            return dest;
        },

        /**
         * Adds the given scalar to each element of the given 4x4 matrix.
         * @method addScalarMat4
         * @static
         */
        addScalarMat4(s, m, dest) {
            return math.addMat4Scalar(m, s, dest);
        },

        /**
         * Subtracts the second 4x4 matrix from the first.
         * @method subMat4
         * @static
         */
        subMat4(a, b, dest) {
            if (!dest) {
                dest = a;
            }
            dest[0] = a[0] - b[0];
            dest[1] = a[1] - b[1];
            dest[2] = a[2] - b[2];
            dest[3] = a[3] - b[3];
            dest[4] = a[4] - b[4];
            dest[5] = a[5] - b[5];
            dest[6] = a[6] - b[6];
            dest[7] = a[7] - b[7];
            dest[8] = a[8] - b[8];
            dest[9] = a[9] - b[9];
            dest[10] = a[10] - b[10];
            dest[11] = a[11] - b[11];
            dest[12] = a[12] - b[12];
            dest[13] = a[13] - b[13];
            dest[14] = a[14] - b[14];
            dest[15] = a[15] - b[15];
            return dest;
        },

        /**
         * Subtracts the given scalar from each element of the given 4x4 matrix.
         * @method subMat4Scalar
         * @static
         */
        subMat4Scalar(m, s, dest) {
            if (!dest) {
                dest = m;
            }
            dest[0] = m[0] - s;
            dest[1] = m[1] - s;
            dest[2] = m[2] - s;
            dest[3] = m[3] - s;
            dest[4] = m[4] - s;
            dest[5] = m[5] - s;
            dest[6] = m[6] - s;
            dest[7] = m[7] - s;
            dest[8] = m[8] - s;
            dest[9] = m[9] - s;
            dest[10] = m[10] - s;
            dest[11] = m[11] - s;
            dest[12] = m[12] - s;
            dest[13] = m[13] - s;
            dest[14] = m[14] - s;
            dest[15] = m[15] - s;
            return dest;
        },

        /**
         * Subtracts the given scalar from each element of the given 4x4 matrix.
         * @method subScalarMat4
         * @static
         */
        subScalarMat4(s, m, dest) {
            if (!dest) {
                dest = m;
            }
            dest[0] = s - m[0];
            dest[1] = s - m[1];
            dest[2] = s - m[2];
            dest[3] = s - m[3];
            dest[4] = s - m[4];
            dest[5] = s - m[5];
            dest[6] = s - m[6];
            dest[7] = s - m[7];
            dest[8] = s - m[8];
            dest[9] = s - m[9];
            dest[10] = s - m[10];
            dest[11] = s - m[11];
            dest[12] = s - m[12];
            dest[13] = s - m[13];
            dest[14] = s - m[14];
            dest[15] = s - m[15];
            return dest;
        },

        /**
         * Multiplies the two given 4x4 matrix by each other.
         * @method mulMat4
         * @static
         */
        mulMat4(a, b, dest) {
            if (!dest) {
                dest = a;
            }

            // Cache the matrix values (makes for huge speed increases!)
            const a00 = a[0];

            const a01 = a[1];
            const a02 = a[2];
            const a03 = a[3];
            const a10 = a[4];
            const a11 = a[5];
            const a12 = a[6];
            const a13 = a[7];
            const a20 = a[8];
            const a21 = a[9];
            const a22 = a[10];
            const a23 = a[11];
            const a30 = a[12];
            const a31 = a[13];
            const a32 = a[14];
            const a33 = a[15];
            const b00 = b[0];
            const b01 = b[1];
            const b02 = b[2];
            const b03 = b[3];
            const b10 = b[4];
            const b11 = b[5];
            const b12 = b[6];
            const b13 = b[7];
            const b20 = b[8];
            const b21 = b[9];
            const b22 = b[10];
            const b23 = b[11];
            const b30 = b[12];
            const b31 = b[13];
            const b32 = b[14];
            const b33 = b[15];

            dest[0] = b00 * a00 + b01 * a10 + b02 * a20 + b03 * a30;
            dest[1] = b00 * a01 + b01 * a11 + b02 * a21 + b03 * a31;
            dest[2] = b00 * a02 + b01 * a12 + b02 * a22 + b03 * a32;
            dest[3] = b00 * a03 + b01 * a13 + b02 * a23 + b03 * a33;
            dest[4] = b10 * a00 + b11 * a10 + b12 * a20 + b13 * a30;
            dest[5] = b10 * a01 + b11 * a11 + b12 * a21 + b13 * a31;
            dest[6] = b10 * a02 + b11 * a12 + b12 * a22 + b13 * a32;
            dest[7] = b10 * a03 + b11 * a13 + b12 * a23 + b13 * a33;
            dest[8] = b20 * a00 + b21 * a10 + b22 * a20 + b23 * a30;
            dest[9] = b20 * a01 + b21 * a11 + b22 * a21 + b23 * a31;
            dest[10] = b20 * a02 + b21 * a12 + b22 * a22 + b23 * a32;
            dest[11] = b20 * a03 + b21 * a13 + b22 * a23 + b23 * a33;
            dest[12] = b30 * a00 + b31 * a10 + b32 * a20 + b33 * a30;
            dest[13] = b30 * a01 + b31 * a11 + b32 * a21 + b33 * a31;
            dest[14] = b30 * a02 + b31 * a12 + b32 * a22 + b33 * a32;
            dest[15] = b30 * a03 + b31 * a13 + b32 * a23 + b33 * a33;

            return dest;
        },

        /**
         * Multiplies the two given 3x3 matrices by each other.
         * @method mulMat4
         * @static
         */
        mulMat3(a, b, dest) {
            if (!dest) {
                dest = new FloatArrayType(9);
            }

            const a11 = a[0];
            const a12 = a[3];
            const a13 = a[6];
            const a21 = a[1];
            const a22 = a[4];
            const a23 = a[7];
            const a31 = a[2];
            const a32 = a[5];
            const a33 = a[8];
            const b11 = b[0];
            const b12 = b[3];
            const b13 = b[6];
            const b21 = b[1];
            const b22 = b[4];
            const b23 = b[7];
            const b31 = b[2];
            const b32 = b[5];
            const b33 = b[8];

            dest[0] = a11 * b11 + a12 * b21 + a13 * b31;
            dest[3] = a11 * b12 + a12 * b22 + a13 * b32;
            dest[6] = a11 * b13 + a12 * b23 + a13 * b33;

            dest[1] = a21 * b11 + a22 * b21 + a23 * b31;
            dest[4] = a21 * b12 + a22 * b22 + a23 * b32;
            dest[7] = a21 * b13 + a22 * b23 + a23 * b33;

            dest[2] = a31 * b11 + a32 * b21 + a33 * b31;
            dest[5] = a31 * b12 + a32 * b22 + a33 * b32;
            dest[8] = a31 * b13 + a32 * b23 + a33 * b33;

            return dest;
        },

        /**
         * Multiplies each element of the given 4x4 matrix by the given scalar.
         * @method mulMat4Scalar
         * @static
         */
        mulMat4Scalar(m, s, dest) {
            if (!dest) {
                dest = m;
            }
            dest[0] = m[0] * s;
            dest[1] = m[1] * s;
            dest[2] = m[2] * s;
            dest[3] = m[3] * s;
            dest[4] = m[4] * s;
            dest[5] = m[5] * s;
            dest[6] = m[6] * s;
            dest[7] = m[7] * s;
            dest[8] = m[8] * s;
            dest[9] = m[9] * s;
            dest[10] = m[10] * s;
            dest[11] = m[11] * s;
            dest[12] = m[12] * s;
            dest[13] = m[13] * s;
            dest[14] = m[14] * s;
            dest[15] = m[15] * s;
            return dest;
        },

        /**
         * Multiplies the given 4x4 matrix by the given four-element vector.
         * @method mulMat4v4
         * @static
         */
        mulMat4v4(m, v, dest = math.vec4()) {
            const v0 = v[0];
            const v1 = v[1];
            const v2 = v[2];
            const v3 = v[3];
            dest[0] = m[0] * v0 + m[4] * v1 + m[8] * v2 + m[12] * v3;
            dest[1] = m[1] * v0 + m[5] * v1 + m[9] * v2 + m[13] * v3;
            dest[2] = m[2] * v0 + m[6] * v1 + m[10] * v2 + m[14] * v3;
            dest[3] = m[3] * v0 + m[7] * v1 + m[11] * v2 + m[15] * v3;
            return dest;
        },

        /**
         * Transposes the given 4x4 matrix.
         * @method transposeMat4
         * @static
         */
        transposeMat4(mat, dest) {
            // If we are transposing ourselves we can skip a few steps but have to cache some values
            const m4 = mat[4];

            const m14 = mat[14];
            const m8 = mat[8];
            const m13 = mat[13];
            const m12 = mat[12];
            const m9 = mat[9];
            if (!dest || mat === dest) {
                const a01 = mat[1];
                const a02 = mat[2];
                const a03 = mat[3];
                const a12 = mat[6];
                const a13 = mat[7];
                const a23 = mat[11];
                mat[1] = m4;
                mat[2] = m8;
                mat[3] = m12;
                mat[4] = a01;
                mat[6] = m9;
                mat[7] = m13;
                mat[8] = a02;
                mat[9] = a12;
                mat[11] = m14;
                mat[12] = a03;
                mat[13] = a13;
                mat[14] = a23;
                return mat;
            }
            dest[0] = mat[0];
            dest[1] = m4;
            dest[2] = m8;
            dest[3] = m12;
            dest[4] = mat[1];
            dest[5] = mat[5];
            dest[6] = m9;
            dest[7] = m13;
            dest[8] = mat[2];
            dest[9] = mat[6];
            dest[10] = mat[10];
            dest[11] = m14;
            dest[12] = mat[3];
            dest[13] = mat[7];
            dest[14] = mat[11];
            dest[15] = mat[15];
            return dest;
        },

        /**
         * Transposes the given 3x3 matrix.
         *
         * @method transposeMat3
         * @static
         */
        transposeMat3(mat, dest) {
            if (dest === mat) {
                const a01 = mat[1];
                const a02 = mat[2];
                const a12 = mat[5];
                dest[1] = mat[3];
                dest[2] = mat[6];
                dest[3] = a01;
                dest[5] = mat[7];
                dest[6] = a02;
                dest[7] = a12;
            } else {
                dest[0] = mat[0];
                dest[1] = mat[3];
                dest[2] = mat[6];
                dest[3] = mat[1];
                dest[4] = mat[4];
                dest[5] = mat[7];
                dest[6] = mat[2];
                dest[7] = mat[5];
                dest[8] = mat[8];
            }
            return dest;
        },

        /**
         * Returns the determinant of the given 4x4 matrix.
         * @method determinantMat4
         * @static
         */
        determinantMat4(mat) {
            // Cache the matrix values (makes for huge speed increases!)
            const a00 = mat[0];

            const a01 = mat[1];
            const a02 = mat[2];
            const a03 = mat[3];
            const a10 = mat[4];
            const a11 = mat[5];
            const a12 = mat[6];
            const a13 = mat[7];
            const a20 = mat[8];
            const a21 = mat[9];
            const a22 = mat[10];
            const a23 = mat[11];
            const a30 = mat[12];
            const a31 = mat[13];
            const a32 = mat[14];
            const a33 = mat[15];
            return a30 * a21 * a12 * a03 - a20 * a31 * a12 * a03 - a30 * a11 * a22 * a03 + a10 * a31 * a22 * a03 +
                a20 * a11 * a32 * a03 - a10 * a21 * a32 * a03 - a30 * a21 * a02 * a13 + a20 * a31 * a02 * a13 +
                a30 * a01 * a22 * a13 - a00 * a31 * a22 * a13 - a20 * a01 * a32 * a13 + a00 * a21 * a32 * a13 +
                a30 * a11 * a02 * a23 - a10 * a31 * a02 * a23 - a30 * a01 * a12 * a23 + a00 * a31 * a12 * a23 +
                a10 * a01 * a32 * a23 - a00 * a11 * a32 * a23 - a20 * a11 * a02 * a33 + a10 * a21 * a02 * a33 +
                a20 * a01 * a12 * a33 - a00 * a21 * a12 * a33 - a10 * a01 * a22 * a33 + a00 * a11 * a22 * a33;
        },

        /**
         * Returns the inverse of the given 4x4 matrix.
         * @method inverseMat4
         * @static
         */
        inverseMat4(mat, dest) {
            if (!dest) {
                dest = mat;
            }

            // Cache the matrix values (makes for huge speed increases!)
            const a00 = mat[0];

            const a01 = mat[1];
            const a02 = mat[2];
            const a03 = mat[3];
            const a10 = mat[4];
            const a11 = mat[5];
            const a12 = mat[6];
            const a13 = mat[7];
            const a20 = mat[8];
            const a21 = mat[9];
            const a22 = mat[10];
            const a23 = mat[11];
            const a30 = mat[12];
            const a31 = mat[13];
            const a32 = mat[14];
            const a33 = mat[15];
            const b00 = a00 * a11 - a01 * a10;
            const b01 = a00 * a12 - a02 * a10;
            const b02 = a00 * a13 - a03 * a10;
            const b03 = a01 * a12 - a02 * a11;
            const b04 = a01 * a13 - a03 * a11;
            const b05 = a02 * a13 - a03 * a12;
            const b06 = a20 * a31 - a21 * a30;
            const b07 = a20 * a32 - a22 * a30;
            const b08 = a20 * a33 - a23 * a30;
            const b09 = a21 * a32 - a22 * a31;
            const b10 = a21 * a33 - a23 * a31;
            const b11 = a22 * a33 - a23 * a32;

            // Calculate the determinant (inlined to avoid double-caching)
            const invDet = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);

            dest[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
            dest[1] = (-a01 * b11 + a02 * b10 - a03 * b09) * invDet;
            dest[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
            dest[3] = (-a21 * b05 + a22 * b04 - a23 * b03) * invDet;
            dest[4] = (-a10 * b11 + a12 * b08 - a13 * b07) * invDet;
            dest[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
            dest[6] = (-a30 * b05 + a32 * b02 - a33 * b01) * invDet;
            dest[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
            dest[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
            dest[9] = (-a00 * b10 + a01 * b08 - a03 * b06) * invDet;
            dest[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
            dest[11] = (-a20 * b04 + a21 * b02 - a23 * b00) * invDet;
            dest[12] = (-a10 * b09 + a11 * b07 - a12 * b06) * invDet;
            dest[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
            dest[14] = (-a30 * b03 + a31 * b01 - a32 * b00) * invDet;
            dest[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;

            return dest;
        },

        /**
         * Returns the trace of the given 4x4 matrix.
         * @method traceMat4
         * @static
         */
        traceMat4(m) {
            return (m[0] + m[5] + m[10] + m[15]);
        },

        /**
         * Returns 4x4 translation matrix.
         * @method translationMat4
         * @static
         */
        translationMat4v(v, dest) {
            const m = dest || math.identityMat4();
            m[12] = v[0];
            m[13] = v[1];
            m[14] = v[2];
            return m;
        },

        /**
         * Returns 3x3 translation matrix.
         * @method translationMat3
         * @static
         */
        translationMat3v(v, dest) {
            const m = dest || math.identityMat3();
            m[6] = v[0];
            m[7] = v[1];
            return m;
        },

        /**
         * Returns 4x4 translation matrix.
         * @method translationMat4c
         * @static
         */
        translationMat4c: ((() => {
            const xyz = new FloatArrayType(3);
            return (x, y, z, dest) => {
                xyz[0] = x;
                xyz[1] = y;
                xyz[2] = z;
                return math.translationMat4v(xyz, dest);
            };
        }))(),

        /**
         * Returns 4x4 translation matrix.
         * @method translationMat4s
         * @static
         */
        translationMat4s(s, dest) {
            return math.translationMat4c(s, s, s, dest);
        },

        /**
         * Efficiently post-concatenates a translation to the given matrix.
         * @param v
         * @param m
         */
        translateMat4v(xyz, m) {
            return math.translateMat4c(xyz[0], xyz[1], xyz[2], m);
        },

        /**
         * Efficiently post-concatenates a translation to the given matrix.
         * @param x
         * @param y
         * @param z
         * @param m
         */

        translateMat4c(x, y, z, m) {

            const m3 = m[3];
            m[0] += m3 * x;
            m[1] += m3 * y;
            m[2] += m3 * z;

            const m7 = m[7];
            m[4] += m7 * x;
            m[5] += m7 * y;
            m[6] += m7 * z;

            const m11 = m[11];
            m[8] += m11 * x;
            m[9] += m11 * y;
            m[10] += m11 * z;

            const m15 = m[15];
            m[12] += m15 * x;
            m[13] += m15 * y;
            m[14] += m15 * z;

            return m;
        },

        /**
         * Creates a new matrix that replaces the translation in the rightmost column of the given
         * affine matrix with the given translation.
         * @param m
         * @param translation
         * @param dest
         * @returns {*}
         */
        setMat4Translation(m, translation, dest) {

            dest[0] = m[0];
            dest[1] = m[1];
            dest[2] = m[2];
            dest[3] = m[3];

            dest[4] = m[4];
            dest[5] = m[5];
            dest[6] = m[6];
            dest[7] = m[7];

            dest[8] = m[8];
            dest[9] = m[9];
            dest[10] = m[10];
            dest[11] = m[11];

            dest[12] = translation[0];
            dest[13] = translation[1];
            dest[14] = translation[2];
            dest[15] = m[15];

            return dest;
        },

        /**
         * Returns 4x4 rotation matrix.
         * @method rotationMat4v
         * @static
         */
        rotationMat4v(anglerad, axis, m) {
            const ax = math.normalizeVec4([axis[0], axis[1], axis[2], 0.0], []);
            const s = Math.sin(anglerad);
            const c = Math.cos(anglerad);
            const q = 1.0 - c;

            const x = ax[0];
            const y = ax[1];
            const z = ax[2];

            let xy;
            let yz;
            let zx;
            let xs;
            let ys;
            let zs;

            //xx = x * x; used once
            //yy = y * y; used once
            //zz = z * z; used once
            xy = x * y;
            yz = y * z;
            zx = z * x;
            xs = x * s;
            ys = y * s;
            zs = z * s;

            m = m || math.mat4();

            m[0] = (q * x * x) + c;
            m[1] = (q * xy) + zs;
            m[2] = (q * zx) - ys;
            m[3] = 0.0;

            m[4] = (q * xy) - zs;
            m[5] = (q * y * y) + c;
            m[6] = (q * yz) + xs;
            m[7] = 0.0;

            m[8] = (q * zx) + ys;
            m[9] = (q * yz) - xs;
            m[10] = (q * z * z) + c;
            m[11] = 0.0;

            m[12] = 0.0;
            m[13] = 0.0;
            m[14] = 0.0;
            m[15] = 1.0;

            return m;
        },

        /**
         * Returns 4x4 rotation matrix.
         * @method rotationMat4c
         * @static
         */
        rotationMat4c(anglerad, x, y, z, mat) {
            return math.rotationMat4v(anglerad, [x, y, z], mat);
        },

        /**
         * Returns 4x4 scale matrix.
         * @method scalingMat4v
         * @static
         */
        scalingMat4v(v, m = math.identityMat4()) {
            m[0] = v[0];
            m[5] = v[1];
            m[10] = v[2];
            return m;
        },

        /**
         * Returns 3x3 scale matrix.
         * @method scalingMat3v
         * @static
         */
        scalingMat3v(v, m = math.identityMat3()) {
            m[0] = v[0];
            m[4] = v[1];
            return m;
        },

        /**
         * Returns 4x4 scale matrix.
         * @method scalingMat4c
         * @static
         */
        scalingMat4c: ((() => {
            const xyz = new FloatArrayType(3);
            return (x, y, z, dest) => {
                xyz[0] = x;
                xyz[1] = y;
                xyz[2] = z;
                return math.scalingMat4v(xyz, dest);
            };
        }))(),

        /**
         * Efficiently post-concatenates a scaling to the given matrix.
         * @method scaleMat4c
         * @param x
         * @param y
         * @param z
         * @param m
         */
        scaleMat4c(x, y, z, m) {

            m[0] *= x;
            m[4] *= y;
            m[8] *= z;

            m[1] *= x;
            m[5] *= y;
            m[9] *= z;

            m[2] *= x;
            m[6] *= y;
            m[10] *= z;

            m[3] *= x;
            m[7] *= y;
            m[11] *= z;
            return m;
        },

        /**
         * Efficiently post-concatenates a scaling to the given matrix.
         * @method scaleMat4c
         * @param xyz
         * @param m
         */
        scaleMat4v(xyz, m) {

            const x = xyz[0];
            const y = xyz[1];
            const z = xyz[2];

            m[0] *= x;
            m[4] *= y;
            m[8] *= z;
            m[1] *= x;
            m[5] *= y;
            m[9] *= z;
            m[2] *= x;
            m[6] *= y;
            m[10] *= z;
            m[3] *= x;
            m[7] *= y;
            m[11] *= z;

            return m;
        },

        /**
         * Returns 4x4 scale matrix.
         * @method scalingMat4s
         * @static
         */
        scalingMat4s(s) {
            return math.scalingMat4c(s, s, s);
        },

        /**
         * Creates a matrix from a quaternion rotation and vector translation
         *
         * @param {Number[]} q Rotation quaternion
         * @param {Number[]} v Translation vector
         * @param {Number[]} dest Destination matrix
         * @returns {Number[]} dest
         */
        rotationTranslationMat4(q, v, dest = math.mat4()) {
            const x = q[0];
            const y = q[1];
            const z = q[2];
            const w = q[3];

            const x2 = x + x;
            const y2 = y + y;
            const z2 = z + z;
            const xx = x * x2;
            const xy = x * y2;
            const xz = x * z2;
            const yy = y * y2;
            const yz = y * z2;
            const zz = z * z2;
            const wx = w * x2;
            const wy = w * y2;
            const wz = w * z2;

            dest[0] = 1 - (yy + zz);
            dest[1] = xy + wz;
            dest[2] = xz - wy;
            dest[3] = 0;
            dest[4] = xy - wz;
            dest[5] = 1 - (xx + zz);
            dest[6] = yz + wx;
            dest[7] = 0;
            dest[8] = xz + wy;
            dest[9] = yz - wx;
            dest[10] = 1 - (xx + yy);
            dest[11] = 0;
            dest[12] = v[0];
            dest[13] = v[1];
            dest[14] = v[2];
            dest[15] = 1;

            return dest;
        },

        /**
         * Gets Euler angles from a 4x4 matrix.
         *
         * @param {Number[]} mat The 4x4 matrix.
         * @param {String} order Desired Euler angle order: "XYZ", "YXZ", "ZXY" etc.
         * @param {Number[]} [dest] Destination Euler angles, created by default.
         * @returns {Number[]} The Euler angles.
         */
        mat4ToEuler(mat, order, dest = math.vec4()) {
            const clamp = math.clamp;

            // Assumes the upper 3x3 of m is a pure rotation matrix (i.e, unscaled)

            const m11 = mat[0];

            const m12 = mat[4];
            const m13 = mat[8];
            const m21 = mat[1];
            const m22 = mat[5];
            const m23 = mat[9];
            const m31 = mat[2];
            const m32 = mat[6];
            const m33 = mat[10];

            if (order === 'XYZ') {

                dest[1] = Math.asin(clamp(m13, -1, 1));

                if (Math.abs(m13) < 0.99999) {
                    dest[0] = Math.atan2(-m23, m33);
                    dest[2] = Math.atan2(-m12, m11);
                } else {
                    dest[0] = Math.atan2(m32, m22);
                    dest[2] = 0;

                }

            } else if (order === 'YXZ') {

                dest[0] = Math.asin(-clamp(m23, -1, 1));

                if (Math.abs(m23) < 0.99999) {
                    dest[1] = Math.atan2(m13, m33);
                    dest[2] = Math.atan2(m21, m22);
                } else {
                    dest[1] = Math.atan2(-m31, m11);
                    dest[2] = 0;
                }

            } else if (order === 'ZXY') {

                dest[0] = Math.asin(clamp(m32, -1, 1));

                if (Math.abs(m32) < 0.99999) {
                    dest[1] = Math.atan2(-m31, m33);
                    dest[2] = Math.atan2(-m12, m22);
                } else {
                    dest[1] = 0;
                    dest[2] = Math.atan2(m21, m11);
                }

            } else if (order === 'ZYX') {

                dest[1] = Math.asin(-clamp(m31, -1, 1));

                if (Math.abs(m31) < 0.99999) {
                    dest[0] = Math.atan2(m32, m33);
                    dest[2] = Math.atan2(m21, m11);
                } else {
                    dest[0] = 0;
                    dest[2] = Math.atan2(-m12, m22);
                }

            } else if (order === 'YZX') {

                dest[2] = Math.asin(clamp(m21, -1, 1));

                if (Math.abs(m21) < 0.99999) {
                    dest[0] = Math.atan2(-m23, m22);
                    dest[1] = Math.atan2(-m31, m11);
                } else {
                    dest[0] = 0;
                    dest[1] = Math.atan2(m13, m33);
                }

            } else if (order === 'XZY') {

                dest[2] = Math.asin(-clamp(m12, -1, 1));

                if (Math.abs(m12) < 0.99999) {
                    dest[0] = Math.atan2(m32, m22);
                    dest[1] = Math.atan2(m13, m11);
                } else {
                    dest[0] = Math.atan2(-m23, m33);
                    dest[1] = 0;
                }
            }

            return dest;
        },

        composeMat4(position, quaternion, scale, mat = math.mat4()) {
            math.quaternionToRotationMat4(quaternion, mat);
            math.scaleMat4v(scale, mat);
            math.translateMat4v(position, mat);

            return mat;
        },

        decomposeMat4: (() => {

            const vec = new FloatArrayType(3);
            const matrix = new FloatArrayType(16);

            return function decompose(mat, position, quaternion, scale) {

                vec[0] = mat[0];
                vec[1] = mat[1];
                vec[2] = mat[2];

                let sx = math.lenVec3(vec);

                vec[0] = mat[4];
                vec[1] = mat[5];
                vec[2] = mat[6];

                const sy = math.lenVec3(vec);

                vec[8] = mat[8];
                vec[9] = mat[9];
                vec[10] = mat[10];

                const sz = math.lenVec3(vec);

                // if determine is negative, we need to invert one scale
                const det = math.determinantMat4(mat);

                if (det < 0) {
                    sx = -sx;
                }

                position[0] = mat[12];
                position[1] = mat[13];
                position[2] = mat[14];

                // scale the rotation part
                matrix.set(mat);

                const invSX = 1 / sx;
                const invSY = 1 / sy;
                const invSZ = 1 / sz;

                matrix[0] *= invSX;
                matrix[1] *= invSX;
                matrix[2] *= invSX;

                matrix[4] *= invSY;
                matrix[5] *= invSY;
                matrix[6] *= invSY;

                matrix[8] *= invSZ;
                matrix[9] *= invSZ;
                matrix[10] *= invSZ;

                math.mat4ToQuaternion(matrix, quaternion);

                scale[0] = sx;
                scale[1] = sy;
                scale[2] = sz;

                return this;

            };

        })(),

        /** @private */
        getColMat4(mat, c) {
            const i = c * 4;
            return [mat[i], mat[i + 1], mat[i + 2], mat[i + 3]];
        },

        /** @private */
        setRowMat4(mat, r, v) {
            mat[r] = v[0];
            mat[r + 4] = v[1];
            mat[r + 8] = v[2];
            mat[r + 12] = v[3];
        },

        /**
         * Returns a 4x4 'lookat' viewing transform matrix.
         * @method lookAtMat4v
         * @param pos vec3 position of the viewer
         * @param target vec3 point the viewer is looking at
         * @param up vec3 pointing "up"
         * @param dest mat4 Optional, mat4 matrix will be written into
         *
         * @return {mat4} dest if specified, a new mat4 otherwise
         */
        lookAtMat4v(pos, target, up, dest) {
            if (!dest) {
                dest = math.mat4();
            }

            const posx = pos[0];
            const posy = pos[1];
            const posz = pos[2];
            const upx = up[0];
            const upy = up[1];
            const upz = up[2];
            const targetx = target[0];
            const targety = target[1];
            const targetz = target[2];

            if (posx === targetx && posy === targety && posz === targetz) {
                return math.identityMat4();
            }

            let z0;
            let z1;
            let z2;
            let x0;
            let x1;
            let x2;
            let y0;
            let y1;
            let y2;
            let len;

            //vec3.direction(eye, center, z);
            z0 = posx - targetx;
            z1 = posy - targety;
            z2 = posz - targetz;

            // normalize (no check needed for 0 because of early return)
            len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
            z0 *= len;
            z1 *= len;
            z2 *= len;

            //vec3.normalize(vec3.cross(up, z, x));
            x0 = upy * z2 - upz * z1;
            x1 = upz * z0 - upx * z2;
            x2 = upx * z1 - upy * z0;
            len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
            if (!len) {
                x0 = 0;
                x1 = 0;
                x2 = 0;
            } else {
                len = 1 / len;
                x0 *= len;
                x1 *= len;
                x2 *= len;
            }

            //vec3.normalize(vec3.cross(z, x, y));
            y0 = z1 * x2 - z2 * x1;
            y1 = z2 * x0 - z0 * x2;
            y2 = z0 * x1 - z1 * x0;

            len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
            if (!len) {
                y0 = 0;
                y1 = 0;
                y2 = 0;
            } else {
                len = 1 / len;
                y0 *= len;
                y1 *= len;
                y2 *= len;
            }

            dest[0] = x0;
            dest[1] = y0;
            dest[2] = z0;
            dest[3] = 0;
            dest[4] = x1;
            dest[5] = y1;
            dest[6] = z1;
            dest[7] = 0;
            dest[8] = x2;
            dest[9] = y2;
            dest[10] = z2;
            dest[11] = 0;
            dest[12] = -(x0 * posx + x1 * posy + x2 * posz);
            dest[13] = -(y0 * posx + y1 * posy + y2 * posz);
            dest[14] = -(z0 * posx + z1 * posy + z2 * posz);
            dest[15] = 1;

            return dest;
        },

        /**
         * Returns a 4x4 'lookat' viewing transform matrix.
         * @method lookAtMat4c
         * @static
         */
        lookAtMat4c(posx, posy, posz, targetx, targety, targetz, upx, upy, upz) {
            return math.lookAtMat4v([posx, posy, posz], [targetx, targety, targetz], [upx, upy, upz], []);
        },

        /**
         * Returns a 4x4 orthographic projection matrix.
         * @method orthoMat4c
         * @static
         */
        orthoMat4c(left, right, bottom, top, near, far, dest) {
            if (!dest) {
                dest = math.mat4();
            }
            const rl = (right - left);
            const tb = (top - bottom);
            const fn = (far - near);

            dest[0] = 2.0 / rl;
            dest[1] = 0.0;
            dest[2] = 0.0;
            dest[3] = 0.0;

            dest[4] = 0.0;
            dest[5] = 2.0 / tb;
            dest[6] = 0.0;
            dest[7] = 0.0;

            dest[8] = 0.0;
            dest[9] = 0.0;
            dest[10] = -2.0 / fn;
            dest[11] = 0.0;

            dest[12] = -(left + right) / rl;
            dest[13] = -(top + bottom) / tb;
            dest[14] = -(far + near) / fn;
            dest[15] = 1.0;

            return dest;
        },

        /**
         * Returns a 4x4 perspective projection matrix.
         * @method frustumMat4v
         * @static
         */
        frustumMat4v(fmin, fmax, m) {
            if (!m) {
                m = math.mat4();
            }

            const fmin4 = [fmin[0], fmin[1], fmin[2], 0.0];
            const fmax4 = [fmax[0], fmax[1], fmax[2], 0.0];

            math.addVec4(fmax4, fmin4, tempMat1);
            math.subVec4(fmax4, fmin4, tempMat2);

            const t = 2.0 * fmin4[2];

            const tempMat20 = tempMat2[0];
            const tempMat21 = tempMat2[1];
            const tempMat22 = tempMat2[2];

            m[0] = t / tempMat20;
            m[1] = 0.0;
            m[2] = 0.0;
            m[3] = 0.0;

            m[4] = 0.0;
            m[5] = t / tempMat21;
            m[6] = 0.0;
            m[7] = 0.0;

            m[8] = tempMat1[0] / tempMat20;
            m[9] = tempMat1[1] / tempMat21;
            m[10] = -tempMat1[2] / tempMat22;
            m[11] = -1.0;

            m[12] = 0.0;
            m[13] = 0.0;
            m[14] = -t * fmax4[2] / tempMat22;
            m[15] = 0.0;

            return m;
        },

        /**
         * Returns a 4x4 perspective projection matrix.
         * @method frustumMat4v
         * @static
         */
        frustumMat4(left, right, bottom, top, near, far, dest) {
            if (!dest) {
                dest = math.mat4();
            }
            const rl = (right - left);
            const tb = (top - bottom);
            const fn = (far - near);
            dest[0] = (near * 2) / rl;
            dest[1] = 0;
            dest[2] = 0;
            dest[3] = 0;
            dest[4] = 0;
            dest[5] = (near * 2) / tb;
            dest[6] = 0;
            dest[7] = 0;
            dest[8] = (right + left) / rl;
            dest[9] = (top + bottom) / tb;
            dest[10] = -(far + near) / fn;
            dest[11] = -1;
            dest[12] = 0;
            dest[13] = 0;
            dest[14] = -(far * near * 2) / fn;
            dest[15] = 0;
            return dest;
        },

        /**
         * Returns a 4x4 perspective projection matrix.
         * @method perspectiveMat4v
         * @static
         */
        perspectiveMat4(fovyrad, aspectratio, znear, zfar, m) {
            const pmin = [];
            const pmax = [];

            pmin[2] = znear;
            pmax[2] = zfar;

            pmax[1] = pmin[2] * Math.tan(fovyrad / 2.0);
            pmin[1] = -pmax[1];

            pmax[0] = pmax[1] * aspectratio;
            pmin[0] = -pmax[0];

            return math.frustumMat4v(pmin, pmax, m);
        },

        /**
         * Returns true if the two 4x4 matrices are the same.
         * @param m1
         * @param m2
         * @returns {Boolean}
         */
        compareMat4(m1, m2) {
            return m1[0] === m2[0] &&
                m1[1] === m2[1] &&
                m1[2] === m2[2] &&
                m1[3] === m2[3] &&
                m1[4] === m2[4] &&
                m1[5] === m2[5] &&
                m1[6] === m2[6] &&
                m1[7] === m2[7] &&
                m1[8] === m2[8] &&
                m1[9] === m2[9] &&
                m1[10] === m2[10] &&
                m1[11] === m2[11] &&
                m1[12] === m2[12] &&
                m1[13] === m2[13] &&
                m1[14] === m2[14] &&
                m1[15] === m2[15];
        },

        /**
         * Transforms a three-element position by a 4x4 matrix.
         * @method transformPoint3
         * @static
         */
        transformPoint3(m, p, dest = math.vec3()) {

            const x = p[0];
            const y = p[1];
            const z = p[2];

            dest[0] = (m[0] * x) + (m[4] * y) + (m[8] * z) + m[12];
            dest[1] = (m[1] * x) + (m[5] * y) + (m[9] * z) + m[13];
            dest[2] = (m[2] * x) + (m[6] * y) + (m[10] * z) + m[14];

            return dest;
        },

        /**
         * Transforms a homogeneous coordinate by a 4x4 matrix.
         * @method transformPoint3
         * @static
         */
        transformPoint4(m, v, dest = math.vec4()) {
            dest[0] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3];
            dest[1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3];
            dest[2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3];
            dest[3] = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3];

            return dest;
        },


        /**
         * Transforms an array of three-element positions by a 4x4 matrix.
         * @method transformPoints3
         * @static
         */
        transformPoints3(m, points, points2) {
            const result = points2 || [];
            const len = points.length;
            let p0;
            let p1;
            let p2;
            let pi;

            // cache values
            const m0 = m[0];

            const m1 = m[1];
            const m2 = m[2];
            const m3 = m[3];
            const m4 = m[4];
            const m5 = m[5];
            const m6 = m[6];
            const m7 = m[7];
            const m8 = m[8];
            const m9 = m[9];
            const m10 = m[10];
            const m11 = m[11];
            const m12 = m[12];
            const m13 = m[13];
            const m14 = m[14];
            const m15 = m[15];

            let r;

            for (let i = 0; i < len; ++i) {

                // cache values
                pi = points[i];

                p0 = pi[0];
                p1 = pi[1];
                p2 = pi[2];

                r = result[i] || (result[i] = [0, 0, 0]);

                r[0] = (m0 * p0) + (m4 * p1) + (m8 * p2) + m12;
                r[1] = (m1 * p0) + (m5 * p1) + (m9 * p2) + m13;
                r[2] = (m2 * p0) + (m6 * p1) + (m10 * p2) + m14;
                r[3] = (m3 * p0) + (m7 * p1) + (m11 * p2) + m15;
            }

            result.length = len;

            return result;
        },

        /**
         * Transforms an array of positions by a 4x4 matrix.
         * @method transformPositions3
         * @static
         */
        transformPositions3(m, p, p2 = p) {
            let i;
            const len = p.length;

            let x;
            let y;
            let z;

            const m0 = m[0];
            const m1 = m[1];
            const m2 = m[2];
            m[3];
            const m4 = m[4];
            const m5 = m[5];
            const m6 = m[6];
            m[7];
            const m8 = m[8];
            const m9 = m[9];
            const m10 = m[10];
            m[11];
            const m12 = m[12];
            const m13 = m[13];
            const m14 = m[14];
            m[15];

            for (i = 0; i < len; i += 3) {

                x = p[i + 0];
                y = p[i + 1];
                z = p[i + 2];

                p2[i + 0] = (m0 * x) + (m4 * y) + (m8 * z) + m12;
                p2[i + 1] = (m1 * x) + (m5 * y) + (m9 * z) + m13;
                p2[i + 2] = (m2 * x) + (m6 * y) + (m10 * z) + m14;
            }

            return p2;
        },

        /**
         * Transforms an array of positions by a 4x4 matrix.
         * @method transformPositions4
         * @static
         */
        transformPositions4(m, p, p2 = p) {
            let i;
            const len = p.length;

            let x;
            let y;
            let z;

            const m0 = m[0];
            const m1 = m[1];
            const m2 = m[2];
            const m3 = m[3];
            const m4 = m[4];
            const m5 = m[5];
            const m6 = m[6];
            const m7 = m[7];
            const m8 = m[8];
            const m9 = m[9];
            const m10 = m[10];
            const m11 = m[11];
            const m12 = m[12];
            const m13 = m[13];
            const m14 = m[14];
            const m15 = m[15];

            for (i = 0; i < len; i += 4) {

                x = p[i + 0];
                y = p[i + 1];
                z = p[i + 2];

                p2[i + 0] = (m0 * x) + (m4 * y) + (m8 * z) + m12;
                p2[i + 1] = (m1 * x) + (m5 * y) + (m9 * z) + m13;
                p2[i + 2] = (m2 * x) + (m6 * y) + (m10 * z) + m14;
                p2[i + 3] = (m3 * x) + (m7 * y) + (m11 * z) + m15;
            }

            return p2;
        },

        /**
         * Transforms a three-element vector by a 4x4 matrix.
         * @method transformVec3
         * @static
         */
        transformVec3(m, v, dest) {
            const v0 = v[0];
            const v1 = v[1];
            const v2 = v[2];
            dest = dest || this.vec3();
            dest[0] = (m[0] * v0) + (m[4] * v1) + (m[8] * v2);
            dest[1] = (m[1] * v0) + (m[5] * v1) + (m[9] * v2);
            dest[2] = (m[2] * v0) + (m[6] * v1) + (m[10] * v2);
            return dest;
        },

        /**
         * Transforms a four-element vector by a 4x4 matrix.
         * @method transformVec4
         * @static
         */
        transformVec4(m, v, dest) {
            const v0 = v[0];
            const v1 = v[1];
            const v2 = v[2];
            const v3 = v[3];
            dest = dest || math.vec4();
            dest[0] = m[0] * v0 + m[4] * v1 + m[8] * v2 + m[12] * v3;
            dest[1] = m[1] * v0 + m[5] * v1 + m[9] * v2 + m[13] * v3;
            dest[2] = m[2] * v0 + m[6] * v1 + m[10] * v2 + m[14] * v3;
            dest[3] = m[3] * v0 + m[7] * v1 + m[11] * v2 + m[15] * v3;
            return dest;
        },

        /**
         * Rotate a 2D vector around a center point.
         *
         * @param a
         * @param center
         * @param angle
         * @returns {math}
         */
        rotateVec2(a, center, angle, dest = a) {
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const x = a[0] - center[0];
            const y = a[1] - center[1];
            dest[0] = x * c - y * s + center[0];
            dest[1] = x * s + y * c + center[1];
            return a;
        },

        /**
         * Rotate a 3D vector around the x-axis
         *
         * @method rotateVec3X
         * @param {Number[]} a The vec3 point to rotate
         * @param {Number[]} b The origin of the rotation
         * @param {Number} c The angle of rotation
         * @param {Number[]} dest The receiving vec3
         * @returns {Number[]} dest
         * @static
         */
        rotateVec3X(a, b, c, dest) {
            const p = [];
            const r = [];

            //Translate point to the origin
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];

            //perform rotation
            r[0] = p[0];
            r[1] = p[1] * Math.cos(c) - p[2] * Math.sin(c);
            r[2] = p[1] * Math.sin(c) + p[2] * Math.cos(c);

            //translate to correct position
            dest[0] = r[0] + b[0];
            dest[1] = r[1] + b[1];
            dest[2] = r[2] + b[2];

            return dest;
        },

        /**
         * Rotate a 3D vector around the y-axis
         *
         * @method rotateVec3Y
         * @param {Number[]} a The vec3 point to rotate
         * @param {Number[]} b The origin of the rotation
         * @param {Number} c The angle of rotation
         * @param {Number[]} dest The receiving vec3
         * @returns {Number[]} dest
         * @static
         */
        rotateVec3Y(a, b, c, dest) {
            const p = [];
            const r = [];

            //Translate point to the origin
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];

            //perform rotation
            r[0] = p[2] * Math.sin(c) + p[0] * Math.cos(c);
            r[1] = p[1];
            r[2] = p[2] * Math.cos(c) - p[0] * Math.sin(c);

            //translate to correct position
            dest[0] = r[0] + b[0];
            dest[1] = r[1] + b[1];
            dest[2] = r[2] + b[2];

            return dest;
        },

        /**
         * Rotate a 3D vector around the z-axis
         *
         * @method rotateVec3Z
         * @param {Number[]} a The vec3 point to rotate
         * @param {Number[]} b The origin of the rotation
         * @param {Number} c The angle of rotation
         * @param {Number[]} dest The receiving vec3
         * @returns {Number[]} dest
         * @static
         */
        rotateVec3Z(a, b, c, dest) {
            const p = [];
            const r = [];

            //Translate point to the origin
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];

            //perform rotation
            r[0] = p[0] * Math.cos(c) - p[1] * Math.sin(c);
            r[1] = p[0] * Math.sin(c) + p[1] * Math.cos(c);
            r[2] = p[2];

            //translate to correct position
            dest[0] = r[0] + b[0];
            dest[1] = r[1] + b[1];
            dest[2] = r[2] + b[2];

            return dest;
        },

        /**
         * Transforms a four-element vector by a 4x4 projection matrix.
         *
         * @method projectVec4
         * @param {Number[]} p 3D View-space coordinate
         * @param {Number[]} q 2D Projected coordinate
         * @returns {Number[]} 2D Projected coordinate
         * @static
         */
        projectVec4(p, q) {
            const f = 1.0 / p[3];
            q = q || math.vec2();
            q[0] = p[0] * f;
            q[1] = p[1] * f;
            return q;
        },

        /**
         * Unprojects a three-element vector.
         *
         * @method unprojectVec3
         * @param {Number[]} p 3D Projected coordinate
         * @param {Number[]} viewMat View matrix
         * @returns {Number[]} projMat Projection matrix
         * @static
         */
        unprojectVec3: ((() => {
            const mat = new FloatArrayType(16);
            const mat2 = new FloatArrayType(16);
            const mat3 = new FloatArrayType(16);
            return function (p, viewMat, projMat, q) {
                return this.transformVec3(this.mulMat4(this.inverseMat4(viewMat, mat), this.inverseMat4(projMat, mat2), mat3), p, q)
            };
        }))(),

        /**
         * Linearly interpolates between two 3D vectors.
         * @method lerpVec3
         * @static
         */
        lerpVec3(t, t1, t2, p1, p2, dest) {
            const result = dest || math.vec3();
            const f = (t - t1) / (t2 - t1);
            result[0] = p1[0] + (f * (p2[0] - p1[0]));
            result[1] = p1[1] + (f * (p2[1] - p1[1]));
            result[2] = p1[2] + (f * (p2[2] - p1[2]));
            return result;
        },

        /**
         * Linearly interpolates between two 4x4 matrices.
         * @method lerpMat4
         * @static
         */
        lerpMat4(t, t1, t2, m1, m2, dest) {
            const result = dest || math.mat4();
            const f = (t - t1) / (t2 - t1);
            result[0] = m1[0] + (f * (m2[0] - m1[0]));
            result[1] = m1[1] + (f * (m2[1] - m1[1]));
            result[2] = m1[2] + (f * (m2[2] - m1[2]));
            result[3] = m1[3] + (f * (m2[3] - m1[3]));
            result[4] = m1[4] + (f * (m2[4] - m1[4]));
            result[5] = m1[5] + (f * (m2[5] - m1[5]));
            result[6] = m1[6] + (f * (m2[6] - m1[6]));
            result[7] = m1[7] + (f * (m2[7] - m1[7]));
            result[8] = m1[8] + (f * (m2[8] - m1[8]));
            result[9] = m1[9] + (f * (m2[9] - m1[9]));
            result[10] = m1[10] + (f * (m2[10] - m1[10]));
            result[11] = m1[11] + (f * (m2[11] - m1[11]));
            result[12] = m1[12] + (f * (m2[12] - m1[12]));
            result[13] = m1[13] + (f * (m2[13] - m1[13]));
            result[14] = m1[14] + (f * (m2[14] - m1[14]));
            result[15] = m1[15] + (f * (m2[15] - m1[15]));
            return result;
        },


        /**
         * Flattens a two-dimensional array into a one-dimensional array.
         *
         * @method flatten
         * @static
         * @param {Array of Arrays} a A 2D array
         * @returns Flattened 1D array
         */
        flatten(a) {

            const result = [];

            let i;
            let leni;
            let j;
            let lenj;
            let item;

            for (i = 0, leni = a.length; i < leni; i++) {
                item = a[i];
                for (j = 0, lenj = item.length; j < lenj; j++) {
                    result.push(item[j]);
                }
            }

            return result;
        },


        identityQuaternion(dest = math.vec4()) {
            dest[0] = 0.0;
            dest[1] = 0.0;
            dest[2] = 0.0;
            dest[3] = 1.0;
            return dest;
        },

        /**
         * Initializes a quaternion from Euler angles.
         *
         * @param {Number[]} euler The Euler angles.
         * @param {String} order Euler angle order: "XYZ", "YXZ", "ZXY" etc.
         * @param {Number[]} [dest] Destination quaternion, created by default.
         * @returns {Number[]} The quaternion.
         */
        eulerToQuaternion(euler, order, dest = math.vec4()) {
            // http://www.mathworks.com/matlabcentral/fileexchange/
            // 	20696-function-to-convert-between-dcm-euler-angles-quaternions-and-euler-vectors/
            //	content/SpinCalc.m

            const a = (euler[0] * math.DEGTORAD) / 2;
            const b = (euler[1] * math.DEGTORAD) / 2;
            const c = (euler[2] * math.DEGTORAD) / 2;

            const c1 = Math.cos(a);
            const c2 = Math.cos(b);
            const c3 = Math.cos(c);
            const s1 = Math.sin(a);
            const s2 = Math.sin(b);
            const s3 = Math.sin(c);

            if (order === 'XYZ') {

                dest[0] = s1 * c2 * c3 + c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 - s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 + s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 - s1 * s2 * s3;

            } else if (order === 'YXZ') {

                dest[0] = s1 * c2 * c3 + c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 - s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 - s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 + s1 * s2 * s3;

            } else if (order === 'ZXY') {

                dest[0] = s1 * c2 * c3 - c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 + s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 + s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 - s1 * s2 * s3;

            } else if (order === 'ZYX') {

                dest[0] = s1 * c2 * c3 - c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 + s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 - s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 + s1 * s2 * s3;

            } else if (order === 'YZX') {

                dest[0] = s1 * c2 * c3 + c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 + s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 - s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 - s1 * s2 * s3;

            } else if (order === 'XZY') {

                dest[0] = s1 * c2 * c3 - c1 * s2 * s3;
                dest[1] = c1 * s2 * c3 - s1 * c2 * s3;
                dest[2] = c1 * c2 * s3 + s1 * s2 * c3;
                dest[3] = c1 * c2 * c3 + s1 * s2 * s3;
            }

            return dest;
        },

        mat4ToQuaternion(m, dest = math.vec4()) {
            // http://www.euclideanspace.com/maths/geometry/rotations/conversions/matrixToQuaternion/index.htm

            // Assumes the upper 3x3 of m is a pure rotation matrix (i.e, unscaled)

            const m11 = m[0];
            const m12 = m[4];
            const m13 = m[8];
            const m21 = m[1];
            const m22 = m[5];
            const m23 = m[9];
            const m31 = m[2];
            const m32 = m[6];
            const m33 = m[10];
            let s;

            const trace = m11 + m22 + m33;

            if (trace > 0) {

                s = 0.5 / Math.sqrt(trace + 1.0);

                dest[3] = 0.25 / s;
                dest[0] = (m32 - m23) * s;
                dest[1] = (m13 - m31) * s;
                dest[2] = (m21 - m12) * s;

            } else if (m11 > m22 && m11 > m33) {

                s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);

                dest[3] = (m32 - m23) / s;
                dest[0] = 0.25 * s;
                dest[1] = (m12 + m21) / s;
                dest[2] = (m13 + m31) / s;

            } else if (m22 > m33) {

                s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);

                dest[3] = (m13 - m31) / s;
                dest[0] = (m12 + m21) / s;
                dest[1] = 0.25 * s;
                dest[2] = (m23 + m32) / s;

            } else {

                s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);

                dest[3] = (m21 - m12) / s;
                dest[0] = (m13 + m31) / s;
                dest[1] = (m23 + m32) / s;
                dest[2] = 0.25 * s;
            }

            return dest;
        },

        vec3PairToQuaternion(u, v, dest = math.vec4()) {
            const norm_u_norm_v = Math.sqrt(math.dotVec3(u, u) * math.dotVec3(v, v));
            let real_part = norm_u_norm_v + math.dotVec3(u, v);

            if (real_part < 0.00000001 * norm_u_norm_v) {

                // If u and v are exactly opposite, rotate 180 degrees
                // around an arbitrary orthogonal axis. Axis normalisation
                // can happen later, when we normalise the quaternion.

                real_part = 0.0;

                if (Math.abs(u[0]) > Math.abs(u[2])) {

                    dest[0] = -u[1];
                    dest[1] = u[0];
                    dest[2] = 0;

                } else {
                    dest[0] = 0;
                    dest[1] = -u[2];
                    dest[2] = u[1];
                }

            } else {

                // Otherwise, build quaternion the standard way.
                math.cross3Vec3(u, v, dest);
            }

            dest[3] = real_part;

            return math.normalizeQuaternion(dest);
        },

        angleAxisToQuaternion(angleAxis, dest = math.vec4()) {
            const halfAngle = angleAxis[3] / 2.0;
            const fsin = Math.sin(halfAngle);
            dest[0] = fsin * angleAxis[0];
            dest[1] = fsin * angleAxis[1];
            dest[2] = fsin * angleAxis[2];
            dest[3] = Math.cos(halfAngle);
            return dest;
        },

        quaternionToEuler: ((() => {
            const mat = new FloatArrayType(16);
            return (q, order, dest) => {
                dest = dest || math.vec3();
                math.quaternionToRotationMat4(q, mat);
                math.mat4ToEuler(mat, order, dest);
                return dest;
            };
        }))(),

        mulQuaternions(p, q, dest = math.vec4()) {
            const p0 = p[0];
            const p1 = p[1];
            const p2 = p[2];
            const p3 = p[3];
            const q0 = q[0];
            const q1 = q[1];
            const q2 = q[2];
            const q3 = q[3];
            dest[0] = p3 * q0 + p0 * q3 + p1 * q2 - p2 * q1;
            dest[1] = p3 * q1 + p1 * q3 + p2 * q0 - p0 * q2;
            dest[2] = p3 * q2 + p2 * q3 + p0 * q1 - p1 * q0;
            dest[3] = p3 * q3 - p0 * q0 - p1 * q1 - p2 * q2;
            return dest;
        },

        vec3ApplyQuaternion(q, vec, dest = math.vec3()) {
            const x = vec[0];
            const y = vec[1];
            const z = vec[2];

            const qx = q[0];
            const qy = q[1];
            const qz = q[2];
            const qw = q[3];

            // calculate quat * vector

            const ix = qw * x + qy * z - qz * y;
            const iy = qw * y + qz * x - qx * z;
            const iz = qw * z + qx * y - qy * x;
            const iw = -qx * x - qy * y - qz * z;

            // calculate result * inverse quat

            dest[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
            dest[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
            dest[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;

            return dest;
        },

        quaternionToMat4(q, dest) {

            dest = math.identityMat4(dest);

            const q0 = q[0];  //x
            const q1 = q[1];  //y
            const q2 = q[2];  //z
            const q3 = q[3];  //w

            const tx = 2.0 * q0;
            const ty = 2.0 * q1;
            const tz = 2.0 * q2;

            const twx = tx * q3;
            const twy = ty * q3;
            const twz = tz * q3;

            const txx = tx * q0;
            const txy = ty * q0;
            const txz = tz * q0;

            const tyy = ty * q1;
            const tyz = tz * q1;
            const tzz = tz * q2;

            dest[0] = 1.0 - (tyy + tzz);
            dest[1] = txy + twz;
            dest[2] = txz - twy;

            dest[4] = txy - twz;
            dest[5] = 1.0 - (txx + tzz);
            dest[6] = tyz + twx;

            dest[8] = txz + twy;
            dest[9] = tyz - twx;

            dest[10] = 1.0 - (txx + tyy);

            return dest;
        },

        quaternionToRotationMat4(q, m) {
            const x = q[0];
            const y = q[1];
            const z = q[2];
            const w = q[3];

            const x2 = x + x;
            const y2 = y + y;
            const z2 = z + z;
            const xx = x * x2;
            const xy = x * y2;
            const xz = x * z2;
            const yy = y * y2;
            const yz = y * z2;
            const zz = z * z2;
            const wx = w * x2;
            const wy = w * y2;
            const wz = w * z2;

            m[0] = 1 - (yy + zz);
            m[4] = xy - wz;
            m[8] = xz + wy;

            m[1] = xy + wz;
            m[5] = 1 - (xx + zz);
            m[9] = yz - wx;

            m[2] = xz - wy;
            m[6] = yz + wx;
            m[10] = 1 - (xx + yy);

            // last column
            m[3] = 0;
            m[7] = 0;
            m[11] = 0;

            // bottom row
            m[12] = 0;
            m[13] = 0;
            m[14] = 0;
            m[15] = 1;

            return m;
        },

        normalizeQuaternion(q, dest = q) {
            const len = math.lenVec4([q[0], q[1], q[2], q[3]]);
            dest[0] = q[0] / len;
            dest[1] = q[1] / len;
            dest[2] = q[2] / len;
            dest[3] = q[3] / len;
            return dest;
        },

        conjugateQuaternion(q, dest = q) {
            dest[0] = -q[0];
            dest[1] = -q[1];
            dest[2] = -q[2];
            dest[3] = q[3];
            return dest;
        },

        inverseQuaternion(q, dest) {
            return math.normalizeQuaternion(math.conjugateQuaternion(q, dest));
        },

        quaternionToAngleAxis(q, angleAxis = math.vec4()) {
            q = math.normalizeQuaternion(q, tempVec4);
            const q3 = q[3];
            const angle = 2 * Math.acos(q3);
            const s = Math.sqrt(1 - q3 * q3);
            if (s < 0.001) { // test to avoid divide by zero, s is always positive due to sqrt
                angleAxis[0] = q[0];
                angleAxis[1] = q[1];
                angleAxis[2] = q[2];
            } else {
                angleAxis[0] = q[0] / s;
                angleAxis[1] = q[1] / s;
                angleAxis[2] = q[2] / s;
            }
            angleAxis[3] = angle; // * 57.295779579;
            return angleAxis;
        },

        //------------------------------------------------------------------------------------------------------------------
        // Boundaries
        //------------------------------------------------------------------------------------------------------------------

        /**
         * Returns a new, uninitialized 3D axis-aligned bounding box.
         *
         * @private
         */
        AABB3(values) {
            return new FloatArrayType(values || 6);
        },

        /**
         * Returns a new, uninitialized 2D axis-aligned bounding box.
         *
         * @private
         */
        AABB2(values) {
            return new FloatArrayType(values || 4);
        },

        /**
         * Returns a new, uninitialized 3D oriented bounding box (OBB).
         *
         * @private
         */
        OBB3(values) {
            return new FloatArrayType(values || 32);
        },

        /**
         * Returns a new, uninitialized 2D oriented bounding box (OBB).
         *
         * @private
         */
        OBB2(values) {
            return new FloatArrayType(values || 16);
        },

        /** Returns a new 3D bounding sphere */
        Sphere3(x, y, z, r) {
            return new FloatArrayType([x, y, z, r]);
        },

        /**
         * Transforms an OBB3 by a 4x4 matrix.
         *
         * @private
         */
        transformOBB3(m, p, p2 = p) {
            let i;
            const len = p.length;

            let x;
            let y;
            let z;

            const m0 = m[0];
            const m1 = m[1];
            const m2 = m[2];
            const m3 = m[3];
            const m4 = m[4];
            const m5 = m[5];
            const m6 = m[6];
            const m7 = m[7];
            const m8 = m[8];
            const m9 = m[9];
            const m10 = m[10];
            const m11 = m[11];
            const m12 = m[12];
            const m13 = m[13];
            const m14 = m[14];
            const m15 = m[15];

            for (i = 0; i < len; i += 4) {

                x = p[i + 0];
                y = p[i + 1];
                z = p[i + 2];

                p2[i + 0] = (m0 * x) + (m4 * y) + (m8 * z) + m12;
                p2[i + 1] = (m1 * x) + (m5 * y) + (m9 * z) + m13;
                p2[i + 2] = (m2 * x) + (m6 * y) + (m10 * z) + m14;
                p2[i + 3] = (m3 * x) + (m7 * y) + (m11 * z) + m15;
            }

            return p2;
        },

        /** Returns true if the first AABB contains the second AABB.
         * @param aabb1
         * @param aabb2
         * @returns {Boolean}
         */
        containsAABB3: function (aabb1, aabb2) {
            const result = (
                aabb1[0] <= aabb2[0] && aabb2[3] <= aabb1[3] &&
                aabb1[1] <= aabb2[1] && aabb2[4] <= aabb1[4] &&
                aabb1[2] <= aabb2[2] && aabb2[5] <= aabb1[5]);
            return result;
        },


        /**
         * Gets the diagonal size of an AABB3 given as minima and maxima.
         *
         * @private
         */
        getAABB3Diag: ((() => {

            const min = new FloatArrayType(3);
            const max = new FloatArrayType(3);
            const tempVec3 = new FloatArrayType(3);

            return aabb => {

                min[0] = aabb[0];
                min[1] = aabb[1];
                min[2] = aabb[2];

                max[0] = aabb[3];
                max[1] = aabb[4];
                max[2] = aabb[5];

                math.subVec3(max, min, tempVec3);

                return Math.abs(math.lenVec3(tempVec3));
            };
        }))(),

        /**
         * Get a diagonal boundary size that is symmetrical about the given point.
         *
         * @private
         */
        getAABB3DiagPoint: ((() => {

            const min = new FloatArrayType(3);
            const max = new FloatArrayType(3);
            const tempVec3 = new FloatArrayType(3);

            return (aabb, p) => {

                min[0] = aabb[0];
                min[1] = aabb[1];
                min[2] = aabb[2];

                max[0] = aabb[3];
                max[1] = aabb[4];
                max[2] = aabb[5];

                const diagVec = math.subVec3(max, min, tempVec3);

                const xneg = p[0] - aabb[0];
                const xpos = aabb[3] - p[0];
                const yneg = p[1] - aabb[1];
                const ypos = aabb[4] - p[1];
                const zneg = p[2] - aabb[2];
                const zpos = aabb[5] - p[2];

                diagVec[0] += (xneg > xpos) ? xneg : xpos;
                diagVec[1] += (yneg > ypos) ? yneg : ypos;
                diagVec[2] += (zneg > zpos) ? zneg : zpos;

                return Math.abs(math.lenVec3(diagVec));
            };
        }))(),

        /**
         * Gets the area of an AABB.
         *
         * @private
         */
        getAABB3Area(aabb) {
            const width = (aabb[3] - aabb[0]);
            const height = (aabb[4] - aabb[1]);
            const depth = (aabb[5] - aabb[2]);
            return (width * height * depth);
        },

        /**
         * Gets the center of an AABB.
         *
         * @private
         */
        getAABB3Center(aabb, dest) {
            const r = dest || math.vec3();

            r[0] = (aabb[0] + aabb[3]) / 2;
            r[1] = (aabb[1] + aabb[4]) / 2;
            r[2] = (aabb[2] + aabb[5]) / 2;

            return r;
        },

        /**
         * Gets the center of a 2D AABB.
         *
         * @private
         */
        getAABB2Center(aabb, dest) {
            const r = dest || math.vec2();

            r[0] = (aabb[2] + aabb[0]) / 2;
            r[1] = (aabb[3] + aabb[1]) / 2;

            return r;
        },

        /**
         * Collapses a 3D axis-aligned boundary, ready to expand to fit 3D points.
         * Creates new AABB if none supplied.
         *
         * @private
         */
        collapseAABB3(aabb = math.AABB3()) {
            aabb[0] = math.MAX_DOUBLE;
            aabb[1] = math.MAX_DOUBLE;
            aabb[2] = math.MAX_DOUBLE;
            aabb[3] = math.MIN_DOUBLE;
            aabb[4] = math.MIN_DOUBLE;
            aabb[5] = math.MIN_DOUBLE;

            return aabb;
        },

        /**
         * Converts an axis-aligned 3D boundary into an oriented boundary consisting of
         * an array of eight 3D positions, one for each corner of the boundary.
         *
         * @private
         */
        AABB3ToOBB3(aabb, obb = math.OBB3()) {
            obb[0] = aabb[0];
            obb[1] = aabb[1];
            obb[2] = aabb[2];
            obb[3] = 1;

            obb[4] = aabb[3];
            obb[5] = aabb[1];
            obb[6] = aabb[2];
            obb[7] = 1;

            obb[8] = aabb[3];
            obb[9] = aabb[4];
            obb[10] = aabb[2];
            obb[11] = 1;

            obb[12] = aabb[0];
            obb[13] = aabb[4];
            obb[14] = aabb[2];
            obb[15] = 1;

            obb[16] = aabb[0];
            obb[17] = aabb[1];
            obb[18] = aabb[5];
            obb[19] = 1;

            obb[20] = aabb[3];
            obb[21] = aabb[1];
            obb[22] = aabb[5];
            obb[23] = 1;

            obb[24] = aabb[3];
            obb[25] = aabb[4];
            obb[26] = aabb[5];
            obb[27] = 1;

            obb[28] = aabb[0];
            obb[29] = aabb[4];
            obb[30] = aabb[5];
            obb[31] = 1;

            return obb;
        },

        /**
         * Finds the minimum axis-aligned 3D boundary enclosing the homogeneous 3D points (x,y,z,w) given in a flattened array.
         *
         * @private
         */
        positions3ToAABB3: ((() => {

            const p = new FloatArrayType(3);

            return (positions, aabb, positionsDecodeMatrix) => {
                aabb = aabb || math.AABB3();

                let xmin = math.MAX_DOUBLE;
                let ymin = math.MAX_DOUBLE;
                let zmin = math.MAX_DOUBLE;
                let xmax = math.MIN_DOUBLE;
                let ymax = math.MIN_DOUBLE;
                let zmax = math.MIN_DOUBLE;

                let x;
                let y;
                let z;

                for (let i = 0, len = positions.length; i < len; i += 3) {

                    if (positionsDecodeMatrix) {

                        p[0] = positions[i + 0];
                        p[1] = positions[i + 1];
                        p[2] = positions[i + 2];

                        math.decompressPosition(p, positionsDecodeMatrix, p);

                        x = p[0];
                        y = p[1];
                        z = p[2];

                    } else {
                        x = positions[i + 0];
                        y = positions[i + 1];
                        z = positions[i + 2];
                    }

                    if (x < xmin) {
                        xmin = x;
                    }

                    if (y < ymin) {
                        ymin = y;
                    }

                    if (z < zmin) {
                        zmin = z;
                    }

                    if (x > xmax) {
                        xmax = x;
                    }

                    if (y > ymax) {
                        ymax = y;
                    }

                    if (z > zmax) {
                        zmax = z;
                    }
                }

                aabb[0] = xmin;
                aabb[1] = ymin;
                aabb[2] = zmin;
                aabb[3] = xmax;
                aabb[4] = ymax;
                aabb[5] = zmax;

                return aabb;
            };
        }))(),

        /**
         * Finds the minimum axis-aligned 3D boundary enclosing the homogeneous 3D points (x,y,z,w) given in a flattened array.
         *
         * @private
         */
        OBB3ToAABB3(obb, aabb = math.AABB3()) {
            let xmin = math.MAX_DOUBLE;
            let ymin = math.MAX_DOUBLE;
            let zmin = math.MAX_DOUBLE;
            let xmax = math.MIN_DOUBLE;
            let ymax = math.MIN_DOUBLE;
            let zmax = math.MIN_DOUBLE;

            let x;
            let y;
            let z;

            for (let i = 0, len = obb.length; i < len; i += 4) {

                x = obb[i + 0];
                y = obb[i + 1];
                z = obb[i + 2];

                if (x < xmin) {
                    xmin = x;
                }

                if (y < ymin) {
                    ymin = y;
                }

                if (z < zmin) {
                    zmin = z;
                }

                if (x > xmax) {
                    xmax = x;
                }

                if (y > ymax) {
                    ymax = y;
                }

                if (z > zmax) {
                    zmax = z;
                }
            }

            aabb[0] = xmin;
            aabb[1] = ymin;
            aabb[2] = zmin;
            aabb[3] = xmax;
            aabb[4] = ymax;
            aabb[5] = zmax;

            return aabb;
        },

        /**
         * Finds the minimum axis-aligned 3D boundary enclosing the given 3D points.
         *
         * @private
         */
        points3ToAABB3(points, aabb = math.AABB3()) {
            let xmin = math.MAX_DOUBLE;
            let ymin = math.MAX_DOUBLE;
            let zmin = math.MAX_DOUBLE;
            let xmax = math.MIN_DOUBLE;
            let ymax = math.MIN_DOUBLE;
            let zmax = math.MIN_DOUBLE;

            let x;
            let y;
            let z;

            for (let i = 0, len = points.length; i < len; i++) {

                x = points[i][0];
                y = points[i][1];
                z = points[i][2];

                if (x < xmin) {
                    xmin = x;
                }

                if (y < ymin) {
                    ymin = y;
                }

                if (z < zmin) {
                    zmin = z;
                }

                if (x > xmax) {
                    xmax = x;
                }

                if (y > ymax) {
                    ymax = y;
                }

                if (z > zmax) {
                    zmax = z;
                }
            }

            aabb[0] = xmin;
            aabb[1] = ymin;
            aabb[2] = zmin;
            aabb[3] = xmax;
            aabb[4] = ymax;
            aabb[5] = zmax;

            return aabb;
        },

        /**
         * Finds the minimum boundary sphere enclosing the given 3D points.
         *
         * @private
         */
        points3ToSphere3: ((() => {

            const tempVec3 = new FloatArrayType(3);

            return (points, sphere) => {

                sphere = sphere || math.vec4();

                let x = 0;
                let y = 0;
                let z = 0;

                let i;
                const numPoints = points.length;

                for (i = 0; i < numPoints; i++) {
                    x += points[i][0];
                    y += points[i][1];
                    z += points[i][2];
                }

                sphere[0] = x / numPoints;
                sphere[1] = y / numPoints;
                sphere[2] = z / numPoints;

                let radius = 0;
                let dist;

                for (i = 0; i < numPoints; i++) {

                    dist = Math.abs(math.lenVec3(math.subVec3(points[i], sphere, tempVec3)));

                    if (dist > radius) {
                        radius = dist;
                    }
                }

                sphere[3] = radius;

                return sphere;
            };
        }))(),

        /**
         * Finds the minimum boundary sphere enclosing the given 3D positions.
         *
         * @private
         */
        positions3ToSphere3: ((() => {

            const tempVec3a = new FloatArrayType(3);
            const tempVec3b = new FloatArrayType(3);

            return (positions, sphere) => {

                sphere = sphere || math.vec4();

                let x = 0;
                let y = 0;
                let z = 0;

                let i;
                const lenPositions = positions.length;
                let radius = 0;

                for (i = 0; i < lenPositions; i += 3) {
                    x += positions[i];
                    y += positions[i + 1];
                    z += positions[i + 2];
                }

                const numPositions = lenPositions / 3;

                sphere[0] = x / numPositions;
                sphere[1] = y / numPositions;
                sphere[2] = z / numPositions;

                let dist;

                for (i = 0; i < lenPositions; i += 3) {

                    tempVec3a[0] = positions[i];
                    tempVec3a[1] = positions[i + 1];
                    tempVec3a[2] = positions[i + 2];

                    dist = Math.abs(math.lenVec3(math.subVec3(tempVec3a, sphere, tempVec3b)));

                    if (dist > radius) {
                        radius = dist;
                    }
                }

                sphere[3] = radius;

                return sphere;
            };
        }))(),

        /**
         * Finds the minimum boundary sphere enclosing the given 3D points.
         *
         * @private
         */
        OBB3ToSphere3: ((() => {

            const point = new FloatArrayType(3);
            const tempVec3 = new FloatArrayType(3);

            return (points, sphere) => {

                sphere = sphere || math.vec4();

                let x = 0;
                let y = 0;
                let z = 0;

                let i;
                const lenPoints = points.length;
                const numPoints = lenPoints / 4;

                for (i = 0; i < lenPoints; i += 4) {
                    x += points[i + 0];
                    y += points[i + 1];
                    z += points[i + 2];
                }

                sphere[0] = x / numPoints;
                sphere[1] = y / numPoints;
                sphere[2] = z / numPoints;

                let radius = 0;
                let dist;

                for (i = 0; i < lenPoints; i += 4) {

                    point[0] = points[i + 0];
                    point[1] = points[i + 1];
                    point[2] = points[i + 2];

                    dist = Math.abs(math.lenVec3(math.subVec3(point, sphere, tempVec3)));

                    if (dist > radius) {
                        radius = dist;
                    }
                }

                sphere[3] = radius;

                return sphere;
            };
        }))(),

        /**
         * Gets the center of a bounding sphere.
         *
         * @private
         */
        getSphere3Center(sphere, dest = math.vec3()) {
            dest[0] = sphere[0];
            dest[1] = sphere[1];
            dest[2] = sphere[2];

            return dest;
        },

        /**
         * Gets the 3D center of the given flat array of 3D positions.
         *
         * @private
         */
        getPositionsCenter(positions, center = math.vec3()) {
            let xCenter = 0;
            let yCenter = 0;
            let zCenter = 0;
            for (var i = 0, len = positions.length; i < len; i += 3) {
                xCenter += positions[i + 0];
                yCenter += positions[i + 1];
                zCenter += positions[i + 2];
            }
            const numPositions = positions.length / 3;
            center[0] = xCenter / numPositions;
            center[1] = yCenter / numPositions;
            center[2] = zCenter / numPositions;
            return center;
        },

        /**
         * Expands the first axis-aligned 3D boundary to enclose the second, if required.
         *
         * @private
         */
        expandAABB3(aabb1, aabb2) {

            if (aabb1[0] > aabb2[0]) {
                aabb1[0] = aabb2[0];
            }

            if (aabb1[1] > aabb2[1]) {
                aabb1[1] = aabb2[1];
            }

            if (aabb1[2] > aabb2[2]) {
                aabb1[2] = aabb2[2];
            }

            if (aabb1[3] < aabb2[3]) {
                aabb1[3] = aabb2[3];
            }

            if (aabb1[4] < aabb2[4]) {
                aabb1[4] = aabb2[4];
            }

            if (aabb1[5] < aabb2[5]) {
                aabb1[5] = aabb2[5];
            }

            return aabb1;
        },

        /**
         * Expands an axis-aligned 3D boundary to enclose the given point, if needed.
         *
         * @private
         */
        expandAABB3Point3(aabb, p) {

            if (aabb[0] > p[0]) {
                aabb[0] = p[0];
            }

            if (aabb[1] > p[1]) {
                aabb[1] = p[1];
            }

            if (aabb[2] > p[2]) {
                aabb[2] = p[2];
            }

            if (aabb[3] < p[0]) {
                aabb[3] = p[0];
            }

            if (aabb[4] < p[1]) {
                aabb[4] = p[1];
            }

            if (aabb[5] < p[2]) {
                aabb[5] = p[2];
            }

            return aabb;
        },

        /**
         * Expands an axis-aligned 3D boundary to enclose the given points, if needed.
         *
         * @private
         */
        expandAABB3Points3(aabb, positions) {
            var x;
            var y;
            var z;
            for (var i = 0, len = positions.length; i < len; i += 3) {
                x = positions[i];
                y = positions[i + 1];
                z = positions[i + 2];
                if (aabb[0] > x) {
                    aabb[0] = x;
                }
                if (aabb[1] > y) {
                    aabb[1] = y;
                }
                if (aabb[2] > z) {
                    aabb[2] = z;
                }
                if (aabb[3] < x) {
                    aabb[3] = x;
                }
                if (aabb[4] < y) {
                    aabb[4] = y;
                }
                if (aabb[5] < z) {
                    aabb[5] = z;
                }
            }
            return aabb;
        },

        /**
         * Collapses a 2D axis-aligned boundary, ready to expand to fit 2D points.
         * Creates new AABB if none supplied.
         *
         * @private
         */
        collapseAABB2(aabb = math.AABB2()) {
            aabb[0] = math.MAX_DOUBLE;
            aabb[1] = math.MAX_DOUBLE;
            aabb[2] = math.MIN_DOUBLE;
            aabb[3] = math.MIN_DOUBLE;

            return aabb;
        },

        point3AABB3Intersect(aabb, p) {
            return aabb[0] > p[0] || aabb[3] < p[0] || aabb[1] > p[1] || aabb[4] < p[1] || aabb[2] > p[2] || aabb[5] < p[2];
        },

        /**
         *
         * @param dir
         * @param constant
         * @param aabb
         * @returns {number}
         */
        planeAABB3Intersect(dir, constant, aabb) {
            let min, max;
            if (dir[0] > 0) {
                min = dir[0] * aabb[0];
                max = dir[0] * aabb[3];
            } else {
                min = dir[0] * aabb[3];
                max = dir[0] * aabb[0];
            }
            if (dir[1] > 0) {
                min += dir[1] * aabb[1];
                max += dir[1] * aabb[4];
            } else {
                min += dir[1] * aabb[4];
                max += dir[1] * aabb[1];
            }
            if (dir[2] > 0) {
                min += dir[2] * aabb[2];
                max += dir[2] * aabb[5];
            } else {
                min += dir[2] * aabb[5];
                max += dir[2] * aabb[2];
            }
            const outside = (min <= -constant) && (max <= -constant);
            if (outside) {
                return -1;
            }

            const inside = (min >= -constant) && (max >= -constant);
            if (inside) {
                return 1;
            }

            return 0;
        },

        /**
         * Finds the minimum 2D projected axis-aligned boundary enclosing the given 3D points.
         *
         * @private
         */
        OBB3ToAABB2(points, aabb = math.AABB2()) {
            let xmin = math.MAX_DOUBLE;
            let ymin = math.MAX_DOUBLE;
            let xmax = math.MIN_DOUBLE;
            let ymax = math.MIN_DOUBLE;

            let x;
            let y;
            let w;
            let f;

            for (let i = 0, len = points.length; i < len; i += 4) {

                x = points[i + 0];
                y = points[i + 1];
                w = points[i + 3] || 1.0;

                f = 1.0 / w;

                x *= f;
                y *= f;

                if (x < xmin) {
                    xmin = x;
                }

                if (y < ymin) {
                    ymin = y;
                }

                if (x > xmax) {
                    xmax = x;
                }

                if (y > ymax) {
                    ymax = y;
                }
            }

            aabb[0] = xmin;
            aabb[1] = ymin;
            aabb[2] = xmax;
            aabb[3] = ymax;

            return aabb;
        },

        /**
         * Expands the first axis-aligned 2D boundary to enclose the second, if required.
         *
         * @private
         */
        expandAABB2(aabb1, aabb2) {

            if (aabb1[0] > aabb2[0]) {
                aabb1[0] = aabb2[0];
            }

            if (aabb1[1] > aabb2[1]) {
                aabb1[1] = aabb2[1];
            }

            if (aabb1[2] < aabb2[2]) {
                aabb1[2] = aabb2[2];
            }

            if (aabb1[3] < aabb2[3]) {
                aabb1[3] = aabb2[3];
            }

            return aabb1;
        },

        /**
         * Expands an axis-aligned 2D boundary to enclose the given point, if required.
         *
         * @private
         */
        expandAABB2Point2(aabb, p) {

            if (aabb[0] > p[0]) {
                aabb[0] = p[0];
            }

            if (aabb[1] > p[1]) {
                aabb[1] = p[1];
            }

            if (aabb[2] < p[0]) {
                aabb[2] = p[0];
            }

            if (aabb[3] < p[1]) {
                aabb[3] = p[1];
            }

            return aabb;
        },

        AABB2ToCanvas(aabb, canvasWidth, canvasHeight, aabb2 = aabb) {
            const xmin = (aabb[0] + 1.0) * 0.5;
            const ymin = (aabb[1] + 1.0) * 0.5;
            const xmax = (aabb[2] + 1.0) * 0.5;
            const ymax = (aabb[3] + 1.0) * 0.5;

            aabb2[0] = Math.floor(xmin * canvasWidth);
            aabb2[1] = canvasHeight - Math.floor(ymax * canvasHeight);
            aabb2[2] = Math.floor(xmax * canvasWidth);
            aabb2[3] = canvasHeight - Math.floor(ymin * canvasHeight);

            return aabb2;
        },

        //------------------------------------------------------------------------------------------------------------------
        // Curves
        //------------------------------------------------------------------------------------------------------------------

        tangentQuadraticBezier(t, p0, p1, p2) {
            return 2 * (1 - t) * (p1 - p0) + 2 * t * (p2 - p1);
        },

        tangentQuadraticBezier3(t, p0, p1, p2, p3) {
            return -3 * p0 * (1 - t) * (1 - t) +
                3 * p1 * (1 - t) * (1 - t) - 6 * t * p1 * (1 - t) +
                6 * t * p2 * (1 - t) - 3 * t * t * p2 +
                3 * t * t * p3;
        },

        tangentSpline(t) {
            const h00 = 6 * t * t - 6 * t;
            const h10 = 3 * t * t - 4 * t + 1;
            const h01 = -6 * t * t + 6 * t;
            const h11 = 3 * t * t - 2 * t;
            return h00 + h10 + h01 + h11;
        },

        catmullRomInterpolate(p0, p1, p2, p3, t) {
            const v0 = (p2 - p0) * 0.5;
            const v1 = (p3 - p1) * 0.5;
            const t2 = t * t;
            const t3 = t * t2;
            return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
        },

    // Bezier Curve formulii from http://en.wikipedia.org/wiki/B%C3%A9zier_curve

    // Quad Bezier Functions

        b2p0(t, p) {
            const k = 1 - t;
            return k * k * p;

        },

        b2p1(t, p) {
            return 2 * (1 - t) * t * p;
        },

        b2p2(t, p) {
            return t * t * p;
        },

        b2(t, p0, p1, p2) {
            return this.b2p0(t, p0) + this.b2p1(t, p1) + this.b2p2(t, p2);
        },

    // Cubic Bezier Functions

        b3p0(t, p) {
            const k = 1 - t;
            return k * k * k * p;
        },

        b3p1(t, p) {
            const k = 1 - t;
            return 3 * k * k * t * p;
        },

        b3p2(t, p) {
            const k = 1 - t;
            return 3 * k * t * t * p;
        },

        b3p3(t, p) {
            return t * t * t * p;
        },

        b3(t, p0, p1, p2, p3) {
            return this.b3p0(t, p0) + this.b3p1(t, p1) + this.b3p2(t, p2) + this.b3p3(t, p3);
        },

        //------------------------------------------------------------------------------------------------------------------
        // Geometry
        //------------------------------------------------------------------------------------------------------------------

        /**
         * Calculates the normal vector of a triangle.
         *
         * @private
         */
        triangleNormal(a, b, c, normal = math.vec3()) {
            const p1x = b[0] - a[0];
            const p1y = b[1] - a[1];
            const p1z = b[2] - a[2];

            const p2x = c[0] - a[0];
            const p2y = c[1] - a[1];
            const p2z = c[2] - a[2];

            const p3x = p1y * p2z - p1z * p2y;
            const p3y = p1z * p2x - p1x * p2z;
            const p3z = p1x * p2y - p1y * p2x;

            const mag = Math.sqrt(p3x * p3x + p3y * p3y + p3z * p3z);
            if (mag === 0) {
                normal[0] = 0;
                normal[1] = 0;
                normal[2] = 0;
            } else {
                normal[0] = p3x / mag;
                normal[1] = p3y / mag;
                normal[2] = p3z / mag;
            }

            return normal
        },

        /**
         * Finds the intersection of a 3D ray with a 3D triangle.
         *
         * @private
         */
        rayTriangleIntersect: ((() => {

            const tempVec3 = new FloatArrayType(3);
            const tempVec3b = new FloatArrayType(3);
            const tempVec3c = new FloatArrayType(3);
            const tempVec3d = new FloatArrayType(3);
            const tempVec3e = new FloatArrayType(3);

            return (origin, dir, a, b, c, isect) => {

                isect = isect || math.vec3();

                const EPSILON = 0.000001;

                const edge1 = math.subVec3(b, a, tempVec3);
                const edge2 = math.subVec3(c, a, tempVec3b);

                const pvec = math.cross3Vec3(dir, edge2, tempVec3c);
                const det = math.dotVec3(edge1, pvec);
                if (det < EPSILON) {
                    return null;
                }

                const tvec = math.subVec3(origin, a, tempVec3d);
                const u = math.dotVec3(tvec, pvec);
                if (u < 0 || u > det) {
                    return null;
                }

                const qvec = math.cross3Vec3(tvec, edge1, tempVec3e);
                const v = math.dotVec3(dir, qvec);
                if (v < 0 || u + v > det) {
                    return null;
                }

                const t = math.dotVec3(edge2, qvec) / det;
                isect[0] = origin[0] + t * dir[0];
                isect[1] = origin[1] + t * dir[1];
                isect[2] = origin[2] + t * dir[2];

                return isect;
            };
        }))(),

        /**
         * Finds the intersection of a 3D ray with a plane defined by 3 points.
         *
         * @private
         */
        rayPlaneIntersect: ((() => {

            const tempVec3 = new FloatArrayType(3);
            const tempVec3b = new FloatArrayType(3);
            const tempVec3c = new FloatArrayType(3);
            const tempVec3d = new FloatArrayType(3);

            return (origin, dir, a, b, c, isect) => {

                isect = isect || math.vec3();

                dir = math.normalizeVec3(dir, tempVec3);

                const edge1 = math.subVec3(b, a, tempVec3b);
                const edge2 = math.subVec3(c, a, tempVec3c);

                const n = math.cross3Vec3(edge1, edge2, tempVec3d);
                math.normalizeVec3(n, n);

                const d = -math.dotVec3(a, n);

                const t = -(math.dotVec3(origin, n) + d) / math.dotVec3(dir, n);

                isect[0] = origin[0] + t * dir[0];
                isect[1] = origin[1] + t * dir[1];
                isect[2] = origin[2] + t * dir[2];

                return isect;
            };
        }))(),

        /**
         * Gets barycentric coordinates from cartesian coordinates within a triangle.
         * Gets barycentric coordinates from cartesian coordinates within a triangle.
         *
         * @private
         */
        cartesianToBarycentric: ((() => {

            const tempVec3 = new FloatArrayType(3);
            const tempVec3b = new FloatArrayType(3);
            const tempVec3c = new FloatArrayType(3);

            return (cartesian, a, b, c, dest) => {

                const v0 = math.subVec3(c, a, tempVec3);
                const v1 = math.subVec3(b, a, tempVec3b);
                const v2 = math.subVec3(cartesian, a, tempVec3c);

                const dot00 = math.dotVec3(v0, v0);
                const dot01 = math.dotVec3(v0, v1);
                const dot02 = math.dotVec3(v0, v2);
                const dot11 = math.dotVec3(v1, v1);
                const dot12 = math.dotVec3(v1, v2);

                const denom = (dot00 * dot11 - dot01 * dot01);

                // Colinear or singular triangle

                if (denom === 0) {

                    // Arbitrary location outside of triangle

                    return null;
                }

                const invDenom = 1 / denom;

                const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
                const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

                dest[0] = 1 - u - v;
                dest[1] = v;
                dest[2] = u;

                return dest;
            };
        }))(),

        /**
         * Returns true if the given barycentric coordinates are within their triangle.
         *
         * @private
         */
        barycentricInsideTriangle(bary) {

            const v = bary[1];
            const u = bary[2];

            return (u >= 0) && (v >= 0) && (u + v < 1);
        },

        /**
         * Gets cartesian coordinates from barycentric coordinates within a triangle.
         *
         * @private
         */
        barycentricToCartesian(bary, a, b, c, cartesian = math.vec3()) {
            const u = bary[0];
            const v = bary[1];
            const w = bary[2];

            cartesian[0] = a[0] * u + b[0] * v + c[0] * w;
            cartesian[1] = a[1] * u + b[1] * v + c[1] * w;
            cartesian[2] = a[2] * u + b[2] * v + c[2] * w;

            return cartesian;
        },


        /**
         * Given geometry defined as an array of positions, optional normals, option uv and an array of indices, returns
         * modified arrays that have duplicate vertices removed.
         *
         * Note: does not work well when co-incident vertices have same positions but different normals and UVs.
         *
         * @param positions
         * @param normals
         * @param uv
         * @param indices
         * @returns {{positions: Array, indices: Array}}
         * @private
         */
        mergeVertices(positions, normals, uv, indices) {
            const positionsMap = {}; // Hashmap for looking up vertices by position coordinates (and making sure they are unique)
            const indicesLookup = [];
            const uniquePositions = [];
            const uniqueNormals = normals ? [] : null;
            const uniqueUV = uv ? [] : null;
            const indices2 = [];
            let vx;
            let vy;
            let vz;
            let key;
            const precisionPoints = 4; // number of decimal points, e.g. 4 for epsilon of 0.0001
            const precision = 10 ** precisionPoints;
            let i;
            let len;
            let uvi = 0;
            for (i = 0, len = positions.length; i < len; i += 3) {
                vx = positions[i];
                vy = positions[i + 1];
                vz = positions[i + 2];
                key = `${Math.round(vx * precision)}_${Math.round(vy * precision)}_${Math.round(vz * precision)}`;
                if (positionsMap[key] === undefined) {
                    positionsMap[key] = uniquePositions.length / 3;
                    uniquePositions.push(vx);
                    uniquePositions.push(vy);
                    uniquePositions.push(vz);
                    if (normals) {
                        uniqueNormals.push(normals[i]);
                        uniqueNormals.push(normals[i + 1]);
                        uniqueNormals.push(normals[i + 2]);
                    }
                    if (uv) {
                        uniqueUV.push(uv[uvi]);
                        uniqueUV.push(uv[uvi + 1]);
                    }
                }
                indicesLookup[i / 3] = positionsMap[key];
                uvi += 2;
            }
            for (i = 0, len = indices.length; i < len; i++) {
                indices2[i] = indicesLookup[indices[i]];
            }
            const result = {
                positions: uniquePositions,
                indices: indices2
            };
            if (uniqueNormals) {
                result.normals = uniqueNormals;
            }
            if (uniqueUV) {
                result.uv = uniqueUV;

            }
            return result;
        },

        /**
         * Builds normal vectors from positions and indices.
         *
         * @private
         */
        buildNormals: ((() => {

            const a = new FloatArrayType(3);
            const b = new FloatArrayType(3);
            const c = new FloatArrayType(3);
            const ab = new FloatArrayType(3);
            const ac = new FloatArrayType(3);
            const crossVec = new FloatArrayType(3);

            return (positions, indices, normals) => {

                let i;
                let len;
                const nvecs = new Array(positions.length / 3);
                let j0;
                let j1;
                let j2;

                for (i = 0, len = indices.length; i < len; i += 3) {

                    j0 = indices[i];
                    j1 = indices[i + 1];
                    j2 = indices[i + 2];

                    a[0] = positions[j0 * 3];
                    a[1] = positions[j0 * 3 + 1];
                    a[2] = positions[j0 * 3 + 2];

                    b[0] = positions[j1 * 3];
                    b[1] = positions[j1 * 3 + 1];
                    b[2] = positions[j1 * 3 + 2];

                    c[0] = positions[j2 * 3];
                    c[1] = positions[j2 * 3 + 1];
                    c[2] = positions[j2 * 3 + 2];

                    math.subVec3(b, a, ab);
                    math.subVec3(c, a, ac);

                    const normVec = math.vec3();

                    math.normalizeVec3(math.cross3Vec3(ab, ac, crossVec), normVec);

                    if (!nvecs[j0]) {
                        nvecs[j0] = [];
                    }
                    if (!nvecs[j1]) {
                        nvecs[j1] = [];
                    }
                    if (!nvecs[j2]) {
                        nvecs[j2] = [];
                    }

                    nvecs[j0].push(normVec);
                    nvecs[j1].push(normVec);
                    nvecs[j2].push(normVec);
                }

                normals = (normals && normals.length === positions.length) ? normals : new Float32Array(positions.length);

                let count;
                let x;
                let y;
                let z;

                for (i = 0, len = nvecs.length; i < len; i++) {  // Now go through and average out everything

                    count = nvecs[i].length;

                    x = 0;
                    y = 0;
                    z = 0;

                    for (let j = 0; j < count; j++) {
                        x += nvecs[i][j][0];
                        y += nvecs[i][j][1];
                        z += nvecs[i][j][2];
                    }

                    normals[i * 3] = (x / count);
                    normals[i * 3 + 1] = (y / count);
                    normals[i * 3 + 2] = (z / count);
                }

                return normals;
            };
        }))(),

        /**
         * Builds vertex tangent vectors from positions, UVs and indices.
         *
         * @private
         */
        buildTangents: ((() => {

            const tempVec3 = new FloatArrayType(3);
            const tempVec3b = new FloatArrayType(3);
            const tempVec3c = new FloatArrayType(3);
            const tempVec3d = new FloatArrayType(3);
            const tempVec3e = new FloatArrayType(3);
            const tempVec3f = new FloatArrayType(3);
            const tempVec3g = new FloatArrayType(3);

            return (positions, indices, uv) => {

                const tangents = new Float32Array(positions.length);

                // The vertex arrays needs to be calculated
                // before the calculation of the tangents

                for (let location = 0; location < indices.length; location += 3) {

                    // Recontructing each vertex and UV coordinate into the respective vectors

                    let index = indices[location];

                    const v0 = positions.subarray(index * 3, index * 3 + 3);
                    const uv0 = uv.subarray(index * 2, index * 2 + 2);

                    index = indices[location + 1];

                    const v1 = positions.subarray(index * 3, index * 3 + 3);
                    const uv1 = uv.subarray(index * 2, index * 2 + 2);

                    index = indices[location + 2];

                    const v2 = positions.subarray(index * 3, index * 3 + 3);
                    const uv2 = uv.subarray(index * 2, index * 2 + 2);

                    const deltaPos1 = math.subVec3(v1, v0, tempVec3);
                    const deltaPos2 = math.subVec3(v2, v0, tempVec3b);

                    const deltaUV1 = math.subVec2(uv1, uv0, tempVec3c);
                    const deltaUV2 = math.subVec2(uv2, uv0, tempVec3d);

                    const r = 1 / ((deltaUV1[0] * deltaUV2[1]) - (deltaUV1[1] * deltaUV2[0]));

                    const tangent = math.mulVec3Scalar(
                        math.subVec3(
                            math.mulVec3Scalar(deltaPos1, deltaUV2[1], tempVec3e),
                            math.mulVec3Scalar(deltaPos2, deltaUV1[1], tempVec3f),
                            tempVec3g
                        ),
                        r,
                        tempVec3f
                    );

                    // Average the value of the vectors

                    let addTo;

                    for (let v = 0; v < 3; v++) {
                        addTo = indices[location + v] * 3;
                        tangents[addTo] += tangent[0];
                        tangents[addTo + 1] += tangent[1];
                        tangents[addTo + 2] += tangent[2];
                    }
                }

                return tangents;
            };
        }))(),

        /**
         * Builds vertex and index arrays needed by color-indexed triangle picking.
         *
         * @private
         */
        buildPickTriangles(positions, indices, compressGeometry) {

            const numIndices = indices.length;
            const pickPositions = compressGeometry ? new Uint16Array(numIndices * 9) : new Float32Array(numIndices * 9);
            const pickColors = new Uint8Array(numIndices * 12);
            let primIndex = 0;
            let vi;// Positions array index
            let pvi = 0;// Picking positions array index
            let pci = 0; // Picking color array index

            // Triangle indices
            let i;
            let r;
            let g;
            let b;
            let a;

            for (let location = 0; location < numIndices; location += 3) {

                // Primitive-indexed triangle pick color

                a = (primIndex >> 24 & 0xFF);
                b = (primIndex >> 16 & 0xFF);
                g = (primIndex >> 8 & 0xFF);
                r = (primIndex & 0xFF);

                // A

                i = indices[location];
                vi = i * 3;

                pickPositions[pvi++] = positions[vi];
                pickPositions[pvi++] = positions[vi + 1];
                pickPositions[pvi++] = positions[vi + 2];

                pickColors[pci++] = r;
                pickColors[pci++] = g;
                pickColors[pci++] = b;
                pickColors[pci++] = a;

                // B

                i = indices[location + 1];
                vi = i * 3;

                pickPositions[pvi++] = positions[vi];
                pickPositions[pvi++] = positions[vi + 1];
                pickPositions[pvi++] = positions[vi + 2];

                pickColors[pci++] = r;
                pickColors[pci++] = g;
                pickColors[pci++] = b;
                pickColors[pci++] = a;

                // C

                i = indices[location + 2];
                vi = i * 3;

                pickPositions[pvi++] = positions[vi];
                pickPositions[pvi++] = positions[vi + 1];
                pickPositions[pvi++] = positions[vi + 2];

                pickColors[pci++] = r;
                pickColors[pci++] = g;
                pickColors[pci++] = b;
                pickColors[pci++] = a;

                primIndex++;
            }

            return {
                positions: pickPositions,
                colors: pickColors
            };
        },

        /**
         * Converts surface-perpendicular face normals to vertex normals. Assumes that the mesh contains disjoint triangles
         * that don't share vertex array elements. Works by finding groups of vertices that have the same location and
         * averaging their normal vectors.
         *
         * @returns {{positions: Array, normals: *}}
         */
        faceToVertexNormals(positions, normals, options = {}) {
            const smoothNormalsAngleThreshold = options.smoothNormalsAngleThreshold || 20;
            const vertexMap = {};
            const vertexNormals = [];
            const vertexNormalAccum = {};
            let acc;
            let vx;
            let vy;
            let vz;
            let key;
            const precisionPoints = 4; // number of decimal points, e.g. 4 for epsilon of 0.0001
            const precision = 10 ** precisionPoints;
            let posi;
            let i;
            let j;
            let len;
            let a;
            let b;

            for (i = 0, len = positions.length; i < len; i += 3) {

                posi = i / 3;

                vx = positions[i];
                vy = positions[i + 1];
                vz = positions[i + 2];

                key = `${Math.round(vx * precision)}_${Math.round(vy * precision)}_${Math.round(vz * precision)}`;

                if (vertexMap[key] === undefined) {
                    vertexMap[key] = [posi];
                } else {
                    vertexMap[key].push(posi);
                }

                const normal = math.normalizeVec3([normals[i], normals[i + 1], normals[i + 2]]);

                vertexNormals[posi] = normal;

                acc = math.vec4([normal[0], normal[1], normal[2], 1]);

                vertexNormalAccum[posi] = acc;
            }

            for (key in vertexMap) {

                if (vertexMap.hasOwnProperty(key)) {

                    const vertices = vertexMap[key];
                    const numVerts = vertices.length;

                    for (i = 0; i < numVerts; i++) {

                        const ii = vertices[i];

                        acc = vertexNormalAccum[ii];

                        for (j = 0; j < numVerts; j++) {

                            if (i === j) {
                                continue;
                            }

                            const jj = vertices[j];

                            a = vertexNormals[ii];
                            b = vertexNormals[jj];

                            const angle = Math.abs(math.angleVec3(a, b) / math.DEGTORAD);

                            if (angle < smoothNormalsAngleThreshold) {

                                acc[0] += b[0];
                                acc[1] += b[1];
                                acc[2] += b[2];
                                acc[3] += 1.0;
                            }
                        }
                    }
                }
            }

            for (i = 0, len = normals.length; i < len; i += 3) {

                acc = vertexNormalAccum[i / 3];

                normals[i + 0] = acc[0] / acc[3];
                normals[i + 1] = acc[1] / acc[3];
                normals[i + 2] = acc[2] / acc[3];

            }
        },

        //------------------------------------------------------------------------------------------------------------------
        // Ray casting
        //------------------------------------------------------------------------------------------------------------------

        /**
         Transforms a ray by a matrix.
         @method transformRay
         @static
         @param {Number[]} matrix 4x4 matrix
         @param {Number[]} rayOrigin The ray origin
         @param {Number[]} rayDir The ray direction
         @param {Number[]} rayOriginDest The transformed ray origin
         @param {Number[]} rayDirDest The transformed ray direction
         */
        transformRay: ((() => {

            const tempVec4a = new FloatArrayType(4);
            const tempVec4b = new FloatArrayType(4);

            return (matrix, rayOrigin, rayDir, rayOriginDest, rayDirDest) => {

                tempVec4a[0] = rayOrigin[0];
                tempVec4a[1] = rayOrigin[1];
                tempVec4a[2] = rayOrigin[2];
                tempVec4a[3] = 1;

                math.transformVec4(matrix, tempVec4a, tempVec4b);

                rayOriginDest[0] = tempVec4b[0];
                rayOriginDest[1] = tempVec4b[1];
                rayOriginDest[2] = tempVec4b[2];

                tempVec4a[0] = rayDir[0];
                tempVec4a[1] = rayDir[1];
                tempVec4a[2] = rayDir[2];

                math.transformVec3(matrix, tempVec4a, tempVec4b);

                math.normalizeVec3(tempVec4b);

                rayDirDest[0] = tempVec4b[0];
                rayDirDest[1] = tempVec4b[1];
                rayDirDest[2] = tempVec4b[2];
            };
        }))(),

        /**
         Transforms a Canvas-space position into a World-space ray, in the context of a Camera.
         @method canvasPosToWorldRay
         @static
         @param {Number[]} viewMatrix View matrix
         @param {Number[]} projMatrix Projection matrix
         @param {Number[]} canvasPos The Canvas-space position.
         @param {Number[]} worldRayOrigin The World-space ray origin.
         @param {Number[]} worldRayDir The World-space ray direction.
         */
        canvasPosToWorldRay: ((() => {

            const tempMat4b = new FloatArrayType(16);
            const tempMat4c = new FloatArrayType(16);
            const tempVec4a = new FloatArrayType(4);
            const tempVec4b = new FloatArrayType(4);
            const tempVec4c = new FloatArrayType(4);
            const tempVec4d = new FloatArrayType(4);

            return (canvas, viewMatrix, projMatrix, canvasPos, worldRayOrigin, worldRayDir) => {

                const pvMat = math.mulMat4(projMatrix, viewMatrix, tempMat4b);
                const pvMatInverse = math.inverseMat4(pvMat, tempMat4c);

                // Calculate clip space coordinates, which will be in range
                // of x=[-1..1] and y=[-1..1], with y=(+1) at top

                const canvasWidth = canvas.width;
                const canvasHeight = canvas.height;

                const clipX = (canvasPos[0] - canvasWidth / 2) / (canvasWidth / 2);  // Calculate clip space coordinates
                const clipY = -(canvasPos[1] - canvasHeight / 2) / (canvasHeight / 2);

                tempVec4a[0] = clipX;
                tempVec4a[1] = clipY;
                tempVec4a[2] = -1;
                tempVec4a[3] = 1;

                math.transformVec4(pvMatInverse, tempVec4a, tempVec4b);
                math.mulVec4Scalar(tempVec4b, 1 / tempVec4b[3]);

                tempVec4c[0] = clipX;
                tempVec4c[1] = clipY;
                tempVec4c[2] = 1;
                tempVec4c[3] = 1;

                math.transformVec4(pvMatInverse, tempVec4c, tempVec4d);
                math.mulVec4Scalar(tempVec4d, 1 / tempVec4d[3]);

                worldRayOrigin[0] = tempVec4d[0];
                worldRayOrigin[1] = tempVec4d[1];
                worldRayOrigin[2] = tempVec4d[2];

                math.subVec3(tempVec4d, tempVec4b, worldRayDir);

                math.normalizeVec3(worldRayDir);
            };
        }))(),

        /**
         Transforms a Canvas-space position to a Mesh's Local-space coordinate system, in the context of a Camera.
         @method canvasPosToLocalRay
         @static
         @param {Camera} camera The Camera.
         @param {Mesh} mesh The Mesh.
         @param {Number[]} viewMatrix View matrix
         @param {Number[]} projMatrix Projection matrix
         @param {Number[]} worldMatrix Modeling matrix
         @param {Number[]} canvasPos The Canvas-space position.
         @param {Number[]} localRayOrigin The Local-space ray origin.
         @param {Number[]} localRayDir The Local-space ray direction.
         */
        canvasPosToLocalRay: ((() => {

            const worldRayOrigin = new FloatArrayType(3);
            const worldRayDir = new FloatArrayType(3);

            return (canvas, viewMatrix, projMatrix, worldMatrix, canvasPos, localRayOrigin, localRayDir) => {
                math.canvasPosToWorldRay(canvas, viewMatrix, projMatrix, canvasPos, worldRayOrigin, worldRayDir);
                math.worldRayToLocalRay(worldMatrix, worldRayOrigin, worldRayDir, localRayOrigin, localRayDir);
            };
        }))(),

        /**
         Transforms a ray from World-space to a Mesh's Local-space coordinate system.
         @method worldRayToLocalRay
         @static
         @param {Number[]} worldMatrix The World transform matrix
         @param {Number[]} worldRayOrigin The World-space ray origin.
         @param {Number[]} worldRayDir The World-space ray direction.
         @param {Number[]} localRayOrigin The Local-space ray origin.
         @param {Number[]} localRayDir The Local-space ray direction.
         */
        worldRayToLocalRay: ((() => {

            const tempMat4 = new FloatArrayType(16);
            const tempVec4a = new FloatArrayType(4);
            const tempVec4b = new FloatArrayType(4);

            return (worldMatrix, worldRayOrigin, worldRayDir, localRayOrigin, localRayDir) => {

                const modelMatInverse = math.inverseMat4(worldMatrix, tempMat4);

                tempVec4a[0] = worldRayOrigin[0];
                tempVec4a[1] = worldRayOrigin[1];
                tempVec4a[2] = worldRayOrigin[2];
                tempVec4a[3] = 1;

                math.transformVec4(modelMatInverse, tempVec4a, tempVec4b);

                localRayOrigin[0] = tempVec4b[0];
                localRayOrigin[1] = tempVec4b[1];
                localRayOrigin[2] = tempVec4b[2];

                math.transformVec3(modelMatInverse, worldRayDir, localRayDir);
            };
        }))(),

        buildKDTree: ((() => {

            const KD_TREE_MAX_DEPTH = 10;
            const KD_TREE_MIN_TRIANGLES = 20;

            const dimLength = new Float32Array();

            function buildNode(triangles, indices, positions, depth) {
                const aabb = new FloatArrayType(6);

                const node = {
                    triangles: null,
                    left: null,
                    right: null,
                    leaf: false,
                    splitDim: 0,
                    aabb
                };

                aabb[0] = aabb[1] = aabb[2] = Number.POSITIVE_INFINITY;
                aabb[3] = aabb[4] = aabb[5] = Number.NEGATIVE_INFINITY;

                let t;
                let len;

                for (t = 0, len = triangles.length; t < len; ++t) {
                    var ii = triangles[t] * 3;
                    for (let j = 0; j < 3; ++j) {
                        const pi = indices[ii + j] * 3;
                        if (positions[pi] < aabb[0]) {
                            aabb[0] = positions[pi];
                        }
                        if (positions[pi] > aabb[3]) {
                            aabb[3] = positions[pi];
                        }
                        if (positions[pi + 1] < aabb[1]) {
                            aabb[1] = positions[pi + 1];
                        }
                        if (positions[pi + 1] > aabb[4]) {
                            aabb[4] = positions[pi + 1];
                        }
                        if (positions[pi + 2] < aabb[2]) {
                            aabb[2] = positions[pi + 2];
                        }
                        if (positions[pi + 2] > aabb[5]) {
                            aabb[5] = positions[pi + 2];
                        }
                    }
                }

                if (triangles.length < KD_TREE_MIN_TRIANGLES || depth > KD_TREE_MAX_DEPTH) {
                    node.triangles = triangles;
                    node.leaf = true;
                    return node;
                }

                dimLength[0] = aabb[3] - aabb[0];
                dimLength[1] = aabb[4] - aabb[1];
                dimLength[2] = aabb[5] - aabb[2];

                let dim = 0;

                if (dimLength[1] > dimLength[dim]) {
                    dim = 1;
                }

                if (dimLength[2] > dimLength[dim]) {
                    dim = 2;
                }

                node.splitDim = dim;

                const mid = (aabb[dim] + aabb[dim + 3]) / 2;
                const left = new Array(triangles.length);
                let numLeft = 0;
                const right = new Array(triangles.length);
                let numRight = 0;

                for (t = 0, len = triangles.length; t < len; ++t) {

                    var ii = triangles[t] * 3;
                    const i0 = indices[ii];
                    const i1 = indices[ii + 1];
                    const i2 = indices[ii + 2];

                    const pi0 = i0 * 3;
                    const pi1 = i1 * 3;
                    const pi2 = i2 * 3;

                    if (positions[pi0 + dim] <= mid || positions[pi1 + dim] <= mid || positions[pi2 + dim] <= mid) {
                        left[numLeft++] = triangles[t];
                    } else {
                        right[numRight++] = triangles[t];
                    }
                }

                left.length = numLeft;
                right.length = numRight;

                node.left = buildNode(left, indices, positions, depth + 1);
                node.right = buildNode(right, indices, positions, depth + 1);

                return node;
            }

            return (indices, positions) => {
                const numTris = indices.length / 3;
                const triangles = new Array(numTris);
                for (let i = 0; i < numTris; ++i) {
                    triangles[i] = i;
                }
                return buildNode(triangles, indices, positions, 0);
            };
        }))(),


        decompressPosition(position, decodeMatrix, dest) {
            dest = dest || position;
            dest[0] = position[0] * decodeMatrix[0] + decodeMatrix[12];
            dest[1] = position[1] * decodeMatrix[5] + decodeMatrix[13];
            dest[2] = position[2] * decodeMatrix[10] + decodeMatrix[14];
        },

        decompressPositions(positions, decodeMatrix, dest = new Float32Array(positions.length)) {
            for (let i = 0, len = positions.length; i < len; i += 3) {
                dest[i + 0] = positions[i + 0] * decodeMatrix[0] + decodeMatrix[12];
                dest[i + 1] = positions[i + 1] * decodeMatrix[5] + decodeMatrix[13];
                dest[i + 2] = positions[i + 2] * decodeMatrix[10] + decodeMatrix[14];
            }
            return dest;
        },

        decompressUV(uv, decodeMatrix, dest) {
            dest[0] = uv[0] * decodeMatrix[0] + decodeMatrix[6];
            dest[1] = uv[1] * decodeMatrix[4] + decodeMatrix[7];
        },

        decompressUVs(uvs, decodeMatrix, dest = new Float32Array(uvs.length)) {
            for (let i = 0, len = uvs.length; i < len; i += 3) {
                dest[i + 0] = uvs[i + 0] * decodeMatrix[0] + decodeMatrix[6];
                dest[i + 1] = uvs[i + 1] * decodeMatrix[4] + decodeMatrix[7];
            }
            return dest;
        },

        octDecodeVec2(oct, result) {
            let x = oct[0];
            let y = oct[1];
            x = (2 * x + 1) / 255;
            y = (2 * y + 1) / 255;
            const z = 1 - Math.abs(x) - Math.abs(y);
            if (z < 0) {
                x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
                y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
            }
            const length = Math.sqrt(x * x + y * y + z * z);
            result[0] = x / length;
            result[1] = y / length;
            result[2] = z / length;
            return result;
        },

        octDecodeVec2s(octs, result) {
            for (let i = 0, j = 0, len = octs.length; i < len; i += 2) {
                let x = octs[i + 0];
                let y = octs[i + 1];
                x = (2 * x + 1) / 255;
                y = (2 * y + 1) / 255;
                const z = 1 - Math.abs(x) - Math.abs(y);
                if (z < 0) {
                    x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
                    y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
                }
                const length = Math.sqrt(x * x + y * y + z * z);
                result[j + 0] = x / length;
                result[j + 1] = y / length;
                result[j + 2] = z / length;
                j += 3;
            }
            return result;
        }
    };

    math.buildEdgeIndices = (function () {

        const uniquePositions = [];
        const indicesLookup = [];
        const indicesReverseLookup = [];
        const weldedIndices = [];

        // TODO: Optimize with caching, but need to cater to both compressed and uncompressed positions

        const faces = [];
        let numFaces = 0;
        const compa = new Uint16Array(3);
        const compb = new Uint16Array(3);
        const compc = new Uint16Array(3);
        const a = math.vec3();
        const b = math.vec3();
        const c = math.vec3();
        const cb = math.vec3();
        const ab = math.vec3();
        const cross = math.vec3();
        const normal = math.vec3();

        function weldVertices(positions, indices) {
            const positionsMap = {}; // Hashmap for looking up vertices by position coordinates (and making sure they are unique)
            let vx;
            let vy;
            let vz;
            let key;
            const precisionPoints = 4; // number of decimal points, e.g. 4 for epsilon of 0.0001
            const precision = Math.pow(10, precisionPoints);
            let i;
            let len;
            let lenUniquePositions = 0;
            for (i = 0, len = positions.length; i < len; i += 3) {
                vx = positions[i];
                vy = positions[i + 1];
                vz = positions[i + 2];
                key = Math.round(vx * precision) + '_' + Math.round(vy * precision) + '_' + Math.round(vz * precision);
                if (positionsMap[key] === undefined) {
                    positionsMap[key] = lenUniquePositions / 3;
                    uniquePositions[lenUniquePositions++] = vx;
                    uniquePositions[lenUniquePositions++] = vy;
                    uniquePositions[lenUniquePositions++] = vz;
                }
                indicesLookup[i / 3] = positionsMap[key];
            }
            for (i = 0, len = indices.length; i < len; i++) {
                weldedIndices[i] = indicesLookup[indices[i]];
                indicesReverseLookup[weldedIndices[i]] = indices[i];
            }
        }

        function buildFaces(numIndices, positionsDecodeMatrix) {
            numFaces = 0;
            for (let i = 0, len = numIndices; i < len; i += 3) {
                const ia = ((weldedIndices[i]) * 3);
                const ib = ((weldedIndices[i + 1]) * 3);
                const ic = ((weldedIndices[i + 2]) * 3);
                if (positionsDecodeMatrix) {
                    compa[0] = uniquePositions[ia];
                    compa[1] = uniquePositions[ia + 1];
                    compa[2] = uniquePositions[ia + 2];
                    compb[0] = uniquePositions[ib];
                    compb[1] = uniquePositions[ib + 1];
                    compb[2] = uniquePositions[ib + 2];
                    compc[0] = uniquePositions[ic];
                    compc[1] = uniquePositions[ic + 1];
                    compc[2] = uniquePositions[ic + 2];
                    // Decode
                    math.decompressPosition(compa, positionsDecodeMatrix, a);
                    math.decompressPosition(compb, positionsDecodeMatrix, b);
                    math.decompressPosition(compc, positionsDecodeMatrix, c);
                } else {
                    a[0] = uniquePositions[ia];
                    a[1] = uniquePositions[ia + 1];
                    a[2] = uniquePositions[ia + 2];
                    b[0] = uniquePositions[ib];
                    b[1] = uniquePositions[ib + 1];
                    b[2] = uniquePositions[ib + 2];
                    c[0] = uniquePositions[ic];
                    c[1] = uniquePositions[ic + 1];
                    c[2] = uniquePositions[ic + 2];
                }
                math.subVec3(c, b, cb);
                math.subVec3(a, b, ab);
                math.cross3Vec3(cb, ab, cross);
                math.normalizeVec3(cross, normal);
                const face = faces[numFaces] || (faces[numFaces] = {normal: math.vec3()});
                face.normal[0] = normal[0];
                face.normal[1] = normal[1];
                face.normal[2] = normal[2];
                numFaces++;
            }
        }

        return function (positions, indices, positionsDecodeMatrix, edgeThreshold) {
            weldVertices(positions, indices);
            buildFaces(indices.length, positionsDecodeMatrix);
            const edgeIndices = [];
            const thresholdDot = Math.cos(math.DEGTORAD * edgeThreshold);
            const edges = {};
            let edge1;
            let edge2;
            let index1;
            let index2;
            let key;
            let largeIndex = false;
            let edge;
            let normal1;
            let normal2;
            let dot;
            let ia;
            let ib;
            for (let i = 0, len = indices.length; i < len; i += 3) {
                const faceIndex = i / 3;
                for (let j = 0; j < 3; j++) {
                    edge1 = weldedIndices[i + j];
                    edge2 = weldedIndices[i + ((j + 1) % 3)];
                    index1 = Math.min(edge1, edge2);
                    index2 = Math.max(edge1, edge2);
                    key = index1 + "," + index2;
                    if (edges[key] === undefined) {
                        edges[key] = {
                            index1: index1,
                            index2: index2,
                            face1: faceIndex,
                            face2: undefined
                        };
                    } else {
                        edges[key].face2 = faceIndex;
                    }
                }
            }
            for (key in edges) {
                edge = edges[key];
                // an edge is only rendered if the angle (in degrees) between the face normals of the adjoining faces exceeds this value. default = 1 degree.
                if (edge.face2 !== undefined) {
                    normal1 = faces[edge.face1].normal;
                    normal2 = faces[edge.face2].normal;
                    dot = math.dotVec3(normal1, normal2);
                    if (dot > thresholdDot) {
                        continue;
                    }
                }
                ia = indicesReverseLookup[edge.index1];
                ib = indicesReverseLookup[edge.index2];
                if (!largeIndex && ia > 65535 || ib > 65535) {
                    largeIndex = true;
                }
                edgeIndices.push(ia);
                edgeIndices.push(ib);
            }
            return (largeIndex) ? new Uint32Array(edgeIndices) : new Uint16Array(edgeIndices);
        };
    })();


    /**
     * Returns `true` if a plane clips the given 3D positions.
     * @param {Number[]} pos Position in plane
     * @param {Number[]} dir Direction of plane
     * @param {number} positions Flat array of 3D positions.
     * @param {number} numElementsPerPosition Number of elements perposition - usually either 3 or 4.
     * @returns {boolean}
     */
    math.planeClipsPositions3 = function (pos, dir, positions, numElementsPerPosition = 3) {
        for (let i = 0, len = positions.length; i < len; i += numElementsPerPosition) {
            tempVec3a$2[0] = positions[i + 0] - pos[0];
            tempVec3a$2[1] = positions[i + 1] - pos[1];
            tempVec3a$2[2] = positions[i + 2] - pos[2];
            let dotProduct = tempVec3a$2[0] * dir[0] + tempVec3a$2[1] * dir[1] + tempVec3a$2[2] * dir[2];
            if (dotProduct < 0) {
                return true;
            }
        }
        return false;
    };

    /**
     * @private
     */
    var buildEdgeIndices = (function () {

        const uniquePositions = [];
        const indicesLookup = [];
        const indicesReverseLookup = [];
        const weldedIndices = [];

    // TODO: Optimize with caching, but need to cater to both compressed and uncompressed positions

        const faces = [];
        let numFaces = 0;
        const compa = new Uint16Array(3);
        const compb = new Uint16Array(3);
        const compc = new Uint16Array(3);
        const a = math.vec3();
        const b = math.vec3();
        const c = math.vec3();
        const cb = math.vec3();
        const ab = math.vec3();
        const cross = math.vec3();
        const normal = math.vec3();

        function weldVertices(positions, indices) {
            const positionsMap = {}; // Hashmap for looking up vertices by position coordinates (and making sure they are unique)
            let vx;
            let vy;
            let vz;
            let key;
            const precisionPoints = 4; // number of decimal points, e.g. 4 for epsilon of 0.0001
            const precision = Math.pow(10, precisionPoints);
            let i;
            let len;
            let lenUniquePositions = 0;
            for (i = 0, len = positions.length; i < len; i += 3) {
                vx = positions[i];
                vy = positions[i + 1];
                vz = positions[i + 2];
                key = Math.round(vx * precision) + '_' + Math.round(vy * precision) + '_' + Math.round(vz * precision);
                if (positionsMap[key] === undefined) {
                    positionsMap[key] = lenUniquePositions / 3;
                    uniquePositions[lenUniquePositions++] = vx;
                    uniquePositions[lenUniquePositions++] = vy;
                    uniquePositions[lenUniquePositions++] = vz;
                }
                indicesLookup[i / 3] = positionsMap[key];
            }
            for (i = 0, len = indices.length; i < len; i++) {
                weldedIndices[i] = indicesLookup[indices[i]];
                indicesReverseLookup[weldedIndices[i]] = indices[i];
            }
        }

        function buildFaces(numIndices, positionsDecodeMatrix) {
            numFaces = 0;
            for (let i = 0, len = numIndices; i < len; i += 3) {
                const ia = ((weldedIndices[i]) * 3);
                const ib = ((weldedIndices[i + 1]) * 3);
                const ic = ((weldedIndices[i + 2]) * 3);
                if (positionsDecodeMatrix) {
                    compa[0] = uniquePositions[ia];
                    compa[1] = uniquePositions[ia + 1];
                    compa[2] = uniquePositions[ia + 2];
                    compb[0] = uniquePositions[ib];
                    compb[1] = uniquePositions[ib + 1];
                    compb[2] = uniquePositions[ib + 2];
                    compc[0] = uniquePositions[ic];
                    compc[1] = uniquePositions[ic + 1];
                    compc[2] = uniquePositions[ic + 2];
                    // Decode
                    math.decompressPosition(compa, positionsDecodeMatrix, a);
                    math.decompressPosition(compb, positionsDecodeMatrix, b);
                    math.decompressPosition(compc, positionsDecodeMatrix, c);
                } else {
                    a[0] = uniquePositions[ia];
                    a[1] = uniquePositions[ia + 1];
                    a[2] = uniquePositions[ia + 2];
                    b[0] = uniquePositions[ib];
                    b[1] = uniquePositions[ib + 1];
                    b[2] = uniquePositions[ib + 2];
                    c[0] = uniquePositions[ic];
                    c[1] = uniquePositions[ic + 1];
                    c[2] = uniquePositions[ic + 2];
                }
                math.subVec3(c, b, cb);
                math.subVec3(a, b, ab);
                math.cross3Vec3(cb, ab, cross);
                math.normalizeVec3(cross, normal);
                const face = faces[numFaces] || (faces[numFaces] = {normal: math.vec3()});
                face.normal[0] = normal[0];
                face.normal[1] = normal[1];
                face.normal[2] = normal[2];
                numFaces++;
            }
        }

        return function (positions, indices, positionsDecodeMatrix, edgeThreshold) {
            weldVertices(positions, indices);
            buildFaces(indices.length, positionsDecodeMatrix);
            const edgeIndices = [];
            const thresholdDot = Math.cos(math.DEGTORAD * edgeThreshold);
            const edges = {};
            let edge1;
            let edge2;
            let index1;
            let index2;
            let key;
            let largeIndex = false;
            let edge;
            let normal1;
            let normal2;
            let dot;
            let ia;
            let ib;
            for (let i = 0, len = indices.length; i < len; i += 3) {
                const faceIndex = i / 3;
                for (let j = 0; j < 3; j++) {
                    edge1 = weldedIndices[i + j];
                    edge2 = weldedIndices[i + ((j + 1) % 3)];
                    index1 = Math.min(edge1, edge2);
                    index2 = Math.max(edge1, edge2);
                    key = index1 + "," + index2;
                    if (edges[key] === undefined) {
                        edges[key] = {
                            index1: index1,
                            index2: index2,
                            face1: faceIndex,
                            face2: undefined
                        };
                    } else {
                        edges[key].face2 = faceIndex;
                    }
                }
            }
            for (key in edges) {
                edge = edges[key];
                // an edge is only rendered if the angle (in degrees) between the face normals of the adjoining faces exceeds this value. default = 1 degree.
                if (edge.face2 !== undefined) {
                    normal1 = faces[edge.face1].normal;
                    normal2 = faces[edge.face2].normal;
                    dot = math.dotVec3(normal1, normal2);
                    if (dot > thresholdDot) {
                        continue;
                    }
                }
                ia = indicesReverseLookup[edge.index1];
                ib = indicesReverseLookup[edge.index2];
                if (!largeIndex && ia > 65535 || ib > 65535) {
                    largeIndex = true;
                }
                edgeIndices.push(ia);
                edgeIndices.push(ib);
            }
            return (largeIndex) ? new Uint32Array(edgeIndices) : new Uint16Array(edgeIndices);
        };
    })();

    const tempOBB3$1 = math.OBB3();
    const tempOBB3b = math.OBB3();
    const tempOBB3c = math.OBB3();

    /**
     * A mesh within a {@link SceneModel}.
     *
     * * Created with {@link SceneModel#createMesh}
     * * Belongs to exactly one {@link SceneModelEntity}
     * * Stored by ID in {@link SceneModel#meshes}
     * * Referenced by {@link SceneModelEntity#meshes}
     * * Can have a {@link SceneModelTransform} to dynamically scale, rotate and translate it.
     */
    class SceneModelMesh {

        /**
         * @private
         */
        constructor(model, id, color, opacity, transform, textureSet, layer = null, portionId = 0) {

            /**
             * The {@link SceneModel} that owns this SceneModelMesh.
             *
             * @type {SceneModel}
             */
            this.model = model;

            /**
             * The {@link SceneModelEntity} that owns this SceneModelMesh.
             *
             * @type {SceneModelEntity}
             */
            this.object = null;

            /**
             * @private
             */
            this.parent = null;

            /**
             * The {@link SceneModelTransform} that transforms this SceneModelMesh.
             *
             * * This only exists when the SceneModelMesh is instancing its geometry.
             * * These are created with {@link SceneModel#createTransform}
             * * Each of these is also registered in {@link SceneModel#transforms}.
             *
             * @type {SceneModelTransform}
             */
            this.transform = transform;

            /**
             * The {@link SceneModelTextureSet} that optionally textures this SceneModelMesh.
             *
             * * This only exists when the SceneModelMesh has texture.
             * * These are created with {@link SceneModel#createTextureSet}
             * * Each of these is also registered in {@link SceneModel#textureSets}.
             *
             * @type {SceneModelTextureSet}
             */
            this.textureSet = textureSet;

            this._matrixDirty = false;
            this._matrixUpdateScheduled = false;

            /**
             * Unique ID of this SceneModelMesh.
             *
             * The SceneModelMesh is registered against this ID in {@link SceneModel#meshes}.
             */
            this.id = id;

            /**
             * @private
             */
            this.obb = null;

            this._aabbLocal = null;
            this._aabbWorld = math.AABB3();
            this._aabbWorldDirty = false;

            /**
             * @private
             */
            // @reviser lijuhong 注释layer相关代码
            // this.layer = layer;

            /**
             * @private
             */
            this.portionId = portionId;

            this._color = new Uint8Array([color[0], color[1], color[2], opacity]); // [0..255]
            this._colorize = new Uint8Array([color[0], color[1], color[2], opacity]); // [0..255]
            this._colorizing = false;
            this._transparent = (opacity < 255);

            /**
             * @private
             */
            this.numTriangles = 0;

            /**
             * @private
             * @type {null}
             */
            this.origin = null; // Set By SceneModel

            /**
             * The {@link SceneModelEntity} that owns this SceneModelMesh.
             *
             * @type {SceneModelEntity}
             */
            this.entity = null;

            if (transform) {
                transform._addMesh(this);
            }
        }

        _sceneModelDirty() {
            this._aabbWorldDirty = true;
            // @reviser lijuhong 注释layer相关代码
            // this.layer.aabbDirty = true;
        }

        _transformDirty() {
            if (!this._matrixDirty && !this._matrixUpdateScheduled) {
                this.model._meshMatrixDirty(this);
                this._matrixDirty = true;
                this._matrixUpdateScheduled = true;
            }
            this._aabbWorldDirty = true;
            // @reviser lijuhong 注释layer相关代码
            // this.layer.aabbDirty = true;
            if (this.entity) {
                this.entity._transformDirty();
            }
        }

        _updateMatrix() {
            // @reviser lijuhong 注释layer相关代码
            // if (this.transform && this._matrixDirty) {
            //     this.layer.setMatrix(this.portionId, this.transform.worldMatrix);
            // }
            this._matrixDirty = false;
            this._matrixUpdateScheduled = false;
        }

        _finalize(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.initFlags(this.portionId, entityFlags, this._transparent);
        }

        _finalize2() {
            // @reviser lijuhong 注释layer相关代码
            // if (this.layer.flushInitFlags) {
            //     this.layer.flushInitFlags();
            // }
        }

        _setVisible(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setVisible(this.portionId, entityFlags, this._transparent);
        }

        _setColor(color) {
            this._color[0] = color[0];
            this._color[1] = color[1];
            this._color[2] = color[2];
            // @reviser lijuhong 注释layer相关代码
            // if (!this._colorizing) {
            //     this.layer.setColor(this.portionId, this._color, false);
            // }
        }

        _setColorize(colorize) {
            if (colorize) {
                this._colorize[0] = colorize[0];
                this._colorize[1] = colorize[1];
                this._colorize[2] = colorize[2];
                // @reviser lijuhong 注释layer相关代码
                // this.layer.setColor(this.portionId, this._colorize, setOpacity);
                this._colorizing = true;
            } else {
                // @reviser lijuhong 注释layer相关代码
                // this.layer.setColor(this.portionId, this._color, setOpacity);
                this._colorizing = false;
            }
        }

        _setOpacity(opacity, entityFlags) {
            const newTransparent = (opacity < 255);
            this._transparent;
            this._color[3] = opacity;
            this._colorize[3] = opacity;
            this._transparent = newTransparent;
            // @reviser lijuhong 注释layer相关代码
            // if (this._colorizing) {
            //     this.layer.setColor(this.portionId, this._colorize);
            // } else {
            //     this.layer.setColor(this.portionId, this._color);
            // }
            // if (changingTransparency) {
            //     this.layer.setTransparent(this.portionId, entityFlags, newTransparent);
            // }
        }

        _setOffset(offset) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setOffset(this.portionId, offset);
        }

        _setHighlighted(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setHighlighted(this.portionId, entityFlags, this._transparent);
        }

        _setXRayed(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setXRayed(this.portionId, entityFlags, this._transparent);
        }

        _setSelected(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setSelected(this.portionId, entityFlags, this._transparent);
        }

        _setEdges(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setEdges(this.portionId, entityFlags, this._transparent);
        }

        _setClippable(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setClippable(this.portionId, entityFlags, this._transparent);
        }

        _setCollidable(entityFlags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setCollidable(this.portionId, entityFlags);
        }

        _setPickable(flags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setPickable(this.portionId, flags, this._transparent);
        }

        _setCulled(flags) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.setCulled(this.portionId, flags, this._transparent);
        }

        /**
         * @private
         */
        canPickTriangle() {
            return false;
        }

        /**
         * @private
         */
        drawPickTriangles(renderFlags, frameCtx) {
            // NOP
        }

        /**
         * @private
         */
        pickTriangleSurface(pickResult) {
            // NOP
        }

        /**
         * @private
         */
        precisionRayPickSurface(worldRayOrigin, worldRayDir, worldSurfacePos, worldSurfaceNormal) {
            // @reviser lijuhong 注释layer相关代码
            // return this.layer.precisionRayPickSurface ? this.layer.precisionRayPickSurface(this.portionId, worldRayOrigin, worldRayDir, worldSurfacePos, worldSurfaceNormal) : false;
        }

        /**
         * @private
         */
        canPickWorldPos() {
            return true;
        }

        /**
         * @private
         */
        drawPickDepths(frameCtx) {
            this.model.drawPickDepths(frameCtx);
        }

        /**
         * @private
         */
        drawPickNormals(frameCtx) {
            this.model.drawPickNormals(frameCtx);
        }

        /**
         * @private
         */
        delegatePickedEntity() {
            return this.parent;
        }

        /**
         * @private
         */
        getEachVertex(callback) {
            // @reviser lijuhong 注释layer相关代码
            // this.layer.getEachVertex(this.portionId, callback);
        }

        /**
         * @private
         */
        set aabb(aabb) { // Called by SceneModel
            this._aabbLocal = aabb;
        }

        /**
         * @private
         */
        get aabb() { // called by SceneModelEntity
            if (this._aabbWorldDirty) {
                math.AABB3ToOBB3(this._aabbLocal, tempOBB3$1);
                if (this.transform) {
                    math.transformOBB3(this.transform.worldMatrix, tempOBB3$1, tempOBB3b);
                    math.transformOBB3(this.model.worldMatrix, tempOBB3b, tempOBB3c);
                    math.OBB3ToAABB3(tempOBB3c, this._aabbWorld);
                } else {
                    math.transformOBB3(this.model.worldMatrix, tempOBB3$1, tempOBB3b);
                    math.OBB3ToAABB3(tempOBB3b, this._aabbWorld);
                }
                if (this.origin) {
                    const origin = this.origin;
                    this._aabbWorld[0] += origin[0];
                    this._aabbWorld[1] += origin[1];
                    this._aabbWorld[2] += origin[2];
                    this._aabbWorld[3] += origin[0];
                    this._aabbWorld[4] += origin[1];
                    this._aabbWorld[5] += origin[2];
                }
                this._aabbWorldDirty = false;
            }
            return this._aabbWorld;
        }

        /**
         * @private
         */
        _destroy() {
            this.model.scene._renderer.putPickID(this.pickId);
        }
    }

    /**
     * Provides scratch memory for methods like TrianglesBatchingLayer setFlags() and setColors(),
     * so they don't need to allocate temporary arrays that need garbage collection.
     *
     * @private
     */
    class ScratchMemory {

        constructor() {
            this._uint8Arrays = {};
            this._float32Arrays = {};
        }

        _clear() {
            this._uint8Arrays = {};
            this._float32Arrays = {};
        }

        getUInt8Array(len) {
            let uint8Array = this._uint8Arrays[len];
            if (!uint8Array) {
                uint8Array = new Uint8Array(len);
                this._uint8Arrays[len] = uint8Array;
            }
            return uint8Array;
        }

        getFloat32Array(len) {
            let float32Array = this._float32Arrays[len];
            if (!float32Array) {
                float32Array = new Float32Array(len);
                this._float32Arrays[len] = float32Array;
            }
            return float32Array;
        }
    }

    const batchingLayerScratchMemory = new ScratchMemory();

    let countUsers = 0;

    /**
     * @private
     */
    function getScratchMemory() {
        countUsers++;
        return batchingLayerScratchMemory;
    }

    /**
     * @private
     */
    function putScratchMemory() {
        if (countUsers === 0) {
            return;
        }
        countUsers--;
        if (countUsers === 0) {
            batchingLayerScratchMemory._clear();
        }
    }

    /**
     * @private
     * @type {{PICKABLE: number, CLIPPABLE: number, BACKFACES: number, VISIBLE: number, SELECTED: number, OUTLINED: number, CULLED: number, RECEIVE_SHADOW: number, COLLIDABLE: number, XRAYED: number, CAST_SHADOW: number, EDGES: number, HIGHLIGHTED: number}}
     */
    const ENTITY_FLAGS = {
        VISIBLE: 1,
        CULLED: 1 << 2,
        PICKABLE: 1 << 3,
        CLIPPABLE: 1 << 4,
        COLLIDABLE: 1 << 5,
        CAST_SHADOW: 1 << 6,
        RECEIVE_SHADOW: 1 << 7,
        XRAYED: 1 << 8,
        HIGHLIGHTED: 1 << 9,
        SELECTED: 1 << 10,
        EDGES: 1 << 11,
        BACKFACES: 1 << 12,
        TRANSPARENT: 1 << 13
    };

    /**
     * Indicates what rendering needs to be done for the layers within a {@link Drawable}.
     *
     * Each Drawable has a RenderFlags in {@link Drawable#renderFlags}.
     *
     * Before rendering each frame, {@link Renderer} will call {@link Drawable#rebuildRenderFlags} on each {@link Drawable}.
     *
     * Then, when rendering a frame, Renderer will apply rendering passes to each Drawable according on what flags are set in {@link Drawable#renderFlags}.
     *
     * @private
     */
    class RenderFlags {

        /**
         * @private
         */
        constructor() {

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate which layers are visible within the {@link Drawable}.
             *
             * This is a list of IDs of visible layers within the {@link Drawable}. The IDs will be whatever the
             * {@link Drawable} uses to identify its layers, usually integers.
             *
             * @property visibleLayers
             * @type {Number[]}
             */
            this.visibleLayers = [];


            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate which {@link SectionPlane}s are active within each layer of the {@link Drawable}.
             *
             * Layout is as follows:
             *
             * ````[
             *      false, false, true, // Layer 0, SectionPlanes 0, 1, 2
             *      false, true, true,  // Layer 1, SectionPlanes 0, 1, 2
             *      true, false, true   // Layer 2, SectionPlanes 0, 1, 2
             * ]````
             *
             * @property sectionPlanesActivePerLayer
             * @type {Boolean[]}
             */
            this.sectionPlanesActivePerLayer = [];

            this.reset();
        }

        /**
         * @private
         */
        reset() {

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate whether the {@link Drawable} is culled.
             * 
             * When this is ````false````, then all of the other properties on ````RenderFlags```` will remain at their default values.
             * 
             * @property culled
             * @type {Boolean}
             */
            this.culled = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate whether the {@link Drawable} is sliced by any {@link SectionPlane}s.
             *
             * @property sectioned
             * @type {Boolean}
             */
            this.sectioned  = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the number of layers within the {@link Drawable}.
             *
             * @property numLayers
             * @type {Number}
             */
            this.numLayers = 0;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the number of visible layers within the {@link Drawable}.
             *
             * @property numVisibleLayers
             * @type {Number}
             */
            this.numVisibleLayers = 0;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs {@link Drawable#drawColorOpaque}.
             * @property colorOpaque
             * @type {boolean}
             */
            this.colorOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs {@link Drawable#drawColorTransparent}.
             * @property colorTransparent
             * @type {boolean}
             */
            this.colorTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs {@link Drawable#drawEdgesColorOpaque}.
             * @property edgesOpaque
             * @type {boolean}
             */
            this.edgesOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs {@link Drawable#drawEdgesColorTransparent}.
             * @property edgesTransparent
             * @type {boolean}
             */
            this.edgesTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawSilhouetteXRayed}.
             * @property xrayedSilhouetteOpaque
             * @type {boolean}
             */
            this.xrayedSilhouetteOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawEdgesXRayed}.
             * @property xrayedEdgesOpaque
             * @type {boolean}
             */
            this.xrayedEdgesOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawSilhouetteXRayed}.
             * @property xrayedSilhouetteTransparent
             * @type {boolean}
             */
            this.xrayedSilhouetteTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawEdgesXRayed}.
             * @property xrayedEdgesTransparent
             * @type {boolean}
             */
            this.xrayedEdgesTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawSilhouetteHighlighted}.
             * @property highlightedSilhouetteOpaque
             * @type {boolean}
             */
            this.highlightedSilhouetteOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawEdgesHighlighted}.
             * @property highlightedEdgesOpaque
             * @type {boolean}
             */
            this.highlightedEdgesOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawSilhouetteHighlighted}.
             * @property highlightedSilhouetteTransparent
             * @type {boolean}
             */
            this.highlightedSilhouetteTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawEdgesHighlighted}.
             * @property highlightedEdgesTransparent
             * @type {boolean}
             */
            this.highlightedEdgesTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawSilhouetteSelected}.
             * @property selectedSilhouetteOpaque
             * @type {boolean}
             */
            this.selectedSilhouetteOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs an opaque {@link Drawable#drawEdgesSelected}.
             * @property selectedEdgesOpaque
             * @type {boolean}
             */
            this.selectedEdgesOpaque = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawSilhouetteSelected}.
             * @property selectedSilhouetteTransparent
             * @type {boolean}
             */
            this.selectedSilhouetteTransparent = false;

            /**
             * Set by {@link Drawable#rebuildRenderFlags} to indicate the {@link Drawable} needs a transparent {@link Drawable#drawEdgesSelected}.
             * @property selectedEdgesTransparent
             * @type {boolean}
             */
            this.selectedEdgesTransparent = false;
        }
    }

    const tempVec3a$1 = math.vec3();


    /**
     * Converts a flat array of double-precision positions to RTC positions, if necessary.
     *
     * Conversion is necessary if the coordinates have values larger than can be expressed at single-precision. When
     * that's the case, then this function will compute the RTC coordinates and RTC center and return true. Otherwise
     * this function does nothing and returns false.
     *
     * When computing the RTC position, this function uses a modulus operation to ensure that, whenever possible,
     * identical RTC centers are reused for different positions arrays.
     *
     * @private
     * @param {Float64Array} worldPositions Flat array of World-space 3D positions.
     * @param {Float64Array} rtcPositions Outputs the computed flat array of 3D RTC positions.
     * @param {Float64Array} rtcCenter Outputs the computed double-precision relative-to-center (RTC) center pos.
     * @param {Number} [cellSize=10000000] The size of each coordinate cell within the RTC coordinate system.
     * @returns {Boolean} ````True```` if the positions actually needed conversion to RTC, else ````false````. When
     * ````false````, we can safely ignore the data returned in ````rtcPositions```` and ````rtcCenter````,
     * since ````rtcCenter```` will equal ````[0,0,0]````, and ````rtcPositions```` will contain identical values to ````positions````.
     */
    function worldToRTCPositions(worldPositions, rtcPositions, rtcCenter, cellSize = 1000) {

        const center = math.getPositionsCenter(worldPositions, tempVec3a$1);

        const rtcCenterX = Math.round(center[0] / cellSize) * cellSize;
        const rtcCenterY = Math.round(center[1] / cellSize) * cellSize;
        const rtcCenterZ = Math.round(center[2] / cellSize) * cellSize;

        rtcCenter[0] = rtcCenterX;
        rtcCenter[1] = rtcCenterY;
        rtcCenter[2] = rtcCenterZ;

        const rtcNeeded = (rtcCenter[0] !== 0 || rtcCenter[1] !== 0 || rtcCenter[2] !== 0);

        if (rtcNeeded) {
            for (let i = 0, len = worldPositions.length; i < len; i += 3) {
                rtcPositions[i + 0] = worldPositions[i + 0] - rtcCenterX;
                rtcPositions[i + 1] = worldPositions[i + 1] - rtcCenterY;
                rtcPositions[i + 2] = worldPositions[i + 2] - rtcCenterZ;
            }
        }

        return rtcNeeded;
    }

    /**
     * A texture set within a {@link SceneModel}.
     *
     * * Created with {@link SceneModel#createTextureSet}
     * * Belongs to many {@link SceneModelMesh}es
     * * Stored by ID in {@link SceneModel#textureSets}
     * * Referenced by {@link SceneModelMesh#textureSet}
     */
    class SceneModelTextureSet {

        /**
         * @private
         */
        constructor(cfg) {

            /**
             * Unique ID of this SceneModelTextureSet.
             *
             * The SceneModelTextureSet is registered against this ID in {@link SceneModel#textureSets}.
             */
            this.id = cfg.id;

            /**
             * The color texture.
             * @type {SceneModelTexture|*}
             */
            this.colorTexture = cfg.colorTexture;

            /**
             * The metallic-roughness texture.
             * @type {SceneModelTexture|*}
             */
            this.metallicRoughnessTexture = cfg.metallicRoughnessTexture;

            /**
             * The normal map texture.
             * @type {SceneModelTexture|*}
             */
            this.normalsTexture = cfg.normalsTexture;

            /**
             * The emissive color texture.
             * @type {SceneModelTexture|*}
             */
            this.emissiveTexture = cfg.emissiveTexture;

            /**
             * The ambient occlusion texture.
             * @type {SceneModelTexture|*}
             */
            this.occlusionTexture = cfg.occlusionTexture;
        }

        /**
         * @private
         */
        destroy() {
        }
    }

    /**
     * Texture wrapping mode in which the texture repeats to infinity.
     */
    const RepeatWrapping = 1000;

    /**
     * Texture wrapping mode in which the last pixel of the texture stretches to the edge of the mesh.
     */
    const ClampToEdgeWrapping = 1001;

    /**
     * Texture wrapping mode in which the texture repeats to infinity, mirroring on each repeat.
     */
    const MirroredRepeatWrapping = 1002;

    /**
     * Texture magnification and minification filter that returns the nearest texel to the given sample coordinates.
     */
    const NearestFilter = 1003;

    /**
     * Texture minification filter that chooses the mipmap that most closely matches the size of the pixel being textured and returns the nearest texel to the given sample coordinates.
     */
    const NearestMipMapNearestFilter = 1004;

    /**
     * Texture minification filter that chooses two mipmaps that most closely match the size of the pixel being textured
     * and returns the nearest texel to the center of the pixel at the given sample coordinates.
     */
    const NearestMipMapLinearFilter = 1005;

    /**
     * Texture magnification and minification filter that returns the weighted average of the four nearest texels to the given sample coordinates.
     */
    const LinearFilter = 1006;

    /**
     * Texture minification filter that chooses the mipmap that most closely matches the size of the pixel being textured and
     * returns the weighted average of the four nearest texels to the given sample coordinates.
     */
    const LinearMipMapNearestFilter = 1007;

    /**
     * Texture minification filter that chooses two mipmaps that most closely match the size of the pixel being textured,
     * finds within each mipmap the weighted average of the nearest texel to the center of the pixel, then returns the
     * weighted average of those two values.
     */
    const LinearMipmapLinearFilter = 1008;

    /**
     * Texture encoding mode in which the texture image is in linear color space.
     */
    const LinearEncoding = 3000;

    /**
     * Texture encoding mode in which the texture image is in sRGB color space.
     */
    const sRGBEncoding = 3001;

    /**
     * Media type for JPEG images.
     */
    const JPEGMediaType = 10001;

    /**
     * Media type for PNG images.
     */
    const PNGMediaType = 10002;

    const translate = math.mat4();
    const scale = math.mat4();

    /**
     * @private
     */
    function quantizePositions(positions, aabb, positionsDecodeMatrix) { // http://cg.postech.ac.kr/research/mesh_comp_mobile/mesh_comp_mobile_conference.pdf
        const lenPositions = positions.length;
        const quantizedPositions = new Uint16Array(lenPositions);
        const xmin = aabb[0];
        const ymin = aabb[1];
        const zmin = aabb[2];
        const xwid = aabb[3] - xmin;
        const ywid = aabb[4] - ymin;
        const zwid = aabb[5] - zmin;
        const maxInt = 65525;
        const xMultiplier = maxInt / xwid;
        const yMultiplier = maxInt / ywid;
        const zMultiplier = maxInt / zwid;
        const verify = (num) => num >= 0 ? num : 0;
        for (let i = 0; i < lenPositions; i += 3) {
            quantizedPositions[i + 0] = Math.floor(verify(positions[i + 0] - xmin) * xMultiplier);
            quantizedPositions[i + 1] = Math.floor(verify(positions[i + 1] - ymin) * yMultiplier);
            quantizedPositions[i + 2] = Math.floor(verify(positions[i + 2] - zmin) * zMultiplier);
        }
        math.identityMat4(translate);
        math.translationMat4v(aabb, translate);
        math.identityMat4(scale);
        math.scalingMat4v([xwid / maxInt, ywid / maxInt, zwid / maxInt], scale);
        math.mulMat4(translate, scale, positionsDecodeMatrix);
        return quantizedPositions;
    }

    /**
     * @private
     * @param aabb
     * @param positionsDecodeMatrix
     * @returns {*}
     */
    function createPositionsDecodeMatrix$1(aabb, positionsDecodeMatrix) { // http://cg.postech.ac.kr/research/mesh_comp_mobile/mesh_comp_mobile_conference.pdf
        const xmin = aabb[0];
        const ymin = aabb[1];
        const zmin = aabb[2];
        const xwid = aabb[3] - xmin;
        const ywid = aabb[4] - ymin;
        const zwid = aabb[5] - zmin;
        const maxInt = 65525;
        math.identityMat4(translate);
        math.translationMat4v(aabb, translate);
        math.identityMat4(scale);
        math.scalingMat4v([xwid / maxInt, ywid / maxInt, zwid / maxInt], scale);
        math.mulMat4(translate, scale, positionsDecodeMatrix);
        return positionsDecodeMatrix;
    }

    /**
     * @author https://github.com/tmarti, with support from https://tribia.com/
     * @license MIT
     *
     * This file takes a geometry given by { positionsCompressed, indices }, and returns
     * equivalent { positionsCompressed, indices } arrays but which only contain unique
     * positionsCompressed.
     *
     * The time is O(N logN) with the number of positionsCompressed due to a pre-sorting
     * step, but is much more GC-friendly and actually faster than the classic O(N)
     * approach based in keeping a hash-based LUT to identify unique positionsCompressed.
     */
    let comparePositions = null;

    function compareVertex(a, b) {
        let res;
        for (let i = 0; i < 3; i++) {
            if (0 !== (res = comparePositions[a * 3 + i] - comparePositions[b * 3 + i])) {
                return res;
            }
        }
        return 0;
    }

    let seqInit = null;

    function setMaxNumberOfPositions(maxPositions) {
        if (seqInit !== null && seqInit.length >= maxPositions) {
            return;
        }
        seqInit = new Uint32Array(maxPositions);
        for (let i = 0; i < maxPositions; i++) {
            seqInit[i] = i;
        }
    }

    /**
     * This function obtains unique positionsCompressed in the provided object
     * .positionsCompressed array and calculates an index mapping, which is then
     * applied to the provided object .indices and .edgeindices.
     *
     * The input object items are not modified, and instead new set
     * of positionsCompressed, indices and edgeIndices with the applied optimization
     * are returned.
     *
     * The algorithm, instead of being based in a hash-like LUT for
     * identifying unique positionsCompressed, is based in pre-sorting the input
     * positionsCompressed...
     *
     * (it's possible to define a _"consistent ordering"_ for the positionsCompressed
     *  as positionsCompressed are quantized and thus not suffer from float number
     *  comparison artifacts)
     *
     * ... so same positionsCompressed are adjacent in the sorted array, and then
     * it's easy to scan linearly the sorted array. During the linear run,
     * we will know that we found a different position because the comparison
     * function will return != 0 between current and previous element.
     *
     * During this linear traversal of the array, a `unique counter` is used
     * in order to calculate the mapping between original indices and unique
     * indices.
     *
     * @param {{positionsCompressed: number[],indices: number[], edgeIndices: number[]}} mesh The input mesh to process, with `positionsCompressed`, `indices` and `edgeIndices` keys.
     *
     * @returns {[Uint16Array, Uint32Array, Uint32Array]} An array with 3 elements: 0 => the uniquified positionsCompressed; 1 and 2 => the remapped edges and edgeIndices arrays
     */
    function uniquifyPositions(mesh) {
        const _positions = mesh.positionsCompressed;
        const _indices = mesh.indices;
        const _edgeIndices = mesh.edgeIndices;

        setMaxNumberOfPositions(_positions.length / 3);

        const seq = seqInit.slice(0, _positions.length / 3);
        const remappings = seqInit.slice(0, _positions.length / 3);

        comparePositions = _positions;

        seq.sort(compareVertex);

        let uniqueIdx = 0;

        remappings[seq[0]] = 0;

        for (let i = 1, len = seq.length; i < len; i++) {
            if (0 !== compareVertex(seq[i], seq[i - 1])) {
                uniqueIdx++;
            }
            remappings[seq[i]] = uniqueIdx;
        }

        const numUniquePositions = uniqueIdx + 1;
        const newPositions = new Uint16Array(numUniquePositions * 3);

        uniqueIdx = 0;

        newPositions [uniqueIdx * 3 + 0] = _positions [seq[0] * 3 + 0];
        newPositions [uniqueIdx * 3 + 1] = _positions [seq[0] * 3 + 1];
        newPositions [uniqueIdx * 3 + 2] = _positions [seq[0] * 3 + 2];

        for (let i = 1, len = seq.length; i < len; i++) {
            if (0 !== compareVertex(seq[i], seq[i - 1])) {
                uniqueIdx++;
                newPositions [uniqueIdx * 3 + 0] = _positions [seq[i] * 3 + 0];
                newPositions [uniqueIdx * 3 + 1] = _positions [seq[i] * 3 + 1];
                newPositions [uniqueIdx * 3 + 2] = _positions [seq[i] * 3 + 2];
            }
            remappings[seq[i]] = uniqueIdx;
        }

        comparePositions = null;

        const newIndices = new Uint32Array(_indices.length);

        for (let i = 0, len = _indices.length; i < len; i++) {
            newIndices[i] = remappings [_indices[i]];
        }

        const newEdgeIndices = new Uint32Array(_edgeIndices.length);

        for (let i = 0, len = _edgeIndices.length; i < len; i++) {
            newEdgeIndices[i] = remappings [_edgeIndices[i]];
        }

        return [newPositions, newIndices, newEdgeIndices];
    }

    /**
     * @author https://github.com/tmarti, with support from https://tribia.com/
     * @license MIT
     **/

    const MAX_RE_BUCKET_FAN_OUT = 8;

    let bucketsForIndices = null;

    function compareBuckets(a, b) {
        const aa = a * 3;
        const bb = b * 3;
        let aa1, aa2, aa3, bb1, bb2, bb3;
        const minBucketA = Math.min(
            aa1 = bucketsForIndices[aa],
            aa2 = bucketsForIndices[aa + 1],
            aa3 = bucketsForIndices[aa + 2]
        );
        const minBucketB = Math.min(
            bb1 = bucketsForIndices[bb],
            bb2 = bucketsForIndices[bb + 1],
            bb3 = bucketsForIndices[bb + 2]
        );
        if (minBucketA !== minBucketB) {
            return minBucketA - minBucketB;
        }
        const maxBucketA = Math.max(aa1, aa2, aa3);
        const maxBucketB = Math.max(bb1, bb2, bb3,);
        if (maxBucketA !== maxBucketB) {
            return maxBucketA - maxBucketB;
        }
        return 0;
    }

    function preSortIndices(indices, bitsPerBucket) {
        const seq = new Int32Array(indices.length / 3);
        for (let i = 0, len = seq.length; i < len; i++) {
            seq[i] = i;
        }
        bucketsForIndices = new Int32Array(indices.length);
        for (let i = 0, len = indices.length; i < len; i++) {
            bucketsForIndices[i] = indices[i] >> bitsPerBucket;
        }
        seq.sort(compareBuckets);
        const sortedIndices = new Int32Array(indices.length);
        for (let i = 0, len = seq.length; i < len; i++) {
            sortedIndices[i * 3 + 0] = indices[seq[i] * 3 + 0];
            sortedIndices[i * 3 + 1] = indices[seq[i] * 3 + 1];
            sortedIndices[i * 3 + 2] = indices[seq[i] * 3 + 2];
        }
        return sortedIndices;
    }

    let compareEdgeIndices = null;

    function compareIndices(a, b) {
        let retVal = compareEdgeIndices[a * 2] - compareEdgeIndices[b * 2];
        if (retVal !== 0) {
            return retVal;
        }
        return compareEdgeIndices[a * 2 + 1] - compareEdgeIndices[b * 2 + 1];
    }

    function preSortEdgeIndices(edgeIndices) {
        if ((edgeIndices || []).length === 0) {
            return [];
        }
        let seq = new Int32Array(edgeIndices.length / 2);
        for (let i = 0, len = seq.length; i < len; i++) {
            seq[i] = i;
        }
        for (let i = 0, j = 0, len = edgeIndices.length; i < len; i += 2) {
            if (edgeIndices[i] > edgeIndices[i + 1]) {
                let tmp = edgeIndices[i];
                edgeIndices[i] = edgeIndices[i + 1];
                edgeIndices[i + 1] = tmp;
            }
        }
        compareEdgeIndices = new Int32Array(edgeIndices);
        seq.sort(compareIndices);
        const sortedEdgeIndices = new Int32Array(edgeIndices.length);
        for (let i = 0, len = seq.length; i < len; i++) {
            sortedEdgeIndices[i * 2 + 0] = edgeIndices[seq[i] * 2 + 0];
            sortedEdgeIndices[i * 2 + 1] = edgeIndices[seq[i] * 2 + 1];
        }
        return sortedEdgeIndices;
    }

    /**
     * @param {{positionsCompressed: number[], indices: number[], edgeIndices: number[]}} mesh 
     * @param {number} bitsPerBucket 
     * @param {boolean} checkResult 
     * 
     * @returns {{positionsCompressed: number[], indices: number[], edgeIndices: number[]}[]}
     */
    function rebucketPositions(mesh, bitsPerBucket, checkResult = false) {
        const positionsCompressed = (mesh.positionsCompressed || []);
        const indices = preSortIndices(mesh.indices || [], bitsPerBucket);
        const edgeIndices = preSortEdgeIndices(mesh.edgeIndices || []);

        function edgeSearch(el0, el1) { // Code adapted from https://stackoverflow.com/questions/22697936/binary-search-in-javascript
            if (el0 > el1) {
                let tmp = el0;
                el0 = el1;
                el1 = tmp;
            }

            function compare_fn(a, b) {
                if (a !== el0) {
                    return el0 - a;
                }
                if (b !== el1) {
                    return el1 - b;
                }
                return 0;
            }

            let m = 0;
            let n = (edgeIndices.length >> 1) - 1;
            while (m <= n) {
                const k = (n + m) >> 1;
                const cmp = compare_fn(edgeIndices[k * 2], edgeIndices[k * 2 + 1]);
                if (cmp > 0) {
                    m = k + 1;
                } else if (cmp < 0) {
                    n = k - 1;
                } else {
                    return k;
                }
            }
            return -m - 1;
        }

        const alreadyOutputEdgeIndices = new Int32Array(edgeIndices.length / 2);
        alreadyOutputEdgeIndices.fill(0);

        const numPositions = positionsCompressed.length / 3;

        if (numPositions > ((1 << bitsPerBucket) * MAX_RE_BUCKET_FAN_OUT)) {
            return [mesh];
        }

        const bucketIndicesRemap = new Int32Array(numPositions);
        bucketIndicesRemap.fill(-1);

        const buckets = [];

        function addEmptyBucket() {
            bucketIndicesRemap.fill(-1);

            const newBucket = {
                positionsCompressed: [],
                indices: [],
                edgeIndices: [],
                maxNumPositions: (1 << bitsPerBucket) - bitsPerBucket,
                numPositions: 0,
                bucketNumber: buckets.length,
            };

            buckets.push(newBucket);

            return newBucket;
        }

        let currentBucket = addEmptyBucket();

        for (let i = 0, len = indices.length; i < len; i += 3) {
            let additonalPositionsInBucket = 0;

            const ii0 = indices[i];
            const ii1 = indices[i + 1];
            const ii2 = indices[i + 2];

            if (bucketIndicesRemap[ii0] === -1) {
                additonalPositionsInBucket++;
            }

            if (bucketIndicesRemap[ii1] === -1) {
                additonalPositionsInBucket++;
            }

            if (bucketIndicesRemap[ii2] === -1) {
                additonalPositionsInBucket++;
            }

            if ((additonalPositionsInBucket + currentBucket.numPositions) > currentBucket.maxNumPositions) {
                currentBucket = addEmptyBucket();
            }

            if (currentBucket.bucketNumber > MAX_RE_BUCKET_FAN_OUT) {
                return [mesh];
            }

            if (bucketIndicesRemap[ii0] === -1) {
                bucketIndicesRemap[ii0] = currentBucket.numPositions++;
                currentBucket.positionsCompressed.push(positionsCompressed[ii0 * 3]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii0 * 3 + 1]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii0 * 3 + 2]);
            }

            if (bucketIndicesRemap[ii1] === -1) {
                bucketIndicesRemap[ii1] = currentBucket.numPositions++;
                currentBucket.positionsCompressed.push(positionsCompressed[ii1 * 3]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii1 * 3 + 1]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii1 * 3 + 2]);
            }

            if (bucketIndicesRemap[ii2] === -1) {
                bucketIndicesRemap[ii2] = currentBucket.numPositions++;
                currentBucket.positionsCompressed.push(positionsCompressed[ii2 * 3]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii2 * 3 + 1]);
                currentBucket.positionsCompressed.push(positionsCompressed[ii2 * 3 + 2]);
            }

            currentBucket.indices.push(bucketIndicesRemap[ii0]);
            currentBucket.indices.push(bucketIndicesRemap[ii1]);
            currentBucket.indices.push(bucketIndicesRemap[ii2]);

            // Check possible edge1
            let edgeIndex;

            if ((edgeIndex = edgeSearch(ii0, ii1)) >= 0) {
                if (alreadyOutputEdgeIndices[edgeIndex] === 0) {
                    alreadyOutputEdgeIndices[edgeIndex] = 1;

                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2]]);
                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2 + 1]]);
                }
            }

            if ((edgeIndex = edgeSearch(ii0, ii2)) >= 0) {
                if (alreadyOutputEdgeIndices[edgeIndex] === 0) {
                    alreadyOutputEdgeIndices[edgeIndex] = 1;

                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2]]);
                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2 + 1]]);
                }
            }

            if ((edgeIndex = edgeSearch(ii1, ii2)) >= 0) {
                if (alreadyOutputEdgeIndices[edgeIndex] === 0) {
                    alreadyOutputEdgeIndices[edgeIndex] = 1;

                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2]]);
                    currentBucket.edgeIndices.push(bucketIndicesRemap[edgeIndices[edgeIndex * 2 + 1]]);
                }
            }
        }

        const prevBytesPerIndex = bitsPerBucket / 8 * 2;
        const newBytesPerIndex = bitsPerBucket / 8;

        const originalSize = positionsCompressed.length * 2 + (indices.length + edgeIndices.length) * prevBytesPerIndex;

        let newSize = 0;
        let newPositions = -positionsCompressed.length / 3;

        buckets.forEach(bucket => {
            newSize += bucket.positionsCompressed.length * 2 + (bucket.indices.length + bucket.edgeIndices.length) * newBytesPerIndex;
            newPositions += bucket.positionsCompressed.length / 3;
        });
        if (newSize > originalSize) {
            return [mesh];
        }
        if (checkResult) {
            doCheckResult(buckets, mesh);
        }
        return buckets;
    }

    function doCheckResult(buckets, mesh) {
        const meshDict = {};

        let edgeIndicesCount = 0;

        buckets.forEach(bucket => {
            const indices = bucket.indices;
            const edgeIndices = bucket.edgeIndices;
            const positionsCompressed = bucket.positionsCompressed;

            for (let i = 0, len = indices.length; i < len; i += 3) {
                const key = positionsCompressed[indices[i] * 3] + "_" + positionsCompressed[indices[i] * 3 + 1] + "_" + positionsCompressed[indices[i] * 3 + 2] + "/" +
                    positionsCompressed[indices[i + 1] * 3] + "_" + positionsCompressed[indices[i + 1] * 3 + 1] + "_" + positionsCompressed[indices[i + 1] * 3 + 2] + "/" +
                    positionsCompressed[indices[i + 2] * 3] + "_" + positionsCompressed[indices[i + 2] * 3 + 1] + "_" + positionsCompressed[indices[i + 2] * 3 + 2];
                meshDict[key] = true;
            }

            edgeIndicesCount += bucket.edgeIndices.length / 2;

            for (let i = 0, len = edgeIndices.length; i < len; i += 2) {
                positionsCompressed[edgeIndices[i] * 3] + "_" + positionsCompressed[edgeIndices[i] * 3 + 1] + "_" + positionsCompressed[edgeIndices[i] * 3 + 2] + "/" +
                    positionsCompressed[edgeIndices[i + 1] * 3] + "_" + positionsCompressed[edgeIndices[i + 1] * 3 + 1] + "_" + positionsCompressed[edgeIndices[i + 1] * 3 + 2] + "/";
            }
        });

        {
            const indices = mesh.indices;
            mesh.edgeIndices;
            const positionsCompressed = mesh.positionsCompressed;

            for (let i = 0, len = indices.length; i < len; i += 3) {
                const key = positionsCompressed[indices[i] * 3] + "_" + positionsCompressed[indices[i] * 3 + 1] + "_" + positionsCompressed[indices[i] * 3 + 2] + "/" +
                    positionsCompressed[indices[i + 1] * 3] + "_" + positionsCompressed[indices[i + 1] * 3 + 1] + "_" + positionsCompressed[indices[i + 1] * 3 + 2] + "/" +
                    positionsCompressed[indices[i + 2] * 3] + "_" + positionsCompressed[indices[i + 2] * 3 + 1] + "_" + positionsCompressed[indices[i + 2] * 3 + 2];

                if (!(key in meshDict)) {
                    console.log("Not found " + key);
                    throw "Ohhhh!";
                }
            }

            //  for (var i = 0, len = edgeIndices.length; i < len; i+=2)
            //  {
            //      var key = positionsCompressed[edgeIndices[i]*3] + "_" + positionsCompressed[edgeIndices[i]*3+1] + "_" + positionsCompressed[edgeIndices[i]*3+2] + "/" +
            //                positionsCompressed[edgeIndices[i+1]*3] + "_" + positionsCompressed[edgeIndices[i+1]*3+1] + "_" + positionsCompressed[edgeIndices[i+1]*3+2] + "/";

            //      if (!(key in edgesDict)) {
            //          var key2 = edgeIndices[i] + "_" + edgeIndices[i+1];

            //          console.log ("   - Not found " + key);
            //          console.log ("   - Not found " + key2);
            //         //  throw "Ohhhh2!";
            //      }
            //  }
        }
    }

    const tempFloatRGB = new Float32Array([0, 0, 0]);
    const tempIntRGB = new Uint16Array([0, 0, 0]);

    math.OBB3();

    /**
     * An entity within a {@link SceneModel}
     *
     * * Created with {@link SceneModel#createEntity}
     * * Stored by ID in {@link SceneModel#entities}
     * * Has one or more {@link SceneModelMesh}es
     *
     * @implements {Entity}
     */
    class SceneModelEntity {

        /**
         * @private
         */
        constructor(model, isObject, id, meshes, flags, lodCullable) {

            this._isObject = isObject;

            /**
             * The {@link Scene} to which this SceneModelEntity belongs.
             */
            // @reviser lijuhong 注释scene相关代码
            // this.scene = model.scene;

            /**
             * The {@link SceneModel} to which this SceneModelEntity belongs.
             */
            this.model = model;

            /**
             * The {@link SceneModelMesh}es belonging to this SceneModelEntity.
             *
             * * These are created with {@link SceneModel#createMesh} and registered in {@ilnk SceneModel#meshes}
             * * Each SceneModelMesh belongs to one SceneModelEntity
             */
            this.meshes = meshes;

            this._numPrimitives = 0;

            for (let i = 0, len = this.meshes.length; i < len; i++) {  // TODO: tidier way? Refactor?
                const mesh = this.meshes[i];
                mesh.parent = this;
                mesh.entity = this;
                this._numPrimitives += mesh.numPrimitives;
            }

            /**
             * The unique ID of this SceneModelEntity.
             */
            this.id = id;

            /**
             * The original system ID of this SceneModelEntity.
             */
            this.originalSystemId = math.unglobalizeObjectId(model.id, id);

            this._flags = flags;
            this._aabb = math.AABB3();
            this._aabbDirty = true;

            this._offset = math.vec3();
            this._colorizeUpdated = false;
            this._opacityUpdated = false;

            this._lodCullable = (!!lodCullable);
            this._culled = false;
            this._culledVFC = false;
            this._culledLOD = false;

            // @reviser lijuhong 注释scene相关代码
            // if (this._isObject) {
            //     model.scene._registerObject(this);
            // }
        }

        _transformDirty() {
            this._aabbDirty = true;
            this.model._transformDirty();

        }

        _sceneModelDirty() { // Called by SceneModel when SceneModel's matrix is updated
            this._aabbDirty = true;
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._sceneModelDirty();
            }
        }

        /**
         * World-space 3D axis-aligned bounding box (AABB) of this SceneModelEntity.
         *
         * Represented by a six-element Float64Array containing the min/max extents of the
         * axis-aligned volume, ie. ````[xmin, ymin, zmin, xmax, ymax, zmax]````.
         *
         * @type {Float64Array}
         */
        get aabb() {
            if (this._aabbDirty) {
                math.collapseAABB3(this._aabb);
                for (let i = 0, len = this.meshes.length; i < len; i++) {
                    math.expandAABB3(this._aabb, this.meshes[i].aabb);
                }
                this._aabbDirty = false;
            }
            // if (this._aabbDirty) {
            //     math.AABB3ToOBB3(this._aabb, tempOBB3a);
            //     math.transformOBB3(this.model.matrix, tempOBB3a);
            //     math.OBB3ToAABB3(tempOBB3a, this._worldAABB);
            //     this._worldAABB[0] += this._offset[0];
            //     this._worldAABB[1] += this._offset[1];
            //     this._worldAABB[2] += this._offset[2];
            //     this._worldAABB[3] += this._offset[0];
            //     this._worldAABB[4] += this._offset[1];
            //     this._worldAABB[5] += this._offset[2];
            //     this._aabbDirty = false;
            // }
            return this._aabb;
        }

        get isEntity() {
            return true;
        }

        /**
         * Returns false to indicate that this Entity subtype is not a model.
         * @returns {boolean}
         */
        get isModel() {
            return false;
        }

        /**
         * Returns ````true```` if this SceneModelEntity represents an object.
         *
         * When this is ````true````, the SceneModelEntity will be registered by {@link SceneModelEntity#id}
         * in {@link Scene#objects} and may also have a corresponding {@link MetaObject}.
         *
         * @type {Boolean}
         */
        get isObject() {
            return this._isObject;
        }

        get numPrimitives() {
            return this._numPrimitives;
        }

        /**
         * The approximate number of triangles in this SceneModelEntity.
         *
         * @type {Number}
         */
        get numTriangles() {
            return this._numPrimitives;
        }

        /**
         * Gets if this SceneModelEntity is visible.
         *
         * Only rendered when {@link SceneModelEntity#visible} is ````true````
         * and {@link SceneModelEntity#culled} is ````false````.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#visible} are
         * both ````true```` the SceneModelEntity will be registered
         * by {@link SceneModelEntity#id} in {@link Scene#visibleObjects}.
         *
         * @type {Boolean}
         */
        get visible() {
            return this._getFlag(ENTITY_FLAGS.VISIBLE);
        }

        /**
         * Sets if this SceneModelEntity is visible.
         *
         * Only rendered when {@link SceneModelEntity#visible} is ````true```` and {@link SceneModelEntity#culled} is ````false````.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#visible} are
         * both ````true```` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#visibleObjects}.
         *
         * @type {Boolean}
         */
        set visible(visible) {
            if (!!(this._flags & ENTITY_FLAGS.VISIBLE) === visible) {
                return; // Redundant update
            }
            if (visible) {
                this._flags = this._flags | ENTITY_FLAGS.VISIBLE;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.VISIBLE;
            }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setVisible(this._flags);
            }
            // @reviser lijuhong 注释scene相关代码
            // if (this._isObject) {
            //     this.model.scene._objectVisibilityUpdated(this);
            // }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity is highlighted.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#highlighted} are both ````true```` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#highlightedObjects}.
         *
         * @type {Boolean}
         */
        get highlighted() {
            return this._getFlag(ENTITY_FLAGS.HIGHLIGHTED);
        }

        /**
         * Sets if this SceneModelEntity is highlighted.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#highlighted} are both ````true```` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#highlightedObjects}.
         *
         * @type {Boolean}
         */
        set highlighted(highlighted) {
            if (!!(this._flags & ENTITY_FLAGS.HIGHLIGHTED) === highlighted) {
                return; // Redundant update
            }

            if (highlighted) {
                this._flags = this._flags | ENTITY_FLAGS.HIGHLIGHTED;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.HIGHLIGHTED;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setHighlighted(this._flags);
            }
            // @reviser lijuhong 注释scene相关代码
            // if (this._isObject) {
            //     this.model.scene._objectHighlightedUpdated(this);
            // }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity is xrayed.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#xrayed} are both ````true``` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#xrayedObjects}.
         *
         * @type {Boolean}
         */
        get xrayed() {
            return this._getFlag(ENTITY_FLAGS.XRAYED);
        }

        /**
         * Sets if this SceneModelEntity is xrayed.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#xrayed} are both ````true``` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#xrayedObjects}.
         *
         * @type {Boolean}
         */
        set xrayed(xrayed) {
            if (!!(this._flags & ENTITY_FLAGS.XRAYED) === xrayed) {
                return; // Redundant update
            }
            if (xrayed) {
                this._flags = this._flags | ENTITY_FLAGS.XRAYED;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.XRAYED;
            }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setXRayed(this._flags);
            }
            // @reviser lijuhong 注释scene相关代码
            // if (this._isObject) {
            //     this.model.scene._objectXRayedUpdated(this);
            // }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity is selected.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#selected} are both ````true``` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#selectedObjects}.
         *
         * @type {Boolean}
         */
        get selected() {
            return this._getFlag(ENTITY_FLAGS.SELECTED);
        }

        /**
         * Gets if this SceneModelEntity is selected.
         *
         * When {@link SceneModelEntity#isObject} and {@link SceneModelEntity#selected} are both ````true``` the SceneModelEntity will be
         * registered by {@link SceneModelEntity#id} in {@link Scene#selectedObjects}.
         *
         * @type {Boolean}
         */
        set selected(selected) {
            if (!!(this._flags & ENTITY_FLAGS.SELECTED) === selected) {
                return; // Redundant update
            }
            if (selected) {
                this._flags = this._flags | ENTITY_FLAGS.SELECTED;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.SELECTED;
            }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setSelected(this._flags);
            }
            // @reviser lijuhong 注释scene相关代码
            // if (this._isObject) {
            //     this.model.scene._objectSelectedUpdated(this);
            // }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity's edges are enhanced.
         *
         * @type {Boolean}
         */
        get edges() {
            return this._getFlag(ENTITY_FLAGS.EDGES);
        }

        /**
         * Sets if this SceneModelEntity's edges are enhanced.
         *
         * @type {Boolean}
         */
        set edges(edges) {
            if (!!(this._flags & ENTITY_FLAGS.EDGES) === edges) {
                return; // Redundant update
            }
            if (edges) {
                this._flags = this._flags | ENTITY_FLAGS.EDGES;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.EDGES;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setEdges(this._flags);
            }
            this.model.glRedraw();
        }


        get culledVFC() {
            return !!(this._culledVFC);
        }

        set culledVFC(culled) {
            this._culledVFC = culled;
            this._setCulled();
        }

        get culledLOD() {
            return !!(this._culledLOD);
        }

        set culledLOD(culled) {
            this._culledLOD = culled;
            this._setCulled();
        }

        /**
         * Gets if this SceneModelEntity is culled.
         *
         * Only rendered when {@link SceneModelEntity#visible} is ````true```` and {@link SceneModelEntity#culled} is ````false````.
         *
         * @type {Boolean}
         */
        get culled() {
            return !!(this._culled);
            // return this._getFlag(ENTITY_FLAGS.CULLED);
        }

        /**
         * Sets if this SceneModelEntity is culled.
         *
         * Only rendered when {@link SceneModelEntity#visible} is ````true```` and {@link SceneModelEntity#culled} is ````false````.
         *
         * @type {Boolean}
         */
        set culled(culled) {
            this._culled = culled;
            this._setCulled();
        }

        _setCulled() {
            let culled = !!(this._culled) || !!(this._culledLOD && this._lodCullable) || !!(this._culledVFC);
            if (!!(this._flags & ENTITY_FLAGS.CULLED) === culled) {
                return; // Redundant update
            }
            if (culled) {
                this._flags = this._flags | ENTITY_FLAGS.CULLED;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.CULLED;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setCulled(this._flags);
            }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity is clippable.
         *
         * Clipping is done by the {@link SectionPlane}s in {@link Scene#sectionPlanes}.
         *
         * @type {Boolean}
         */
        get clippable() {
            return this._getFlag(ENTITY_FLAGS.CLIPPABLE);
        }

        /**
         * Sets if this SceneModelEntity is clippable.
         *
         * Clipping is done by the {@link SectionPlane}s in {@link Scene#sectionPlanes}.
         *
         * @type {Boolean}
         */
        set clippable(clippable) {
            if ((!!(this._flags & ENTITY_FLAGS.CLIPPABLE)) === clippable) {
                return; // Redundant update
            }
            if (clippable) {
                this._flags = this._flags | ENTITY_FLAGS.CLIPPABLE;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.CLIPPABLE;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setClippable(this._flags);
            }
            this.model.glRedraw();
        }

        /**
         * Gets if this SceneModelEntity is included in boundary calculations.
         *
         * @type {Boolean}
         */
        get collidable() {
            return this._getFlag(ENTITY_FLAGS.COLLIDABLE);
        }

        /**
         * Sets if this SceneModelEntity is included in boundary calculations.
         *
         * @type {Boolean}
         */
        set collidable(collidable) {
            if (!!(this._flags & ENTITY_FLAGS.COLLIDABLE) === collidable) {
                return; // Redundant update
            }
            if (collidable) {
                this._flags = this._flags | ENTITY_FLAGS.COLLIDABLE;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.COLLIDABLE;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setCollidable(this._flags);
            }
        }

        /**
         * Gets if this SceneModelEntity is pickable.
         *
         * Picking is done via calls to {@link Scene#pick}.
         *
         * @type {Boolean}
         */
        get pickable() {
            return this._getFlag(ENTITY_FLAGS.PICKABLE);
        }

        /**
         * Sets if this SceneModelEntity is pickable.
         *
         * Picking is done via calls to {@link Scene#pick}.
         *
         * @type {Boolean}
         */
        set pickable(pickable) {
            if (!!(this._flags & ENTITY_FLAGS.PICKABLE) === pickable) {
                return; // Redundant update
            }
            if (pickable) {
                this._flags = this._flags | ENTITY_FLAGS.PICKABLE;
            } else {
                this._flags = this._flags & ~ENTITY_FLAGS.PICKABLE;
            }
            for (var i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setPickable(this._flags);
            }
        }

        /**
         * Gets the SceneModelEntity's RGB colorize color, multiplies by the SceneModelEntity's rendered fragment colors.
         *
         * Each element of the color is in range ````[0..1]````.
         *
         * @type {Number[]}
         */
        get colorize() { // [0..1, 0..1, 0..1]
            if (this.meshes.length === 0) {
                return null;
            }
            const colorize = this.meshes[0]._colorize;
            tempFloatRGB[0] = colorize[0] / 255.0; // Unquantize
            tempFloatRGB[1] = colorize[1] / 255.0;
            tempFloatRGB[2] = colorize[2] / 255.0;
            return tempFloatRGB;
        }

        /**
         * Sets the SceneModelEntity's RGB colorize color, multiplies by the SceneModelEntity's rendered fragment colors.
         *
         * Each element of the color is in range ````[0..1]````.
         *
         * @type {Number[]}
         */
        set colorize(color) { // [0..1, 0..1, 0..1]
            if (color) {
                tempIntRGB[0] = Math.floor(color[0] * 255.0); // Quantize
                tempIntRGB[1] = Math.floor(color[1] * 255.0);
                tempIntRGB[2] = Math.floor(color[2] * 255.0);
                for (let i = 0, len = this.meshes.length; i < len; i++) {
                    this.meshes[i]._setColorize(tempIntRGB);
                }
            } else {
                for (let i = 0, len = this.meshes.length; i < len; i++) {
                    this.meshes[i]._setColorize(null);
                }
            }
            if (this._isObject) {
                const colorized = (!!color);
                // @reviser lijuhong 注释scene相关代码
                // this.scene._objectColorizeUpdated(this, colorized);
                this._colorizeUpdated = colorized;
            }
            this.model.glRedraw();
        }

        /**
         * Gets the SceneModelEntity's opacity factor.
         *
         * This is a factor in range ````[0..1]```` which multiplies by the rendered fragment alphas.
         *
         * @type {Number}
         */
        get opacity() {
            if (this.meshes.length > 0) {
                return (this.meshes[0]._colorize[3] / 255.0);
            } else {
                return 1.0;
            }
        }

        /**
         * Sets the SceneModelEntity's opacity factor.
         *
         * This is a factor in range ````[0..1]```` which multiplies by the rendered fragment alphas.
         *
         * @type {Number}
         */
        set opacity(opacity) {
            if (this.meshes.length === 0) {
                return;
            }
            const opacityUpdated = (opacity !== null && opacity !== undefined);
            const lastOpacityQuantized = this.meshes[0]._colorize[3];
            let opacityQuantized = 255;
            if (opacityUpdated) {
                if (opacity < 0) {
                    opacity = 0;
                } else if (opacity > 1) {
                    opacity = 1;
                }
                opacityQuantized = Math.floor(opacity * 255.0); // Quantize
                if (lastOpacityQuantized === opacityQuantized) {
                    return;
                }
            } else {
                opacityQuantized = 255.0;
                if (lastOpacityQuantized === opacityQuantized) {
                    return;
                }
            }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setOpacity(opacityQuantized, this._flags);
            }
            if (this._isObject) {
                // @reviser lijuhong 注释scene相关代码
                // this.scene._objectOpacityUpdated(this, opacityUpdated);
                this._opacityUpdated = opacityUpdated;
            }
            this.model.glRedraw();
        }

        /**
         * Gets the SceneModelEntity's 3D World-space offset.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        get offset() {
            return this._offset;
        }

        /**
         * Sets the SceneModelEntity's 3D World-space offset.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        set offset(offset) {
            if (offset) {
                this._offset[0] = offset[0];
                this._offset[1] = offset[1];
                this._offset[2] = offset[2];
            } else {
                this._offset[0] = 0;
                this._offset[1] = 0;
                this._offset[2] = 0;
            }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._setOffset(this._offset);
            }
            this._aabbDirty  = true;
            this.model._aabbDirty = true;
            // @reviser lijuhong 注释scene相关代码
            // this.scene._aabbDirty = true;
            // this.scene._objectOffsetUpdated(this, offset);
            this.model.glRedraw();
        }

        get saoEnabled() {
            return this.model.saoEnabled;
        }

        getEachVertex(callback) {
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i].getEachVertex(callback);
            }
        }

        _getFlag(flag) {
            return !!(this._flags & flag);
        }

        _finalize() {
            // @reviser lijuhong 注释scene相关代码
            // const scene = this.model.scene;
            // if (this._isObject) {
            //     if (this.visible) {
            //         scene._objectVisibilityUpdated(this);
            //     }
            //     if (this.highlighted) {
            //         scene._objectHighlightedUpdated(this);
            //     }
            //     if (this.xrayed) {
            //         scene._objectXRayedUpdated(this);
            //     }
            //     if (this.selected) {
            //         scene._objectSelectedUpdated(this);
            //     }
            // }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._finalize(this._flags);
            }
        }

        _finalize2() {
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._finalize2();
            }
        }

        _destroy() {
            // @reviser lijuhong 注释scene相关代码
            // const scene = this.model.scene;
            // if (this._isObject) {
            //     scene._deregisterObject(this);
            //     if (this.visible) {
            //         scene._deRegisterVisibleObject(this);
            //     }
            //     if (this.xrayed) {
            //         scene._deRegisterXRayedObject(this);
            //     }
            //     if (this.selected) {
            //         scene._deRegisterSelectedObject(this);
            //     }
            //     if (this.highlighted) {
            //         scene._deRegisterHighlightedObject(this);
            //     }
            //     if (this._colorizeUpdated) {
            //         this.scene._deRegisterColorizedObject(this);
            //     }
            //     if (this._opacityUpdated) {
            //         this.scene._deRegisterOpacityObject(this);
            //     }
            //     if (this._offset && (this._offset[0] !== 0 || this._offset[1] !== 0 || this._offset[2] !== 0)) {
            //         this.scene._deRegisterOffsetObject(this);
            //     }
            // }
            for (let i = 0, len = this.meshes.length; i < len; i++) {
                this.meshes[i]._destroy();
            }
            // @reviser lijuhong 注释scene相关代码
            // scene._aabbDirty = true;
        }
    }

    /**
     * Private geometry compression and decompression utilities.
     */

    /**
     * @private
     * @param array
     * @returns {{min: Float32Array, max: Float32Array}}
     */
    function getPositionsBounds(array) {
        const min = new Float32Array(3);
        const max = new Float32Array(3);
        let i, j;
        for (i = 0; i < 3; i++) {
            min[i] = Number.MAX_VALUE;
            max[i] = -Number.MAX_VALUE;
        }
        for (i = 0; i < array.length; i += 3) {
            for (j = 0; j < 3; j++) {
                min[j] = Math.min(min[j], array[i + j]);
                max[j] = Math.max(max[j], array[i + j]);
            }
        }
        return {
            min: min,
            max: max
        };
    }

    const createPositionsDecodeMatrix = (function () {
        const translate = math.mat4();
        const scale = math.mat4();
        return function (aabb, positionsDecodeMatrix) {
            positionsDecodeMatrix = positionsDecodeMatrix || math.mat4();
            const xmin = aabb[0];
            const ymin = aabb[1];
            const zmin = aabb[2];
            const xwid = aabb[3] - xmin;
            const ywid = aabb[4] - ymin;
            const zwid = aabb[5] - zmin;
            const maxInt = 65535;
            math.identityMat4(translate);
            math.translationMat4v(aabb, translate);
            math.identityMat4(scale);
            math.scalingMat4v([xwid / maxInt, ywid / maxInt, zwid / maxInt], scale);
            math.mulMat4(translate, scale, positionsDecodeMatrix);
            return positionsDecodeMatrix;
        };
    })();

    /**
     * @private
     */
    var compressPositions = (function () { // http://cg.postech.ac.kr/research/mesh_comp_mobile/mesh_comp_mobile_conference.pdf
        const translate = math.mat4();
        const scale = math.mat4();
        return function (array, min, max) {
            const quantized = new Uint16Array(array.length);
            const multiplier = new Float32Array([
                max[0] !== min[0] ? 65535 / (max[0] - min[0]) : 0,
                max[1] !== min[1] ? 65535 / (max[1] - min[1]) : 0,
                max[2] !== min[2] ? 65535 / (max[2] - min[2]) : 0
            ]);
            let i;
            for (i = 0; i < array.length; i += 3) {
                quantized[i + 0] = Math.max(0, Math.min(65535, Math.floor((array[i + 0] - min[0]) * multiplier[0])));
                quantized[i + 1] = Math.max(0, Math.min(65535, Math.floor((array[i + 1] - min[1]) * multiplier[1])));
                quantized[i + 2] = Math.max(0, Math.min(65535, Math.floor((array[i + 2] - min[2]) * multiplier[2])));
            }
            math.identityMat4(translate);
            math.translationMat4v(min, translate);
            math.identityMat4(scale);
            math.scalingMat4v([
                (max[0] - min[0]) / 65535,
                (max[1] - min[1]) / 65535,
                (max[2] - min[2]) / 65535
            ], scale);
            const decodeMat = math.mulMat4(translate, scale, math.identityMat4());
            return {
                quantized: quantized,
                decodeMatrix: decodeMat
            };
        };
    })();

    function compressPosition(p, aabb, q) {
        const multiplier = new Float32Array([
            aabb[3] !== aabb[0] ? 65535 / (aabb[3] - aabb[0]) : 0,
            aabb[4] !== aabb[1] ? 65535 / (aabb[4] - aabb[1]) : 0,
            aabb[5] !== aabb[2] ? 65535 / (aabb[5] - aabb[2]) : 0
        ]);
        q[0] = Math.max(0, Math.min(65535, Math.floor((p[0] - aabb[0]) * multiplier[0])));
        q[1] = Math.max(0, Math.min(65535, Math.floor((p[1] - aabb[1]) * multiplier[1])));
        q[2] = Math.max(0, Math.min(65535, Math.floor((p[2] - aabb[2]) * multiplier[2])));
    }

    function decompressPosition(position, decodeMatrix, dest) {
        dest[0] = position[0] * decodeMatrix[0] + decodeMatrix[12];
        dest[1] = position[1] * decodeMatrix[5] + decodeMatrix[13];
        dest[2] = position[2] * decodeMatrix[10] + decodeMatrix[14];
        return dest;
    }

    function decompressAABB(aabb, decodeMatrix, dest = aabb) {
        dest[0] = aabb[0] * decodeMatrix[0] + decodeMatrix[12];
        dest[1] = aabb[1] * decodeMatrix[5] + decodeMatrix[13];
        dest[2] = aabb[2] * decodeMatrix[10] + decodeMatrix[14];
        dest[3] = aabb[3] * decodeMatrix[0] + decodeMatrix[12];
        dest[4] = aabb[4] * decodeMatrix[5] + decodeMatrix[13];
        dest[5] = aabb[5] * decodeMatrix[10] + decodeMatrix[14];
        return dest;
    }

    /**
     * @private
     */
    function decompressPositions(positions, decodeMatrix, dest = new Float32Array(positions.length)) {
        for (let i = 0, len = positions.length; i < len; i += 3) {
            dest[i + 0] = positions[i + 0] * decodeMatrix[0] + decodeMatrix[12];
            dest[i + 1] = positions[i + 1] * decodeMatrix[5] + decodeMatrix[13];
            dest[i + 2] = positions[i + 2] * decodeMatrix[10] + decodeMatrix[14];
        }
        return dest;
    }

    //--------------- UVs --------------------------------------------------------------------------------------------------

    /**
     * @private
     * @param array
     * @returns {{min: Float32Array, max: Float32Array}}
     */
    function getUVBounds(array) {
        const min = new Float32Array(2);
        const max = new Float32Array(2);
        let i, j;
        for (i = 0; i < 2; i++) {
            min[i] = Number.MAX_VALUE;
            max[i] = -Number.MAX_VALUE;
        }
        for (i = 0; i < array.length; i += 2) {
            for (j = 0; j < 2; j++) {
                min[j] = Math.min(min[j], array[i + j]);
                max[j] = Math.max(max[j], array[i + j]);
            }
        }
        return {
            min: min,
            max: max
        };
    }

    /**
     * @private
     */
    var compressUVs = (function () {
        const translate = math.mat3();
        const scale = math.mat3();
        return function (array, min, max) {
            const quantized = new Uint16Array(array.length);
            const multiplier = new Float32Array([
                65535 / (max[0] - min[0]),
                65535 / (max[1] - min[1])
            ]);
            let i;
            for (i = 0; i < array.length; i += 2) {
                quantized[i + 0] = Math.max(0, Math.min(65535, Math.floor((array[i + 0] - min[0]) * multiplier[0])));
                quantized[i + 1] = Math.max(0, Math.min(65535, Math.floor((array[i + 1] - min[1]) * multiplier[1])));
            }
            math.identityMat3(translate);
            math.translationMat3v(min, translate);
            math.identityMat3(scale);
            math.scalingMat3v([
                (max[0] - min[0]) / 65535,
                (max[1] - min[1]) / 65535
            ], scale);
            const decodeMat = math.mulMat3(translate, scale, math.identityMat3());
            return {
                quantized: quantized,
                decodeMatrix: decodeMat
            };
        };
    })();


    //--------------- Normals ----------------------------------------------------------------------------------------------

    /**
     * @private
     */
    function compressNormals(array) { // http://jcgt.org/published/0003/02/01/

        // Note: three elements for each encoded normal, in which the last element in each triplet is redundant.
        // This is to work around a mysterious WebGL issue where 2-element normals just wouldn't work in the shader :/

        const encoded = new Int8Array(array.length);
        let oct, dec, best, currentCos, bestCos;
        for (let i = 0; i < array.length; i += 3) {
            // Test various combinations of ceil and floor
            // to minimize rounding errors
            best = oct = octEncodeVec3(array, i, "floor", "floor");
            dec = octDecodeVec2(oct);
            currentCos = bestCos = dot(array, i, dec);
            oct = octEncodeVec3(array, i, "ceil", "floor");
            dec = octDecodeVec2(oct);
            currentCos = dot(array, i, dec);
            if (currentCos > bestCos) {
                best = oct;
                bestCos = currentCos;
            }
            oct = octEncodeVec3(array, i, "floor", "ceil");
            dec = octDecodeVec2(oct);
            currentCos = dot(array, i, dec);
            if (currentCos > bestCos) {
                best = oct;
                bestCos = currentCos;
            }
            oct = octEncodeVec3(array, i, "ceil", "ceil");
            dec = octDecodeVec2(oct);
            currentCos = dot(array, i, dec);
            if (currentCos > bestCos) {
                best = oct;
                bestCos = currentCos;
            }
            encoded[i] = best[0];
            encoded[i + 1] = best[1];
        }
        return encoded;
    }

    /**
     * @private
     */
    function octEncodeVec3(array, i, xfunc, yfunc) { // Oct-encode single normal vector in 2 bytes
        let x = array[i] / (Math.abs(array[i]) + Math.abs(array[i + 1]) + Math.abs(array[i + 2]));
        let y = array[i + 1] / (Math.abs(array[i]) + Math.abs(array[i + 1]) + Math.abs(array[i + 2]));
        if (array[i + 2] < 0) {
            let tempx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
            let tempy = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
            x = tempx;
            y = tempy;
        }
        return new Int8Array([
            Math[xfunc](x * 127.5 + (x < 0 ? -1 : 0)),
            Math[yfunc](y * 127.5 + (y < 0 ? -1 : 0))
        ]);
    }

    /**
     * Decode an oct-encoded normal
     */
    function octDecodeVec2(oct) {
        let x = oct[0];
        let y = oct[1];
        x /= x < 0 ? 127 : 128;
        y /= y < 0 ? 127 : 128;
        const z = 1 - Math.abs(x) - Math.abs(y);
        if (z < 0) {
            x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
            y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        }
        const length = Math.sqrt(x * x + y * y + z * z);
        return [
            x / length,
            y / length,
            z / length
        ];
    }

    /**
     * Dot product of a normal in an array against a candidate decoding
     * @private
     */
    function dot(array, i, vec3) {
        return array[i] * vec3[0] + array[i + 1] * vec3[1] + array[i + 2] * vec3[2];
    }

    /**
     * @private
     */
    function decompressUV(uv, decodeMatrix, dest) {
        dest[0] = uv[0] * decodeMatrix[0] + decodeMatrix[6];
        dest[1] = uv[1] * decodeMatrix[4] + decodeMatrix[7];
    }

    /**
     * @private
     */
    function decompressUVs(uvs, decodeMatrix, dest = new Float32Array(uvs.length)) {
        for (let i = 0, len = uvs.length; i < len; i += 3) {
            dest[i + 0] = uvs[i + 0] * decodeMatrix[0] + decodeMatrix[6];
            dest[i + 1] = uvs[i + 1] * decodeMatrix[4] + decodeMatrix[7];
        }
        return dest;
    }

    /**
     * @private
     */
    function decompressNormal(oct, result) {
        let x = oct[0];
        let y = oct[1];
        x = (2 * x + 1) / 255;
        y = (2 * y + 1) / 255;
        const z = 1 - Math.abs(x) - Math.abs(y);
        if (z < 0) {
            x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
            y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
        }
        const length = Math.sqrt(x * x + y * y + z * z);
        result[0] = x / length;
        result[1] = y / length;
        result[2] = z / length;
        return result;
    }

    /**
     * @private
     */
    function decompressNormals(octs, result) {
        for (let i = 0, j = 0, len = octs.length; i < len; i += 2) {
            let x = octs[i + 0];
            let y = octs[i + 1];
            x = (2 * x + 1) / 255;
            y = (2 * y + 1) / 255;
            const z = 1 - Math.abs(x) - Math.abs(y);
            if (z < 0) {
                x = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
                y = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
            }
            const length = Math.sqrt(x * x + y * y + z * z);
            result[j + 0] = x / length;
            result[j + 1] = y / length;
            result[j + 2] = z / length;
            j += 3;
        }
        return result;
    }

    /**
     * @private
     */
    const geometryCompressionUtils = {

        getPositionsBounds: getPositionsBounds,
        createPositionsDecodeMatrix: createPositionsDecodeMatrix,
        compressPositions: compressPositions,
        compressPosition:compressPosition,
        decompressPositions: decompressPositions,
        decompressPosition: decompressPosition,
        decompressAABB: decompressAABB,

        getUVBounds: getUVBounds,
        compressUVs: compressUVs,
        decompressUVs: decompressUVs,
        decompressUV: decompressUV,

        compressNormals: compressNormals,
        decompressNormals: decompressNormals,
        decompressNormal: decompressNormal
    };

    math.vec3();
    math.vec3();
    math.mat4();

    const angleAxis = math.vec4(4);
    const q1 = math.vec4();
    const q2 = math.vec4();
    const xAxis = math.vec3([1, 0, 0]);
    const yAxis = math.vec3([0, 1, 0]);
    const zAxis = math.vec3([0, 0, 1]);

    math.vec3(3);
    math.vec3(3);

    const identityMat = math.identityMat4();

    /**
     * A dynamically-updatable transform within a {@link SceneModel}.
     *
     * * Can be composed into hierarchies
     * * Shared by multiple {@link SceneModelMesh}es
     * * Created with {@link SceneModel#createTransform}
     * * Stored by ID in {@link SceneModel#transforms}
     * * Referenced by {@link SceneModelMesh#transform}
     */
    class SceneModelTransform {

        /**
         * @private
         */
        constructor(cfg) {
            this._model = cfg.model;

            /**
             * Unique ID of this SceneModelTransform.
             *
             * The SceneModelTransform is registered against this ID in {@link SceneModel#transforms}.
             */
            this.id = cfg.id;

            this._parentTransform = cfg.parent;
            this._childTransforms = [];
            this._meshes = [];
            this._scale = new Float32Array([1,1,1]);
            this._quaternion = math.identityQuaternion(new Float32Array(4));
            this._rotation = new Float32Array(3);
            this._position = new Float32Array(3);
            this._localMatrix = math.identityMat4(new Float32Array(16));
            this._worldMatrix = math.identityMat4(new Float32Array(16));
            this._localMatrixDirty = true;
            this._worldMatrixDirty = true;

            if (cfg.matrix) {
                this.matrix = cfg.matrix;
            } else {
                this.scale = cfg.scale;
                this.position = cfg.position;
                if (cfg.quaternion) ; else {
                    this.rotation = cfg.rotation;
                }
            }
            if (cfg.parent) {
                cfg.parent._addChildTransform(this);
            }
        }

        _addChildTransform(childTransform) {
            this._childTransforms.push(childTransform);
            childTransform._parentTransform = this;
            childTransform._setWorldMatrixDirty();
            childTransform._setAABBDirty();
        }

        _addMesh(mesh) {
            this._meshes.push(mesh);
            mesh.transform = this;
            // childTransform._setWorldMatrixDirty();
            // childTransform._setAABBDirty();
        }

        /**
         * The optional parent SceneModelTransform.
         *
         * @type {SceneModelTransform}
         */
        get parentTransform() {
            return this._parentTransform;
        }

        /**
         * The {@link SceneModelMesh}es transformed by this SceneModelTransform.
         *
         * @returns {[]}
         */
        get meshes() {
            return this._meshes;
        }

        /**
         * Sets the SceneModelTransform's local translation.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        set position(value) {
            this._position.set(value || [0, 0, 0]);
            this._setLocalMatrixDirty();
            this._model.glRedraw();
        }

        /**
         * Gets the SceneModelTransform's translation.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        get position() {
            return this._position;
        }

        /**
         * Sets the SceneModelTransform's rotation, as Euler angles given in degrees, for each of the X, Y and Z axis.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        set rotation(value) {
            this._rotation.set(value || [0, 0, 0]);
            math.eulerToQuaternion(this._rotation, "XYZ", this._quaternion);
            this._setLocalMatrixDirty();
            this._model.glRedraw();
        }

        /**
         * Gets the SceneModelTransform's rotation, as Euler angles given in degrees, for each of the X, Y and Z axis.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        get rotation() {
            return this._rotation;
        }

        /**
         * Sets the SceneModelTransform's rotation quaternion.
         *
         * Default value is ````[0,0,0,1]````.
         *
         * @type {Number[]}
         */
        set quaternion(value) {
            this._quaternion.set(value || [0, 0, 0, 1]);
            math.quaternionToEuler(this._quaternion, "XYZ", this._rotation);
            this._setLocalMatrixDirty();
            this._model.glRedraw();
        }

        /**
         * Gets the SceneModelTransform's rotation quaternion.
         *
         * Default value is ````[0,0,0,1]````.
         *
         * @type {Number[]}
         */
        get quaternion() {
            return this._quaternion;
        }

        /**
         * Sets the SceneModelTransform's scale.
         *
         * Default value is ````[1,1,1]````.
         *
         * @type {Number[]}
         */
        set scale(value) {
            this._scale.set(value || [1, 1, 1]);
            this._setLocalMatrixDirty();
            this._model.glRedraw();
        }

        /**
         * Gets the SceneModelTransform's scale.
         *
         * Default value is ````[1,1,1]````.
         *
         * @type {Number[]}
         */
        get scale() {
            return this._scale;
        }

        /**
         * Sets the SceneModelTransform's transform matrix.
         *
         * Default value is ````[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]````.
         *
         * @type {Number[]}
         */
        set matrix(value) {
            if (!this._localMatrix) {
                this._localMatrix = math.identityMat4();
            }
            this._localMatrix.set(value || identityMat);
            math.decomposeMat4(this._localMatrix, this._position, this._quaternion, this._scale);
            this._localMatrixDirty = false;
            this._transformDirty();
            this._model.glRedraw();
        }

        /**
         * Gets the SceneModelTransform's transform matrix.
         *
         * Default value is ````[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]````.
         *
         * @type {Number[]}
         */
        get matrix() {
            if (this._localMatrixDirty) {
                if (!this._localMatrix) {
                    this._localMatrix = math.identityMat4();
                }
                math.composeMat4(this._position, this._quaternion, this._scale, this._localMatrix);
                this._localMatrixDirty = false;
            }
            return this._localMatrix;
        }

        /**
         * Gets the SceneModelTransform's World matrix.
         *
         * @property worldMatrix
         * @type {Number[]}
         */
        get worldMatrix() {
            if (this._worldMatrixDirty) {
                this._buildWorldMatrix();
            }
            return this._worldMatrix;
        }

        /**
         * Rotates the SceneModelTransform about the given axis by the given increment.
         *
         * @param {Number[]} axis Local axis about which to rotate.
         * @param {Number} angle Angle increment in degrees.
         */
        rotate(axis, angle) {
            angleAxis[0] = axis[0];
            angleAxis[1] = axis[1];
            angleAxis[2] = axis[2];
            angleAxis[3] = angle * math.DEGTORAD;
            math.angleAxisToQuaternion(angleAxis, q1);
            math.mulQuaternions(this.quaternion, q1, q2);
            this.quaternion = q2;
            this._setLocalMatrixDirty();
            this._model.glRedraw();
            return this;
        }

        /**
         * Rotates the SceneModelTransform about the given World-space axis by the given increment.
         *
         * @param {Number[]} axis Local axis about which to rotate.
         * @param {Number} angle Angle increment in degrees.
         */
        rotateOnWorldAxis(axis, angle) {
            angleAxis[0] = axis[0];
            angleAxis[1] = axis[1];
            angleAxis[2] = axis[2];
            angleAxis[3] = angle * math.DEGTORAD;
            math.angleAxisToQuaternion(angleAxis, q1);
            math.mulQuaternions(q1, this.quaternion, q1);
            //this.quaternion.premultiply(q1);
            return this;
        }

        /**
         * Rotates the SceneModelTransform about the local X-axis by the given increment.
         *
         * @param {Number} angle Angle increment in degrees.
         */
        rotateX(angle) {
            return this.rotate(xAxis, angle);
        }

        /**
         * Rotates the SceneModelTransform about the local Y-axis by the given increment.
         *
         * @param {Number} angle Angle increment in degrees.
         */
        rotateY(angle) {
            return this.rotate(yAxis, angle);
        }

        /**
         * Rotates the SceneModelTransform about the local Z-axis by the given increment.
         *
         * @param {Number} angle Angle increment in degrees.
         */
        rotateZ(angle) {
            return this.rotate(zAxis, angle);
        }

        /**
         * Translates the SceneModelTransform along the local axis by the given increment.
         *
         * @param {Number[]} axis Normalized local space 3D vector along which to translate.
         * @param {Number} distance Distance to translate along  the vector.
         */
        translate(axis) {
            this._position[0] += axis[0];
            this._position[1] += axis[1];
            this._position[2] += axis[2];
            this._setLocalMatrixDirty();
            this._model.glRedraw();
            return this;
        }

        /**
         * Translates the SceneModelTransform along the local X-axis by the given increment.
         *
         * @param {Number} distance Distance to translate along  the X-axis.
         */
        translateX(distance) {
            this._position[0] += distance;
            this._setLocalMatrixDirty();
            this._model.glRedraw();
            return this;
        }

        /**
         * Translates the SceneModelTransform along the local Y-axis by the given increment.
         *
         * @param {Number} distance Distance to translate along  the Y-axis.
         */
        translateY(distance) {
            this._position[1] += distance;
            this._setLocalMatrixDirty();
            this._model.glRedraw();
            return this;
        }

        /**
         * Translates the SceneModelTransform along the local Z-axis by the given increment.
         *
         * @param {Number} distance Distance to translate along  the Z-axis.
         */
        translateZ(distance) {
            this._position[2] += distance;
            this._setLocalMatrixDirty();
            this._model.glRedraw();
            return this;
        }

        _setLocalMatrixDirty() {
            this._localMatrixDirty = true;
            this._transformDirty();
        }

        _transformDirty() {
            this._worldMatrixDirty = true;
            for (let i = 0, len = this._childTransforms.length; i < len; i++) {
                const childTransform = this._childTransforms[i];
                childTransform._transformDirty();
                if (childTransform._meshes && childTransform._meshes.length > 0) {
                   const meshes = childTransform._meshes;
                   for (let j =0, lenj = meshes.length; j < lenj; j++) {
                     meshes[j]._transformDirty();
                   }
                }
            }
            if (this._meshes && this._meshes.length > 0) {
                const meshes = this._meshes;
                for (let j =0, lenj = meshes.length; j < lenj; j++) {
                    meshes[j]._transformDirty();
                }
            }
        }

        _buildWorldMatrix() {
            const localMatrix = this.matrix;
            if (!this._parentTransform) {
                for (let i = 0, len = localMatrix.length; i < len; i++) {
                    this._worldMatrix[i] = localMatrix[i];
                }
            } else {
                math.mulMat4(this._parentTransform.worldMatrix, localMatrix, this._worldMatrix);
            }
            this._worldMatrixDirty = false;
        }

        _setSubtreeAABBsDirty(sceneTransform) {
            sceneTransform._aabbDirty = true;
            if (sceneTransform._childTransforms) {
                for (let i = 0, len = sceneTransform._childTransforms.length; i < len; i++) {
                    this._setSubtreeAABBsDirty(sceneTransform._childTransforms[i]);
                }
            }
        }
    }

    const tempVec3a = math.vec3();

    const tempOBB3 = math.OBB3();

    const DEFAULT_SCALE = math.vec3([1, 1, 1]);
    const DEFAULT_POSITION = math.vec3([0, 0, 0]);
    const DEFAULT_ROTATION = math.vec3([0, 0, 0]);
    const DEFAULT_QUATERNION = math.identityQuaternion();
    const DEFAULT_MATRIX = math.identityMat4();

    const DEFAULT_COLOR_TEXTURE_ID = "defaultColorTexture";
    const DEFAULT_METAL_ROUGH_TEXTURE_ID = "defaultMetalRoughTexture";
    const DEFAULT_NORMALS_TEXTURE_ID = "defaultNormalsTexture";
    const DEFAULT_EMISSIVE_TEXTURE_ID = "defaultEmissiveTexture";
    const DEFAULT_OCCLUSION_TEXTURE_ID = "defaultOcclusionTexture";

    const defaultCompressedColor = new Uint8Array([255, 255, 255]);

    const VBO_INSTANCED = 0;
    const VBO_BATCHED = 1;
    const DTX = 2;

    /**
     * @desc A high-performance model representation for efficient rendering and low memory usage.
     *
     * # Examples
     *
     * Internally, SceneModel uses a combination of several different techniques to render and represent
     * the different parts of a typical model. Each of the live examples at these links is designed to "unit test" one of these
     * techniques, in isolation. If some bug occurs in SceneModel, we use these tests to debug, but they also
     * serve to demonstrate how to use the capabilities of SceneModel programmatically.
     *
     * * [Loading building models into SceneModels](/examples/buildings)
     * * [Loading city models into SceneModels](/examples/cities)
     * * [Loading LiDAR scans into SceneModels](/examples/lidar)
     * * [Loading CAD models into SceneModels](/examples/cad)
     * * [SceneModel feature tests](/examples/scenemodel)
     *
     * # Overview
     *
     * While xeokit's standard [scene graph](https://github.com/xeokit/xeokit-sdk/wiki/Scene-Graphs) is great for gizmos and medium-sized models, it doesn't scale up to millions of objects in terms of memory and rendering efficiency.
     *
     * For huge models, we have the ````SceneModel```` representation, which is optimized to pack large amounts of geometry into memory and render it efficiently using WebGL.
     *
     * ````SceneModel```` is the default model representation loaded by  (at least) {@link GLTFLoaderPlugin}, {@link XKTLoaderPlugin} and  {@link WebIFCLoaderPlugin}.
     *
     * In this tutorial you'll learn how to use ````SceneModel```` to create high-detail content programmatically. Ordinarily you'd be learning about ````SceneModel```` if you were writing your own model loader plugins.
     *
     * # Contents
     *
     * - [SceneModel](#DataTextureSceneModel)
     * - [GPU-Resident Geometry](#gpu-resident-geometry)
     * - [Picking](#picking)
     * - [Example 1: Geometry Instancing](#example-1--geometry-instancing)
     * - [Finalizing a SceneModel](#finalizing-a-DataTextureSceneModel)
     * - [Finding Entities](#finding-entities)
     * - [Example 2: Geometry Batching](#example-2--geometry-batching)
     * - [Classifying with Metadata](#classifying-with-metadata)
     * - [Querying Metadata](#querying-metadata)
     * - [Metadata Structure](#metadata-structure)
     * - [RTC Coordinates](#rtc-coordinates-for-double-precision)
     *   - [Example 3: RTC Coordinates with Geometry Instancing](#example-2--rtc-coordinates-with-geometry-instancing)
     *   - [Example 4: RTC Coordinates with Geometry Batching](#example-2--rtc-coordinates-with-geometry-batching)
     *
     * ## SceneModel
     *
     * ````SceneModel```` uses two rendering techniques internally:
     *
     * 1. ***Geometry batching*** for unique geometries, combining those into a single WebGL geometry buffer, to render in one draw call, and
     * 2. ***geometry instancing*** for geometries that are shared by multiple meshes, rendering all instances of each shared geometry in one draw call.
     *
     * <br>
     * These techniques come with certain limitations:
     *
     * * Non-realistic rendering - while scene graphs can use xeokit's full set of material workflows, ````SceneModel```` uses simple Lambertian shading without textures.
     * * Static transforms - transforms within a ````SceneModel```` are static and cannot be dynamically translated, rotated and scaled the way {@link Node}s and {@link Mesh}es in scene graphs can.
     * * Immutable model representation - while scene graph {@link Node}s and
     * {@link Mesh}es can be dynamically plugged together, ````SceneModel```` is immutable,
     * since it packs its geometries into buffers and instanced arrays.
     *
     * ````SceneModel````'s API allows us to exploit batching and instancing, while exposing its elements as
     * abstract {@link Entity} types.
     *
     * {@link Entity} is the abstract base class for
     * the various xeokit components that represent models, objects, or anonymous visible elements. An Entity has a unique ID and can be
     * individually shown, hidden, selected, highlighted, ghosted, culled, picked and clipped, and has its own World-space boundary.
     *
     * * A ````SceneModel```` is an {@link Entity} that represents a model.
     * * A ````SceneModel```` represents each of its objects with an {@link Entity}.
     * * Each {@link Entity} has one or more meshes that define its shape.
     * * Each mesh has either its own unique geometry, or shares a geometry with other meshes.
     *
     * ## GPU-Resident Geometry
     *
     * For a low memory footprint, ````SceneModel```` stores its geometries in GPU memory only, compressed (quantized) as integers. Unfortunately, GPU-resident geometry is
     * not readable by JavaScript.
     *
     *
     * ## Example 1: Geometry Instancing
     *
     * In the example below, we'll use a ````SceneModel````
     * to build a simple table model using geometry instancing.
     *
     * We'll start by adding a reusable box-shaped geometry to our ````SceneModel````.
     *
     * Then, for each object in our model we'll add an {@link Entity}
     * that has a mesh that instances our box geometry, transforming and coloring the instance.
     *
     * [![](http://xeokit.io/img/docs/sceneGraph.png)](https://xeokit.github.io/xeokit-sdk/examples/index.html#sceneRepresentation_SceneModel_instancing)
     *
     * ````javascript
     * import {Viewer, SceneModel} from "xeokit-sdk.es.js";
     *
     * const viewer = new Viewer({
     *     canvasId: "myCanvas",
     *     transparent: true
     * });
     *
     * viewer.scene.camera.eye = [-21.80, 4.01, 6.56];
     * viewer.scene.camera.look = [0, -5.75, 0];
     * viewer.scene.camera.up = [0.37, 0.91, -0.11];
     *
     * // Build a SceneModel representing a table
     * // with four legs, using geometry instancing
     *
     * const sceneModel = new SceneModel(viewer.scene, {
     *     id: "table",
     *     isModel: true, // <--- Registers SceneModel in viewer.scene.models
     *     position: [0, 0, 0],
     *     scale: [1, 1, 1],
     *     rotation: [0, 0, 0]
     * });
     *
     * // Create a reusable geometry within the SceneModel
     * // We'll instance this geometry by five meshes
     *
     * sceneModel.createGeometry({
     *
     *     id: "myBoxGeometry",
     *
     *     // The primitive type - allowed values are "points", "lines" and "triangles".
     *     // See the OpenGL/WebGL specification docs
     *     // for how the coordinate arrays are supposed to be laid out.
     *     primitive: "triangles",
     *
     *     // The vertices - eight for our cube, each
     *     // one spanning three array elements for X,Y and Z
     *     positions: [
     *          1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1, // v0-v1-v2-v3 front
     *          1, 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, // v0-v3-v4-v1 right
     *          1, 1, 1, 1, 1, -1, -1, 1, -1, -1, 1, 1, // v0-v1-v6-v1 top
     *          -1, 1, 1, -1, 1, -1, -1, -1, -1, -1, -1, 1, // v1-v6-v7-v2 left
     *          -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, // v7-v4-v3-v2 bottom
     *          1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1 // v4-v7-v6-v1 back
     *     ],
     *
     *     // Normal vectors, one for each vertex
     *     normals: [
     *         0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, // v0-v1-v2-v3 front
     *         1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, // v0-v3-v4-v5 right
     *         0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, // v0-v5-v6-v1 top
     *         -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, // v1-v6-v7-v2 left
     *         0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, // v7-v4-v3-v2 bottom
     *         0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1 // v4-v7-v6-v5 back
     *     ],
     *
     *     // Indices - these organise the positions and and normals
     *     // into geometric primitives in accordance with the "primitive" parameter,
     *     // in this case a set of three indices for each triangle.
     *     //
     *     // Note that each triangle is specified in counter-clockwise winding order.
     *     //
     *     indices: [
     *         0, 1, 2, 0, 2, 3, // front
     *         4, 5, 6, 4, 6, 7, // right
     *         8, 9, 10, 8, 10, 11, // top
     *         12, 13, 14, 12, 14, 15, // left
     *         16, 17, 18, 16, 18, 19, // bottom
     *         20, 21, 22, 20, 22, 23
     *     ]
     * });
     *
     * // Red table leg
     *
     * sceneModel.createMesh({
     *     id: "redLegMesh",
     *     geometryId: "myBoxGeometry",
     *     position: [-4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1, 0.3, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     id: "redLeg",
     *     meshIds: ["redLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Green table leg
     *
     * sceneModel.createMesh({
     *     id: "greenLegMesh",
     *     geometryId: "myBoxGeometry",
     *     position: [4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 1.0, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     id: "greenLeg",
     *     meshIds: ["greenLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Blue table leg
     *
     * sceneModel.createMesh({
     *     id: "blueLegMesh",
     *     geometryId: "myBoxGeometry",
     *     position: [4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "blueLeg",
     *     meshIds: ["blueLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Yellow table leg
     *
     * sceneModel.createMesh({
     *      id: "yellowLegMesh",
     *      geometryId: "myBoxGeometry",
     *      position: [-4, -6, 4],
     *      scale: [1, 3, 1],
     *      rotation: [0, 0, 0],
     *      color: [1.0, 1.0, 0.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "yellowLeg",
     *     meshIds: ["yellowLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Purple table top
     *
     * sceneModel.createMesh({
     *     id: "purpleTableTopMesh",
     *     geometryId: "myBoxGeometry",
     *     position: [0, -3, 0],
     *     scale: [6, 0.5, 6],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "purpleTableTop",
     *     meshIds: ["purpleTableTopMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *  ````
     *
     * ## Finalizing a SceneModel
     *
     * Before we can view and interact with our ````SceneModel````, we need to **finalize** it. Internally, this causes the ````SceneModel```` to build the
     * vertex buffer objects (VBOs) that support our geometry instances. When using geometry batching (see next example),
     * this causes ````SceneModel```` to build the VBOs that combine the batched geometries. Note that you can do both instancing and
     * batching within the same ````SceneModel````.
     *
     * Once finalized, we can't add anything more to our ````SceneModel````.
     *
     * ```` javascript
     * SceneModel.finalize();
     * ````
     *
     * ## Finding Entities
     *
     * As mentioned earlier, {@link Entity} is
     * the abstract base class for components that represent models, objects, or just
     * anonymous visible elements.
     *
     * Since we created configured our ````SceneModel```` with ````isModel: true````,
     * we're able to find it as an Entity by ID in ````viewer.scene.models````. Likewise, since
     * we configured each of its Entities with ````isObject: true````, we're able to
     * find them in  ````viewer.scene.objects````.
     *
     *
     * ````javascript
     * // Get the whole table model Entity
     * const table = viewer.scene.models["table"];
     *
     *  // Get some leg object Entities
     * const redLeg = viewer.scene.objects["redLeg"];
     * const greenLeg = viewer.scene.objects["greenLeg"];
     * const blueLeg = viewer.scene.objects["blueLeg"];
     * ````
     *
     * ## Example 2: Geometry Batching
     *
     * Let's once more use a ````SceneModel````
     * to build the simple table model, this time exploiting geometry batching.
     *
     *  [![](http://xeokit.io/img/docs/sceneGraph.png)](https://xeokit.github.io/xeokit-sdk/examples/index.html#sceneRepresentation_SceneModel_batching)
     *
     * ````javascript
     * import {Viewer, SceneModel} from "xeokit-sdk.es.js";
     *
     * const viewer = new Viewer({
     *     canvasId: "myCanvas",
     *     transparent: true
     * });
     *
     * viewer.scene.camera.eye = [-21.80, 4.01, 6.56];
     * viewer.scene.camera.look = [0, -5.75, 0];
     * viewer.scene.camera.up = [0.37, 0.91, -0.11];
     *
     * // Create a SceneModel representing a table with four legs, using geometry batching
     * const sceneModel = new SceneModel(viewer.scene, {
     *     id: "table",
     *     isModel: true,  // <--- Registers SceneModel in viewer.scene.models
     *     position: [0, 0, 0],
     *     scale: [1, 1, 1],
     *     rotation: [0, 0, 0]
     * });
     *
     * // Red table leg
     *
     * sceneModel.createMesh({
     *     id: "redLegMesh",
     *
     *     // Geometry arrays are same as for the earlier batching example
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [-4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1, 0.3, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     id: "redLeg",
     *     meshIds: ["redLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Green table leg
     *
     * sceneModel.createMesh({
     *     id: "greenLegMesh",
     *     primitive: "triangles",
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 1.0, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     id: "greenLeg",
     *     meshIds: ["greenLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Blue table leg
     *
     * sceneModel.createMesh({
     *     id: "blueLegMesh",
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "blueLeg",
     *     meshIds: ["blueLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Yellow table leg object
     *
     * sceneModel.createMesh({
     *     id: "yellowLegMesh",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [-4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 1.0, 0.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "yellowLeg",
     *     meshIds: ["yellowLegMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Purple table top
     *
     * sceneModel.createMesh({
     *     id: "purpleTableTopMesh",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [0, -3, 0],
     *     scale: [6, 0.5, 6],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     id: "purpleTableTop",
     *     meshIds: ["purpleTableTopMesh"],
     *     isObject: true // <---- Registers Entity by ID on viewer.scene.objects
     * });
     *
     * // Finalize the SceneModel.
     *
     * SceneModel.finalize();
     *
     * // Find BigModelNodes by their model and object IDs
     *
     * // Get the whole table model
     * const table = viewer.scene.models["table"];
     *
     * // Get some leg objects
     * const redLeg = viewer.scene.objects["redLeg"];
     * const greenLeg = viewer.scene.objects["greenLeg"];
     * const blueLeg = viewer.scene.objects["blueLeg"];
     * ````
     *
     * ## Classifying with Metadata
     *
     * In the previous examples, we used ````SceneModel```` to build
     * two versions of the same table model, to demonstrate geometry batching and geometry instancing.
     *
     * We'll now classify our {@link Entity}s with metadata. This metadata
     * will work the same for both our examples, since they create the exact same structure of {@link Entity}s
     * to represent their models and objects. The abstract Entity type is, after all, intended to provide an abstract interface through which differently-implemented scene content can be accessed uniformly.
     *
     * To create the metadata, we'll create a {@link MetaModel} for our model,
     * with a {@link MetaObject} for each of it's objects. The MetaModel and MetaObjects
     * get the same IDs as the {@link Entity}s that represent their model and objects within our scene.
     *
     * ```` javascript
     * const furnitureMetaModel = viewer.metaScene.createMetaModel("furniture", {         // Creates a MetaModel in the MetaScene
     *
     *      "projectId": "myTableProject",
     *      "revisionId": "V1.0",
     *
     *      "metaObjects": [
     *          {                               // Creates a MetaObject in the MetaModel
     *              "id": "table",
     *              "name": "Table",            // Same ID as an object Entity
     *              "type": "furniture",        // Arbitrary type, could be IFC type
     *              "properties": {             // Arbitrary properties, could be IfcPropertySet
     *                  "cost": "200"
     *              }
     *          },
     *          {
     *              "id": "redLeg",
     *              "name": "Red table Leg",
     *              "type": "leg",
     *              "parent": "table",           // References first MetaObject as parent
     *              "properties": {
     *                  "material": "wood"
     *              }
     *          },
     *          {
     *              "id": "greenLeg",           // Node with corresponding id does not need to exist
     *              "name": "Green table leg",  // and MetaObject does not need to exist for Node with an id
     *              "type": "leg",
     *              "parent": "table",
     *              "properties": {
     *                  "material": "wood"
     *              }
     *          },
     *          {
     *              "id": "blueLeg",
     *              "name": "Blue table leg",
     *              "type": "leg",
     *              "parent": "table",
     *              "properties": {
     *                  "material": "wood"
     *              }
     *          },
     *          {
     *              "id": "yellowLeg",
     *              "name": "Yellow table leg",
     *              "type": "leg",
     *              "parent": "table",
     *              "properties": {
     *                  "material": "wood"
     *              }
     *          },
     *          {
     *              "id": "tableTop",
     *              "name": "Purple table top",
     *              "type": "surface",
     *              "parent": "table",
     *              "properties": {
     *                  "material": "formica",
     *                  "width": "60",
     *                  "depth": "60",
     *                  "thickness": "5"
     *              }
     *          }
     *      ]
     *  });
     * ````
     *
     * ## Querying Metadata
     *
     * Having created and classified our model (either the instancing or batching example), we can now find the {@link MetaModel}
     * and {@link MetaObject}s using the IDs of their
     * corresponding {@link Entity}s.
     *
     * ````JavaScript
     * const furnitureMetaModel = scene.metaScene.metaModels["furniture"];
     *
     * const redLegMetaObject = scene.metaScene.metaObjects["redLeg"];
     * ````
     *
     * In the snippet below, we'll log metadata on each {@link Entity} we click on:
     *
     * ````JavaScript
     * viewer.scene.input.on("mouseclicked", function (coords) {
     *
     *      const hit = viewer.scene.pick({
     *          canvasPos: coords
     *      });
     *
     *      if (hit) {
     *          const entity = hit.entity;
     *          const metaObject = viewer.metaScene.metaObjects[entity.id];
     *          if (metaObject) {
     *              console.log(JSON.stringify(metaObject.getJSON(), null, "\t"));
     *          }
     *      }
     *  });
     * ````
     *
     * ## Metadata Structure
     *
     * The {@link MetaModel}
     * organizes its {@link MetaObject}s in
     * a tree that describes their structural composition:
     *
     * ````JavaScript
     * // Get metadata on the root object
     * const tableMetaObject = furnitureMetaModel.rootMetaObject;
     *
     * // Get metadata on the leg objects
     * const redLegMetaObject = tableMetaObject.children[0];
     * const greenLegMetaObject = tableMetaObject.children[1];
     * const blueLegMetaObject = tableMetaObject.children[2];
     * const yellowLegMetaObject = tableMetaObject.children[3];
     * ````
     *
     * Given an {@link Entity}, we can find the object or model of which it is a part, or the objects that comprise it. We can also generate UI
     * components from the metadata, such as the tree view demonstrated in [this demo](https://xeokit.github.io/xeokit-sdk/examples/index.html#BIMOffline_glTF_OTCConferenceCenter).
     *
     * This hierarchy allows us to express the hierarchical structure of a model while representing it in
     * various ways in the 3D scene (such as with ````SceneModel````, which
     * has a non-hierarchical scene representation).
     *
     * Note also that a {@link MetaObject} does not need to have a corresponding
     * {@link Entity} and vice-versa.
     *
     * # RTC Coordinates for Double Precision
     *
     * ````SceneModel```` can emulate 64-bit precision on GPUs using relative-to-center (RTC) coordinates.
     *
     * Consider a model that contains many small objects, but with such large spatial extents that 32 bits of GPU precision (accurate to ~7 digits) will not be sufficient to render all of the the objects without jittering.
     *
     * To prevent jittering, we could spatially subdivide the objects into "tiles". Each tile would have a center position, and the positions of the objects within the tile would be relative to that center ("RTC coordinates").
     *
     * While the center positions of the tiles would be 64-bit values, the object positions only need to be 32-bit.
     *
     * Internally, when rendering an object with RTC coordinates, xeokit first temporarily translates the camera viewing matrix by the object's tile's RTC center, on the CPU, using 64-bit math.
     *
     * Then xeokit loads the viewing matrix into its WebGL shaders, where math happens at 32-bit precision. Within the shaders, the matrix is effectively down-cast to 32-bit precision, and the object's 32-bit vertex positions are transformed by the matrix.
     *
     * We see no jittering, because with RTC a detectable loss of GPU accuracy only starts happening to objects as they become very distant from the camera viewpoint, at which point they are too small to be discernible anyway.
     *
     * ## RTC Coordinates with Geometry Instancing
     *
     * To use RTC with ````SceneModel```` geometry instancing, we specify an RTC center for the geometry via its ````origin```` parameter. Then ````SceneModel```` assumes that all meshes that instance that geometry are within the same RTC coordinate system, ie. the meshes ````position```` and ````rotation```` properties are assumed to be relative to the geometry's ````origin````.
     *
     * For simplicity, our example's meshes all instance the same geometry. Therefore, our example model has only one RTC center.
     *
     * Note that the axis-aligned World-space boundary (AABB) of our model is ````[ -6, -9, -6, 1000000006, -2.5, 1000000006]````.
     *
     * [![](http://xeokit.io/img/docs/sceneGraph.png)](https://xeokit.github.io/xeokit-sdk/examples/index.html#sceneRepresentation_SceneModel_batching)
     *
     * ````javascript
     * const origin = [100000000, 0, 100000000];
     *
     * sceneModel.createGeometry({
     *     id: "box",
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg1",
     *     geometryId: "box",
     *     position: [-4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1, 0.3, 0.3],
     *     origin: origin
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg1"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg2",
     *     geometryId: "box",
     *     position: [4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 1.0, 0.3],
     *     origin: origin
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg2"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg3",
     *     geometryId: "box",
     *     position: [4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 0.3, 1.0],
     *     origin: origin
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg3"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg4",
     *     geometryId: "box",
     *     position: [-4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 1.0, 0.0],
     *     origin: origin
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg4"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "top",
     *     geometryId: "box",
     *     position: [0, -3, 0],
     *     scale: [6, 0.5, 6],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 0.3, 1.0],
     *     origin: origin
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["top"],
     *     isObject: true
     * });
     * ````
     *
     * ## RTC Coordinates with Geometry Batching
     *
     * To use RTC with ````SceneModel```` geometry batching, we specify an RTC center (````origin````) for each mesh. For performance, we try to have as many meshes share the same value for ````origin```` as possible. Each mesh's ````positions````, ````position```` and ````rotation```` properties are assumed to be relative to ````origin````.
     *
     * For simplicity, the meshes in our example all share the same RTC center.
     *
     * The axis-aligned World-space boundary (AABB) of our model is ````[ -6, -9, -6, 1000000006, -2.5, 1000000006]````.
     *
     * [![](http://xeokit.io/img/docs/sceneGraph.png)](https://xeokit.github.io/xeokit-sdk/examples/index.html#sceneRepresentation_SceneModel_batching)
     *
     * ````javascript
     * const origin = [100000000, 0, 100000000];
     *
     * sceneModel.createMesh({
     *     id: "leg1",
     *     origin: origin, // This mesh's positions and transforms are relative to the RTC center
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [-4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1, 0.3, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg1"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg2",
     *     origin: origin, // This mesh's positions and transforms are relative to the RTC center
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 1.0, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg2"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg3",
     *     origin: origin, // This mesh's positions and transforms are relative to the RTC center
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg3"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg4",
     *     origin: origin, // This mesh's positions and transforms are relative to the RTC center
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [-4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 1.0, 0.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg4"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "top",
     *     origin: origin, // This mesh's positions and transforms are relative to the RTC center
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     *     position: [0, -3, 0],
     *     scale: [6, 0.5, 6],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["top"],
     *     isObject: true
     * });
     * ````
     *
     * ## Positioning at World-space coordinates
     *
     * To position a SceneModel at given double-precision World coordinates, we can
     * configure the ````origin```` of the SceneModel itself. The ````origin```` is a double-precision
     * 3D World-space position at which the SceneModel will be located.
     *
     * Note that ````position```` is a single-precision offset relative to ````origin````.
     *
     * ````javascript
     * const origin = [100000000, 0, 100000000];
     *
     * const sceneModel = new SceneModel(viewer.scene, {
     *     id: "table",
     *     isModel: true,
     *     origin: origin, // Everything in this SceneModel is relative to this RTC center
     *     position: [0, 0, 0],
     *     scale: [1, 1, 1],
     *     rotation: [0, 0, 0]
     * });
     *
     * sceneModel.createGeometry({
     *     id: "box",
     *     primitive: "triangles",
     *     positions: [ 1, 1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1 ... ],
     *     normals: [ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, ... ],
     *     indices: [ 0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, ... ],
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg1",
     *     geometryId: "box",
     *     position: [-4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1, 0.3, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg1"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg2",
     *     geometryId: "box",
     *     position: [4, -6, -4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 1.0, 0.3]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg2"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg3",
     *     geometryId: "box",
     *     position: [4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [0.3, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg3"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "leg4",
     *     geometryId: "box",
     *     position: [-4, -6, 4],
     *     scale: [1, 3, 1],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 1.0, 0.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["leg4"],
     *     isObject: true
     * });
     *
     * sceneModel.createMesh({
     *     id: "top",
     *     geometryId: "box",
     *     position: [0, -3, 0],
     *     scale: [6, 0.5, 6],
     *     rotation: [0, 0, 0],
     *     color: [1.0, 0.3, 1.0]
     * });
     *
     * sceneModel.createEntity({
     *     meshIds: ["top"],
     *     isObject: true
     * });
     * ````
     *
     * # Textures
     *
     * ## Loading KTX2 Texture Files into a SceneModel
     *
     * A {@link SceneModel} that is configured with a {@link KTX2TextureTranscoder} will
     * allow us to load textures into it from KTX2 buffers or files.
     *
     * In the example below, we'll create a {@link Viewer}, containing a {@link SceneModel} configured with a
     * {@link KTX2TextureTranscoder}. We'll then programmatically create a simple object within the SceneModel, consisting of
     * a single mesh with a texture loaded from a KTX2 file, which our SceneModel internally transcodes, using
     * its {@link KTX2TextureTranscoder}. Note how we configure our {@link KTX2TextureTranscoder} with a path to the Basis Universal
     * transcoder WASM module.
     *
     * ````javascript
     * const viewer = new Viewer({
     *     canvasId: "myCanvas",
     *     transparent: true
     * });
     *
     * viewer.scene.camera.eye = [-21.80, 4.01, 6.56];
     * viewer.scene.camera.look = [0, -5.75, 0];
     * viewer.scene.camera.up = [0.37, 0.91, -0.11];
     *
     * const textureTranscoder = new KTX2TextureTranscoder({
     *     viewer,
     *     transcoderPath: "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk/dist/basis/" // <------ Path to BasisU transcoder module
     * });
     *
     * const sceneModel = new SceneModel(viewer.scene, {
     *      id: "myModel",
     *      textureTranscoder // <<-------------------- Configure model with our transcoder
     *  });
     *
     * sceneModel.createTexture({
     *      id: "myColorTexture",
     *      src: "../assets/textures/compressed/sample_uastc_zstd.ktx2" // <<----- KTX2 texture asset
     * });
     *
     * sceneModel.createTexture({
     *      id: "myMetallicRoughnessTexture",
     *      src: "../assets/textures/alpha/crosshatchAlphaMap.jpg" // <<----- JPEG texture asset
     * });
     *
     * sceneModel.createTextureSet({
     *      id: "myTextureSet",
     *      colorTextureId: "myColorTexture",
     *      metallicRoughnessTextureId: "myMetallicRoughnessTexture"
     *  });
     *
     * sceneModel.createMesh({
     *      id: "myMesh",
     *      textureSetId: "myTextureSet",
     *      primitive: "triangles",
     *      positions: [1, 1, 1, ...],
     *      normals: [0, 0, 1, 0, ...],
     *      uv: [1, 0, 0, ...],
     *      indices: [0, 1, 2, ...],
     *  });
     *
     * sceneModel.createEntity({
     *      id: "myEntity",
     *      meshIds: ["myMesh"]
     *  });
     *
     * sceneModel.finalize();
     * ````
     *
     * ## Loading KTX2 Textures from ArrayBuffers into a SceneModel
     *
     * A SceneModel that is configured with a {@link KTX2TextureTranscoder} will allow us to load textures into
     * it from KTX2 ArrayBuffers.
     *
     * In the example below, we'll create a {@link Viewer}, containing a {@link SceneModel} configured with a
     * {@link KTX2TextureTranscoder}. We'll then programmatically create a simple object within the SceneModel, consisting of
     * a single mesh with a texture loaded from a KTX2 ArrayBuffer, which our SceneModel internally transcodes, using
     * its {@link KTX2TextureTranscoder}.
     *
     * ````javascript
     * const viewer = new Viewer({
     *     canvasId: "myCanvas",
     *     transparent: true
     * });
     *
     * viewer.scene.camera.eye = [-21.80, 4.01, 6.56];
     * viewer.scene.camera.look = [0, -5.75, 0];
     * viewer.scene.camera.up = [0.37, 0.91, -0.11];
     *
     * const textureTranscoder = new KTX2TextureTranscoder({
     *     viewer,
     *     transcoderPath: "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk/dist/basis/" // <------ Path to BasisU transcoder module
     * });
     *
     * const sceneModel = new SceneModel(viewer.scene, {
     *      id: "myModel",
     *      textureTranscoder // <<-------------------- Configure model with our transcoder
     * });
     *
     * utils.loadArraybuffer("../assets/textures/compressed/sample_uastc_zstd.ktx2",(arrayBuffer) => {
     *
     *     sceneModel.createTexture({
     *         id: "myColorTexture",
     *         buffers: [arrayBuffer] // <<----- KTX2 texture asset
     *     });
     *
     *     sceneModel.createTexture({
     *         id: "myMetallicRoughnessTexture",
     *         src: "../assets/textures/alpha/crosshatchAlphaMap.jpg" // <<----- JPEG texture asset
     *     });
     *
     *     sceneModel.createTextureSet({
     *        id: "myTextureSet",
     *        colorTextureId: "myColorTexture",
     *        metallicRoughnessTextureId: "myMetallicRoughnessTexture"
     *     });
     *
     *     sceneModel.createMesh({
     *          id: "myMesh",
     *          textureSetId: "myTextureSet",
     *          primitive: "triangles",
     *          positions: [1, 1, 1, ...],
     *          normals: [0, 0, 1, 0, ...],
     *          uv: [1, 0, 0, ...],
     *          indices: [0, 1, 2, ...],
     *     });
     *
     *     sceneModel.createEntity({
     *         id: "myEntity",
     *         meshIds: ["myMesh"]
     *     });
     *
     *     sceneModel.finalize();
     * });
     * ````
     *
     * @implements {Entity}
     */
    class SceneModel extends Component {

        /**
         * @constructor
         * @param {Component} owner Owner component. When destroyed, the owner will destroy this component as well.
         * @param {*} [cfg] Configs
         * @param {String} [cfg.id] Optional ID, unique among all components in the parent scene, generated automatically when omitted.
         * @param {Boolean} [cfg.isModel] Specify ````true```` if this SceneModel represents a model, in which case the SceneModel will be registered by {@link SceneModel#id} in {@link Scene#models} and may also have a corresponding {@link MetaModel} with matching {@link MetaModel#id}, registered by that ID in {@link MetaScene#metaModels}.
         * @param {Number[]} [cfg.origin=[0,0,0]] World-space double-precision 3D origin.
         * @param {Number[]} [cfg.position=[0,0,0]] Local, single-precision 3D position, relative to the origin parameter.
         * @param {Number[]} [cfg.scale=[1,1,1]] Local scale.
         * @param {Number[]} [cfg.rotation=[0,0,0]] Local rotation, as Euler angles given in degrees, for each of the X, Y and Z axis.
         * @param {Number[]} [cfg.matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] Local modelling transform matrix. Overrides the position, scale and rotation parameters.
         * @param {Boolean} [cfg.visible=true] Indicates if the SceneModel is initially visible.
         * @param {Boolean} [cfg.culled=false] Indicates if the SceneModel is initially culled from view.
         * @param {Boolean} [cfg.pickable=true] Indicates if the SceneModel is initially pickable.
         * @param {Boolean} [cfg.clippable=true] Indicates if the SceneModel is initially clippable.
         * @param {Boolean} [cfg.collidable=true] Indicates if the SceneModel is initially included in boundary calculations.
         * @param {Boolean} [cfg.xrayed=false] Indicates if the SceneModel is initially xrayed.
         * @param {Boolean} [cfg.highlighted=false] Indicates if the SceneModel is initially highlighted.
         * @param {Boolean} [cfg.selected=false] Indicates if the SceneModel is initially selected.
         * @param {Boolean} [cfg.edges=false] Indicates if the SceneModel's edges are initially emphasized.
         * @param {Number[]} [cfg.colorize=[1.0,1.0,1.0]] SceneModel's initial RGB colorize color, multiplies by the rendered fragment colors.
         * @param {Number} [cfg.opacity=1.0] SceneModel's initial opacity factor, multiplies by the rendered fragment alpha.
         * @param {Number} [cfg.backfaces=false] When we set this ````true````, then we force rendering of backfaces for this SceneModel. When
         * we leave this ````false````, then we allow the Viewer to decide when to render backfaces. In that case, the
         * Viewer will hide backfaces on watertight meshes, show backfaces on open meshes, and always show backfaces on meshes when we slice them open with {@link SectionPlane}s.
         * @param {Boolean} [cfg.saoEnabled=true] Indicates if Scalable Ambient Obscurance (SAO) will apply to this SceneModel. SAO is configured by the Scene's {@link SAO} component.
         * @param {Boolean} [cfg.pbrEnabled=true] Indicates if physically-based rendering (PBR) will apply to the SceneModel when {@link Scene#pbrEnabled} is ````true````.
         * @param {Boolean} [cfg.colorTextureEnabled=true] Indicates if base color textures will be rendered for the SceneModel when {@link Scene#colorTextureEnabled} is ````true````.
         * @param {Number} [cfg.edgeThreshold=10] When xraying, highlighting, selecting or edging, this is the threshold angle between normals of adjacent triangles, below which their shared wireframe edge is not drawn.
         * @param {Number} [cfg.maxGeometryBatchSize=50000000] Maximum geometry batch size, as number of vertices. This is optionally supplied
         * to limit the size of the batched geometry arrays that SceneModel internally creates for batched geometries.
         * A lower value means less heap allocation/de-allocation while creating/loading batched geometries, but more draw calls and
         * slower rendering speed. A high value means larger heap allocation/de-allocation while creating/loading, but less draw calls
         * and faster rendering speed. It's recommended to keep this somewhere roughly between ````50000```` and ````50000000```.
         * @param {TextureTranscoder} [cfg.textureTranscoder] Transcoder that will be used internally by {@link SceneModel#createTexture}
         * to convert transcoded texture data. Only required when we'll be providing transcoded data
         * to {@link SceneModel#createTexture}. We assume that all transcoded texture data added to a  ````SceneModel````
         * will then in a format supported by this transcoder.
         * @param {Boolean} [cfg.dtxEnabled=true] When ````true```` (default) use data textures (DTX), where appropriate, to
         * represent the returned model. Set false to always use vertex buffer objects (VBOs). Note that DTX is only applicable
         * to non-textured triangle meshes, and that VBOs are always used for meshes that have textures, line segments, or point
         * primitives. Only works while {@link DTX#enabled} is also ````true````.
         */
        // @reviser lijuhong 移除参数owner
        constructor(cfg = {}) {

            super(cfg);

            // @reviser lijuhong 注释scene相关代码
            this._dtxEnabled = false;//this.scene.dtxEnabled && (cfg.dtxEnabled !== false);

            this._enableVertexWelding = false; // Not needed for most objects, and very expensive, so disabled
            this._enableIndexBucketing = false; // Until fixed: https://github.com/xeokit/xeokit-sdk/issues/1204

            this._vboBatchingLayerScratchMemory = getScratchMemory();
            // this._textureTranscoder = cfg.textureTranscoder || getKTX2TextureTranscoder(this.scene.viewer);

            this._maxGeometryBatchSize = cfg.maxGeometryBatchSize;

            this._aabb = math.collapseAABB3();
            this._aabbDirty = true;

            this._quantizationRanges = {};

            this._vboInstancingLayers = {};
            this._vboBatchingLayers = {};
            this._dtxLayers = {};

            this._meshList = [];

            this.layerList = []; // For GL state efficiency when drawing, InstancingLayers are in first part, BatchingLayers are in second
            this._entityList = [];

            this._geometries = {};
            this._dtxBuckets = {}; // Geometries with optimizations used for data texture representation
            this._textures = {};
            this._textureSets = {};
            this._transforms = {};
            this._meshes = {};
            this._unusedMeshes = {};
            this._entities = {};

            /** @private **/
            this.renderFlags = new RenderFlags();

            /**
             * @private
             */
            this.numGeometries = 0; // Number of geometries created with createGeometry()

            // These counts are used to avoid unnecessary render passes
            // They are incremented or decremented exclusively by BatchingLayer and InstancingLayer

            /**
             * @private
             */
            this.numPortions = 0;

            /**
             * @private
             */
            this.numVisibleLayerPortions = 0;

            /**
             * @private
             */
            this.numTransparentLayerPortions = 0;

            /**
             * @private
             */
            this.numXRayedLayerPortions = 0;

            /**
             * @private
             */
            this.numHighlightedLayerPortions = 0;

            /**
             * @private
             */
            this.numSelectedLayerPortions = 0;

            /**
             * @private
             */
            this.numEdgesLayerPortions = 0;

            /**
             * @private
             */
            this.numPickableLayerPortions = 0;

            /**
             * @private
             */
            this.numClippableLayerPortions = 0;

            /**
             * @private
             */
            this.numCulledLayerPortions = 0;

            this.numEntities = 0;
            this._numTriangles = 0;
            this._numLines = 0;
            this._numPoints = 0;

            this._edgeThreshold = cfg.edgeThreshold || 10;

            // Build static matrix

            this._origin = math.vec3(cfg.origin || [0, 0, 0]);
            this._position = math.vec3(cfg.position || [0, 0, 0]);
            this._rotation = math.vec3(cfg.rotation || [0, 0, 0]);
            this._quaternion = math.vec4(cfg.quaternion || [0, 0, 0, 1]);
            this._conjugateQuaternion = math.vec4(cfg.quaternion || [0, 0, 0, 1]);

            if (cfg.rotation) {
                math.eulerToQuaternion(this._rotation, "XYZ", this._quaternion);
            }
            this._scale = math.vec3(cfg.scale || [1, 1, 1]);

            this._worldRotationMatrix = math.mat4();
            this._worldRotationMatrixConjugate = math.mat4();
            this._matrix = math.mat4();
            this._matrixDirty = true;

            this._rebuildMatrices();

            this._worldNormalMatrix = math.mat4();
            math.inverseMat4(this._matrix, this._worldNormalMatrix);
            math.transposeMat4(this._worldNormalMatrix);

            if (cfg.matrix || cfg.position || cfg.rotation || cfg.scale || cfg.quaternion) {
                this._viewMatrix = math.mat4();
                this._viewNormalMatrix = math.mat4();
                this._viewMatrixDirty = true;
                this._matrixNonIdentity = true;
            }

            this._opacity = 1.0;
            this._colorize = [1, 1, 1];

            this._saoEnabled = (cfg.saoEnabled !== false);
            this._pbrEnabled = (cfg.pbrEnabled !== false);
            this._colorTextureEnabled = (cfg.colorTextureEnabled !== false);

            this._isModel = cfg.isModel;
            // @reviser lijuhong 注释scene相关代码
            // if (this._isModel) {
            //     this.scene._registerModel(this);
            // }

            // @reviser lijuhong 注释scene相关代码
            // this._onCameraViewMatrix = this.scene.camera.on("matrix", () => {
            //     this._viewMatrixDirty = true;
            // });

            this._meshesWithDirtyMatrices = [];
            this._numMeshesWithDirtyMatrices = 0;

            // @reviser lijuhong 注释scene相关代码
            // this._onTick = this.scene.on("tick", () => {
            //     while (this._numMeshesWithDirtyMatrices > 0) {
            //         this._meshesWithDirtyMatrices[--this._numMeshesWithDirtyMatrices]._updateMatrix();
            //     }
            // });

            // @reviser lijuhong 注释scene相关代码
            // this._createDefaultTextureSet();

            this.visible = cfg.visible;
            this.culled = cfg.culled;
            this.pickable = cfg.pickable;
            this.clippable = cfg.clippable;
            this.collidable = cfg.collidable;
            this.castsShadow = cfg.castsShadow;
            this.receivesShadow = cfg.receivesShadow;
            this.xrayed = cfg.xrayed;
            this.highlighted = cfg.highlighted;
            this.selected = cfg.selected;
            this.edges = cfg.edges;
            this.colorize = cfg.colorize;
            this.opacity = cfg.opacity;
            this.backfaces = cfg.backfaces;
        }

        _meshMatrixDirty(mesh) {
            this._meshesWithDirtyMatrices[this._numMeshesWithDirtyMatrices++] = mesh;
        }

        // @reviser lijuhong 注释scene相关代码
        /* _createDefaultTextureSet() {
            // Every SceneModelMesh gets at least the default TextureSet,
            // which contains empty default textures filled with color
            const defaultColorTexture = new SceneModelTexture({
                id: DEFAULT_COLOR_TEXTURE_ID,
                texture: new Texture2D({
                    gl: this.scene.canvas.gl,
                    preloadColor: [1, 1, 1, 1] // [r, g, b, a]})
                })
            });
            const defaultMetalRoughTexture = new SceneModelTexture({
                id: DEFAULT_METAL_ROUGH_TEXTURE_ID,
                texture: new Texture2D({
                    gl: this.scene.canvas.gl,
                    preloadColor: [0, 1, 1, 1] // [unused, roughness, metalness, unused]
                })
            });
            const defaultNormalsTexture = new SceneModelTexture({
                id: DEFAULT_NORMALS_TEXTURE_ID,
                texture: new Texture2D({
                    gl: this.scene.canvas.gl,
                    preloadColor: [0, 0, 0, 0] // [x, y, z, unused] - these must be zeros
                })
            });
            const defaultEmissiveTexture = new SceneModelTexture({
                id: DEFAULT_EMISSIVE_TEXTURE_ID,
                texture: new Texture2D({
                    gl: this.scene.canvas.gl,
                    preloadColor: [0, 0, 0, 1] // [x, y, z, unused]
                })
            });
            const defaultOcclusionTexture = new SceneModelTexture({
                id: DEFAULT_OCCLUSION_TEXTURE_ID,
                texture: new Texture2D({
                    gl: this.scene.canvas.gl,
                    preloadColor: [1, 1, 1, 1] // [x, y, z, unused]
                })
            });
            this._textures[DEFAULT_COLOR_TEXTURE_ID] = defaultColorTexture;
            this._textures[DEFAULT_METAL_ROUGH_TEXTURE_ID] = defaultMetalRoughTexture;
            this._textures[DEFAULT_NORMALS_TEXTURE_ID] = defaultNormalsTexture;
            this._textures[DEFAULT_EMISSIVE_TEXTURE_ID] = defaultEmissiveTexture;
            this._textures[DEFAULT_OCCLUSION_TEXTURE_ID] = defaultOcclusionTexture;
            this._textureSets[DEFAULT_TEXTURE_SET_ID] = new SceneModelTextureSet({
                id: DEFAULT_TEXTURE_SET_ID,
                model: this,
                colorTexture: defaultColorTexture,
                metallicRoughnessTexture: defaultMetalRoughTexture,
                normalsTexture: defaultNormalsTexture,
                emissiveTexture: defaultEmissiveTexture,
                occlusionTexture: defaultOcclusionTexture
            });
        } */

        //------------------------------------------------------------------------------------------------------------------
        // SceneModel members
        //------------------------------------------------------------------------------------------------------------------

        /**
         * Returns true to indicate that this Component is a SceneModel.
         * @type {Boolean}
         */
        get isPerformanceModel() {
            return true;
        }

        /**
         * The {@link SceneModelTransform}s in this SceneModel.
         *
         * Each {#link SceneModelTransform} is stored here against its {@link SceneModelTransform.id}.
         *
         * @returns {*|{}}
         */
        get transforms() {
            return this._transforms;
        }

        /**
         * The {@link SceneModelTexture}s in this SceneModel.
         *
         * * Each {@link SceneModelTexture} is created with {@link SceneModel.createTexture}.
         * * Each {@link SceneModelTexture} is stored here against its {@link SceneModelTexture.id}.
         *
         * @returns {*|{}}
         */
        get textures() {
            return this._textures;
        }

        /**
         * The {@link SceneModelTextureSet}s in this SceneModel.
         *
         * Each {@link SceneModelTextureSet} is stored here against its {@link SceneModelTextureSet.id}.
         *
         * @returns {*|{}}
         */
        get textureSets() {
            return this._textureSets;
        }

        /**
         * The {@link SceneModelMesh}es in this SceneModel.
         *
         * Each {@SceneModelMesh} is stored here against its {@link SceneModelMesh.id}.
         *
         * @returns {*|{}}
         */
        get meshes() {
            return this._meshes;
        }

        /**
         * The {@link SceneModelEntity}s in this SceneModel.
         *
         * Each {#link SceneModelEntity} in this SceneModel that represents an object is
         * stored here against its {@link SceneModelTransform.id}.
         *
         * @returns {*|{}}
         */
        get objects() {
            return this._entities;
        }

        /**
         * Gets the 3D World-space origin for this SceneModel.
         *
         * Each {@link SceneModelMesh.origin}, if supplied, is relative to this origin.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Float64Array}
         */
        get origin() {
            return this._origin;
        }

        /**
         * Sets the SceneModel's local translation.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        set position(value) {
            this._position.set(value || [0, 0, 0]);
            this._setWorldMatrixDirty();
            this._sceneModelDirty();
            this.glRedraw();
        }

        /**
         * Gets the SceneModel's local translation.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        get position() {
            return this._position;
        }

        /**
         * Sets the SceneModel's local rotation, as Euler angles given in degrees, for each of the X, Y and Z axis.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        set rotation(value) {
            this._rotation.set(value || [0, 0, 0]);
            math.eulerToQuaternion(this._rotation, "XYZ", this._quaternion);
            this._setWorldMatrixDirty();
            this._sceneModelDirty();
            this.glRedraw();
        }

        /**
         * Gets the SceneModel's local rotation, as Euler angles given in degrees, for each of the X, Y and Z axis.
         *
         * Default value is ````[0,0,0]````.
         *
         * @type {Number[]}
         */
        get rotation() {
            return this._rotation;
        }

        /**
         * Sets the SceneModel's local rotation quaternion.
         *
         * Default value is ````[0,0,0,1]````.
         *
         * @type {Number[]}
         */
        set quaternion(value) {
            this._quaternion.set(value || [0, 0, 0, 1]);
            math.quaternionToEuler(this._quaternion, "XYZ", this._rotation);
            this._setWorldMatrixDirty();
            this._sceneModelDirty();
            this.glRedraw();
        }

        /**
         * Gets the SceneModel's local rotation quaternion.
         *
         * Default value is ````[0,0,0,1]````.
         *
         * @type {Number[]}
         */
        get quaternion() {
            return this._quaternion;
        }

        /**
         * Sets the SceneModel's local scale.
         *
         * Default value is ````[1,1,1]````.
         *
         * @type {Number[]}
         * @deprecated
         */
        set scale(value) {
            // NOP - deprecated
        }

        /**
         * Gets the SceneModel's local scale.
         *
         * Default value is ````[1,1,1]````.
         *
         * @type {Number[]}
         * @deprecated
         */
        get scale() {
            return this._scale;
        }

        /**
         * Sets the SceneModel's local modeling transform matrix.
         *
         * Default value is ````[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]````.
         *
         * @type {Number[]}
         */
        set matrix(value) {
            this._matrix.set(value || DEFAULT_MATRIX);

            math.quaternionToRotationMat4(this._quaternion, this._worldRotationMatrix);
            math.conjugateQuaternion(this._quaternion, this._conjugateQuaternion);
            math.quaternionToRotationMat4(this._quaternion, this._worldRotationMatrixConjugate);
            this._matrix.set(this._worldRotationMatrix);
            math.translateMat4v(this._position, this._matrix);

            this._matrixDirty = false;
            this._setWorldMatrixDirty();
            this._sceneModelDirty();
            this.glRedraw();
        }

        /**
         * Gets the SceneModel's local modeling transform matrix.
         *
         * Default value is ````[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]````.
         *
         * @type {Number[]}
         */
        get matrix() {
            if (this._matrixDirty) {
                this._rebuildMatrices();
            }
            return this._matrix;
        }

        /**
         * Gets the SceneModel's local modeling rotation transform matrix.
         *
         * @type {Number[]}
         */
        get rotationMatrix() {
            if (this._matrixDirty) {
                this._rebuildMatrices();
            }
            return this._worldRotationMatrix;
        }

        _rebuildMatrices() {
            if (this._matrixDirty) {
                math.quaternionToRotationMat4(this._quaternion, this._worldRotationMatrix);
                math.conjugateQuaternion(this._quaternion, this._conjugateQuaternion);
                math.quaternionToRotationMat4(this._quaternion, this._worldRotationMatrixConjugate);
                this._matrix.set(this._worldRotationMatrix);
                math.translateMat4v(this._position, this._matrix);
                this._matrixDirty = false;
            }
        }

        /**
         * Gets the conjugate of the SceneModel's local modeling rotation transform matrix.
         *
         * This is used for RTC view matrix management in renderers.
         *
         * @type {Number[]}
         */
        get rotationMatrixConjugate() {
            if (this._matrixDirty) {
                this._rebuildMatrices();
            }
            return this._worldRotationMatrixConjugate;
        }

        _setWorldMatrixDirty() {
            this._matrixDirty = true;
            this._aabbDirty = true;
        }

        _transformDirty() {
            this._matrixDirty = true;
            this._aabbDirty = true;
            // @reviser lijuhong 注释scene相关代码
            // this.scene._aabbDirty = true;
        }

        _sceneModelDirty() {
            // @reviser lijuhong 注释scene相关代码
            // this.scene._aabbDirty = true;
            this._aabbDirty = true;
            this._matrixDirty = true;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i]._sceneModelDirty(); // Entities need to retransform their World AABBs by SceneModel's worldMatrix
            }
        }

        /**
         * Gets the SceneModel's World matrix.
         *
         * @property worldMatrix
         * @type {Number[]}
         */
        get worldMatrix() {
            return this.matrix;
        }

        /**
         * Gets the SceneModel's World normal matrix.
         *
         * @type {Number[]}
         */
        get worldNormalMatrix() {
            return this._worldNormalMatrix;
        }

        /**
         * Called by private renderers in ./lib, returns the view matrix with which to
         * render this SceneModel. The view matrix is the concatenation of the
         * Camera view matrix with the Performance model's world (modeling) matrix.
         *
         * @private
         */
        get viewMatrix() {
            // @reviser lijuhong 注释scene相关代码
            // if (!this._viewMatrix) {
            //     return this.scene.camera.viewMatrix;
            // }
            if (this._matrixDirty) {
                this._rebuildMatrices();
                this._viewMatrixDirty = true;
            }
            if (this._viewMatrixDirty) {
                // @reviser lijuhong 注释scene相关代码
                // math.mulMat4(this.scene.camera.viewMatrix, this._matrix, this._viewMatrix);
                // math.inverseMat4(this._viewMatrix, this._viewNormalMatrix);
                // math.transposeMat4(this._viewNormalMatrix);
                this._viewMatrixDirty = false;
            }
            return this._viewMatrix;
        }

        /**
         * Called by private renderers in ./lib, returns the view normal matrix with which to render this SceneModel.
         *
         * @private
         */
        get viewNormalMatrix() {
            // @reviser lijuhong 注释scene相关代码
            // if (!this._viewNormalMatrix) {
            //     return this.scene.camera.viewNormalMatrix;
            // }
            if (this._matrixDirty) {
                this._rebuildMatrices();
                this._viewMatrixDirty = true;
            }
            if (this._viewMatrixDirty) {
                // @reviser lijuhong 注释scene相关代码
                // math.mulMat4(this.scene.camera.viewMatrix, this._matrix, this._viewMatrix);
                // math.inverseMat4(this._viewMatrix, this._viewNormalMatrix);
                // math.transposeMat4(this._viewNormalMatrix);
                this._viewMatrixDirty = false;
            }
            math.inverseMat4(this._viewMatrix, this._viewNormalMatrix);
            math.transposeMat4(this._viewNormalMatrix);
            return this._viewNormalMatrix;
        }

        /**
         * Sets if backfaces are rendered for this SceneModel.
         *
         * Default is ````false````.
         *
         * @type {Boolean}
         */
        get backfaces() {
            return this._backfaces;
        }

        /**
         * Sets if backfaces are rendered for this SceneModel.
         *
         * Default is ````false````.
         *
         * When we set this ````true````, then backfaces are always rendered for this SceneModel.
         *
         * When we set this ````false````, then we allow the Viewer to decide whether to render backfaces. In this case,
         * the Viewer will:
         *
         *  * hide backfaces on watertight meshes,
         *  * show backfaces on open meshes, and
         *  * always show backfaces on meshes when we slice them open with {@link SectionPlane}s.
         *
         * @type {Boolean}
         */
        set backfaces(backfaces) {
            backfaces = !!backfaces;
            this._backfaces = backfaces;
            this.glRedraw();
        }

        /**
         * Gets the list of {@link SceneModelEntity}s within this SceneModel.
         *
         * @returns {SceneModelEntity[]}
         */
        get entityList() {
            return this._entityList;
        }

        /**
         * Returns true to indicate that SceneModel is an {@link Entity}.
         * @type {Boolean}
         */
        get isEntity() {
            return true;
        }

        /**
         * Returns ````true```` if this SceneModel represents a model.
         *
         * When ````true```` the SceneModel will be registered by {@link SceneModel#id} in
         * {@link Scene#models} and may also have a {@link MetaObject} with matching {@link MetaObject#id}.
         *
         * @type {Boolean}
         */
        get isModel() {
            return this._isModel;
        }

        //------------------------------------------------------------------------------------------------------------------
        // SceneModel members
        //------------------------------------------------------------------------------------------------------------------

        /**
         * Returns ````false```` to indicate that SceneModel never represents an object.
         *
         * @type {Boolean}
         */
        get isObject() {
            return false;
        }

        /**
         * Gets the SceneModel's World-space 3D axis-aligned bounding box.
         *
         * Represented by a six-element Float64Array containing the min/max extents of the
         * axis-aligned volume, ie. ````[xmin, ymin,zmin,xmax,ymax, zmax]````.
         *
         * @type {Number[]}
         */
        get aabb() {
            if (this._aabbDirty) {
                math.collapseAABB3(this._aabb);
                for (let i = 0, len = this._entityList.length; i < len; i++) {
                    math.expandAABB3(this._aabb, this._entityList[i].aabb);
                }
                this._aabbDirty = false;
            }
            return this._aabb;
        }

        /**
         * The approximate number of triangle primitives in this SceneModel.
         *
         * @type {Number}
         */
        get numTriangles() {
            return this._numTriangles;
        }

        //------------------------------------------------------------------------------------------------------------------
        // Entity members
        //------------------------------------------------------------------------------------------------------------------

        /**
         * The approximate number of line primitives in this SceneModel.
         *
         * @type {Number}
         */
        get numLines() {
            return this._numLines;
        }

        /**
         * The approximate number of point primitives in this SceneModel.
         *
         * @type {Number}
         */
        get numPoints() {
            return this._numPoints;
        }

        /**
         * Gets if any {@link SceneModelEntity}s in this SceneModel are visible.
         *
         * The SceneModel is only rendered when {@link SceneModel#visible} is ````true```` and {@link SceneModel#culled} is ````false````.
         *
         * @type {Boolean}
         */
        get visible() {
            return (this.numVisibleLayerPortions > 0);
        }

        /**
         * Sets if this SceneModel is visible.
         *
         * The SceneModel is only rendered when {@link SceneModel#visible} is ````true```` and {@link SceneModel#culled} is ````false````.
         **
         * @type {Boolean}
         */
        set visible(visible) {
            visible = visible !== false;
            this._visible = visible;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].visible = visible;
            }
            this.glRedraw();
        }

        /**
         * Gets if any {@link SceneModelEntity}s in this SceneModel are xrayed.
         *
         * @type {Boolean}
         */
        get xrayed() {
            return (this.numXRayedLayerPortions > 0);
        }

        /**
         * Sets if all {@link SceneModelEntity}s in this SceneModel are xrayed.
         *
         * @type {Boolean}
         */
        set xrayed(xrayed) {
            xrayed = !!xrayed;
            this._xrayed = xrayed;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].xrayed = xrayed;
            }
            this.glRedraw();
        }

        /**
         * Gets if any {@link SceneModelEntity}s in this SceneModel are highlighted.
         *
         * @type {Boolean}
         */
        get highlighted() {
            return (this.numHighlightedLayerPortions > 0);
        }

        /**
         * Sets if all {@link SceneModelEntity}s in this SceneModel are highlighted.
         *
         * @type {Boolean}
         */
        set highlighted(highlighted) {
            highlighted = !!highlighted;
            this._highlighted = highlighted;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].highlighted = highlighted;
            }
            this.glRedraw();
        }

        /**
         * Gets if any {@link SceneModelEntity}s in this SceneModel are selected.
         *
         * @type {Boolean}
         */
        get selected() {
            return (this.numSelectedLayerPortions > 0);
        }

        /**
         * Sets if all {@link SceneModelEntity}s in this SceneModel are selected.
         *
         * @type {Boolean}
         */
        set selected(selected) {
            selected = !!selected;
            this._selected = selected;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].selected = selected;
            }
            this.glRedraw();
        }

        /**
         * Gets if any {@link SceneModelEntity}s in this SceneModel have edges emphasised.
         *
         * @type {Boolean}
         */
        get edges() {
            return (this.numEdgesLayerPortions > 0);
        }

        /**
         * Sets if all {@link SceneModelEntity}s in this SceneModel have edges emphasised.
         *
         * @type {Boolean}
         */
        set edges(edges) {
            edges = !!edges;
            this._edges = edges;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].edges = edges;
            }
            this.glRedraw();
        }

        /**
         * Gets if this SceneModel is culled from view.
         *
         * The SceneModel is only rendered when {@link SceneModel#visible} is true and {@link SceneModel#culled} is false.
         *
         * @type {Boolean}
         */
        get culled() {
            return this._culled;
        }

        /**
         * Sets if this SceneModel is culled from view.
         *
         * The SceneModel is only rendered when {@link SceneModel#visible} is true and {@link SceneModel#culled} is false.
         *
         * @type {Boolean}
         */
        set culled(culled) {
            culled = !!culled;
            this._culled = culled;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].culled = culled;
            }
            this.glRedraw();
        }

        /**
         * Gets if {@link SceneModelEntity}s in this SceneModel are clippable.
         *
         * Clipping is done by the {@link SectionPlane}s in {@link Scene#sectionPlanes}.
         *
         * @type {Boolean}
         */
        get clippable() {
            return this._clippable;
        }

        /**
         * Sets if {@link SceneModelEntity}s in this SceneModel are clippable.
         *
         * Clipping is done by the {@link SectionPlane}s in {@link Scene#sectionPlanes}.
         *
         * @type {Boolean}
         */
        set clippable(clippable) {
            clippable = clippable !== false;
            this._clippable = clippable;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].clippable = clippable;
            }
            this.glRedraw();
        }

        /**
         * Gets if this SceneModel is collidable.
         *
         * @type {Boolean}
         */
        get collidable() {
            return this._collidable;
        }

        /**
         * Sets if {@link SceneModelEntity}s in this SceneModel are collidable.
         *
         * @type {Boolean}
         */
        set collidable(collidable) {
            collidable = collidable !== false;
            this._collidable = collidable;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].collidable = collidable;
            }
        }

        /**
         * Gets if this SceneModel is pickable.
         *
         * Picking is done via calls to {@link Scene#pick}.
         *
         * @type {Boolean}
         */
        get pickable() {
            return (this.numPickableLayerPortions > 0);
        }

        /**
         * Sets if {@link SceneModelEntity}s in this SceneModel are pickable.
         *
         * Picking is done via calls to {@link Scene#pick}.
         *
         * @type {Boolean}
         */
        set pickable(pickable) {
            pickable = pickable !== false;
            this._pickable = pickable;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].pickable = pickable;
            }
        }

        /**
         * Gets the RGB colorize color for this SceneModel.
         *
         * Each element of the color is in range ````[0..1]````.
         *
         * @type {Number[]}
         */
        get colorize() {
            return this._colorize;
        }

        /**
         * Sets the RGB colorize color for this SceneModel.
         *
         * Multiplies by rendered fragment colors.
         *
         * Each element of the color is in range ````[0..1]````.
         *
         * @type {Number[]}
         */
        set colorize(colorize) {
            this._colorize = colorize;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].colorize = colorize;
            }
        }

        /**
         * Gets this SceneModel's opacity factor.
         *
         * This is a factor in range ````[0..1]```` which multiplies by the rendered fragment alphas.
         *
         * @type {Number}
         */
        get opacity() {
            return this._opacity;
        }

        /**
         * Sets the opacity factor for this SceneModel.
         *
         * This is a factor in range ````[0..1]```` which multiplies by the rendered fragment alphas.
         *
         * @type {Number}
         */
        set opacity(opacity) {
            this._opacity = opacity;
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i].opacity = opacity;
            }
        }

        /**
         * Gets if this SceneModel casts a shadow.
         *
         * @type {Boolean}
         */
        get castsShadow() {
            return this._castsShadow;
        }

        /**
         * Sets if this SceneModel casts a shadow.
         *
         * @type {Boolean}
         */
        set castsShadow(castsShadow) {
            castsShadow = (castsShadow !== false);
            if (castsShadow !== this._castsShadow) {
                this._castsShadow = castsShadow;
                this.glRedraw();
            }
        }

        /**
         * Sets if this SceneModel can have shadow cast upon it.
         *
         * @type {Boolean}
         */
        get receivesShadow() {
            return this._receivesShadow;
        }

        /**
         * Sets if this SceneModel can have shadow cast upon it.
         *
         * @type {Boolean}
         */
        set receivesShadow(receivesShadow) {
            receivesShadow = (receivesShadow !== false);
            if (receivesShadow !== this._receivesShadow) {
                this._receivesShadow = receivesShadow;
                this.glRedraw();
            }
        }

        /**
         * Gets if Scalable Ambient Obscurance (SAO) will apply to this SceneModel.
         *
         * SAO is configured by the Scene's {@link SAO} component.
         *
         *  Only works when {@link SAO#enabled} is also true.
         *
         * @type {Boolean}
         */
        get saoEnabled() {
            return this._saoEnabled;
        }

        /**
         * Gets if physically-based rendering (PBR) is enabled for this SceneModel.
         *
         * Only works when {@link Scene#pbrEnabled} is also true.
         *
         * @type {Boolean}
         */
        get pbrEnabled() {
            return this._pbrEnabled;
        }

        /**
         * Gets if color textures are enabled for this SceneModel.
         *
         * Only works when {@link Scene#colorTextureEnabled} is also true.
         *
         * @type {Boolean}
         */
        get colorTextureEnabled() {
            return this._colorTextureEnabled;
        }

        /**
         * Returns true to indicate that SceneModel is implements {@link Drawable}.
         *
         * @type {Boolean}
         */
        get isDrawable() {
            return true;
        }

        /** @private */
        get isStateSortable() {
            return false
        }

        /**
         * Configures the appearance of xrayed {@link SceneModelEntity}s within this SceneModel.
         *
         * This is the {@link Scene#xrayMaterial}.
         *
         * @type {EmphasisMaterial}
         */
        // @reviser lijuhong 注释scene相关代码
        // get xrayMaterial() {
        //     return this.scene.xrayMaterial;
        // }

        /**
         * Configures the appearance of highlighted {@link SceneModelEntity}s within this SceneModel.
         *
         * This is the {@link Scene#highlightMaterial}.
         *
         * @type {EmphasisMaterial}
         */
        // @reviser lijuhong 注释scene相关代码
        // get highlightMaterial() {
        //     return this.scene.highlightMaterial;
        // }

        /**
         * Configures the appearance of selected {@link SceneModelEntity}s within this SceneModel.
         *
         * This is the {@link Scene#selectedMaterial}.
         *
         * @type {EmphasisMaterial}
         */
        // @reviser lijuhong 注释scene相关代码
        // get selectedMaterial() {
        //     return this.scene.selectedMaterial;
        // }

        /**
         * Configures the appearance of edges of {@link SceneModelEntity}s within this SceneModel.
         *
         * This is the {@link Scene#edgeMaterial}.
         *
         * @type {EdgeMaterial}
         */
        // @reviser lijuhong 注释scene相关代码
        // get edgeMaterial() {
        //     return this.scene.edgeMaterial;
        // }

        //------------------------------------------------------------------------------------------------------------------
        // Drawable members
        //------------------------------------------------------------------------------------------------------------------

        /**
         * Called by private renderers in ./lib, returns the picking view matrix with which to
         * ray-pick on this SceneModel.
         *
         * @private
         */
        getPickViewMatrix(pickViewMatrix) {
            if (!this._viewMatrix) {
                return pickViewMatrix;
            }
            return this._viewMatrix;
        }

        /**
         *
         * @param cfg
         */
        createQuantizationRange(cfg) {
            if (cfg.id === undefined || cfg.id === null) {
                this.error("[createQuantizationRange] Config missing: id");
                return;
            }
            if (cfg.aabb) {
                this.error("[createQuantizationRange] Config missing: aabb");
                return;
            }
            if (this._quantizationRanges[cfg.id]) {
                this.error("[createQuantizationRange] QuantizationRange already created: " + cfg.id);
                return;
            }
            this._quantizationRanges[cfg.id] = {
                id: cfg.id,
                aabb: cfg.aabb,
                matrix: createPositionsDecodeMatrix$1(cfg.aabb, math.mat4())
            };
        }

        /**
         * Creates a reusable geometry within this SceneModel.
         *
         * We can then supply the geometry ID to {@link SceneModel#createMesh} when we want to create meshes that
         * instance the geometry.
         *
         * @param {*} cfg Geometry properties.
         * @param {String|Number} cfg.id Mandatory ID for the geometry, to refer to with {@link SceneModel#createMesh}.
         * @param {String} cfg.primitive The primitive type. Accepted values are 'points', 'lines', 'triangles', 'solid' and 'surface'.
         * @param {Number[]} [cfg.positions] Flat array of uncompressed 3D vertex positions positions. Required for all primitive types. Overridden by ````positionsCompressed````.
         * @param {Number[]} [cfg.positionsCompressed] Flat array of quantized 3D vertex positions. Overrides ````positions````, and must be accompanied by ````positionsDecodeMatrix````.
         * @param {Number[]} [cfg.positionsDecodeMatrix] A 4x4 matrix for decompressing ````positionsCompressed````. Must be accompanied by ````positionsCompressed````.
         * @param {Number[]} [cfg.normals] Flat array of normal vectors. Only used with "triangles", "solid" and "surface" primitives. When no normals are given, the geometry will be flat shaded using auto-generated face-aligned normals.
         * @param {Number[]} [cfg.normalsCompressed] Flat array of oct-encoded normal vectors. Overrides ````normals````. Only used with "triangles", "solid" and "surface" primitives. When no normals are given, the geometry will be flat shaded using auto-generated face-aligned normals.
         * @param {Number[]} [cfg.colors] Flat array of uncompressed RGBA vertex colors, as float values in range ````[0..1]````. Ignored when ````geometryId```` is given. Overridden by ````color```` and ````colorsCompressed````.
         * @param {Number[]} [cfg.colorsCompressed] Flat array of compressed RGBA vertex colors, as unsigned short integers in range ````[0..255]````. Ignored when ````geometryId```` is given. Overrides ````colors```` and is overridden by ````color````.
         * @param {Number[]} [cfg.uv] Flat array of uncompressed vertex UV coordinates. Only used with "triangles", "solid" and "surface" primitives. Required for textured rendering.
         * @param {Number[]} [cfg.uvCompressed] Flat array of compressed vertex UV coordinates. Only used with "triangles", "solid" and "surface" primitives. Overrides ````uv````. Must be accompanied by ````uvDecodeMatrix````. Only used with "triangles", "solid" and "surface" primitives. Required for textured rendering.
         * @param {Number[]} [cfg.uvDecodeMatrix] A 3x3 matrix for decompressing ````uvCompressed````.
         * @param {Number[]} [cfg.indices] Array of primitive connectivity indices. Not required for `points` primitives.
         * @param {Number[]} [cfg.edgeIndices] Array of edge line indices. Used only with 'triangles', 'solid' and 'surface' primitives. Automatically generated internally if not supplied, using the optional ````edgeThreshold```` given to the ````SceneModel```` constructor.
         */
        createGeometry(cfg) {
            if (cfg.id === undefined || cfg.id === null) {
                this.error("[createGeometry] Config missing: id");
                return;
            }
            if (this._geometries[cfg.id]) {
                this.error("[createGeometry] Geometry already created: " + cfg.id);
                return;
            }
            if (cfg.primitive === undefined || cfg.primitive === null) {
                cfg.primitive = "triangles";
            }
            if (cfg.primitive !== "points" && cfg.primitive !== "lines" && cfg.primitive !== "triangles" && cfg.primitive !== "solid" && cfg.primitive !== "surface") {
                this.error(`[createGeometry] Unsupported value for 'primitive': '${cfg.primitive}' - supported values are 'points', 'lines', 'triangles', 'solid' and 'surface'. Defaulting to 'triangles'.`);
                return;
            }
            if (!cfg.positions && !cfg.positionsCompressed && !cfg.buckets) {
                this.error("[createGeometry] Param expected: `positions`,  `positionsCompressed' or 'buckets");
                return null;
            }
            if (cfg.positionsCompressed && !cfg.positionsDecodeMatrix && !cfg.positionsDecodeBoundary) {
                this.error("[createGeometry] Param expected: `positionsDecodeMatrix` or 'positionsDecodeBoundary' (required for `positionsCompressed')");
                return null;
            }
            if (cfg.positionsDecodeMatrix && cfg.positionsDecodeBoundary) {
                this.error("[createGeometry] Only one of these params expected: `positionsDecodeMatrix` or 'positionsDecodeBoundary' (required for `positionsCompressed')");
                return null;
            }
            if (cfg.uvCompressed && !cfg.uvDecodeMatrix) {
                this.error("[createGeometry] Param expected: `uvDecodeMatrix` (required for `uvCompressed')");
                return null;
            }
            if (!cfg.buckets && !cfg.indices && (cfg.primitive === "triangles" || cfg.primitive === "solid" || cfg.primitive === "surface")) {
                const numPositions = (cfg.positions || cfg.positionsCompressed).length / 3;
                cfg.indices = this._createDefaultIndices(numPositions);
            }
            if (!cfg.buckets && !cfg.indices && cfg.primitive !== "points") {
                this.error(`[createGeometry] Param expected: indices (required for '${cfg.primitive}' primitive type)`);
                return null;
            }
            if (cfg.positionsDecodeBoundary) {
                cfg.positionsDecodeMatrix = createPositionsDecodeMatrix$1(cfg.positionsDecodeBoundary, math.mat4());
            }
            if (cfg.positions) {
                const aabb = math.collapseAABB3();
                cfg.positionsDecodeMatrix = math.mat4();
                math.expandAABB3Points3(aabb, cfg.positions);
                cfg.positionsCompressed = quantizePositions(cfg.positions, aabb, cfg.positionsDecodeMatrix);
                cfg.aabb = aabb;
            } else if (cfg.positionsCompressed) {
                const aabb = math.collapseAABB3();
                cfg.positionsDecodeMatrix = new Float64Array(cfg.positionsDecodeMatrix);
                cfg.positionsCompressed = new Uint16Array(cfg.positionsCompressed);
                math.expandAABB3Points3(aabb, cfg.positionsCompressed);
                geometryCompressionUtils.decompressAABB(aabb, cfg.positionsDecodeMatrix);
                cfg.aabb = aabb;
                // @reviser lijuhong 解压positionsCompressed以获得positions
                cfg.positions = geometryCompressionUtils.decompressPositions(cfg.positionsCompressed, cfg.positionsDecodeMatrix, new Float64Array(cfg.positionsCompressed.length));
            } else if (cfg.buckets) {
                const aabb = math.collapseAABB3();
                this._dtxBuckets[cfg.id] = cfg.buckets;
                for (let i = 0, len = cfg.buckets.length; i < len; i++) {
                    const bucket = cfg.buckets[i];
                    if (bucket.positions) {
                        math.expandAABB3Points3(aabb, bucket.positions);
                    } else if (bucket.positionsCompressed) {
                        math.expandAABB3Points3(aabb, bucket.positionsCompressed);
                        // @reviser lijuhong 解压positionsCompressed以获得positions
                        bucket.positions = geometryCompressionUtils.decompressPositions(bucket.positionsCompressed, cfg.positionsDecodeMatrix, new Float64Array(bucket.positionsCompressed.length));
                    }
                }
                if (cfg.positionsDecodeMatrix) {
                    geometryCompressionUtils.decompressAABB(aabb, cfg.positionsDecodeMatrix);
                }
                cfg.aabb = aabb;
            }
            if (cfg.colorsCompressed && cfg.colorsCompressed.length > 0) {
                cfg.colorsCompressed = new Uint8Array(cfg.colorsCompressed);
            } else if (cfg.colors && cfg.colors.length > 0) {
                const colors = cfg.colors;
                const colorsCompressed = new Uint8Array(colors.length);
                for (let i = 0, len = colors.length; i < len; i++) {
                    colorsCompressed[i] = colors[i] * 255;
                }
                cfg.colorsCompressed = colorsCompressed;
            }
            if (!cfg.buckets && !cfg.edgeIndices && (cfg.primitive === "triangles" || cfg.primitive === "solid" || cfg.primitive === "surface")) {
                if (cfg.positions) {
                    cfg.edgeIndices = buildEdgeIndices(cfg.positions, cfg.indices, null, 5.0);
                } else {
                    cfg.edgeIndices = buildEdgeIndices(cfg.positionsCompressed, cfg.indices, cfg.positionsDecodeMatrix, 2.0);
                }
            }
            if (cfg.uv) {
                const bounds = geometryCompressionUtils.getUVBounds(cfg.uv);
                const result = geometryCompressionUtils.compressUVs(cfg.uv, bounds.min, bounds.max);
                cfg.uvCompressed = result.quantized;
                cfg.uvDecodeMatrix = result.decodeMatrix;
            } else if (cfg.uvCompressed) {
                cfg.uvCompressed = new Uint16Array(cfg.uvCompressed);
                cfg.uvDecodeMatrix = new Float64Array(cfg.uvDecodeMatrix);
                // @reviser lijuhong 解压uvCompressed以获得uv
                cfg.uv = geometryCompressionUtils.decompressUVs(cfg.uvCompressed, cfg.uvDecodeMatrix);
            }
            if (cfg.normals) { // HACK
                cfg.normals = null;
            }
            this._geometries [cfg.id] = cfg;
            this._numTriangles += (cfg.indices ? Math.round(cfg.indices.length / 3) : 0);
            this.numGeometries++;
        }

        /**
         * Creates a texture within this SceneModel.
         *
         * We can then supply the texture ID to {@link SceneModel#createTextureSet} when we want to create texture sets that use the texture.
         *
         * @param {*} cfg Texture properties.
         * @param {String|Number} cfg.id Mandatory ID for the texture, to refer to with {@link SceneModel#createTextureSet}.
         * @param {String} [cfg.src] Image file for the texture. Assumed to be transcoded if not having a recognized image file
         * extension (jpg, jpeg, png etc.). If transcoded, then assumes ````SceneModel```` is configured with a {@link TextureTranscoder}.
         * @param {ArrayBuffer[]} [cfg.buffers] Transcoded texture data. Assumes ````SceneModel```` is
         * configured with a {@link TextureTranscoder}. This parameter is given as an array of buffers so we can potentially support multi-image textures, such as cube maps.
         * @param {HTMLImageElement} [cfg.image] HTML Image object to load into this texture. Overrides ````src```` and ````buffers````. Never transcoded.
         * @param {Number} [cfg.minFilter=LinearMipmapLinearFilter] How the texture is sampled when a texel covers less than one pixel.
         * Supported values are {@link LinearMipmapLinearFilter}, {@link LinearMipMapNearestFilter}, {@link NearestMipMapNearestFilter}, {@link NearestMipMapLinearFilter} and {@link LinearMipMapLinearFilter}.
         * @param {Number} [cfg.magFilter=LinearFilter] How the texture is sampled when a texel covers more than one pixel. Supported values are {@link LinearFilter} and {@link NearestFilter}.
         * @param {Number} [cfg.wrapS=RepeatWrapping] Wrap parameter for texture coordinate *S*. Supported values are {@link ClampToEdgeWrapping}, {@link MirroredRepeatWrapping} and {@link RepeatWrapping}.
         * @param {Number} [cfg.wrapT=RepeatWrapping] Wrap parameter for texture coordinate *T*. Supported values are {@link ClampToEdgeWrapping}, {@link MirroredRepeatWrapping} and {@link RepeatWrapping}..
         * @param {Number} [cfg.wrapR=RepeatWrapping] Wrap parameter for texture coordinate *R*. Supported values are {@link ClampToEdgeWrapping}, {@link MirroredRepeatWrapping} and {@link RepeatWrapping}.
         * @param {Boolean} [cfg.flipY=false] Flips this Texture's source data along its vertical axis when ````true````.
         * @param  {Number} [cfg.encoding=LinearEncoding] Encoding format. Supported values are {@link LinearEncoding} and {@link sRGBEncoding}.
         */
        createTexture(cfg) {
            const textureId = cfg.id;
            if (textureId === undefined || textureId === null) {
                this.error("[createTexture] Config missing: id");
                return;
            }
            if (this._textures[textureId]) {
                this.error("[createTexture] Texture already created: " + textureId);
                return;
            }
            if (!cfg.src && !cfg.image && !cfg.buffers) {
                this.error("[createTexture] Param expected: `src`, `image' or 'buffers'");
                return null;
            }
            let minFilter = cfg.minFilter || LinearMipmapLinearFilter;
            if (minFilter !== LinearFilter &&
                minFilter !== LinearMipMapNearestFilter &&
                minFilter !== LinearMipmapLinearFilter &&
                minFilter !== NearestMipMapLinearFilter &&
                minFilter !== NearestMipMapNearestFilter) {
                this.error(`[createTexture] Unsupported value for 'minFilter' - 
            supported values are LinearFilter, LinearMipMapNearestFilter, NearestMipMapNearestFilter, 
            NearestMipMapLinearFilter and LinearMipmapLinearFilter. Defaulting to LinearMipmapLinearFilter.`);
                minFilter = LinearMipmapLinearFilter;
            }
            let magFilter = cfg.magFilter || LinearFilter;
            if (magFilter !== LinearFilter && magFilter !== NearestFilter) {
                this.error(`[createTexture] Unsupported value for 'magFilter' - supported values are LinearFilter and NearestFilter. Defaulting to LinearFilter.`);
                magFilter = LinearFilter;
            }
            let wrapS = cfg.wrapS || RepeatWrapping;
            if (wrapS !== ClampToEdgeWrapping && wrapS !== MirroredRepeatWrapping && wrapS !== RepeatWrapping) {
                this.error(`[createTexture] Unsupported value for 'wrapS' - supported values are ClampToEdgeWrapping, MirroredRepeatWrapping and RepeatWrapping. Defaulting to RepeatWrapping.`);
                wrapS = RepeatWrapping;
            }
            let wrapT = cfg.wrapT || RepeatWrapping;
            if (wrapT !== ClampToEdgeWrapping && wrapT !== MirroredRepeatWrapping && wrapT !== RepeatWrapping) {
                this.error(`[createTexture] Unsupported value for 'wrapT' - supported values are ClampToEdgeWrapping, MirroredRepeatWrapping and RepeatWrapping. Defaulting to RepeatWrapping.`);
                wrapT = RepeatWrapping;
            }
            let wrapR = cfg.wrapR || RepeatWrapping;
            if (wrapR !== ClampToEdgeWrapping && wrapR !== MirroredRepeatWrapping && wrapR !== RepeatWrapping) {
                this.error(`[createTexture] Unsupported value for 'wrapR' - supported values are ClampToEdgeWrapping, MirroredRepeatWrapping and RepeatWrapping. Defaulting to RepeatWrapping.`);
                wrapR = RepeatWrapping;
            }
            let encoding = cfg.encoding || LinearEncoding;
            if (encoding !== LinearEncoding && encoding !== sRGBEncoding) {
                this.error("[createTexture] Unsupported value for 'encoding' - supported values are LinearEncoding and sRGBEncoding. Defaulting to LinearEncoding.");
                encoding = LinearEncoding;
            }
            // @reivser lijuhong 注释掉Texture2D相关代码
            // const texture = new Texture2D({
            //     gl: this.scene.canvas.gl,
            //     minFilter,
            //     magFilter,
            //     wrapS,
            //     wrapT,
            //     wrapR,
            //     // flipY: cfg.flipY,
            //     encoding
            // });
            // if (cfg.preloadColor) {
            //     texture.setPreloadColor(cfg.preloadColor);
            // }
            // if (cfg.image) { // Ignore transcoder for Images
            //     const image = cfg.image;
            //     image.crossOrigin = "Anonymous";
            //     texture.setImage(image, {minFilter, magFilter, wrapS, wrapT, wrapR, flipY: cfg.flipY, encoding});
            // } else if (cfg.src) {
            //     const ext = cfg.src.split('.').pop();
            //     switch (ext) { // Don't transcode recognized image file types
            //         case "jpeg":
            //         case "jpg":
            //         case "png":
            //         case "gif":
            //             const image = new Image();
            //             image.onload = () => {
            //                 texture.setImage(image, {
            //                     minFilter,
            //                     magFilter,
            //                     wrapS,
            //                     wrapT,
            //                     wrapR,
            //                     flipY: cfg.flipY,
            //                     encoding
            //                 });
            //                 this.glRedraw();
            //             };
            //             image.src = cfg.src; // URL or Base64 string
            //             break;
            //         default: // Assume other file types need transcoding
            //             if (!this._textureTranscoder) {
            //                 this.error(`[createTexture] Can't create texture from 'src' - SceneModel needs to be configured with a TextureTranscoder for this file type ('${ext}')`);
            //             } else {
            //                 utils.loadArraybuffer(cfg.src, (arrayBuffer) => {
            //                         if (!arrayBuffer.byteLength) {
            //                             this.error(`[createTexture] Can't create texture from 'src': file data is zero length`);
            //                             return;
            //                         }
            //                         this._textureTranscoder.transcode([arrayBuffer], texture).then(() => {
            //                             this.glRedraw();
            //                         });
            //                     },
            //                     function (errMsg) {
            //                         this.error(`[createTexture] Can't create texture from 'src': ${errMsg}`);
            //                     });
            //             }
            //             break;
            //     }
            // } else if (cfg.buffers) { // Buffers implicitly require transcoding
            //     if (!this._textureTranscoder) {
            //         this.error(`[createTexture] Can't create texture from 'buffers' - SceneModel needs to be configured with a TextureTranscoder for this option`);
            //     } else {
            //         this._textureTranscoder.transcode(cfg.buffers, texture).then(() => {
            //             this.glRedraw();
            //         });
            //     }
            // }
            // this._textures[textureId] = new SceneModelTexture({id: textureId, texture});
            // @reivser lijuhong 保存传入的cfg
            this._textures[textureId] = cfg;
        }

        /**
         * Creates a texture set within this SceneModel.
         *
         * * Stores the new {@link SceneModelTextureSet} in {@link SceneModel#textureSets}.
         *
         * A texture set is a collection of textures that can be shared among meshes. We can then supply the texture set
         * ID to {@link SceneModel#createMesh} when we want to create meshes that use the texture set.
         *
         * The textures can work as a texture atlas, where each mesh can have geometry UVs that index
         * a different part of the textures. This allows us to minimize the number of textures in our models, which
         * means faster rendering.
         *
         * @param {*} cfg Texture set properties.
         * @param {String|Number} cfg.id Mandatory ID for the texture set, to refer to with {@link SceneModel#createMesh}.
         * @param {*} [cfg.colorTextureId] ID of *RGBA* base color texture, with color in *RGB* and alpha in *A*.
         * @param {*} [cfg.metallicRoughnessTextureId] ID of *RGBA* metal-roughness texture, with the metallic factor in *R*, and roughness factor in *G*.
         * @param {*} [cfg.normalsTextureId] ID of *RGBA* normal map texture, with normal map vectors in *RGB*.
         * @param {*} [cfg.emissiveTextureId] ID of *RGBA* emissive map texture, with emissive color in *RGB*.
         * @param {*} [cfg.occlusionTextureId] ID of *RGBA* occlusion map texture, with occlusion factor in *R*.
         * @returns {SceneModelTransform} The new texture set.
         */
        createTextureSet(cfg) {
            const textureSetId = cfg.id;
            if (textureSetId === undefined || textureSetId === null) {
                this.error("[createTextureSet] Config missing: id");
                return;
            }
            if (this._textureSets[textureSetId]) {
                this.error(`[createTextureSet] Texture set already created: ${textureSetId}`);
                return;
            }
            let colorTexture;
            if (cfg.colorTextureId !== undefined && cfg.colorTextureId !== null) {
                colorTexture = this._textures[cfg.colorTextureId];
                if (!colorTexture) {
                    this.error(`[createTextureSet] Texture not found: ${cfg.colorTextureId} - ensure that you create it first with createTexture()`);
                    return;
                }
            } else {
                colorTexture = this._textures[DEFAULT_COLOR_TEXTURE_ID];
            }
            let metallicRoughnessTexture;
            if (cfg.metallicRoughnessTextureId !== undefined && cfg.metallicRoughnessTextureId !== null) {
                metallicRoughnessTexture = this._textures[cfg.metallicRoughnessTextureId];
                if (!metallicRoughnessTexture) {
                    this.error(`[createTextureSet] Texture not found: ${cfg.metallicRoughnessTextureId} - ensure that you create it first with createTexture()`);
                    return;
                }
            } else {
                metallicRoughnessTexture = this._textures[DEFAULT_METAL_ROUGH_TEXTURE_ID];
            }
            let normalsTexture;
            if (cfg.normalsTextureId !== undefined && cfg.normalsTextureId !== null) {
                normalsTexture = this._textures[cfg.normalsTextureId];
                if (!normalsTexture) {
                    this.error(`[createTextureSet] Texture not found: ${cfg.normalsTextureId} - ensure that you create it first with createTexture()`);
                    return;
                }
            } else {
                normalsTexture = this._textures[DEFAULT_NORMALS_TEXTURE_ID];
            }
            let emissiveTexture;
            if (cfg.emissiveTextureId !== undefined && cfg.emissiveTextureId !== null) {
                emissiveTexture = this._textures[cfg.emissiveTextureId];
                if (!emissiveTexture) {
                    this.error(`[createTextureSet] Texture not found: ${cfg.emissiveTextureId} - ensure that you create it first with createTexture()`);
                    return;
                }
            } else {
                emissiveTexture = this._textures[DEFAULT_EMISSIVE_TEXTURE_ID];
            }
            let occlusionTexture;
            if (cfg.occlusionTextureId !== undefined && cfg.occlusionTextureId !== null) {
                occlusionTexture = this._textures[cfg.occlusionTextureId];
                if (!occlusionTexture) {
                    this.error(`[createTextureSet] Texture not found: ${cfg.occlusionTextureId} - ensure that you create it first with createTexture()`);
                    return;
                }
            } else {
                occlusionTexture = this._textures[DEFAULT_OCCLUSION_TEXTURE_ID];
            }
            const textureSet = new SceneModelTextureSet({
                id: textureSetId,
                model: this,
                colorTexture,
                metallicRoughnessTexture,
                normalsTexture,
                emissiveTexture,
                occlusionTexture
            });
            this._textureSets[textureSetId] = textureSet;
            return textureSet;
        }

        /**
         * Creates a new {@link SceneModelTransform} within this SceneModel.
         *
         * * Stores the new {@link SceneModelTransform} in {@link SceneModel#transforms}.
         * * Can be connected into hierarchies
         * * Each {@link SceneModelTransform} can be used by unlimited {@link SceneModelMesh}es
         *
         * @param {*} cfg Transform creation parameters.
         * @param {String} cfg.id Mandatory ID for the new transform. Must not clash with any existing components within the {@link Scene}.
         * @param {String} [cfg.parentTransformId] ID of a parent transform, previously created with {@link SceneModel#createTextureSet}.
         * @param {Number[]} [cfg.position=[0,0,0]] Local 3D position of the mesh. Overridden by ````transformId````.
         * @param {Number[]} [cfg.scale=[1,1,1]] Scale of the transform.
         * @param {Number[]} [cfg.rotation=[0,0,0]] Rotation of the transform as Euler angles given in degrees, for each of the X, Y and Z axis.
         * @param {Number[]} [cfg.matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]] Modelling transform matrix. Overrides the ````position````, ````scale```` and ````rotation```` parameters.
         * @returns {SceneModelTransform} The new transform.
         */
        createTransform(cfg) {
            if (cfg.id === undefined || cfg.id === null) {
                this.error("[createTransform] SceneModel.createTransform() config missing: id");
                return;
            }
            if (this._transforms[cfg.id]) {
                this.error(`[createTransform] SceneModel already has a transform with this ID: ${cfg.id}`);
                return;
            }
            let parentTransform;
            if (cfg.parentTransformId) {
                parentTransform = this._transforms[cfg.parentTransformId];
                if (!parentTransform) {
                    this.error("[createTransform] SceneModel.createTransform() config missing: id");
                    return;
                }
            }
            const transform = new SceneModelTransform({
                id: cfg.id,
                model: this,
                parentTransform,
                matrix: cfg.matrix,
                position: cfg.position,
                scale: cfg.scale,
                rotation: cfg.rotation,
                quaternion: cfg.quaternion
            });
            this._transforms[transform.id] = transform;
            return transform;
        }

        /**
         * Creates a new {@link SceneModelMesh} within this SceneModel.
         *
         * * It prepares and saves data for a SceneModelMesh {@link SceneModel#meshes} creation. SceneModelMesh will be created only once the SceneModelEntity (which references this particular SceneModelMesh) will be created.
         * * The SceneModelMesh can either define its own geometry or share it with other SceneModelMeshes. To define own geometry, provide the
         * various geometry arrays to this method. To share a geometry, provide the ID of a geometry created earlier
         * with {@link SceneModel#createGeometry}.
         * * If you accompany the arrays with an  ````origin````, then ````createMesh()```` will assume
         * that the geometry ````positions```` are in relative-to-center (RTC) coordinates, with ````origin```` being the
         * origin of their RTC coordinate system.
         *
         * @param {object} cfg Object properties.
         * @param {String} cfg.id Mandatory ID for the new mesh. Must not clash with any existing components within the {@link Scene}.
         * @param {String|Number} [cfg.textureSetId] ID of a {@link SceneModelTextureSet} previously created with {@link SceneModel#createTextureSet}.
         * @param {String|Number} [cfg.transformId] ID of a {@link SceneModelTransform} to instance, previously created with {@link SceneModel#createTransform}. Overrides all other transform parameters given to this method.
         * @param {String|Number} [cfg.geometryId] ID of a geometry to instance, previously created with {@link SceneModel#createGeometry}. Overrides all other geometry parameters given to this method.
         * @param {String} cfg.primitive The primitive type. Accepted values are 'points', 'lines', 'triangles', 'solid' and 'surface'.
         * @param {Number[]} [cfg.positions] Flat array of uncompressed 3D vertex positions positions. Required for all primitive types. Overridden by ````positionsCompressed````.
         * @param {Number[]} [cfg.positionsCompressed] Flat array of quantized 3D vertex positions. Overrides ````positions````, and must be accompanied by ````positionsDecodeMatrix````.
         * @param {Number[]} [cfg.positionsDecodeMatrix] A 4x4 matrix for decompressing ````positionsCompressed````. Must be accompanied by ````positionsCompressed````.
         * @param {Number[]} [cfg.normals] Flat array of normal vectors. Only used with "triangles", "solid" and "surface" primitives. When no normals are given, the geometry will be flat shaded using auto-generated face-aligned normals.
         * @param {Number[]} [cfg.normalsCompressed] Flat array of oct-encoded normal vectors. Overrides ````normals````. Only used with "triangles", "solid" and "surface" primitives. When no normals are given, the geometry will be flat shaded using auto-generated face-aligned normals.
         * @param {Number[]} [cfg.colors] Flat array of uncompressed RGBA vertex colors, as float values in range ````[0..1]````. Ignored when ````geometryId```` is given. Overridden by ````color```` and ````colorsCompressed````.
         * @param {Number[]} [cfg.colorsCompressed] Flat array of compressed RGBA vertex colors, as unsigned short integers in range ````[0..255]````. Ignored when ````geometryId```` is given. Overrides ````colors```` and is overridden by ````color````.
         * @param {Number[]} [cfg.uv] Flat array of uncompressed vertex UV coordinates. Only used with "triangles", "solid" and "surface" primitives. Required for textured rendering.
         * @param {Number[]} [cfg.uvCompressed] Flat array of compressed vertex UV coordinates. Only used with "triangles", "solid" and "surface" primitives. Overrides ````uv````. Must be accompanied by ````uvDecodeMatrix````. Only used with "triangles", "solid" and "surface" primitives. Required for textured rendering.
         * @param {Number[]} [cfg.uvDecodeMatrix] A 3x3 matrix for decompressing ````uvCompressed````.
         * @param {Number[]} [cfg.indices] Array of primitive connectivity indices. Not required for `points` primitives.
         * @param {Number[]} [cfg.edgeIndices] Array of edge line indices. Used only with 'triangles', 'solid' and 'surface' primitives. Automatically generated internally if not supplied, using the optional ````edgeThreshold```` given to the ````SceneModel```` constructor.
         * @param {Number[]} [cfg.origin] Optional geometry origin, relative to {@link SceneModel#origin}. When this is given, then ````positions```` are assumed to be relative to this.
         * @param {Number[]} [cfg.position=[0,0,0]] Local 3D position of the mesh. Overridden by ````transformId````.
         * @param {Number[]} [cfg.scale=[1,1,1]] Scale of the mesh.  Overridden by ````transformId````.
         * @param {Number[]} [cfg.rotation=[0,0,0]] Rotation of the mesh as Euler angles given in degrees, for each of the X, Y and Z axis.  Overridden by ````transformId````.
         * @param {Number[]} [cfg.matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]] Mesh modelling transform matrix. Overrides the ````position````, ````scale```` and ````rotation```` parameters. Also  overridden by ````transformId````.
         * @param {Number[]} [cfg.color=[1,1,1]] RGB color in range ````[0..1, 0..1, 0..1]````. Overridden by texture set ````colorTexture````. Overrides ````colors```` and ````colorsCompressed````.
         * @param {Number} [cfg.opacity=1] Opacity in range ````[0..1]````. Overridden by texture set ````colorTexture````.
         * @param {Number} [cfg.metallic=0] Metallic factor in range ````[0..1]````. Overridden by texture set ````metallicRoughnessTexture````.
         * @param {Number} [cfg.roughness=1] Roughness factor in range ````[0..1]````. Overridden by texture set ````metallicRoughnessTexture````.
         * @returns {SceneModelMesh} The new mesh.
         */
        createMesh(cfg) {

            if (cfg.id === undefined || cfg.id === null) {
                this.error("[createMesh] SceneModel.createMesh() config missing: id");
                return false;
            }

            if (this._meshes[cfg.id]) {
                this.error(`[createMesh] SceneModel already has a mesh with this ID: ${cfg.id}`);
                return false;
            }

            const instancing = (cfg.geometryId !== undefined);
            const batching = !instancing;

            if (batching) {

                // Batched geometry

                if (cfg.primitive === undefined || cfg.primitive === null) {
                    cfg.primitive = "triangles";
                }
                if (cfg.primitive !== "points" && cfg.primitive !== "lines" && cfg.primitive !== "triangles" && cfg.primitive !== "solid" && cfg.primitive !== "surface") {
                    this.error(`Unsupported value for 'primitive': '${primitive}'  ('geometryId' is absent) - supported values are 'points', 'lines', 'triangles', 'solid' and 'surface'.`);
                    return false;
                }
                if (!cfg.positions && !cfg.positionsCompressed && !cfg.buckets) {
                    this.error("Param expected: 'positions',  'positionsCompressed' or `buckets`  ('geometryId' is absent)");
                    return false;
                }
                if (cfg.positions && (cfg.positionsDecodeMatrix || cfg.positionsDecodeBoundary)) {
                    this.error("Illegal params: 'positions' not expected with 'positionsDecodeMatrix'/'positionsDecodeBoundary' ('geometryId' is absent)");
                    return false;
                }
                if (cfg.positionsCompressed && !cfg.positionsDecodeMatrix && !cfg.positionsDecodeBoundary) {
                    this.error("Param expected: 'positionsCompressed' should be accompanied by 'positionsDecodeMatrix'/'positionsDecodeBoundary' ('geometryId' is absent)");
                    return false;
                }
                if (cfg.uvCompressed && !cfg.uvDecodeMatrix) {
                    this.error("Param expected: 'uvCompressed' should be accompanied by `uvDecodeMatrix` ('geometryId' is absent)");
                    return false;
                }
                if (!cfg.buckets && !cfg.indices && (cfg.primitive === "triangles" || cfg.primitive === "solid" || cfg.primitive === "surface")) {
                    const numPositions = (cfg.positions || cfg.positionsCompressed).length / 3;
                    cfg.indices = this._createDefaultIndices(numPositions);
                }
                if (!cfg.buckets && !cfg.indices && cfg.primitive !== "points") {
                    cfg.indices = this._createDefaultIndices(numIndices);
                    this.error(`Param expected: indices (required for '${cfg.primitive}' primitive type)`);
                    return false;
                }
                if ((cfg.matrix || cfg.position || cfg.rotation || cfg.scale) && (cfg.positionsCompressed || cfg.positionsDecodeBoundary)) {
                    this.error("Unexpected params: 'matrix', 'rotation', 'scale', 'position' not allowed with 'positionsCompressed'");
                    return false;
                }

                const useDTX = (!!this._dtxEnabled && (cfg.primitive === "triangles"
                        || cfg.primitive === "solid"
                        || cfg.primitive === "surface"))
                    && (!cfg.textureSetId);

                cfg.origin = cfg.origin ? math.addVec3(this._origin, cfg.origin, math.vec3()) : this._origin;

                // MATRIX - optional for batching

                if (cfg.matrix) {
                    cfg.meshMatrix = cfg.matrix;
                } else if (cfg.scale || cfg.rotation || cfg.position) {
                    const scale = cfg.scale || DEFAULT_SCALE;
                    const position = cfg.position || DEFAULT_POSITION;
                    const rotation = cfg.rotation || DEFAULT_ROTATION;
                    math.eulerToQuaternion(rotation, "XYZ", DEFAULT_QUATERNION);
                    cfg.meshMatrix = math.composeMat4(position, DEFAULT_QUATERNION, scale, math.mat4());
                }

                if (cfg.positionsDecodeBoundary) {
                    cfg.positionsDecodeMatrix = createPositionsDecodeMatrix$1(cfg.positionsDecodeBoundary, math.mat4());
                }

                if (useDTX) {

                    // DTX

                    cfg.type = DTX;

                    // NPR

                    cfg.color = (cfg.color) ? new Uint8Array([Math.floor(cfg.color[0] * 255), Math.floor(cfg.color[1] * 255), Math.floor(cfg.color[2] * 255)]) : defaultCompressedColor;
                    cfg.opacity = (cfg.opacity !== undefined && cfg.opacity !== null) ? Math.floor(cfg.opacity * 255) : 255;

                    // RTC

                    if (cfg.positions) {
                        const rtcCenter = math.vec3();
                        const rtcPositions = [];
                        const rtcNeeded = worldToRTCPositions(cfg.positions, rtcPositions, rtcCenter);
                        if (rtcNeeded) {
                            cfg.positions = rtcPositions;
                            cfg.origin = math.addVec3(cfg.origin, rtcCenter, rtcCenter);
                        }
                    }

                    // COMPRESSION

                    if (cfg.positions) {
                        const aabb = math.collapseAABB3();
                        cfg.positionsDecodeMatrix = math.mat4();
                        math.expandAABB3Points3(aabb, cfg.positions);
                        cfg.positionsCompressed = quantizePositions(cfg.positions, aabb, cfg.positionsDecodeMatrix);
                        cfg.aabb = aabb;

                    } else if (cfg.positionsCompressed) {
                        const aabb = math.collapseAABB3();
                        math.expandAABB3Points3(aabb, cfg.positionsCompressed);
                        geometryCompressionUtils.decompressAABB(aabb, cfg.positionsDecodeMatrix);
                        cfg.aabb = aabb;

                    }
                    if (cfg.buckets) {
                        const aabb = math.collapseAABB3();
                        for (let i = 0, len = cfg.buckets.length; i < len; i++) {
                            const bucket = cfg.buckets[i];
                            if (bucket.positions) {
                                math.expandAABB3Points3(aabb, bucket.positions);
                            } else if (bucket.positionsCompressed) {
                                math.expandAABB3Points3(aabb, bucket.positionsCompressed);
                            }
                        }
                        if (cfg.positionsDecodeMatrix) {
                            geometryCompressionUtils.decompressAABB(aabb, cfg.positionsDecodeMatrix);
                        }
                        cfg.aabb = aabb;
                    }

                    if (cfg.meshMatrix) {
                        math.AABB3ToOBB3(cfg.aabb, tempOBB3);
                        math.transformOBB3(cfg.meshMatrix, tempOBB3);
                        math.OBB3ToAABB3(tempOBB3, cfg.aabb);
                    }

                    // EDGES

                    if (!cfg.buckets && !cfg.edgeIndices && (cfg.primitive === "triangles" || cfg.primitive === "solid" || cfg.primitive === "surface")) {
                        if (cfg.positions) { // Faster
                            cfg.edgeIndices = buildEdgeIndices(cfg.positions, cfg.indices, null, 2.0);
                        } else {
                            cfg.edgeIndices = buildEdgeIndices(cfg.positionsCompressed, cfg.indices, cfg.positionsDecodeMatrix, 2.0);
                        }
                    }

                    // BUCKETING

                    if (!cfg.buckets) {
                        cfg.buckets = createDTXBuckets(cfg, this._enableVertexWelding && this._enableIndexBucketing);
                    }

                } else {

                    // VBO

                    cfg.type = VBO_BATCHED;

                    // PBR

                    cfg.color = (cfg.color) ? new Uint8Array([Math.floor(cfg.color[0] * 255), Math.floor(cfg.color[1] * 255), Math.floor(cfg.color[2] * 255)]) : [255, 255, 255];
                    cfg.opacity = (cfg.opacity !== undefined && cfg.opacity !== null) ? Math.floor(cfg.opacity * 255) : 255;
                    cfg.metallic = (cfg.metallic !== undefined && cfg.metallic !== null) ? Math.floor(cfg.metallic * 255) : 0;
                    cfg.roughness = (cfg.roughness !== undefined && cfg.roughness !== null) ? Math.floor(cfg.roughness * 255) : 255;

                    // RTC

                    if (cfg.positions) {
                        const rtcPositions = [];
                        const rtcNeeded = worldToRTCPositions(cfg.positions, rtcPositions, tempVec3a);
                        if (rtcNeeded) {
                            cfg.positions = rtcPositions;
                            cfg.origin = math.addVec3(cfg.origin, tempVec3a, math.vec3());
                        }
                    }

                    if (cfg.positions) {
                        const aabb = math.collapseAABB3();
                        if (cfg.meshMatrix) {
                            math.transformPositions3(cfg.meshMatrix, cfg.positions, cfg.positions);
                            cfg.meshMatrix = null; // Positions now baked, don't need any more
                        }
                        math.expandAABB3Points3(aabb, cfg.positions);
                        cfg.aabb = aabb;

                    } else {
                        const aabb = math.collapseAABB3();
                        math.expandAABB3Points3(aabb, cfg.positionsCompressed);
                        geometryCompressionUtils.decompressAABB(aabb, cfg.positionsDecodeMatrix);
                        cfg.aabb = aabb;
                        // @reviser lijuhong 解压positionsCompressed以获得positions
                        cfg.positions = geometryCompressionUtils.decompressPositions(cfg.positionsCompressed, cfg.positionsDecodeMatrix, new Float64Array(cfg.positionsCompressed.length));
                    }

                    // @reviser lijuhong 解压normalsCompressed以获得normals
                    if (!cfg.normals && cfg.normalsCompressed && cfg.normalsCompressed.length > 0) {
                        const lenCompressed = cfg.normalsCompressed.length;
                        const lenDecompressed = lenCompressed + (lenCompressed / 2); // 2 -> 3
                        const normals = new Float32Array(lenDecompressed);
                        cfg.normals = geometryCompressionUtils.decompressNormals(cfg.normalsCompressed, normals);
                    }
                    // @reviser lijuhong 解压uvCompressed以获得uv
                    if (!cfg.uv && cfg.uvCompressed && cfg.uvCompressed.length > 0) {
                        cfg.uv = geometryCompressionUtils.decompressUVs(cfg.uvCompressed, cfg.uvDecodeMatrix);
                    }

                    if (cfg.meshMatrix) {
                        math.AABB3ToOBB3(cfg.aabb, tempOBB3);
                        math.transformOBB3(cfg.meshMatrix, tempOBB3);
                        math.OBB3ToAABB3(tempOBB3, cfg.aabb);
                    }

                    // EDGES

                    if (!cfg.buckets && !cfg.edgeIndices && (cfg.primitive === "triangles" || cfg.primitive === "solid" || cfg.primitive === "surface")) {
                        if (cfg.positions) {
                            cfg.edgeIndices = buildEdgeIndices(cfg.positions, cfg.indices, null, 2.0);
                        } else {
                            cfg.edgeIndices = buildEdgeIndices(cfg.positionsCompressed, cfg.indices, cfg.positionsDecodeMatrix, 2.0);
                        }
                    }

                    // TEXTURE

                    // cfg.textureSetId = cfg.textureSetId || DEFAULT_TEXTURE_SET_ID;
                    if (cfg.textureSetId) {
                        cfg.textureSet = this._textureSets[cfg.textureSetId];
                        if (!cfg.textureSet) {
                            this.error(`[createMesh] Texture set not found: ${cfg.textureSetId} - ensure that you create it first with createTextureSet()`);
                            return false;
                        }
                    }
                }

            } else {

                // INSTANCING

                if (cfg.positions || cfg.positionsCompressed || cfg.indices || cfg.edgeIndices || cfg.normals || cfg.normalsCompressed || cfg.uv || cfg.uvCompressed || cfg.positionsDecodeMatrix) {
                    this.error(`Mesh geometry parameters not expected when instancing a geometry (not expected: positions, positionsCompressed, indices, edgeIndices, normals, normalsCompressed, uv, uvCompressed, positionsDecodeMatrix)`);
                    return false;
                }

                cfg.geometry = this._geometries[cfg.geometryId];
                if (!cfg.geometry) {
                    this.error(`[createMesh] Geometry not found: ${cfg.geometryId} - ensure that you create it first with createGeometry()`);
                    return false;
                }

                cfg.origin = cfg.origin ? math.addVec3(this._origin, cfg.origin, math.vec3()) : this._origin;
                cfg.positionsDecodeMatrix = cfg.geometry.positionsDecodeMatrix;

                if (cfg.transformId) {

                    // TRANSFORM

                    cfg.transform = this._transforms[cfg.transformId];

                    if (!cfg.transform) {
                        this.error(`[createMesh] Transform not found: ${cfg.transformId} - ensure that you create it first with createTransform()`);
                        return false;
                    }

                    cfg.aabb = cfg.geometry.aabb;

                } else {

                    // MATRIX

                    if (cfg.matrix) {
                        cfg.meshMatrix = cfg.matrix.slice();
                    } else {
                        const scale = cfg.scale || DEFAULT_SCALE;
                        const position = cfg.position || DEFAULT_POSITION;
                        const rotation = cfg.rotation || DEFAULT_ROTATION;
                        math.eulerToQuaternion(rotation, "XYZ", DEFAULT_QUATERNION);
                        cfg.meshMatrix = math.composeMat4(position, DEFAULT_QUATERNION, scale, math.mat4());
                    }

                    math.AABB3ToOBB3(cfg.geometry.aabb, tempOBB3);
                    math.transformOBB3(cfg.meshMatrix, tempOBB3);
                    cfg.aabb = math.OBB3ToAABB3(tempOBB3, math.AABB3());
                }

                const useDTX = (!!this._dtxEnabled
                        && (cfg.geometry.primitive === "triangles"
                            || cfg.geometry.primitive === "solid"
                            || cfg.geometry.primitive === "surface"))
                    && (!cfg.textureSetId);

                if (useDTX) {

                    // DTX

                    cfg.type = DTX;

                    // NPR

                    cfg.color = (cfg.color) ? new Uint8Array([Math.floor(cfg.color[0] * 255), Math.floor(cfg.color[1] * 255), Math.floor(cfg.color[2] * 255)]) : defaultCompressedColor;
                    cfg.opacity = (cfg.opacity !== undefined && cfg.opacity !== null) ? Math.floor(cfg.opacity * 255) : 255;

                    // BUCKETING - lazy generated, reused

                    let buckets = this._dtxBuckets[cfg.geometryId];
                    if (!buckets) {
                        buckets = createDTXBuckets(cfg.geometry, this._enableVertexWelding, this._enableIndexBucketing);
                        this._dtxBuckets[cfg.geometryId] = buckets;
                    }
                    cfg.buckets = buckets;

                } else {

                    // VBO

                    cfg.type = VBO_INSTANCED;

                    // PBR

                    cfg.color = (cfg.color) ? new Uint8Array([Math.floor(cfg.color[0] * 255), Math.floor(cfg.color[1] * 255), Math.floor(cfg.color[2] * 255)]) : defaultCompressedColor;
                    cfg.opacity = (cfg.opacity !== undefined && cfg.opacity !== null) ? Math.floor(cfg.opacity * 255) : 255;
                    cfg.metallic = (cfg.metallic !== undefined && cfg.metallic !== null) ? Math.floor(cfg.metallic * 255) : 0;
                    cfg.roughness = (cfg.roughness !== undefined && cfg.roughness !== null) ? Math.floor(cfg.roughness * 255) : 255;

                    // TEXTURE

                    if (cfg.textureSetId) {
                        cfg.textureSet = this._textureSets[cfg.textureSetId];
                        // if (!cfg.textureSet) {
                        //     this.error(`[createMesh] Texture set not found: ${cfg.textureSetId} - ensure that you create it first with createTextureSet()`);
                        //     return false;
                        // }
                    }
                }
            }

            cfg.numPrimitives = this._getNumPrimitives(cfg);

            return this._createMesh(cfg);
        }

        _createMesh(cfg) {
            const mesh = new SceneModelMesh(this, cfg.id, cfg.color, cfg.opacity, cfg.transform, cfg.textureSet);
            // @reviser lijuhong 注释pickId与pickColor代码
            // mesh.pickId = this.scene._renderer.getPickID(mesh);
            // const pickId = mesh.pickId;
            // const a = pickId >> 24 & 0xFF;
            // const b = pickId >> 16 & 0xFF;
            // const g = pickId >> 8 & 0xFF;
            // const r = pickId & 0xFF;
            // cfg.pickColor = new Uint8Array([r, g, b, a]); // Quantized pick color
            cfg.solid = (cfg.primitive === "solid");
            mesh.origin = math.vec3(cfg.origin);
            // @reviser lijuhong 注释创建layer代码
            // switch (cfg.type) {
            //     case DTX:
            //         mesh.layer = this._getDTXLayer(cfg);
            //         mesh.aabb = cfg.aabb;
            //         break;
            //     case VBO_BATCHED:
            //         mesh.layer = this._getVBOBatchingLayer(cfg);
            //         mesh.aabb = cfg.aabb;
            //         break;
            //     case VBO_INSTANCED:
            //         mesh.layer = this._getVBOInstancingLayer(cfg);
            //         mesh.aabb = cfg.aabb;
            //         break;
            // }
            if (cfg.transform) {
                cfg.meshMatrix = cfg.transform.worldMatrix;
            }
            // @reviser lijuhong 注释createPortion代码
            // mesh.portionId = mesh.layer.createPortion(mesh, cfg);
            // @reviser lijuhong 保存传入的cfg
            mesh.cfg = cfg;
            this._meshes[cfg.id] = mesh;
            this._unusedMeshes[cfg.id] = mesh;
            this._meshList.push(mesh);
            return mesh;
        }

        _getNumPrimitives(cfg) {
            let countIndices = 0;
            const primitive = cfg.geometry ? cfg.geometry.primitive : cfg.primitive;
            switch (primitive) {
                case "triangles":
                case "solid":
                case "surface":
                    switch (cfg.type) {
                        case DTX:
                            for (let i = 0, len = cfg.buckets.length; i < len; i++) {
                                countIndices += cfg.buckets[i].indices.length;
                            }
                            break;
                        case VBO_BATCHED:
                            countIndices += cfg.indices.length;
                            break;
                        case VBO_INSTANCED:
                            countIndices += cfg.geometry.indices.length;
                            break;
                    }
                    return Math.round(countIndices / 3);
                case "points":
                    switch (cfg.type) {
                        case DTX:
                            for (let i = 0, len = cfg.buckets.length; i < len; i++) {
                                countIndices += cfg.buckets[i].positionsCompressed.length;
                            }
                            break;
                        case VBO_BATCHED:
                            countIndices += cfg.positions ? cfg.positions.length : cfg.positionsCompressed.length;
                            break;
                        case VBO_INSTANCED:
                            const geometry = cfg.geometry;
                            countIndices += geometry.positions ? geometry.positions.length : geometry.positionsCompressed.length;
                            break;
                    }
                    return Math.round(countIndices);
                case "lines":
                case "line-strip":
                    switch (cfg.type) {
                        case DTX:
                            for (let i = 0, len = cfg.buckets.length; i < len; i++) {
                                countIndices += cfg.buckets[i].indices.length;
                            }
                            break;
                        case VBO_BATCHED:
                            countIndices += cfg.indices.length;
                            break;
                        case VBO_INSTANCED:
                            countIndices += cfg.geometry.indices.length;
                            break;
                    }
                    return Math.round(countIndices / 2);
            }
            return 0;
        }

        // @reviser lijuhong 注释Layer相关代码
        /* _getDTXLayer(cfg) {
            const origin = cfg.origin;
            const primitive = cfg.geometry ? cfg.geometry.primitive : cfg.primitive;
            const layerId = `.${primitive}.${Math.round(origin[0])}.${Math.round(origin[1])}.${Math.round(origin[2])}`;
            let dtxLayer = this._dtxLayers[layerId];
            if (dtxLayer) {
                if (!dtxLayer.canCreatePortion(cfg)) {
                    dtxLayer.finalize();
                    delete this._dtxLayers[layerId];
                    dtxLayer = null;
                } else {
                    return dtxLayer;
                }
            }
            switch (primitive) {
                case "triangles":
                case "solid":
                case "surface":
                    dtxLayer = new DTXTrianglesLayer(this, {layerIndex: 0, origin}); // layerIndex is set in #finalize()
                    break;
                case "lines":
                    dtxLayer = new DTXLinesLayer(this, {layerIndex: 0, origin}); // layerIndex is set in #finalize()
                    break;
                default:
                    return;
            }
            this._dtxLayers[layerId] = dtxLayer;
            this.layerList.push(dtxLayer);
            return dtxLayer;
        }

        _getVBOBatchingLayer(cfg) {
            const model = this;
            const origin = cfg.origin;
            const positionsDecodeHash = cfg.positionsDecodeMatrix || cfg.positionsDecodeBoundary ?
                this._createHashStringFromMatrix(cfg.positionsDecodeMatrix || cfg.positionsDecodeBoundary)
                : "-";
            const textureSetId = cfg.textureSetId || "-";
            const layerId = `${Math.round(origin[0])}.${Math.round(origin[1])}.${Math.round(origin[2])}.${cfg.primitive}.${positionsDecodeHash}.${textureSetId}`;
            let vboBatchingLayer = this._vboBatchingLayers[layerId];
            if (vboBatchingLayer) {
                return vboBatchingLayer;
            }
            let textureSet = cfg.textureSet;
            while (!vboBatchingLayer) {
                switch (cfg.primitive) {
                    case "triangles":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesBatchingLayer`);
                        vboBatchingLayer = new VBOBatchingTrianglesLayer({
                            model,
                            textureSet,
                            layerIndex: 0, // This is set in #finalize()
                            scratchMemory: this._vboBatchingLayerScratchMemory,
                            positionsDecodeMatrix: cfg.positionsDecodeMatrix,  // Can be undefined
                            uvDecodeMatrix: cfg.uvDecodeMatrix, // Can be undefined
                            origin,
                            maxGeometryBatchSize: this._maxGeometryBatchSize,
                            solid: (cfg.primitive === "solid"),
                            autoNormals: true
                        });
                        break;
                    case "solid":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesBatchingLayer`);
                        vboBatchingLayer = new VBOBatchingTrianglesLayer({
                            model,
                            textureSet,
                            layerIndex: 0, // This is set in #finalize()
                            scratchMemory: this._vboBatchingLayerScratchMemory,
                            positionsDecodeMatrix: cfg.positionsDecodeMatrix,  // Can be undefined
                            uvDecodeMatrix: cfg.uvDecodeMatrix, // Can be undefined
                            origin,
                            maxGeometryBatchSize: this._maxGeometryBatchSize,
                            solid: (cfg.primitive === "solid"),
                            autoNormals: true
                        });
                        break;
                    case "surface":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesBatchingLayer`);
                        vboBatchingLayer = new VBOBatchingTrianglesLayer({
                            model,
                            textureSet,
                            layerIndex: 0, // This is set in #finalize()
                            scratchMemory: this._vboBatchingLayerScratchMemory,
                            positionsDecodeMatrix: cfg.positionsDecodeMatrix,  // Can be undefined
                            uvDecodeMatrix: cfg.uvDecodeMatrix, // Can be undefined
                            origin,
                            maxGeometryBatchSize: this._maxGeometryBatchSize,
                            solid: (cfg.primitive === "solid"),
                            autoNormals: true
                        });
                        break;
                    case "lines":
                        // console.info(`[SceneModel ${this.id}]: creating VBOBatchingLinesLayer`);
                        vboBatchingLayer = new VBOBatchingLinesLayer({
                            model,
                            layerIndex: 0, // This is set in #finalize()
                            scratchMemory: this._vboBatchingLayerScratchMemory,
                            positionsDecodeMatrix: cfg.positionsDecodeMatrix,  // Can be undefined
                            uvDecodeMatrix: cfg.uvDecodeMatrix, // Can be undefined
                            origin,
                            maxGeometryBatchSize: this._maxGeometryBatchSize
                        });
                        break;
                    case "points":
                        // console.info(`[SceneModel ${this.id}]: creating VBOBatchingPointsLayer`);
                        vboBatchingLayer = new VBOBatchingPointsLayer({
                            model,
                            layerIndex: 0, // This is set in #finalize()
                            scratchMemory: this._vboBatchingLayerScratchMemory,
                            positionsDecodeMatrix: cfg.positionsDecodeMatrix,  // Can be undefined
                            uvDecodeMatrix: cfg.uvDecodeMatrix, // Can be undefined
                            origin,
                            maxGeometryBatchSize: this._maxGeometryBatchSize
                        });
                        break;
                }
                const lenPositions = cfg.positionsCompressed ? cfg.positionsCompressed.length : cfg.positions.length;
                const canCreatePortion = (cfg.primitive === "points")
                    ? vboBatchingLayer.canCreatePortion(lenPositions)
                    : vboBatchingLayer.canCreatePortion(lenPositions, cfg.indices.length);
                if (!canCreatePortion) {
                    vboBatchingLayer.finalize();
                    delete this._vboBatchingLayers[layerId];
                    vboBatchingLayer = null;
                }
            }
            this._vboBatchingLayers[layerId] = vboBatchingLayer;
            this.layerList.push(vboBatchingLayer);
            return vboBatchingLayer;
        } */

        _createHashStringFromMatrix(matrix) {
            const matrixString = matrix.join('');
            let hash = 0;
            for (let i = 0; i < matrixString.length; i++) {
                const char = matrixString.charCodeAt(i);
                hash = (hash << 5) - hash + char;
                hash |= 0; // Convert to 32-bit integer
            }
            const hashString = (hash >>> 0).toString(16);
            return hashString;
        }

        // @reviser lijuhong 注释Layer相关代码
        /* _getVBOInstancingLayer(cfg) {
            const model = this;
            const origin = cfg.origin;
            const textureSetId = cfg.textureSetId || "-";
            const geometryId = cfg.geometryId;
            const layerId = `${Math.round(origin[0])}.${Math.round(origin[1])}.${Math.round(origin[2])}.${textureSetId}.${geometryId}`;
            let vboInstancingLayer = this._vboInstancingLayers[layerId];
            if (vboInstancingLayer) {
                return vboInstancingLayer;
            }
            let textureSet = cfg.textureSet;
            const geometry = cfg.geometry;
            while (!vboInstancingLayer) {
                switch (geometry.primitive) {
                    case "triangles":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesInstancingLayer`);
                        vboInstancingLayer = new VBOInstancingTrianglesLayer({
                            model,
                            textureSet,
                            geometry,
                            origin,
                            layerIndex: 0,
                            solid: false
                        });
                        break;
                    case "solid":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesInstancingLayer`);
                        vboInstancingLayer = new VBOInstancingTrianglesLayer({
                            model,
                            textureSet,
                            geometry,
                            origin,
                            layerIndex: 0,
                            solid: true
                        });
                        break;
                    case "surface":
                        // console.info(`[SceneModel ${this.id}]: creating TrianglesInstancingLayer`);
                        vboInstancingLayer = new VBOInstancingTrianglesLayer({
                            model,
                            textureSet,
                            geometry,
                            origin,
                            layerIndex: 0,
                            solid: false
                        });
                        break;
                    case "lines":
                        // console.info(`[SceneModel ${this.id}]: creating VBOInstancingLinesLayer`);
                        vboInstancingLayer = new VBOInstancingLinesLayer({
                            model,
                            textureSet,
                            geometry,
                            origin,
                            layerIndex: 0
                        });
                        break;
                    case "points":
                        // console.info(`[SceneModel ${this.id}]: creating PointsInstancingLayer`);
                        vboInstancingLayer = new VBOInstancingPointsLayer({
                            model,
                            textureSet,
                            geometry,
                            origin,
                            layerIndex: 0
                        });
                        break;
                }
                // const lenPositions = geometry.positionsCompressed.length;
                // if (!vboInstancingLayer.canCreatePortion(lenPositions, geometry.indices.length)) { // FIXME: indices should be optional
                //     vboInstancingLayer.finalize();
                //     delete this._vboInstancingLayers[layerId];
                //     vboInstancingLayer = null;
                // }
            }
            this._vboInstancingLayers[layerId] = vboInstancingLayer;
            this.layerList.push(vboInstancingLayer);
            return vboInstancingLayer;
        } */

        /**
         * Creates a {@link SceneModelEntity} within this SceneModel.
         *
         * * Gives the SceneModelEntity one or more {@link SceneModelMesh}es previously created with
         * {@link SceneModel#createMesh}. A SceneModelMesh can only belong to one SceneModelEntity, so you'll get an
         * error if you try to reuse a mesh among multiple SceneModelEntitys.
         * * The SceneModelEntity can have a {@link SceneModelTextureSet}, previously created with
         * {@link SceneModel#createTextureSet}. A SceneModelTextureSet can belong to multiple SceneModelEntitys.
         * * The SceneModelEntity can have a geometry, previously created with
         * {@link SceneModel#createTextureSet}. A geometry is a "virtual component" and can belong to multiple SceneModelEntitys.
         *
         * @param {Object} cfg SceneModelEntity configuration.
         * @param {String} cfg.id Optional ID for the new SceneModelEntity. Must not clash with any existing components within the {@link Scene}.
         * @param {String[]} cfg.meshIds IDs of one or more meshes created previously with {@link SceneModel@createMesh}.
         * @param {Boolean} [cfg.isObject] Set ````true```` if the {@link SceneModelEntity} represents an object, in which case it will be registered by {@link SceneModelEntity#id} in {@link Scene#objects} and can also have a corresponding {@link MetaObject} with matching {@link MetaObject#id}, registered by that ID in {@link MetaScene#metaObjects}.
         * @param {Boolean} [cfg.visible=true] Indicates if the SceneModelEntity is initially visible.
         * @param {Boolean} [cfg.culled=false] Indicates if the SceneModelEntity is initially culled from view.
         * @param {Boolean} [cfg.pickable=true] Indicates if the SceneModelEntity is initially pickable.
         * @param {Boolean} [cfg.clippable=true] Indicates if the SceneModelEntity is initially clippable.
         * @param {Boolean} [cfg.collidable=true] Indicates if the SceneModelEntity is initially included in boundary calculations.
         * @param {Boolean} [cfg.castsShadow=true] Indicates if the SceneModelEntity initially casts shadows.
         * @param {Boolean} [cfg.receivesShadow=true]  Indicates if the SceneModelEntity initially receives shadows.
         * @param {Boolean} [cfg.xrayed=false] Indicates if the SceneModelEntity is initially xrayed. XRayed appearance is configured by {@link SceneModel#xrayMaterial}.
         * @param {Boolean} [cfg.highlighted=false] Indicates if the SceneModelEntity is initially highlighted. Highlighted appearance is configured by {@link SceneModel#highlightMaterial}.
         * @param {Boolean} [cfg.selected=false] Indicates if the SceneModelEntity is initially selected. Selected appearance is configured by {@link SceneModel#selectedMaterial}.
         * @param {Boolean} [cfg.edges=false] Indicates if the SceneModelEntity's edges are initially emphasized. Edges appearance is configured by {@link SceneModel#edgeMaterial}.
         * @returns {SceneModelEntity} The new SceneModelEntity.
         */
        createEntity(cfg) {
            if (cfg.id === undefined) {
                cfg.id = math.createUUID();
            }
            // @reviser lijuhong 注释scene相关代码 
            // else if (this.scene.components[cfg.id]) {
            //     this.error(`Scene already has a Component with this ID: ${cfg.id} - will assign random ID`);
            //     cfg.id = math.createUUID();
            // }
            if (cfg.meshIds === undefined) {
                this.error("Config missing: meshIds");
                return;
            }
            let flags = 0;
            if (this._visible && cfg.visible !== false) {
                flags = flags | ENTITY_FLAGS.VISIBLE;
            }
            if (this._pickable && cfg.pickable !== false) {
                flags = flags | ENTITY_FLAGS.PICKABLE;
            }
            if (this._culled && cfg.culled !== false) {
                flags = flags | ENTITY_FLAGS.CULLED;
            }
            if (this._clippable && cfg.clippable !== false) {
                flags = flags | ENTITY_FLAGS.CLIPPABLE;
            }
            if (this._collidable && cfg.collidable !== false) {
                flags = flags | ENTITY_FLAGS.COLLIDABLE;
            }
            if (this._edges && cfg.edges !== false) {
                flags = flags | ENTITY_FLAGS.EDGES;
            }
            if (this._xrayed && cfg.xrayed !== false) {
                flags = flags | ENTITY_FLAGS.XRAYED;
            }
            if (this._highlighted && cfg.highlighted !== false) {
                flags = flags | ENTITY_FLAGS.HIGHLIGHTED;
            }
            if (this._selected && cfg.selected !== false) {
                flags = flags | ENTITY_FLAGS.SELECTED;
            }
            cfg.flags = flags;
            this._createEntity(cfg);
        }

        _createEntity(cfg) {
            let meshes = [];
            for (let i = 0, len = cfg.meshIds.length; i < len; i++) {
                const meshId = cfg.meshIds[i];
                let mesh = this._meshes[meshId]; // Trying to get already created mesh
                if (!mesh) { // Checks if there is already created mesh for this meshId
                    this.error(`Mesh with this ID not found: "${meshId}" - ignoring this mesh`); // There is no such cfg
                    continue;
                }
                if (mesh.parent) {
                    this.error(`Mesh with ID "${meshId}" already belongs to object with ID "${mesh.parent.id}" - ignoring this mesh`);
                    continue;
                }
                meshes.push(mesh);
                delete this._unusedMeshes[meshId];
            }
            const lodCullable = true;
            const entity = new SceneModelEntity(
                this,
                cfg.isObject,
                cfg.id,
                meshes,
                cfg.flags,
                lodCullable); // Internally sets SceneModelEntity#parent to this SceneModel
            this._entityList.push(entity);
            this._entities[cfg.id] = entity;
            this.numEntities++;
        }

        /**
         * Finalizes this SceneModel.
         *
         * Once finalized, you can't add anything more to this SceneModel.
         */
        finalize() {
            if (this.destroyed) {
                return;
            }
            this._createDummyEntityForUnusedMeshes();
            for (let i = 0, len = this.layerList.length; i < len; i++) {
                const layer = this.layerList[i];
                layer.finalize();
            }
            // @reivser lijuhong 注释掉释放_geometries代码
            // this._geometries = {};
            this._dtxBuckets = {};
            // @reivser lijuhong 注释掉释放_textures、_textureSets代码
            // this._textures = {};
            // this._textureSets = {};
            this._dtxLayers = {};
            this._vboInstancingLayers = {};
            this._vboBatchingLayers = {};
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                const entity = this._entityList[i];
                entity._finalize();
            }
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                const entity = this._entityList[i];
                entity._finalize2();
            }
            // Sort layers to reduce WebGL shader switching when rendering them
            this.layerList.sort((a, b) => {
                if (a.sortId < b.sortId) {
                    return -1;
                }
                if (a.sortId > b.sortId) {
                    return 1;
                }
                return 0;
            });
            for (let i = 0, len = this.layerList.length; i < len; i++) {
                const layer = this.layerList[i];
                layer.layerIndex = i;
            }
            this.glRedraw();
            // @reviser lijuhong 注释scene相关代码
            // this.scene._aabbDirty = true;
            this._viewMatrixDirty = true;
            this._matrixDirty = true;
            this._aabbDirty = true;

            this._setWorldMatrixDirty();
            this._sceneModelDirty();

            this.position = this._position;
        }

        /** @private */
        stateSortCompare(drawable1, drawable2) {
        }

        /** @private */
        rebuildRenderFlags() {
            this.renderFlags.reset();
            this._updateRenderFlagsVisibleLayers();
            if (this.renderFlags.numLayers > 0 && this.renderFlags.numVisibleLayers === 0) {
                this.renderFlags.culled = true;
                return;
            }
            this._updateRenderFlags();
        }

        /**
         * @private
         */
        _updateRenderFlagsVisibleLayers() {
            const renderFlags = this.renderFlags;
            renderFlags.numLayers = this.layerList.length;
            renderFlags.numVisibleLayers = 0;
            for (let layerIndex = 0, len = this.layerList.length; layerIndex < len; layerIndex++) {
                const layer = this.layerList[layerIndex];
                const layerVisible = this._getActiveSectionPlanesForLayer(layer);
                if (layerVisible) {
                    renderFlags.visibleLayers[renderFlags.numVisibleLayers++] = layerIndex;
                }
            }
        }

        /** @private */
        _createDummyEntityForUnusedMeshes() {
            const unusedMeshIds = Object.keys(this._unusedMeshes);
            if (unusedMeshIds.length > 0) {
                const entityId = `${this.id}-dummyEntityForUnusedMeshes`;
                this.warn(`Creating dummy SceneModelEntity "${entityId}" for unused SceneMeshes: [${unusedMeshIds.join(",")}]`);
                this.createEntity({
                    id: entityId,
                    meshIds: unusedMeshIds,
                    isObject: true
                });
            }
            this._unusedMeshes = {};
        }

        _getActiveSectionPlanesForLayer(layer) {
            // @reviser lijuhong 注释scene相关代码
            // const renderFlags = this.renderFlags;
            // const sectionPlanes = this.scene._sectionPlanesState.sectionPlanes;
            // const numSectionPlanes = sectionPlanes.length;
            // const baseIndex = layer.layerIndex * numSectionPlanes;
            // if (numSectionPlanes > 0) {
            //     for (let i = 0; i < numSectionPlanes; i++) {
            //         const sectionPlane = sectionPlanes[i];
            //         if (!sectionPlane.active) {
            //             renderFlags.sectionPlanesActivePerLayer[baseIndex + i] = false;
            //         } else {
            //             renderFlags.sectionPlanesActivePerLayer[baseIndex + i] = true;
            //             renderFlags.sectioned = true;
            //         }
            //     }
            // }
            return true;
        }

        _updateRenderFlags() {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            if (this.numCulledLayerPortions === this.numPortions) {
                return;
            }
            const renderFlags = this.renderFlags;
            renderFlags.colorOpaque = (this.numTransparentLayerPortions < this.numPortions);
            if (this.numTransparentLayerPortions > 0) {
                renderFlags.colorTransparent = true;
            }
            // @reviser lijuhong 注释scene相关代码
            /* if (this.numXRayedLayerPortions > 0) {
                const xrayMaterial = this.scene.xrayMaterial._state;
                if (xrayMaterial.fill) {
                    if (xrayMaterial.fillAlpha < 1.0) {
                        renderFlags.xrayedSilhouetteTransparent = true;
                    } else {
                        renderFlags.xrayedSilhouetteOpaque = true;
                    }
                }
                if (xrayMaterial.edges) {
                    if (xrayMaterial.edgeAlpha < 1.0) {
                        renderFlags.xrayedEdgesTransparent = true;
                    } else {
                        renderFlags.xrayedEdgesOpaque = true;
                    }
                }
            }
            if (this.numEdgesLayerPortions > 0) {
                const edgeMaterial = this.scene.edgeMaterial._state;
                if (edgeMaterial.edges) {
                    renderFlags.edgesOpaque = (this.numTransparentLayerPortions < this.numPortions);
                    if (this.numTransparentLayerPortions > 0) {
                        renderFlags.edgesTransparent = true;
                    }
                }
            }
            if (this.numSelectedLayerPortions > 0) {
                const selectedMaterial = this.scene.selectedMaterial._state;
                if (selectedMaterial.fill) {
                    if (selectedMaterial.fillAlpha < 1.0) {
                        renderFlags.selectedSilhouetteTransparent = true;
                    } else {
                        renderFlags.selectedSilhouetteOpaque = true;
                    }
                }
                if (selectedMaterial.edges) {
                    if (selectedMaterial.edgeAlpha < 1.0) {
                        renderFlags.selectedEdgesTransparent = true;
                    } else {
                        renderFlags.selectedEdgesOpaque = true;
                    }
                }
            }
            if (this.numHighlightedLayerPortions > 0) {
                const highlightMaterial = this.scene.highlightMaterial._state;
                if (highlightMaterial.fill) {
                    if (highlightMaterial.fillAlpha < 1.0) {
                        renderFlags.highlightedSilhouetteTransparent = true;
                    } else {
                        renderFlags.highlightedSilhouetteOpaque = true;
                    }
                }
                if (highlightMaterial.edges) {
                    if (highlightMaterial.edgeAlpha < 1.0) {
                        renderFlags.highlightedEdgesTransparent = true;
                    } else {
                        renderFlags.highlightedEdgesOpaque = true;
                    }
                }
            } */
        }

        // -------------- RENDERING ---------------------------------------------------------------------------------------

        /** @private */
        drawColorOpaque(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawColorOpaque(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawColorTransparent(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawColorTransparent(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawDepth(frameCtx) { // Dedicated to SAO because it skips transparent objects
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawDepth(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawNormals(frameCtx) { // Dedicated to SAO because it skips transparent objects
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawNormals(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawSilhouetteXRayed(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawSilhouetteXRayed(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawSilhouetteHighlighted(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawSilhouetteHighlighted(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawSilhouetteSelected(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawSilhouetteSelected(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawEdgesColorOpaque(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawEdgesColorOpaque(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawEdgesColorTransparent(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawEdgesColorTransparent(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawEdgesXRayed(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawEdgesXRayed(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawEdgesHighlighted(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawEdgesHighlighted(renderFlags, frameCtx);
            }
        }

        /** @private */
        drawEdgesSelected(frameCtx) {
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawEdgesSelected(renderFlags, frameCtx);
            }
        }

        /**
         * @private
         */
        drawOcclusion(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawOcclusion(renderFlags, frameCtx);
            }
        }

        /**
         * @private
         */
        drawShadow(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawShadow(renderFlags, frameCtx);
            }
        }

        /** @private */
        setPickMatrices(pickViewMatrix, pickProjMatrix) {
            if (this._numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                const layer = this.layerList[layerIndex];
                if (layer.setPickMatrices) {
                    layer.setPickMatrices(pickViewMatrix, pickProjMatrix);
                }
            }
        }

        /** @private */
        drawPickMesh(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawPickMesh(renderFlags, frameCtx);
            }
        }

        /**
         * Called by SceneModelMesh.drawPickDepths()
         * @private
         */
        drawPickDepths(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawPickDepths(renderFlags, frameCtx);
            }
        }

        /**
         * Called by SceneModelMesh.drawPickNormals()
         * @private
         */
        drawPickNormals(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                this.layerList[layerIndex].drawPickNormals(renderFlags, frameCtx);
            }
        }

        /**
         * @private
         */
        drawSnapInit(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                const layer = this.layerList[layerIndex];
                if (layer.drawSnapInit) {
                    frameCtx.snapPickOrigin = [0, 0, 0];
                    frameCtx.snapPickCoordinateScale = [1, 1, 1];
                    frameCtx.snapPickLayerNumber++;
                    layer.drawSnapInit(renderFlags, frameCtx);
                    frameCtx.snapPickLayerParams[frameCtx.snapPickLayerNumber] = {
                        origin: frameCtx.snapPickOrigin.slice(),
                        coordinateScale: frameCtx.snapPickCoordinateScale.slice(),
                    };
                }
            }
        }

        /**
         * @private
         */
        drawSnap(frameCtx) {
            if (this.numVisibleLayerPortions === 0) {
                return;
            }
            const renderFlags = this.renderFlags;
            for (let i = 0, len = renderFlags.visibleLayers.length; i < len; i++) {
                const layerIndex = renderFlags.visibleLayers[i];
                const layer = this.layerList[layerIndex];
                if (layer.drawSnap) {
                    frameCtx.snapPickOrigin = [0, 0, 0];
                    frameCtx.snapPickCoordinateScale = [1, 1, 1];
                    frameCtx.snapPickLayerNumber++;
                    layer.drawSnap(renderFlags, frameCtx);
                    frameCtx.snapPickLayerParams[frameCtx.snapPickLayerNumber] = {
                        origin: frameCtx.snapPickOrigin.slice(),
                        coordinateScale: frameCtx.snapPickCoordinateScale.slice(),
                    };
                }
            }
        }

        /**
         * Destroys this SceneModel.
         */
        destroy() {
            for (let layerId in this._vboBatchingLayers) {
                if (this._vboBatchingLayers.hasOwnProperty(layerId)) {
                    this._vboBatchingLayers[layerId].destroy();
                }
            }
            this._vboBatchingLayers = {};
            for (let layerId in this._vboInstancingLayers) {
                if (this._vboInstancingLayers.hasOwnProperty(layerId)) {
                    this._vboInstancingLayers[layerId].destroy();
                }
            }
            this._vboInstancingLayers = {};
            // @reviser lijuhong 注释scene相关代码
            // this.scene.camera.off(this._onCameraViewMatrix);
            // this.scene.off(this._onTick);
            for (let i = 0, len = this.layerList.length; i < len; i++) {
                this.layerList[i].destroy();
            }
            this.layerList = [];
            for (let i = 0, len = this._entityList.length; i < len; i++) {
                this._entityList[i]._destroy();
            }
            // Object.entries(this._geometries).forEach(([id, geometry]) => {
            //     geometry.destroy();
            // });
            this._geometries = {};
            this._dtxBuckets = {};
            this._textures = {};
            this._textureSets = {};
            this._meshes = {};
            this._entities = {};
            // @reviser lijuhong 注释scene相关代码
            // this.scene._aabbDirty = true;
            // if (this._isModel) {
            //     this.scene._deregisterModel(this);
            // }
            putScratchMemory();
            super.destroy();
        }
    }


    /**
     * This function applies two steps to the provided mesh geometry data:
     *
     * - 1st, it reduces its `.positions` to unique positions, thus removing duplicate vertices. It will adjust the `.indices` and `.edgeIndices` array accordingly to the unique `.positions`.
     *
     * - 2nd, it tries to do an optimization called `index rebucketting`
     *
     *   _Rebucketting minimizes the amount of RAM usage for a given mesh geometry by trying do demote its needed index bitness._
     *
     *   - _for 32 bit indices, will try to demote them to 16 bit indices_
     *   - _for 16 bit indices, will try to demote them to 8 bits indices_
     *   - _8 bits indices are kept as-is_
     *
     *   The fact that 32/16/8 bits are needed for indices, depends on the number of maximumm indexable vertices within the mesh geometry: this is, the number of vertices in the mesh geometry.
     *
     * The function returns the same provided input `geometry`, enrichened with the additional key `.preparedBukets`.
     *
     * @param {object} geometry The mesh information containing `.positions`, `.indices`, `.edgeIndices` arrays.
     *
     * @param enableVertexWelding
     * @param enableIndexBucketing
     * @returns {object} The mesh information enrichened with `.buckets` key.
     */
    function createDTXBuckets(geometry, enableVertexWelding, enableIndexBucketing) {
        let uniquePositionsCompressed, uniqueIndices, uniqueEdgeIndices;
        if (enableVertexWelding || enableIndexBucketing) { // Expensive - careful!
            [
                uniquePositionsCompressed,
                uniqueIndices,
                uniqueEdgeIndices,
            ] = uniquifyPositions({
                positionsCompressed: geometry.positionsCompressed,
                indices: geometry.indices,
                edgeIndices: geometry.edgeIndices
            });
        } else {
            uniquePositionsCompressed = geometry.positionsCompressed;
            uniqueIndices = geometry.indices;
            uniqueEdgeIndices = geometry.edgeIndices;
        }
        let buckets;
        if (enableIndexBucketing) {
            let numUniquePositions = uniquePositionsCompressed.length / 3;
            buckets = rebucketPositions({
                    positionsCompressed: uniquePositionsCompressed,
                    indices: uniqueIndices,
                    edgeIndices: uniqueEdgeIndices,
                },
                (numUniquePositions > (1 << 16)) ? 16 : 8,
                // true
            );
        } else {
            buckets = [{
                positionsCompressed: uniquePositionsCompressed,
                indices: uniqueIndices,
                edgeIndices: uniqueEdgeIndices,
            }];
        }
        return buckets;
    }

    /**
     * @desc A property within a {@link PropertySet}.
     *
     * @class Property
     */
    class Property {

        /**
         * @private
         */
        constructor(name, value, type, valueType, description) {

            /**
             * The name of this property.
             *
             * @property name
             * @type {String}
             */
            this.name = name;

            /**
             * The type of this property.
             *
             * @property type
             * @type {Number|String}
             */
            this.type = type;

            /**
             * The value of this property.
             *
             * @property value
             * @type {*}
             */
            this.value = value;

            /**
             * The type of this property's value.
             *
             * @property valueType
             * @type {Number|String}
             */
            this.valueType = valueType;

            /**
             * Informative text to explain the property.
             *
             * @property name
             * @type {String}
             */
            this.description = description;
        }
    }

    /**
     * @desc A set of properties associated with one or more {@link MetaObject}s.
     *
     * A PropertySet is created within {@link MetaScene#createMetaModel} and belongs to a {@link MetaModel}.
     *
     * Each PropertySet is registered by {@link PropertySet#id} in {@link MetaScene#propertySets} and {@link MetaModel#propertySets}.
     *
     * @class PropertySet
     */
    class PropertySet {

        /**
         * @private
         */
        constructor(params) {

            /**
             * Globally-unique ID for this PropertySet.
             *
             * PropertySet instances are registered by this ID in {@link MetaScene#propertySets} and {@link MetaModel#propertySets}.
             *
             * @property id
             * @type {String}
             */
            this.id = params.id;

            /**
             * ID of the corresponding object within the originating system, if any.
             *
             * @type {String}
             * @abstract
             */
            this.originalSystemId = params.originalSystemId;

            /**
             * The MetaModels that share this PropertySet.
             * @type {MetaModel[]}
             */
            this.metaModels = [];

            /**
             * Human-readable name of this PropertySet.
             *
             * @property name
             * @type {String}
             */
            this.name = params.name;

            /**
             * Type of this PropertySet.
             *
             * @property type
             * @type {String}
             */
            this.type = params.type;

            /**
             * Properties within this PropertySet.
             *
             * @property properties
             * @type {Property[]}
             */
            this.properties = [];

            if (params.properties) {
                const properties = params.properties;
                for (let i = 0, len = properties.length; i < len; i++) {
                    const property = properties[i];
                    this.properties.push(new Property(property.name,  property.value, property.type, property.valueType, property.description));
                }
            }
        }
    }

    /**
     * @desc Metadata corresponding to an {@link Entity} that represents an object.
     *
     * An {@link Entity} represents an object when {@link Entity#isObject} is ````true````
     *
     * A MetaObject corresponds to an {@link Entity} by having the same {@link MetaObject#id} as the {@link Entity#id}.
     *
     * A MetaObject is created within {@link MetaScene#createMetaModel} and belongs to a {@link MetaModel}.
     *
     * Each MetaObject is registered by {@link MetaObject#id} in {@link MetaScene#metaObjects}.
     *
     * A {@link MetaModel} represents its object structure with a tree of MetaObjects, with {@link MetaModel#rootMetaObject} referencing
     * the root MetaObject.
     *
     * @class MetaObject
     */
    class MetaObject {

        /**
         * @private
         */
        constructor(params) {

            /**
             * The MetaModels that share this MetaObject.
             * @type {MetaModel[]}
             */
            this.metaModels = [];

            /**
             * Globally-unique ID.
             *
             * MetaObject instances are registered by this ID in {@link MetaScene#metaObjects}.
             *
             * @property id
             * @type {String|Number}
             */
            this.id = params.id;

            /**
             * ID of the parent MetaObject.
             * @type {String|Number}
             */
            this.parentId = params.parentId;

            /**
             * The parent MetaObject.
             * @type {MetaObject | null}
             */
            this.parent = null;

            /**
             * ID of the corresponding object within the originating system, if any.
             *
             * @type {String}
             * @abstract
             */
            this.originalSystemId = params.originalSystemId;

            /**
             * Human-readable name.
             *
             * @property name
             * @type {String}
             */
            this.name = params.name;

            /**
             * Type - often an IFC product type.
             *
             * @property type
             * @type {String}
             */
            this.type = params.type;

            /**
             * IDs of PropertySets associated with this MetaObject.
             * @type {[]|*}
             */
            this.propertySetIds = params.propertySetIds;

            /**
             * The {@link PropertySet}s associated with this MetaObject.
             *
             * @property propertySets
             * @type {PropertySet[]}
             */
            this.propertySets = [];

            /**
             * The attributes of this MetaObject.
             * @type {{}}
             */
            this.attributes = params.attributes || {};

            if (params.external !== undefined && params.external !== null) {
            
                /**
                 * External application-specific metadata
                 *
                 * Undefined when there are is no external application-specific metadata.
                 *
                 * @property external
                 * @type {*}
                 */
                this.external = params.external;
            }
        }

        /**
         * Backwards compatibility with the object belonging to a single MetaModel.
         * 
         * @property metaModel
         * @type {MetaModel|null}
         **/
        get metaModel() {
            if (this.metaModels.length == 1) {
                return this.metaModels[0];
            }

            return null;
        }

        /**
         * Gets the {@link MetaObject#id}s of the {@link MetaObject}s within the subtree.
         *
         * @returns {String[]} Array of {@link MetaObject#id}s.
         */
        getObjectIDsInSubtree() {
            const objectIds = [];

            function visit(metaObject) {
                if (!metaObject) {
                    return;
                }
                objectIds.push(metaObject.id);
                const children = metaObject.children;
                if (children) {
                    for (var i = 0, len = children.length; i < len; i++) {
                        visit(children[i]);
                    }
                }
            }

            visit(this);
            return objectIds;
        }


        /**
         * Iterates over the {@link MetaObject}s within the subtree.
         *
         * @param {Function} callback Callback fired at each {@link MetaObject}.
         */
        withMetaObjectsInSubtree(callback) {

            function visit(metaObject) {
                if (!metaObject) {
                    return;
                }
                callback(metaObject);
                const children = metaObject.children;
                if (children) {
                    for (var i = 0, len = children.length; i < len; i++) {
                        visit(children[i]);
                    }
                }
            }

            visit(this);
        }

        /**
         * Gets the {@link MetaObject#id}s of the {@link MetaObject}s within the subtree that have the given {@link MetaObject#type}s.
         *
         * @param {String[]} types {@link MetaObject#type} values.
         * @returns {String[]} Array of {@link MetaObject#id}s.
         */
        getObjectIDsInSubtreeByType(types) {
            const mask = {};
            for (var i = 0, len = types.length; i < len; i++) {
                mask[types[i]] = types[i];
            }
            const objectIds = [];

            function visit(metaObject) {
                if (!metaObject) {
                    return;
                }
                if (mask[metaObject.type]) {
                    objectIds.push(metaObject.id);
                }
                const children = metaObject.children;
                if (children) {
                    for (var i = 0, len = children.length; i < len; i++) {
                        visit(children[i]);
                    }
                }
            }

            visit(this);
            return objectIds;
        }

        /**
         * Returns properties of this MeteObject as JSON.
         *
         * @returns {{id: (String|Number), type: String, name: String, parent: (String|Number|Undefined)}}
         */
        getJSON() {
            var json = {
                id: this.id,
                type: this.type,
                name: this.name
            };
            if (this.parent) {
                json.parent = this.parent.id;
            }
            return json;
        }
    }

    /**
     * @desc Metadata corresponding to an {@link Entity} that represents a model.
     *
     * An {@link Entity} represents a model when {@link Entity#isModel} is ````true````
     *
     * A MetaModel corresponds to an {@link Entity} by having the same {@link MetaModel#id} as the {@link Entity#id}.
     *
     * A MetaModel is created by {@link MetaScene#createMetaModel} and belongs to a {@link MetaScene}.
     *
     * Each MetaModel is registered by {@link MetaModel#id} in {@link MetaScene#metaModels}.
     *
     * A {@link MetaModel} represents its object structure with a tree of {@link MetaObject}s, with {@link MetaModel#rootMetaObject} referencing the root {@link MetaObject}.
     *
     * @class MetaModel
     */
    class MetaModel {

        /**
         * Creates a new, unfinalized MetaModel.
         *
         * * The MetaModel is immediately registered by {@link MetaModel#id} in {@link MetaScene#metaModels}, even though it's not yet populated.
         * * The MetaModel then needs to be populated with one or more calls to {@link metaModel#loadData}.
         * * As we populate it, the MetaModel will create {@link MetaObject}s and {@link PropertySet}s in itself, and in the MetaScene.
         * * When populated, call {@link MetaModel#finalize} to finish it off, which causes MetaScene to fire a "metaModelCreated" event.
         */
        constructor(params) {

            /**
             * Globally-unique ID.
             *
             * MetaModels are registered by ID in {@link MetaScene#metaModels}.
             *
             * When this MetaModel corresponds to an {@link Entity} then this ID will match the {@link Entity#id}.
             *
             * @property id
             * @type {String|Number}
             */
            this.id = params.id;

            /**
             * The project ID
             * @property projectId
             * @type {String|Number}
             */
            this.projectId = params.projectId;

            /**
             * The revision ID, if available.
             *
             * Will be undefined if not available.
             *
             * @property revisionId
             * @type {String|Number}
             */
            this.revisionId = params.revisionId;

            /**
             * The model author, if available.
             *
             * Will be undefined if not available.
             *
             * @property author
             * @type {String}
             */
            this.author = params.author;

            /**
             * The date the model was created, if available.
             *
             * Will be undefined if not available.
             *
             * @property createdAt
             * @type {String}
             */
            this.createdAt = params.createdAt;

            /**
             * The application that created the model, if available.
             *
             * Will be undefined if not available.
             *
             * @property creatingApplication
             * @type {String}
             */
            this.creatingApplication = params.creatingApplication;

            /**
             * The model schema version, if available.
             *
             * Will be undefined if not available.
             *
             * @property schema
             * @type {String}
             */
            this.schema = params.schema;

            /**
             * Metadata on the {@link Scene}.
             *
             * @property metaScene
             * @type {MetaScene}
             */
            // @reviser lijuhong 注释metaScene相关代码
            // this.metaScene = params.metaScene;

            /**
             * The {@link PropertySet}s in this MetaModel.
             *
             * @property propertySets
             * @type  {PropertySet[]}
             */
            this.propertySets = [];

            /**
             * The root {@link MetaObject}s in this MetaModel's composition structure hierarchy.
             *
             * @property rootMetaObject
             * @type {MetaObject[]}
             */
            this.rootMetaObjects = [];

            /**
             * The {@link MetaObject}s in this MetaModel, each mapped to its ID.
             *
             * @property metaObjects
             * @type  {MetaObject[]}
             */
            this.metaObjects = [];

            /**
             * Connectivity graph.
             * @type {{}}
             */
            this.graph = params.graph || {};

            // @reviser lijuhong 注释metaScene相关代码
            // this.metaScene.metaModels[this.id] = this;

            /**
             * True when this MetaModel has been finalized.
             * @type {boolean}
             */
            this.finalized = false;
        }

        /**
         * Backwards compatibility with the model having a single root MetaObject.
         *
         * @property rootMetaObject
         * @type {MetaObject|null}
         */
        get rootMetaObject() {
            if (this.rootMetaObjects.length == 1) {
                return this.rootMetaObjects[0];
            }
            return null;
        }

        /**
         * Load metamodel data into this MetaModel.
         * @param metaModelData
         */
        loadData(metaModelData, options = {}) {

            if (this.finalized) {
                throw "MetaScene already finalized - can't add more data";
            }

            this._globalizeIDs(metaModelData, options);

            // const metaScene = this.metaScene;
            const propertyLookup = metaModelData.properties;

            // Create global Property Sets

            if (metaModelData.propertySets) {
                for (let i = 0, len = metaModelData.propertySets.length; i < len; i++) {
                    const propertySetData = metaModelData.propertySets[i];
                    if (!propertySetData.properties) { // HACK: https://github.com/Creoox/creoox-ifc2gltfcxconverter/issues/8
                        propertySetData.properties = [];
                    }
                    // @reviser lijuhong 注释metaScene相关代码
                    let propertySet;// = metaScene.propertySets[propertySetData.id];
                    if (!propertySet) {
                        if (propertyLookup) {
                            this._decompressProperties(propertyLookup, propertySetData.properties);
                        }
                        propertySet = new PropertySet({
                            id: propertySetData.id,
                            originalSystemId: propertySetData.originalSystemId || propertySetData.id,
                            type: propertySetData.type,
                            name: propertySetData.name,
                            properties: propertySetData.properties
                        });
                        // @reviser lijuhong 注释metaScene相关代码
                        // metaScene.propertySets[propertySet.id] = propertySet;
                    }
                    propertySet.metaModels.push(this);
                    this.propertySets.push(propertySet);
                }
            }

            if (metaModelData.metaObjects) {
                for (let i = 0, len = metaModelData.metaObjects.length; i < len; i++) {
                    const metaObjectData = metaModelData.metaObjects[i];
                    const id = metaObjectData.id;
                    // @reviser lijuhong 注释metaScene相关代码
                    let metaObject;// = metaScene.metaObjects[id];
                    if (!metaObject) {
                        const type = metaObjectData.type;
                        const originalSystemId = metaObjectData.originalSystemId;
                        const propertySetIds = metaObjectData.propertySets || metaObjectData.propertySetIds;
                        metaObject = new MetaObject({
                            id,
                            originalSystemId,
                            parentId: metaObjectData.parent,
                            type,
                            name: metaObjectData.name,
                            attributes: metaObjectData.attributes,
                            propertySetIds,
                            external: metaObjectData.external,
                        });
                        // @reviser lijuhong 注释metaScene相关代码
                        // this.metaScene.metaObjects[id] = metaObject;
                        metaObject.metaModels = [];
                    }
                    this.metaObjects.push(metaObject);
                    if (!metaObjectData.parent) {
                        this.rootMetaObjects.push(metaObject);
                        // @reviser lijuhong 注释metaScene相关代码
                        // metaScene.rootMetaObjects[id] = metaObject;
                    }
                }
            }
        }

        _decompressProperties(propertyLookup, properties) {
            for (let i = 0, len = properties.length; i < len; i++) {
                const property = properties[i];
                if (Number.isInteger(property)) {
                    const lookupProperty = propertyLookup[property];
                    if (lookupProperty) {
                        properties[i] = lookupProperty;
                    }
                }
            }
        }

        finalize() {

            if (this.finalized) {
                throw "MetaScene already finalized - can't re-finalize";
            }

            // Re-link MetaScene's entire MetaObject parent/child hierarchy

            // @reviser lijuhong 注释metaScene相关代码
            /* const metaScene = this.metaScene;

            for (let objectId in metaScene.metaObjects) {
                const metaObject = metaScene.metaObjects[objectId];
                if (metaObject.children) {
                    metaObject.children = [];
                }

                // Re-link each MetaObject's property sets

                if (metaObject.propertySets) {
                    metaObject.propertySets = [];
                }
                if (metaObject.propertySetIds) {
                    for (let i = 0, len = metaObject.propertySetIds.length; i < len; i++) {
                        const propertySetId = metaObject.propertySetIds[i];
                        const propertySet = metaScene.propertySets[propertySetId];
                        metaObject.propertySets.push(propertySet);
                    }
                }
            }

            for (let objectId in metaScene.metaObjects) {
                const metaObject = metaScene.metaObjects[objectId];
                if (metaObject.parentId) {
                    const parentMetaObject = metaScene.metaObjects[metaObject.parentId];
                    if (parentMetaObject) {
                        metaObject.parent = parentMetaObject;
                        (parentMetaObject.children || (parentMetaObject.children = [])).push(metaObject);
                    }
                }
            }

            // Relink MetaObjects to their MetaModels

            for (let objectId in metaScene.metaObjects) {
                const metaObject = metaScene.metaObjects[objectId];
                metaObject.metaModels = [];
            }

            for (let modelId in metaScene.metaModels) {
                const metaModel = metaScene.metaModels[modelId];
                for (let i = 0, len = metaModel.metaObjects.length; i < len; i++) {
                    const metaObject = metaModel.metaObjects[i];
                    metaObject.metaModels.push(metaModel);
                }
            }

            // Rebuild MetaScene's MetaObjects-by-type lookup

            metaScene.metaObjectsByType = {};
            for (let objectId in metaScene.metaObjects) {
                const metaObject = metaScene.metaObjects[objectId];
                const type = metaObject.type;
                (metaScene.metaObjectsByType[type] || (metaScene.metaObjectsByType[type] = {}))[objectId] = metaObject;
            } */

            this.finalized = true;

            // @reviser lijuhong 注释metaScene相关代码
            // this.metaScene.fire("metaModelCreated", this.id);
        }

        /**
         * Gets this MetaModel as JSON.
         * @returns {{schema: (String|string|*), createdAt: (String|string|*), metaObjects: *[], author: (String|string|*), id: (String|Number|string|number|*), creatingApplication: (String|string|*), projectId: (String|Number|string|number|*), propertySets: *[]}}
         */
        getJSON() {
            const json = {
                id: this.id,
                projectId: this.projectId,
                author: this.author,
                createdAt: this.createdAt,
                schema: this.schema,
                creatingApplication: this.creatingApplication,
                metaObjects: [],
                propertySets: []
            };
            for (let i = 0, len = this.metaObjects.length; i < len; i++) {
                const metaObject = this.metaObjects[i];
                const metaObjectCfg = {
                    id: metaObject.id,
                    originalSystemId: metaObject.originalSystemId,
                    extId: metaObject.extId,
                    type: metaObject.type,
                    name: metaObject.name
                };
                if (metaObject.parent) {
                    metaObjectCfg.parent = metaObject.parent.id;
                }
                if (metaObject.attributes) {
                    metaObjectCfg.attributes = metaObject.attributes;
                }
                if (metaObject.propertySetIds) {
                    metaObjectCfg.propertySetIds = metaObject.propertySetIds;
                }
                json.metaObjects.push(metaObjectCfg);
            }
            for (let i = 0, len = this.propertySets.length; i < len; i++) {
                const propertySet = this.propertySets[i];
                const propertySetCfg = {
                    id: propertySet.id,
                    originalSystemId: propertySet.originalSystemId,
                    extId: propertySet.extId,
                    type: propertySet.type,
                    name: propertySet.name,
                    propertyies: []
                };
                for (let j = 0, lenj = propertySet.properties.length; j < lenj; j++) {
                    const property = propertySet.properties[j];
                    const propertyCfg = {
                        id: property.id,
                        description: property.description,
                        type: property.type,
                        name: property.name,
                        value: property.value,
                        valueType: property.valueType
                    };
                    propertySetCfg.properties.push(propertyCfg);
                }
                json.propertySets.push(propertySetCfg);
            }
            return json;
        }

        _globalizeIDs(metaModelData, options) {

            const globalize = !!options.globalizeObjectIds;

            if (metaModelData.metaObjects) {
                for (let i = 0, len = metaModelData.metaObjects.length; i < len; i++) {
                    const metaObjectData = metaModelData.metaObjects[i];

                    // Globalize MetaObject IDs and parent IDs

                    metaObjectData.originalSystemId = metaObjectData.id;
                    if (metaObjectData.parent) {
                        metaObjectData.originalParentSystemId = metaObjectData.parent;
                    }
                    if (globalize) {
                        metaObjectData.id = math.globalizeObjectId(this.id, metaObjectData.id);
                        if (metaObjectData.parent) {
                            metaObjectData.parent = math.globalizeObjectId(this.id, metaObjectData.parent);
                        }
                    }

                    // Globalize MetaObject property set IDs

                    if (globalize) {
                        const propertySetIds = metaObjectData.propertySetIds;
                        if (propertySetIds) {
                            const propertySetGlobalIds = [];
                            for (let j = 0, lenj = propertySetIds.length; j < lenj; j++) {
                                propertySetGlobalIds.push(math.globalizeObjectId(this.id, propertySetIds[j]));
                            }
                            metaObjectData.propertySetIds = propertySetGlobalIds;
                            metaObjectData.originalSystemPropertySetIds = propertySetIds;
                        }
                    } else {
                        metaObjectData.originalSystemPropertySetIds = metaObjectData.propertySetIds;
                    }
                }
            }

            // Globalize global PropertySet IDs

            if (metaModelData.propertySets) {
                for (let i = 0, len = metaModelData.propertySets.length; i < len; i++) {
                    const propertySet = metaModelData.propertySets[i];
                    propertySet.originalSystemId = propertySet.id;
                    if (globalize) {
                        propertySet.id = math.globalizeObjectId(this.id, propertySet.id);
                    }
                }
            }
        }

        // @reviser lijuhong 新增getMetaObject方法
        getMetaObject(metaObjectId) {
            for (let i = 0, len = this.metaObjects.length; i < len; i++) {
                const metaObject = this.metaObjects[i];
                if (metaObject.id === metaObjectId)
                    return metaObject;
            }
        }

        // @reviser lijuhong 新增destroy方法
        destroy() {
            if (this.destroyed) {
                return;
            }        

            this.propertySets.length = 0;
            this.rootMetaObjects.length = 0;
            this.metaObjects.length = 0;

            this.fire("destroyed", this.destroyed = true);
        }
    }

    /**
     @desc Base class for {@link Viewer} plugin classes.
     */
    class Plugin {

        /**
         * Creates this Plugin and installs it into the given {@link Viewer}.
         *
         * @param {string} id ID for this plugin, unique among all plugins in the viewer.
         * @param {Viewer} viewer The viewer.
         * @param {Object} [cfg] Options
         */
        constructor(id, viewer, cfg) {

            /**
             * ID for this Plugin, unique within its {@link Viewer}.
             *
             * @type {string}
             */
            this.id = (cfg && cfg.id) ? cfg.id : id;

            /**
             * The Viewer that contains this Plugin.
             *
             * @type {Viewer}
             */
            this.viewer = viewer;

            this._subIdMap = null; // Subscription subId pool
            this._subIdEvents = null; // Subscription subIds mapped to event names
            this._eventSubs = null; // Event names mapped to subscribers
            this._eventSubsNum = null;
            this._events = null; // Maps names to events
            this._eventCallDepth = 0; // Helps us catch stack overflows from recursive events

            // @reviser lijuhong 添加viewer是否存在判断
            viewer && viewer.addPlugin(this);
        }

        /**
         * Schedule a task to perform on the next browser interval
         * @param task
         */
        scheduleTask(task) {
            core.scheduleTask(task, null);
        }

        /**
         * Fires an event on this Plugin.
         *
         * Notifies existing subscribers to the event, optionally retains the event to give to
         * any subsequent notifications on the event as they are made.
         *
         * @param {String} event The event type name
         * @param {Object} value The event parameters
         * @param {Boolean} [forget=false] When true, does not retain for subsequent subscribers
         */
        fire(event, value, forget) {
            if (!this._events) {
                this._events = {};
            }
            if (!this._eventSubs) {
                this._eventSubs = {};
                this._eventSubsNum = {};
            }
            if (forget !== true) {
                this._events[event] = value || true; // Save notification
            }
            const subs = this._eventSubs[event];
            let sub;
            if (subs) { // Notify subscriptions
                for (const subId in subs) {
                    if (subs.hasOwnProperty(subId)) {
                        sub = subs[subId];
                        this._eventCallDepth++;
                        if (this._eventCallDepth < 300) {
                            sub.callback.call(sub.scope, value);
                        } else {
                            this.error("fire: potential stack overflow from recursive event '" + event + "' - dropping this event");
                        }
                        this._eventCallDepth--;
                    }
                }
            }
        }

        /**
         * Subscribes to an event on this Plugin.
         *
         * The callback is be called with this Plugin as scope.
         *
         * @param {String} event The event
         * @param {Function} callback Called fired on the event
         * @param {Object} [scope=this] Scope for the callback
         * @return {String} Handle to the subscription, which may be used to unsubscribe with {@link #off}.
         */
        on(event, callback, scope) {
            if (!this._events) {
                this._events = {};
            }
            if (!this._subIdMap) {
                this._subIdMap = new Map(); // Subscription subId pool
            }
            if (!this._subIdEvents) {
                this._subIdEvents = {};
            }
            if (!this._eventSubs) {
                this._eventSubs = {};
            }
            if (!this._eventSubsNum) {
                this._eventSubsNum = {};
            }
            let subs = this._eventSubs[event];
            if (!subs) {
                subs = {};
                this._eventSubs[event] = subs;
                this._eventSubsNum[event] = 1;
            } else {
                this._eventSubsNum[event]++;
            }
            const subId = this._subIdMap.addItem(); // Create unique subId
            subs[subId] = {
                callback: callback,
                scope: scope || this
            };
            this._subIdEvents[subId] = event;
            const value = this._events[event];
            if (value !== undefined) { // A publication exists, notify callback immediately
                callback.call(scope || this, value);
            }
            return subId;
        }

        /**
         * Cancels an event subscription that was previously made with {@link Plugin#on} or {@link Plugin#once}.
         *
         * @param {String} subId Subscription ID
         */
        off(subId) {
            if (subId === undefined || subId === null) {
                return;
            }
            if (!this._subIdEvents) {
                return;
            }
            const event = this._subIdEvents[subId];
            if (event) {
                delete this._subIdEvents[subId];
                const subs = this._eventSubs[event];
                if (subs) {
                    delete subs[subId];
                    this._eventSubsNum[event]--;
                }
                this._subIdMap.removeItem(subId); // Release subId
            }
        }

        /**
         * Subscribes to the next occurrence of the given event, then un-subscribes as soon as the event is subIdd.
         *
         * This is equivalent to calling {@link Plugin#on}, and then calling {@link Plugin#off} inside the callback function.
         *
         * @param {String} event Data event to listen to
         * @param {Function} callback Called when fresh data is available at the event
         * @param {Object} [scope=this] Scope for the callback
         */
        once(event, callback, scope) {
            const self = this;
            const subId = this.on(event,
                function (value) {
                    self.off(subId);
                    callback.call(scope || this, value);
                },
                scope);
        }

        /**
         * Returns true if there are any subscribers to the given event on this Plugin.
         *
         * @param {String} event The event
         * @return {Boolean} True if there are any subscribers to the given event on this Plugin.
         */
        hasSubs(event) {
            return (this._eventSubsNum && (this._eventSubsNum[event] > 0));
        }

        /**
         * Logs a message to the JavaScript developer console, prefixed with the ID of this Plugin.
         *
         * @param {String} msg The error message
         */
        log(msg) {
            console.log(`[xeokit plugin ${this.id}]: ${msg}`);
        }

        /**
         * Logs a warning message to the JavaScript developer console, prefixed with the ID of this Plugin.
         *
         * @param {String} msg The error message
         */
        warn(msg) {
            console.warn(`[xeokit plugin ${this.id}]: ${msg}`);
        }

        /**
         * Logs an error message to the JavaScript developer console, prefixed with the ID of this Plugin.
         *
         * @param {String} msg The error message
         */
        error(msg) {
            console.error(`[xeokit plugin ${this.id}]: ${msg}`);
        }

        /**
         * Sends a message to this Plugin.
         *
         * @private
         */
        send(name, value) {
            //...
        }

        /**
         * Destroys this Plugin and removes it from its {@link Viewer}.
         */
        destroy() {
            // @reviser lijuhong 添加viewer是否存在判断
            this.viewer && this.viewer.removePlugin(this);
        }
    }

    /**
     * Default data access strategy for {@link XKTLoaderPlugin}.
     */
    class XKTDefaultDataSource {

        constructor() {
        }

        /**
         * Gets manifest JSON.
         *
         * @param {String|Number} manifestSrc Identifies the manifest JSON asset.
         * @param {Function} ok Fired on successful loading of the manifest JSON asset.
         * @param {Function} error Fired on error while loading the manifest JSON asset.
         */
        getManifest(manifestSrc, ok, error) {
            utils.loadJSON(manifestSrc,
                (json) => {
                    ok(json);
                },
                function (errMsg) {
                    error(errMsg);
                });
        }

        /**
         * Gets metamodel JSON.
         *
         * @param {String|Number} metaModelSrc Identifies the metamodel JSON asset.
         * @param {Function} ok Fired on successful loading of the metamodel JSON asset.
         * @param {Function} error Fired on error while loading the metamodel JSON asset.
         */
        getMetaModel(metaModelSrc, ok, error) {
            utils.loadJSON(metaModelSrc,
                (json) => {
                    ok(json);
                },
                function (errMsg) {
                    error(errMsg);
                });
        }

        /**
         * Gets the contents of the given ````.xkt```` file in an arraybuffer.
         *
         * @param {String|Number} src Path or ID of an ````.xkt```` file.
         * @param {Function} ok Callback fired on success, argument is the ````.xkt```` file in an arraybuffer.
         * @param {Function} error Callback fired on error.
         */
        getXKT(src, ok, error) {
            var defaultCallback = () => {
            };
            ok = ok || defaultCallback;
            error = error || defaultCallback;
            const dataUriRegex = /^data:(.*?)(;base64)?,(.*)$/;
            const dataUriRegexResult = src.match(dataUriRegex);
            if (dataUriRegexResult) { // Safari can't handle data URIs through XMLHttpRequest
                const isBase64 = !!dataUriRegexResult[2];
                var data = dataUriRegexResult[3];
                data = window.decodeURIComponent(data);
                if (isBase64) {
                    data = window.atob(data);
                }
                try {
                    const buffer = new ArrayBuffer(data.length);
                    const view = new Uint8Array(buffer);
                    for (var i = 0; i < data.length; i++) {
                        view[i] = data.charCodeAt(i);
                    }
                    ok(buffer);
                } catch (errMsg) {
                    error(errMsg);
                }
            } else {
                const request = new XMLHttpRequest();
                request.open('GET', src, true);
                request.responseType = 'arraybuffer';
                request.onreadystatechange = function () {
                    if (request.readyState === 4) {
                        if (request.status === 200) {
                            ok(request.response);
                        } else {
                            error('getXKT error : ' + request.response);
                        }
                    }
                };
                request.send(null);
            }
        }
    }

    /**
     * @desc Default initial properties for {@link Entity}s loaded from models accompanied by metadata.
     *
     * When loading a model, plugins such as {@link XKTLoaderPlugin} create
     * a tree of {@link Entity}s that represent the model. These loaders can optionally load metadata, to create
     * a {@link MetaModel} corresponding to the root {@link Entity}, with a {@link MetaObject} corresponding to each
     * object {@link Entity} within the tree.
     *
     * @type {{String:Object}}
     */
    const IFCObjectDefaults = {

        DEFAULT: {
        }
    };

    /*! pako 2.1.0 https://github.com/nodeca/pako @license (MIT AND Zlib) */
    !function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t="undefined"!=typeof globalThis?globalThis:t||self).pako={});}(undefined,(function(t){function e(t){let e=t.length;for(;--e>=0;)t[e]=0;}const a=256,i=286,n=30,s=15,r=new Uint8Array([0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]),o=new Uint8Array([0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]),l=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7]),h=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]),d=new Array(576);e(d);const _=new Array(60);e(_);const f=new Array(512);e(f);const c=new Array(256);e(c);const u=new Array(29);e(u);const w=new Array(n);function m(t,e,a,i,n){this.static_tree=t,this.extra_bits=e,this.extra_base=a,this.elems=i,this.max_length=n,this.has_stree=t&&t.length;}let b,g,p;function k(t,e){this.dyn_tree=t,this.max_code=0,this.stat_desc=e;}e(w);const v=t=>t<256?f[t]:f[256+(t>>>7)],y=(t,e)=>{t.pending_buf[t.pending++]=255&e,t.pending_buf[t.pending++]=e>>>8&255;},x=(t,e,a)=>{t.bi_valid>16-a?(t.bi_buf|=e<<t.bi_valid&65535,y(t,t.bi_buf),t.bi_buf=e>>16-t.bi_valid,t.bi_valid+=a-16):(t.bi_buf|=e<<t.bi_valid&65535,t.bi_valid+=a);},z=(t,e,a)=>{x(t,a[2*e],a[2*e+1]);},A=(t,e)=>{let a=0;do{a|=1&t,t>>>=1,a<<=1;}while(--e>0);return a>>>1},E=(t,e,a)=>{const i=new Array(16);let n,r,o=0;for(n=1;n<=s;n++)o=o+a[n-1]<<1,i[n]=o;for(r=0;r<=e;r++){let e=t[2*r+1];0!==e&&(t[2*r]=A(i[e]++,e));}},R=t=>{let e;for(e=0;e<i;e++)t.dyn_ltree[2*e]=0;for(e=0;e<n;e++)t.dyn_dtree[2*e]=0;for(e=0;e<19;e++)t.bl_tree[2*e]=0;t.dyn_ltree[512]=1,t.opt_len=t.static_len=0,t.sym_next=t.matches=0;},Z=t=>{t.bi_valid>8?y(t,t.bi_buf):t.bi_valid>0&&(t.pending_buf[t.pending++]=t.bi_buf),t.bi_buf=0,t.bi_valid=0;},U=(t,e,a,i)=>{const n=2*e,s=2*a;return t[n]<t[s]||t[n]===t[s]&&i[e]<=i[a]},S=(t,e,a)=>{const i=t.heap[a];let n=a<<1;for(;n<=t.heap_len&&(n<t.heap_len&&U(e,t.heap[n+1],t.heap[n],t.depth)&&n++,!U(e,i,t.heap[n],t.depth));)t.heap[a]=t.heap[n],a=n,n<<=1;t.heap[a]=i;},D=(t,e,i)=>{let n,s,l,h,d=0;if(0!==t.sym_next)do{n=255&t.pending_buf[t.sym_buf+d++],n+=(255&t.pending_buf[t.sym_buf+d++])<<8,s=t.pending_buf[t.sym_buf+d++],0===n?z(t,s,e):(l=c[s],z(t,l+a+1,e),h=r[l],0!==h&&(s-=u[l],x(t,s,h)),n--,l=v(n),z(t,l,i),h=o[l],0!==h&&(n-=w[l],x(t,n,h)));}while(d<t.sym_next);z(t,256,e);},T=(t,e)=>{const a=e.dyn_tree,i=e.stat_desc.static_tree,n=e.stat_desc.has_stree,r=e.stat_desc.elems;let o,l,h,d=-1;for(t.heap_len=0,t.heap_max=573,o=0;o<r;o++)0!==a[2*o]?(t.heap[++t.heap_len]=d=o,t.depth[o]=0):a[2*o+1]=0;for(;t.heap_len<2;)h=t.heap[++t.heap_len]=d<2?++d:0,a[2*h]=1,t.depth[h]=0,t.opt_len--,n&&(t.static_len-=i[2*h+1]);for(e.max_code=d,o=t.heap_len>>1;o>=1;o--)S(t,a,o);h=r;do{o=t.heap[1],t.heap[1]=t.heap[t.heap_len--],S(t,a,1),l=t.heap[1],t.heap[--t.heap_max]=o,t.heap[--t.heap_max]=l,a[2*h]=a[2*o]+a[2*l],t.depth[h]=(t.depth[o]>=t.depth[l]?t.depth[o]:t.depth[l])+1,a[2*o+1]=a[2*l+1]=h,t.heap[1]=h++,S(t,a,1);}while(t.heap_len>=2);t.heap[--t.heap_max]=t.heap[1],((t,e)=>{const a=e.dyn_tree,i=e.max_code,n=e.stat_desc.static_tree,r=e.stat_desc.has_stree,o=e.stat_desc.extra_bits,l=e.stat_desc.extra_base,h=e.stat_desc.max_length;let d,_,f,c,u,w,m=0;for(c=0;c<=s;c++)t.bl_count[c]=0;for(a[2*t.heap[t.heap_max]+1]=0,d=t.heap_max+1;d<573;d++)_=t.heap[d],c=a[2*a[2*_+1]+1]+1,c>h&&(c=h,m++),a[2*_+1]=c,_>i||(t.bl_count[c]++,u=0,_>=l&&(u=o[_-l]),w=a[2*_],t.opt_len+=w*(c+u),r&&(t.static_len+=w*(n[2*_+1]+u)));if(0!==m){do{for(c=h-1;0===t.bl_count[c];)c--;t.bl_count[c]--,t.bl_count[c+1]+=2,t.bl_count[h]--,m-=2;}while(m>0);for(c=h;0!==c;c--)for(_=t.bl_count[c];0!==_;)f=t.heap[--d],f>i||(a[2*f+1]!==c&&(t.opt_len+=(c-a[2*f+1])*a[2*f],a[2*f+1]=c),_--);}})(t,e),E(a,d,t.bl_count);},O=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),e[2*(a+1)+1]=65535,i=0;i<=a;i++)n=r,r=e[2*(i+1)+1],++o<l&&n===r||(o<h?t.bl_tree[2*n]+=o:0!==n?(n!==s&&t.bl_tree[2*n]++,t.bl_tree[32]++):o<=10?t.bl_tree[34]++:t.bl_tree[36]++,o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4));},I=(t,e,a)=>{let i,n,s=-1,r=e[1],o=0,l=7,h=4;for(0===r&&(l=138,h=3),i=0;i<=a;i++)if(n=r,r=e[2*(i+1)+1],!(++o<l&&n===r)){if(o<h)do{z(t,n,t.bl_tree);}while(0!=--o);else 0!==n?(n!==s&&(z(t,n,t.bl_tree),o--),z(t,16,t.bl_tree),x(t,o-3,2)):o<=10?(z(t,17,t.bl_tree),x(t,o-3,3)):(z(t,18,t.bl_tree),x(t,o-11,7));o=0,s=n,0===r?(l=138,h=3):n===r?(l=6,h=3):(l=7,h=4);}};let F=!1;const L=(t,e,a,i)=>{x(t,0+(i?1:0),3),Z(t),y(t,a),y(t,~a),a&&t.pending_buf.set(t.window.subarray(e,e+a),t.pending),t.pending+=a;};var N=(t,e,i,n)=>{let s,r,o=0;t.level>0?(2===t.strm.data_type&&(t.strm.data_type=(t=>{let e,i=4093624447;for(e=0;e<=31;e++,i>>>=1)if(1&i&&0!==t.dyn_ltree[2*e])return 0;if(0!==t.dyn_ltree[18]||0!==t.dyn_ltree[20]||0!==t.dyn_ltree[26])return 1;for(e=32;e<a;e++)if(0!==t.dyn_ltree[2*e])return 1;return 0})(t)),T(t,t.l_desc),T(t,t.d_desc),o=(t=>{let e;for(O(t,t.dyn_ltree,t.l_desc.max_code),O(t,t.dyn_dtree,t.d_desc.max_code),T(t,t.bl_desc),e=18;e>=3&&0===t.bl_tree[2*h[e]+1];e--);return t.opt_len+=3*(e+1)+5+5+4,e})(t),s=t.opt_len+3+7>>>3,r=t.static_len+3+7>>>3,r<=s&&(s=r)):s=r=i+5,i+4<=s&&-1!==e?L(t,e,i,n):4===t.strategy||r===s?(x(t,2+(n?1:0),3),D(t,d,_)):(x(t,4+(n?1:0),3),((t,e,a,i)=>{let n;for(x(t,e-257,5),x(t,a-1,5),x(t,i-4,4),n=0;n<i;n++)x(t,t.bl_tree[2*h[n]+1],3);I(t,t.dyn_ltree,e-1),I(t,t.dyn_dtree,a-1);})(t,t.l_desc.max_code+1,t.d_desc.max_code+1,o+1),D(t,t.dyn_ltree,t.dyn_dtree)),R(t),n&&Z(t);},B={_tr_init:t=>{F||((()=>{let t,e,a,h,k;const v=new Array(16);for(a=0,h=0;h<28;h++)for(u[h]=a,t=0;t<1<<r[h];t++)c[a++]=h;for(c[a-1]=h,k=0,h=0;h<16;h++)for(w[h]=k,t=0;t<1<<o[h];t++)f[k++]=h;for(k>>=7;h<n;h++)for(w[h]=k<<7,t=0;t<1<<o[h]-7;t++)f[256+k++]=h;for(e=0;e<=s;e++)v[e]=0;for(t=0;t<=143;)d[2*t+1]=8,t++,v[8]++;for(;t<=255;)d[2*t+1]=9,t++,v[9]++;for(;t<=279;)d[2*t+1]=7,t++,v[7]++;for(;t<=287;)d[2*t+1]=8,t++,v[8]++;for(E(d,287,v),t=0;t<n;t++)_[2*t+1]=5,_[2*t]=A(t,5);b=new m(d,r,257,i,s),g=new m(_,o,0,n,s),p=new m(new Array(0),l,0,19,7);})(),F=!0),t.l_desc=new k(t.dyn_ltree,b),t.d_desc=new k(t.dyn_dtree,g),t.bl_desc=new k(t.bl_tree,p),t.bi_buf=0,t.bi_valid=0,R(t);},_tr_stored_block:L,_tr_flush_block:N,_tr_tally:(t,e,i)=>(t.pending_buf[t.sym_buf+t.sym_next++]=e,t.pending_buf[t.sym_buf+t.sym_next++]=e>>8,t.pending_buf[t.sym_buf+t.sym_next++]=i,0===e?t.dyn_ltree[2*i]++:(t.matches++,e--,t.dyn_ltree[2*(c[i]+a+1)]++,t.dyn_dtree[2*v(e)]++),t.sym_next===t.sym_end),_tr_align:t=>{x(t,2,3),z(t,256,d),(t=>{16===t.bi_valid?(y(t,t.bi_buf),t.bi_buf=0,t.bi_valid=0):t.bi_valid>=8&&(t.pending_buf[t.pending++]=255&t.bi_buf,t.bi_buf>>=8,t.bi_valid-=8);})(t);}};var C=(t,e,a,i)=>{let n=65535&t|0,s=t>>>16&65535|0,r=0;for(;0!==a;){r=a>2e3?2e3:a,a-=r;do{n=n+e[i++]|0,s=s+n|0;}while(--r);n%=65521,s%=65521;}return n|s<<16|0};const M=new Uint32Array((()=>{let t,e=[];for(var a=0;a<256;a++){t=a;for(var i=0;i<8;i++)t=1&t?3988292384^t>>>1:t>>>1;e[a]=t;}return e})());var H=(t,e,a,i)=>{const n=M,s=i+a;t^=-1;for(let a=i;a<s;a++)t=t>>>8^n[255&(t^e[a])];return -1^t},j={2:"need dictionary",1:"stream end",0:"","-1":"file error","-2":"stream error","-3":"data error","-4":"insufficient memory","-5":"buffer error","-6":"incompatible version"},K={Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_BLOCK:5,Z_TREES:6,Z_OK:0,Z_STREAM_END:1,Z_NEED_DICT:2,Z_ERRNO:-1,Z_STREAM_ERROR:-2,Z_DATA_ERROR:-3,Z_MEM_ERROR:-4,Z_BUF_ERROR:-5,Z_NO_COMPRESSION:0,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_COMPRESSION:-1,Z_FILTERED:1,Z_HUFFMAN_ONLY:2,Z_RLE:3,Z_FIXED:4,Z_DEFAULT_STRATEGY:0,Z_BINARY:0,Z_TEXT:1,Z_UNKNOWN:2,Z_DEFLATED:8};const{_tr_init:P,_tr_stored_block:Y,_tr_flush_block:G,_tr_tally:X,_tr_align:W}=B,{Z_NO_FLUSH:q,Z_PARTIAL_FLUSH:J,Z_FULL_FLUSH:Q,Z_FINISH:V,Z_BLOCK:$,Z_OK:tt,Z_STREAM_END:et,Z_STREAM_ERROR:at,Z_DATA_ERROR:it,Z_BUF_ERROR:nt,Z_DEFAULT_COMPRESSION:st,Z_FILTERED:rt,Z_HUFFMAN_ONLY:ot,Z_RLE:lt,Z_FIXED:ht,Z_DEFAULT_STRATEGY:dt,Z_UNKNOWN:_t,Z_DEFLATED:ft}=K,ct=258,ut=262,wt=42,mt=113,bt=666,gt=(t,e)=>(t.msg=j[e],e),pt=t=>2*t-(t>4?9:0),kt=t=>{let e=t.length;for(;--e>=0;)t[e]=0;},vt=t=>{let e,a,i,n=t.w_size;e=t.hash_size,i=e;do{a=t.head[--i],t.head[i]=a>=n?a-n:0;}while(--e);e=n,i=e;do{a=t.prev[--i],t.prev[i]=a>=n?a-n:0;}while(--e)};let yt=(t,e,a)=>(e<<t.hash_shift^a)&t.hash_mask;const xt=t=>{const e=t.state;let a=e.pending;a>t.avail_out&&(a=t.avail_out),0!==a&&(t.output.set(e.pending_buf.subarray(e.pending_out,e.pending_out+a),t.next_out),t.next_out+=a,e.pending_out+=a,t.total_out+=a,t.avail_out-=a,e.pending-=a,0===e.pending&&(e.pending_out=0));},zt=(t,e)=>{G(t,t.block_start>=0?t.block_start:-1,t.strstart-t.block_start,e),t.block_start=t.strstart,xt(t.strm);},At=(t,e)=>{t.pending_buf[t.pending++]=e;},Et=(t,e)=>{t.pending_buf[t.pending++]=e>>>8&255,t.pending_buf[t.pending++]=255&e;},Rt=(t,e,a,i)=>{let n=t.avail_in;return n>i&&(n=i),0===n?0:(t.avail_in-=n,e.set(t.input.subarray(t.next_in,t.next_in+n),a),1===t.state.wrap?t.adler=C(t.adler,e,n,a):2===t.state.wrap&&(t.adler=H(t.adler,e,n,a)),t.next_in+=n,t.total_in+=n,n)},Zt=(t,e)=>{let a,i,n=t.max_chain_length,s=t.strstart,r=t.prev_length,o=t.nice_match;const l=t.strstart>t.w_size-ut?t.strstart-(t.w_size-ut):0,h=t.window,d=t.w_mask,_=t.prev,f=t.strstart+ct;let c=h[s+r-1],u=h[s+r];t.prev_length>=t.good_match&&(n>>=2),o>t.lookahead&&(o=t.lookahead);do{if(a=e,h[a+r]===u&&h[a+r-1]===c&&h[a]===h[s]&&h[++a]===h[s+1]){s+=2,a++;do{}while(h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&h[++s]===h[++a]&&s<f);if(i=ct-(f-s),s=f-ct,i>r){if(t.match_start=e,r=i,i>=o)break;c=h[s+r-1],u=h[s+r];}}}while((e=_[e&d])>l&&0!=--n);return r<=t.lookahead?r:t.lookahead},Ut=t=>{const e=t.w_size;let a,i,n;do{if(i=t.window_size-t.lookahead-t.strstart,t.strstart>=e+(e-ut)&&(t.window.set(t.window.subarray(e,e+e-i),0),t.match_start-=e,t.strstart-=e,t.block_start-=e,t.insert>t.strstart&&(t.insert=t.strstart),vt(t),i+=e),0===t.strm.avail_in)break;if(a=Rt(t.strm,t.window,t.strstart+t.lookahead,i),t.lookahead+=a,t.lookahead+t.insert>=3)for(n=t.strstart-t.insert,t.ins_h=t.window[n],t.ins_h=yt(t,t.ins_h,t.window[n+1]);t.insert&&(t.ins_h=yt(t,t.ins_h,t.window[n+3-1]),t.prev[n&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=n,n++,t.insert--,!(t.lookahead+t.insert<3)););}while(t.lookahead<ut&&0!==t.strm.avail_in)},St=(t,e)=>{let a,i,n,s=t.pending_buf_size-5>t.w_size?t.w_size:t.pending_buf_size-5,r=0,o=t.strm.avail_in;do{if(a=65535,n=t.bi_valid+42>>3,t.strm.avail_out<n)break;if(n=t.strm.avail_out-n,i=t.strstart-t.block_start,a>i+t.strm.avail_in&&(a=i+t.strm.avail_in),a>n&&(a=n),a<s&&(0===a&&e!==V||e===q||a!==i+t.strm.avail_in))break;r=e===V&&a===i+t.strm.avail_in?1:0,Y(t,0,0,r),t.pending_buf[t.pending-4]=a,t.pending_buf[t.pending-3]=a>>8,t.pending_buf[t.pending-2]=~a,t.pending_buf[t.pending-1]=~a>>8,xt(t.strm),i&&(i>a&&(i=a),t.strm.output.set(t.window.subarray(t.block_start,t.block_start+i),t.strm.next_out),t.strm.next_out+=i,t.strm.avail_out-=i,t.strm.total_out+=i,t.block_start+=i,a-=i),a&&(Rt(t.strm,t.strm.output,t.strm.next_out,a),t.strm.next_out+=a,t.strm.avail_out-=a,t.strm.total_out+=a);}while(0===r);return o-=t.strm.avail_in,o&&(o>=t.w_size?(t.matches=2,t.window.set(t.strm.input.subarray(t.strm.next_in-t.w_size,t.strm.next_in),0),t.strstart=t.w_size,t.insert=t.strstart):(t.window_size-t.strstart<=o&&(t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,t.insert>t.strstart&&(t.insert=t.strstart)),t.window.set(t.strm.input.subarray(t.strm.next_in-o,t.strm.next_in),t.strstart),t.strstart+=o,t.insert+=o>t.w_size-t.insert?t.w_size-t.insert:o),t.block_start=t.strstart),t.high_water<t.strstart&&(t.high_water=t.strstart),r?4:e!==q&&e!==V&&0===t.strm.avail_in&&t.strstart===t.block_start?2:(n=t.window_size-t.strstart,t.strm.avail_in>n&&t.block_start>=t.w_size&&(t.block_start-=t.w_size,t.strstart-=t.w_size,t.window.set(t.window.subarray(t.w_size,t.w_size+t.strstart),0),t.matches<2&&t.matches++,n+=t.w_size,t.insert>t.strstart&&(t.insert=t.strstart)),n>t.strm.avail_in&&(n=t.strm.avail_in),n&&(Rt(t.strm,t.window,t.strstart,n),t.strstart+=n,t.insert+=n>t.w_size-t.insert?t.w_size-t.insert:n),t.high_water<t.strstart&&(t.high_water=t.strstart),n=t.bi_valid+42>>3,n=t.pending_buf_size-n>65535?65535:t.pending_buf_size-n,s=n>t.w_size?t.w_size:n,i=t.strstart-t.block_start,(i>=s||(i||e===V)&&e!==q&&0===t.strm.avail_in&&i<=n)&&(a=i>n?n:i,r=e===V&&0===t.strm.avail_in&&a===i?1:0,Y(t,t.block_start,a,r),t.block_start+=a,xt(t.strm)),r?3:1)},Dt=(t,e)=>{let a,i;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),0!==a&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a)),t.match_length>=3)if(i=X(t,t.strstart-t.match_start,t.match_length-3),t.lookahead-=t.match_length,t.match_length<=t.max_lazy_match&&t.lookahead>=3){t.match_length--;do{t.strstart++,t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart;}while(0!=--t.match_length);t.strstart++;}else t.strstart+=t.match_length,t.match_length=0,t.ins_h=t.window[t.strstart],t.ins_h=yt(t,t.ins_h,t.window[t.strstart+1]);else i=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++;if(i&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2},Tt=(t,e)=>{let a,i,n;for(;;){if(t.lookahead<ut){if(Ut(t),t.lookahead<ut&&e===q)return 1;if(0===t.lookahead)break}if(a=0,t.lookahead>=3&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart),t.prev_length=t.match_length,t.prev_match=t.match_start,t.match_length=2,0!==a&&t.prev_length<t.max_lazy_match&&t.strstart-a<=t.w_size-ut&&(t.match_length=Zt(t,a),t.match_length<=5&&(t.strategy===rt||3===t.match_length&&t.strstart-t.match_start>4096)&&(t.match_length=2)),t.prev_length>=3&&t.match_length<=t.prev_length){n=t.strstart+t.lookahead-3,i=X(t,t.strstart-1-t.prev_match,t.prev_length-3),t.lookahead-=t.prev_length-1,t.prev_length-=2;do{++t.strstart<=n&&(t.ins_h=yt(t,t.ins_h,t.window[t.strstart+3-1]),a=t.prev[t.strstart&t.w_mask]=t.head[t.ins_h],t.head[t.ins_h]=t.strstart);}while(0!=--t.prev_length);if(t.match_available=0,t.match_length=2,t.strstart++,i&&(zt(t,!1),0===t.strm.avail_out))return 1}else if(t.match_available){if(i=X(t,0,t.window[t.strstart-1]),i&&zt(t,!1),t.strstart++,t.lookahead--,0===t.strm.avail_out)return 1}else t.match_available=1,t.strstart++,t.lookahead--;}return t.match_available&&(i=X(t,0,t.window[t.strstart-1]),t.match_available=0),t.insert=t.strstart<2?t.strstart:2,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2};function Ot(t,e,a,i,n){this.good_length=t,this.max_lazy=e,this.nice_length=a,this.max_chain=i,this.func=n;}const It=[new Ot(0,0,0,0,St),new Ot(4,4,8,4,Dt),new Ot(4,5,16,8,Dt),new Ot(4,6,32,32,Dt),new Ot(4,4,16,16,Tt),new Ot(8,16,32,32,Tt),new Ot(8,16,128,128,Tt),new Ot(8,32,128,256,Tt),new Ot(32,128,258,1024,Tt),new Ot(32,258,258,4096,Tt)];function Ft(){this.strm=null,this.status=0,this.pending_buf=null,this.pending_buf_size=0,this.pending_out=0,this.pending=0,this.wrap=0,this.gzhead=null,this.gzindex=0,this.method=ft,this.last_flush=-1,this.w_size=0,this.w_bits=0,this.w_mask=0,this.window=null,this.window_size=0,this.prev=null,this.head=null,this.ins_h=0,this.hash_size=0,this.hash_bits=0,this.hash_mask=0,this.hash_shift=0,this.block_start=0,this.match_length=0,this.prev_match=0,this.match_available=0,this.strstart=0,this.match_start=0,this.lookahead=0,this.prev_length=0,this.max_chain_length=0,this.max_lazy_match=0,this.level=0,this.strategy=0,this.good_match=0,this.nice_match=0,this.dyn_ltree=new Uint16Array(1146),this.dyn_dtree=new Uint16Array(122),this.bl_tree=new Uint16Array(78),kt(this.dyn_ltree),kt(this.dyn_dtree),kt(this.bl_tree),this.l_desc=null,this.d_desc=null,this.bl_desc=null,this.bl_count=new Uint16Array(16),this.heap=new Uint16Array(573),kt(this.heap),this.heap_len=0,this.heap_max=0,this.depth=new Uint16Array(573),kt(this.depth),this.sym_buf=0,this.lit_bufsize=0,this.sym_next=0,this.sym_end=0,this.opt_len=0,this.static_len=0,this.matches=0,this.insert=0,this.bi_buf=0,this.bi_valid=0;}const Lt=t=>{if(!t)return 1;const e=t.state;return !e||e.strm!==t||e.status!==wt&&57!==e.status&&69!==e.status&&73!==e.status&&91!==e.status&&103!==e.status&&e.status!==mt&&e.status!==bt?1:0},Nt=t=>{if(Lt(t))return gt(t,at);t.total_in=t.total_out=0,t.data_type=_t;const e=t.state;return e.pending=0,e.pending_out=0,e.wrap<0&&(e.wrap=-e.wrap),e.status=2===e.wrap?57:e.wrap?wt:mt,t.adler=2===e.wrap?0:1,e.last_flush=-2,P(e),tt},Bt=t=>{const e=Nt(t);var a;return e===tt&&((a=t.state).window_size=2*a.w_size,kt(a.head),a.max_lazy_match=It[a.level].max_lazy,a.good_match=It[a.level].good_length,a.nice_match=It[a.level].nice_length,a.max_chain_length=It[a.level].max_chain,a.strstart=0,a.block_start=0,a.lookahead=0,a.insert=0,a.match_length=a.prev_length=2,a.match_available=0,a.ins_h=0),e},Ct=(t,e,a,i,n,s)=>{if(!t)return at;let r=1;if(e===st&&(e=6),i<0?(r=0,i=-i):i>15&&(r=2,i-=16),n<1||n>9||a!==ft||i<8||i>15||e<0||e>9||s<0||s>ht||8===i&&1!==r)return gt(t,at);8===i&&(i=9);const o=new Ft;return t.state=o,o.strm=t,o.status=wt,o.wrap=r,o.gzhead=null,o.w_bits=i,o.w_size=1<<o.w_bits,o.w_mask=o.w_size-1,o.hash_bits=n+7,o.hash_size=1<<o.hash_bits,o.hash_mask=o.hash_size-1,o.hash_shift=~~((o.hash_bits+3-1)/3),o.window=new Uint8Array(2*o.w_size),o.head=new Uint16Array(o.hash_size),o.prev=new Uint16Array(o.w_size),o.lit_bufsize=1<<n+6,o.pending_buf_size=4*o.lit_bufsize,o.pending_buf=new Uint8Array(o.pending_buf_size),o.sym_buf=o.lit_bufsize,o.sym_end=3*(o.lit_bufsize-1),o.level=e,o.strategy=s,o.method=a,Bt(t)};var Mt={deflateInit:(t,e)=>Ct(t,e,ft,15,8,dt),deflateInit2:Ct,deflateReset:Bt,deflateResetKeep:Nt,deflateSetHeader:(t,e)=>Lt(t)||2!==t.state.wrap?at:(t.state.gzhead=e,tt),deflate:(t,e)=>{if(Lt(t)||e>$||e<0)return t?gt(t,at):at;const a=t.state;if(!t.output||0!==t.avail_in&&!t.input||a.status===bt&&e!==V)return gt(t,0===t.avail_out?nt:at);const i=a.last_flush;if(a.last_flush=e,0!==a.pending){if(xt(t),0===t.avail_out)return a.last_flush=-1,tt}else if(0===t.avail_in&&pt(e)<=pt(i)&&e!==V)return gt(t,nt);if(a.status===bt&&0!==t.avail_in)return gt(t,nt);if(a.status===wt&&0===a.wrap&&(a.status=mt),a.status===wt){let e=ft+(a.w_bits-8<<4)<<8,i=-1;if(i=a.strategy>=ot||a.level<2?0:a.level<6?1:6===a.level?2:3,e|=i<<6,0!==a.strstart&&(e|=32),e+=31-e%31,Et(a,e),0!==a.strstart&&(Et(a,t.adler>>>16),Et(a,65535&t.adler)),t.adler=1,a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(57===a.status)if(t.adler=0,At(a,31),At(a,139),At(a,8),a.gzhead)At(a,(a.gzhead.text?1:0)+(a.gzhead.hcrc?2:0)+(a.gzhead.extra?4:0)+(a.gzhead.name?8:0)+(a.gzhead.comment?16:0)),At(a,255&a.gzhead.time),At(a,a.gzhead.time>>8&255),At(a,a.gzhead.time>>16&255),At(a,a.gzhead.time>>24&255),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,255&a.gzhead.os),a.gzhead.extra&&a.gzhead.extra.length&&(At(a,255&a.gzhead.extra.length),At(a,a.gzhead.extra.length>>8&255)),a.gzhead.hcrc&&(t.adler=H(t.adler,a.pending_buf,a.pending,0)),a.gzindex=0,a.status=69;else if(At(a,0),At(a,0),At(a,0),At(a,0),At(a,0),At(a,9===a.level?2:a.strategy>=ot||a.level<2?4:0),At(a,3),a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt;if(69===a.status){if(a.gzhead.extra){let e=a.pending,i=(65535&a.gzhead.extra.length)-a.gzindex;for(;a.pending+i>a.pending_buf_size;){let n=a.pending_buf_size-a.pending;if(a.pending_buf.set(a.gzhead.extra.subarray(a.gzindex,a.gzindex+n),a.pending),a.pending=a.pending_buf_size,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex+=n,xt(t),0!==a.pending)return a.last_flush=-1,tt;e=0,i-=n;}let n=new Uint8Array(a.gzhead.extra);a.pending_buf.set(n.subarray(a.gzindex,a.gzindex+i),a.pending),a.pending+=i,a.gzhead.hcrc&&a.pending>e&&(t.adler=H(t.adler,a.pending_buf,a.pending-e,e)),a.gzindex=0;}a.status=73;}if(73===a.status){if(a.gzhead.name){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0;}e=a.gzindex<a.gzhead.name.length?255&a.gzhead.name.charCodeAt(a.gzindex++):0,At(a,e);}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),a.gzindex=0;}a.status=91;}if(91===a.status){if(a.gzhead.comment){let e,i=a.pending;do{if(a.pending===a.pending_buf_size){if(a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i)),xt(t),0!==a.pending)return a.last_flush=-1,tt;i=0;}e=a.gzindex<a.gzhead.comment.length?255&a.gzhead.comment.charCodeAt(a.gzindex++):0,At(a,e);}while(0!==e);a.gzhead.hcrc&&a.pending>i&&(t.adler=H(t.adler,a.pending_buf,a.pending-i,i));}a.status=103;}if(103===a.status){if(a.gzhead.hcrc){if(a.pending+2>a.pending_buf_size&&(xt(t),0!==a.pending))return a.last_flush=-1,tt;At(a,255&t.adler),At(a,t.adler>>8&255),t.adler=0;}if(a.status=mt,xt(t),0!==a.pending)return a.last_flush=-1,tt}if(0!==t.avail_in||0!==a.lookahead||e!==q&&a.status!==bt){let i=0===a.level?St(a,e):a.strategy===ot?((t,e)=>{let a;for(;;){if(0===t.lookahead&&(Ut(t),0===t.lookahead)){if(e===q)return 1;break}if(t.match_length=0,a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++,a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):a.strategy===lt?((t,e)=>{let a,i,n,s;const r=t.window;for(;;){if(t.lookahead<=ct){if(Ut(t),t.lookahead<=ct&&e===q)return 1;if(0===t.lookahead)break}if(t.match_length=0,t.lookahead>=3&&t.strstart>0&&(n=t.strstart-1,i=r[n],i===r[++n]&&i===r[++n]&&i===r[++n])){s=t.strstart+ct;do{}while(i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&i===r[++n]&&n<s);t.match_length=ct-(s-n),t.match_length>t.lookahead&&(t.match_length=t.lookahead);}if(t.match_length>=3?(a=X(t,1,t.match_length-3),t.lookahead-=t.match_length,t.strstart+=t.match_length,t.match_length=0):(a=X(t,0,t.window[t.strstart]),t.lookahead--,t.strstart++),a&&(zt(t,!1),0===t.strm.avail_out))return 1}return t.insert=0,e===V?(zt(t,!0),0===t.strm.avail_out?3:4):t.sym_next&&(zt(t,!1),0===t.strm.avail_out)?1:2})(a,e):It[a.level].func(a,e);if(3!==i&&4!==i||(a.status=bt),1===i||3===i)return 0===t.avail_out&&(a.last_flush=-1),tt;if(2===i&&(e===J?W(a):e!==$&&(Y(a,0,0,!1),e===Q&&(kt(a.head),0===a.lookahead&&(a.strstart=0,a.block_start=0,a.insert=0))),xt(t),0===t.avail_out))return a.last_flush=-1,tt}return e!==V?tt:a.wrap<=0?et:(2===a.wrap?(At(a,255&t.adler),At(a,t.adler>>8&255),At(a,t.adler>>16&255),At(a,t.adler>>24&255),At(a,255&t.total_in),At(a,t.total_in>>8&255),At(a,t.total_in>>16&255),At(a,t.total_in>>24&255)):(Et(a,t.adler>>>16),Et(a,65535&t.adler)),xt(t),a.wrap>0&&(a.wrap=-a.wrap),0!==a.pending?tt:et)},deflateEnd:t=>{if(Lt(t))return at;const e=t.state.status;return t.state=null,e===mt?gt(t,it):tt},deflateSetDictionary:(t,e)=>{let a=e.length;if(Lt(t))return at;const i=t.state,n=i.wrap;if(2===n||1===n&&i.status!==wt||i.lookahead)return at;if(1===n&&(t.adler=C(t.adler,e,a,0)),i.wrap=0,a>=i.w_size){0===n&&(kt(i.head),i.strstart=0,i.block_start=0,i.insert=0);let t=new Uint8Array(i.w_size);t.set(e.subarray(a-i.w_size,a),0),e=t,a=i.w_size;}const s=t.avail_in,r=t.next_in,o=t.input;for(t.avail_in=a,t.next_in=0,t.input=e,Ut(i);i.lookahead>=3;){let t=i.strstart,e=i.lookahead-2;do{i.ins_h=yt(i,i.ins_h,i.window[t+3-1]),i.prev[t&i.w_mask]=i.head[i.ins_h],i.head[i.ins_h]=t,t++;}while(--e);i.strstart=t,i.lookahead=2,Ut(i);}return i.strstart+=i.lookahead,i.block_start=i.strstart,i.insert=i.lookahead,i.lookahead=0,i.match_length=i.prev_length=2,i.match_available=0,t.next_in=r,t.input=o,t.avail_in=s,i.wrap=n,tt},deflateInfo:"pako deflate (from Nodeca project)"};const Ht=(t,e)=>Object.prototype.hasOwnProperty.call(t,e);var jt=function(t){const e=Array.prototype.slice.call(arguments,1);for(;e.length;){const a=e.shift();if(a){if("object"!=typeof a)throw new TypeError(a+"must be non-object");for(const e in a)Ht(a,e)&&(t[e]=a[e]);}}return t},Kt=t=>{let e=0;for(let a=0,i=t.length;a<i;a++)e+=t[a].length;const a=new Uint8Array(e);for(let e=0,i=0,n=t.length;e<n;e++){let n=t[e];a.set(n,i),i+=n.length;}return a};let Pt=!0;try{String.fromCharCode.apply(null,new Uint8Array(1));}catch(t){Pt=!1;}const Yt=new Uint8Array(256);for(let t=0;t<256;t++)Yt[t]=t>=252?6:t>=248?5:t>=240?4:t>=224?3:t>=192?2:1;Yt[254]=Yt[254]=1;var Gt=t=>{if("function"==typeof TextEncoder&&TextEncoder.prototype.encode)return (new TextEncoder).encode(t);let e,a,i,n,s,r=t.length,o=0;for(n=0;n<r;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),o+=a<128?1:a<2048?2:a<65536?3:4;for(e=new Uint8Array(o),s=0,n=0;s<o;n++)a=t.charCodeAt(n),55296==(64512&a)&&n+1<r&&(i=t.charCodeAt(n+1),56320==(64512&i)&&(a=65536+(a-55296<<10)+(i-56320),n++)),a<128?e[s++]=a:a<2048?(e[s++]=192|a>>>6,e[s++]=128|63&a):a<65536?(e[s++]=224|a>>>12,e[s++]=128|a>>>6&63,e[s++]=128|63&a):(e[s++]=240|a>>>18,e[s++]=128|a>>>12&63,e[s++]=128|a>>>6&63,e[s++]=128|63&a);return e},Xt=(t,e)=>{const a=e||t.length;if("function"==typeof TextDecoder&&TextDecoder.prototype.decode)return (new TextDecoder).decode(t.subarray(0,e));let i,n;const s=new Array(2*a);for(n=0,i=0;i<a;){let e=t[i++];if(e<128){s[n++]=e;continue}let r=Yt[e];if(r>4)s[n++]=65533,i+=r-1;else {for(e&=2===r?31:3===r?15:7;r>1&&i<a;)e=e<<6|63&t[i++],r--;r>1?s[n++]=65533:e<65536?s[n++]=e:(e-=65536,s[n++]=55296|e>>10&1023,s[n++]=56320|1023&e);}}return ((t,e)=>{if(e<65534&&t.subarray&&Pt)return String.fromCharCode.apply(null,t.length===e?t:t.subarray(0,e));let a="";for(let i=0;i<e;i++)a+=String.fromCharCode(t[i]);return a})(s,n)},Wt=(t,e)=>{(e=e||t.length)>t.length&&(e=t.length);let a=e-1;for(;a>=0&&128==(192&t[a]);)a--;return a<0||0===a?e:a+Yt[t[a]]>e?a:e};var qt=function(){this.input=null,this.next_in=0,this.avail_in=0,this.total_in=0,this.output=null,this.next_out=0,this.avail_out=0,this.total_out=0,this.msg="",this.state=null,this.data_type=2,this.adler=0;};const Jt=Object.prototype.toString,{Z_NO_FLUSH:Qt,Z_SYNC_FLUSH:Vt,Z_FULL_FLUSH:$t,Z_FINISH:te,Z_OK:ee,Z_STREAM_END:ae,Z_DEFAULT_COMPRESSION:ie,Z_DEFAULT_STRATEGY:ne,Z_DEFLATED:se}=K;function re(t){this.options=jt({level:ie,method:se,chunkSize:16384,windowBits:15,memLevel:8,strategy:ne},t||{});let e=this.options;e.raw&&e.windowBits>0?e.windowBits=-e.windowBits:e.gzip&&e.windowBits>0&&e.windowBits<16&&(e.windowBits+=16),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=Mt.deflateInit2(this.strm,e.level,e.method,e.windowBits,e.memLevel,e.strategy);if(a!==ee)throw new Error(j[a]);if(e.header&&Mt.deflateSetHeader(this.strm,e.header),e.dictionary){let t;if(t="string"==typeof e.dictionary?Gt(e.dictionary):"[object ArrayBuffer]"===Jt.call(e.dictionary)?new Uint8Array(e.dictionary):e.dictionary,a=Mt.deflateSetDictionary(this.strm,t),a!==ee)throw new Error(j[a]);this._dict_set=!0;}}function oe(t,e){const a=new re(e);if(a.push(t,!0),a.err)throw a.msg||j[a.err];return a.result}re.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize;let n,s;if(this.ended)return !1;for(s=e===~~e?e:!0===e?te:Qt,"string"==typeof t?a.input=Gt(t):"[object ArrayBuffer]"===Jt.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;)if(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),(s===Vt||s===$t)&&a.avail_out<=6)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else {if(n=Mt.deflate(a,s),n===ae)return a.next_out>0&&this.onData(a.output.subarray(0,a.next_out)),n=Mt.deflateEnd(this.strm),this.onEnd(n),this.ended=!0,n===ee;if(0!==a.avail_out){if(s>0&&a.next_out>0)this.onData(a.output.subarray(0,a.next_out)),a.avail_out=0;else if(0===a.avail_in)break}else this.onData(a.output);}return !0},re.prototype.onData=function(t){this.chunks.push(t);},re.prototype.onEnd=function(t){t===ee&&(this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg;};var le={Deflate:re,deflate:oe,deflateRaw:function(t,e){return (e=e||{}).raw=!0,oe(t,e)},gzip:function(t,e){return (e=e||{}).gzip=!0,oe(t,e)},constants:K};const he=16209;var de=function(t,e){let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z,A;const E=t.state;a=t.next_in,z=t.input,i=a+(t.avail_in-5),n=t.next_out,A=t.output,s=n-(e-t.avail_out),r=n+(t.avail_out-257),o=E.dmax,l=E.wsize,h=E.whave,d=E.wnext,_=E.window,f=E.hold,c=E.bits,u=E.lencode,w=E.distcode,m=(1<<E.lenbits)-1,b=(1<<E.distbits)-1;t:do{c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=u[f&m];e:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,0===p)A[n++]=65535&g;else {if(!(16&p)){if(0==(64&p)){g=u[(65535&g)+(f&(1<<p)-1)];continue e}if(32&p){E.mode=16191;break t}t.msg="invalid literal/length code",E.mode=he;break t}k=65535&g,p&=15,p&&(c<p&&(f+=z[a++]<<c,c+=8),k+=f&(1<<p)-1,f>>>=p,c-=p),c<15&&(f+=z[a++]<<c,c+=8,f+=z[a++]<<c,c+=8),g=w[f&b];a:for(;;){if(p=g>>>24,f>>>=p,c-=p,p=g>>>16&255,!(16&p)){if(0==(64&p)){g=w[(65535&g)+(f&(1<<p)-1)];continue a}t.msg="invalid distance code",E.mode=he;break t}if(v=65535&g,p&=15,c<p&&(f+=z[a++]<<c,c+=8,c<p&&(f+=z[a++]<<c,c+=8)),v+=f&(1<<p)-1,v>o){t.msg="invalid distance too far back",E.mode=he;break t}if(f>>>=p,c-=p,p=n-s,v>p){if(p=v-p,p>h&&E.sane){t.msg="invalid distance too far back",E.mode=he;break t}if(y=0,x=_,0===d){if(y+=l-p,p<k){k-=p;do{A[n++]=_[y++];}while(--p);y=n-v,x=A;}}else if(d<p){if(y+=l+d-p,p-=d,p<k){k-=p;do{A[n++]=_[y++];}while(--p);if(y=0,d<k){p=d,k-=p;do{A[n++]=_[y++];}while(--p);y=n-v,x=A;}}}else if(y+=d-p,p<k){k-=p;do{A[n++]=_[y++];}while(--p);y=n-v,x=A;}for(;k>2;)A[n++]=x[y++],A[n++]=x[y++],A[n++]=x[y++],k-=3;k&&(A[n++]=x[y++],k>1&&(A[n++]=x[y++]));}else {y=n-v;do{A[n++]=A[y++],A[n++]=A[y++],A[n++]=A[y++],k-=3;}while(k>2);k&&(A[n++]=A[y++],k>1&&(A[n++]=A[y++]));}break}}break}}while(a<i&&n<r);k=c>>3,a-=k,c-=k<<3,f&=(1<<c)-1,t.next_in=a,t.next_out=n,t.avail_in=a<i?i-a+5:5-(a-i),t.avail_out=n<r?r-n+257:257-(n-r),E.hold=f,E.bits=c;};const _e=15,fe=new Uint16Array([3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258,0,0]),ce=new Uint8Array([16,16,16,16,16,16,16,16,17,17,17,17,18,18,18,18,19,19,19,19,20,20,20,20,21,21,21,21,16,72,78]),ue=new Uint16Array([1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577,0,0]),we=new Uint8Array([16,16,16,16,17,17,18,18,19,19,20,20,21,21,22,22,23,23,24,24,25,25,26,26,27,27,28,28,29,29,64,64]);var me=(t,e,a,i,n,s,r,o)=>{const l=o.bits;let h,d,_,f,c,u,w=0,m=0,b=0,g=0,p=0,k=0,v=0,y=0,x=0,z=0,A=null;const E=new Uint16Array(16),R=new Uint16Array(16);let Z,U,S,D=null;for(w=0;w<=_e;w++)E[w]=0;for(m=0;m<i;m++)E[e[a+m]]++;for(p=l,g=_e;g>=1&&0===E[g];g--);if(p>g&&(p=g),0===g)return n[s++]=20971520,n[s++]=20971520,o.bits=1,0;for(b=1;b<g&&0===E[b];b++);for(p<b&&(p=b),y=1,w=1;w<=_e;w++)if(y<<=1,y-=E[w],y<0)return -1;if(y>0&&(0===t||1!==g))return -1;for(R[1]=0,w=1;w<_e;w++)R[w+1]=R[w]+E[w];for(m=0;m<i;m++)0!==e[a+m]&&(r[R[e[a+m]]++]=m);if(0===t?(A=D=r,u=20):1===t?(A=fe,D=ce,u=257):(A=ue,D=we,u=0),z=0,m=0,w=b,c=s,k=p,v=0,_=-1,x=1<<p,f=x-1,1===t&&x>852||2===t&&x>592)return 1;for(;;){Z=w-v,r[m]+1<u?(U=0,S=r[m]):r[m]>=u?(U=D[r[m]-u],S=A[r[m]-u]):(U=96,S=0),h=1<<w-v,d=1<<k,b=d;do{d-=h,n[c+(z>>v)+d]=Z<<24|U<<16|S|0;}while(0!==d);for(h=1<<w-1;z&h;)h>>=1;if(0!==h?(z&=h-1,z+=h):z=0,m++,0==--E[w]){if(w===g)break;w=e[a+r[m]];}if(w>p&&(z&f)!==_){for(0===v&&(v=p),c+=b,k=w-v,y=1<<k;k+v<g&&(y-=E[k+v],!(y<=0));)k++,y<<=1;if(x+=1<<k,1===t&&x>852||2===t&&x>592)return 1;_=z&f,n[_]=p<<24|k<<16|c-s|0;}}return 0!==z&&(n[c+z]=w-v<<24|64<<16|0),o.bits=p,0};const{Z_FINISH:be,Z_BLOCK:ge,Z_TREES:pe,Z_OK:ke,Z_STREAM_END:ve,Z_NEED_DICT:ye,Z_STREAM_ERROR:xe,Z_DATA_ERROR:ze,Z_MEM_ERROR:Ae,Z_BUF_ERROR:Ee,Z_DEFLATED:Re}=K,Ze=16180,Ue=16190,Se=16191,De=16192,Te=16194,Oe=16199,Ie=16200,Fe=16206,Le=16209,Ne=t=>(t>>>24&255)+(t>>>8&65280)+((65280&t)<<8)+((255&t)<<24);function Be(){this.strm=null,this.mode=0,this.last=!1,this.wrap=0,this.havedict=!1,this.flags=0,this.dmax=0,this.check=0,this.total=0,this.head=null,this.wbits=0,this.wsize=0,this.whave=0,this.wnext=0,this.window=null,this.hold=0,this.bits=0,this.length=0,this.offset=0,this.extra=0,this.lencode=null,this.distcode=null,this.lenbits=0,this.distbits=0,this.ncode=0,this.nlen=0,this.ndist=0,this.have=0,this.next=null,this.lens=new Uint16Array(320),this.work=new Uint16Array(288),this.lendyn=null,this.distdyn=null,this.sane=0,this.back=0,this.was=0;}const Ce=t=>{if(!t)return 1;const e=t.state;return !e||e.strm!==t||e.mode<Ze||e.mode>16211?1:0},Me=t=>{if(Ce(t))return xe;const e=t.state;return t.total_in=t.total_out=e.total=0,t.msg="",e.wrap&&(t.adler=1&e.wrap),e.mode=Ze,e.last=0,e.havedict=0,e.flags=-1,e.dmax=32768,e.head=null,e.hold=0,e.bits=0,e.lencode=e.lendyn=new Int32Array(852),e.distcode=e.distdyn=new Int32Array(592),e.sane=1,e.back=-1,ke},He=t=>{if(Ce(t))return xe;const e=t.state;return e.wsize=0,e.whave=0,e.wnext=0,Me(t)},je=(t,e)=>{let a;if(Ce(t))return xe;const i=t.state;return e<0?(a=0,e=-e):(a=5+(e>>4),e<48&&(e&=15)),e&&(e<8||e>15)?xe:(null!==i.window&&i.wbits!==e&&(i.window=null),i.wrap=a,i.wbits=e,He(t))},Ke=(t,e)=>{if(!t)return xe;const a=new Be;t.state=a,a.strm=t,a.window=null,a.mode=Ze;const i=je(t,e);return i!==ke&&(t.state=null),i};let Pe,Ye,Ge=!0;const Xe=t=>{if(Ge){Pe=new Int32Array(512),Ye=new Int32Array(32);let e=0;for(;e<144;)t.lens[e++]=8;for(;e<256;)t.lens[e++]=9;for(;e<280;)t.lens[e++]=7;for(;e<288;)t.lens[e++]=8;for(me(1,t.lens,0,288,Pe,0,t.work,{bits:9}),e=0;e<32;)t.lens[e++]=5;me(2,t.lens,0,32,Ye,0,t.work,{bits:5}),Ge=!1;}t.lencode=Pe,t.lenbits=9,t.distcode=Ye,t.distbits=5;},We=(t,e,a,i)=>{let n;const s=t.state;return null===s.window&&(s.wsize=1<<s.wbits,s.wnext=0,s.whave=0,s.window=new Uint8Array(s.wsize)),i>=s.wsize?(s.window.set(e.subarray(a-s.wsize,a),0),s.wnext=0,s.whave=s.wsize):(n=s.wsize-s.wnext,n>i&&(n=i),s.window.set(e.subarray(a-i,a-i+n),s.wnext),(i-=n)?(s.window.set(e.subarray(a-i,a),0),s.wnext=i,s.whave=s.wsize):(s.wnext+=n,s.wnext===s.wsize&&(s.wnext=0),s.whave<s.wsize&&(s.whave+=n))),0};var qe={inflateReset:He,inflateReset2:je,inflateResetKeep:Me,inflateInit:t=>Ke(t,15),inflateInit2:Ke,inflate:(t,e)=>{let a,i,n,s,r,o,l,h,d,_,f,c,u,w,m,b,g,p,k,v,y,x,z=0;const A=new Uint8Array(4);let E,R;const Z=new Uint8Array([16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]);if(Ce(t)||!t.output||!t.input&&0!==t.avail_in)return xe;a=t.state,a.mode===Se&&(a.mode=De),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,_=o,f=l,x=ke;t:for(;;)switch(a.mode){case Ze:if(0===a.wrap){a.mode=De;break}for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(2&a.wrap&&35615===h){0===a.wbits&&(a.wbits=15),a.check=0,A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0),h=0,d=0,a.mode=16181;break}if(a.head&&(a.head.done=!1),!(1&a.wrap)||(((255&h)<<8)+(h>>8))%31){t.msg="incorrect header check",a.mode=Le;break}if((15&h)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(h>>>=4,d-=4,y=8+(15&h),0===a.wbits&&(a.wbits=y),y>15||y>a.wbits){t.msg="invalid window size",a.mode=Le;break}a.dmax=1<<a.wbits,a.flags=0,t.adler=a.check=1,a.mode=512&h?16189:Se,h=0,d=0;break;case 16181:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(a.flags=h,(255&a.flags)!==Re){t.msg="unknown compression method",a.mode=Le;break}if(57344&a.flags){t.msg="unknown header flags set",a.mode=Le;break}a.head&&(a.head.text=h>>8&1),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16182;case 16182:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.head&&(a.head.time=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,A[2]=h>>>16&255,A[3]=h>>>24&255,a.check=H(a.check,A,4,0)),h=0,d=0,a.mode=16183;case 16183:for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.head&&(a.head.xflags=255&h,a.head.os=h>>8),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0,a.mode=16184;case 16184:if(1024&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.length=h,a.head&&(a.head.extra_len=h),512&a.flags&&4&a.wrap&&(A[0]=255&h,A[1]=h>>>8&255,a.check=H(a.check,A,2,0)),h=0,d=0;}else a.head&&(a.head.extra=null);a.mode=16185;case 16185:if(1024&a.flags&&(c=a.length,c>o&&(c=o),c&&(a.head&&(y=a.head.extra_len-a.length,a.head.extra||(a.head.extra=new Uint8Array(a.head.extra_len)),a.head.extra.set(i.subarray(s,s+c),y)),512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,a.length-=c),a.length))break t;a.length=0,a.mode=16186;case 16186:if(2048&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.name+=String.fromCharCode(y));}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.name=null);a.length=0,a.mode=16187;case 16187:if(4096&a.flags){if(0===o)break t;c=0;do{y=i[s+c++],a.head&&y&&a.length<65536&&(a.head.comment+=String.fromCharCode(y));}while(y&&c<o);if(512&a.flags&&4&a.wrap&&(a.check=H(a.check,i,c,s)),o-=c,s+=c,y)break t}else a.head&&(a.head.comment=null);a.mode=16188;case 16188:if(512&a.flags){for(;d<16;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(4&a.wrap&&h!==(65535&a.check)){t.msg="header crc mismatch",a.mode=Le;break}h=0,d=0;}a.head&&(a.head.hcrc=a.flags>>9&1,a.head.done=!0),t.adler=a.check=0,a.mode=Se;break;case 16189:for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}t.adler=a.check=Ne(h),h=0,d=0,a.mode=Ue;case Ue:if(0===a.havedict)return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,ye;t.adler=a.check=1,a.mode=Se;case Se:if(e===ge||e===pe)break t;case De:if(a.last){h>>>=7&d,d-=7&d,a.mode=Fe;break}for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}switch(a.last=1&h,h>>>=1,d-=1,3&h){case 0:a.mode=16193;break;case 1:if(Xe(a),a.mode=Oe,e===pe){h>>>=2,d-=2;break t}break;case 2:a.mode=16196;break;case 3:t.msg="invalid block type",a.mode=Le;}h>>>=2,d-=2;break;case 16193:for(h>>>=7&d,d-=7&d;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if((65535&h)!=(h>>>16^65535)){t.msg="invalid stored block lengths",a.mode=Le;break}if(a.length=65535&h,h=0,d=0,a.mode=Te,e===pe)break t;case Te:a.mode=16195;case 16195:if(c=a.length,c){if(c>o&&(c=o),c>l&&(c=l),0===c)break t;n.set(i.subarray(s,s+c),r),o-=c,s+=c,l-=c,r+=c,a.length-=c;break}a.mode=Se;break;case 16196:for(;d<14;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(a.nlen=257+(31&h),h>>>=5,d-=5,a.ndist=1+(31&h),h>>>=5,d-=5,a.ncode=4+(15&h),h>>>=4,d-=4,a.nlen>286||a.ndist>30){t.msg="too many length or distance symbols",a.mode=Le;break}a.have=0,a.mode=16197;case 16197:for(;a.have<a.ncode;){for(;d<3;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.lens[Z[a.have++]]=7&h,h>>>=3,d-=3;}for(;a.have<19;)a.lens[Z[a.have++]]=0;if(a.lencode=a.lendyn,a.lenbits=7,E={bits:a.lenbits},x=me(0,a.lens,0,19,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid code lengths set",a.mode=Le;break}a.have=0,a.mode=16198;case 16198:for(;a.have<a.nlen+a.ndist;){for(;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(g<16)h>>>=m,d-=m,a.lens[a.have++]=g;else {if(16===g){for(R=m+2;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(h>>>=m,d-=m,0===a.have){t.msg="invalid bit length repeat",a.mode=Le;break}y=a.lens[a.have-1],c=3+(3&h),h>>>=2,d-=2;}else if(17===g){for(R=m+3;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}h>>>=m,d-=m,y=0,c=3+(7&h),h>>>=3,d-=3;}else {for(R=m+7;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}h>>>=m,d-=m,y=0,c=11+(127&h),h>>>=7,d-=7;}if(a.have+c>a.nlen+a.ndist){t.msg="invalid bit length repeat",a.mode=Le;break}for(;c--;)a.lens[a.have++]=y;}}if(a.mode===Le)break;if(0===a.lens[256]){t.msg="invalid code -- missing end-of-block",a.mode=Le;break}if(a.lenbits=9,E={bits:a.lenbits},x=me(1,a.lens,0,a.nlen,a.lencode,0,a.work,E),a.lenbits=E.bits,x){t.msg="invalid literal/lengths set",a.mode=Le;break}if(a.distbits=6,a.distcode=a.distdyn,E={bits:a.distbits},x=me(2,a.lens,a.nlen,a.ndist,a.distcode,0,a.work,E),a.distbits=E.bits,x){t.msg="invalid distances set",a.mode=Le;break}if(a.mode=Oe,e===pe)break t;case Oe:a.mode=Ie;case Ie:if(o>=6&&l>=258){t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,de(t,f),r=t.next_out,n=t.output,l=t.avail_out,s=t.next_in,i=t.input,o=t.avail_in,h=a.hold,d=a.bits,a.mode===Se&&(a.back=-1);break}for(a.back=0;z=a.lencode[h&(1<<a.lenbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(b&&0==(240&b)){for(p=m,k=b,v=g;z=a.lencode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}h>>>=p,d-=p,a.back+=p;}if(h>>>=m,d-=m,a.back+=m,a.length=g,0===b){a.mode=16205;break}if(32&b){a.back=-1,a.mode=Se;break}if(64&b){t.msg="invalid literal/length code",a.mode=Le;break}a.extra=15&b,a.mode=16201;case 16201:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.length+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra;}a.was=a.length,a.mode=16202;case 16202:for(;z=a.distcode[h&(1<<a.distbits)-1],m=z>>>24,b=z>>>16&255,g=65535&z,!(m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(0==(240&b)){for(p=m,k=b,v=g;z=a.distcode[v+((h&(1<<p+k)-1)>>p)],m=z>>>24,b=z>>>16&255,g=65535&z,!(p+m<=d);){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}h>>>=p,d-=p,a.back+=p;}if(h>>>=m,d-=m,a.back+=m,64&b){t.msg="invalid distance code",a.mode=Le;break}a.offset=g,a.extra=15&b,a.mode=16203;case 16203:if(a.extra){for(R=a.extra;d<R;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}a.offset+=h&(1<<a.extra)-1,h>>>=a.extra,d-=a.extra,a.back+=a.extra;}if(a.offset>a.dmax){t.msg="invalid distance too far back",a.mode=Le;break}a.mode=16204;case 16204:if(0===l)break t;if(c=f-l,a.offset>c){if(c=a.offset-c,c>a.whave&&a.sane){t.msg="invalid distance too far back",a.mode=Le;break}c>a.wnext?(c-=a.wnext,u=a.wsize-c):u=a.wnext-c,c>a.length&&(c=a.length),w=a.window;}else w=n,u=r-a.offset,c=a.length;c>l&&(c=l),l-=c,a.length-=c;do{n[r++]=w[u++];}while(--c);0===a.length&&(a.mode=Ie);break;case 16205:if(0===l)break t;n[r++]=a.length,l--,a.mode=Ie;break;case Fe:if(a.wrap){for(;d<32;){if(0===o)break t;o--,h|=i[s++]<<d,d+=8;}if(f-=l,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,r-f):C(a.check,n,f,r-f)),f=l,4&a.wrap&&(a.flags?h:Ne(h))!==a.check){t.msg="incorrect data check",a.mode=Le;break}h=0,d=0;}a.mode=16207;case 16207:if(a.wrap&&a.flags){for(;d<32;){if(0===o)break t;o--,h+=i[s++]<<d,d+=8;}if(4&a.wrap&&h!==(4294967295&a.total)){t.msg="incorrect length check",a.mode=Le;break}h=0,d=0;}a.mode=16208;case 16208:x=ve;break t;case Le:x=ze;break t;case 16210:return Ae;default:return xe}return t.next_out=r,t.avail_out=l,t.next_in=s,t.avail_in=o,a.hold=h,a.bits=d,(a.wsize||f!==t.avail_out&&a.mode<Le&&(a.mode<Fe||e!==be))&&We(t,t.output,t.next_out,f-t.avail_out),_-=t.avail_in,f-=t.avail_out,t.total_in+=_,t.total_out+=f,a.total+=f,4&a.wrap&&f&&(t.adler=a.check=a.flags?H(a.check,n,f,t.next_out-f):C(a.check,n,f,t.next_out-f)),t.data_type=a.bits+(a.last?64:0)+(a.mode===Se?128:0)+(a.mode===Oe||a.mode===Te?256:0),(0===_&&0===f||e===be)&&x===ke&&(x=Ee),x},inflateEnd:t=>{if(Ce(t))return xe;let e=t.state;return e.window&&(e.window=null),t.state=null,ke},inflateGetHeader:(t,e)=>{if(Ce(t))return xe;const a=t.state;return 0==(2&a.wrap)?xe:(a.head=e,e.done=!1,ke)},inflateSetDictionary:(t,e)=>{const a=e.length;let i,n,s;return Ce(t)?xe:(i=t.state,0!==i.wrap&&i.mode!==Ue?xe:i.mode===Ue&&(n=1,n=C(n,e,a,0),n!==i.check)?ze:(s=We(t,e,a,a),s?(i.mode=16210,Ae):(i.havedict=1,ke)))},inflateInfo:"pako inflate (from Nodeca project)"};var Je=function(){this.text=0,this.time=0,this.xflags=0,this.os=0,this.extra=null,this.extra_len=0,this.name="",this.comment="",this.hcrc=0,this.done=!1;};const Qe=Object.prototype.toString,{Z_NO_FLUSH:Ve,Z_FINISH:$e,Z_OK:ta,Z_STREAM_END:ea,Z_NEED_DICT:aa,Z_STREAM_ERROR:ia,Z_DATA_ERROR:na,Z_MEM_ERROR:sa}=K;function ra(t){this.options=jt({chunkSize:65536,windowBits:15,to:""},t||{});const e=this.options;e.raw&&e.windowBits>=0&&e.windowBits<16&&(e.windowBits=-e.windowBits,0===e.windowBits&&(e.windowBits=-15)),!(e.windowBits>=0&&e.windowBits<16)||t&&t.windowBits||(e.windowBits+=32),e.windowBits>15&&e.windowBits<48&&0==(15&e.windowBits)&&(e.windowBits|=15),this.err=0,this.msg="",this.ended=!1,this.chunks=[],this.strm=new qt,this.strm.avail_out=0;let a=qe.inflateInit2(this.strm,e.windowBits);if(a!==ta)throw new Error(j[a]);if(this.header=new Je,qe.inflateGetHeader(this.strm,this.header),e.dictionary&&("string"==typeof e.dictionary?e.dictionary=Gt(e.dictionary):"[object ArrayBuffer]"===Qe.call(e.dictionary)&&(e.dictionary=new Uint8Array(e.dictionary)),e.raw&&(a=qe.inflateSetDictionary(this.strm,e.dictionary),a!==ta)))throw new Error(j[a])}function oa(t,e){const a=new ra(e);if(a.push(t),a.err)throw a.msg||j[a.err];return a.result}ra.prototype.push=function(t,e){const a=this.strm,i=this.options.chunkSize,n=this.options.dictionary;let s,r,o;if(this.ended)return !1;for(r=e===~~e?e:!0===e?$e:Ve,"[object ArrayBuffer]"===Qe.call(t)?a.input=new Uint8Array(t):a.input=t,a.next_in=0,a.avail_in=a.input.length;;){for(0===a.avail_out&&(a.output=new Uint8Array(i),a.next_out=0,a.avail_out=i),s=qe.inflate(a,r),s===aa&&n&&(s=qe.inflateSetDictionary(a,n),s===ta?s=qe.inflate(a,r):s===na&&(s=aa));a.avail_in>0&&s===ea&&a.state.wrap>0&&0!==t[a.next_in];)qe.inflateReset(a),s=qe.inflate(a,r);switch(s){case ia:case na:case aa:case sa:return this.onEnd(s),this.ended=!0,!1}if(o=a.avail_out,a.next_out&&(0===a.avail_out||s===ea))if("string"===this.options.to){let t=Wt(a.output,a.next_out),e=a.next_out-t,n=Xt(a.output,t);a.next_out=e,a.avail_out=i-e,e&&a.output.set(a.output.subarray(t,t+e),0),this.onData(n);}else this.onData(a.output.length===a.next_out?a.output:a.output.subarray(0,a.next_out));if(s!==ta||0!==o){if(s===ea)return s=qe.inflateEnd(this.strm),this.onEnd(s),this.ended=!0,!0;if(0===a.avail_in)break}}return !0},ra.prototype.onData=function(t){this.chunks.push(t);},ra.prototype.onEnd=function(t){t===ta&&("string"===this.options.to?this.result=this.chunks.join(""):this.result=Kt(this.chunks)),this.chunks=[],this.err=t,this.msg=this.strm.msg;};var la={Inflate:ra,inflate:oa,inflateRaw:function(t,e){return (e=e||{}).raw=!0,oa(t,e)},ungzip:oa,constants:K};const{Deflate:ha,deflate:da,deflateRaw:_a,gzip:fa}=le,{Inflate:ca,inflate:ua,inflateRaw:wa,ungzip:ma}=la;var ba=ha,ga=da,pa=_a,ka=fa,va=ca,ya=ua,xa=wa,za=ma,Aa=K,Ea={Deflate:ba,deflate:ga,deflateRaw:pa,gzip:ka,Inflate:va,inflate:ya,inflateRaw:xa,ungzip:za,constants:Aa};t.Deflate=ba,t.Inflate=va,t.constants=Aa,t.default=Ea,t.deflate=ga,t.deflateRaw=pa,t.gzip=ka,t.inflate=ya,t.inflateRaw=xa,t.ungzip=za,Object.defineProperty(t,"__esModule",{value:!0});}));

    var p = /*#__PURE__*/Object.freeze({
        __proto__: null
    });

    /*

     Parser for .XKT Format V1

    .XKT specifications: https://github.com/xeokit/xeokit-sdk/wiki/XKT-Format

     DEPRECATED

     */

    let pako$9 = window.pako || p;
    if (!pako$9.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$9 = pako$9.default;
    }

    const decompressColor$9 = (function () {
        const color2 = new Float32Array(3);
        return function (color) {
            color2[0] = color[0] / 255.0;
            color2[1] = color[1] / 255.0;
            color2[2] = color[2] / 255.0;
            return color2;
        };
    })();

    function extract$9(elements) {
        return {
            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],
            meshPositions: elements[4],
            meshIndices: elements[5],
            meshEdgesIndices: elements[6],
            meshColors: elements[7],
            entityIDs: elements[8],
            entityMeshes: elements[9],
            entityIsObjects: elements[10],
            positionsDecodeMatrix: elements[11]
        };
    }

    function inflate$9(deflatedData) {
        return {
            positions: new Uint16Array(pako$9.inflate(deflatedData.positions).buffer),
            normals: new Int8Array(pako$9.inflate(deflatedData.normals).buffer),
            indices: new Uint32Array(pako$9.inflate(deflatedData.indices).buffer),
            edgeIndices: new Uint32Array(pako$9.inflate(deflatedData.edgeIndices).buffer),
            meshPositions: new Uint32Array(pako$9.inflate(deflatedData.meshPositions).buffer),
            meshIndices: new Uint32Array(pako$9.inflate(deflatedData.meshIndices).buffer),
            meshEdgesIndices: new Uint32Array(pako$9.inflate(deflatedData.meshEdgesIndices).buffer),
            meshColors: new Uint8Array(pako$9.inflate(deflatedData.meshColors).buffer),
            entityIDs: pako$9.inflate(deflatedData.entityIDs, {to: 'string'}),
            entityMeshes: new Uint32Array(pako$9.inflate(deflatedData.entityMeshes).buffer),
            entityIsObjects: new Uint8Array(pako$9.inflate(deflatedData.entityIsObjects).buffer),
            positionsDecodeMatrix: new Float32Array(pako$9.inflate(deflatedData.positionsDecodeMatrix).buffer)
        };
    }

    function load$9(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        manifestCtx.getNextId();

        sceneModel.positionsCompression = "precompressed";
        sceneModel.normalsCompression = "precompressed";

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const meshPositions = inflatedData.meshPositions;
        const meshIndices = inflatedData.meshIndices;
        const meshEdgesIndices = inflatedData.meshEdgesIndices;
        const meshColors = inflatedData.meshColors;
        const entityIDs = JSON.parse(inflatedData.entityIDs);
        const entityMeshes = inflatedData.entityMeshes;
        const entityIsObjects = inflatedData.entityIsObjects;
        const numMeshes = meshPositions.length;
        const numEntities = entityMeshes.length;

        for (let i = 0; i < numEntities; i++) {

            const xktEntityId = entityIDs [i];
            const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;
            // @reviser lijuhong 修改获取metaObject代码
            const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
            const entityDefaults = {};
            const meshDefaults = {};

            if (metaObject) {

                if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                    continue;
                }

                if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                    continue;
                }

                const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                if (props) {
                    if (props.visible === false) {
                        entityDefaults.visible = false;
                    }
                    if (props.pickable === false) {
                        entityDefaults.pickable = false;
                    }
                    if (props.colorize) {
                        meshDefaults.color = props.colorize;
                    }
                    if (props.opacity !== undefined && props.opacity !== null) {
                        meshDefaults.opacity = props.opacity;
                    }
                }
            } else {
                if (options.excludeUnclassifiedObjects) {
                    continue;
                }
            }

            const lastEntity = (i === numEntities - 1);
            const meshIds = [];

            for (let j = entityMeshes [i], jlen = lastEntity ? entityMeshes.length : entityMeshes [i + 1]; j < jlen; j++) {

                const lastMesh = (j === (numMeshes - 1));
                const meshId = entityId + ".mesh." + j;

                const color = decompressColor$9(meshColors.subarray((j * 4), (j * 4) + 3));
                const opacity = meshColors[(j * 4) + 3] / 255.0;

                sceneModel.createMesh(utils.apply(meshDefaults, {
                    id: meshId,
                    primitive: "triangles",
                    positionsCompressed: positions.subarray(meshPositions [j], lastMesh ? positions.length : meshPositions [j + 1]),
                    normalsCompressed: normals.subarray(meshPositions [j], lastMesh ? positions.length : meshPositions [j + 1]),
                    indices: indices.subarray(meshIndices [j], lastMesh ? indices.length : meshIndices [j + 1]),
                    edgeIndices: edgeIndices.subarray(meshEdgesIndices [j], lastMesh ? edgeIndices.length : meshEdgesIndices [j + 1]),
                    positionsDecodeMatrix: inflatedData.positionsDecodeMatrix,
                    color: color,
                    opacity: opacity
                }));

                meshIds.push(meshId);
            }

            sceneModel.createEntity(utils.apply(entityDefaults, {
                id: entityId,
                isObject: (entityIsObjects [i] === 1),
                meshIds: meshIds
            }));
        }
    }

    /** @private */
    const ParserV1 = {
        version: 1,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$9(elements);
            const inflatedData = inflate$9(deflatedData);
            load$9(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

    Parser for .XKT Format V2

    DEPRECATED

    .XKT specifications: https://github.com/xeokit/xeokit-sdk/wiki/XKT-Format

     */

    let pako$8 = window.pako || p;
    if (!pako$8.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$8 = pako$8.default;
    }

    function extract$8(elements) {
        return {

            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],

            meshPositions: elements[4],
            meshIndices: elements[5],
            meshEdgesIndices: elements[6],
            meshColors: elements[7],

            entityIDs: elements[8],
            entityMeshes: elements[9],
            entityIsObjects: elements[10],

            positionsDecodeMatrix: elements[11],

            entityMeshIds: elements[12],
            entityMatrices: elements[13],
            entityUsesInstancing: elements[14]
        };
    }

    function inflate$8(deflatedData) {
        return {
            positions: new Uint16Array(pako$8.inflate(deflatedData.positions).buffer),
            normals: new Int8Array(pako$8.inflate(deflatedData.normals).buffer),
            indices: new Uint32Array(pako$8.inflate(deflatedData.indices).buffer),
            edgeIndices: new Uint32Array(pako$8.inflate(deflatedData.edgeIndices).buffer),

            meshPositions: new Uint32Array(pako$8.inflate(deflatedData.meshPositions).buffer),
            meshIndices: new Uint32Array(pako$8.inflate(deflatedData.meshIndices).buffer),
            meshEdgesIndices: new Uint32Array(pako$8.inflate(deflatedData.meshEdgesIndices).buffer),
            meshColors: new Uint8Array(pako$8.inflate(deflatedData.meshColors).buffer),

            entityIDs: pako$8.inflate(deflatedData.entityIDs, {to: 'string'}),
            entityMeshes: new Uint32Array(pako$8.inflate(deflatedData.entityMeshes).buffer),
            entityIsObjects: new Uint8Array(pako$8.inflate(deflatedData.entityIsObjects).buffer),

            positionsDecodeMatrix: new Float32Array(pako$8.inflate(deflatedData.positionsDecodeMatrix).buffer),

            entityMeshIds: new Uint32Array(pako$8.inflate(deflatedData.entityMeshIds).buffer),
            entityMatrices: new Float32Array(pako$8.inflate(deflatedData.entityMatrices).buffer),
            entityUsesInstancing: new Uint8Array(pako$8.inflate(deflatedData.entityUsesInstancing).buffer)
        };
    }

    const decompressColor$8 = (function () {
        const color2 = new Float32Array(3);
        return function (color) {
            color2[0] = color[0] / 255.0;
            color2[1] = color[1] / 255.0;
            color2[2] = color[2] / 255.0;
            return color2;
        };
    })();

    function load$8(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        sceneModel.positionsCompression = "precompressed";
        sceneModel.normalsCompression = "precompressed";

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const meshPositions = inflatedData.meshPositions;
        const meshIndices = inflatedData.meshIndices;
        const meshEdgesIndices = inflatedData.meshEdgesIndices;
        const meshColors = inflatedData.meshColors;
        const entityIDs = JSON.parse(inflatedData.entityIDs);
        const entityMeshes = inflatedData.entityMeshes;
        const entityIsObjects = inflatedData.entityIsObjects;
        const entityMeshIds = inflatedData.entityMeshIds;
        const entityMatrices = inflatedData.entityMatrices;
        const entityUsesInstancing = inflatedData.entityUsesInstancing;

        const numMeshes = meshPositions.length;
        const numEntities = entityMeshes.length;

        const alreadyCreatedGeometries = {};

        for (let i = 0; i < numEntities; i++) {

            const xktEntityId = entityIDs [i];
            const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;
            // @reviser lijuhong 修改获取metaObject代码
            const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
            const entityDefaults = {};
            const meshDefaults = {};
            const entityMatrix = entityMatrices.subarray((i * 16), (i * 16) + 16);

            if (metaObject) {
                if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                    continue;
                }
                if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                    continue;
                }
                const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;
                if (props) {
                    if (props.visible === false) {
                        entityDefaults.visible = false;
                    }
                    if (props.pickable === false) {
                        entityDefaults.pickable = false;
                    }
                    if (props.colorize) {
                        meshDefaults.color = props.colorize;
                    }
                    if (props.opacity !== undefined && props.opacity !== null) {
                        meshDefaults.opacity = props.opacity;
                    }
                }
            } else {
                if (options.excludeUnclassifiedObjects) {
                    continue;
                }
            }

            const lastEntity = (i === numEntities - 1);

            const meshIds = [];

            for (let j = entityMeshes [i], jlen = lastEntity ? entityMeshIds.length : entityMeshes [i + 1]; j < jlen; j++) {

                const jj = entityMeshIds [j];

                const lastMesh = (jj === (numMeshes - 1));
                const meshId = manifestCtx.getNextId();

                const color = decompressColor$8(meshColors.subarray((jj * 4), (jj * 4) + 3));
                const opacity = meshColors[(jj * 4) + 3] / 255.0;

                const tmpPositions = positions.subarray(meshPositions [jj], lastMesh ? positions.length : meshPositions [jj + 1]);
                const tmpNormals = normals.subarray(meshPositions [jj], lastMesh ? positions.length : meshPositions [jj + 1]);
                const tmpIndices = indices.subarray(meshIndices [jj], lastMesh ? indices.length : meshIndices [jj + 1]);
                const tmpEdgeIndices = edgeIndices.subarray(meshEdgesIndices [jj], lastMesh ? edgeIndices.length : meshEdgesIndices [jj + 1]);

                if (entityUsesInstancing [i] === 1) {

                    const geometryId = `${modelPartId}.geometry.${meshId}.${jj}`;

                    if (!(geometryId in alreadyCreatedGeometries)) {

                        sceneModel.createGeometry({
                            id: geometryId,
                            positionsCompressed: tmpPositions,
                            normalsCompressed: tmpNormals,
                            indices: tmpIndices,
                            edgeIndices: tmpEdgeIndices,
                            primitive: "triangles",
                            positionsDecodeMatrix: inflatedData.positionsDecodeMatrix,
                        });

                        alreadyCreatedGeometries [geometryId] = true;
                    }

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        color: color,
                        opacity: opacity,
                        matrix: entityMatrix,
                        geometryId,
                    }));

                    meshIds.push(meshId);

                } else {

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        primitive: "triangles",
                        positionsCompressed: tmpPositions,
                        normalsCompressed: tmpNormals,
                        indices: tmpIndices,
                        edgeIndices: tmpEdgeIndices,
                        positionsDecodeMatrix: inflatedData.positionsDecodeMatrix,
                        color: color,
                        opacity: opacity
                    }));

                    meshIds.push(meshId);
                }
            }

            if (meshIds.length) {

                sceneModel.createEntity(utils.apply(entityDefaults, {
                    id: entityId,
                    isObject: (entityIsObjects [i] === 1),
                    meshIds: meshIds
                }));
            }
        }
    }

    /** @private */
    const ParserV2 = {
        version: 2,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$8(elements);
            const inflatedData = inflate$8(deflatedData);
            load$8(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

    Parser for .XKT Format V3

    .XKT specifications: https://github.com/xeokit/xeokit-sdk/wiki/XKT-Format

     */

    let pako$7 = window.pako || p;
    if (!pako$7.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$7 = pako$7.default;
    }

    function extract$7(elements) {
        return {
            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],
            meshPositions: elements[4],
            meshIndices: elements[5],
            meshEdgesIndices: elements[6],
            meshColors: elements[7],
            entityIDs: elements[8],
            entityMeshes: elements[9],
            entityIsObjects: elements[10],
            instancedPositionsDecodeMatrix: elements[11],
            batchedPositionsDecodeMatrix: elements[12],
            entityMeshIds: elements[13],
            entityMatrices: elements[14],
            entityUsesInstancing: elements[15]
        };
    }

    function inflate$7(deflatedData) {
        return {
            positions: new Uint16Array(pako$7.inflate(deflatedData.positions).buffer),
            normals: new Int8Array(pako$7.inflate(deflatedData.normals).buffer),
            indices: new Uint32Array(pako$7.inflate(deflatedData.indices).buffer),
            edgeIndices: new Uint32Array(pako$7.inflate(deflatedData.edgeIndices).buffer),
            meshPositions: new Uint32Array(pako$7.inflate(deflatedData.meshPositions).buffer),
            meshIndices: new Uint32Array(pako$7.inflate(deflatedData.meshIndices).buffer),
            meshEdgesIndices: new Uint32Array(pako$7.inflate(deflatedData.meshEdgesIndices).buffer),
            meshColors: new Uint8Array(pako$7.inflate(deflatedData.meshColors).buffer),
            entityIDs: pako$7.inflate(deflatedData.entityIDs, {to: 'string'}),
            entityMeshes: new Uint32Array(pako$7.inflate(deflatedData.entityMeshes).buffer),
            entityIsObjects: new Uint8Array(pako$7.inflate(deflatedData.entityIsObjects).buffer),
            instancedPositionsDecodeMatrix: new Float32Array(pako$7.inflate(deflatedData.instancedPositionsDecodeMatrix).buffer),
            batchedPositionsDecodeMatrix: new Float32Array(pako$7.inflate(deflatedData.batchedPositionsDecodeMatrix).buffer),
            entityMeshIds: new Uint32Array(pako$7.inflate(deflatedData.entityMeshIds).buffer),
            entityMatrices: new Float32Array(pako$7.inflate(deflatedData.entityMatrices).buffer),
            entityUsesInstancing: new Uint8Array(pako$7.inflate(deflatedData.entityUsesInstancing).buffer)
        };
    }

    const decompressColor$7 = (function () {
        const color2 = new Float32Array(3);
        return function (color) {
            color2[0] = color[0] / 255.0;
            color2[1] = color[1] / 255.0;
            color2[2] = color[2] / 255.0;
            return color2;
        };
    })();

    function load$7(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        sceneModel.positionsCompression = "precompressed";
        sceneModel.normalsCompression = "precompressed";

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const meshPositions = inflatedData.meshPositions;
        const meshIndices = inflatedData.meshIndices;
        const meshEdgesIndices = inflatedData.meshEdgesIndices;
        const meshColors = inflatedData.meshColors;
        const entityIDs = JSON.parse(inflatedData.entityIDs);
        const entityMeshes = inflatedData.entityMeshes;
        const entityIsObjects = inflatedData.entityIsObjects;
        const entityMeshIds = inflatedData.entityMeshIds;
        const entityMatrices = inflatedData.entityMatrices;
        const entityUsesInstancing = inflatedData.entityUsesInstancing;

        const numMeshes = meshPositions.length;
        const numEntities = entityMeshes.length;

        const _alreadyCreatedGeometries = {};

        for (let i = 0; i < numEntities; i++) {

            const xktEntityId = entityIDs [i];
            const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;
            // @reviser lijuhong 修改获取metaObject代码
            const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
            const entityDefaults = {};
            const meshDefaults = {};
            const entityMatrix = entityMatrices.subarray((i * 16), (i * 16) + 16);

            if (metaObject) {

                if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                    continue;
                }

                if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                    continue;
                }

                const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                if (props) {
                    if (props.visible === false) {
                        entityDefaults.visible = false;
                    }
                    if (props.pickable === false) {
                        entityDefaults.pickable = false;
                    }
                    if (props.colorize) {
                        meshDefaults.color = props.colorize;
                    }
                    if (props.opacity !== undefined && props.opacity !== null) {
                        meshDefaults.opacity = props.opacity;
                    }
                }
            } else {
                if (options.excludeUnclassifiedObjects) {
                    continue;
                }
            }

            const lastEntity = (i === numEntities - 1);

            const meshIds = [];

            for (let j = entityMeshes [i], jlen = lastEntity ? entityMeshIds.length : entityMeshes [i + 1]; j < jlen; j++) {
                var jj = entityMeshIds [j];

                const lastMesh = (jj === (numMeshes - 1));
                const meshId = `${modelPartId}.${entityId}.mesh.${jj}`;

                const color = decompressColor$7(meshColors.subarray((jj * 4), (jj * 4) + 3));
                const opacity = meshColors[(jj * 4) + 3] / 255.0;

                var tmpPositions = positions.subarray(meshPositions [jj], lastMesh ? positions.length : meshPositions [jj + 1]);
                var tmpNormals = normals.subarray(meshPositions [jj], lastMesh ? positions.length : meshPositions [jj + 1]);
                var tmpIndices = indices.subarray(meshIndices [jj], lastMesh ? indices.length : meshIndices [jj + 1]);
                var tmpEdgeIndices = edgeIndices.subarray(meshEdgesIndices [jj], lastMesh ? edgeIndices.length : meshEdgesIndices [jj + 1]);

                if (entityUsesInstancing [i] === 1) {

                    const geometryId = `${modelPartId}.geometry.${meshId}.${jj}`;

                    if (!(geometryId in _alreadyCreatedGeometries)) {

                        sceneModel.createGeometry({
                            id: geometryId,
                            positionsCompressed: tmpPositions,
                            normalsCompressed: tmpNormals,
                            indices: tmpIndices,
                            edgeIndices: tmpEdgeIndices,
                            primitive: "triangles",
                            positionsDecodeMatrix: inflatedData.instancedPositionsDecodeMatrix
                        });

                        _alreadyCreatedGeometries [geometryId] = true;
                    }

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        color: color,
                        opacity: opacity,
                        matrix: entityMatrix,
                        geometryId,
                    }));

                    meshIds.push(meshId);

                } else {

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        primitive: "triangles",
                        positionsCompressed: tmpPositions,
                        normalsCompressed: tmpNormals,
                        indices: tmpIndices,
                        edgeIndices: tmpEdgeIndices,
                        positionsDecodeMatrix: inflatedData.batchedPositionsDecodeMatrix,
                        color: color,
                        opacity: opacity
                    }));

                    meshIds.push(meshId);
                }
            }

            if (meshIds.length) {
                sceneModel.createEntity(utils.apply(entityDefaults, {
                    id: entityId,
                    isObject: (entityIsObjects [i] === 1),
                    meshIds: meshIds
                }));
            }
        }
    }

    /** @private */
    const ParserV3 = {
        version: 3,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$7(elements);
            const inflatedData = inflate$7(deflatedData);
            load$7(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

    Parser for .XKT Format V4

    .XKT specifications: https://github.com/xeokit/xeokit-sdk/wiki/XKT-Format

     */

    let pako$6 = window.pako || p;
    if (!pako$6.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$6 = pako$6.default;
    }

    function extract$6(elements) {
        return {
            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],
            decodeMatrices: elements[4],
            matrices: elements[5],
            eachPrimitivePositionsAndNormalsPortion: elements[6],
            eachPrimitiveIndicesPortion: elements[7],
            eachPrimitiveEdgeIndicesPortion: elements[8],
            eachPrimitiveDecodeMatricesPortion: elements[9],
            eachPrimitiveColor: elements[10],
            primitiveInstances: elements[11],
            eachEntityId: elements[12],
            eachEntityPrimitiveInstancesPortion: elements[13],
            eachEntityMatricesPortion: elements[14],
            eachEntityMatrix: elements[15]
        };
    }

    function inflate$6(deflatedData) {
        return {
            positions: new Uint16Array(pako$6.inflate(deflatedData.positions).buffer),
            normals: new Int8Array(pako$6.inflate(deflatedData.normals).buffer),
            indices: new Uint32Array(pako$6.inflate(deflatedData.indices).buffer),
            edgeIndices: new Uint32Array(pako$6.inflate(deflatedData.edgeIndices).buffer),
            decodeMatrices: new Float32Array(pako$6.inflate(deflatedData.decodeMatrices).buffer),
            matrices: new Float32Array(pako$6.inflate(deflatedData.matrices).buffer),
            eachPrimitivePositionsAndNormalsPortion: new Uint32Array(pako$6.inflate(deflatedData.eachPrimitivePositionsAndNormalsPortion).buffer),
            eachPrimitiveIndicesPortion: new Uint32Array(pako$6.inflate(deflatedData.eachPrimitiveIndicesPortion).buffer),
            eachPrimitiveEdgeIndicesPortion: new Uint32Array(pako$6.inflate(deflatedData.eachPrimitiveEdgeIndicesPortion).buffer),
            eachPrimitiveDecodeMatricesPortion: new Uint32Array(pako$6.inflate(deflatedData.eachPrimitiveDecodeMatricesPortion).buffer),
            eachPrimitiveColor: new Uint8Array(pako$6.inflate(deflatedData.eachPrimitiveColor).buffer),
            primitiveInstances: new Uint32Array(pako$6.inflate(deflatedData.primitiveInstances).buffer),
            eachEntityId: pako$6.inflate(deflatedData.eachEntityId, {to: 'string'}),
            eachEntityPrimitiveInstancesPortion: new Uint32Array(pako$6.inflate(deflatedData.eachEntityPrimitiveInstancesPortion).buffer),
            eachEntityMatricesPortion: new Uint32Array(pako$6.inflate(deflatedData.eachEntityMatricesPortion).buffer)
        };
    }

    const decompressColor$6 = (function () {
        const color2 = new Float32Array(3);
        return function (color) {
            color2[0] = color[0] / 255.0;
            color2[1] = color[1] / 255.0;
            color2[2] = color[2] / 255.0;
            return color2;
        };
    })();

    function load$6(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        sceneModel.positionsCompression = "precompressed";
        sceneModel.normalsCompression = "precompressed";

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const decodeMatrices = inflatedData.decodeMatrices;
        const matrices = inflatedData.matrices;

        const eachPrimitivePositionsAndNormalsPortion = inflatedData.eachPrimitivePositionsAndNormalsPortion;
        const eachPrimitiveIndicesPortion = inflatedData.eachPrimitiveIndicesPortion;
        const eachPrimitiveEdgeIndicesPortion = inflatedData.eachPrimitiveEdgeIndicesPortion;
        const eachPrimitiveDecodeMatricesPortion = inflatedData.eachPrimitiveDecodeMatricesPortion;
        const eachPrimitiveColor = inflatedData.eachPrimitiveColor;

        const primitiveInstances = inflatedData.primitiveInstances;

        const eachEntityId = JSON.parse(inflatedData.eachEntityId);
        const eachEntityPrimitiveInstancesPortion = inflatedData.eachEntityPrimitiveInstancesPortion;
        const eachEntityMatricesPortion = inflatedData.eachEntityMatricesPortion;

        const numPrimitives = eachPrimitivePositionsAndNormalsPortion.length;
        const numPrimitiveInstances = primitiveInstances.length;
        const primitiveInstanceCounts = new Uint8Array(numPrimitives); // For each mesh, how many times it is instanced
        const orderedPrimitiveIndexes = new Uint32Array(numPrimitives); // For each mesh, its index sorted into runs that share the same decode matrix

        const numEntities = eachEntityId.length;

        // Get lookup that orders primitives into runs that share the same decode matrices;
        // this is used to create meshes in batches that use the same decode matrix

        for (let primitiveIndex = 0; primitiveIndex < numPrimitives; primitiveIndex++) {
            orderedPrimitiveIndexes[primitiveIndex] = primitiveIndex;
        }

        orderedPrimitiveIndexes.sort((i1, i2) => {
            if (eachPrimitiveDecodeMatricesPortion[i1] < eachPrimitiveDecodeMatricesPortion[i2]) {
                return -1;
            }
            if (eachPrimitiveDecodeMatricesPortion[i1] > eachPrimitiveDecodeMatricesPortion[i2]) {
                return 1;
            }
            return 0;
        });

        // Count instances of each primitive

        for (let primitiveInstanceIndex = 0; primitiveInstanceIndex < numPrimitiveInstances; primitiveInstanceIndex++) {
            const primitiveIndex = primitiveInstances[primitiveInstanceIndex];
            primitiveInstanceCounts[primitiveIndex]++;
        }

        // Map batched primitives to the entities that will use them

        const batchedPrimitiveEntityIndexes = {};

        for (let entityIndex = 0; entityIndex < numEntities; entityIndex++) {

            const lastEntityIndex = (numEntities - 1);
            const atLastEntity = (entityIndex === lastEntityIndex);
            const firstEntityPrimitiveInstanceIndex = eachEntityPrimitiveInstancesPortion [entityIndex];
            const lastEntityPrimitiveInstanceIndex = atLastEntity ? eachEntityPrimitiveInstancesPortion[lastEntityIndex] : eachEntityPrimitiveInstancesPortion[entityIndex + 1];

            for (let primitiveInstancesIndex = firstEntityPrimitiveInstanceIndex; primitiveInstancesIndex < lastEntityPrimitiveInstanceIndex; primitiveInstancesIndex++) {

                const primitiveIndex = primitiveInstances[primitiveInstancesIndex];
                const primitiveInstanceCount = primitiveInstanceCounts[primitiveIndex];
                const isInstancedPrimitive = (primitiveInstanceCount > 1);

                if (!isInstancedPrimitive) {
                    batchedPrimitiveEntityIndexes[primitiveIndex] = entityIndex;
                }
            }
        }

        // Create 1) geometries for instanced primitives, and 2) meshes for batched primitives.  We create all the
        // batched meshes now, before we create entities, because we're creating the batched meshes in runs that share
        // the same decode matrices. Each run of meshes with the same decode matrix will end up in the same
        // BatchingLayer; the SceneModel#createMesh() method starts a new BatchingLayer each time the decode
        // matrix has changed since the last invocation of that method, hence why we need to order batched meshes
        // in runs like this.

        for (let primitiveIndex = 0; primitiveIndex < numPrimitives; primitiveIndex++) {

            const orderedPrimitiveIndex = orderedPrimitiveIndexes[primitiveIndex];

            const atLastPrimitive = (orderedPrimitiveIndex === (numPrimitives - 1));

            const primitiveInstanceCount = primitiveInstanceCounts[orderedPrimitiveIndex];
            const isInstancedPrimitive = (primitiveInstanceCount > 1);

            const color = decompressColor$6(eachPrimitiveColor.subarray((orderedPrimitiveIndex * 4), (orderedPrimitiveIndex * 4) + 3));
            const opacity = eachPrimitiveColor[(orderedPrimitiveIndex * 4) + 3] / 255.0;

            const primitivePositions = positions.subarray(eachPrimitivePositionsAndNormalsPortion [orderedPrimitiveIndex], atLastPrimitive ? positions.length : eachPrimitivePositionsAndNormalsPortion [orderedPrimitiveIndex + 1]);
            const primitiveNormals = normals.subarray(eachPrimitivePositionsAndNormalsPortion [orderedPrimitiveIndex], atLastPrimitive ? normals.length : eachPrimitivePositionsAndNormalsPortion [orderedPrimitiveIndex + 1]);
            const primitiveIndices = indices.subarray(eachPrimitiveIndicesPortion [orderedPrimitiveIndex], atLastPrimitive ? indices.length : eachPrimitiveIndicesPortion [orderedPrimitiveIndex + 1]);
            const primitiveEdgeIndices = edgeIndices.subarray(eachPrimitiveEdgeIndicesPortion [orderedPrimitiveIndex], atLastPrimitive ? edgeIndices.length : eachPrimitiveEdgeIndicesPortion [orderedPrimitiveIndex + 1]);
            const primitiveDecodeMatrix = decodeMatrices.subarray(eachPrimitiveDecodeMatricesPortion [orderedPrimitiveIndex], eachPrimitiveDecodeMatricesPortion [orderedPrimitiveIndex] + 16);

            if (isInstancedPrimitive) {

                // Primitive instanced by more than one entity, and has positions in Model-space

               const geometryId = `${modelPartId}-geometry.${orderedPrimitiveIndex}`; // These IDs are local to the SceneModel

                sceneModel.createGeometry({
                    id: geometryId,
                    primitive: "triangles",
                    positionsCompressed: primitivePositions,
                    normalsCompressed: primitiveNormals,
                    indices: primitiveIndices,
                    edgeIndices: primitiveEdgeIndices,
                    positionsDecodeMatrix: primitiveDecodeMatrix
                });

            } else {

                // Primitive is used only by one entity, and has positions pre-transformed into World-space

                const meshId = `${modelPartId}-${orderedPrimitiveIndex}`;

                const entityIndex = batchedPrimitiveEntityIndexes[orderedPrimitiveIndex];
                eachEntityId[entityIndex];

                const meshDefaults = {}; // TODO: get from lookup from entity IDs

                sceneModel.createMesh(utils.apply(meshDefaults, {
                    id: meshId,
                    primitive: "triangles",
                    positionsCompressed: primitivePositions,
                    normalsCompressed: primitiveNormals,
                    indices: primitiveIndices,
                    edgeIndices: primitiveEdgeIndices,
                    positionsDecodeMatrix: primitiveDecodeMatrix,
                    color: color,
                    opacity: opacity
                }));
            }
        }

        let countInstances = 0;

        for (let entityIndex = 0; entityIndex < numEntities; entityIndex++) {

            const lastEntityIndex = (numEntities - 1);
            const atLastEntity = (entityIndex === lastEntityIndex);
            const entityId = eachEntityId[entityIndex];
            const firstEntityPrimitiveInstanceIndex = eachEntityPrimitiveInstancesPortion [entityIndex];
            const lastEntityPrimitiveInstanceIndex = atLastEntity ? eachEntityPrimitiveInstancesPortion[lastEntityIndex] : eachEntityPrimitiveInstancesPortion[entityIndex + 1];

            const meshIds = [];

            for (let primitiveInstancesIndex = firstEntityPrimitiveInstanceIndex; primitiveInstancesIndex < lastEntityPrimitiveInstanceIndex; primitiveInstancesIndex++) {

                const primitiveIndex = primitiveInstances[primitiveInstancesIndex];
                const primitiveInstanceCount = primitiveInstanceCounts[primitiveIndex];
                const isInstancedPrimitive = (primitiveInstanceCount > 1);

                if (isInstancedPrimitive) {

                    const meshDefaults = {}; // TODO: get from lookup from entity IDs

                    const meshId = `${modelPartId}-instance.${countInstances++}`;
                    const geometryId = `${modelPartId}-geometry.${primitiveIndex}`; // These IDs are local to the SceneModel

                    const matricesIndex = (eachEntityMatricesPortion [entityIndex]) * 16;
                    const matrix = matrices.subarray(matricesIndex, matricesIndex + 16);

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        geometryId: geometryId,
                        matrix: matrix
                    }));

                    meshIds.push(meshId);

                } else {
                    meshIds.push(primitiveIndex);
                }
            }

            if (meshIds.length > 0) {

                const entityDefaults = {}; // TODO: get from lookup from entity IDs

                sceneModel.createEntity(utils.apply(entityDefaults, {
                    id: entityId,
                    isObject: true, ///////////////// TODO: If metaobject exists
                    meshIds: meshIds
                }));
            }
        }
    }

    /** @private */
    const ParserV4 = {
        version: 4,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$6(elements);
            const inflatedData = inflate$6(deflatedData);
            load$6(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

     Parser for .XKT Format V5

    .XKT specifications: https://github.com/xeokit/xeokit-sdk/wiki/XKT-Format

     */

    let pako$5 = window.pako || p;
    if (!pako$5.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$5 = pako$5.default;
    }

    function extract$5(elements) {
        return {
            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],
            matrices: elements[4],
            eachPrimitivePositionsAndNormalsPortion: elements[5],
            eachPrimitiveIndicesPortion: elements[6],
            eachPrimitiveEdgeIndicesPortion: elements[7],
            eachPrimitiveColor: elements[8],
            primitiveInstances: elements[9],
            eachEntityId: elements[10],
            eachEntityPrimitiveInstancesPortion: elements[11],
            eachEntityMatricesPortion: elements[12]
        };
    }

    function inflate$5(deflatedData) {
        return {
            positions: new Float32Array(pako$5.inflate(deflatedData.positions).buffer),
            normals: new Int8Array(pako$5.inflate(deflatedData.normals).buffer),
            indices: new Uint32Array(pako$5.inflate(deflatedData.indices).buffer),
            edgeIndices: new Uint32Array(pako$5.inflate(deflatedData.edgeIndices).buffer),
            matrices: new Float32Array(pako$5.inflate(deflatedData.matrices).buffer),
            eachPrimitivePositionsAndNormalsPortion: new Uint32Array(pako$5.inflate(deflatedData.eachPrimitivePositionsAndNormalsPortion).buffer),
            eachPrimitiveIndicesPortion: new Uint32Array(pako$5.inflate(deflatedData.eachPrimitiveIndicesPortion).buffer),
            eachPrimitiveEdgeIndicesPortion: new Uint32Array(pako$5.inflate(deflatedData.eachPrimitiveEdgeIndicesPortion).buffer),
            eachPrimitiveColor: new Uint8Array(pako$5.inflate(deflatedData.eachPrimitiveColor).buffer),
            primitiveInstances: new Uint32Array(pako$5.inflate(deflatedData.primitiveInstances).buffer),
            eachEntityId: pako$5.inflate(deflatedData.eachEntityId, {to: 'string'}),
            eachEntityPrimitiveInstancesPortion: new Uint32Array(pako$5.inflate(deflatedData.eachEntityPrimitiveInstancesPortion).buffer),
            eachEntityMatricesPortion: new Uint32Array(pako$5.inflate(deflatedData.eachEntityMatricesPortion).buffer)
        };
    }

    const decompressColor$5 = (function () {
        const color2 = new Float32Array(3);
        return function (color) {
            color2[0] = color[0] / 255.0;
            color2[1] = color[1] / 255.0;
            color2[2] = color[2] / 255.0;
            return color2;
        };
    })();

    function load$5(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        sceneModel.positionsCompression = "disabled"; // Positions in XKT V4 are floats, which we never quantize, for precision with big models
        sceneModel.normalsCompression = "precompressed"; // Normals are oct-encoded though

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const matrices = inflatedData.matrices;

        const eachPrimitivePositionsAndNormalsPortion = inflatedData.eachPrimitivePositionsAndNormalsPortion;
        const eachPrimitiveIndicesPortion = inflatedData.eachPrimitiveIndicesPortion;
        const eachPrimitiveEdgeIndicesPortion = inflatedData.eachPrimitiveEdgeIndicesPortion;
        const eachPrimitiveColor = inflatedData.eachPrimitiveColor;

        const primitiveInstances = inflatedData.primitiveInstances;

        const eachEntityId = JSON.parse(inflatedData.eachEntityId);
        const eachEntityPrimitiveInstancesPortion = inflatedData.eachEntityPrimitiveInstancesPortion;
        const eachEntityMatricesPortion = inflatedData.eachEntityMatricesPortion;

        const numPrimitives = eachPrimitivePositionsAndNormalsPortion.length;
        const numPrimitiveInstances = primitiveInstances.length;
        const primitiveInstanceCounts = new Uint8Array(numPrimitives); // For each mesh, how many times it is instanced

        const numEntities = eachEntityId.length;

        // Count instances of each primitive

        for (let primitiveInstanceIndex = 0; primitiveInstanceIndex < numPrimitiveInstances; primitiveInstanceIndex++) {
            const primitiveIndex = primitiveInstances[primitiveInstanceIndex];
            primitiveInstanceCounts[primitiveIndex]++;
        }

        // Map batched primitives to the entities that will use them

        const batchedPrimitiveEntityIndexes = {};

        for (let entityIndex = 0; entityIndex < numEntities; entityIndex++) {

            const lastEntityIndex = (numEntities - 1);
            const atLastEntity = (entityIndex === lastEntityIndex);
            const firstEntityPrimitiveInstanceIndex = eachEntityPrimitiveInstancesPortion [entityIndex];
            const lastEntityPrimitiveInstanceIndex = atLastEntity ? eachEntityPrimitiveInstancesPortion[lastEntityIndex] : eachEntityPrimitiveInstancesPortion[entityIndex + 1];

            for (let primitiveInstancesIndex = firstEntityPrimitiveInstanceIndex; primitiveInstancesIndex < lastEntityPrimitiveInstanceIndex; primitiveInstancesIndex++) {

                const primitiveIndex = primitiveInstances[primitiveInstancesIndex];
                const primitiveInstanceCount = primitiveInstanceCounts[primitiveIndex];
                const isInstancedPrimitive = (primitiveInstanceCount > 1);

                if (!isInstancedPrimitive) {
                    batchedPrimitiveEntityIndexes[primitiveIndex] = entityIndex;
                }
            }
        }

        // Create geometries for instanced primitives and meshes for batched primitives.

        for (let primitiveIndex = 0; primitiveIndex < numPrimitives; primitiveIndex++) {

            const atLastPrimitive = (primitiveIndex === (numPrimitives - 1));

            const primitiveInstanceCount = primitiveInstanceCounts[primitiveIndex];
            const isInstancedPrimitive = (primitiveInstanceCount > 1);

            const color = decompressColor$5(eachPrimitiveColor.subarray((primitiveIndex * 4), (primitiveIndex * 4) + 3));
            const opacity = eachPrimitiveColor[(primitiveIndex * 4) + 3] / 255.0;

            const primitivePositions = positions.subarray(eachPrimitivePositionsAndNormalsPortion [primitiveIndex], atLastPrimitive ? positions.length : eachPrimitivePositionsAndNormalsPortion [primitiveIndex + 1]);
            const primitiveNormals = normals.subarray(eachPrimitivePositionsAndNormalsPortion [primitiveIndex], atLastPrimitive ? normals.length : eachPrimitivePositionsAndNormalsPortion [primitiveIndex + 1]);
            const primitiveIndices = indices.subarray(eachPrimitiveIndicesPortion [primitiveIndex], atLastPrimitive ? indices.length : eachPrimitiveIndicesPortion [primitiveIndex + 1]);
            const primitiveEdgeIndices = edgeIndices.subarray(eachPrimitiveEdgeIndicesPortion [primitiveIndex], atLastPrimitive ? edgeIndices.length : eachPrimitiveEdgeIndicesPortion [primitiveIndex + 1]);

            if (isInstancedPrimitive) {

                // Primitive instanced by more than one entity, and has positions in Model-space

                const geometryId = `${modelPartId}-geometry.${primitiveIndex}`; // These IDs are local to the SceneModel

                sceneModel.createGeometry({
                    id: geometryId,
                    primitive: "triangles",
                    positionsCompressed: primitivePositions,
                    normalsCompressed: primitiveNormals,
                    indices: primitiveIndices,
                    edgeIndices: primitiveEdgeIndices
                });

            } else {

                // Primitive is used only by one entity, and has positions pre-transformed into World-space

                const meshId = primitiveIndex; // These IDs are local to the SceneModel

                const entityIndex = batchedPrimitiveEntityIndexes[primitiveIndex];
                eachEntityId[entityIndex];

                const meshDefaults = {}; // TODO: get from lookup from entity IDs

                sceneModel.createMesh(utils.apply(meshDefaults, {
                    id: meshId,
                    primitive: "triangles",
                    positionsCompressed: primitivePositions,
                    normalsCompressed: primitiveNormals,
                    indices: primitiveIndices,
                    edgeIndices: primitiveEdgeIndices,
                    color: color,
                    opacity: opacity
                }));
            }
        }

        let countInstances = 0;

        for (let entityIndex = 0; entityIndex < numEntities; entityIndex++) {

            const lastEntityIndex = (numEntities - 1);
            const atLastEntity = (entityIndex === lastEntityIndex);
            const entityId = eachEntityId[entityIndex];
            const firstEntityPrimitiveInstanceIndex = eachEntityPrimitiveInstancesPortion [entityIndex];
            const lastEntityPrimitiveInstanceIndex = atLastEntity ? eachEntityPrimitiveInstancesPortion[lastEntityIndex] : eachEntityPrimitiveInstancesPortion[entityIndex + 1];

            const meshIds = [];

            for (let primitiveInstancesIndex = firstEntityPrimitiveInstanceIndex; primitiveInstancesIndex < lastEntityPrimitiveInstanceIndex; primitiveInstancesIndex++) {

                const primitiveIndex = primitiveInstances[primitiveInstancesIndex];
                const primitiveInstanceCount = primitiveInstanceCounts[primitiveIndex];
                const isInstancedPrimitive = (primitiveInstanceCount > 1);

                if (isInstancedPrimitive) {

                    const meshDefaults = {}; // TODO: get from lookup from entity IDs

                    const meshId = "instance." + countInstances++;
                    const geometryId = "geometry" + primitiveIndex;
                    const matricesIndex = (eachEntityMatricesPortion [entityIndex]) * 16;
                    const matrix = matrices.subarray(matricesIndex, matricesIndex + 16);

                    sceneModel.createMesh(utils.apply(meshDefaults, {
                        id: meshId,
                        geometryId: geometryId,
                        matrix: matrix
                    }));

                    meshIds.push(meshId);

                } else {
                    meshIds.push(primitiveIndex);
                }
            }

            if (meshIds.length > 0) {

                const entityDefaults = {}; // TODO: get from lookup from entity IDs

                sceneModel.createEntity(utils.apply(entityDefaults, {
                    id: entityId,
                    isObject: true, ///////////////// TODO: If metaobject exists
                    meshIds: meshIds
                }));
            }
        }
    }

    /** @private */
    const ParserV5 = {
        version: 5,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$5(elements);
            const inflatedData = inflate$5(deflatedData);
            load$5(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

     Parser for .XKT Format V6

     */

    let pako$4 = window.pako || p;
    if (!pako$4.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$4 = pako$4.default;
    }

    function extract$4(elements) {

        return {
            positions: elements[0],
            normals: elements[1],
            indices: elements[2],
            edgeIndices: elements[3],
            matrices: elements[4],
            reusedPrimitivesDecodeMatrix: elements[5],
            eachPrimitivePositionsAndNormalsPortion: elements[6],
            eachPrimitiveIndicesPortion: elements[7],
            eachPrimitiveEdgeIndicesPortion: elements[8],
            eachPrimitiveColorAndOpacity: elements[9],
            primitiveInstances: elements[10],
            eachEntityId: elements[11],
            eachEntityPrimitiveInstancesPortion: elements[12],
            eachEntityMatricesPortion: elements[13],
            eachTileAABB: elements[14],
            eachTileEntitiesPortion: elements[15]
        };
    }

    function inflate$4(deflatedData) {

        function inflate(array, options) {
            return (array.length === 0) ? [] : pako$4.inflate(array, options).buffer;
        }

        return {
            positions: new Uint16Array(inflate(deflatedData.positions)),
            normals: new Int8Array(inflate(deflatedData.normals)),
            indices: new Uint32Array(inflate(deflatedData.indices)),
            edgeIndices: new Uint32Array(inflate(deflatedData.edgeIndices)),
            matrices: new Float32Array(inflate(deflatedData.matrices)),
            reusedPrimitivesDecodeMatrix: new Float32Array(inflate(deflatedData.reusedPrimitivesDecodeMatrix)),
            eachPrimitivePositionsAndNormalsPortion: new Uint32Array(inflate(deflatedData.eachPrimitivePositionsAndNormalsPortion)),
            eachPrimitiveIndicesPortion: new Uint32Array(inflate(deflatedData.eachPrimitiveIndicesPortion)),
            eachPrimitiveEdgeIndicesPortion: new Uint32Array(inflate(deflatedData.eachPrimitiveEdgeIndicesPortion)),
            eachPrimitiveColorAndOpacity: new Uint8Array(inflate(deflatedData.eachPrimitiveColorAndOpacity)),
            primitiveInstances: new Uint32Array(inflate(deflatedData.primitiveInstances)),
            eachEntityId: pako$4.inflate(deflatedData.eachEntityId, {to: 'string'}),
            eachEntityPrimitiveInstancesPortion: new Uint32Array(inflate(deflatedData.eachEntityPrimitiveInstancesPortion)),
            eachEntityMatricesPortion: new Uint32Array(inflate(deflatedData.eachEntityMatricesPortion)),
            eachTileAABB: new Float64Array(inflate(deflatedData.eachTileAABB)),
            eachTileEntitiesPortion: new Uint32Array(inflate(deflatedData.eachTileEntitiesPortion))
        };
    }

    const decompressColor$4 = (function () {
        const floatColor = new Float32Array(3);
        return function (intColor) {
            floatColor[0] = intColor[0] / 255.0;
            floatColor[1] = intColor[1] / 255.0;
            floatColor[2] = intColor[2] / 255.0;
            return floatColor;
        };
    })();

    function load$4(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;

        const matrices = inflatedData.matrices;

        const reusedPrimitivesDecodeMatrix = inflatedData.reusedPrimitivesDecodeMatrix;

        const eachPrimitivePositionsAndNormalsPortion = inflatedData.eachPrimitivePositionsAndNormalsPortion;
        const eachPrimitiveIndicesPortion = inflatedData.eachPrimitiveIndicesPortion;
        const eachPrimitiveEdgeIndicesPortion = inflatedData.eachPrimitiveEdgeIndicesPortion;
        const eachPrimitiveColorAndOpacity = inflatedData.eachPrimitiveColorAndOpacity;

        const primitiveInstances = inflatedData.primitiveInstances;

        const eachEntityId = JSON.parse(inflatedData.eachEntityId);
        const eachEntityPrimitiveInstancesPortion = inflatedData.eachEntityPrimitiveInstancesPortion;
        const eachEntityMatricesPortion = inflatedData.eachEntityMatricesPortion;

        const eachTileAABB = inflatedData.eachTileAABB;
        const eachTileEntitiesPortion = inflatedData.eachTileEntitiesPortion;

        const numPrimitives = eachPrimitivePositionsAndNormalsPortion.length;
        const numPrimitiveInstances = primitiveInstances.length;
        const numEntities = eachEntityId.length;
        const numTiles = eachTileEntitiesPortion.length;

        // Count instances of each primitive

        const primitiveReuseCounts = new Uint32Array(numPrimitives);

        for (let primitiveInstanceIndex = 0; primitiveInstanceIndex < numPrimitiveInstances; primitiveInstanceIndex++) {
            const primitiveIndex = primitiveInstances[primitiveInstanceIndex];
            if (primitiveReuseCounts[primitiveIndex] !== undefined) {
                primitiveReuseCounts[primitiveIndex]++;
            } else {
                primitiveReuseCounts[primitiveIndex] = 1;
            }
        }

        // Iterate over tiles

        const tileCenter = math.vec3();
        const rtcAABB = math.AABB3();

        for (let tileIndex = 0; tileIndex < numTiles; tileIndex++) {

            const lastTileIndex = (numTiles - 1);

            const atLastTile = (tileIndex === lastTileIndex);

            const firstTileEntityIndex = eachTileEntitiesPortion [tileIndex];
            const lastTileEntityIndex = atLastTile ? numEntities : eachTileEntitiesPortion[tileIndex + 1];

            const tileAABBIndex = tileIndex * 6;
            const tileAABB = eachTileAABB.subarray(tileAABBIndex, tileAABBIndex + 6);

            math.getAABB3Center(tileAABB, tileCenter);

            rtcAABB[0] = tileAABB[0] - tileCenter[0];
            rtcAABB[1] = tileAABB[1] - tileCenter[1];
            rtcAABB[2] = tileAABB[2] - tileCenter[2];
            rtcAABB[3] = tileAABB[3] - tileCenter[0];
            rtcAABB[4] = tileAABB[4] - tileCenter[1];
            rtcAABB[5] = tileAABB[5] - tileCenter[2];

            const tileDecodeMatrix = geometryCompressionUtils.createPositionsDecodeMatrix(rtcAABB);

            const geometryCreated = {};

            // Iterate over each tile's entities

            for (let tileEntityIndex = firstTileEntityIndex; tileEntityIndex < lastTileEntityIndex; tileEntityIndex++) {

                const xktEntityId = eachEntityId[tileEntityIndex];
                const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;

                const entityMatrixIndex = eachEntityMatricesPortion[tileEntityIndex];
                const entityMatrix = matrices.slice(entityMatrixIndex, entityMatrixIndex + 16);

                const lastTileEntityIndex = (numEntities - 1);
                const atLastTileEntity = (tileEntityIndex === lastTileEntityIndex);
                const firstPrimitiveInstanceIndex = eachEntityPrimitiveInstancesPortion [tileEntityIndex];
                const lastPrimitiveInstanceIndex = atLastTileEntity ? primitiveInstances.length : eachEntityPrimitiveInstancesPortion[tileEntityIndex + 1];

                const meshIds = [];

                // @reviser lijuhong 修改获取metaObject代码
                const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
                const entityDefaults = {};
                const meshDefaults = {};

                if (metaObject) {

                    // Mask loading of object types

                    if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                        continue;
                    }

                    if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                        continue;
                    }

                    // Get initial property values for object types

                    const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                    if (props) {
                        if (props.visible === false) {
                            entityDefaults.visible = false;
                        }
                        if (props.pickable === false) {
                            entityDefaults.pickable = false;
                        }
                        if (props.colorize) {
                            meshDefaults.color = props.colorize;
                        }
                        if (props.opacity !== undefined && props.opacity !== null) {
                            meshDefaults.opacity = props.opacity;
                        }
                    }

                } else {
                    if (options.excludeUnclassifiedObjects) {
                        continue;
                    }
                }

                // Iterate each entity's primitive instances

                for (let primitiveInstancesIndex = firstPrimitiveInstanceIndex; primitiveInstancesIndex < lastPrimitiveInstanceIndex; primitiveInstancesIndex++) {

                    const primitiveIndex = primitiveInstances[primitiveInstancesIndex];
                    const primitiveReuseCount = primitiveReuseCounts[primitiveIndex];
                    const isReusedPrimitive = (primitiveReuseCount > 1);

                    const atLastPrimitive = (primitiveIndex === (numPrimitives - 1));

                    const primitivePositions = positions.subarray(eachPrimitivePositionsAndNormalsPortion [primitiveIndex], atLastPrimitive ? positions.length : eachPrimitivePositionsAndNormalsPortion [primitiveIndex + 1]);
                    const primitiveNormals = normals.subarray(eachPrimitivePositionsAndNormalsPortion [primitiveIndex], atLastPrimitive ? normals.length : eachPrimitivePositionsAndNormalsPortion [primitiveIndex + 1]);
                    const primitiveIndices = indices.subarray(eachPrimitiveIndicesPortion [primitiveIndex], atLastPrimitive ? indices.length : eachPrimitiveIndicesPortion [primitiveIndex + 1]);
                    const primitiveEdgeIndices = edgeIndices.subarray(eachPrimitiveEdgeIndicesPortion [primitiveIndex], atLastPrimitive ? edgeIndices.length : eachPrimitiveEdgeIndicesPortion [primitiveIndex + 1]);

                    const color = decompressColor$4(eachPrimitiveColorAndOpacity.subarray((primitiveIndex * 4), (primitiveIndex * 4) + 3));
                    const opacity = eachPrimitiveColorAndOpacity[(primitiveIndex * 4) + 3] / 255.0;

                    const meshId = manifestCtx.getNextId();

                    if (isReusedPrimitive) {

                        // Create mesh for multi-use primitive - create (or reuse) geometry, create mesh using that geometry

                        const geometryId = `${modelPartId}-geometry.${tileIndex}.${primitiveIndex}`; // These IDs are local to the SceneModel

                        if (!geometryCreated[geometryId]) {

                            sceneModel.createGeometry({
                                id: geometryId,
                                primitive: "triangles",
                                positionsCompressed: primitivePositions,
                             //   normalsCompressed: primitiveNormals,
                                indices: primitiveIndices,
                                edgeIndices: primitiveEdgeIndices,
                                positionsDecodeMatrix: reusedPrimitivesDecodeMatrix
                            });

                            geometryCreated[geometryId] = true;
                        }

                        sceneModel.createMesh(utils.apply(meshDefaults, {
                            id: meshId,
                            geometryId: geometryId,
                            origin: tileCenter,
                            matrix: entityMatrix,
                            color: color,
                            opacity: opacity
                        }));

                        meshIds.push(meshId);

                    } else {

                        sceneModel.createMesh(utils.apply(meshDefaults, {
                            id: meshId,
                            origin: tileCenter,
                            primitive: "triangles",
                            positionsCompressed: primitivePositions,
                            normalsCompressed: primitiveNormals,
                            indices: primitiveIndices,
                            edgeIndices: primitiveEdgeIndices,
                            positionsDecodeMatrix: tileDecodeMatrix,
                            color: color,
                            opacity: opacity
                        }));

                        meshIds.push(meshId);
                    }
                }

                if (meshIds.length > 0) {

                    sceneModel.createEntity(utils.apply(entityDefaults, {
                        id: entityId,
                        isObject: true,
                        meshIds: meshIds
                    }));
                }
            }
        }
    }

    /** @private */
    const ParserV6 = {
        version: 6,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$4(elements);
            const inflatedData = inflate$4(deflatedData);
            load$4(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

     Parser for .XKT Format V7

     */

    let pako$3 = window.pako || p;
    if (!pako$3.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$3 = pako$3.default;
    }

    function extract$3(elements) {

        return {

            // Vertex attributes

            positions: elements[0],
            normals: elements[1],
            colors: elements[2],

            // Indices

            indices: elements[3],
            edgeIndices: elements[4],

            // Transform matrices

            matrices: elements[5],

            reusedGeometriesDecodeMatrix: elements[6],

            // Geometries

            eachGeometryPrimitiveType: elements[7],
            eachGeometryPositionsPortion: elements[8],
            eachGeometryNormalsPortion: elements[9],
            eachGeometryColorsPortion: elements[10],
            eachGeometryIndicesPortion: elements[11],
            eachGeometryEdgeIndicesPortion: elements[12],

            // Meshes are grouped in runs that are shared by the same entities

            eachMeshGeometriesPortion: elements[13],
            eachMeshMatricesPortion: elements[14],
            eachMeshMaterial: elements[15],

            // Entity elements in the following arrays are grouped in runs that are shared by the same tiles

            eachEntityId: elements[16],
            eachEntityMeshesPortion: elements[17],

            eachTileAABB: elements[18],
            eachTileEntitiesPortion: elements[19]
        };
    }

    function inflate$3(deflatedData) {

        function inflate(array, options) {
            return (array.length === 0) ? [] : pako$3.inflate(array, options).buffer;
        }

        return {
            positions: new Uint16Array(inflate(deflatedData.positions)),
            normals: new Int8Array(inflate(deflatedData.normals)),
            colors: new Uint8Array(inflate(deflatedData.colors)),

            indices: new Uint32Array(inflate(deflatedData.indices)),
            edgeIndices: new Uint32Array(inflate(deflatedData.edgeIndices)),

            matrices: new Float32Array(inflate(deflatedData.matrices)),

            reusedGeometriesDecodeMatrix: new Float32Array(inflate(deflatedData.reusedGeometriesDecodeMatrix)),

            eachGeometryPrimitiveType: new Uint8Array(inflate(deflatedData.eachGeometryPrimitiveType)),
            eachGeometryPositionsPortion: new Uint32Array(inflate(deflatedData.eachGeometryPositionsPortion)),
            eachGeometryNormalsPortion: new Uint32Array(inflate(deflatedData.eachGeometryNormalsPortion)),
            eachGeometryColorsPortion: new Uint32Array(inflate(deflatedData.eachGeometryColorsPortion)),
            eachGeometryIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryIndicesPortion)),
            eachGeometryEdgeIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryEdgeIndicesPortion)),

            eachMeshGeometriesPortion: new Uint32Array(inflate(deflatedData.eachMeshGeometriesPortion)),
            eachMeshMatricesPortion: new Uint32Array(inflate(deflatedData.eachMeshMatricesPortion)),
            eachMeshMaterial: new Uint8Array(inflate(deflatedData.eachMeshMaterial)),

            eachEntityId: pako$3.inflate(deflatedData.eachEntityId, {to: 'string'}),
            eachEntityMeshesPortion: new Uint32Array(inflate(deflatedData.eachEntityMeshesPortion)),

            eachTileAABB: new Float64Array(inflate(deflatedData.eachTileAABB)),
            eachTileEntitiesPortion: new Uint32Array(inflate(deflatedData.eachTileEntitiesPortion)),
        };
    }

    const decompressColor$3 = (function () {
        const floatColor = new Float32Array(3);
        return function (intColor) {
            floatColor[0] = intColor[0] / 255.0;
            floatColor[1] = intColor[1] / 255.0;
            floatColor[2] = intColor[2] / 255.0;
            return floatColor;
        };
    })();

    function convertColorsRGBToRGBA$1(colorsRGB) {
        const colorsRGBA = [];
        for (let i = 0, len = colorsRGB.length; i < len; i+=3) {
            colorsRGBA.push(colorsRGB[i]);
            colorsRGBA.push(colorsRGB[i+1]);
            colorsRGBA.push(colorsRGB[i+2]);
            colorsRGBA.push(1.0);
        }
        return colorsRGBA;
    }

    function load$3(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const colors = inflatedData.colors;

        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;

        const matrices = inflatedData.matrices;

        const reusedGeometriesDecodeMatrix = inflatedData.reusedGeometriesDecodeMatrix;

        const eachGeometryPrimitiveType = inflatedData.eachGeometryPrimitiveType;
        const eachGeometryPositionsPortion = inflatedData.eachGeometryPositionsPortion;
        const eachGeometryNormalsPortion = inflatedData.eachGeometryNormalsPortion;
        const eachGeometryColorsPortion = inflatedData.eachGeometryColorsPortion;
        const eachGeometryIndicesPortion = inflatedData.eachGeometryIndicesPortion;
        const eachGeometryEdgeIndicesPortion = inflatedData.eachGeometryEdgeIndicesPortion;

        const eachMeshGeometriesPortion = inflatedData.eachMeshGeometriesPortion;
        const eachMeshMatricesPortion = inflatedData.eachMeshMatricesPortion;
        const eachMeshMaterial = inflatedData.eachMeshMaterial;

        const eachEntityId = JSON.parse(inflatedData.eachEntityId);
        const eachEntityMeshesPortion = inflatedData.eachEntityMeshesPortion;

        const eachTileAABB = inflatedData.eachTileAABB;
        const eachTileEntitiesPortion = inflatedData.eachTileEntitiesPortion;

        const numGeometries = eachGeometryPositionsPortion.length;
        const numMeshes = eachMeshGeometriesPortion.length;
        const numEntities = eachEntityId.length;
        const numTiles = eachTileEntitiesPortion.length;

        // Count instances of each geometry

        const geometryReuseCounts = new Uint32Array(numGeometries);

        for (let meshIndex = 0; meshIndex < numMeshes; meshIndex++) {
            const geometryIndex = eachMeshGeometriesPortion[meshIndex];
            if (geometryReuseCounts[geometryIndex] !== undefined) {
                geometryReuseCounts[geometryIndex]++;
            } else {
                geometryReuseCounts[geometryIndex] = 1;
            }
        }

        // Iterate over tiles

        const tileCenter = math.vec3();
        const rtcAABB = math.AABB3();

        for (let tileIndex = 0; tileIndex < numTiles; tileIndex++) {

            const lastTileIndex = (numTiles - 1);

            const atLastTile = (tileIndex === lastTileIndex);

            const firstTileEntityIndex = eachTileEntitiesPortion [tileIndex];
            const lastTileEntityIndex = atLastTile ? numEntities : eachTileEntitiesPortion[tileIndex + 1];

            const tileAABBIndex = tileIndex * 6;
            const tileAABB = eachTileAABB.subarray(tileAABBIndex, tileAABBIndex + 6);

            math.getAABB3Center(tileAABB, tileCenter);

            rtcAABB[0] = tileAABB[0] - tileCenter[0];
            rtcAABB[1] = tileAABB[1] - tileCenter[1];
            rtcAABB[2] = tileAABB[2] - tileCenter[2];
            rtcAABB[3] = tileAABB[3] - tileCenter[0];
            rtcAABB[4] = tileAABB[4] - tileCenter[1];
            rtcAABB[5] = tileAABB[5] - tileCenter[2];

            const tileDecodeMatrix = geometryCompressionUtils.createPositionsDecodeMatrix(rtcAABB);

            const geometryCreated = {};

            // Iterate over each tile's entities

            for (let tileEntityIndex = firstTileEntityIndex; tileEntityIndex < lastTileEntityIndex; tileEntityIndex++) {

                const xktEntityId = eachEntityId[tileEntityIndex];
                const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;

                const lastTileEntityIndex = (numEntities - 1);
                const atLastTileEntity = (tileEntityIndex === lastTileEntityIndex);
                const firstMeshIndex = eachEntityMeshesPortion [tileEntityIndex];
                const lastMeshIndex = atLastTileEntity ? eachMeshGeometriesPortion.length : eachEntityMeshesPortion[tileEntityIndex + 1];

                const meshIds = [];

                // @reviser lijuhong 修改获取metaObject代码
                const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
                const entityDefaults = {};
                const meshDefaults = {};

                if (metaObject) {

                    // Mask loading of object types

                    if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                        continue;
                    }

                    if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                        continue;
                    }

                    // Get initial property values for object types

                    const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                    if (props) {
                        if (props.visible === false) {
                            entityDefaults.visible = false;
                        }
                        if (props.pickable === false) {
                            entityDefaults.pickable = false;
                        }
                        if (props.colorize) {
                            meshDefaults.color = props.colorize;
                        }
                        if (props.opacity !== undefined && props.opacity !== null) {
                            meshDefaults.opacity = props.opacity;
                        }
                        if (props.metallic !== undefined && props.metallic !== null) {
                            meshDefaults.metallic = props.metallic;
                        }
                        if (props.roughness !== undefined && props.roughness !== null) {
                            meshDefaults.roughness = props.roughness;
                        }
                    }

                } else {
                    if (options.excludeUnclassifiedObjects) {
                        continue;
                    }
                }

                // Iterate each entity's meshes

                for (let meshIndex = firstMeshIndex; meshIndex < lastMeshIndex; meshIndex++) {

                    const geometryIndex = eachMeshGeometriesPortion[meshIndex];
                    const geometryReuseCount = geometryReuseCounts[geometryIndex];
                    const isReusedGeometry = (geometryReuseCount > 1);

                    const atLastGeometry = (geometryIndex === (numGeometries - 1));

                    const meshColor = decompressColor$3(eachMeshMaterial.subarray((meshIndex * 6), (meshIndex * 6) + 3));
                    const meshOpacity = eachMeshMaterial[(meshIndex * 6) + 3] / 255.0;
                    const meshMetallic = eachMeshMaterial[(meshIndex * 6) + 4] / 255.0;
                    const meshRoughness = eachMeshMaterial[(meshIndex * 6) + 5] / 255.0;

                    const meshId = manifestCtx.getNextId();

                    if (isReusedGeometry) {

                        // Create mesh for multi-use geometry - create (or reuse) geometry, create mesh using that geometry

                        const meshMatrixIndex = eachMeshMatricesPortion[meshIndex];
                        const meshMatrix = matrices.slice(meshMatrixIndex, meshMatrixIndex + 16);

                        const geometryId = `${modelPartId}-geometry.${tileIndex}.${geometryIndex}`; // These IDs are local to the SceneModel

                        if (!geometryCreated[geometryId]) {

                            const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                            let primitiveName;
                            let geometryPositions;
                            let geometryNormals;
                            let geometryColors;
                            let geometryIndices;
                            let geometryEdgeIndices;

                            switch (primitiveType) {
                                case 0:
                                    primitiveName = "solid";
                                    geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    break;
                                case 1:
                                    primitiveName = "surface";
                                    geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    break;
                                case 2:
                                    primitiveName = "points";
                                    geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryColors = convertColorsRGBToRGBA$1(colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]));
                                    break;
                                case 3:
                                    primitiveName = "lines";
                                    geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    break;
                                default:
                                    continue;
                            }

                            sceneModel.createGeometry({
                                id: geometryId,
                                primitive: primitiveName,
                                positionsCompressed: geometryPositions,
                                normalsCompressed: geometryNormals,
                                colors: geometryColors,
                                indices: geometryIndices,
                                edgeIndices: geometryEdgeIndices,
                                positionsDecodeMatrix: reusedGeometriesDecodeMatrix
                            });

                            geometryCreated[geometryId] = true;
                        }

                        sceneModel.createMesh(utils.apply(meshDefaults, {
                            id: meshId,
                            geometryId: geometryId,
                            origin: tileCenter,
                            matrix: meshMatrix,
                            color: meshColor,
                            metallic: meshMetallic,
                            roughness: meshRoughness,
                            opacity: meshOpacity
                        }));

                        meshIds.push(meshId);

                    } else {

                        const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                        let primitiveName;
                        let geometryPositions;
                        let geometryNormals;
                        let geometryColors;
                        let geometryIndices;
                        let geometryEdgeIndices;

                        switch (primitiveType) {
                            case 0:
                                primitiveName = "solid";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                break;
                            case 1:
                                primitiveName = "surface";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                break;
                            case 2:
                                primitiveName = "points";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryColors = convertColorsRGBToRGBA$1(colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]));
                                break;
                            case 3:
                                primitiveName = "lines";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                break;
                            default:
                                continue;
                        }

                        sceneModel.createMesh(utils.apply(meshDefaults, {
                            id: meshId,
                            origin: tileCenter,
                            primitive: primitiveName,
                            positionsCompressed: geometryPositions,
                            normalsCompressed: geometryNormals,
                            colors: geometryColors,
                            indices: geometryIndices,
                            edgeIndices: geometryEdgeIndices,
                            positionsDecodeMatrix: tileDecodeMatrix,
                            color: meshColor,
                            metallic: meshMetallic,
                            roughness: meshRoughness,
                            opacity: meshOpacity
                        }));

                        meshIds.push(meshId);
                    }
                }

                if (meshIds.length > 0) {

                    sceneModel.createEntity(utils.apply(entityDefaults, {
                        id: entityId,
                        isObject: true,
                        meshIds: meshIds
                    }));
                }
            }
        }
    }

    /** @private */
    const ParserV7 = {
        version: 7,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$3(elements);
            const inflatedData = inflate$3(deflatedData);
            load$3(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

     Parser for .XKT Format V8

     */

    let pako$2 = window.pako || p;
    if (!pako$2.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$2 = pako$2.default;
    }

    const tempVec4a$2 = math.vec4();
    const tempVec4b$2 = math.vec4();

    function extract$2(elements) {

        return {

            // Vertex attributes

            types: elements[0],
            eachMetaObjectId: elements[1],
            eachMetaObjectType: elements[2],
            eachMetaObjectName: elements[3],
            eachMetaObjectParent: elements[4],

            positions: elements[5],
            normals: elements[6],
            colors: elements[7],
            indices: elements[8],
            edgeIndices: elements[9],

            // Transform matrices

            matrices: elements[10],
            reusedGeometriesDecodeMatrix: elements[11],

            // Geometries

            eachGeometryPrimitiveType: elements[12],
            eachGeometryPositionsPortion: elements[13],
            eachGeometryNormalsPortion: elements[14],
            eachGeometryColorsPortion: elements[15],
            eachGeometryIndicesPortion: elements[16],
            eachGeometryEdgeIndicesPortion: elements[17],

            // Meshes are grouped in runs that are shared by the same entities

            eachMeshGeometriesPortion: elements[18],
            eachMeshMatricesPortion: elements[19],
            eachMeshMaterial: elements[20],

            // Entity elements in the following arrays are grouped in runs that are shared by the same tiles

            eachEntityMetaObject: elements[21],
            eachEntityMeshesPortion: elements[22],

            eachTileAABB: elements[23],
            eachTileEntitiesPortion: elements[24]
        };
    }

    function inflate$2(deflatedData) {

        function inflate(array, options) {
            return (array.length === 0) ? [] : pako$2.inflate(array, options).buffer;
        }

        return {

            types: pako$2.inflate(deflatedData.types, {to: 'string'}),
            eachMetaObjectId: pako$2.inflate(deflatedData.eachMetaObjectId, {to: 'string'}),
            eachMetaObjectType: new Uint32Array(inflate(deflatedData.eachMetaObjectType)),
            eachMetaObjectName: pako$2.inflate(deflatedData.eachMetaObjectName, {to: 'string'}),
            eachMetaObjectParent: new Uint32Array(inflate(deflatedData.eachMetaObjectParent)),

            positions: new Uint16Array(inflate(deflatedData.positions)),
            normals: new Int8Array(inflate(deflatedData.normals)),
            colors: new Uint8Array(inflate(deflatedData.colors)),
            indices: new Uint32Array(inflate(deflatedData.indices)),
            edgeIndices: new Uint32Array(inflate(deflatedData.edgeIndices)),

            matrices: new Float32Array(inflate(deflatedData.matrices)),
            reusedGeometriesDecodeMatrix: new Float32Array(inflate(deflatedData.reusedGeometriesDecodeMatrix)),

            eachGeometryPrimitiveType: new Uint8Array(inflate(deflatedData.eachGeometryPrimitiveType)),
            eachGeometryPositionsPortion: new Uint32Array(inflate(deflatedData.eachGeometryPositionsPortion)),
            eachGeometryNormalsPortion: new Uint32Array(inflate(deflatedData.eachGeometryNormalsPortion)),
            eachGeometryColorsPortion: new Uint32Array(inflate(deflatedData.eachGeometryColorsPortion)),
            eachGeometryIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryIndicesPortion)),
            eachGeometryEdgeIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryEdgeIndicesPortion)),

            eachMeshGeometriesPortion: new Uint32Array(inflate(deflatedData.eachMeshGeometriesPortion)),
            eachMeshMatricesPortion: new Uint32Array(inflate(deflatedData.eachMeshMatricesPortion)),
            eachMeshMaterial: new Uint8Array(inflate(deflatedData.eachMeshMaterial)),

            eachEntityMetaObject: new Uint32Array(inflate(deflatedData.eachEntityMetaObject)),
            eachEntityMeshesPortion: new Uint32Array(inflate(deflatedData.eachEntityMeshesPortion)),

            eachTileAABB: new Float64Array(inflate(deflatedData.eachTileAABB)),
            eachTileEntitiesPortion: new Uint32Array(inflate(deflatedData.eachTileEntitiesPortion)),
        };
    }

    const decompressColor$2 = (function () {
        const floatColor = new Float32Array(3);
        return function (intColor) {
            floatColor[0] = intColor[0] / 255.0;
            floatColor[1] = intColor[1] / 255.0;
            floatColor[2] = intColor[2] / 255.0;
            return floatColor;
        };
    })();

    function convertColorsRGBToRGBA(colorsRGB) {
        const colorsRGBA = [];
        for (let i = 0, len = colorsRGB.length; i < len; i += 3) {
            colorsRGBA.push(colorsRGB[i]);
            colorsRGBA.push(colorsRGB[i + 1]);
            colorsRGBA.push(colorsRGB[i + 2]);
            colorsRGBA.push(1.0);
        }
        return colorsRGBA;
    }

    function load$2(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        const types = JSON.parse(inflatedData.types);
        const eachMetaObjectId = JSON.parse(inflatedData.eachMetaObjectId);
        const eachMetaObjectType = inflatedData.eachMetaObjectType;
        const eachMetaObjectName = JSON.parse(inflatedData.eachMetaObjectName);
        const eachMetaObjectParent = inflatedData.eachMetaObjectParent;

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const colors = inflatedData.colors;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;

        const matrices = inflatedData.matrices;
        const reusedGeometriesDecodeMatrix = inflatedData.reusedGeometriesDecodeMatrix;

        const eachGeometryPrimitiveType = inflatedData.eachGeometryPrimitiveType;
        const eachGeometryPositionsPortion = inflatedData.eachGeometryPositionsPortion;
        const eachGeometryNormalsPortion = inflatedData.eachGeometryNormalsPortion;
        const eachGeometryColorsPortion = inflatedData.eachGeometryColorsPortion;
        const eachGeometryIndicesPortion = inflatedData.eachGeometryIndicesPortion;
        const eachGeometryEdgeIndicesPortion = inflatedData.eachGeometryEdgeIndicesPortion;

        const eachMeshGeometriesPortion = inflatedData.eachMeshGeometriesPortion;
        const eachMeshMatricesPortion = inflatedData.eachMeshMatricesPortion;
        const eachMeshMaterial = inflatedData.eachMeshMaterial;

        const eachEntityMetaObject = inflatedData.eachEntityMetaObject;
        const eachEntityMeshesPortion = inflatedData.eachEntityMeshesPortion;

        const eachTileAABB = inflatedData.eachTileAABB;
        const eachTileEntitiesPortion = inflatedData.eachTileEntitiesPortion;

        const numMetaObjects = eachMetaObjectId.length;
        const numGeometries = eachGeometryPositionsPortion.length;
        const numMeshes = eachMeshGeometriesPortion.length;
        const numEntities = eachEntityMetaObject.length;
        const numTiles = eachTileEntitiesPortion.length;

        if (metaModel) {
            const metaModelData = {
                metaObjects: []
            };
            for (let metaObjectIndex = 0; metaObjectIndex < numMetaObjects; metaObjectIndex++) {
                const metaObjectId = eachMetaObjectId[metaObjectIndex];
                const typeIndex = eachMetaObjectType[metaObjectIndex];
                const metaObjectType = types[typeIndex] || "default";
                const metaObjectName = eachMetaObjectName[metaObjectIndex];
                const metaObjectParentIndex = eachMetaObjectParent[metaObjectIndex];
                const metaObjectParentId = (metaObjectParentIndex !== metaObjectIndex) ? eachMetaObjectId[metaObjectParentIndex] : null;
                metaModelData.metaObjects.push({
                    id: metaObjectId,
                    type: metaObjectType,
                    name: metaObjectName,
                    parent: metaObjectParentId
                });
            }
            metaModel.loadData(metaModelData, {
                includeTypes: options.includeTypes,
                excludeTypes: options.excludeTypes,
                globalizeObjectIds: options.globalizeObjectIds
            });
        }

        // Count instances of each geometry

        const geometryReuseCounts = new Uint32Array(numGeometries);

        for (let meshIndex = 0; meshIndex < numMeshes; meshIndex++) {
            const geometryIndex = eachMeshGeometriesPortion[meshIndex];
            if (geometryReuseCounts[geometryIndex] !== undefined) {
                geometryReuseCounts[geometryIndex]++;
            } else {
                geometryReuseCounts[geometryIndex] = 1;
            }
        }

        // Iterate over tiles

        const tileCenter = math.vec3();
        const rtcAABB = math.AABB3();

        const geometryArraysCache = {};

        for (let tileIndex = 0; tileIndex < numTiles; tileIndex++) {

            const lastTileIndex = (numTiles - 1);

            const atLastTile = (tileIndex === lastTileIndex);

            const firstTileEntityIndex = eachTileEntitiesPortion [tileIndex];
            const lastTileEntityIndex = atLastTile ? numEntities : eachTileEntitiesPortion[tileIndex + 1];

            const tileAABBIndex = tileIndex * 6;
            const tileAABB = eachTileAABB.subarray(tileAABBIndex, tileAABBIndex + 6);

            math.getAABB3Center(tileAABB, tileCenter);

            rtcAABB[0] = tileAABB[0] - tileCenter[0];
            rtcAABB[1] = tileAABB[1] - tileCenter[1];
            rtcAABB[2] = tileAABB[2] - tileCenter[2];
            rtcAABB[3] = tileAABB[3] - tileCenter[0];
            rtcAABB[4] = tileAABB[4] - tileCenter[1];
            rtcAABB[5] = tileAABB[5] - tileCenter[2];

            const tileDecodeMatrix = geometryCompressionUtils.createPositionsDecodeMatrix(rtcAABB);

            const geometryCreatedInTile = {};

            // Iterate over each tile's entities

            for (let tileEntityIndex = firstTileEntityIndex; tileEntityIndex < lastTileEntityIndex; tileEntityIndex++) {

                const xktMetaObjectIndex = eachEntityMetaObject[tileEntityIndex];
                const xktMetaObjectId = eachMetaObjectId[xktMetaObjectIndex];
                const xktEntityId = xktMetaObjectId;

                const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;

                const lastTileEntityIndex = (numEntities - 1);
                const atLastTileEntity = (tileEntityIndex === lastTileEntityIndex);
                const firstMeshIndex = eachEntityMeshesPortion [tileEntityIndex];
                const lastMeshIndex = atLastTileEntity ? eachMeshGeometriesPortion.length : eachEntityMeshesPortion[tileEntityIndex + 1];

                const meshIds = [];

                // @reviser lijuhong 修改获取metaObject代码
                const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
                const entityDefaults = {};
                const meshDefaults = {};

                if (metaObject) {

                    // Mask loading of object types

                    if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                        continue;
                    }

                    if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                        continue;
                    }

                    // Get initial property values for object types

                    const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                    if (props) {
                        if (props.visible === false) {
                            entityDefaults.visible = false;
                        }
                        if (props.pickable === false) {
                            entityDefaults.pickable = false;
                        }
                        if (props.colorize) {
                            meshDefaults.color = props.colorize;
                        }
                        if (props.opacity !== undefined && props.opacity !== null) {
                            meshDefaults.opacity = props.opacity;
                        }
                        if (props.metallic !== undefined && props.metallic !== null) {
                            meshDefaults.metallic = props.metallic;
                        }
                        if (props.roughness !== undefined && props.roughness !== null) {
                            meshDefaults.roughness = props.roughness;
                        }
                    }

                } else {
                    if (options.excludeUnclassifiedObjects) {
                        continue;
                    }
                }

                // Iterate each entity's meshes

                for (let meshIndex = firstMeshIndex; meshIndex < lastMeshIndex; meshIndex++) {

                    const geometryIndex = eachMeshGeometriesPortion[meshIndex];
                    const geometryReuseCount = geometryReuseCounts[geometryIndex];
                    const isReusedGeometry = (geometryReuseCount > 1);

                    const atLastGeometry = (geometryIndex === (numGeometries - 1));

                    const meshColor = decompressColor$2(eachMeshMaterial.subarray((meshIndex * 6), (meshIndex * 6) + 3));
                    const meshOpacity = eachMeshMaterial[(meshIndex * 6) + 3] / 255.0;
                    const meshMetallic = eachMeshMaterial[(meshIndex * 6) + 4] / 255.0;
                    const meshRoughness = eachMeshMaterial[(meshIndex * 6) + 5] / 255.0;

                    const meshId = manifestCtx.getNextId();

                    if (isReusedGeometry) {

                        // Create mesh for multi-use geometry - create (or reuse) geometry, create mesh using that geometry

                        const meshMatrixIndex = eachMeshMatricesPortion[meshIndex];
                        const meshMatrix = matrices.slice(meshMatrixIndex, meshMatrixIndex + 16);

                         const geometryId = `${modelPartId}-geometry.${tileIndex}.${geometryIndex}`; // These IDs are local to the SceneModel

                        let geometryArrays = geometryArraysCache[geometryId];

                        if (!geometryArrays) {

                            geometryArrays = {
                                batchThisMesh: (!options.reuseGeometries)
                            };

                            const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                            let geometryValid = false;

                            switch (primitiveType) {
                                case 0:
                                    geometryArrays.primitiveName = "solid";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 1:
                                    geometryArrays.primitiveName = "surface";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 2:
                                    geometryArrays.primitiveName = "points";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryColors = convertColorsRGBToRGBA(colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]));
                                    geometryValid = (geometryArrays.geometryPositions.length > 0);
                                    break;
                                case 3:
                                    geometryArrays.primitiveName = "lines";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                default:
                                    continue;
                            }

                            if (!geometryValid) {
                                geometryArrays = null;
                            }

                            if (geometryArrays) {
                                if (geometryArrays.geometryPositions.length > 1000) ;
                                if (geometryArrays.batchThisMesh) {
                                    geometryArrays.decompressedPositions = new Float32Array(geometryArrays.geometryPositions.length);
                                    const geometryPositions = geometryArrays.geometryPositions;
                                    const decompressedPositions = geometryArrays.decompressedPositions;
                                    for (let i = 0, len = geometryPositions.length; i < len; i += 3) {
                                        decompressedPositions[i + 0] = geometryPositions[i + 0] * reusedGeometriesDecodeMatrix[0] + reusedGeometriesDecodeMatrix[12];
                                        decompressedPositions[i + 1] = geometryPositions[i + 1] * reusedGeometriesDecodeMatrix[5] + reusedGeometriesDecodeMatrix[13];
                                        decompressedPositions[i + 2] = geometryPositions[i + 2] * reusedGeometriesDecodeMatrix[10] + reusedGeometriesDecodeMatrix[14];
                                    }
                                    geometryArrays.geometryPositions = null;
                                    geometryArraysCache[geometryId] = geometryArrays;
                                }
                            }
                        }

                        if (geometryArrays) {

                            if (geometryArrays.batchThisMesh) {

                                const decompressedPositions = geometryArrays.decompressedPositions;
                                const positions = new Uint16Array(decompressedPositions.length);
                                for (let i = 0, len = decompressedPositions.length; i < len; i += 3) {
                                    tempVec4a$2[0] = decompressedPositions[i + 0];
                                    tempVec4a$2[1] = decompressedPositions[i + 1];
                                    tempVec4a$2[2] = decompressedPositions[i + 2];
                                    tempVec4a$2[3] = 1;
                                    math.transformVec4(meshMatrix, tempVec4a$2, tempVec4b$2);
                                    geometryCompressionUtils.compressPosition(tempVec4b$2, rtcAABB, tempVec4a$2);
                                    positions[i + 0] = tempVec4a$2[0];
                                    positions[i + 1] = tempVec4a$2[1];
                                    positions[i + 2] = tempVec4a$2[2];
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    origin: tileCenter,
                                    primitive: geometryArrays.primitiveName,
                                    positionsCompressed: positions,
                                    normalsCompressed: geometryArrays.geometryNormals,
                                    colorsCompressed: geometryArrays.geometryColors,
                                    indices: geometryArrays.geometryIndices,
                                    edgeIndices: geometryArrays.geometryEdgeIndices,
                                    positionsDecodeMatrix: tileDecodeMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity
                                }));

                                meshIds.push(meshId);

                            } else {

                                if (!geometryCreatedInTile[geometryId]) {

                                    sceneModel.createGeometry({
                                        id: geometryId,
                                        primitive: geometryArrays.primitiveName,
                                        positionsCompressed: geometryArrays.geometryPositions,
                                        normalsCompressed: geometryArrays.geometryNormals,
                                        colorsCompressed: geometryArrays.geometryColors,
                                        indices: geometryArrays.geometryIndices,
                                        edgeIndices: geometryArrays.geometryEdgeIndices,
                                        positionsDecodeMatrix: reusedGeometriesDecodeMatrix
                                    });

                                    geometryCreatedInTile[geometryId] = true;
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    geometryId: geometryId,
                                    origin: tileCenter,
                                    matrix: meshMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity
                                }));

                                meshIds.push(meshId);
                            }
                        }

                    } else {

                        const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                        let primitiveName;
                        let geometryPositions;
                        let geometryNormals;
                        let geometryColors;
                        let geometryIndices;
                        let geometryEdgeIndices;
                        let geometryValid = false;

                        switch (primitiveType) {
                            case 0:
                                primitiveName = "solid";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 1:
                                primitiveName = "surface";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 2:
                                primitiveName = "points";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryColors = convertColorsRGBToRGBA(colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]));
                                geometryValid = (geometryPositions.length > 0);
                                break;
                            case 3:
                                primitiveName = "lines";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            default:
                                continue;
                        }

                        if (geometryValid) {

                            sceneModel.createMesh(utils.apply(meshDefaults, {
                                id: meshId,
                                origin: tileCenter,
                                primitive: primitiveName,
                                positionsCompressed: geometryPositions,
                                normalsCompressed: geometryNormals,
                                colorsCompressed: geometryColors,
                                indices: geometryIndices,
                                edgeIndices: geometryEdgeIndices,
                                positionsDecodeMatrix: tileDecodeMatrix,
                                color: meshColor,
                                metallic: meshMetallic,
                                roughness: meshRoughness,
                                opacity: meshOpacity
                            }));

                            meshIds.push(meshId);
                        }
                    }
                }

                if (meshIds.length > 0) {

                    sceneModel.createEntity(utils.apply(entityDefaults, {
                        id: entityId,
                        isObject: true,
                        meshIds: meshIds
                    }));
                }
            }
        }
    }

    /** @private */
    const ParserV8 = {
        version: 8,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$2(elements);
            const inflatedData = inflate$2(deflatedData);
            load$2(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*

     Parser for .XKT Format V9

     */

    let pako$1 = window.pako || p;
    if (!pako$1.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako$1 = pako$1.default;
    }

    const tempVec4a$1 = math.vec4();
    const tempVec4b$1 = math.vec4();

    function extract$1(elements) {

        return {

            // Metadata

            metadata: elements[0],

            positions: elements[1],
            normals: elements[2],
            colors: elements[3],
            indices: elements[4],
            edgeIndices: elements[5],

            // Transform matrices

            matrices: elements[6],
            reusedGeometriesDecodeMatrix: elements[7],

            // Geometries

            eachGeometryPrimitiveType: elements[8],
            eachGeometryPositionsPortion: elements[9],
            eachGeometryNormalsPortion: elements[10],
            eachGeometryColorsPortion: elements[11],
            eachGeometryIndicesPortion: elements[12],
            eachGeometryEdgeIndicesPortion: elements[13],

            // Meshes are grouped in runs that are shared by the same entities

            eachMeshGeometriesPortion: elements[14],
            eachMeshMatricesPortion: elements[15],
            eachMeshMaterial: elements[16],

            // Entity elements in the following arrays are grouped in runs that are shared by the same tiles

            eachEntityId: elements[17],
            eachEntityMeshesPortion: elements[18],

            eachTileAABB: elements[19],
            eachTileEntitiesPortion: elements[20]
        };
    }

    function inflate$1(deflatedData) {

        function inflate(array, options) {
            return (array.length === 0) ? [] : pako$1.inflate(array, options).buffer;
        }

        return {

            metadata: JSON.parse(pako$1.inflate(deflatedData.metadata, {to: 'string'})),

            positions: new Uint16Array(inflate(deflatedData.positions)),
            normals: new Int8Array(inflate(deflatedData.normals)),
            colors: new Uint8Array(inflate(deflatedData.colors)),
            indices: new Uint32Array(inflate(deflatedData.indices)),
            edgeIndices: new Uint32Array(inflate(deflatedData.edgeIndices)),

            matrices: new Float32Array(inflate(deflatedData.matrices)),
            reusedGeometriesDecodeMatrix: new Float32Array(inflate(deflatedData.reusedGeometriesDecodeMatrix)),

            eachGeometryPrimitiveType: new Uint8Array(inflate(deflatedData.eachGeometryPrimitiveType)),
            eachGeometryPositionsPortion: new Uint32Array(inflate(deflatedData.eachGeometryPositionsPortion)),
            eachGeometryNormalsPortion: new Uint32Array(inflate(deflatedData.eachGeometryNormalsPortion)),
            eachGeometryColorsPortion: new Uint32Array(inflate(deflatedData.eachGeometryColorsPortion)),
            eachGeometryIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryIndicesPortion)),
            eachGeometryEdgeIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryEdgeIndicesPortion)),

            eachMeshGeometriesPortion: new Uint32Array(inflate(deflatedData.eachMeshGeometriesPortion)),
            eachMeshMatricesPortion: new Uint32Array(inflate(deflatedData.eachMeshMatricesPortion)),
            eachMeshMaterial: new Uint8Array(inflate(deflatedData.eachMeshMaterial)),

            eachEntityId: JSON.parse(pako$1.inflate(deflatedData.eachEntityId, {to: 'string'})),
            eachEntityMeshesPortion: new Uint32Array(inflate(deflatedData.eachEntityMeshesPortion)),

            eachTileAABB: new Float64Array(inflate(deflatedData.eachTileAABB)),
            eachTileEntitiesPortion: new Uint32Array(inflate(deflatedData.eachTileEntitiesPortion)),
        };
    }

    const decompressColor$1 = (function () {
        const floatColor = new Float32Array(3);
        return function (intColor) {
            floatColor[0] = intColor[0] / 255.0;
            floatColor[1] = intColor[1] / 255.0;
            floatColor[2] = intColor[2] / 255.0;
            return floatColor;
        };
    })();

    function load$1(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        const metadata = inflatedData.metadata;

        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const colors = inflatedData.colors;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;

        const matrices = inflatedData.matrices;
        const reusedGeometriesDecodeMatrix = inflatedData.reusedGeometriesDecodeMatrix;

        const eachGeometryPrimitiveType = inflatedData.eachGeometryPrimitiveType;
        const eachGeometryPositionsPortion = inflatedData.eachGeometryPositionsPortion;
        const eachGeometryNormalsPortion = inflatedData.eachGeometryNormalsPortion;
        const eachGeometryColorsPortion = inflatedData.eachGeometryColorsPortion;
        const eachGeometryIndicesPortion = inflatedData.eachGeometryIndicesPortion;
        const eachGeometryEdgeIndicesPortion = inflatedData.eachGeometryEdgeIndicesPortion;

        const eachMeshGeometriesPortion = inflatedData.eachMeshGeometriesPortion;
        const eachMeshMatricesPortion = inflatedData.eachMeshMatricesPortion;
        const eachMeshMaterial = inflatedData.eachMeshMaterial;

        const eachEntityId = inflatedData.eachEntityId;
        const eachEntityMeshesPortion = inflatedData.eachEntityMeshesPortion;

        const eachTileAABB = inflatedData.eachTileAABB;
        const eachTileEntitiesPortion = inflatedData.eachTileEntitiesPortion;

        const numGeometries = eachGeometryPositionsPortion.length;
        const numMeshes = eachMeshGeometriesPortion.length;
        const numEntities = eachEntityMeshesPortion.length;
        const numTiles = eachTileEntitiesPortion.length;

        if (metaModel) {
            metaModel.loadData(metadata, {
                includeTypes: options.includeTypes,
                excludeTypes: options.excludeTypes,
                globalizeObjectIds: options.globalizeObjectIds
            }); // Can be empty
        }

        // Count instances of each geometry

        const geometryReuseCounts = new Uint32Array(numGeometries);

        for (let meshIndex = 0; meshIndex < numMeshes; meshIndex++) {
            const geometryIndex = eachMeshGeometriesPortion[meshIndex];
            if (geometryReuseCounts[geometryIndex] !== undefined) {
                geometryReuseCounts[geometryIndex]++;
            } else {
                geometryReuseCounts[geometryIndex] = 1;
            }
        }

        // Iterate over tiles

        const tileCenter = math.vec3();
        const rtcAABB = math.AABB3();

        const geometryArraysCache = {};

        for (let tileIndex = 0; tileIndex < numTiles; tileIndex++) {

            const lastTileIndex = (numTiles - 1);

            const atLastTile = (tileIndex === lastTileIndex);

            const firstTileEntityIndex = eachTileEntitiesPortion [tileIndex];
            const lastTileEntityIndex = atLastTile ? (numEntities - 1) : (eachTileEntitiesPortion[tileIndex + 1] - 1);

            const tileAABBIndex = tileIndex * 6;
            const tileAABB = eachTileAABB.subarray(tileAABBIndex, tileAABBIndex + 6);

            math.getAABB3Center(tileAABB, tileCenter);

            rtcAABB[0] = tileAABB[0] - tileCenter[0];
            rtcAABB[1] = tileAABB[1] - tileCenter[1];
            rtcAABB[2] = tileAABB[2] - tileCenter[2];
            rtcAABB[3] = tileAABB[3] - tileCenter[0];
            rtcAABB[4] = tileAABB[4] - tileCenter[1];
            rtcAABB[5] = tileAABB[5] - tileCenter[2];

            const tileDecodeMatrix = geometryCompressionUtils.createPositionsDecodeMatrix(rtcAABB);

            const geometryCreatedInTile = {};

            // Iterate over each tile's entities

            for (let tileEntityIndex = firstTileEntityIndex; tileEntityIndex <= lastTileEntityIndex; tileEntityIndex++) {

                const xktEntityId = eachEntityId[tileEntityIndex];

                const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;

                const finalTileEntityIndex = (numEntities - 1);
                const atLastTileEntity = (tileEntityIndex === finalTileEntityIndex);
                const firstMeshIndex = eachEntityMeshesPortion [tileEntityIndex];
                const lastMeshIndex = atLastTileEntity ? (eachMeshGeometriesPortion.length - 1) : (eachEntityMeshesPortion[tileEntityIndex + 1] - 1);

                const meshIds = [];

                // @reviser lijuhong 修改获取metaObject代码
                const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
                const entityDefaults = {};
                const meshDefaults = {};

                if (metaObject) {

                    // Mask loading of object types

                    if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                        continue;
                    }

                    if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                        continue;
                    }

                    // Get initial property values for object types

                    const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                    if (props) {
                        if (props.visible === false) {
                            entityDefaults.visible = false;
                        }
                        if (props.pickable === false) {
                            entityDefaults.pickable = false;
                        }
                        if (props.colorize) {
                            meshDefaults.color = props.colorize;
                        }
                        if (props.opacity !== undefined && props.opacity !== null) {
                            meshDefaults.opacity = props.opacity;
                        }
                        if (props.metallic !== undefined && props.metallic !== null) {
                            meshDefaults.metallic = props.metallic;
                        }
                        if (props.roughness !== undefined && props.roughness !== null) {
                            meshDefaults.roughness = props.roughness;
                        }
                    }

                } else {
                    if (options.excludeUnclassifiedObjects) {
                        continue;
                    }
                }

                // Iterate each entity's meshes

                for (let meshIndex = firstMeshIndex; meshIndex <= lastMeshIndex; meshIndex++) {

                    const geometryIndex = eachMeshGeometriesPortion[meshIndex];
                    const geometryReuseCount = geometryReuseCounts[geometryIndex];
                    const isReusedGeometry = (geometryReuseCount > 1);

                    const atLastGeometry = (geometryIndex === (numGeometries - 1));

                    const meshColor = decompressColor$1(eachMeshMaterial.subarray((meshIndex * 6), (meshIndex * 6) + 3));
                    const meshOpacity = eachMeshMaterial[(meshIndex * 6) + 3] / 255.0;
                    const meshMetallic = eachMeshMaterial[(meshIndex * 6) + 4] / 255.0;
                    const meshRoughness = eachMeshMaterial[(meshIndex * 6) + 5] / 255.0;

                    const meshId = manifestCtx.getNextId();

                    if (isReusedGeometry) {

                        // Create mesh for multi-use geometry - create (or reuse) geometry, create mesh using that geometry

                        const meshMatrixIndex = eachMeshMatricesPortion[meshIndex];
                        const meshMatrix = matrices.slice(meshMatrixIndex, meshMatrixIndex + 16);

                        const geometryId = `${modelPartId}-geometry.${tileIndex}.${geometryIndex}`; // These IDs are local to the SceneModel

                        let geometryArrays = geometryArraysCache[geometryId];

                        if (!geometryArrays) {
                            geometryArrays = {
                                batchThisMesh: (!options.reuseGeometries)
                            };
                            const primitiveType = eachGeometryPrimitiveType[geometryIndex];
                            let geometryValid = false;
                            switch (primitiveType) {
                                case 0:
                                    geometryArrays.primitiveName = "solid";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 1:
                                    geometryArrays.primitiveName = "surface";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 2:
                                    geometryArrays.primitiveName = "points";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryColors = colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0);
                                    break;
                                case 3:
                                    geometryArrays.primitiveName = "lines";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                default:
                                    continue;
                            }

                            if (!geometryValid) {
                                geometryArrays = null;
                            }

                            if (geometryArrays) {
                                if (geometryArrays.geometryPositions.length > 1000) ;
                                if (geometryArrays.batchThisMesh) {
                                    geometryArrays.decompressedPositions = new Float32Array(geometryArrays.geometryPositions.length);
                                    geometryArrays.transformedAndRecompressedPositions = new Uint16Array(geometryArrays.geometryPositions.length);
                                    const geometryPositions = geometryArrays.geometryPositions;
                                    const decompressedPositions = geometryArrays.decompressedPositions;
                                    for (let i = 0, len = geometryPositions.length; i < len; i += 3) {
                                        decompressedPositions[i + 0] = geometryPositions[i + 0] * reusedGeometriesDecodeMatrix[0] + reusedGeometriesDecodeMatrix[12];
                                        decompressedPositions[i + 1] = geometryPositions[i + 1] * reusedGeometriesDecodeMatrix[5] + reusedGeometriesDecodeMatrix[13];
                                        decompressedPositions[i + 2] = geometryPositions[i + 2] * reusedGeometriesDecodeMatrix[10] + reusedGeometriesDecodeMatrix[14];
                                    }
                                    geometryArrays.geometryPositions = null;
                                    geometryArraysCache[geometryId] = geometryArrays;
                                }
                            }
                        }

                        if (geometryArrays) {

                            if (geometryArrays.batchThisMesh) {

                                const decompressedPositions = geometryArrays.decompressedPositions;
                                const transformedAndRecompressedPositions = geometryArrays.transformedAndRecompressedPositions;

                                for (let i = 0, len = decompressedPositions.length; i < len; i += 3) {
                                    tempVec4a$1[0] = decompressedPositions[i + 0];
                                    tempVec4a$1[1] = decompressedPositions[i + 1];
                                    tempVec4a$1[2] = decompressedPositions[i + 2];
                                    tempVec4a$1[3] = 1;
                                    math.transformVec4(meshMatrix, tempVec4a$1, tempVec4b$1);
                                    geometryCompressionUtils.compressPosition(tempVec4b$1, rtcAABB, tempVec4a$1);
                                    transformedAndRecompressedPositions[i + 0] = tempVec4a$1[0];
                                    transformedAndRecompressedPositions[i + 1] = tempVec4a$1[1];
                                    transformedAndRecompressedPositions[i + 2] = tempVec4a$1[2];
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    origin: tileCenter,
                                    primitive: geometryArrays.primitiveName,
                                    positionsCompressed: transformedAndRecompressedPositions,
                                    normalsCompressed: geometryArrays.geometryNormals,
                                    colorsCompressed: geometryArrays.geometryColors,
                                    indices: geometryArrays.geometryIndices,
                                    edgeIndices: geometryArrays.geometryEdgeIndices,
                                    positionsDecodeMatrix: tileDecodeMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity
                                }));

                                meshIds.push(meshId);

                            } else {

                                if (!geometryCreatedInTile[geometryId]) {

                                    sceneModel.createGeometry({
                                        id: geometryId,
                                        primitive: geometryArrays.primitiveName,
                                        positionsCompressed: geometryArrays.geometryPositions,
                                        normalsCompressed: geometryArrays.geometryNormals,
                                        colorsCompressed: geometryArrays.geometryColors,
                                        indices: geometryArrays.geometryIndices,
                                        edgeIndices: geometryArrays.geometryEdgeIndices,
                                        positionsDecodeMatrix: reusedGeometriesDecodeMatrix
                                    });

                                    geometryCreatedInTile[geometryId] = true;
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    geometryId: geometryId,
                                    origin: tileCenter,
                                    matrix: meshMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity
                                }));

                                meshIds.push(meshId);
                            }
                        }

                    } else {

                        const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                        let primitiveName;
                        let geometryPositions;
                        let geometryNormals;
                        let geometryColors;
                        let geometryIndices;
                        let geometryEdgeIndices;
                        let geometryValid = false;

                        switch (primitiveType) {
                            case 0:
                                primitiveName = "solid";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 1:
                                primitiveName = "surface";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 2:
                                primitiveName = "points";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryColors = colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0);
                                break;
                            case 3:
                                primitiveName = "lines";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            default:
                                continue;
                        }

                        if (geometryValid) {

                            sceneModel.createMesh(utils.apply(meshDefaults, {
                                id: meshId,
                                origin: tileCenter,
                                primitive: primitiveName,
                                positionsCompressed: geometryPositions,
                                normalsCompressed: geometryNormals,
                                colorsCompressed: geometryColors,
                                indices: geometryIndices,
                                edgeIndices: geometryEdgeIndices,
                                positionsDecodeMatrix: tileDecodeMatrix,
                                color: meshColor,
                                metallic: meshMetallic,
                                roughness: meshRoughness,
                                opacity: meshOpacity
                            }));

                            meshIds.push(meshId);
                        }
                    }
                }

                if (meshIds.length > 0) {

                    sceneModel.createEntity(utils.apply(entityDefaults, {
                        id: entityId,
                        isObject: true,
                        meshIds: meshIds
                    }));
                }
            }
        }
    }

    /** @private */
    const ParserV9 = {
        version: 9,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract$1(elements);
            const inflatedData = inflate$1(deflatedData);
            load$1(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    /*
     Parser for .XKT Format V10
    */

    let pako = window.pako || p;
    if (!pako.inflate) {  // See https://github.com/nodeca/pako/issues/97
        pako = pako.default;
    }

    const tempVec4a = math.vec4();
    const tempVec4b = math.vec4();

    const NUM_TEXTURE_ATTRIBUTES = 9;

    function extract(elements) {

        let i = 0;

        return {
            metadata: elements[i++],
            textureData: elements[i++],
            eachTextureDataPortion: elements[i++],
            eachTextureAttributes: elements[i++],
            positions: elements[i++],
            normals: elements[i++],
            colors: elements[i++],
            uvs: elements[i++],
            indices: elements[i++],
            edgeIndices: elements[i++],
            eachTextureSetTextures: elements[i++],
            matrices: elements[i++],
            reusedGeometriesDecodeMatrix: elements[i++],
            eachGeometryPrimitiveType: elements[i++],
            eachGeometryPositionsPortion: elements[i++],
            eachGeometryNormalsPortion: elements[i++],
            eachGeometryColorsPortion: elements[i++],
            eachGeometryUVsPortion: elements[i++],
            eachGeometryIndicesPortion: elements[i++],
            eachGeometryEdgeIndicesPortion: elements[i++],
            eachMeshGeometriesPortion: elements[i++],
            eachMeshMatricesPortion: elements[i++],
            eachMeshTextureSet: elements[i++],
            eachMeshMaterialAttributes: elements[i++],
            eachEntityId: elements[i++],
            eachEntityMeshesPortion: elements[i++],
            eachTileAABB: elements[i++],
            eachTileEntitiesPortion: elements[i++]
        };
    }

    function inflate(deflatedData) {

        function inflate(array, options) {
            return (array.length === 0) ? [] : pako.inflate(array, options).buffer;
        }

        return {
            metadata: JSON.parse(pako.inflate(deflatedData.metadata, {to: 'string'})),
            textureData: new Uint8Array(inflate(deflatedData.textureData)),  // <<----------------------------- ??? ZIPPing to blame?
            eachTextureDataPortion: new Uint32Array(inflate(deflatedData.eachTextureDataPortion)),
            eachTextureAttributes: new Uint16Array(inflate(deflatedData.eachTextureAttributes)),
            positions: new Uint16Array(inflate(deflatedData.positions)),
            normals: new Int8Array(inflate(deflatedData.normals)),
            colors: new Uint8Array(inflate(deflatedData.colors)),
            uvs: new Float32Array(inflate(deflatedData.uvs)),
            indices: new Uint32Array(inflate(deflatedData.indices)),
            edgeIndices: new Uint32Array(inflate(deflatedData.edgeIndices)),
            eachTextureSetTextures: new Int32Array(inflate(deflatedData.eachTextureSetTextures)),
            matrices: new Float32Array(inflate(deflatedData.matrices)),
            reusedGeometriesDecodeMatrix: new Float32Array(inflate(deflatedData.reusedGeometriesDecodeMatrix)),
            eachGeometryPrimitiveType: new Uint8Array(inflate(deflatedData.eachGeometryPrimitiveType)),
            eachGeometryPositionsPortion: new Uint32Array(inflate(deflatedData.eachGeometryPositionsPortion)),
            eachGeometryNormalsPortion: new Uint32Array(inflate(deflatedData.eachGeometryNormalsPortion)),
            eachGeometryColorsPortion: new Uint32Array(inflate(deflatedData.eachGeometryColorsPortion)),
            eachGeometryUVsPortion: new Uint32Array(inflate(deflatedData.eachGeometryUVsPortion)),
            eachGeometryIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryIndicesPortion)),
            eachGeometryEdgeIndicesPortion: new Uint32Array(inflate(deflatedData.eachGeometryEdgeIndicesPortion)),
            eachMeshGeometriesPortion: new Uint32Array(inflate(deflatedData.eachMeshGeometriesPortion)),
            eachMeshMatricesPortion: new Uint32Array(inflate(deflatedData.eachMeshMatricesPortion)),
            eachMeshTextureSet: new Int32Array(inflate(deflatedData.eachMeshTextureSet)), // Can be -1
            eachMeshMaterialAttributes: new Uint8Array(inflate(deflatedData.eachMeshMaterialAttributes)),
            eachEntityId: JSON.parse(pako.inflate(deflatedData.eachEntityId, {to: 'string'})),
            eachEntityMeshesPortion: new Uint32Array(inflate(deflatedData.eachEntityMeshesPortion)),
            eachTileAABB: new Float64Array(inflate(deflatedData.eachTileAABB)),
            eachTileEntitiesPortion: new Uint32Array(inflate(deflatedData.eachTileEntitiesPortion)),
        };
    }

    const decompressColor = (function () {
        const floatColor = new Float32Array(3);
        return function (intColor) {
            floatColor[0] = intColor[0] / 255.0;
            floatColor[1] = intColor[1] / 255.0;
            floatColor[2] = intColor[2] / 255.0;
            return floatColor;
        };
    })();

    ((function () {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        return function (imagedata) {
            canvas.width = imagedata.width;
            canvas.height = imagedata.height;
            context.putImageData(imagedata, 0, 0);
            return canvas.toDataURL();
        };
    }))();

    function load(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx) {

        const modelPartId = manifestCtx.getNextId();

        const metadata = inflatedData.metadata;
        const textureData = inflatedData.textureData;
        const eachTextureDataPortion = inflatedData.eachTextureDataPortion;
        const eachTextureAttributes = inflatedData.eachTextureAttributes;
        const positions = inflatedData.positions;
        const normals = inflatedData.normals;
        const colors = inflatedData.colors;
        const uvs = inflatedData.uvs;
        const indices = inflatedData.indices;
        const edgeIndices = inflatedData.edgeIndices;
        const eachTextureSetTextures = inflatedData.eachTextureSetTextures;
        const matrices = inflatedData.matrices;
        const reusedGeometriesDecodeMatrix = inflatedData.reusedGeometriesDecodeMatrix;
        const eachGeometryPrimitiveType = inflatedData.eachGeometryPrimitiveType;
        const eachGeometryPositionsPortion = inflatedData.eachGeometryPositionsPortion;
        const eachGeometryNormalsPortion = inflatedData.eachGeometryNormalsPortion;
        const eachGeometryColorsPortion = inflatedData.eachGeometryColorsPortion;
        const eachGeometryUVsPortion = inflatedData.eachGeometryUVsPortion;
        const eachGeometryIndicesPortion = inflatedData.eachGeometryIndicesPortion;
        const eachGeometryEdgeIndicesPortion = inflatedData.eachGeometryEdgeIndicesPortion;
        const eachMeshGeometriesPortion = inflatedData.eachMeshGeometriesPortion;
        const eachMeshMatricesPortion = inflatedData.eachMeshMatricesPortion;
        const eachMeshTextureSet = inflatedData.eachMeshTextureSet;
        const eachMeshMaterialAttributes = inflatedData.eachMeshMaterialAttributes;
        const eachEntityId = inflatedData.eachEntityId;
        const eachEntityMeshesPortion = inflatedData.eachEntityMeshesPortion;
        const eachTileAABB = inflatedData.eachTileAABB;
        const eachTileEntitiesPortion = inflatedData.eachTileEntitiesPortion;

        const numTextures = eachTextureDataPortion.length;
        const numTextureSets = eachTextureSetTextures.length / 5;
        const numGeometries = eachGeometryPositionsPortion.length;
        const numMeshes = eachMeshGeometriesPortion.length;
        const numEntities = eachEntityMeshesPortion.length;
        const numTiles = eachTileEntitiesPortion.length;

        if (metaModel) {
            metaModel.loadData(metadata, {
                includeTypes: options.includeTypes,
                excludeTypes: options.excludeTypes,
                globalizeObjectIds: options.globalizeObjectIds
            }); // Can be empty
        }

        // Create textures

        for (let textureIndex = 0; textureIndex < numTextures; textureIndex++) {
            const atLastTexture = (textureIndex === (numTextures - 1));
            const textureDataPortionStart = eachTextureDataPortion[textureIndex];
            const textureDataPortionEnd = atLastTexture ? textureData.length : (eachTextureDataPortion[textureIndex + 1]);

            const textureDataPortionSize = textureDataPortionEnd - textureDataPortionStart;
            const textureDataPortionExists = (textureDataPortionSize > 0);

            const textureAttrBaseIdx = (textureIndex * NUM_TEXTURE_ATTRIBUTES);

            const compressed = (eachTextureAttributes[textureAttrBaseIdx + 0] === 1);
            const mediaType = eachTextureAttributes[textureAttrBaseIdx + 1];
            eachTextureAttributes[textureAttrBaseIdx + 2];
            eachTextureAttributes[textureAttrBaseIdx + 3];
            const minFilter = eachTextureAttributes[textureAttrBaseIdx + 4];
            const magFilter = eachTextureAttributes[textureAttrBaseIdx + 5]; // LinearFilter | NearestFilter
            const wrapS = eachTextureAttributes[textureAttrBaseIdx + 6]; // ClampToEdgeWrapping | MirroredRepeatWrapping | RepeatWrapping
            const wrapT = eachTextureAttributes[textureAttrBaseIdx + 7]; // ClampToEdgeWrapping | MirroredRepeatWrapping | RepeatWrapping
            const wrapR = eachTextureAttributes[textureAttrBaseIdx + 8]; // ClampToEdgeWrapping | MirroredRepeatWrapping | RepeatWrapping

            if (textureDataPortionExists) {

                const imageDataSubarray = new Uint8Array(textureData.subarray(textureDataPortionStart, textureDataPortionEnd));
                const arrayBuffer = imageDataSubarray.buffer;
                const textureId = `${modelPartId}-texture-${textureIndex}`;

                if (compressed) {

                    sceneModel.createTexture({
                        id: textureId,
                        buffers: [arrayBuffer],
                        minFilter,
                        magFilter,
                        wrapS,
                        wrapT,
                        wrapR
                    });

                } else {

                    const mimeType = mediaType === JPEGMediaType ? "image/jpeg" : (mediaType === PNGMediaType ? "image/png" : "image/gif");
                    const blob = new Blob([arrayBuffer], {type: mimeType});
                    const urlCreator = window.URL || window.webkitURL;
                    const imageUrl = urlCreator.createObjectURL(blob);
                    const img = document.createElement('img');
                    img.src = imageUrl;

                    sceneModel.createTexture({
                        id: textureId,
                        image: img,
                        //mediaType,
                        minFilter,
                        magFilter,
                        wrapS,
                        wrapT,
                        wrapR
                    });
                }
            }
        }

        // Create texture sets

        for (let textureSetIndex = 0; textureSetIndex < numTextureSets; textureSetIndex++) {
            const eachTextureSetTexturesIndex = textureSetIndex * 5;
            const textureSetId = `${modelPartId}-textureSet-${textureSetIndex}`;
            const colorTextureIndex = eachTextureSetTextures[eachTextureSetTexturesIndex + 0];
            const metallicRoughnessTextureIndex = eachTextureSetTextures[eachTextureSetTexturesIndex + 1];
            const normalsTextureIndex = eachTextureSetTextures[eachTextureSetTexturesIndex + 2];
            const emissiveTextureIndex = eachTextureSetTextures[eachTextureSetTexturesIndex + 3];
            const occlusionTextureIndex = eachTextureSetTextures[eachTextureSetTexturesIndex + 4];
            sceneModel.createTextureSet({
                id: textureSetId,
                colorTextureId: colorTextureIndex >= 0 ? `${modelPartId}-texture-${colorTextureIndex}` : null,
                normalsTextureId: normalsTextureIndex >= 0 ? `${modelPartId}-texture-${normalsTextureIndex}` : null,
                metallicRoughnessTextureId: metallicRoughnessTextureIndex >= 0 ? `${modelPartId}-texture-${metallicRoughnessTextureIndex}` : null,
                emissiveTextureId: emissiveTextureIndex >= 0 ? `${modelPartId}-texture-${emissiveTextureIndex}` : null,
                occlusionTextureId: occlusionTextureIndex >= 0 ? `${modelPartId}-texture-${occlusionTextureIndex}` : null
            });
        }

        // Count instances of each geometry

        const geometryReuseCounts = new Uint32Array(numGeometries);

        for (let meshIndex = 0; meshIndex < numMeshes; meshIndex++) {
            const geometryIndex = eachMeshGeometriesPortion[meshIndex];
            if (geometryReuseCounts[geometryIndex] !== undefined) {
                geometryReuseCounts[geometryIndex]++;
            } else {
                geometryReuseCounts[geometryIndex] = 1;
            }
        }

        // Iterate over tiles

        const tileCenter = math.vec3();
        const rtcAABB = math.AABB3();

        const geometryArraysCache = {};

        for (let tileIndex = 0; tileIndex < numTiles; tileIndex++) {

            const lastTileIndex = (numTiles - 1);

            const atLastTile = (tileIndex === lastTileIndex);

            const firstTileEntityIndex = eachTileEntitiesPortion [tileIndex];
            const lastTileEntityIndex = atLastTile ? (numEntities - 1) : (eachTileEntitiesPortion[tileIndex + 1] - 1);

            const tileAABBIndex = tileIndex * 6;
            const tileAABB = eachTileAABB.subarray(tileAABBIndex, tileAABBIndex + 6);

            math.getAABB3Center(tileAABB, tileCenter);

            rtcAABB[0] = tileAABB[0] - tileCenter[0];
            rtcAABB[1] = tileAABB[1] - tileCenter[1];
            rtcAABB[2] = tileAABB[2] - tileCenter[2];
            rtcAABB[3] = tileAABB[3] - tileCenter[0];
            rtcAABB[4] = tileAABB[4] - tileCenter[1];
            rtcAABB[5] = tileAABB[5] - tileCenter[2];

            const tileDecodeMatrix = geometryCompressionUtils.createPositionsDecodeMatrix(rtcAABB);

            const geometryCreatedInTile = {};

            // Iterate over each tile's entities

            for (let tileEntityIndex = firstTileEntityIndex; tileEntityIndex <= lastTileEntityIndex; tileEntityIndex++) {

                const xktEntityId = eachEntityId[tileEntityIndex];

                const entityId = options.globalizeObjectIds ? math.globalizeObjectId(sceneModel.id, xktEntityId) : xktEntityId;

                const finalTileEntityIndex = (numEntities - 1);
                const atLastTileEntity = (tileEntityIndex === finalTileEntityIndex);
                const firstMeshIndex = eachEntityMeshesPortion [tileEntityIndex];
                const lastMeshIndex = atLastTileEntity ? (eachMeshGeometriesPortion.length - 1) : (eachEntityMeshesPortion[tileEntityIndex + 1] - 1);

                const meshIds = [];

                // @reviser lijuhong 修改获取metaObject代码
                const metaObject = metaModel.getMetaObject(entityId);//viewer.metaScene.metaObjects[entityId];
                const entityDefaults = {};
                const meshDefaults = {};

                if (metaObject) {

                    // Mask loading of object types

                    if (options.excludeTypesMap && metaObject.type && options.excludeTypesMap[metaObject.type]) {
                        continue;
                    }

                    if (options.includeTypesMap && metaObject.type && (!options.includeTypesMap[metaObject.type])) {
                        continue;
                    }

                    // Get initial property values for object types

                    const props = options.objectDefaults ? options.objectDefaults[metaObject.type] || options.objectDefaults["DEFAULT"] : null;

                    if (props) {
                        if (props.visible === false) {
                            entityDefaults.visible = false;
                        }
                        if (props.pickable === false) {
                            entityDefaults.pickable = false;
                        }
                        if (props.colorize) {
                            meshDefaults.color = props.colorize;
                        }
                        if (props.opacity !== undefined && props.opacity !== null) {
                            meshDefaults.opacity = props.opacity;
                        }
                        if (props.metallic !== undefined && props.metallic !== null) {
                            meshDefaults.metallic = props.metallic;
                        }
                        if (props.roughness !== undefined && props.roughness !== null) {
                            meshDefaults.roughness = props.roughness;
                        }
                    }

                } else {
                    if (options.excludeUnclassifiedObjects) {
                        continue;
                    }
                }

                // Iterate each entity's meshes

                for (let meshIndex = firstMeshIndex; meshIndex <= lastMeshIndex; meshIndex++) {

                    const geometryIndex = eachMeshGeometriesPortion[meshIndex];
                    const geometryReuseCount = geometryReuseCounts[geometryIndex];
                    const isReusedGeometry = (geometryReuseCount > 1);

                    const atLastGeometry = (geometryIndex === (numGeometries - 1));

                    const textureSetIndex = eachMeshTextureSet[meshIndex];

                    const textureSetId = (textureSetIndex >= 0) ? `${modelPartId}-textureSet-${textureSetIndex}` : null;

                    const meshColor = decompressColor(eachMeshMaterialAttributes.subarray((meshIndex * 6), (meshIndex * 6) + 3));
                    const meshOpacity = eachMeshMaterialAttributes[(meshIndex * 6) + 3] / 255.0;
                    const meshMetallic = eachMeshMaterialAttributes[(meshIndex * 6) + 4] / 255.0;
                    const meshRoughness = eachMeshMaterialAttributes[(meshIndex * 6) + 5] / 255.0;

                    const meshId = manifestCtx.getNextId();

                    if (isReusedGeometry) {

                        // Create mesh for multi-use geometry - create (or reuse) geometry, create mesh using that geometry

                        const meshMatrixIndex = eachMeshMatricesPortion[meshIndex];
                        const meshMatrix = matrices.slice(meshMatrixIndex, meshMatrixIndex + 16);

                        const geometryId = `${modelPartId}-geometry.${tileIndex}.${geometryIndex}`; // These IDs are local to the SceneModel

                        let geometryArrays = geometryArraysCache[geometryId];

                        if (!geometryArrays) {
                            geometryArrays = {
                                batchThisMesh: (!options.reuseGeometries)
                            };
                            const primitiveType = eachGeometryPrimitiveType[geometryIndex];
                            let geometryValid = false;
                            switch (primitiveType) {
                                case 0:
                                    geometryArrays.primitiveName = "solid";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryUVs = uvs.subarray(eachGeometryUVsPortion [geometryIndex], atLastGeometry ? uvs.length : eachGeometryUVsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 1:
                                    geometryArrays.primitiveName = "surface";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryUVs = uvs.subarray(eachGeometryUVsPortion [geometryIndex], atLastGeometry ? uvs.length : eachGeometryUVsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryArrays.geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 2:
                                    geometryArrays.primitiveName = "points";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryColors = colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0);
                                    break;
                                case 3:
                                    geometryArrays.primitiveName = "lines";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                case 4:
                                    geometryArrays.primitiveName = "lines";
                                    geometryArrays.geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                    geometryArrays.geometryIndices = lineStripToLines(
                                        geometryArrays.geometryPositions,
                                        indices.subarray(eachGeometryIndicesPortion [geometryIndex],
                                            atLastGeometry
                                                ? indices.length
                                                : eachGeometryIndicesPortion [geometryIndex + 1]));
                                    geometryValid = (geometryArrays.geometryPositions.length > 0 && geometryArrays.geometryIndices.length > 0);
                                    break;
                                default:
                                    continue;
                            }

                            if (!geometryValid) {
                                geometryArrays = null;
                            }

                            if (geometryArrays) {
                                if (geometryArrays.geometryPositions.length > 1000) ;
                                if (geometryArrays.batchThisMesh) {
                                    geometryArrays.decompressedPositions = new Float32Array(geometryArrays.geometryPositions.length);
                                    geometryArrays.transformedAndRecompressedPositions = new Uint16Array(geometryArrays.geometryPositions.length);
                                    const geometryPositions = geometryArrays.geometryPositions;
                                    const decompressedPositions = geometryArrays.decompressedPositions;
                                    for (let i = 0, len = geometryPositions.length; i < len; i += 3) {
                                        decompressedPositions[i + 0] = geometryPositions[i + 0] * reusedGeometriesDecodeMatrix[0] + reusedGeometriesDecodeMatrix[12];
                                        decompressedPositions[i + 1] = geometryPositions[i + 1] * reusedGeometriesDecodeMatrix[5] + reusedGeometriesDecodeMatrix[13];
                                        decompressedPositions[i + 2] = geometryPositions[i + 2] * reusedGeometriesDecodeMatrix[10] + reusedGeometriesDecodeMatrix[14];
                                    }
                                    geometryArrays.geometryPositions = null;
                                    geometryArraysCache[geometryId] = geometryArrays;
                                }
                            }
                        }

                        if (geometryArrays) {

                            if (geometryArrays.batchThisMesh) {

                                const decompressedPositions = geometryArrays.decompressedPositions;
                                const transformedAndRecompressedPositions = geometryArrays.transformedAndRecompressedPositions;

                                for (let i = 0, len = decompressedPositions.length; i < len; i += 3) {
                                    tempVec4a[0] = decompressedPositions[i + 0];
                                    tempVec4a[1] = decompressedPositions[i + 1];
                                    tempVec4a[2] = decompressedPositions[i + 2];
                                    tempVec4a[3] = 1;
                                    math.transformVec4(meshMatrix, tempVec4a, tempVec4b);
                                    geometryCompressionUtils.compressPosition(tempVec4b, rtcAABB, tempVec4a);
                                    transformedAndRecompressedPositions[i + 0] = tempVec4a[0];
                                    transformedAndRecompressedPositions[i + 1] = tempVec4a[1];
                                    transformedAndRecompressedPositions[i + 2] = tempVec4a[2];
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    textureSetId,
                                    origin: tileCenter,
                                    primitive: geometryArrays.primitiveName,
                                    positionsCompressed: transformedAndRecompressedPositions,
                                    normalsCompressed: geometryArrays.geometryNormals,
                                    uv: geometryArrays.geometryUVs,
                                    colorsCompressed: geometryArrays.geometryColors,
                                    indices: geometryArrays.geometryIndices,
                                    edgeIndices: geometryArrays.geometryEdgeIndices,
                                    positionsDecodeMatrix: tileDecodeMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity
                                }));

                                meshIds.push(meshId);

                            } else {

                                if (!geometryCreatedInTile[geometryId]) {

                                    sceneModel.createGeometry({
                                        id: geometryId,
                                        primitive: geometryArrays.primitiveName,
                                        positionsCompressed: geometryArrays.geometryPositions,
                                        normalsCompressed: geometryArrays.geometryNormals,
                                        uv: geometryArrays.geometryUVs,
                                        colorsCompressed: geometryArrays.geometryColors,
                                        indices: geometryArrays.geometryIndices,
                                        edgeIndices: geometryArrays.geometryEdgeIndices,
                                        positionsDecodeMatrix: reusedGeometriesDecodeMatrix
                                    });

                                    geometryCreatedInTile[geometryId] = true;
                                }

                                sceneModel.createMesh(utils.apply(meshDefaults, {
                                    id: meshId,
                                    geometryId,
                                    textureSetId,
                                    matrix: meshMatrix,
                                    color: meshColor,
                                    metallic: meshMetallic,
                                    roughness: meshRoughness,
                                    opacity: meshOpacity,
                                    origin: tileCenter
                                }));

                                meshIds.push(meshId);
                            }
                        }

                    } else { // Do not reuse geometry

                        const primitiveType = eachGeometryPrimitiveType[geometryIndex];

                        let primitiveName;
                        let geometryPositions;
                        let geometryNormals;
                        let geometryUVs;
                        let geometryColors;
                        let geometryIndices;
                        let geometryEdgeIndices;
                        let geometryValid = false;

                        switch (primitiveType) {
                            case 0:
                                primitiveName = "solid";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryUVs = uvs.subarray(eachGeometryUVsPortion [geometryIndex], atLastGeometry ? uvs.length : eachGeometryUVsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 1:
                                primitiveName = "surface";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryNormals = normals.subarray(eachGeometryNormalsPortion [geometryIndex], atLastGeometry ? normals.length : eachGeometryNormalsPortion [geometryIndex + 1]);
                                geometryUVs = uvs.subarray(eachGeometryUVsPortion [geometryIndex], atLastGeometry ? uvs.length : eachGeometryUVsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryEdgeIndices = edgeIndices.subarray(eachGeometryEdgeIndicesPortion [geometryIndex], atLastGeometry ? edgeIndices.length : eachGeometryEdgeIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 2:
                                primitiveName = "points";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryColors = colors.subarray(eachGeometryColorsPortion [geometryIndex], atLastGeometry ? colors.length : eachGeometryColorsPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0);
                                break;
                            case 3:
                                primitiveName = "lines";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryIndices = indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry ? indices.length : eachGeometryIndicesPortion [geometryIndex + 1]);
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            case 4:
                                primitiveName = "lines";
                                geometryPositions = positions.subarray(eachGeometryPositionsPortion [geometryIndex], atLastGeometry ? positions.length : eachGeometryPositionsPortion [geometryIndex + 1]);
                                geometryIndices = lineStripToLines(
                                    geometryPositions,
                                    indices.subarray(eachGeometryIndicesPortion [geometryIndex], atLastGeometry
                                        ? indices.length
                                        : eachGeometryIndicesPortion [geometryIndex + 1]));
                                geometryValid = (geometryPositions.length > 0 && geometryIndices.length > 0);
                                break;
                            default:
                                continue;
                        }

                        if (geometryValid) {

                            sceneModel.createMesh(utils.apply(meshDefaults, {
                                id: meshId,
                                textureSetId,
                                origin: tileCenter,
                                primitive: primitiveName,
                                positionsCompressed: geometryPositions,
                                normalsCompressed: geometryNormals,
                                uv: geometryUVs && geometryUVs.length > 0 ? geometryUVs : null,
                                colorsCompressed: geometryColors,
                                indices: geometryIndices,
                                edgeIndices: geometryEdgeIndices,
                                positionsDecodeMatrix: tileDecodeMatrix,
                                color: meshColor,
                                metallic: meshMetallic,
                                roughness: meshRoughness,
                                opacity: meshOpacity
                            }));

                            meshIds.push(meshId);
                        }
                    }
                }

                if (meshIds.length > 0) {

                    sceneModel.createEntity(utils.apply(entityDefaults, {
                        id: entityId,
                        isObject: true,
                        meshIds: meshIds
                    }));
                }
            }
        }
    }

    function lineStripToLines(positions, indices) {
        const linesIndices = [];
        if (indices.length > 1) {
            for (let i = 0, len = indices.length - 1; i < len; i++) {
                linesIndices.push(indices[i]);
                linesIndices.push(indices[i + 1]);
            }
        } else if (positions.length > 1) {
            for (let i = 0, len = (positions.length / 3) - 1; i < len; i++) {
                linesIndices.push(i);
                linesIndices.push(i + 1);
            }
        }
        return linesIndices;
    }

    /** @private */
    const ParserV10 = {
        version: 10,
        parse: function (viewer, options, elements, sceneModel, metaModel, manifestCtx) {
            const deflatedData = extract(elements);
            const inflatedData = inflate(deflatedData);
            load(viewer, options, inflatedData, sceneModel, metaModel, manifestCtx);
        }
    };

    const parsers = {};

    parsers[ParserV1.version] = ParserV1;
    parsers[ParserV2.version] = ParserV2;
    parsers[ParserV3.version] = ParserV3;
    parsers[ParserV4.version] = ParserV4;
    parsers[ParserV5.version] = ParserV5;
    parsers[ParserV6.version] = ParserV6;
    parsers[ParserV7.version] = ParserV7;
    parsers[ParserV8.version] = ParserV8;
    parsers[ParserV9.version] = ParserV9;
    parsers[ParserV10.version] = ParserV10;

    /**
     * {@link Viewer} plugin that loads models from xeokit's optimized *````.XKT````* format.
     *
     * <a href="https://xeokit.github.io/xeokit-sdk/examples/index.html#loading_XKT_OTCConferenceCenter"><img src="http://xeokit.io/img/docs/XKTLoaderPlugin/XKTLoaderPlugin.png"></a>
     *
     * [[Run this example](https://xeokit.github.io/xeokit-sdk/examples/index.html#loading_XKT_OTCConferenceCenter)]
     *
     * # Overview
     *
     * * XKTLoaderPlugin is the most efficient way to load high-detail models into xeokit.
     * * An *````.XKT````* file is a single BLOB containing a model, compressed using geometry quantization
     * and [pako](https://nodeca.github.io/pako/).
     * * Supports double-precision coordinates.
     * * Supports compressed textures.
     * * Set the position, scale and rotation of each model as you load it.
     * * Filter which IFC types get loaded.
     * * Configure initial default appearances for IFC types.
     * * Set a custom data source for *````.XKT````* and IFC metadata files.
     * * Option to load multiple copies of the same model, without object ID clashes.
     *
     * # Creating *````.XKT````* Files and Metadata
     *
     * We have several sways to convert your files into XKT. See these tutorials for more info:
     *
     * * [Converting Models to XKT with convert2xkt](https://www.notion.so/xeokit/Converting-Models-to-XKT-with-convert2xkt-fa567843313f4db8a7d6535e76da9380) - how to convert various file formats (glTF, IFC, CityJSON, LAS/LAZ...) to XKT using our nodejs-based converter.
     * * [Converting IFC Models to XKT using 3rd-Party Open Source Tools](https://www.notion.so/xeokit/Converting-IFC-Models-to-XKT-using-3rd-Party-Open-Source-Tools-c373e48bc4094ff5b6e5c5700ff580ee) - how to convert IFC files to XKT using 3rd-party open source CLI tools.
     *
     * # Scene representation
     *
     * When loading a model, XKTLoaderPlugin creates an {@link Entity} that represents the model, which
     * will have {@link Entity#isModel} set ````true```` and will be registered by {@link Entity#id}
     * in {@link Scene#models}. The XKTLoaderPlugin also creates an {@link Entity} for each object within the
     * model. Those Entities will have {@link Entity#isObject} set ````true```` and will be registered
     * by {@link Entity#id} in {@link Scene#objects}.
     *
     * # Metadata
     *
     * Since XKT V8, model metadata is included in the XKT file. If the XKT file has metadata, then loading it creates
     * model metadata components within the Viewer, namely a {@link MetaModel} corresponding to the model {@link Entity},
     * and a {@link MetaObject} for each object {@link Entity}.
     *
     * Each {@link MetaObject} has a {@link MetaObject#type}, which indicates the classification of its corresponding
     * {@link Entity}. When loading metadata, we can also configure XKTLoaderPlugin with a custom lookup table of initial
     * values to set on the properties of each type of {@link Entity}. By default, XKTLoaderPlugin uses its own map of
     * default colors and visibilities for IFC element types.
     *
     * For XKT versions prior to V8, we provided the metadata to XKTLoaderPlugin as an accompanying JSON file to load. We can
     * still do that for all XKT versions, and for XKT V8+ it will override any metadata provided within the XKT file.
     *
     * # Usage
     *
     * In the example below we'll load the Schependomlaan model from a [.XKT file](https://github.com/xeokit/xeokit-sdk/tree/master/examples/models/xkt/schependomlaan).
     *
     * This will create a bunch of {@link Entity}s that represents the model and its objects, along with a {@link MetaModel} and {@link MetaObject}s
     * that hold their metadata.
     *
     * Since this model contains IFC types, the XKTLoaderPlugin will set the initial appearance of each object
     * {@link Entity} according to its IFC type in {@link XKTLoaderPlugin#objectDefaults}.
     *
     * Read more about this example in the user guide on [Viewing BIM Models Offline](https://www.notion.so/xeokit/Viewing-an-IFC-Model-with-xeokit-c373e48bc4094ff5b6e5c5700ff580ee).
     *
     * * [[Run example](https://xeokit.github.io/xeokit-sdk/examples/index.html#BIMOffline_XKT_metadata_Schependomlaan)]
     *
     * ````javascript
     * import {Viewer, XKTLoaderPlugin} from "xeokit-sdk.es.js";
     *
     * //------------------------------------------------------------------------------------------------------------------
     * // 1. Create a Viewer,
     * // 2. Arrange the camera
     * //------------------------------------------------------------------------------------------------------------------
     *
     * // 1
     * const viewer = new Viewer({
     *      canvasId: "myCanvas",
     *      transparent: true
     * });
     *
     * // 2
     * viewer.camera.eye = [-2.56, 8.38, 8.27];
     * viewer.camera.look = [13.44, 3.31, -14.83];
     * viewer.camera.up = [0.10, 0.98, -0.14];
     *
     * //------------------------------------------------------------------------------------------------------------------
     * // 1. Create a XKTLoaderPlugin,
     * // 2. Load a building model and JSON IFC metadata
     * //------------------------------------------------------------------------------------------------------------------
     *
     * // 1
     * const xktLoader = new XKTLoaderPlugin(viewer);
     *
     * // 2
     * const model = xktLoader.load({          // Returns an Entity that represents the model
     *     id: "myModel",
     *     src: "./models/xkt/Schependomlaan.xkt",
     *     edges: true
     * });
     *
     * model.on("loaded", () => {
     *
     *     //--------------------------------------------------------------------------------------------------------------
     *     // 1. Find metadata on the third storey
     *     // 2. Select all the objects in the building's third storey
     *     // 3. Fit the camera to all the objects on the third storey
     *     //--------------------------------------------------------------------------------------------------------------
     *
     *     // 1
     *     const metaModel = viewer.metaScene.metaModels["myModel"];       // MetaModel with ID "myModel"
     *     const metaObject
     *          = viewer.metaScene.metaObjects["0u4wgLe6n0ABVaiXyikbkA"];  // MetaObject with ID "0u4wgLe6n0ABVaiXyikbkA"
     *
     *     const name = metaObject.name;                                   // "01 eerste verdieping"
     *     const type = metaObject.type;                                   // "IfcBuildingStorey"
     *     const parent = metaObject.parent;                               // MetaObject with type "IfcBuilding"
     *     const children = metaObject.children;                           // Array of child MetaObjects
     *     const objectId = metaObject.id;                                 // "0u4wgLe6n0ABVaiXyikbkA"
     *     const objectIds = viewer.metaScene.getObjectIDsInSubtree(objectId);   // IDs of leaf sub-objects
     *     const aabb = viewer.scene.getAABB(objectIds);                   // Axis-aligned boundary of the leaf sub-objects
     *
     *     // 2
     *     viewer.scene.setObjectsSelected(objectIds, true);
     *
     *     // 3
     *     viewer.cameraFlight.flyTo(aabb);
     * });
     *
     * // Find the model Entity by ID
     * model = viewer.scene.models["myModel"];
     *
     * // Destroy the model
     * model.destroy();
     * ````
     *
     * # Loading XKT files containing textures
     *
     * XKTLoaderPlugin uses a {@link KTX2TextureTranscoder} to load textures in XKT files (XKT v10+). An XKTLoaderPlugin has its own
     * default KTX2TextureTranscoder, configured to load the Basis Codec from the CDN. If we wish, we can override that with our own
     * KTX2TextureTranscoder instance that's configured to load the Codec locally.
     *
     * In the example below, we'll create a {@link Viewer} and add an XKTLoaderPlugin
     * configured with a KTX2TextureTranscoder that finds the Codec in our local file system. Then we'll use the
     * XKTLoaderPlugin to load an XKT file that contains KTX2 textures, which the plugin will transcode using
     * its KTX2TextureTranscoder.
     *
     * We'll configure our KTX2TextureTranscoder to load the Basis Codec from a local directory. If we were happy with loading the
     * Codec from our CDN (ie. our app will always have an Internet connection) then we could just leave out the
     * KTX2TextureTranscoder altogether, and let the XKTLoaderPlugin use its internal default KTX2TextureTranscoder, which is configured to
     * load the Codec from the CDN. We'll stick with loading our own Codec, in case we want to run our app without an Internet connection.
     *
     * <a href="https://xeokit.github.io/xeokit-sdk/examples/buildings/#xkt_vbo_textures_HousePlan"><img src="https://xeokit.github.io/xeokit-sdk/assets/images/xktWithTextures.png"></a>
     *
     * * [[Run this example](https://xeokit.github.io/xeokit-sdk/examples/buildings/#xkt_vbo_textures_HousePlan)]
     *
     * ````javascript
     * const viewer = new Viewer({
     *     canvasId: "myCanvas",
     *     transparent: true
     * });
     *
     * viewer.camera.eye = [-2.56, 8.38, 8.27];
     * viewer.camera.look = [13.44, 3.31, -14.83];
     * viewer.camera.up = [0.10, 0.98, -0.14];
     *
     * const textureTranscoder = new KTX2TextureTranscoder({
     *     viewer,
     *     transcoderPath: "https://cdn.jsdelivr.net/npm/@xeokit/xeokit-sdk/dist/basis/" // <------ Path to Basis Universal transcoder
     * });
     *
     * const xktLoader = new XKTLoaderPlugin(viewer, {
     *     textureTranscoder // <<------------- Transcodes KTX2 textures in XKT files
     * });
     *
     * const sceneModel = xktLoader.load({
     *     id: "myModel",
     *     src: "./HousePlan.xkt" // <<------ XKT file with KTX2 textures
     * });
     * ````
     *
     * # Transforming
     *
     * We have the option to rotate, scale and translate each  *````.XKT````* model as we load it.
     *
     * This lets us load multiple models, or even multiple copies of the same model, and position them apart from each other.
     *
     * In the example below, we'll scale our model to half its size, rotate it 90 degrees about its local X-axis, then
     * translate it 100 units along its X axis.
     *
     * ````javascript
     * xktLoader.load({
     *      src: "./models/xkt/Duplex.ifc.xkt",
     *      rotation: [90,0,0],
     *      scale: [0.5, 0.5, 0.5],
     *      position: [100, 0, 0]
     * });
     * ````
     *
     * # Including and excluding IFC types
     *
     * We can also load only those objects that have the specified IFC types.
     *
     * In the example below, we'll load only the objects that represent walls.
     *
     * ````javascript
     * const model2 = xktLoader.load({
     *     id: "myModel2",
     *     src: "./models/xkt/OTCConferenceCenter.xkt",
     *     includeTypes: ["IfcWallStandardCase"]
     * });
     * ````
     *
     * We can also load only those objects that **don't** have the specified IFC types.
     *
     * In the example below, we'll load only the objects that do not represent empty space.
     *
     * ````javascript
     * const model3 = xktLoader.load({
     *     id: "myModel3",
     *     src: "./models/xkt/OTCConferenceCenter.xkt",
     *     excludeTypes: ["IfcSpace"]
     * });
     * ````
     *
     * # Configuring initial IFC object appearances
     *
     * We can specify the custom initial appearance of loaded objects according to their IFC types.
     *
     * This is useful for things like:
     *
     * * setting the colors to our objects according to their IFC types,
     * * automatically hiding ````IfcSpace```` objects, and
     * * ensuring that ````IfcWindow```` objects are always transparent.
     * <br>
     * In the example below, we'll load a model, while configuring ````IfcSpace```` elements to be always initially invisible,
     * and ````IfcWindow```` types to be always translucent blue.
     *
     * ````javascript
     * const myObjectDefaults = {
     *
     *      IfcSpace: {
     *          visible: false
     *      },
     *      IfcWindow: {
     *          colorize: [0.337255, 0.303922, 0.870588], // Blue
     *          opacity: 0.3
     *      },
     *
     *      //...
     *
     *      DEFAULT: {
     *          colorize: [0.5, 0.5, 0.5]
     *      }
     * };
     *
     * const model4 = xktLoader.load({
     *      id: "myModel4",
     *      src: "./models/xkt/Duplex.ifc.xkt",
     *      objectDefaults: myObjectDefaults // Use our custom initial default states for object Entities
     * });
     * ````
     *
     * When we don't customize the appearance of IFC types, as just above, then IfcSpace elements tend to obscure other
     * elements, which can be confusing.
     *
     * It's often helpful to make IfcSpaces transparent and unpickable, like this:
     *
     * ````javascript
     * const xktLoader = new XKTLoaderPlugin(viewer, {
     *    objectDefaults: {
     *        IfcSpace: {
     *            pickable: false,
     *            opacity: 0.2
     *        }
     *    }
     * });
     * ````
     *
     * Alternatively, we could just make IfcSpaces invisible, which also makes them unpickable:
     *
     * ````javascript
     * const xktLoader = new XKTLoaderPlugin(viewer, {
     *    objectDefaults: {
     *        IfcSpace: {
     *            visible: false
     *        }
     *    }
     * });
     * ````
     *
     * # Configuring a custom data source
     *
     * By default, XKTLoaderPlugin will load *````.XKT````* files and metadata JSON over HTTP.
     *
     * In the example below, we'll customize the way XKTLoaderPlugin loads the files by configuring it with our own data source
     * object. For simplicity, our custom data source example also uses HTTP, using a couple of xeokit utility functions.
     *
     * ````javascript
     * import {utils} from "xeokit-sdk.es.js";
     *
     * class MyDataSource {
     *
     *      constructor() {
     *      }
     *
     *      // Gets metamodel JSON
     *      getMetaModel(metaModelSrc, ok, error) {
     *          console.log("MyDataSource#getMetaModel(" + metaModelSrc + ", ... )");
     *          utils.loadJSON(metaModelSrc,
     *              (json) => {
     *                  ok(json);
     *              },
     *              function (errMsg) {
     *                  error(errMsg);
     *              });
     *      }
     *
     *      // Gets the contents of the given .XKT file in an arraybuffer
     *      getXKT(src, ok, error) {
     *          console.log("MyDataSource#getXKT(" + xKTSrc + ", ... )");
     *          utils.loadArraybuffer(src,
     *              (arraybuffer) => {
     *                  ok(arraybuffer);
     *              },
     *              function (errMsg) {
     *                  error(errMsg);
     *              });
     *      }
     * }
     *
     * const xktLoader2 = new XKTLoaderPlugin(viewer, {
     *       dataSource: new MyDataSource()
     * });
     *
     * const model5 = xktLoader2.load({
     *      id: "myModel5",
     *      src: "./models/xkt/Duplex.ifc.xkt"
     * });
     * ````
     *
     * # Loading multiple copies of a model, without object ID clashes
     *
     * Sometimes we need to load two or more instances of the same model, without having clashes
     * between the IDs of the equivalent objects in the model instances.
     *
     * As shown in the example below, we do this by setting {@link XKTLoaderPlugin#globalizeObjectIds} ````true```` before we load our models.
     *
     * * [[Run example](https://xeokit.github.io/xeokit-sdk/examples/index.html#TreeViewPlugin_Containment_MultipleModels)]
     *
     * ````javascript
     * xktLoader.globalizeObjectIds = true;
     *
     * const model = xktLoader.load({
     *      id: "model1",
     *      src: "./models/xkt/Schependomlaan.xkt"
     * });
     *
     * const model2 = xktLoader.load({
     *    id: "model2",
     *    src: "./models/xkt/Schependomlaan.xkt"
     * });
     * ````
     *
     * For each {@link Entity} loaded by these two calls, {@link Entity#id} and {@link MetaObject#id} will get prefixed by
     * the ID of their model, in order to avoid ID clashes between the two models.
     *
     * An Entity belonging to the first model will get an ID like this:
     *
     * ````
     * myModel1#0BTBFw6f90Nfh9rP1dlXrb
     * ````
     *
     * The equivalent Entity in the second model will get an ID like this:
     *
     * ````
     * myModel2#0BTBFw6f90Nfh9rP1dlXrb
     * ````
     *
     * Now, to update the visibility of both of those Entities collectively, using {@link Scene#setObjectsVisible}, we can
     * supply just the IFC product ID part to that method:
     *
     * ````javascript
     * myViewer.scene.setObjectVisibilities("0BTBFw6f90Nfh9rP1dlXrb", true);
     * ````
     *
     * The method, along with {@link Scene#setObjectsXRayed}, {@link Scene#setObjectsHighlighted} etc, will internally expand
     * the given ID to refer to the instances of that Entity in both models.
     *
     * We can also, of course, reference each Entity directly, using its globalized ID:
     *
     * ````javascript
     * myViewer.scene.setObjectVisibilities("myModel1#0BTBFw6f90Nfh9rP1dlXrb", true);
     *````
     *
     * We can also provide an HTTP URL to the XKT file:
     *
     * ````javascript
     * const sceneModel = xktLoader.load({
     *   manifestSrc: "https://xeokit.github.io/xeokit-sdk/assets/models/models/xkt/Schependomlaan.xkt",
     *   id: "myModel",
     * });
     * ````
     *
     * # Loading a model from a manifest of XKT files
     *
     * The `ifc2gltf` tool from Creoox, which converts IFC files into glTF geometry and JSON metadata files, has the option to
     * split its output into multiple pairs of glTF and JSON files, accompanied by a JSON manifest that lists the files.
     *
     * To integrate with that option, the `convert2xkt` tool, which converts glTF geometry and JSON metadata files into XKT files,
     * also has the option to batch-convert the glTF+JSON files in the manifest, in one invocation.
     *
     * When we use this option, convert2xkt will output a bunch of XKT files, along with a JSON manifest file that lists those XKT files.
     *
     * Working down the pipeline, the XKTLoaderPlugin has the option batch-load all XKT files listed in that manifest
     * into a xeokit Viewer in one load operation, combining the XKT files into a single SceneModel and MetaModel.
     *
     * You can learn more about this conversion and loading process, with splitting, batch converting and batch loading,
     * in [this tutorial](https://www.notion.so/xeokit/Importing-Huge-IFC-Models-as-Multiple-XKT-Files-165fc022e94742cf966ee50003572259).
     *
     * To show how to use XKTLoaderPlugin to load a manifest of XKT files, let's imagine that we have a set of such XKT files. As
     * described in the tutorial, they were converted by `ifc2gltf` from an IFC file into a set of glTF+JSON files, that were
     * then converted by convert2xkt into this set of XKT files and a manifest, as shown below.
     *
     * ````bash
     * ./
     * ├── model_1.xkt
     * ├── model_2.xkt
     * ├── model_3.xkt
     * ├── model_4..xkt
     * └── model.xkt.manifest.json
     * ````
     *
     * The `model.xkt.manifest.json` XKT manifest would look something like this:
     *
     * ````json
     * {
     *   "inputFile": null,
     *   "converterApplication": "convert2xkt",
     *   "converterApplicationVersion": "v1.1.9",
     *   "conversionDate": "10-08-2023- 02-05-01",
     *   "outputDir": null,
     *   "xktFiles": [
     *     "model_1.xkt",
     *     "model_2.xkt",
     *     "model_3.xkt",
     *     "model_4.xkt"
     *   ]
     * }
     * ````
     *
     * Now, to load all those XKT files into a single SceneModel and MetaModel in one operation, we pass a path to the XKT
     * manifest to `XKTLoaderPlugin.load`, as shown in the example below:
     *
     * * [[Run example](https://xeokit.github.io/xeokit-sdk/examples/buildings/#xkt_manifest_KarhumakiBridge)]
     *
     * ````javascript
     * import {
     *   Viewer,
     *   XKTLoaderPlugin,
     *   TreeViewPlugin,
     * } from "xeokit-sdk.es.js";
     *
     * const viewer = new Viewer({
     *   canvasId: "myCanvas"
     * });
     *
     * viewer.scene.camera.eye = [26.54, 29.29, 36.20,];
     * viewer.scene.camera.look = [-23.51, -8.26, -21.65,];
     * viewer.scene.camera.up = [-0.2, 0.89, -0.33,];
     *
     * const xktLoader = new XKTLoaderPlugin(viewer);
     *
     * const sceneModel = xktLoader.load({
     *   manifestSrc: "model.xkt.manifest.json",
     *   id: "myModel",
     * });
     *
     * const metaModel = viewer.metaScene.metaModels[sceneModel.id];
     *
     * // Then when we need to, we can destroy the SceneModel
     * // and MetaModel in one shot, like so:
     *
     * sceneModel.destroy();
     * metaModel.destroy();
     * ````
     *
     * The main advantage here, of splitting IFC files like this within the conversion and import pipeline,
     * is to reduce the memory pressure on each of the `ifc2gltf`, `convert2xkt` and XKTLoaderPlugin components.
     * They work much reliably (and faster) when processing smaller files (eg. 20MB) than when processing large files (eg. 500MB), where
     * they have less trouble allocating the system memory they need for conversion and parsing.
     *
     * We can also provide an HTTP URL to the manifest:
     *
     * ````javascript
     * const sceneModel = xktLoader.load({
     *   manifestSrc: "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model.xkt.manifest.json",
     *   id: "myModel",
     * });
     * ````
     *
     * We can also provide the manifest as parameter object:
     *
     * ````javascript
     * const sceneModel = xktLoader.load({
     *   id: "myModel",
     *   manifest: {
     *   inputFile: "assets/models/gltf/Karhumaki/model.glb.manifest.json",
     *   converterApplication: "convert2xkt",
     *   converterApplicationVersion: "v1.1.10",
     *   conversionDate": "09-11-2023- 18-29-01",
     *     xktFiles: [
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_1.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_2.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_3.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_4.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_5.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_6.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_7.xkt",
     *       "../../assets/models/xkt/v10/split/Karhumaki-Bridge/model_8.xkt"
     *     ]
     *   }
     * });
     * ````
     *
     * We can also provide the paths to the XKT files as HTTP URLs:
     *
     * ````javascript
     * const sceneModel = xktLoader.load({
     *   id: "myModel",
     *   manifest: {
     *   inputFile: "assets/models/gltf/Karhumaki/model.glb.manifest.json",
     *   converterApplication: "convert2xkt",
     *   converterApplicationVersion: "v1.1.10",
     *   conversionDate": "09-11-2023- 18-29-01",
     *     xktFiles: [
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_1.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_2.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_3.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_4.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_5.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_6.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_7.xkt",
     *       "https://xeokit.github.io/xeokit-sdk/assets/models/xkt/v10/split/Karhumaki-Bridge/model_8.xkt"
     *     ]
     *   }
     * });
     * ````
     *
     * @class XKTLoaderPlugin
     */
    class XKTLoaderPlugin extends Plugin {

        /**
         * @constructor
         *
         * @param {Viewer} viewer The Viewer.
         * @param {Object} cfg  Plugin configuration.
         * @param {String} [cfg.id="XKTLoader"] Optional ID for this plugin, so that we can find it within {@link Viewer#plugins}.
         * @param {Object} [cfg.objectDefaults] Map of initial default states for each loaded {@link Entity} that represents an object.  Default value is {@link IFCObjectDefaults}.
         * @param {Object} [cfg.dataSource] A custom data source through which the XKTLoaderPlugin can load model and metadata files. Defaults to an instance of {@link XKTDefaultDataSource}, which loads uover HTTP.
         * @param {String[]} [cfg.includeTypes] When loading metadata, only loads objects that have {@link MetaObject}s with {@link MetaObject#type} values in this list.
         * @param {String[]} [cfg.excludeTypes] When loading metadata, never loads objects that have {@link MetaObject}s with {@link MetaObject#type} values in this list.
         * @param {Boolean} [cfg.excludeUnclassifiedObjects=false] When loading metadata and this is ````true````, will only load {@link Entity}s that have {@link MetaObject}s (that are not excluded). This is useful when we don't want Entitys in the Scene that are not represented within IFC navigation components, such as {@link TreeViewPlugin}.
         * @param {Boolean} [cfg.reuseGeometries=true] Indicates whether to enable geometry reuse (````true```` by default) or whether to internally expand
         * all geometry instances into batches (````false````), and not use instancing to render them. Setting this ````false```` can significantly
         * improve Viewer performance for models that have a lot of geometry reuse, but may also increase the amount of
         * browser and GPU memory they require. See [#769](https://github.com/xeokit/xeokit-sdk/issues/769) for more info.
         * @param {Number} [cfg.maxGeometryBatchSize=50000000] Maximum geometry batch size, as number of vertices. This is optionally supplied
         * to limit the size of the batched geometry arrays that {@link SceneModel} internally creates for batched geometries.
         * A low value means less heap allocation/de-allocation while loading batched geometries, but more draw calls and
         * slower rendering speed. A high value means larger heap allocation/de-allocation while loading, but less draw calls
         * and faster rendering speed. It's recommended to keep this somewhere roughly between ````50000```` and ````50000000```.
         * @param {KTX2TextureTranscoder} [cfg.textureTranscoder] Transcoder used internally to transcode KTX2
         * textures within the XKT. Only required when the XKT is version 10 or later, and contains KTX2 textures.
         */
        // @reviser lijuhong 移除参数viewer
        constructor(cfg = {}) {

            super("XKTLoader", undefined, cfg);

            this._maxGeometryBatchSize = cfg.maxGeometryBatchSize;

            this.textureTranscoder = cfg.textureTranscoder;
            this.dataSource = cfg.dataSource;
            this.objectDefaults = cfg.objectDefaults;
            this.includeTypes = cfg.includeTypes;
            this.excludeTypes = cfg.excludeTypes;
            this.excludeUnclassifiedObjects = cfg.excludeUnclassifiedObjects;
            this.reuseGeometries = cfg.reuseGeometries;
        }

        /**
         * Gets the ````.xkt```` format versions supported by this XKTLoaderPlugin/
         * @returns {string[]}
         */
        get supportedVersions() {
            return Object.keys(parsers);
        }

        /**
         * Gets the texture transcoder.
         *
         * @type {TextureTranscoder}
         */
        get textureTranscoder() {
            return this._textureTranscoder;
        }

        /**
         * Sets the texture transcoder.
         *
         * @type {TextureTranscoder}
         */
        set textureTranscoder(textureTranscoder) {
            this._textureTranscoder = textureTranscoder;
        }

        /**
         * Gets the custom data source through which the XKTLoaderPlugin can load models and metadata.
         *
         * Default value is {@link XKTDefaultDataSource}, which loads via HTTP.
         *
         * @type {Object}
         */
        get dataSource() {
            return this._dataSource;
        }

        /**
         * Sets a custom data source through which the XKTLoaderPlugin can load models and metadata.
         *
         * Default value is {@link XKTDefaultDataSource}, which loads via HTTP.
         *
         * @type {Object}
         */
        set dataSource(value) {
            this._dataSource = value || new XKTDefaultDataSource();
        }

        /**
         * Gets map of initial default states for each loaded {@link Entity} that represents an object.
         *
         * Default value is {@link IFCObjectDefaults}.
         *
         * @type {{String: Object}}
         */
        get objectDefaults() {
            return this._objectDefaults;
        }

        /**
         * Sets map of initial default states for each loaded {@link Entity} that represents an object.
         *
         * Default value is {@link IFCObjectDefaults}.
         *
         * @type {{String: Object}}
         */
        set objectDefaults(value) {
            this._objectDefaults = value || IFCObjectDefaults;
        }

        /**
         * Gets the whitelist of the IFC types loaded by this XKTLoaderPlugin.
         *
         * When loading models with metadata, causes this XKTLoaderPlugin to only load objects whose types are in this
         * list. An object's type is indicated by its {@link MetaObject}'s {@link MetaObject#type}.
         *
         * Default value is ````undefined````.
         *
         * @type {String[]}
         */
        get includeTypes() {
            return this._includeTypes;
        }

        /**
         * Sets the whitelist of the IFC types loaded by this XKTLoaderPlugin.
         *
         * When loading models with metadata, causes this XKTLoaderPlugin to only load objects whose types are in this
         * list. An object's type is indicated by its {@link MetaObject}'s {@link MetaObject#type}.
         *
         * Default value is ````undefined````.
         *
         * @type {String[]}
         */
        set includeTypes(value) {
            this._includeTypes = value;
        }

        /**
         * Gets the blacklist of IFC types that are never loaded by this XKTLoaderPlugin.
         *
         * When loading models with metadata, causes this XKTLoaderPlugin to **not** load objects whose types are in this
         * list. An object's type is indicated by its {@link MetaObject}'s {@link MetaObject#type}.
         *
         * Default value is ````undefined````.
         *
         * @type {String[]}
         */
        get excludeTypes() {
            return this._excludeTypes;
        }

        /**
         * Sets the blacklist of IFC types that are never loaded by this XKTLoaderPlugin.
         *
         * When loading models with metadata, causes this XKTLoaderPlugin to **not** load objects whose types are in this
         * list. An object's type is indicated by its {@link MetaObject}'s {@link MetaObject#type}.
         *
         * Default value is ````undefined````.
         *
         * @type {String[]}
         */
        set excludeTypes(value) {
            this._excludeTypes = value;
        }

        /**
         * Gets whether we load objects that don't have IFC types.
         *
         * When loading models with metadata and this is ````true````, XKTLoaderPlugin will not load objects
         * that don't have IFC types.
         *
         * Default value is ````false````.
         *
         * @type {Boolean}
         */
        get excludeUnclassifiedObjects() {
            return this._excludeUnclassifiedObjects;
        }

        /**
         * Sets whether we load objects that don't have IFC types.
         *
         * When loading models with metadata and this is ````true````, XKTLoaderPlugin will not load objects
         * that don't have IFC types.
         *
         * Default value is ````false````.
         *
         * @type {Boolean}
         */
        set excludeUnclassifiedObjects(value) {
            this._excludeUnclassifiedObjects = !!value;
        }

        /**
         * Gets whether XKTLoaderPlugin globalizes each {@link Entity#id} and {@link MetaObject#id} as it loads a model.
         *
         * Default value is ````false````.
         *
         * @type {Boolean}
         */
        get globalizeObjectIds() {
            return this._globalizeObjectIds;
        }

        /**
         * Sets whether XKTLoaderPlugin globalizes each {@link Entity#id} and {@link MetaObject#id} as it loads a model.
         *
         * Set  this ````true```` when you need to load multiple instances of the same model, to avoid ID clashes
         * between the objects in the different instances.
         *
         * When we load a model with this set ````true````, then each {@link Entity#id} and {@link MetaObject#id} will be
         * prefixed by the ID of the model, ie. ````<modelId>#<objectId>````.
         *
         * {@link Entity#originalSystemId} and {@link MetaObject#originalSystemId} will always hold the original, un-prefixed, ID values.
         *
         * Default value is ````false````.
         *
         * See the main {@link XKTLoaderPlugin} class documentation for usage info.
         *
         * @type {Boolean}
         */
        set globalizeObjectIds(value) {
            this._globalizeObjectIds = !!value;
        }

        /**
         * Gets whether XKTLoaderPlugin enables geometry reuse when loading models.
         *
         * Default value is ````true````.
         *
         * @type {Boolean}
         */
        get reuseGeometries() {
            return this._reuseGeometries;
        }

        /**
         * Sets whether XKTLoaderPlugin enables geometry reuse when loading models.
         *
         * Default value is ````true````.
         *
         * Geometry reuse saves memory, but can impact Viewer performance when there are many reused geometries. For
         * this reason, we can set this ````false```` to disable geometry reuse for models loaded by this XKTLoaderPlugin
         * (which will then "expand" the geometry instances into batches instead).
         *
         * The result will be be less WebGL draw calls (which are expensive), at the cost of increased memory footprint.
         *
         * See [#769](https://github.com/xeokit/xeokit-sdk/issues/769) for more info.
         *
         * @type {Boolean}
         */
        set reuseGeometries(value) {
            this._reuseGeometries = value !== false;
        }

        /**
         * Loads an ````.xkt```` model into this XKTLoaderPlugin's {@link Viewer}.
         *
         * Since xeokit/xeokit-sdk 1.9.0, XKTLoaderPlugin has supported XKT 8, which bundles the metamodel
         * data (eg. an IFC element hierarchy) in the XKT file itself. For XKT 8, we therefore no longer need to
         * load the metamodel data from a separate accompanying JSON file, as we did with previous XKT versions.
         * However, if we do choose to specify a separate metamodel JSON file to load (eg. for backward compatibility
         * in data pipelines), then that metamodel will be loaded and the metamodel in the XKT 8 file will be ignored.
         *
         * @param {*} params Loading parameters.
         * @param {String} [params.id] ID to assign to the root {@link Entity#id}, unique among all components in the Viewer's {@link Scene}, generated automatically by default.
         * @param {String} [params.src] Path or URL to an *````.xkt````* file, as an alternative to the ````xkt```` parameter.
         * @param {ArrayBuffer} [params.xkt] The *````.xkt````* file data, as an alternative to the ````src```` parameter.
         * @param {String} [params.metaModelSrc] Path or URL to an optional metadata file, as an alternative to the ````metaModelData```` parameter.
         * @param {*} [params.metaModelData] JSON model metadata, as an alternative to the ````metaModelSrc```` parameter.
         * @param {String} [params.manifestSrc] Path or URL to a JSON manifest file that provides paths to ````.xkt```` files to load as parts of the model. Use this option to load models that have been split into
         * multiple XKT files. See [tutorial](https://www.notion.so/xeokit/Automatically-Splitting-Large-Models-for-Better-Performance-165fc022e94742cf966ee50003572259) for more info.
         * @param {Object} [params.manifest] A JSON manifest object (as an alternative to a path or URL) that provides paths to ````.xkt```` files to load as parts of the model. Use this option to load models that have been split into
         * multiple XKT files. See [tutorial](https://www.notion.so/xeokit/Automatically-Splitting-Large-Models-for-Better-Performance-165fc022e94742cf966ee50003572259) for more info.
         * @param {{String:Object}} [params.objectDefaults] Map of initial default states for each loaded {@link Entity} that represents an object. Default value is {@link IFCObjectDefaults}.
         * @param {String[]} [params.includeTypes] When loading metadata, only loads objects that have {@link MetaObject}s with {@link MetaObject#type} values in this list.
         * @param {String[]} [params.excludeTypes] When loading metadata, never loads objects that have {@link MetaObject}s with {@link MetaObject#type} values in this list.
         * @param {Boolean} [params.edges=false] Whether or not xeokit renders the model with edges emphasized.
         * @param {Number[]} [params.origin=[0,0,0]] The model's World-space double-precision 3D origin. Use this to position the model within xeokit's World coordinate system, using double-precision coordinates.
         * @param {Number[]} [params.position=[0,0,0]] The model single-precision 3D position, relative to the ````origin```` parameter.
         * @param {Number[]} [params.scale=[1,1,1]] The model's scale.
         * @param {Number[]} [params.rotation=[0,0,0]] The model's orientation, given as Euler angles in degrees, for each of the X, Y and Z axis.
         * @param {Number[]} [params.matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]] The model's world transform matrix. Overrides the position, scale and rotation parameters. Relative to ````origin````.
         * @param {Boolean} [params.edges=false] Indicates if the model's edges are initially emphasized.
         * @param {Boolean} [params.saoEnabled=true] Indicates if Scalable Ambient Obscurance (SAO) is enabled for the model. SAO is configured by the Scene's {@link SAO} component. Only works when {@link SAO#enabled} is also ````true````
         * @param {Boolean} [params.pbrEnabled=true] Indicates if physically-based rendering (PBR) is enabled for the model. Overrides ````colorTextureEnabled````. Only works when {@link Scene#pbrEnabled} is also ````true````.
         * @param {Boolean} [params.colorTextureEnabled=true] Indicates if base color texture rendering is enabled for the model. Overridden by ````pbrEnabled````.  Only works when {@link Scene#colorTextureEnabled} is also ````true````.
         * @param {Number} [params.backfaces=false] When we set this ````true````, then we force rendering of backfaces for the model. When
         * we leave this ````false````, then we allow the Viewer to decide when to render backfaces. In that case, the
         * Viewer will hide backfaces on watertight meshes, show backfaces on open meshes, and always show backfaces on meshes when we slice them open with {@link SectionPlane}s.
         * @param {Boolean} [params.excludeUnclassifiedObjects=false] When loading metadata and this is ````true````, will only load {@link Entity}s that have {@link MetaObject}s (that are not excluded). This is useful when we don't want Entitys in the Scene that are not represented within IFC navigation components, such as {@link TreeViewPlugin}.
         * @param {Boolean} [params.globalizeObjectIds=false] Indicates whether to globalize each {@link Entity#id} and {@link MetaObject#id}, in case you need to prevent ID clashes with other models. See {@link XKTLoaderPlugin#globalizeObjectIds} for more info.
         * @param {Boolean} [params.reuseGeometries=true] Indicates whether to enable geometry reuse (````true```` by default) or whether to expand
         * all geometry instances into batches (````false````), and not use instancing to render them. Setting this ````false```` can significantly
         * improve Viewer performance for models that have excessive geometry reuse, but may also increases the amount of
         * browser and GPU memory used by the model. See [#769](https://github.com/xeokit/xeokit-sdk/issues/769) for more info.
         * @param {Boolean} [params.dtxEnabled=true] When ````true```` (default) use data textures (DTX), where appropriate, to
         * represent the returned model. Set false to always use vertex buffer objects (VBOs). Note that DTX is only applicable
         * to non-textured triangle meshes, and that VBOs are always used for meshes that have textures, line segments, or point
         * primitives. Only works while {@link DTX#enabled} is also ````true````.
         * @returns {Entity} Entity representing the model, which will have {@link Entity#isModel} set ````true```` and will be registered by {@link Entity#id} in {@link Scene#models}.
         */
        // @reviser lijuhong 添加onLoad、onError回调参数
        load(params = {}, onLoad, onError) {

            // @reivser lijuhong 注释viewer相关代码
            // if (params.id && this.viewer.scene.components[params.id]) {
            //     this.error("Component with this ID already exists in viewer: " + params.id + " - will autogenerate this ID");
            //     delete params.id;
            // }

            if (!params.src && !params.xkt && !params.manifestSrc && !params.manifest) {
                this.error("load() param expected: src, xkt, manifestSrc or manifestData");
                return sceneModel; // Return new empty model
            }

            const options = {};
            const includeTypes = params.includeTypes || this._includeTypes;
            const excludeTypes = params.excludeTypes || this._excludeTypes;
            const objectDefaults = params.objectDefaults || this._objectDefaults;

            options.reuseGeometries = (params.reuseGeometries !== null && params.reuseGeometries !== undefined) ? params.reuseGeometries : (this._reuseGeometries !== false);

            if (includeTypes) {
                options.includeTypesMap = {};
                for (let i = 0, len = includeTypes.length; i < len; i++) {
                    options.includeTypesMap[includeTypes[i]] = true;
                }
            }

            if (excludeTypes) {
                options.excludeTypesMap = {};
                for (let i = 0, len = excludeTypes.length; i < len; i++) {
                    options.excludeTypesMap[excludeTypes[i]] = true;
                }
            }

            if (objectDefaults) {
                options.objectDefaults = objectDefaults;
            }

            options.excludeUnclassifiedObjects = (params.excludeUnclassifiedObjects !== undefined) ? (!!params.excludeUnclassifiedObjects) : this._excludeUnclassifiedObjects;
            options.globalizeObjectIds = (params.globalizeObjectIds !== undefined && params.globalizeObjectIds !== null) ? (!!params.globalizeObjectIds) : this._globalizeObjectIds;

            // @reviser lijuhong 移除参数scene
            const sceneModel = new SceneModel(utils.apply(params, {
                isModel: true,
                textureTranscoder: this._textureTranscoder,
                maxGeometryBatchSize: this._maxGeometryBatchSize,
                origin: params.origin,
                disableVertexWelding: params.disableVertexWelding || false,
                disableIndexRebucketing: params.disableIndexRebucketing || false,
                dtxEnabled: params.dtxEnabled
            }));

            const modelId = sceneModel.id;  // In case ID was auto-generated

            const metaModel = new MetaModel({
                // @reviser lijuhong 移除参数metaScene
                // metaScene: this.viewer.metaScene,
                id: modelId
            });

            // @reivser lijuhong 注释viewer相关代码
            // this.viewer.scene.canvas.spinner.processes++;

            const finish = () => {
                // this._createDefaultMetaModelIfNeeded(sceneModel, params, options);
                sceneModel.finalize();
                metaModel.finalize();
                // @reivser lijuhong 注释viewer相关代码
                // this.viewer.scene.canvas.spinner.processes--;
                sceneModel.once("destroyed", () => {
                    // @reivser lijuhong 修改销毁MetaModel代码
                    // this.viewer.metaScene.destroyMetaModel(metaModel.id);
                    metaModel.destroy();
                });
                this.scheduleTask(() => {
                    if (sceneModel.destroyed) {
                        return;
                    }
                    // @reviser lijuhong 注释scene相关代码
                    // sceneModel.scene.fire("modelLoaded", sceneModel.id); // FIXME: Assumes listeners know order of these two events
                    sceneModel.fire("loaded", true, false); // Don't forget the event, for late subscribers
                    // @reviser lijuhong 触发onLoad回调
                    if (typeof onLoad === 'function')
                        onLoad(sceneModel, metaModel);
                });
            };

            const error = (errMsg) => {
                // @reivser lijuhong 注释viewer相关代码
                // this.viewer.scene.canvas.spinner.processes--;
                this.error(errMsg);
                sceneModel.fire("error", errMsg);
                // @reviser lijuhong 触发onLoad回调
                if (typeof onError === 'function')
                    onError(errMsg);
            };

            let nextId = 0;
            const manifestCtx = {
                getNextId: () => {
                    return `${modelId}.${nextId++}`;
                }
            };

            if (params.metaModelSrc || params.metaModelData) {

                if (params.metaModelSrc) {

                    const metaModelSrc = params.metaModelSrc;

                    this._dataSource.getMetaModel(metaModelSrc, (metaModelData) => {
                        if (sceneModel.destroyed) {
                            return;
                        }
                        metaModel.loadData(metaModelData, {
                            includeTypes: includeTypes,
                            excludeTypes: excludeTypes,
                            globalizeObjectIds: options.globalizeObjectIds
                        });
                        if (params.src) {
                            this._loadModel(params.src, params, options, sceneModel, null, manifestCtx, finish, error);
                        } else {
                            this._parseModel(params.xkt, params, options, sceneModel, null, manifestCtx);
                            finish();
                        }
                    }, (errMsg) => {
                        error(`load(): Failed to load model metadata for model '${modelId} from  '${metaModelSrc}' - ${errMsg}`);
                    });

                } else if (params.metaModelData) {
                    metaModel.loadData(params.metaModelData, {
                        includeTypes: includeTypes,
                        excludeTypes: excludeTypes,
                        globalizeObjectIds: options.globalizeObjectIds
                    });
                    if (params.src) {
                        this._loadModel(params.src, params, options, sceneModel, null, manifestCtx, finish, error);
                    } else {
                        this._parseModel(params.xkt, params, options, sceneModel, null, manifestCtx);
                        finish();
                    }
                }


            } else {

                if (params.src) {
                    this._loadModel(params.src, params, options, sceneModel, metaModel, manifestCtx, finish, error);
                } else if (params.xkt) {
                    this._parseModel(params.xkt, params, options, sceneModel, metaModel, manifestCtx);
                    finish();
                } else if (params.manifestSrc || params.manifest) {
                    const baseDir = params.manifestSrc ? getBaseDirectory(params.manifestSrc) : "";
                    const loadJSONs = (metaDataFiles, done, error) => {
                        let i = 0;
                        const loadNext = () => {
                            if (i >= metaDataFiles.length) {
                                done();
                            } else {
                                this._dataSource.getMetaModel(`${baseDir}${metaDataFiles[i]}`, (metaModelData) => {
                                    metaModel.loadData(metaModelData, {
                                        includeTypes: includeTypes,
                                        excludeTypes: excludeTypes,
                                        globalizeObjectIds: options.globalizeObjectIds
                                    });
                                    i++;
                                    this.scheduleTask(loadNext, 100);
                                }, error);
                            }
                        };
                        loadNext();
                    };
                    const loadXKTs_excludeTheirMetaModels = (xktFiles, done, error) => { // Load XKTs, ignore metamodels in the XKT
                        let i = 0;
                        const loadNext = () => {
                            if (i >= xktFiles.length) {
                                done();
                            } else {
                                this._dataSource.getXKT(`${baseDir}${xktFiles[i]}`, (arrayBuffer) => {
                                    this._parseModel(arrayBuffer, params, options, sceneModel, null /* Ignore metamodel in XKT */, manifestCtx);
                                    i++;
                                    this.scheduleTask(loadNext, 100);
                                }, error);
                            }
                        };
                        loadNext();
                    };
                    const loadXKTs_includeTheirMetaModels = (xktFiles, done, error) => { // Load XKTs, parse metamodels from the XKT
                        let i = 0;
                        const loadNext = () => {
                            if (i >= xktFiles.length) {
                                done();
                            } else {
                                this._dataSource.getXKT(`${baseDir}${xktFiles[i]}`, (arrayBuffer) => {
                                    this._parseModel(arrayBuffer, params, options, sceneModel, metaModel, manifestCtx);
                                    i++;
                                    this.scheduleTask(loadNext, 100);
                                }, error);
                            }
                        };
                        loadNext();
                    };
                    if (params.manifest) {
                        const manifestData = params.manifest;
                        const xktFiles = manifestData.xktFiles;
                        if (!xktFiles || xktFiles.length === 0) {
                            error(`load(): Failed to load model manifest - manifest not valid`);
                            return;
                        }
                        const metaModelFiles = manifestData.metaModelFiles;
                        if (metaModelFiles) {
                            loadJSONs(metaModelFiles, () => {
                                loadXKTs_excludeTheirMetaModels(xktFiles, finish, error);
                            }, error);
                        } else {
                            loadXKTs_includeTheirMetaModels(xktFiles, finish, error);
                        }
                    } else {
                        this._dataSource.getManifest(params.manifestSrc, (manifestData) => {
                            if (sceneModel.destroyed) {
                                return;
                            }
                            const xktFiles = manifestData.xktFiles;
                            if (!xktFiles || xktFiles.length === 0) {
                                error(`load(): Failed to load model manifest - manifest not valid`);
                                return;
                            }
                            const metaModelFiles = manifestData.metaModelFiles;
                            if (metaModelFiles) {
                                loadJSONs(metaModelFiles, () => {
                                    loadXKTs_excludeTheirMetaModels(xktFiles, finish, error);
                                }, error);
                            } else {
                                loadXKTs_includeTheirMetaModels(xktFiles, finish, error);
                            }
                        }, error);
                    }
                }
            }

            return sceneModel;
        }

        _loadModel(src, params, options, sceneModel, metaModel, manifestCtx, done, error) {
            this._dataSource.getXKT(params.src, (arrayBuffer) => {
                this._parseModel(arrayBuffer, params, options, sceneModel, metaModel, manifestCtx);
                done();
            }, error);
        }

        _parseModel(arrayBuffer, params, options, sceneModel, metaModel, manifestCtx) {
            if (sceneModel.destroyed) {
                return;
            }
            const dataView = new DataView(arrayBuffer);
            const dataArray = new Uint8Array(arrayBuffer);
            const xktVersion = dataView.getUint32(0, true);
            const parser = parsers[xktVersion];
            if (!parser) {
                this.error("Unsupported .XKT file version: " + xktVersion + " - this XKTLoaderPlugin supports versions " + Object.keys(parsers));
                return;
            }
            this.log("Loading .xkt V" + xktVersion);
            const numElements = dataView.getUint32(4, true);
            const elements = [];
            let byteOffset = (numElements + 2) * 4;
            for (let i = 0; i < numElements; i++) {
                const elementSize = dataView.getUint32((i + 2) * 4, true);
                elements.push(dataArray.subarray(byteOffset, byteOffset + elementSize));
                byteOffset += elementSize;
            }
            parser.parse(this.viewer, options, elements, sceneModel, metaModel, manifestCtx);
        }
    }

    function getBaseDirectory(filePath) {
        const pathArray = filePath.split('/');
        pathArray.pop(); // Remove the file name or the last segment of the path
        return pathArray.join('/') + '/';
    }

    return XKTLoaderPlugin;

}));
//# sourceMappingURL=xktloader.js.map
