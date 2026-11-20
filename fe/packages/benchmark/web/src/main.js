import { createContainer } from '@dimina/fe-container-sdk'
import '@dimina/fe-container-sdk/style.css'

const APP_ID = 'wxbench00000000001'
const ENTRY = 'pages/benchmark/index'

const query = new URLSearchParams(location.search)
const requestedCase = query.get('case') || 'set-data-primitive'
const requestedMode = query.get('mode') || 'baseline'
const warmup = clampInt(query.get('warmup'), 10, 0, 1000)
const iterations = clampInt(query.get('iterations'), 50, 1, 10000)

const mount = document.getElementById('container')
const status = document.getElementById('status')

let openStartedAt = 0
let settled = false

window.__DIMINA_BENCHMARK_RESULT__ = null
window.__DIMINA_BENCHMARK_META__ = {
	appId: APP_ID,
	entry: ENTRY,
	mode: requestedMode,
	case: requestedCase,
	warmup,
	iterations,
	userAgent: navigator.userAgent,
}

function setStatus(message) {
	if (status) {
		status.textContent = message
	}
}

function publishResult(report) {
	if (settled) return

	if (report?.error) {
		settled = true
		window.__DIMINA_BENCHMARK_RESULT__ = report
		setStatus(`ERROR\n${report.error}`)
		return
	}

	if (requestedCase === 'cold-start') {
		if (report?.name !== 'cold-start' || report?.ready !== true) {
			return
		}

		settled = true
		const duration = performance.now() - openStartedAt
		window.__DIMINA_BENCHMARK_RESULT__ = {
			name: 'cold-start',
			samples: [duration],
			metadata: report.metadata || {},
		}
		setStatus(`cold-start ready: ${duration.toFixed(3)} ms`)
		return
	}

	if (report?.name !== requestedCase || !Array.isArray(report?.samples)) {
		return
	}

	settled = true
	window.__DIMINA_BENCHMARK_RESULT__ = report
	setStatus(
		`${requestedCase}\n` +
		`samples: ${report.samples.length}\n` +
		`mode: ${requestedMode}`,
	)
}

const container = createContainer({
	mount,
	appTransitions: query.get('appTransitions') !== '0',
	resourceBaseUrl: `${location.origin}/miniapp/`,
	pageFrameUrl: `${location.origin}/pageFrame.html`,
	urlSync: false,
	getAppInfo: () => ({
		name: 'Dimina Benchmark',
	}),
	apis: {
		benchmarkReport(args = {}) {
			publishResult(args.report ?? args)
		},
	},
	onAppLaunchError(error) {
		const report = {
			name: requestedCase,
			error: error?.stack || error?.message || String(error),
		}
		publishResult(report)
		console.error('[benchmark] app launch failed', error)
	},
})

const pageQuery = new URLSearchParams({
	case: requestedCase,
	warmup: String(warmup),
	iterations: String(iterations),
	mode: requestedMode,
})

setStatus(
	`opening ${APP_ID}\n` +
	`case: ${requestedCase}\n` +
	`mode: ${requestedMode}\n` +
	`warmup: ${warmup}\n` +
	`iterations: ${iterations}`,
)

try {
	openStartedAt = performance.now()
	await container.openApp({
		appId: APP_ID,
		path: `${ENTRY}?${pageQuery.toString()}`,
		destroy: true,
		scene: 1001,
	})

	if (!settled) {
		setStatus(
			`running ${requestedCase}\n` +
			`mode: ${requestedMode}\n` +
			`waiting for wx.benchmarkReport…`,
		)
	}
}
catch (error) {
	publishResult({
		name: requestedCase,
		error: error?.stack || error?.message || String(error),
	})
	console.error('[benchmark] openApp failed', error)
}

function clampInt(value, fallback, min, max) {
	const parsed = Number.parseInt(value ?? '', 10)
	if (!Number.isFinite(parsed)) return fallback
	return Math.min(max, Math.max(min, parsed))
}
