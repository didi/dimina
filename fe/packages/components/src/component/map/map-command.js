export function mapPoint(value) {
	if (!value || !Number.isFinite(value.longitude) || !Number.isFinite(value.latitude)
		|| Math.abs(value.longitude) > 180 || Math.abs(value.latitude) > 90) throw new Error('invalid coordinate')
	return value
}

export function mapNumber(value, name, min = -Infinity, max = Infinity) {
	if (!Number.isFinite(value) || value < min || value > max) throw new Error(`invalid ${name}`)
	return value
}

export function validateMapCommand(command, args) {
	if (command === 'setCenterOffset') {
		if (!Array.isArray(args.offset) || args.offset.length !== 2) throw new Error('offset requires two values')
		args.offset.forEach(value => mapNumber(value, 'offset', 0.25, 0.75))
	}
	if (command === 'toScreenLocation') mapPoint(args)
	if (command === 'fromScreenLocation') { mapNumber(args.x, 'x'); mapNumber(args.y, 'y') }
	if (command === 'setBoundary') {
		const sw = mapPoint(args.southwest); const ne = mapPoint(args.northeast)
		if (sw.longitude >= ne.longitude || sw.latitude >= ne.latitude) throw new Error('invalid boundary')
	}
	if (command === 'translateMarker' || command === 'moveAlong') {
		if (!Number.isInteger(args.markerId)) throw new TypeError('invalid markerId')
		mapNumber(args.duration ?? 1000, 'duration', 0)
		if (command === 'translateMarker') {
			mapPoint(args.destination)
			mapNumber(args.rotate ?? 0, 'rotate')
		}
		else {
			if (!Array.isArray(args.path) || args.path.length < 2) throw new Error('path requires at least two points')
			args.path.forEach(mapPoint)
			if (args.precision !== undefined) mapNumber(args.precision, 'precision', 0)
		}
	}
}

// Sample a circular arc once in Mercator space. Every SDK receives the same path;
// no frame-by-frame bridge traffic or provider-specific interpretation of angle.
export function arcPoints(args) {
	if (!Number.isInteger(args.id)) throw new TypeError('invalid arc id')
	mapNumber(args.width ?? 5, 'width', 0)
	const project = (value) => {
		mapPoint(value)
		if (Math.abs(value.latitude) >= 85.051129) throw new Error('arc latitude exceeds Mercator range')
		return [value.longitude * Math.PI / 180, Math.log(Math.tan(Math.PI / 4 + value.latitude * Math.PI / 360))]
	}
	const a = project(args.start); const b = project(args.end)
	const dx = b[0] - a[0]; const dy = b[1] - a[1]
	if (Math.hypot(dx, dy) < 1e-12 || Math.abs(dx) > Math.PI) throw new Error('invalid arc endpoints')
	let center; let sweep
	if (args.angle !== undefined && args.angle !== 0) {
		const angle = mapNumber(args.angle, 'angle', -179.999, 179.999) * Math.PI / 180
		const cot = 1 / Math.tan(angle)
		center = [(a[0] + b[0] - dy * cot) / 2, (a[1] + b[1] + dx * cot) / 2]
		sweep = angle * 2
	}
	else {
		const c = project(args.pass)
		const ux = c[0] - a[0]; const uy = c[1] - a[1]
		const cross = dx * uy - dy * ux
		if (Math.abs(cross) < 1e-14) throw new Error('arc points must not be collinear')
		const d2 = dx * dx + dy * dy; const u2 = ux * ux + uy * uy
		center = [a[0] + (d2 * uy - u2 * dy) / (2 * cross), a[1] + (dx * u2 - ux * d2) / (2 * cross)]
		const start = Math.atan2(a[1] - center[1], a[0] - center[0])
		const positive = value => (value + Math.PI * 4) % (Math.PI * 2)
		const end = positive(Math.atan2(b[1] - center[1], b[0] - center[0]) - start)
		const pass = positive(Math.atan2(c[1] - center[1], c[0] - center[0]) - start)
		sweep = pass <= end ? end : end - Math.PI * 2
	}
	const radius = Math.hypot(a[0] - center[0], a[1] - center[1])
	const start = Math.atan2(a[1] - center[1], a[0] - center[0])
	const count = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 90)))
	return Array.from({ length: count + 1 }, (_, index) => {
		if (!index) return { longitude: args.start.longitude, latitude: args.start.latitude }
		if (index === count) return { longitude: args.end.longitude, latitude: args.end.latitude }
		const angle = start + sweep * index / count
		return mapPoint({ longitude: (center[0] + radius * Math.cos(angle)) * 180 / Math.PI,
			latitude: (2 * Math.atan(Math.exp(center[1] + radius * Math.sin(angle))) - Math.PI / 2) * 180 / Math.PI })
	})
}
