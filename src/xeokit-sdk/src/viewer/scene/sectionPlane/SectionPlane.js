import {Component} from '../Component.js';
import {RenderState} from '../webgl/RenderState.js';
import {math} from "../math/math.js";

const tempVec3a = math.vec3();

/**
 *  @desc An arbitrarily-aligned World-space clipping plane.
 *
 * * Slices portions off objects to create cross-section views or reveal interiors.
 * * Registered by {@link SectionPlane#id} in {@link Scene#sectionPlanes}.
 * * Indicates World-space position in {@link SectionPlane#pos} and orientation in {@link SectionPlane#dir}.
 * * Discards elements from the half-space in the direction of {@link SectionPlane#dir}.
 * * Can be be enabled or disabled via {@link SectionPlane#active}.
 *
 * ## Usage
 *
 * In the example below, we'll create two SectionPlanes to slice a model loaded from glTF. Note that we could also create them
 * using a {@link SectionPlanesPlugin}.
 *
 * ````javascript
 * import {Viewer, GLTFLoaderPlugin, SectionPlane} from "xeokit-sdk.es.js";
 *
 * const viewer = new Viewer({
 *      canvasId: "myCanvas"
 * });
 *
 * const gltfLoaderPlugin = new GLTFModelsPlugin(viewer, {
 *      id: "GLTFModels"
 * });
 *
 * const model = gltfLoaderPlugin.load({
 *      id: "myModel",
 *      src: "./models/gltf/mygltfmodel.gltf"
 * });
 *
 * // Create a SectionPlane on negative diagonal
 * const sectionPlane1 = new SectionPlane(viewer.scene, {
 *     pos: [1.0, 1.0, 1.0],
 *     dir: [-1.0, -1.0, -1.0],
 *     active: true
 * }),
 *
 * // Create a SectionPlane on positive diagonal
 * const sectionPlane2 = new SectionPlane(viewer.scene, {
 *     pos: [-1.0, -1.0, -1.0],
 *     dir: [1.0, 1.0, 1.0],
 *     active: true
 * });
 * ````
 */
class SectionPlane extends Component {

    /**
     @private
     */
    get type() {
        return "SectionPlane";
    }

    /**
     * @constructor
     * @param {Component} [owner]  Owner component. When destroyed, the owner will destroy this SectionPlane as well.
     * @param {*} [cfg]  SectionPlane configuration
     * @param  {String} [cfg.id] Optional ID, unique among all components in the parent {@link Scene}, generated automatically when omitted.
     * @param {Boolean} [cfg.active=true] Indicates whether or not this SectionPlane is active.
     * @param {Number[]} [cfg.pos=[0,0,0]] World-space position of the SectionPlane.
     * @param {Number[]} [cfg.dir=[0,0,-1]] Vector perpendicular to the plane surface, indicating the SectionPlane plane orientation.
     */
    constructor(owner, cfg = {}) {

        super(owner, cfg);

        this._state = new RenderState({
            active: true,
            pos: math.vec3(),
            dir: math.vec3(),
            dist: 0
        });

        this.active = cfg.active;
        this.pos = cfg.pos;
        this.dir = cfg.dir;

        this.scene._sectionPlaneCreated(this);
    }

    /**
     * Sets if this SectionPlane is active or not.
     *
     * Default value is ````true````.
     *
     * @param {Boolean} value Set ````true```` to activate else ````false```` to deactivate.
     */
    set active(value) {
        this._state.active = value !== false;
        this.glRedraw();
        this.fire("active", this._state.active);
        this.scene.fire("sectionPlaneUpdated", this);
    }

    /**
     * Gets if this SectionPlane is active or not.
     *
     * Default value is ````true````.
     *
     * @returns {Boolean} Returns ````true```` if active.
     */
    get active() {
        return this._state.active;
    }

    /**
     * Sets the World-space position of this SectionPlane's plane.
     *
     * Default value is ````[0, 0, 0]````.
     *
     * @param {Number[]} value New position.
     */
    set pos(value) {
        this._state.pos.set(value || [0, 0, 0]);
        this._state.dist = (-math.dotVec3(this._state.pos, this._state.dir));
        this.fire("pos", this._state.pos);
        this.scene.fire("sectionPlaneUpdated", this);
    }

    /**
     * Gets the World-space position of this SectionPlane's plane.
     *
     * Default value is ````[0, 0, 0]````.
     *
     * @returns {Number[]} Current position.
     */
    get pos() {
        return this._state.pos;
    }

    /**
     * Sets the direction of this SectionPlane's plane.
     *
     * Default value is ````[0, 0, -1]````.
     *
     * @param {Number[]} value New direction.
     */
    set dir(value) {
        this._state.dir.set(value || [0, 0, -1]);
        this._state.dist = (-math.dotVec3(this._state.pos, this._state.dir));
        this.glRedraw();
        this.fire("dir", this._state.dir);
        this.scene.fire("sectionPlaneUpdated", this);
    }

    /**
     * Gets the direction of this SectionPlane's plane.
     *
     * Default value is ````[0, 0, -1]````.
     *
     * @returns {Number[]} value Current direction.
     */
    get dir() {
        return this._state.dir;
    }

    /**
     * Gets this SectionPlane's distance to the origin of the World-space coordinate system.
     *
     * This is the dot product of {@link SectionPlane#pos} and {@link SectionPlane#dir} and is automatically re-calculated
     * each time either of two properties are updated.
     *
     * @returns {Number}
     */
    get dist() {
        return this._state.dist;
    }

    /**
     * Inverts the direction of {@link SectionPlane#dir}.
     */
    flipDir() {
        math.mulVec3Scalar(this._state.dir, -1.0, this._state.dir);
        this.dir = this._state.dir;
    }

    /**
     * @destroy
     */
    destroy() {
        this._state.destroy();
        this.scene._sectionPlaneDestroyed(this);
        super.destroy();
    }
}

export {SectionPlane};
