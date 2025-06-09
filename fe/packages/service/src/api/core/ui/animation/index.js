import { suffixPixel } from '@dimina/common'

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/animation/wx.createAnimation.html
 * @returns { Animation } 动画对象
 */
export function createAnimation(opts = {}) {
	return new Animation(opts)
}

class Animation {
	constructor({ duration = 400, timingFunction = 'linear', delay = 0, transformOrigin = '50% 50% 0' } = {}) {
		this.actions = []
		this.currentTransform = {}
		this.currentStepAnimates = []
		this.option = {
			transition: {
				duration,
				timingFunction,
				delay,
			},
			transformOrigin,
		}
	}

	/**
	 * 导出动画队列。export 方法每次调用后会清掉之前的动画操作。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/animation/Animation.export.html
	 */
	export() {
		const actions = this.actions
		this.actions = []
		return { actions }
	}

	/**
	 * 表示一组动画完成。可以在一组动画中调用任意多个动画方法，一组动画中的所有动画会同时开始，一组动画完成后才会进行下一组动画。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/animation/Animation.step.html
	 */
	step(option = {}) {
		for (const stepAnimate of this.currentStepAnimates) {
			if (stepAnimate.type === 'style') {
				this.currentTransform[`${stepAnimate.type}.${stepAnimate.args[0]}`] = stepAnimate
			}
			else {
				this.currentTransform[stepAnimate.type] = stepAnimate
			}
		}
		this.actions.push({
			animates: Object.keys(this.currentTransform).reduce((prev, current) => {
				return [].concat(...prev, [this.currentTransform[current]])
			}, []),
			option: {
				transformOrigin: option.transformOrigin !== undefined ? option.transformOrigin : this.option.transformOrigin,
				transition: {
					duration: option.duration !== undefined ? option.duration : this.option.transition.duration,
					timingFunction: option.timingFunction !== undefined ? option.timingFunction : this.option.transition.timingFunction,
					delay: option.delay !== undefined ? option.delay : this.option.transition.delay,
				},
			},
		})

		this.currentStepAnimates = []
		return this
	}

	backgroundColor(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['background-color', value],
		})
		return this
	}

	bottom(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['bottom', suffixPixel(value)],
		})
		return this
	}

	height(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['height', suffixPixel(value)],
		})
		return this
	}

	left(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['left', suffixPixel(value)],
		})
		return this
	}

	matrix(a = 1, b = 0, c = 0, d = 1, tx = 1, ty = 1) {
		this.currentStepAnimates.push({
			type: 'matrix',
			args: [a, b, c, d, tx, ty],
		})
		return this
	}

	matrix3d(
		a1 = 1,
		b1 = 0,
		c1 = 0,
		d1 = 0,
		a2 = 0,
		b2 = 1,
		c2 = 0,
		d2 = 0,
		a3 = 0,
		b3 = 0,
		c3 = 1,
		d3 = 0,
		a4 = 0,
		b4 = 0,
		c4 = 0,
		d4 = 1,
	) {
		this.currentStepAnimates.push({
			type: 'matrix3d',
			args: [
				a1,
				b1,
				c1,
				d1,
				a2,
				b2,
				c2,
				d2,
				a3,
				b3,
				c3,
				d3,
				a4,
				b4,
				c4,
				d4,
			],
		})
		return this
	}

	opacity(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['opacity', value],
		})
		return this
	}

	right(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['right', suffixPixel(value)],
		})
		return this
	}

	rotate(angle = 0) {
		this.currentStepAnimates.push({
			type: 'rotate',
			args: [angle],
		})
		return this
	}

	rotate3d(x = 0, y = 0, z = 0, angle = 0) {
		this.currentStepAnimates.push({
			type: 'rotate3d',
			args: [x, y, z, angle],
		})
		return this
	}

	rotateX(angle) {
		this.currentStepAnimates.push({
			type: 'rotateX',
			args: [angle],
		})
		return this
	}

	rotateY(angle) {
		this.currentStepAnimates.push({
			type: 'rotateY',
			args: [angle],
		})
		return this
	}

	rotateZ(angle) {
		this.currentStepAnimates.push({
			type: 'rotateZ',
			args: [angle],
		})
		return this
	}

	scale(x = 1, y = 1) {
		this.currentStepAnimates.push({
			type: 'scale',
			args: [x, y],
		})
		return this
	}

	scale3d(sx = 1, sy = 1, sz = 1) {
		this.currentStepAnimates.push({
			type: 'scale3d',
			args: [sx, sy, sz],
		})
		return this
	}

	scaleX(scale = 1) {
		this.currentStepAnimates.push({
			type: 'scaleX',
			args: [scale],
		})
		return this
	}

	scaleY(scale = 1) {
		this.currentStepAnimates.push({
			type: 'scaleY',
			args: [scale],
		})
		return this
	}

	scaleZ(scale = 1) {
		this.currentStepAnimates.push({
			type: 'scaleZ',
			args: [scale],
		})
		return this
	}

	skew(ax = 0, ay = 0) {
		this.currentStepAnimates.push({
			type: 'skew',
			args: [ax, ay],
		})
		return this
	}

	skewX(angle = 0) {
		this.currentStepAnimates.push({
			type: 'skewX',
			args: [angle],
		})
		return this
	}

	skewY(angle = 0) {
		this.currentStepAnimates.push({
			type: 'skewY',
			args: [angle],
		})
		return this
	}

	top(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['top', suffixPixel(value)],
		})
		return this
	}

	translate(tx = 0, ty = 0) {
		this.currentStepAnimates.push({
			type: 'translate',
			args: [tx, ty],
		})
		return this
	}

	translate3d(tx = 0, ty = 0, tz = 0) {
		this.currentStepAnimates.push({
			type: 'translate3d',
			args: [tx, ty, tz],
		})
		return this
	}

	translateX(translation = 0) {
		this.currentStepAnimates.push({
			type: 'translateX',
			args: [translation],
		})
		return this
	}

	translateY(translation = 0) {
		this.currentStepAnimates.push({
			type: 'translateY',
			args: [translation],
		})
		return this
	}

	width(value) {
		this.currentStepAnimates.push({
			type: 'style',
			args: ['width', suffixPixel(value)],
		})
		return this
	}
}
