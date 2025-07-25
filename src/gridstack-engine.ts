/**
 * gridstack-engine.ts 12.2.2-dev
 * Copyright (c) 2021-2024  Alain Dumesny - see GridStack root license
 */

import { Utils } from './utils';
import { GridStackNode, ColumnOptions, GridStackPosition, GridStackMoveOpts, SaveFcn, CompactOptions } from './types';

/** callback to update the DOM attributes since this class is generic (no HTML or other info) for items that changed - see _notify() */
type OnChangeCB = (nodes: GridStackNode[]) => void;

/** options used during creation - similar to GridStackOptions */
export interface GridStackEngineOptions {
  column?: number;
  maxRow?: number;
  float?: boolean;
  nodes?: GridStackNode[];
  onChange?: OnChangeCB;
}

/**
 * Defines the GridStack engine that does most no DOM grid manipulation.
 * See GridStack methods and vars for descriptions.
 *
 * NOTE: values should not be modified directly - call the main GridStack API instead
 */
export class GridStackEngine {
  public column: number;
  public maxRow: number;
  public nodes: GridStackNode[];
  public addedNodes: GridStackNode[] = [];
  public removedNodes: GridStackNode[] = [];
  public batchMode: boolean;
  public defaultColumn = 12;
  /** @internal callback to update the DOM attributes */
  protected onChange: OnChangeCB;
  /** @internal */
  protected _float: boolean;
  /** @internal */
  protected _prevFloat: boolean;
  /** @internal cached layouts of difference column count so we can restore back (eg 12 -> 1 -> 12) */
  protected _layouts?: GridStackNode[][]; // maps column # to array of values nodes
  /** @internal set during loading (which is sorted) so item gets added AFTER collision nodes */
  public _loading?: boolean
  /** @internal true while we are resizing widgets during column resize to skip certain parts */
  protected _inColumnResize?: boolean;
  /** true when grid.load() already cached the layout and can skip out of bound caching info */
  public skipCacheUpdate?: boolean;
  /** @internal true if we have some items locked */
  protected _hasLocked: boolean;
  /** @internal unique global internal _id counter */
  public static _idSeq = 0;

  public constructor(opts: GridStackEngineOptions = {}) {
    this.column = opts.column || this.defaultColumn;
    if (this.column > this.defaultColumn) this.defaultColumn = this.column;
    this.maxRow = opts.maxRow;
    this._float = opts.float;
    this.nodes = opts.nodes || [];
    this.onChange = opts.onChange;
  }

  public batchUpdate(flag = true, doPack = true): GridStackEngine {
    if (!!this.batchMode === flag) return this;
    this.batchMode = flag;
    if (flag) {
      this._prevFloat = this._float;
      this._float = true; // let things go anywhere for now... will restore and possibly reposition later
      this.cleanNodes();
      this.saveInitial(); // since begin update (which is called multiple times) won't do this
    } else {
      this._float = this._prevFloat;
      delete this._prevFloat;
      if (doPack) this._packNodes();
      this._notify();
    }
    return this;
  }

  // use entire row for hitting area (will use bottom reverse sorted first) if we not actively moving DOWN and didn't already skip
  protected _useEntireRowArea(node: GridStackNode, nn: GridStackPosition): boolean {
    return (!this.float || this.batchMode && !this._prevFloat) && !this._hasLocked && (!node._moving || node._skipDown || nn.y <= node.y);
  }

  /** @internal fix collision on given 'node', going to given new location 'nn', with optional 'collide' node already found.
   * return true if we moved. */
  protected _fixCollisions(node: GridStackNode, nn = node, collide?: GridStackNode, opt: GridStackMoveOpts = {}): boolean {
    this.sortNodes(-1); // from last to first, so recursive collision move items in the right order

    collide = collide || this.collide(node, nn); // REAL area collide for swap and skip if none...
    if (!collide) return false;

    // swap check: if we're actively moving in gravity mode, see if we collide with an object the same size
    if (node._moving && !opt.nested && !this.float) {
      if (this.swap(node, collide)) return true;
    }

    // during while() collisions MAKE SURE to check entire row so larger items don't leap frog small ones (push them all down starting last in grid)
    let area = nn;
    if (!this._loading && this._useEntireRowArea(node, nn)) {
      area = {x: 0, w: this.column, y: nn.y, h: nn.h};
      collide = this.collide(node, area, opt.skip); // force new hit
    }

    let didMove = false;
    const newOpt: GridStackMoveOpts = {nested: true, pack: false};
    let counter = 0;
    while (collide = collide || this.collide(node, area, opt.skip)) { // could collide with more than 1 item... so repeat for each
      if (counter++ > this.nodes.length * 2) {
        throw new Error("Infinite collide check");
      }
      let moved: boolean;
      // if colliding with a locked item OR loading (move after) OR moving down with top gravity (and collide could move up) -> skip past the collide,
      // but remember that skip down so we only do this once (and push others otherwise).
      if (collide.locked || this._loading || node._moving && !node._skipDown && nn.y > node.y && !this.float &&
        // can take space we had, or before where we're going
        (!this.collide(collide, {...collide, y: node.y}, node) || !this.collide(collide, {...collide, y: nn.y - collide.h}, node))) {

        node._skipDown = (node._skipDown || nn.y > node.y);
        const newNN = {...nn, y: collide.y + collide.h, ...newOpt};
        // pretent we moved to where we are now so we can continue any collision checks #2492
        moved = this._loading && Utils.samePos(node, newNN) ? true : this.moveNode(node, newNN);

        if ((collide.locked || this._loading) && moved) {
          Utils.copyPos(nn, node); // moving after lock become our new desired location
        } else if (!collide.locked && moved && opt.pack) {
          // we moved after and will pack: do it now and keep the original drop location, but past the old collide to see what else we might push way
          this._packNodes();
          nn.y = collide.y + collide.h;
          Utils.copyPos(node, nn);
        }
        didMove = didMove || moved;
      } else {
        // move collide down *after* where we will be, ignoring where we are now (don't collide with us)
        moved = this.moveNode(collide, {...collide, y: nn.y + nn.h, skip: node, ...newOpt});
      }

      if (!moved) return didMove; // break inf loop if we couldn't move after all (ex: maxRow, fixed)

      collide = undefined;
    }
    return didMove;
  }

