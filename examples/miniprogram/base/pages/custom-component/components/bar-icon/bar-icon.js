let lifecycleInstanceSeed = 0

function logLifecycle(component, event, details) {
	console.log('[Lifecycle][Component:bar-icon]', {
		event,
		instance: component.__lifecycleInstanceId,
		label: component.properties.instanceId,
		...(details || {}),
	})
}

Component({
	properties: {
		instanceId: {
			type: String,
			value: 'unlabeled',
		},
	},
	data: {
		tapCount: 0,
	},
	methods: {
		selectIcon() {
			const tapCount = this.data.tapCount + 1
			this.setData({ tapCount })
			console.log('[Interaction][Component:bar-icon]', {
				event: 'tap',
				instance: this.__lifecycleInstanceId,
				label: this.properties.instanceId,
				tapCount,
			})
			this.triggerEvent('selectIcon', {
				type: 'icon',
				instanceId: this.properties.instanceId,
				tapCount,
			})
		}
	},
	lifetimes: {
		created() {
			lifecycleInstanceSeed += 1
			this.__lifecycleInstanceId = `bar-icon-${lifecycleInstanceSeed}`
			logLifecycle(this, 'created')
		},
		ready() {
			logLifecycle(this, 'ready')
		},
		attached() {
			logLifecycle(this, 'attached')
		},
		moved() {
			logLifecycle(this, 'moved')
		},
		detached() {
			logLifecycle(this, 'detached')
		},
		error(error) {
			logLifecycle(this, 'error', { error })
		},
	},
	pageLifetimes: {
		show() {
			logLifecycle(this, 'pageLifetimes.show')
		},
		hide() {
			logLifecycle(this, 'pageLifetimes.hide')
		},
		resize(size) {
			logLifecycle(this, 'pageLifetimes.resize', { size })
		},
		routeDone() {
			logLifecycle(this, 'pageLifetimes.routeDone')
		},
	},
})
