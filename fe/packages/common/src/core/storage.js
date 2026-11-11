export const STORAGE_LIMIT_KB = 10 * 1024
export const STORAGE_LIMIT = STORAGE_LIMIT_KB * 1024

// WAService 2.25.3 anyTypeToString: storage contains typed strings, not JSON
// representations of the host's database records. Sizes count UTF-16 code units.
export function createStorageEntry(key, value) {
	const dataType = Object.prototype.toString.call(value).slice(8, -1)
	let data
	if (dataType === 'Array' || dataType === 'Object') data = JSON.stringify(value)
	else if (['String', 'Number', 'Boolean'].includes(dataType)) data = value.toString()
	else if (dataType === 'Date') data = value.getTime().toString()
	else if (dataType === 'Undefined') data = 'undefined'
	else if (dataType === 'Null') data = 'null'
	else data = ''
	const record = { data, dataType }
	return { ...record, entrySize: storageEntrySize(key, record) }
}

export function storageEntrySize(key, record) {
	return JSON.stringify(key).length + 1 + JSON.stringify({ data: record.data, dataType: record.dataType }).length
}

export function decodeStorageEntry({ data, dataType }) {
	if (dataType === 'String') return data
	if (dataType === 'Array' || dataType === 'Object') return JSON.parse(data)
	if (dataType === 'Number') return Number.parseFloat(data)
	if (dataType === 'Boolean') return data === 'true'
	if (dataType === 'Date') return new Date(Number.parseInt(data, 10))
	if (dataType === 'Undefined') return undefined
	if (dataType === 'Null') return null
	return ''
}

export function decodeStorageResult(result) {
	if (result?.__diminaStorageResult !== 1) return result
	return result.record ? decodeStorageEntry(result.record) : result.value
}

export function storageSpaceSize(entrySizes) {
	return 2 + entrySizes.reduce((sum, size) => sum + size, 0) + Math.max(0, entrySizes.length - 1)
}

export function checkStorageQuota(entrySizes) {
	// The developer tool checks JSON.stringify({ 0: space }), including its wrapper.
	if (storageSpaceSize(entrySizes) + 6 > STORAGE_LIMIT) {
		throw new Error('exceed storage max size 10Mb')
	}
}