  /** return the nodes that intercept the given node. Optionally a different area can be used, as well as a second node to skip */
  public collide(skip: GridStackNode, area = skip, skip2?: GridStackNode): GridStackNode | undefined {
    const skipId = skip._id;
    const skip2Id = skip2?._id;
    return this.nodes.find(n => n._id !== skipId && n._id !== skip2Id && Utils.isIntercepted(n, area));
  }
  public collideAll(skip: GridStackNode, area = skip, skip2?: GridStackNode): GridStackNode[] {
    const skipId = skip._id;
    const skip2Id = skip2?._id;
    return this.nodes.filter(n => n._id !== skipId && n._id !== skip2Id && Utils.isIntercepted(n, area));
  }

  /** does a pixel coverage collision based on where we started, returning the node that has the most coverage that is >50% mid line */
  protected directionCollideCoverage(node: GridStackNode, o: GridStackMoveOpts, collides: GridStackNode[]): GridStackNode | undefined {
    if (!o.rect || !node._rect) return;
    const r0 = node._rect; // where started
    const r = {...o.rect}; // where we are

    // update dragged rect to show where it's coming from (above or below, etc...)
    if (r.y > r0.y) {
      r.h += r.y - r0.y;
      r.y = r0.y;
    } else {
      r.h += r0.y - r.y;
    }
    if (r.x > r0.x) {
      r.w += r.x - r0.x;
      r.x = r0.x;
    } else {
      r.w += r0.x - r.x;
    }

    let collide: GridStackNode;
    let overMax = 0.5; // need >50%
    for (let n of collides) {
      if (n.locked || !n._rect) {
        break;
      }
      const r2 = n._rect; // overlapping target
      let yOver = Number.MAX_VALUE, xOver = Number.MAX_VALUE;
      // depending on which side we started from, compute the overlap % of coverage
      // (ex: from above/below we only compute the max horizontal line coverage)
      if (r0.y < r2.y) { // from above
        yOver = ((r.y + r.h) - r2.y) / r2.h;
      } else if (r0.y + r0.h > r2.y + r2.h) { // from below
        yOver = ((r2.y + r2.h) - r.y) / r2.h;
      }
      if (r0.x < r2.x) { // from the left
        xOver = ((r.x + r.w) - r2.x) / r2.w;
      } else if (r0.x + r0.w > r2.x + r2.w) { // from the right
        xOver = ((r2.x + r2.w) - r.x) / r2.w;
      }
      const over = Math.min(xOver, yOver);
      if (over > overMax) {
        overMax = over;
        collide = n;
      }
    }
    o.collide = collide; // save it so we don't have to find it again
    return collide;
  }

  /** does a pixel coverage returning the node that has the most coverage by area */
  /*
  protected collideCoverage(r: GridStackPosition, collides: GridStackNode[]): {collide: GridStackNode, over: number} {
    const collide: GridStackNode;
    const overMax = 0;
    collides.forEach(n => {
      if (n.locked || !n._rect) return;
      const over = Utils.areaIntercept(r, n._rect);
      if (over > overMax) {
        overMax = over;
        collide = n;
      }
    });
    return {collide, over: overMax};
  }
  */

  /** called to cache the nodes pixel rectangles used for collision detection during drag */
  public cacheRects(w: number, h: number, top: number, right: number, bottom: number, left: number): GridStackEngine
  {
    this.nodes.forEach(n =>
      n._rect = {
        y: n.y * h + top,
        x: n.x * w + left,
        w: n.w * w - left - right,
        h: n.h * h - top - bottom
      }
    );
    return this;
  }

