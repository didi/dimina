import fs from 'node:fs'
import path from 'node:path'

export function isBinaryRuntimeAsset(filename) {
	return /\.(?:wasm(?:\.br)?|pag)$/i.test(filename)
}

// Runtime loaders can construct paths dynamically, so preserve package-relative names.
export function copyBinaryRuntimeAssets(workPath, targetPath, subPackages = [], dependencyGraph, { ignoredPaths = [], owner = 'app' } = {}) {
	const sourceRoot = path.resolve(workPath)
	const targetRoot = path.resolve(targetPath)
	const ignoredRoots = new Set([targetRoot, ...ignoredPaths.map(directory => path.resolve(directory))])
	const roots = subPackages.map(pkg => pkg.root.replace(/\/+$/, ''))
	function visit(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const source = path.join(directory, entry.name)
			if (ignoredRoots.has(source)) continue
			if (entry.isDirectory()) {
				if (!entry.name.startsWith('.') && !['node_modules', 'miniprogram_npm'].includes(entry.name)) visit(source)
			} else if (entry.isFile() && isBinaryRuntimeAsset(entry.name)) {
				const relative = path.relative(sourceRoot, source).split(path.sep).join('/')
				const subpackage = roots.some(root => relative.startsWith(`${root}/`))
				const target = path.join(targetRoot, subpackage ? '' : 'main', relative)
				fs.mkdirSync(path.dirname(target), { recursive: true })
				fs.copyFileSync(source, target)
				dependencyGraph?.addFile(owner, source, 'config')
			}
		}
	}
	visit(sourceRoot)
}
