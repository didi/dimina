import { isReferenceIdentifier, ScopeTracker, walk } from 'oxc-walker'

export const WXS_RUNTIME_MODULE = 'dimina:wxs-runtime'

// This factory is serialized into a shared script module. Keep it self contained:
// browser and Node compilation must emit exactly the same compatibility layer.
export function createWxsRuntime() {
	const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
	const tag = value => Object.prototype.toString.call(value).slice(8, -1)
	const methods = {
		Number: 'toString toLocaleString toFixed toExponential toPrecision valueOf',
		Boolean: 'toString valueOf',
		String: 'toString valueOf charAt charCodeAt concat indexOf lastIndexOf localeCompare match replace search slice split substring toLowerCase toLocaleLowerCase toUpperCase toLocaleUpperCase trim',
		Array: 'toString concat join pop push reverse shift slice sort splice unshift indexOf lastIndexOf every some forEach map filter reduce reduceRight',
		Object: 'toString',
		Arguments: 'toString',
		Date: 'toString toDateString toTimeString toLocaleString toLocaleDateString toLocaleTimeString valueOf getTime getFullYear getUTCFullYear getMonth getUTCMonth getDate getUTCDate getDay getUTCDay getHours getUTCHours getMinutes getUTCMinutes getSeconds getUTCSeconds getMilliseconds getUTCMilliseconds getTimezoneOffset setTime setMilliseconds setUTCMilliseconds setSeconds setUTCSeconds setMinutes setUTCMinutes setHours setUTCHours setDate setUTCDate setMonth setUTCMonth setFullYear setUTCFullYear toUTCString toISOString toJSON',
		RegExp: 'exec test toString source global ignoreCase multiline',
	}
	for (const type of Object.keys(methods)) {
		methods[type] = new Set(methods[type].split(' '))
	}
	const functionToString = () => '[function Function]'
	const fn = value => {
		Object.defineProperty(value, 'toString', { value: functionToString, configurable: true, writable: true })
		return value
	}
	const nativeFunctions = new WeakMap()
	const native = value => {
		if (typeof value !== 'function') return value
		if (!nativeFunctions.has(value)) {
			const wrapper = fn(function (...args) { return value.apply(this, args) })
			Object.defineProperty(wrapper, 'length', { value: value.length })
			nativeFunctions.set(value, wrapper)
		}
		return nativeFunctions.get(value)
	}
	const get = (value, property) => {
		if (value === null || value === undefined) {
			throw new TypeError('Cannot read properties of ' + value)
		}
		const key = String(property)
		const type = tag(value)
		if (type === 'Function') {
			if (key === 'constructor') return own(value, key) ? value[key] : 'Function'
			if (key === 'length') return value.length
			if (key === 'toString') return functionToString
			if (['name', 'prototype', 'arguments', 'caller'].includes(key)) return undefined
			return own(value, key) ? value[key] : undefined
		}
		if (own(value, key)) return value[key]
		if (key === 'constructor') return type === 'Arguments' ? 'Object' : type
		if (methods[type]?.has(key)) return native(key === 'toString' && !value[key] ? Object.prototype.toString : value[key])
		return undefined
	}
	const pick = (source, keys) => {
		const result = Object.create(null)
		for (const key of keys.split(' ')) result[key] = native(source[key])
		return result
	}
	const globals = Object.assign(Object.create(null), {
		undefined, NaN: Number.NaN, Infinity,
		Number: fn(function Number() {}),
		Date: fn(function Date() {}),
		Math: pick(Math, 'E LN10 LN2 LOG2E LOG10E PI SQRT1_2 SQRT2 abs acos asin atan atan2 ceil cos exp floor log max min pow random round sin sqrt tan'),
		JSON: { parse: fn(value => JSON.parse(value)), stringify: fn(value => JSON.stringify(value)) },
		getDate: fn((...args) => new Date(...args)),
		getRegExp: fn((...args) => new RegExp(...args)),
		parseInt: Number.parseInt, parseFloat: Number.parseFloat,
		// WXS numeric predicates coerce strings, unlike Number.isNaN/isFinite.
		// oxlint-disable-next-line unicorn/prefer-number-properties
		isNaN, isFinite,
		decodeURI, decodeURIComponent, encodeURI, encodeURIComponent,
		console: pick(console, 'log info warn error debug'),
	})
	for (const key of ['parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent']) {
		globals[key] = native(globals[key])
	}
	Object.assign(globals.Number, pick(Number, 'MAX_VALUE MIN_VALUE POSITIVE_INFINITY NEGATIVE_INFINITY'))
	Object.assign(globals.Date, pick(Date, 'now parse UTC'))
	const set = (value, key, assigned) => {
		if (key === '__proto__') Object.defineProperty(value, key, { value: assigned, enumerable: true, configurable: true, writable: true })
		else value[key] = assigned
		return assigned
	}
	const assign = (value, property, operator, right) => {
		const key = String(property)
		if (operator === '=') return set(value, key, right())
		const left = get(value, key)
		if (operator === '&&=') return left && set(value, key, right())
		if (operator === '||=') return left || set(value, key, right())
		if (operator === '??=') return left ?? set(value, key, right())
		const rhs = right()
		let result
		switch (operator) {
			case '+=': result = left + rhs; break
			case '-=': result = left - rhs; break
			case '*=': result = left * rhs; break
			case '/=': result = left / rhs; break
			case '%=': result = left % rhs; break
			case '**=': result = left ** rhs; break
			case '<<=': result = left << rhs; break
			case '>>=': result = left >> rhs; break
			case '>>>=': result = left >>> rhs; break
			case '&=': result = left & rhs; break
			case '^=': result = left ^ rhs; break
			case '|=': result = left | rhs; break
			default: throw new SyntaxError('Unsupported WXS assignment ' + operator)
		}
		return set(value, key, result)
	}
	const update = (value, property, operator, prefix) => {
		const key = String(property)
		const previous = +get(value, key)
		const result = previous + (operator === '++' ? 1 : -1)
		set(value, key, result)
		return prefix ? result : previous
	}
	const method = (value, key) => {
		const callable = get(value, key)
		return (...args) => callable.apply(value, args)
	}
	return { globals, get, fn, assign, update, method }
}