  /** called to possibly swap between 2 nodes (same size or column, not locked, touching), returning true if successful */
  public swap(a: GridStackNode, b: GridStackNode): boolean | undefined {
    if (!b || b.locked || !a || a.locked) return false;

    function _doSwap(): true { // assumes a is before b IFF they have different height (put after rather than exact swap)
      const x = b.x, y = b.y;
      b.x = a.x; b.y = a.y; // b -> a position
      if (a.h != b.h) {
        a.x = x; a.y = b.y + b.h; // a -> goes after b
      } else if (a.w != b.w) {
        a.x = b.x + b.w; a.y = y; // a -> goes after b
      } else {
        a.x = x; a.y = y; // a -> old b position
      }
      a._dirty = b._dirty = true;
      return true;
    }
    let touching: boolean; // remember if we called it (vs undefined)

    // same size and same row or column, and touching
    if (a.w === b.w && a.h === b.h && (a.x === b.x || a.y === b.y) && (touching = Utils.isTouching(a, b)))
      return _doSwap();
    if (touching === false) return; // IFF ran test and fail, bail out

    // check for taking same columns (but different height) and touching
    if (a.w === b.w && a.x === b.x && (touching || (touching = Utils.isTouching(a, b)))) {
      if (b.y < a.y) { const t = a; a = b; b = t; } // swap a <-> b vars so a is first
      return _doSwap();
    }
    if (touching === false) return;

    // check if taking same row (but different width) and touching
    if (a.h === b.h && a.y === b.y && (touching || (touching = Utils.isTouching(a, b)))) {
      if (b.x < a.x) { const t = a; a = b; b = t; } // swap a <-> b vars so a is first
      return _doSwap();
    }
    return false;
  }

  public isAreaEmpty(x: number, y: number, w: number, h: number): boolean {
    const nn: GridStackNode = {x: x || 0, y: y || 0, w: w || 1, h: h || 1};
    return !this.collide(nn);
  }

  /** re-layout grid items to reclaim any empty space - optionally keeping the sort order exactly the same ('list' mode) vs truly finding an empty spaces */
  public compact(layout: CompactOptions = 'compact', doSort = true): GridStackEngine {
    if (this.nodes.length === 0) return this;
    if (doSort) this.sortNodes();
    const wasBatch = this.batchMode;
    if (!wasBatch) this.batchUpdate();
    const wasColumnResize = this._inColumnResize;
    if (!wasColumnResize) this._inColumnResize = true; // faster addNode()
    const copyNodes = this.nodes;
    this.nodes = []; // pretend we have no nodes to conflict layout to start with...
    copyNodes.forEach((n, index, list) => {
      let after: GridStackNode;
      if (!n.locked) {
        n.autoPosition = true;
        if (layout === 'list' && index) after = list[index - 1];
      }
      this.addNode(n, false, after); // 'false' for add event trigger
    });
    if (!wasColumnResize) delete this._inColumnResize;
    if (!wasBatch) this.batchUpdate(false);
    return this;
  }

  /** enable/disable floating widgets (default: `false`) See [example](http://gridstackjs.com/demo/float.html) */
  public set float(val: boolean) {
    if (this._float === val) return;
    this._float = val || false;
    if (!val) {
      this._packNodes()._notify();
    }
  }

  /** float getter method */
  public get float(): boolean { return this._float || false; }

  /** sort the nodes array from first to last, or reverse. Called during collision/placement to force an order */
  public sortNodes(dir: 1 | -1 = 1): GridStackEngine {
    this.nodes = Utils.sort(this.nodes, dir);
    return this;
  }

  /** @internal called to top gravity pack the items back OR revert back to original Y positions when floating */
  protected _packNodes(): GridStackEngine {
    if (this.batchMode) { return this; }
    this.sortNodes(); // first to last

    if (this.float) {
      // restore original Y pos
      this.nodes.forEach(n => {
        if (n._updating || n._orig === undefined || n.y === n._orig.y) return;
        let newY = n.y;
        while (newY > n._orig.y) {
          --newY;
          const collide = this.collide(n, {x: n.x, y: newY, w: n.w, h: n.h});
          if (!collide) {
            n._dirty = true;
            n.y = newY;
          }
        }
      });
    } else {
      // top gravity pack
      this.nodes.forEach((n, i) => {
        if (n.locked) return;
        while (n.y > 0) {
          const newY = i === 0 ? 0 : n.y - 1;
          const canBeMoved = i === 0 || !this.collide(n, {x: n.x, y: newY, w: n.w, h: n.h});
          if (!canBeMoved) break;
          // Note: must be dirty (from last position) for GridStack::OnChange CB to update positions
          // and move items back. The user 'change' CB should detect changes from the original
          // starting position instead.
          n._dirty = (n.y !== newY);
          n.y = newY;
        }
      });
    }
    return this;
  }

