export function createProjectStore({ indexedDB = globalThis.indexedDB } = {}) {
	let opening
	const open = () => opening ||= new Promise((resolve, reject) => {
		const request = indexedDB.open('dimina-generated-projects', 1)
		request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' })
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
	const run = async (mode, action) => {
		const database = await open()
		return new Promise((resolve, reject) => {
			const transaction = database.transaction('projects', mode)
			const request = action(transaction.objectStore('projects'))
			transaction.oncomplete = () => resolve(request.result)
			transaction.onerror = () => reject(transaction.error)
			transaction.onabort = () => reject(transaction.error || new Error('保存已取消'))
		})
	}
	return {
		get: id => run('readonly', store => store.get(id)),
		list: async () => (await run('readonly', store => store.getAll())).sort((a, b) => b.updatedAt - a.updatedAt),
		put: project => run('readwrite', store => store.put(project)),
		delete: id => run('readwrite', store => store.delete(id)),
	}
}
