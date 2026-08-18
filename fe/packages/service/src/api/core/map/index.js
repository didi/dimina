import { invokeAPI } from '@/api/common'

export function createMapContext(mapId, obj) {
	return new MapContext({ mapId, obj })
}

class MapContext {
	constructor(opts) {
		this.opts = opts
	}

	addMarkers(data) {
		return this.invoke('addMarkers', data)
	}

	removeMarkers(data) {
		return this.invoke('removeMarkers', data)
	}

	includePoints(data) {
		return this.invoke('includePoints', data)
	}

	setCenterOffset(data) {
		return this.invoke('setCenterOffset', data)
	}

	getCenterLocation(data) {
		return this.invoke('getCenterLocation', data)
	}

	getScale(data) {
		return this.invoke('getScale', data)
	}

	moveToLocation(data) {
		return this.invoke('moveToLocation', data)
	}

	translateMarker(data) {
		return this.invoke('translateMarker', data)
	}

	addArc(data) {
		return this.invoke('addArc', data)
	}

	removeArc(data) {
		return this.invoke('removeArc', data)
	}

	invoke(apiName, data = {}) {
		return invokeAPI(apiName, {
			mapId: this.opts.mapId,
			...data,
		})
	}
}