  /**
   * given a random node, makes sure it's coordinates/values are valid in the current grid
   * @param node to adjust
   * @param resizing if out of bound, resize down or move into the grid to fit ?
   */
  public prepareNode(node: GridStackNode, resizing?: boolean): GridStackNode {
    node._id = node._id ?? GridStackEngine._idSeq++;

    // make sure USER supplied id are unique in our list, else assign a new one as it will create issues during load/update/etc...
    const id = node.id;
    if (id) {
      let count = 1; // append nice _n rather than some random number
      while (this.nodes.find(n => n.id === node.id && n !== node)) {
        node.id = id + '_' + (count++);
      }
    }

    // if we're missing position, have the grid position us automatically (before we set them to 0,0)
    if (node.x === undefined || node.y === undefined || node.x === null || node.y === null) {
      node.autoPosition = true;
    }

    // assign defaults for missing required fields
    const defaults: GridStackNode = { x: 0, y: 0, w: 1, h: 1};
    Utils.defaults(node, defaults);

    if (!node.autoPosition) { delete node.autoPosition; }
    if (!node.noResize) { delete node.noResize; }
    if (!node.noMove) { delete node.noMove; }
    Utils.sanitizeMinMax(node);

    // check for NaN (in case messed up strings were passed. can't do parseInt() || defaults.x above as 0 is valid #)
    if (typeof node.x == 'string') { node.x = Number(node.x); }
    if (typeof node.y == 'string') { node.y = Number(node.y); }
    if (typeof node.w == 'string') { node.w = Number(node.w); }
    if (typeof node.h == 'string') { node.h = Number(node.h); }
    if (isNaN(node.x)) { node.x = defaults.x; node.autoPosition = true; }
    if (isNaN(node.y)) { node.y = defaults.y; node.autoPosition = true; }
    if (isNaN(node.w)) { node.w = defaults.w; }
    if (isNaN(node.h)) { node.h = defaults.h; }

    this.nodeBoundFix(node, resizing);
    return node;
  }

  /** part2 of preparing a node to fit inside our grid - checks for x,y,w from grid dimensions */
  public nodeBoundFix(node: GridStackNode, resizing?: boolean): GridStackEngine {

    const before = node._orig || Utils.copyPos({}, node);

    if (node.maxW) { node.w = Math.min(node.w || 1, node.maxW); }
    if (node.maxH) { node.h = Math.min(node.h || 1, node.maxH); }
    if (node.minW) { node.w = Math.max(node.w || 1, node.minW); }
    if (node.minH) { node.h = Math.max(node.h || 1, node.minH); }

    // if user loaded a larger than allowed widget for current # of columns,
    // remember it's position & width so we can restore back (1 -> 12 column) #1655 #1985
    // IFF we're not in the middle of column resizing!
    const saveOrig = (node.x || 0) + (node.w || 1) > this.column;
    if (saveOrig && this.column < this.defaultColumn && !this._inColumnResize && !this.skipCacheUpdate && node._id != null  && this.findCacheLayout(node, this.defaultColumn) === -1) {
      const copy = {...node}; // need _id + positions
      if (copy.autoPosition || copy.x === undefined) { delete copy.x; delete copy.y; }
      else copy.x = Math.min(this.defaultColumn - 1, copy.x);
      copy.w = Math.min(this.defaultColumn, copy.w || 1);
      this.cacheOneLayout(copy, this.defaultColumn);
    }
    
    if (node.w > this.column) {
      node.w = this.column;
    } else if (node.w < 1) {
      node.w = 1;
    }

    if (this.maxRow && node.h > this.maxRow) {
      node.h = this.maxRow;
    } else if (node.h < 1) {
      node.h = 1;
    }

    if (node.x < 0) {
      node.x = 0;
    }
    if (node.y < 0) {
      node.y = 0;
    }

    if (node.x + node.w > this.column) {
      if (resizing) {
        node.w = this.column - node.x;
      } else {
        node.x = this.column - node.w;
      }
    }
    if (this.maxRow && node.y + node.h > this.maxRow) {
      if (resizing) {
        node.h = this.maxRow - node.y;
      } else {
        node.y = this.maxRow - node.h;
      }
    }

    if (!Utils.samePos(node, before)) {
      node._dirty = true;
    }

    return this;
  }

  /** returns a list of modified nodes from their original values */
  public getDirtyNodes(verify?: boolean): GridStackNode[] {
    // compare original x,y,w,h instead as _dirty can be a temporary state
    if (verify) {
      return this.nodes.filter(n => n._dirty && !Utils.samePos(n, n._orig));
    }
    return this.nodes.filter(n => n._dirty);
  }

  /** @internal call this to call onChange callback with dirty nodes so DOM can be updated */
  protected _notify(removedNodes?: GridStackNode[]): GridStackEngine {
    if (this.batchMode || !this.onChange) return this;
    const dirtyNodes = (removedNodes || []).concat(this.getDirtyNodes());
    this.onChange(dirtyNodes);
    return this;
  }

  /** @internal remove dirty and last tried info */
  public cleanNodes(): GridStackEngine {
    if (this.batchMode) return this;
    this.nodes.forEach(n => {
      delete n._dirty;
      delete n._lastTried;
    });
    return this;
  }

  /** @internal called to save initial position/size to track real dirty state.
   * Note: should be called right after we call change event (so next API is can detect changes)
   * as well as right before we start move/resize/enter (so we can restore items to prev values) */
  public saveInitial(): GridStackEngine {
    this.nodes.forEach(n => {
      n._orig = Utils.copyPos({}, n);
      delete n._dirty;
    });
    this._hasLocked = this.nodes.some(n => n.locked);
    return this;
  }

