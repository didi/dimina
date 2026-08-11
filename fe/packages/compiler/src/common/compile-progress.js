import process from 'node:process'
import { isUnicodeSupported } from 'listr2'

const DEFAULT_TERMINAL_COLUMNS = 80
const MIN_PROGRESS_WIDTH = 8
const MAX_PROGRESS_WIDTH = 28
const RENDERER_CHROME_WIDTH = 14
const PROGRESS_BRACKETS_WIDTH = 2
const RESET_FOREGROUND = '\u001B[39m'
const PROGRESS_BODY_COLOR = '\u001B[38;2;101;116;217m'
const PROGRESS_HIGHLIGHT_COLOR = '\u001B[38;2;168;178;245m'
const PROGRESS_HIGHLIGHT_WIDTH = 2

/**
 * Format worker progress without assuming a fixed terminal width.
 * The completed count remains the source of truth. Whole cells avoid the
 * visible gap that partial block glyphs leave before the unfilled section.
 */
export function formatCompileProgress(completed, total, options = {}) {
	const unicode = options.unicode ?? isUnicodeSupported()
	const color = options.color ?? shouldUseColor()
	const columns = normalizePositiveInteger(options.columns) || process.stdout.columns || DEFAULT_TERMINAL_COLUMNS
	const safeTotal = normalizePositiveInteger(total)
	const safeCompleted = Math.min(normalizePositiveInteger(completed), safeTotal)
	const ratio = safeTotal === 0 ? 0 : safeCompleted / safeTotal
	const percentage = Math.round(ratio * 100)
	const separator = unicode ? '·' : '|'
	const metadata = `${String(safeCompleted).padStart(String(safeTotal).length)}/${safeTotal} ${separator} ${String(percentage).padStart(3)}%`
	const availableWidth = columns - metadata.length - RENDERER_CHROME_WIDTH - PROGRESS_BRACKETS_WIDTH

	if (availableWidth < MIN_PROGRESS_WIDTH) {
		return metadata
	}

	const width = Math.min(availableWidth, MAX_PROGRESS_WIDTH)
	const bar = unicode
		? createUnicodeBar(ratio, width, color)
		: createAsciiBar(ratio, width, color)

	return `[${bar}]  ${metadata}`
}

function createUnicodeBar(ratio, width, color) {
	const completeWidth = Math.round(ratio * width)
	const emptyWidth = width - completeWidth

	return `${colorizeCompleteSegment('█'.repeat(completeWidth), color)}${'░'.repeat(emptyWidth)}`
}

function createAsciiBar(ratio, width, color) {
	const completeWidth = Math.floor(ratio * width)
	const showHead = ratio > 0 && ratio < 1
	const bodyWidth = Math.max(0, completeWidth - (showHead ? 1 : 0))
	const emptyWidth = width - bodyWidth - (showHead ? 1 : 0)
	const completeSegment = `${'='.repeat(bodyWidth)}${showHead ? '>' : ''}`

	return `${colorizeCompleteSegment(completeSegment, color)}${'-'.repeat(emptyWidth)}`
}

function colorizeCompleteSegment(segment, color) {
	if (!color || segment.length === 0) {
		return segment
	}

	const highlightWidth = Math.min(PROGRESS_HIGHLIGHT_WIDTH, segment.length)
	const bodyWidth = segment.length - highlightWidth
	const body = bodyWidth > 0
		? `${PROGRESS_BODY_COLOR}${segment.slice(0, bodyWidth)}`
		: ''
	const highlight = `${PROGRESS_HIGHLIGHT_COLOR}${segment.slice(bodyWidth)}`

	return `${body}${highlight}${RESET_FOREGROUND}`
}

function shouldUseColor() {
	if (process.env.FORCE_COLOR === '0' || 'NO_COLOR' in process.env) {
		return false
	}
	if (process.env.FORCE_COLOR !== undefined) {
		return true
	}
	return Boolean(process.stdout.isTTY && process.env.TERM !== 'dumb')
}

function normalizePositiveInteger(value) {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}
