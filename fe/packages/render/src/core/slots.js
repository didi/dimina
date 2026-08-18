function appendSlotResult(target, result) {
	if (Array.isArray(result)) {
		target.push(...result)
	}
	else if (result !== null && result !== undefined) {
		target.push(result)
	}
}

function withDynamicSlotKey(slot) {
	if (!slot.key) {
		return slot.fn
	}
	return (...args) => {
		const result = slot.fn(...args)
		if (result) {
			result.key = slot.key
		}
		return result
	}
}

function mergeSlotFunctions(existing, incoming) {
	return (...args) => {
		const existingResult = existing(...args)
		const incomingResult = incoming(...args)
		const merged = []
		appendSlotResult(merged, existingResult)
		appendSlotResult(merged, incomingResult)
		const key = incomingResult?.key ?? existingResult?.key
		if (key !== undefined) {
			merged.key = key
		}
		return merged
	}
}

/**
 * Vue createSlots 对同名动态插槽采用覆盖语义；小程序需要按声明顺序合并内容。
 */
export function createMiniProgramSlots(slots, dynamicSlots) {
	const addSlot = (slot) => {
		if (!slot) return
		const slotFunction = withDynamicSlotKey(slot)
		const existing = slots[slot.name]
		slots[slot.name] = existing
			? mergeSlotFunctions(existing, slotFunction)
			: slotFunction
	}

	for (const slot of dynamicSlots || []) {
		if (Array.isArray(slot)) {
			slot.forEach(addSlot)
		}
		else {
			addSlot(slot)
		}
	}
	return slots
}