  /** @internal restore all the nodes back to initial values (called when we leave) */
  public restoreInitial(): GridStackEngine {
    this.nodes.forEach(n => {
      if (!n._orig || Utils.samePos(n, n._orig)) return;
      Utils.copyPos(n, n._orig);
      n._dirty = true;
    });
    this._notify();
    return this;
  }

  /** find the first available empty spot for the given node width/height, updating the x,y attributes. return true if found.
   * optionally you can pass your own existing node list and column count, otherwise defaults to that engine data.
   * Optionally pass a widget to start search AFTER, meaning the order will remain the same but possibly have empty slots we skipped
   */
  public findEmptyPosition(node: GridStackNode, nodeList = this.nodes, column = this.column, after?: GridStackNode): boolean {
    const start = after ? after.y * column + (after.x + after.w) : 0;
    let found = false;
    for (let i = start; !found; ++i) {
      const x = i % column;
      const y = Math.floor(i / column);
      if (x + node.w > column) {
        continue;
      }
      const box = {x, y, w: node.w, h: node.h};
      if (!nodeList.find(n => Utils.isIntercepted(box, n))) {
        if (node.x !== x || node.y !== y) node._dirty = true;
        node.x = x;
        node.y = y;
        delete node.autoPosition;
        found = true;
      }
    }
    return found;
  }

  /** call to add the given node to our list, fixing collision and re-packing */
  public addNode(node: GridStackNode, triggerAddEvent = false, after?: GridStackNode): GridStackNode {
    const dup = this.nodes.find(n => n._id === node._id);
    if (dup) return dup; // prevent inserting twice! return it instead.

    // skip prepareNode if we're in middle of column resize (not new) but do check for bounds!
    this._inColumnResize ? this.nodeBoundFix(node) : this.prepareNode(node);
    delete node._temporaryRemoved;
    delete node._removeDOM;

    let skipCollision: boolean;
    if (node.autoPosition && this.findEmptyPosition(node, this.nodes, this.column, after)) {
      delete node.autoPosition; // found our slot
      skipCollision = true;
    }

    this.nodes.push(node);
    if (triggerAddEvent) { this.addedNodes.push(node); }

    if (!skipCollision) this._fixCollisions(node);
    if (!this.batchMode) { this._packNodes()._notify(); }
    return node;
  }

  public removeNode(node: GridStackNode, removeDOM = true, triggerEvent = false): GridStackEngine {
    if (!this.nodes.find(n => n._id === node._id)) {
      // TEST console.log(`Error: GridStackEngine.removeNode() node._id=${node._id} not found!`)
      return this;
    }
    if (triggerEvent) { // we wait until final drop to manually track removed items (rather than during drag)
      this.removedNodes.push(node);
    }
    if (removeDOM) node._removeDOM = true; // let CB remove actual HTML (used to set _id to null, but then we loose layout info)
    // don't use 'faster' .splice(findIndex(),1) in case node isn't in our list, or in multiple times.
    this.nodes = this.nodes.filter(n => n._id !== node._id);
    if (!node._isAboutToRemove) this._packNodes(); // if dragged out, no need to relayout as already done...
    this._notify([node]);
    return this;
  }

  public removeAll(removeDOM = true, triggerEvent = true): GridStackEngine {
    delete this._layouts;
    if (!this.nodes.length) return this;
    removeDOM && this.nodes.forEach(n => n._removeDOM = true); // let CB remove actual HTML (used to set _id to null, but then we loose layout info)
    const removedNodes = this.nodes;
    this.removedNodes = triggerEvent ? removedNodes : [];
    this.nodes = [];
    return this._notify(removedNodes);
  }

  /** checks if item can be moved (layout constrain) vs moveNode(), returning true if was able to move.
   * In more complicated cases (maxRow) it will attempt at moving the item and fixing
   * others in a clone first, then apply those changes if still within specs. */
  public moveNodeCheck(node: GridStackNode, o: GridStackMoveOpts): boolean {
    // if (node.locked) return false;
    if (!this.changedPosConstrain(node, o)) return false;
    o.pack = true;

    // simpler case: move item directly...
    if (!this.maxRow) {
      return this.moveNode(node, o);
    }

    // complex case: create a clone with NO maxRow (will check for out of bounds at the end)
    let clonedNode: GridStackNode;
    const clone = new GridStackEngine({
      column: this.column,
      float: this.float,
      nodes: this.nodes.map(n => {
        if (n._id === node._id) {
          clonedNode = {...n};
          return clonedNode;
        }
        return {...n};
      })
    });
    if (!clonedNode) return false;

    // check if we're covering 50% collision and could move, while still being under maxRow or at least not making it worse
    // (case where widget was somehow added past our max #2449)
    const canMove = clone.moveNode(clonedNode, o) && clone.getRow() <= Math.max(this.getRow(), this.maxRow);
    // else check if we can force a swap (float=true, or different shapes) on non-resize
    if (!canMove && !o.resizing && o.collide) {
      const collide = o.collide.el.gridstackNode; // find the source node the clone collided with at 50%
      if (this.swap(node, collide)) { // swaps and mark dirty
        this._notify();
        return true;
      }
    }
    if (!canMove) return false;

    // if clone was able to move, copy those mods over to us now instead of caller trying to do this all over!
    // Note: we can't use the list directly as elements and other parts point to actual node, so copy content
    clone.nodes.filter(n => n._dirty).forEach(c => {
      const n = this.nodes.find(a => a._id === c._id);
      if (!n) return;
      Utils.copyPos(n, c);
      n._dirty = true;
    });
    this._notify();
    return true;
  }

