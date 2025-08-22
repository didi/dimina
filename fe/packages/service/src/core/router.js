// https://developers.weixin.qq.com/miniprogram/dev/framework/app-service/route.html
class Router {
	#stacks = []
	#initId = ''

	setInitId(id) {
		this.#initId = id
	}

	push(pageInfo, stackId) {
		this.stack(stackId).push(pageInfo)
	}

	pop() {
		// 从最上面的子数组中移除最后一个元素
		if (this.stack().length > 0) {
			this.stack().pop()
		}
	}

	getPageInfo() {
		// 获取最上面子数组的最后页面信息
		return this.stack().at(-1) || { id: this.#initId }
	}

	/**
	 * 推入一个新页面栈
	 */
	pushStack(stackId) {
		const newStack = {
			id: stackId,
			pages: [],
		}
		this.#stacks.push(newStack)
		return newStack
	}

	/**
	 * 当前新页面栈退出
	 */
	popStack(stackId) {
		if (stackId) {
			// 移除指定的栈
			const index = this.#stacks.findIndex(stack => stack.id === stackId)
			if (index !== -1) {
				this.#stacks.splice(index, 1)
			}
		}
		else if (this.#stacks.length > 0) {
			// 移除最上面的栈
			this.#stacks.pop()
		}
	}

	/**
	 * 获取当前页面栈
	 */
	stack(stackId) {
		if (stackId) {
			// 查找指定的栈
			let currentStack = this.#stacks.find(stack => stack.id === stackId)
			if (!currentStack) {
				// 如果不存在，创建新栈
				currentStack = this.pushStack(stackId)
			}
			return currentStack.pages
		}
		else {
			// 如果没有指定stackId，返回最上面的栈
			const currentStack = this.#stacks.at(-1)
			if (currentStack) {
				return currentStack.pages
			}
			else {
				// 如果不存在，创建新栈
				return this.pushStack(Date.now()).pages
			}
		}
	}
}

export default new Router()
