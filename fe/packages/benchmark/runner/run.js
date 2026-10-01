import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { cases } from './cases.js'
import { config, modes } from './config.js'
import { summarize } from './stats.js'

function readArg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`)
	return index >= 0 ? process.argv[index + 1] : fallback
}

const selectedMode = readArg('mode', 'baseline')
const selectedCase = readArg('case', null)

if (!modes.includes(selectedMode)) {
	throw new Error(`Unknown mode: ${selectedMode}`)
}

const selectedCases = selectedCase
	? cases.filter(name => name === selectedCase)
	: cases

if (!selectedCases.length) {
	throw new Error(`Unknown case: ${selectedCase}`)
}

const browser = await chromium.launch({
	headless: process.env.HEADLESS !== '0',
	args: [
		'--disable-background-timer-throttling',
		'--disable-renderer-backgrounding',
	],
})

const context = await browser.newContext({
	viewport: {
		width: 1180,
		height: 920,
	},
})

const page = await context.newPage()

page.on('console', (message) => {
	if (process.env.DIMINA_BENCH_BROWSER_LOGS === '1') {
		console.log(`[browser:${message.type()}] ${message.text()}`)
	}
})

page.on('pageerror', (error) => {
	console.error('[browser:error]', error)
})

const result = {
	generatedAt: new Date().toISOString(),
	mode: selectedMode,
	config: {
		warmup: config.warmup,
		iterations: config.iterations,
		url: config.url,
	},
	environment: {
		node: process.version,
		browser: await browser.version(),
	},
	cases: {},
}

for (const name of selectedCases) {
	const samples = name === 'cold-start'
		? await runColdStart(page, name)
		: await runCase(page, name)

	const summary = summarize(samples)
	result.cases[name] = {
		timingMs: summary,
		rawSamplesMs: samples,
	}

	console.log(
		`${name.padEnd(28)} ` +
		`median=${summary.median.toFixed(3)}ms ` +
		`p95=${summary.p95.toFixed(3)}ms ` +
		`p99=${summary.p99.toFixed(3)}ms`,
	)
}

await fs.mkdir(config.outputDir, { recursive: true })
const outputFile = path.join(config.outputDir, `${selectedMode}.json`)
await fs.writeFile(outputFile, JSON.stringify(result, null, 2))

await browser.close()
console.log(`\nSaved ${outputFile}`)

async function runCase(page, name) {
	const url = createCaseUrl(name, {
		warmup: config.warmup,
		iterations: config.iterations,
	})

	await page.goto(url, {
		waitUntil: 'domcontentloaded',
		timeout: config.timeout,
	})

	const report = await waitForReport(page)
	if (report.error) {
		throw new Error(`${name}: ${report.error}`)
	}

	if (!Array.isArray(report.samples)) {
		throw new TypeError(`${name}: benchmark report has no samples`)
	}

	return report.samples
}

async function runColdStart(page, name) {
	const samples = []
	const totalRuns = config.warmup + config.iterations

	for (let i = 0; i < totalRuns; i += 1) {
		const url = createCaseUrl(name, {
			warmup: 0,
			iterations: 1,
			run: i,
		})

		await page.goto(url, {
			waitUntil: 'domcontentloaded',
			timeout: config.timeout,
		})

		const report = await waitForReport(page)
		if (report.error) {
			throw new Error(`${name}: ${report.error}`)
		}

		const sample = report.samples?.[0]
		if (!Number.isFinite(sample)) {
			throw new TypeError(`${name}: invalid cold-start sample`)
		}

		if (i >= config.warmup) {
			samples.push(sample)
		}
	}

	return samples
}

function createCaseUrl(name, extra = {}) {
	const url = new URL(config.url)
	url.searchParams.set('case', name)
	url.searchParams.set('mode', selectedMode)
	url.searchParams.set('warmup', String(extra.warmup ?? config.warmup))
	url.searchParams.set('iterations', String(extra.iterations ?? config.iterations))
	url.searchParams.set('_run', String(extra.run ?? Date.now()))
	return url.toString()
}

async function waitForReport(page) {
	await page.waitForFunction(
		() => window.__DIMINA_BENCHMARK_RESULT__ !== null,
		null,
		{ timeout: config.timeout },
	)

	return page.evaluate(() => window.__DIMINA_BENCHMARK_RESULT__)
}
