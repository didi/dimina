import { describe, expect, it } from 'vitest'
import { formatCompileProgress } from '../src/common/compile-progress.js'

describe('compile progress', () => {
	it('renders a continuous unicode bar with stable progress metadata', () => {
		const output = formatCompileProgress(3, 8, { columns: 80, unicode: true, color: false })
		const metadata = '3/8 ·  38%'
		const bar = output.slice(0, -metadata.length - 2)

		expect(Array.from(bar)).toHaveLength(30)
		expect(bar).toMatch(/^\[███████████░+\]$/)
		expect(output.endsWith(metadata)).toBe(true)
	})

	it('adapts the bar to narrow terminals', () => {
		const output = formatCompileProgress(5, 12, { columns: 40, unicode: true, color: false })
		const metadata = ' 5/12 ·  42%'
		const bar = output.slice(0, -metadata.length - 2)

		expect(Array.from(bar)).toHaveLength(14)
		expect(bar).toMatch(/^\[█████░+\]$/)
		expect(output.endsWith(metadata)).toBe(true)
	})

	it('falls back to metadata when a terminal is too narrow', () => {
		expect(formatCompileProgress(1, 10, { columns: 28, unicode: true, color: false }))
			.toBe(' 1/10 ·  10%')
	})

	it('supports ascii terminals and clamps invalid progress', () => {
		expect(formatCompileProgress(20, 10, { columns: 80, unicode: false, color: false }))
			.toBe('[============================]  10/10 | 100%')
		expect(formatCompileProgress(-1, Number.NaN, { columns: 20, unicode: false, color: false }))
			.toBe('0/0 |   0%')
	})

	it('uses a restrained blue body with a short directional highlight', () => {
		const output = formatCompileProgress(1, 2, { columns: 80, unicode: true, color: true })
		const plainOutput = [
			'\u001B[38;2;101;116;217m',
			'\u001B[38;2;168;178;245m',
			'\u001B[39m',
		].reduce((result, sequence) => result.replaceAll(sequence, ''), output)

		expect(output).toContain(`\u001B[38;2;101;116;217m${'█'.repeat(12)}`)
		expect(output).toContain(`\u001B[38;2;168;178;245m${'█'.repeat(2)}\u001B[39m`)
		expect(plainOutput).toBe('[██████████████░░░░░░░░░░░░░░]  1/2 ·  50%')
	})

	it('keeps metadata-only output free of color sequences', () => {
		expect(formatCompileProgress(1, 10, { columns: 28, unicode: true, color: true }))
			.toBe(' 1/10 ·  10%')
	})
})
