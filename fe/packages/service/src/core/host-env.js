class HostEnv {
	constructor() {
		this.reset()
	}

	reset() {
		this.active = false
		this.snapshot = {
			systemInfo: null,
			menuRect: null,
		}
	}

	init(snapshot = {}) {
		this.active = true
		this.snapshot = {
			...this.snapshot,
			...snapshot,
		}
	}

	update(patch = {}) {
		this.snapshot = {
			...this.snapshot,
			...patch,
		}
	}

	get(key) {
		if (!this.active) {
			return null
		}
		return this.snapshot[key] ?? null
	}

	getSystemInfo() {
		return this.get('systemInfo')
	}

	getMenuRect() {
		return this.get('menuRect')
	}
}

export default new HostEnv()
