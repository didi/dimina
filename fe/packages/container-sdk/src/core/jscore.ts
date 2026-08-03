import type { Emitter } from 'mitt'
import type { MiniApp } from '../pages/miniApp/miniApp.js'
import type { BridgeMessage } from '../types.js'
import serviceURL from '@dimina/service?url'
import mitt from 'mitt'

/** worker.onmessage 收到的逻辑线程消息：至少带 method 字段用于事件分发。 */
interface WorkerEvent {
	method: string
	[key: string]: unknown
}

/** invoke/publish 复用同一个 mitt 实例，事件名固定为 'invoke' | 'publish'。 */
type JSCoreEvents = {
	invoke: BridgeMessage
	publish: BridgeMessage
}

export class JSCore {
	parent: MiniApp
	worker: Worker | null
	event: Emitter<JSCoreEvents>
	/** appShow/appHide 期望方向与已真正投递方向，见 #flushAppVisibility() 上的说明。 */
	private desiredAppVisible: boolean | null
	private sentAppVisible: boolean | null
	/** service 侧 App 实例是否已构造完成，见 notifyServiceReady() 上的说明。 */
	private serviceReady: boolean

	constructor(parent: MiniApp) {
		this.parent = parent
		this.worker = null
		this.event = mitt<JSCoreEvents>()
		this.desiredAppVisible = null
		this.sentAppVisible = null
		this.serviceReady = false
	}

	async init(): Promise<void> {
		// 使用 Web Worker 创建逻辑线程
		// 使用下面的形式会使 hash 失效
		// this.worker = new Worker(new URL('@dimina/service', import.meta.url))；
		const namespaces = this.parent.getApiNamespaces?.() || []
		// 已注册的 API 名字随 worker 启动配置传给 service 层，
		// 使它们在 wx（globalApi Proxy）上可被 Object.keys 枚举。
		const registeredApis = Object.keys(this.parent.apiRegistry ?? {})
		const workerName = JSON.stringify({ apiNamespaces: namespaces, registeredApis })
		this.worker = new Worker(serviceURL, { type: 'classic', name: workerName })

		// 监听逻辑线程的消息
		this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
			const msg = e.data
			this.event.emit(msg.method as keyof JSCoreEvents, msg as unknown as BridgeMessage)
		}
	}

	/**
	 * 在逻辑线程注册消息处理监听器 invoke
	 */
	invoke(handler: (msg: BridgeMessage) => void): void {
		this.event.on('invoke', handler)
	}

	/**
	 * 在逻辑线程注册消息中转监听器 publish
	 */
	publish(handler: (msg: BridgeMessage) => void): void {
		this.event.on('publish', handler)
	}

	/**
	 * App 级前后台信号：一个 MiniApp 的所有页面 Bridge 共享同一个 JSCore/Worker，
	 * appShow/appHide 因此是 app 粒度、不是页面粒度——不能像 pageShow/pageHide
	 * 那样分别记账在各个 Bridge 上，否则多页面/多 tab 各自一份状态会互相踩踏
	 * （如 tab A 已经发过 appHide，切到 tab B 后 B 自己那份"未发送过"的状态会
	 * 把这次真正需要的 appShow 又发一遍；反过来也可能把该发的一次误判成重复而
	 * 吞掉）。记账收在这个真正共享的 JSCore 上，同方向重复调用直接跳过，避免
	 * 小程序侧 App.onShow()/onHide() 生命周期被同一次事件触发两遍。
	 *
	 * 真正投递的时机不能只看 Worker 对象是否存在——service 侧的 runtime 要等
	 * 入口页 loadResource 真正跑完才会构造出 App 实例（此前 runtime.appShow()/
	 * appHide() 内部 `this.app?.xxx()` 会因为 app 尚不存在而静默丢弃），过早发送
	 * 会让 JSCore 误以为已经送达、事后不再补发，实际上小程序侧从未收到这次事件。
	 * 因此 appShow/appHide 只记录期望方向，真正投递延后到 notifyServiceReady()
	 * 判定 service 侧确已就绪之后才 flush，与 Bridge.desiredPageVisible/
	 * sentPageVisible/#flushPageVisibility() 是同一套模式，只是就绪判据换成了
	 * service 侧 App 是否已构造，而不是某个具体页面的双线程资源是否都已加载。
	 */
	appShow(): void {
		this.desiredAppVisible = true
		this.#flushAppVisibility()
	}

	appHide(): void {
		this.desiredAppVisible = false
		this.#flushAppVisibility()
	}

	#flushAppVisibility(): void {
		if (
			!this.serviceReady
			|| this.desiredAppVisible === null
			|| this.sentAppVisible === this.desiredAppVisible
		) {
			return
		}
		this.postMessage({
			type: this.desiredAppVisible ? 'appShow' : 'appHide',
			body: {},
		})
		this.sentAppVisible = this.desiredAppVisible
	}

	/**
	 * 由 Bridge 在收到任意一次 serviceResourceLoaded 时调用一次：service 侧
	 * runtime 处理完第一次 loadResource 即完成 App 实例构造，此后 app 级消息
	 * 才真正有意义。首次调用补发期间累积的 desiredAppVisible（如果有），之后
	 * 的重复调用是幂等空操作。
	 *
	 * App 实例构造这一刻本身就会触发一次隐式 onLaunch/onShow（对齐微信官方
	 * 语义：App() 构造即视为一次首次展示），因此这里的"已发送"基线必须置为
	 * true，不能当成从未发送过——否则 desired 恰好也是 true 的最常见冷启动
	 * 场景，会在这次隐式 onShow 之上又叠加发一次显式 appShow，小程序侧收到
	 * 两次 onShow。只有当期间已经产生了"实际应处于隐藏"的期望（例如
	 * Application 在 service 就绪之前就已经进入 sleep）时，才需要补发一次
	 * appHide，把这个隐式展示的状态真正掰回隐藏。
	 */
	notifyServiceReady(): void {
		if (this.serviceReady) {
			return
		}
		this.serviceReady = true
		this.sentAppVisible = true
		this.#flushAppVisibility()
	}

	/**
	 * 向逻辑线程发送消息的唯一出口。判空在此统一吸收
	 * 「destroy() 之后仍在途的异步续体继续往已 terminate 的 worker 发消息」这类调用。
	 */
	postMessage(msg: BridgeMessage): void {
		if (!this.worker) {
			// destroy() 之后迟到的调用是预期场景，不刷日志；只打 type，避免业务数据进日志。
			if (!this.parent._destroyed) {
				console.warn(`[container] postMessage(${msg.type}) dropped: worker not ready`)
			}
			return
		}
		this.worker.postMessage(msg)
	}

	/**
	 * 释放 Web Worker。并发场景下 destroy() 可能先于 init() 创建 worker，判空避免解引用 null。
	 */
	destroy(): void {
		this.worker?.terminate()
		this.worker = null
		this.desiredAppVisible = null
		this.sentAppVisible = null
		this.serviceReady = false
	}
}