  /** return true if can fit in grid height constrain only (always true if no maxRow) */
  public willItFit(node: GridStackNode): boolean {
    delete node._willFitPos;
    if (!this.maxRow) return true;
    // create a clone with NO maxRow and check if still within size
    const clone = new GridStackEngine({
      column: this.column,
      float: this.float,
      nodes: this.nodes.map(n => {return {...n}})
    });
    const n = {...node}; // clone node so we don't mod any settings on it but have full autoPosition and min/max as well! #1687
    this.cleanupNode(n);
    delete n.el; delete n._id; delete n.content; delete n.grid;
    clone.addNode(n);
    if (clone.getRow() <= this.maxRow) {
      node._willFitPos = Utils.copyPos({}, n);
      return true;
    }
    return false;
  }

  /** true if x,y or w,h are different after clamping to min/max */
  public changedPosConstrain(node: GridStackNode, p: GridStackPosition): boolean {
    // first make sure w,h are set for caller
    p.w = p.w || node.w;
    p.h = p.h || node.h;
    if (node.x !== p.x || node.y !== p.y) return true;
    // check constrained w,h
    if (node.maxW) { p.w = Math.min(p.w, node.maxW); }
    if (node.maxH) { p.h = Math.min(p.h, node.maxH); }
    if (node.minW) { p.w = Math.max(p.w, node.minW); }
    if (node.minH) { p.h = Math.max(p.h, node.minH); }
    return (node.w !== p.w || node.h !== p.h);
  }

  /** return true if the passed in node was actually moved (checks for no-op and locked) */
  public moveNode(node: GridStackNode, o: GridStackMoveOpts): boolean {
    if (!node || /*node.locked ||*/ !o) return false;
    let wasUndefinedPack: boolean;
    if (o.pack === undefined && !this.batchMode) {
      wasUndefinedPack = o.pack = true;
    }

    // constrain the passed in values and check if we're still changing our node
    if (typeof o.x !== 'number') { o.x = node.x; }
    if (typeof o.y !== 'number') { o.y = node.y; }
    if (typeof o.w !== 'number') { o.w = node.w; }
    if (typeof o.h !== 'number') { o.h = node.h; }
    const resizing = (node.w !== o.w || node.h !== o.h);
    const nn: GridStackNode = Utils.copyPos({}, node, true); // get min/max out first, then opt positions next
    Utils.copyPos(nn, o);
    this.nodeBoundFix(nn, resizing);
    Utils.copyPos(o, nn);

    if (!o.forceCollide && Utils.samePos(node, o)) return false;
    const prevPos: GridStackPosition = Utils.copyPos({}, node);

    // check if we will need to fix collision at our new location
    const collides = this.collideAll(node, nn, o.skip);
    let needToMove = true;
    if (collides.length) {
      const activeDrag = node._moving && !o.nested;
      // check to make sure we actually collided over 50% surface area while dragging
      let collide = activeDrag ? this.directionCollideCoverage(node, o, collides) : collides[0];
      // if we're enabling creation of sub-grids on the fly, see if we're covering 80% of either one, if we didn't already do that
      if (activeDrag && collide && node.grid?.opts?.subGridDynamic && !node.grid._isTemp) {
        const over = Utils.areaIntercept(o.rect, collide._rect);
        const a1 = Utils.area(o.rect);
        const a2 = Utils.area(collide._rect);
        const perc = over / (a1 < a2 ? a1 : a2);
        if (perc > .8) {
          collide.grid.makeSubGrid(collide.el, undefined, node);
          collide = undefined;
        }
      }

      if (collide) {
        needToMove = !this._fixCollisions(node, nn, collide, o); // check if already moved...
      } else {
        needToMove = false; // we didn't cover >50% for a move, skip...
        if (wasUndefinedPack) delete o.pack;
      }
    }

    // now move (to the original ask vs the collision version which might differ) and repack things
    if (needToMove && !Utils.samePos(node, nn)) {
      node._dirty = true;
      Utils.copyPos(node, nn);
    }
    if (o.pack) {
      this._packNodes()
        ._notify();
    }
    return !Utils.samePos(node, prevPos); // pack might have moved things back
  }

  public getRow(): number {
    return this.nodes.reduce((row, n) => Math.max(row, n.y + n.h), 0);
  }

