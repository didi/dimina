import { invokeAPI } from '@/api/common'

export function createMapContext(mapId, obj) {
	return new MapContext({ mapId, obj })
}

class MapContext {
	constructor(opts) {
		this.opts = opts
	}

	addMarkers(data) {
		return invokeAPI('addMarkers', data)
	}

	removeMarkers(data) {
		return invokeAPI('removeMarkers', data)
	}

	includePoints(data) {
		return invokeAPI('includePoints', data)
	}

	setCenterOffset(data) {
		return invokeAPI('setCenterOffset', data)
	}

	getCenterLocation(data) {
		return invokeAPI('getCenterLocation', data)
	}

	getScale(data) {
		return invokeAPI('getScale', data)
	}

	moveToLocation(data) {
		return invokeAPI('moveToLocation', data)
	}

	translateMarker(data) {
		return invokeAPI('translateMarker', data)
	}

	addArc(data) {
		return invokeAPI('addArc', data)
	}

	removeArc(data) {
		return invokeAPI('removeArc', data)
	}
}