// WXS only decodes newline, carriage return and tab. Its quoted-character
// escapes are observable literal hex spellings, rather than JS escape values.
export function decodeWxsString(raw) {
	return raw.slice(1, -1).replace(/\\([\s\S])/g, (match, char) => {
		if (char === 'n') return '\n'
		if (char === 'r') return '\r'
		if (char === 't') return '\t'
		if (char === '\\') return '\\x5c'
		if (char === "'") return '\\x27'
		if (char === '"') return '\\x22'
		return match
	})
}

export function createWxsScopeTracker(ast) {
	const tracker = new ScopeTracker({ preserveExitedScopes: true })
	walk(ast, { scopeTracker: tracker })
	tracker.freeze()
	return tracker
}

export function transformWxs(source, ast) {
	const names = new Set()
	walk(ast, { enter(node) { if (node.type === 'Identifier') names.add(node.name) } })
	let runtime = '__diminaWxs'
	while (names.has(runtime)) runtime += '_'
	const rendered = new Map()
	const children = new Map()
	const tracker = createWxsScopeTracker(ast)
	const sourceOf = node => rendered.get(node) ?? source.slice(node.start, node.end)
	const keyOf = node => node.computed ? sourceOf(node.property) : JSON.stringify(node.property.name)
	let changed = false
	walk(ast, {
		scopeTracker: tracker,
		enter(node, parent) {
			if (parent) {
				if (!children.has(parent)) children.set(parent, [])
				children.get(parent).push(node)
			}
		},
		leave(node, parent) {
			let text = source.slice(node.start, node.end)
			for (const child of (children.get(node) || []).sort((a, b) => b.start - a.start)) {
				text = text.slice(0, child.start - node.start) + sourceOf(child) + text.slice(child.end - node.start)
			}
			if (node.type === 'Identifier' && isReferenceIdentifier(node, parent)
				&& !tracker.isDeclared(node.name) && !['module', 'exports', 'require'].includes(node.name)) {
				text = `${runtime}.globals[${JSON.stringify(node.name)}]`
			}
			else if (node.type === 'StringLiteral' || (node.type === 'Literal' && typeof node.value === 'string')) {
				text = JSON.stringify(decodeWxsString(source.slice(node.start, node.end)))
			}
			else if (node.type === 'ThisExpression') text = 'undefined'
			else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
				text = `${runtime}.assign(${sourceOf(node.left.object)},${keyOf(node.left)},${JSON.stringify(node.operator)},()=>(${sourceOf(node.right)}))`
			}
			else if (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression') {
				text = `${runtime}.update(${sourceOf(node.argument.object)},${keyOf(node.argument)},${JSON.stringify(node.operator)},${node.prefix})`
			}
			else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
				text = `${runtime}.method(${sourceOf(node.callee.object)},${keyOf(node.callee)})(${node.arguments.map(sourceOf).join(',')})`
			}
			else if (node.type === 'MemberExpression') {
				const writable = (parent?.type === 'AssignmentExpression' && parent.left === node)
					|| (parent?.type === 'UpdateExpression' && parent.argument === node)
					|| (parent?.type === 'UnaryExpression' && parent.operator === 'delete')
					|| (parent?.type === 'ForInStatement' && parent.left === node)
				if (!writable) text = `${runtime}.get(${sourceOf(node.object)},${keyOf(node)})`
			}
			else if (node.type === 'Property' && node.shorthand) {
				text = `${source.slice(node.key.start, node.key.end)}:${sourceOf(node.value)}`
			}
			else if (node.type === 'Property' && !node.computed && (node.key.name === '__proto__' || node.key.value === '__proto__')) {
				text = `["__proto__"]:${sourceOf(node.value)}`
			}
			else if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') text = `${runtime}.fn(${text})`
			else if (node.type === 'BlockStatement' || node.type === 'Program') {
				const declarations = (node.body || []).filter(item => item.type === 'FunctionDeclaration' && item.id)
				if (declarations.length) {
					const initializers = declarations.map(item => `${runtime}.fn(${item.id.name});`).join('')
					const offset = node.type === 'BlockStatement' ? 1 : 0
					text = text.slice(0, offset) + initializers + text.slice(offset)
				}
			}
			if (text !== source.slice(node.start, node.end)) changed = true
			rendered.set(node, text)
		},
	})
	return changed ? `;(function(${runtime}){\n${sourceOf(ast)}\n})(require(${JSON.stringify(WXS_RUNTIME_MODULE)}));` : source
}