  public beginUpdate(node: GridStackNode): GridStackEngine {
    if (!node._updating) {
      node._updating = true;
      delete node._skipDown;
      if (!this.batchMode) this.saveInitial();
    }
    return this;
  }

  public endUpdate(): GridStackEngine {
    const n = this.nodes.find(n => n._updating);
    if (n) {
      delete n._updating;
      delete n._skipDown;
    }
    return this;
  }

  /** saves a copy of the largest column layout (eg 12 even when rendering oneColumnMode) so we don't loose orig layout,
   * returning a list of widgets for serialization */
  public save(saveElement = true, saveCB?: SaveFcn): GridStackNode[] {
    // use the highest layout for any saved info so we can have full detail on reload #1849
    const len = this._layouts?.length;
    const layout = len && this.column !== (len - 1) ? this._layouts[len - 1] : null;
    const list: GridStackNode[] = [];
    this.sortNodes();
    this.nodes.forEach(n => {
      const wl = layout?.find(l => l._id === n._id);
      // use layout info fields instead if set
      const w: GridStackNode = {...n, ...(wl || {})};
      Utils.removeInternalForSave(w, !saveElement);
      if (saveCB) saveCB(n, w);
      list.push(w);
    });
    return list;
  }

  /** @internal called whenever a node is added or moved - updates the cached layouts */
  public layoutsNodesChange(nodes: GridStackNode[]): GridStackEngine {
    if (!this._layouts || this._inColumnResize) return this;
    // remove smaller layouts - we will re-generate those on the fly... larger ones need to update
    this._layouts.forEach((layout, column) => {
      if (!layout || column === this.column) return this;
      if (column < this.column) {
        this._layouts[column] = undefined;
      }
      else {
        // we save the original x,y,w (h isn't cached) to see what actually changed to propagate better.
        // NOTE: we don't need to check against out of bound scaling/moving as that will be done when using those cache values. #1785
        const ratio = column / this.column;
        nodes.forEach(node => {
          if (!node._orig) return; // didn't change (newly added ?)
          const n = layout.find(l => l._id === node._id);
          if (!n) return; // no cache for new nodes. Will use those values.
          // Y changed, push down same amount
          // TODO: detect doing item 'swaps' will help instead of move (especially in 1 column mode)
          if (n.y >= 0 && node.y !== node._orig.y) {
            n.y += (node.y - node._orig.y);
          }
          // X changed, scale from new position
          if (node.x !== node._orig.x) {
            n.x = Math.round(node.x * ratio);
          }
          // width changed, scale from new width
          if (node.w !== node._orig.w) {
            n.w = Math.round(node.w * ratio);
          }
          // ...height always carries over from cache
        });
      }
    });
    return this;
  }

