export type LaunchPhase =
	| 'launch-start'
	| 'worker-created'
	| 'config-loaded'
	| 'page-frame-ready'
	| 'resource-load-start'
	| 'service-resources-ready'
	| 'render-resources-ready'
	| 'first-render-sent'
	| 'dom-ready'
	| 'launch-ready'
	| 'launch-failed'

export type LaunchFailure =
	| 'worker-start'
	| 'app-config'
	| 'page-frame'
	| 'worker-error'
	| 'service-resources-timeout'
	| 'render-resources'
	| 'render-resources-timeout'
	| 'first-render-timeout'
	| 'restore-page-stack'
	| 'page-startup'

export interface LaunchDiagnosticEvent {
	appId: string
	pagePath?: string
	bridgeId?: string
	resourceLoadId?: string
	phase: LaunchPhase
	failure?: LaunchFailure
}

export interface LaunchDiagnosticsOptions {
	/** Versions of the artifacts that the host actually uses. */
	versions?: { host?: string, sdk?: string, jssdk?: string, compiler?: string }
	/** Observes sanitized launch events as they happen. */
	onEvent?: (event: LaunchDiagnosticsSnapshot['events'][number]) => void
}

export interface LaunchDiagnosticsSnapshot {
	schemaVersion: 1
	versions: NonNullable<LaunchDiagnosticsOptions['versions']>
	/** Monotonic milliseconds since the collector was created. */
	events: (LaunchDiagnosticEvent & { elapsedMs: number })[]
}

const MAX_EVENTS = 200

export class LaunchDiagnostics {
	private readonly startTime = performance.now()
	private readonly events: LaunchDiagnosticsSnapshot['events'] = []
	private readonly versions: LaunchDiagnosticsSnapshot['versions']
	private readonly onEvent: LaunchDiagnosticsOptions['onEvent']

	constructor(options: LaunchDiagnosticsOptions) {
		const { host, sdk, jssdk, compiler } = options.versions ?? {}
		this.versions = { host, sdk, jssdk, compiler }
		this.onEvent = options.onEvent
	}

	record(event: LaunchDiagnosticEvent): void {
		if (this.events.length === MAX_EVENTS) this.events.shift()
		const { appId, pagePath, bridgeId, resourceLoadId, phase, failure } = event
		const recorded = {
			appId,
			pagePath: typeof pagePath === 'string' ? pagePath.split(/[?#]/, 1)[0] : undefined,
			bridgeId,
			resourceLoadId,
			phase,
			failure,
			elapsedMs: Math.round(performance.now() - this.startTime),
		}
		this.events.push(recorded)
		try {
			this.onEvent?.({ ...recorded })
		}
		catch {
			// Hosting diagnostics must not affect page startup.
		}
	}

	snapshot(): LaunchDiagnosticsSnapshot {
		return {
			schemaVersion: 1,
			versions: { ...this.versions },
			events: this.events.map(event => ({ ...event })),
		}
	}
}
