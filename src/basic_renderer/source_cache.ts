import Cache from '../source/tile_cache';
import assert from 'assert';
import Tile from '../source/tile';
import Point from '@mapbox/point-geometry';
import EXTENT from '../data/extent';
import SphericalMercator from '@mapbox/sphericalmercator';
import type {SourceSpecification} from '../style-spec/types';
import type Dispatcher from '../util/dispatcher';
import {create as createSource} from '../source/source';
import {Evented} from '../util/evented';
//import SourceCache from "maplibre-gl-js/src/source/source_cache";

const sphericalMercator = new SphericalMercator();

const TILE_CACHE_SIZE = 20;

const TILE_LOAD_TIMEOUT = 60 * 1000;

/*
  This "owns" tiles, with each tile existing in at most one of the following two places:
    + _tilesInUse - a map from tileID.key => tile, where the tiles have a .uses counter
    + _tileCache - a Least Recently Used cache, also from tileID.key => tile.
  In addition, one of the _tilesInUse may also appear as the following:
    + currentlyRenderingTiles - a list of tiles that we actually want to be able to paint
*/

interface ExtTile extends Tile {
  cache: any;
  loadedPromise: Promise<void>;
  _isDud: boolean;
}

class BasicSourceCache extends Evented {
  _source;
  _tilesInUse = {}; // tileID.key => tile (note that tile's have a .uses counter)
  map = {};
  _tileCache;
  currentlyRenderingTiles;
  _maxTileCacheSize: number;
  dispatcher: any;
  id: string;

  constructor(
    id: string,
    options: SourceSpecification,
    dispatcher: Dispatcher
  ) {
      super();
      this.id = id;
      this.dispatcher = dispatcher;

      this._source = createSource(id, options, dispatcher, this);

      this._tileCache = new Cache(TILE_CACHE_SIZE, (t) =>
          this._source.unloadTile(t)
      );
  }
  getSource() {
      return this._source;
  }
  getVisibleCoordinates() {
      return this.currentlyRenderingTiles.map((t) => t.tileID);
  }
  getRenderableIds() {
      return this.getVisibleCoordinates();
  }
  acquireTile(tileID: any, size) {
      // important: every call to acquireTile should be paired with a call to releaseTile
      // you can also manually increment tile.uses, however do not decrement it directly, instead
      // call releaseTile.
      const tile = new Tile(tileID.wrapped(), size) as ExtTile;
      tile.uses++;
      this._tilesInUse[tileID.key] = tile;

      tile.cache = this; // redundant if tile is not new
      if (tile.loadedPromise) {
          return tile;
      }

      // We need to actually issue the load request, and express it as a promise...
      tile.loadedPromise = new Promise((res, rej) => {
      // note that we don't touch the .uses counter here on errors
          const timeout = setTimeout(() => {
              this._source.abortTile(tile, console.log);
              tile.loadedPromise = null;
              rej(new Error('timeout'));
          }, TILE_LOAD_TIMEOUT);
          this._source.loadTile(tile, (err) => {
              clearTimeout(timeout);
              if (err) {
                  console.error(err);
                  tile._isDud = true; // we can consider it to "have data", i.e. we will let it go into the cache
                  rej(err);
              } else {
                  res();
              }
          });
      });

      return tile;
  }
  getTileByID(tileID) {
      return this.getTile(tileID); //alias
  }

  getTile(tileID) {
      // note that the requested tile should actually also feature in currentlyRenderingTiles..but that's harder to query
      return this._tilesInUse[tileID.key];
  }

  serialize() {
      return this._source.serialize();
  }
  prepare(context) {
      this.currentlyRenderingTiles.forEach((t) => t.upload(context));
  }
  releaseTile(tile) {
      assert(tile.uses > 0);
      if (--tile.uses > 0) {
          return;
      }
      delete this._tilesInUse[tile.tileID.key];
      if (tile.hasData() || tile._isDud) {
      // this tile is worth keeping...
          this._tileCache.add(tile.tileID, tile);
      } else {
      // this tile isn't ready and isn't needed, so abandon it...
          this._source.abortTile(tile);
          this._source.unloadTile(tile);
      }
  }

  loaded() {
      if (!this._source.loaded()) {
          return false;
      }
      if (Object.keys(this._tilesInUse).length > 0) {
          return false;
      }
      return true;
  }

  invalidateAllLoadedTiles() {
      // this needs to be called on all changes: style, layers visible, resolution (i.e. zoom)
      // by removing the loadedPromise, we force a fresh load next time the tile
      // is needed...although note that "fresh" is only partial because the rawData
      // is still available.
      Object.values(this._tilesInUse).forEach((t: ExtTile) => {
          return !t._isDud && (t.loadedPromise = null);
      });
      this._tileCache.keys().forEach((id) => {
          const tile = this._tileCache.get(id);
          if (!tile._isDud) (tile.loadedPromise = null);
      });
  }

  tilesIn(opts) {
      const tileXY = sphericalMercator
          .px([opts.lng, opts.lat], opts.tileZ, false)
          .map((x) => x / 256 /* why 256? */);
      const tileX = tileXY[0] | 0;
      const tileY = tileXY[1] | 0;
      const pointXY = tileXY.map((x) => (x - (x | 0)) * EXTENT);
      const pointX = pointXY[0];
      const pointY = pointXY[1];

      return Object.values(this._tilesInUse)
          .filter((t: ExtTile) => t.hasData()) // we are a bit lazy in terms of ensuring the data matches the rendered styles etc. ..could check loadedPromise has resolved
          .map((t: ExtTile) => ({
              tile: t,
              tileID: t.tileID,
              queryGeometry: [
                  [
                      Point.convert([
                          // for all but the 0th coord, we need to adjust the pointXY values to lie suitably outside the [0,EXTENT] range
                          pointX + EXTENT * (tileX - t.tileID.canonical.x),
                          pointY + EXTENT * (tileY - t.tileID.canonical.y),
                      ]),
                  ],
              ],
              scale: 1,
          }));
  }

  reload() {}
  pause() {}
  resume() {}
  onAdd(map: Map<any, any>) {
      this.map = map;
      // @ts-ignore
      this._maxTileCacheSize = map ? map._maxTileCacheSize : null;
      if (this._source && this._source.onAdd) {
          this._source.onAdd(map);
      }
  }
}

export default BasicSourceCache;