  /**
   * @internal Called to scale the widget width & position up/down based on the column change.
   * Note we store previous layouts (especially original ones) to make it possible to go
   * from say 12 -> 1 -> 12 and get back to where we were.
   *
   * @param prevColumn previous number of columns
   * @param column  new column number
   * @param layout specify the type of re-layout that will happen (position, size, etc...).
   * Note: items will never be outside of the current column boundaries. default (moveScale). Ignored for 1 column
   */
  public columnChanged(prevColumn: number, column: number, layout: ColumnOptions = 'moveScale'): GridStackEngine {
    if (!this.nodes.length || !column || prevColumn === column) return this;

    // simpler shortcuts layouts
    const doCompact = layout === 'compact' || layout === 'list';
    if (doCompact) {
      this.sortNodes(1); // sort with original layout once and only once (new column will affect order otherwise)
    }

    // cache the current layout in case they want to go back (like 12 -> 1 -> 12) as it requires original data IFF we're sizing down (see below)
    if (column < prevColumn) this.cacheLayout(this.nodes, prevColumn);
    this.batchUpdate(); // do this EARLY as it will call saveInitial() so we can detect where we started for _dirty and collision
    let newNodes: GridStackNode[] = [];
    let nodes = doCompact ? this.nodes : Utils.sort(this.nodes, -1); // current column reverse sorting so we can insert last to front (limit collision)

    // see if we have cached previous layout IFF we are going up in size (restore) otherwise always
    // generate next size down from where we are (looks more natural as you gradually size down).
    if (column > prevColumn && this._layouts) {
      const cacheNodes = this._layouts[column] || [];
      // ...if not, start with the largest layout (if not already there) as down-scaling is more accurate
      // by pretending we came from that larger column by assigning those values as starting point
      const lastIndex = this._layouts.length - 1;
      if (!cacheNodes.length && prevColumn !== lastIndex && this._layouts[lastIndex]?.length) {
        prevColumn = lastIndex;
        this._layouts[lastIndex].forEach(cacheNode => {
          const n = nodes.find(n => n._id === cacheNode._id);
          if (n) {
            // still current, use cache info positions
            if (!doCompact && !cacheNode.autoPosition) {
              n.x = cacheNode.x ?? n.x;
              n.y = cacheNode.y ?? n.y;
            }
            n.w = cacheNode.w ?? n.w;
            if (cacheNode.x == undefined || cacheNode.y === undefined) n.autoPosition = true;
          }
        });
      }

      // if we found cache re-use those nodes that are still current
      cacheNodes.forEach(cacheNode => {
        const j = nodes.findIndex(n => n._id === cacheNode._id);
        if (j !== -1) {
          const n = nodes[j];
          // still current, use cache info positions
          if (doCompact) {
            n.w = cacheNode.w; // only w is used, and don't trim the list
            return;
          }
          if (cacheNode.autoPosition || isNaN(cacheNode.x) || isNaN(cacheNode.y)) {
            this.findEmptyPosition(cacheNode, newNodes);
          }
          if (!cacheNode.autoPosition) {
            n.x = cacheNode.x ?? n.x;
            n.y = cacheNode.y ?? n.y;
            n.w = cacheNode.w ?? n.w;
            newNodes.push(n);
          }
          nodes.splice(j, 1);
        }
      });
    }

    // much simpler layout that just compacts
    if (doCompact) {
      this.compact(layout, false);
    } else {
      // ...and add any extra non-cached ones
      if (nodes.length) {
        if (typeof layout === 'function') {
          layout(column, prevColumn, newNodes, nodes);
        } else {
          const ratio = (doCompact || layout === 'none') ? 1 : column / prevColumn;
          const move = (layout === 'move' || layout === 'moveScale');
          const scale = (layout === 'scale' || layout === 'moveScale');
          nodes.forEach(node => {
            // NOTE: x + w could be outside of the grid, but addNode() below will handle that
            node.x = (column === 1 ? 0 : (move ? Math.round(node.x * ratio) : Math.min(node.x, column - 1)));
            node.w = ((column === 1 || prevColumn === 1) ? 1 : scale ? (Math.round(node.w * ratio) || 1) : (Math.min(node.w, column)));
            newNodes.push(node);
          });
          nodes = [];
        }
      }

      // finally re-layout them in reverse order (to get correct placement)
      newNodes = Utils.sort(newNodes, -1);
      this._inColumnResize = true; // prevent cache update
      this.nodes = []; // pretend we have no nodes to start with (add() will use same structures) to simplify layout
      newNodes.forEach(node => {
        this.addNode(node, false); // 'false' for add event trigger
        delete node._orig; // make sure the commit doesn't try to restore things back to original
      });
    }

    this.nodes.forEach(n => delete n._orig); // clear _orig before batch=false so it doesn't handle float=true restore
    this.batchUpdate(false, !doCompact);
    delete this._inColumnResize;
    return this;
  }

  /**
   * call to cache the given layout internally to the given location so we can restore back when column changes size
   * @param nodes list of nodes
   * @param column corresponding column index to save it under
   * @param clear if true, will force other caches to be removed (default false)
   */
  public cacheLayout(nodes: GridStackNode[], column: number, clear = false): GridStackEngine {
    const copy: GridStackNode[] = [];
    nodes.forEach((n, i) => {
      // make sure we have an id in case this is new layout, else re-use id already set
      if (n._id === undefined) {
        const existing = n.id ? this.nodes.find(n2 => n2.id === n.id) : undefined; // find existing node using users id
        n._id = existing?._id ?? GridStackEngine._idSeq++;
      }
      copy[i] = {x: n.x, y: n.y, w: n.w, _id: n._id} // only thing we change is x,y,w and id to find it back
    });
    this._layouts = clear ? [] : this._layouts || []; // use array to find larger quick
    this._layouts[column] = copy;
    return this;
  }

  /**
   * call to cache the given node layout internally to the given location so we can restore back when column changes size
   * @param node single node to cache
   * @param column corresponding column index to save it under
   */
  public cacheOneLayout(n: GridStackNode, column: number): GridStackEngine {
    n._id = n._id ?? GridStackEngine._idSeq++;
    const l: GridStackNode = {x: n.x, y: n.y, w: n.w, _id: n._id}
    if (n.autoPosition || n.x === undefined) { delete l.x; delete l.y; if (n.autoPosition) l.autoPosition = true; }
    this._layouts = this._layouts || [];
    this._layouts[column] = this._layouts[column] || [];
    const index = this.findCacheLayout(n, column);
    if (index === -1)
      this._layouts[column].push(l);
    else
      this._layouts[column][index] = l;
    return this;
  }

  protected findCacheLayout(n: GridStackNode, column: number): number | undefined {
    return this._layouts?.[column]?.findIndex(l => l._id === n._id) ?? -1;
  }

  public removeNodeFromLayoutCache(n: GridStackNode) {
    if (!this._layouts) {
      return;
    }
    for (let i = 0; i < this._layouts.length; i++) {
      const index = this.findCacheLayout(n, i);
      if (index !== -1) {
        this._layouts[i].splice(index, 1);
      }
    }
  }

  /** called to remove all internal values but the _id */
  public cleanupNode(node: GridStackNode): GridStackEngine {
    for (const prop in node) {
      if (prop[0] === '_' && prop !== '_id') delete node[prop];
    }
    return this;
  }
}
