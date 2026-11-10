import path from 'path-browserify'

// A compiler job owns this filesystem inside its own Worker. No host files or
// previous job output are visible to source supplied by a model.
const files = new Map()
const directories = new Set(['/'])
const normalize = value => path.resolve('/', String(value))
function mkdirSync(directory) {
	const parts = normalize(directory).split('/')
	for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/') || '/')
}
function writeFileSync(filename, content) {
	filename = normalize(filename)
	mkdirSync(path.dirname(filename))
	files.set(filename, typeof content === 'string' ? content : new TextDecoder().decode(content))
}
function readFileSync(filename) {
	filename = normalize(filename)
	if (!files.has(filename)) throw new Error(`File not found: ${filename}`)
	return files.get(filename)
}
function statSync(filename) {
	filename = normalize(filename)
	if (!files.has(filename) && !directories.has(filename)) throw new Error(`File not found: ${filename}`)
	return { isFile: () => files.has(filename), isDirectory: () => directories.has(filename) }
}
function readdirSync(directory, options = {}) {
	directory = normalize(directory)
	const prefix = directory === '/' ? '/' : `${directory}/`
	const names = new Set([...directories, ...files.keys()]
		.filter(name => name.startsWith(prefix) && name !== directory)
		.map(name => name.slice(prefix.length).split('/')[0]))
	return [...names].map(name => options.withFileTypes ? { name, ...statSync(`${prefix}${name}`) } : name)
}
export function resetFiles(input) {
	files.clear()
	directories.clear()
	directories.add('/')
	for (const [name, content] of Object.entries(input)) writeFileSync(`/project/${name}`, content)
}
export function outputFiles() {
	return Object.fromEntries([...files].filter(([name]) => name.startsWith('/output/')).map(([name, content]) => [name.slice(8), content]))
}
export default {
	mkdirSync, writeFileSync, readFileSync, statSync, readdirSync,
	existsSync: filename => files.has(normalize(filename)) || directories.has(normalize(filename)),
	copyFileSync: (source, target) => writeFileSync(target, readFileSync(source)),
}
