// 组件层与渲染层之间靠 DOM 传递的约定名字。两侧各写一份字面量时，任何一侧改名都不会让
// 对方的测试变红——两边分开测都绿，只有真实链路上接不起来。

// 画布归属：组件层写入，渲染层按它把 canvas-id 解析到正确的宿主实例。
// 用 DOM property 而不是 data-*，因为事件序列化会把 target.dataset 整份交给小程序，
// 框架内部的组件实例 id 会变成开发者从未声明过的字段。
export const CANVAS_OWNER_PROP = '__ddCanvasOwner'

// owner 只说明候选所属作用域；动态 id 冲突时，同一 owner 下还可能同时存在 winner 和一块被
// 隐藏的 rejected canvas。解析必须同时要求这块画布持有有效 claim。
export const CANVAS_ACTIVE_PROP = '__ddCanvasActive'

// DOM property 不会触发 MutationObserver；claim 在同一 DOM 节点上接手时用冒泡事件通知等待中的
// resolver。事件名同样必须由两端共享，避免组件和 runtime 各写一份字符串后静默断链。
export const CANVAS_CONTRACT_CHANGE_EVENT = 'dd-canvas-contract-change'

// 组件根节点与真正参与 Canvas API 的 HTMLCanvasElement 之间的稳定协议。SelectorQuery 命中
// 的是带小程序 id/dataset/布局的组件根节点，但 node 字段必须登记内部画布。显式引用比查找子树
// 更可靠：slot 内容也可能有 canvas，组件内部结构变化也不应改变 API 目标。
export const CANVAS_NODE_PROP = '__ddCanvasNode'
