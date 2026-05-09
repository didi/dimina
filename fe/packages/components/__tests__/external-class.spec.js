import { describe, expect, it } from 'vitest'
import { replaceExternalClassTokens } from '../src/common/utils'

describe('replaceExternalClassTokens', () => {
	it('replaces external class placeholders without duplicating resolved classes', () => {
		const className = 't-image__img t-image--shape-square t-class-image dd-image'
		const replacement = 't-swiper__image-host t-swiper__image t-class-image'

		const result = replaceExternalClassTokens(className, 't-class-image', replacement)

		expect(result).toBe('t-image__img t-image--shape-square t-swiper__image-host t-swiper__image t-class-image dd-image')
	})

	it('is idempotent when external class parsing runs multiple times', () => {
		const initial = 't-image__img t-image--shape-square t-class-image dd-image'
		const replacement = 't-swiper__image-host t-swiper__image t-class-image'

		const firstPass = replaceExternalClassTokens(initial, 't-class-image', replacement)
		const secondPass = replaceExternalClassTokens(firstPass, 't-class-image', replacement)

		expect(secondPass).toBe(firstPass)
		expect(secondPass.match(/t-swiper__image-host/g)).toHaveLength(1)
		expect(secondPass.match(/t-swiper__image(?!-host)/g)).toHaveLength(1)
	})

	it('keeps unrelated classes untouched while deduplicating replacement tokens', () => {
		const className = 'foo t-class-image bar'
		const replacement = 'foo baz t-class-image baz'

		const result = replaceExternalClassTokens(className, 't-class-image', replacement)

		expect(result).toBe('foo baz t-class-image bar')
	})
})
