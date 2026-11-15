import { loadAMap } from './amap-loader'
import { arcPoints, validateMapCommand } from '../map-command'
import { markerMotion } from '../marker-motion'

function point(value) {
	if (!value || typeof value.longitude !== 'number' || typeof value.latitude !== 'number'
		|| !Number.isFinite(value.longitude) || !Number.isFinite(value.latitude)
		|| Math.abs(value.longitude) > 180 || Math.abs(value.latitude) > 90) {
		throw new Error('invalid longitude or latitude')
	}
	return [value.longitude, value.latitude]
}
function coordinate(value) {
	return { longitude: value.getLng(), latitude: value.getLat() }
}
function number(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function color(value) {
	const match = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(value)
	return match ? [`#${match[1]}`, Number.parseInt(match[2], 16) / 255] : [value, 1]
}
function textNode(doc, content) {
	const node = doc.createElement('div')
	node.textContent = String(content ?? '')
	return node
}

export async function createAMap({ element, props, emit, options: config, getLocation, signal }) {
	const AMap = await loadAMap(config, element.ownerDocument)
	if (signal.aborted) throw new Error('map destroyed')
	const map = new AMap.Map(element, {
		center: point(props), zoom: props.scale, viewMode: '3D',
		zooms: [props.minScale, props.maxScale],
	})
	let destroyed = false
	let previous = {}
	let locationRevision = 0
	let locationMarker
	let scaleControl
	let compassControl
	let centerOffset = [0.5, 0.5]
	const arcs = new Map()
	const animations = new Map()
	let animationFrame = 0
	let rejectReady
	const ready = new Promise((resolve, reject) => {
		rejectReady = reject
		map.on('complete', resolve)
	})
	ready.catch(() => {})
	const markers = new Map()
	const geometries = new Map()
	const listeners = []
	const on = (target, event, handler) => {
		target.on(event, handler)
		listeners.push(() => target.off(event, handler))
	}
	const destroy = () => {
		if (destroyed) return
		destroyed = true
		rejectReady(new Error('map destroyed'))
		locationRevision++
		if (animationFrame) cancelAnimationFrame(animationFrame)
		for (const id of animations.keys()) cancelMotion(id, 'map destroyed')
		listeners.splice(0).forEach(off => off())
		for (const entry of markers.values()) entry.dispose()
		markers.clear()
		map.destroy()
		signal.removeEventListener('abort', destroy)
	}
	signal.addEventListener('abort', destroy, { once: true })
	const assertActive = () => { if (destroyed) throw new Error('map destroyed') }
	const fire = (type, detail = {}) => { if (!destroyed) emit(type, detail) }

	function makeMarker(data) {
		const options = { position: point(data), title: data.title || '', angle: number(data.rotate, 0), zIndex: number(data.zIndex, 12) }
		if (data.iconPath) {
			const img = element.ownerDocument.createElement('img')
			img.src = data.iconPath
			img.style.width = `${number(data.width, 24)}px`
			img.style.height = `${number(data.height, 32)}px`
			options.content = img
		}
		const marker = new AMap.Marker(options)
		const markerDetail = data.id === undefined ? {} : { markerId: data.id }
		let callout
		let calloutNode
		const calloutTap = () => fire('callouttap', markerDetail)
		if (data.callout?.content) {
			calloutNode = textNode(element.ownerDocument, data.callout.content)
			calloutNode.addEventListener('click', calloutTap)
			callout = new AMap.InfoWindow({ content: calloutNode })
		}
		const tap = () => {
			fire('markertap', markerDetail)
			callout?.open(map, marker.getPosition())
		}
		marker.on('click', tap)
		return {
			marker,
			attach() {
				map.add(marker)
				if (data.callout?.display === 'ALWAYS') callout?.open(map, marker.getPosition())
			},
				dispose() {
					cancelMotion(data.id, 'marker removed')
				marker.off('click', tap)
				calloutNode?.removeEventListener('click', calloutTap)
				callout?.close()
				map.remove(marker)
			},
		}
	}
	function cancelMotion(id, reason) {
		const motion = animations.get(id)
		if (!motion) return
		animations.delete(id)
		motion.reject(new Error(reason))
		if (!animations.size && animationFrame) { cancelAnimationFrame(animationFrame); animationFrame = 0 }
	}
	function animate(command, args) {
		const marker = markers.get(args.markerId)?.marker
		if (!marker) throw new Error('marker not found')
		const path = command === 'translateMarker' ? [coordinate(marker.getPosition()), args.destination] : args.path
		const separateRotation = command === 'translateMarker' && !args.moveWithRotate && !args.autoRotate
		const sample = markerMotion(path, { angle: marker.getAngle(), rotate: args.rotate, autoRotate: args.autoRotate, separateRotation })
		cancelMotion(args.markerId, 'marker animation replaced')
		const duration = (args.duration ?? 1000) * (separateRotation ? 2 : 1)
		let lastDistance = 0
		const apply = progress => {
			const value = sample(progress)
			marker.setPosition([value.longitude, value.latitude]); marker.setAngle(value.rotate)
			if (args.precision > 0 && (progress === 1 || value.distance - lastDistance >= args.precision)) {
				lastDistance = value.distance
				fire('interpolatepoint', { markerId: args.markerId, longitude: value.longitude, latitude: value.latitude,
					animationStatus: progress === 1 ? 'complete' : 'interpolating' })
			}
			return value
		}
		if (!duration) { apply(1); return }
		apply(0)
		return new Promise((resolve, reject) => {
			animations.set(args.markerId, { start: performance.now(), duration, apply, resolve, reject })
			if (!animationFrame) animationFrame = requestAnimationFrame(tick)
		})
	}
	function tick(now) {
		animationFrame = 0
		for (const [id, motion] of animations) {
			try {
				const progress = Math.min(1, (now - motion.start) / motion.duration)
				motion.apply(progress)
				if (progress === 1) { animations.delete(id); motion.resolve({}) }
			}
			catch (error) { animations.delete(id); motion.reject(error) }
		}
		if (animations.size) animationFrame = requestAnimationFrame(tick)
	}
	function logicalCenter() {
		if (centerOffset[0] === 0.5 && centerOffset[1] === 0.5) return map.getCenter()
		const size = map.getSize()
		return map.containerToLngLat(new AMap.Pixel(size.getWidth() * centerOffset[0], size.getHeight() * centerOffset[1]))
	}
	function moveCenter(center) {
		map.setCenter(center, true)
		if (centerOffset[0] !== 0.5 || centerOffset[1] !== 0.5) {
			const size = map.getSize()
			map.panBy((centerOffset[0] - 0.5) * size.getWidth(), (centerOffset[1] - 0.5) * size.getHeight(), 0)
		}
	}
	function addMarkers(data, clear = false) {
		if (!Array.isArray(data)) throw new TypeError('markers must be an array')
		const next = new Map()
		try {
			for (const item of data) {
				if (item.id !== undefined && (!Number.isInteger(item.id) || next.has(item.id))) throw new Error('marker id must be a unique integer')
				// Symbols never collide with an explicit numeric ID and are never exposed.
				next.set(item.id === undefined ? Symbol('anonymous marker') : item.id, makeMarker(item))
			}
		}
		catch (error) {
			for (const entry of next.values()) entry.dispose()
			throw error
		}
		if (clear) {
			for (const entry of markers.values()) entry.dispose()
			markers.clear()
		}
		for (const [id, entry] of next) {
			markers.get(id)?.dispose()
			markers.set(id, entry)
			entry.attach()
		}
	}
	function includePoints({ points, padding = [0, 0, 0, 0] }) {
		if (!Array.isArray(points) || points.length === 0) throw new Error('points must be a non-empty array')
		if (!Array.isArray(padding) || padding.length !== 4 || padding.some(n => !Number.isFinite(n) || n < 0)) {
			throw new Error('padding must contain four non-negative numbers')
		}
		const positions = points.map(point)
		const southwest = [Infinity, Infinity]
		const northeast = [-Infinity, -Infinity]
		for (const [longitude, latitude] of positions) {
			southwest[0] = Math.min(southwest[0], longitude)
			southwest[1] = Math.min(southwest[1], latitude)
			northeast[0] = Math.max(northeast[0], longitude)
			northeast[1] = Math.max(northeast[1], latitude)
		}
		// Fit coordinates directly, without relying on temporary marker geometry.
		// WeChat: top/right/bottom/left; AMap: top/bottom/left/right.
		const [zoom, center] = map.getFitZoomAndCenterByBounds(
			new AMap.Bounds(southwest, northeast), [padding[0], padding[2], padding[3], padding[1]],
		)
		map.setZoomAndCenter(zoom, center, true)
	}
	function replaceGeometry(type, data) {
		const next = []
		try {
			for (const item of data) {
				const [strokeColor, strokeOpacity] = color(item.color || item.strokeColor || '#000000')
				const [fillColor, fillOpacity] = color(item.fillColor || '#00000000')
				const options = { strokeColor, strokeOpacity, strokeWeight: number(item.width ?? item.strokeWidth, 1), fillColor, fillOpacity }
				if (type === 'circles') {
					if (!Number.isFinite(item.radius) || item.radius < 0) throw new Error('invalid circle radius')
					next.push(new AMap.Circle({ ...options, center: point(item), radius: item.radius }))
				}
				else {
					const path = item.points.map(point)
					const Constructor = type === 'polyline' ? AMap.Polyline : AMap.Polygon
					next.push(new Constructor({ ...options, path, strokeStyle: item.dottedLine ? 'dashed' : 'solid' }))
				}
			}
		}
		catch (error) { next.forEach(overlay => overlay.setMap(null)); throw error }
		map.remove(geometries.get(type) || [])
		map.add(next)
		geometries.set(type, next)
	}
	async function locate() {
		if (typeof getLocation !== 'function') throw new TypeError('host location provider is not configured')
		const location = await getLocation({ type: 'gcj02', signal })
		assertActive()
		return point(location)
	}
	async function showLocation(revision) {
		const position = await locate()
		if (revision !== locationRevision) return
		locationMarker?.setMap(null)
		locationMarker = new AMap.CircleMarker({ center: position, radius: 6, fillColor: '#1677ff', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2 })
		map.add(locationMarker)
	}
	function update(next) {
		assertActive()
		const changed = key => JSON.stringify(next[key]) !== JSON.stringify(previous[key])
		const centerChanged = changed('longitude') || changed('latitude')
		const cameraChanged = centerChanged || changed('scale') || changed('rotate') || changed('skew')
		const offsetActive = centerOffset[0] !== 0.5 || centerOffset[1] !== 0.5
		const center = centerChanged ? point(next) : cameraChanged && offsetActive ? logicalCenter() : undefined
		if (changed('scale')) map.setZoom(number(next.scale, 16), true)
		if (changed('minScale') || changed('maxScale')) map.setZooms([number(next.minScale, 3), number(next.maxScale, 22)])
		map.setStatus({ dragEnable: next.enableScroll, zoomEnable: next.enableZoom, rotateEnable: next.enableRotate, pitchEnable: next.enableOverlooking })
		if (changed('rotate')) map.setRotation(number(next.rotate, 0), true)
		if (changed('skew')) map.setPitch(number(next.skew, 0), true)
		if (center) moveCenter(center)
		if (changed('markers')) addMarkers(next.markers || [], true)
		for (const type of ['polyline', 'polygons', 'circles']) if (changed(type)) replaceGeometry(type, next[type] || [])
		if (changed('includePoints') && next.includePoints?.length) includePoints({ points: next.includePoints })
		if (changed('showScale')) {
			if (next.showScale) { scaleControl = new AMap.Scale(); map.addControl(scaleControl) }
			else if (scaleControl) { map.removeControl(scaleControl); scaleControl = null }
		}
		if (changed('showCompass')) {
			if (next.showCompass) { compassControl = new AMap.ControlBar({ showControlButton: false }); map.addControl(compassControl) }
			else if (compassControl) { map.removeControl(compassControl); compassControl = null }
		}
		if (changed('showLocation')) {
			const revision = ++locationRevision
			if (next.showLocation) showLocation(revision).catch(error => {
				if (revision === locationRevision) fire('error', { errMsg: `map:fail ${error.message}` })
			})
			else { locationMarker?.setMap(null); locationMarker = null }
		}
		previous = next
	}
	const methods = {
		getCenterLocation: () => coordinate(logicalCenter()),
		getScale: () => ({ scale: map.getZoom() }),
		getRotate: () => ({ rotate: map.getRotation() }),
		getSkew: () => ({ skew: map.getPitch() }),
		toScreenLocation(data) {
			const pixel = map.lngLatToContainer(point(data))
			return { x: pixel.getX(), y: pixel.getY() }
		},
		fromScreenLocation: data => coordinate(map.containerToLngLat(new AMap.Pixel(data.x, data.y))),
		setCenterOffset(data) { const center = logicalCenter(); centerOffset = [...data.offset]; moveCenter(center) },
		setBoundary(data) { map.setLimitBounds(new AMap.Bounds(point(data.southwest), point(data.northeast))) },
		translateMarker: data => animate('translateMarker', data),
		moveAlong: data => animate('moveAlong', data),
		addArc(data) {
			const path = arcPoints(data).map(point)
			const [strokeColor, strokeOpacity] = color(data.color || '#000000')
			const arc = new AMap.Polyline({ path, strokeColor, strokeOpacity, strokeWeight: data.width ?? 5 })
			map.add(arc)
			if (arcs.has(data.id)) map.remove(arcs.get(data.id))
			arcs.set(data.id, arc)
		},
		removeArc(data) { if (arcs.has(data.id)) { map.remove(arcs.get(data.id)); arcs.delete(data.id) } },
		getRegion: () => ({ southwest: coordinate(map.getBounds().getSouthWest()), northeast: coordinate(map.getBounds().getNorthEast()) }),
		addMarkers: data => addMarkers(data.markers, data.clear === true),
		removeMarkers(data) {
			if (!Array.isArray(data.markerIds)) throw new TypeError('markerIds must be an array')
			for (const id of data.markerIds) { markers.get(id)?.dispose(); markers.delete(id) }
		},
		includePoints,
		async moveToLocation(data) {
			const position = data.longitude === undefined && data.latitude === undefined ? await locate() : point(data)
			moveCenter(position)
		},
	}
	try {
		on(map, 'click', event => fire('tap', coordinate(event.lnglat)))
		on(map, 'complete', () => { fire('updated'); fire('rendersuccess') })
		for (const event of ['movestart', 'moveend', 'zoomstart', 'zoomend']) {
			on(map, event, source => fire('regionchange', {
				type: event.endsWith('start') ? 'begin' : 'end',
				causedBy: source?.originEvent ? (event.startsWith('zoom') ? 'scale' : 'drag') : 'update',
				centerLocation: coordinate(logicalCenter()), scale: map.getZoom(),
			}))
		}
		update(props)
		await ready
	}
	catch (error) { destroy(); throw error }
	return {
		update, destroy,
		invoke(command, params) {
			assertActive()
			validateMapCommand(command, params)
			if (!Object.prototype.hasOwnProperty.call(methods, command)) throw new Error(`AMap provider does not support ${command}`)
			return methods[command](params)
		},
	}
}
