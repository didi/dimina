const path = require('node:path')

function collectEntryAssets(manifest, entry, visited = new Set()) {
	if (visited.has(entry)) return new Set()
	visited.add(entry)
	const chunk = manifest[entry]
	if (!chunk) throw new Error(`Build manifest is missing ${entry}; rebuild the Web container`)
	const assets = new Set([chunk.file, ...(chunk.css || []), ...(chunk.assets || [])])
	for (const dependency of [...(chunk.imports || []), ...(chunk.dynamicImports || [])]) {
		for (const asset of collectEntryAssets(manifest, dependency, visited)) assets.add(asset)
	}
	return assets
}

// Exclude the workspace's Web dependency graph, including shared demo chunks.
// Dependencies of the native render entry and service.js must stay packaged.
function getWebOnlySdkAssets(manifest) {
	const generated = collectEntryAssets(manifest, 'src/generator.js')
	const native = collectEntryAssets(manifest, 'pageFrame.html')
	// This fixed file is the service runtime contract used by native loaders.
	native.add('assets/service.js')
	for (const asset of native) generated.delete(asset)
	return new Set([...generated].map(asset => path.posix.relative('assets', asset)))
}

module.exports = { getWebOnlySdkAssets }
