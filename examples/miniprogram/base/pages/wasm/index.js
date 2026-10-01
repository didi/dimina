const modulePath = '/pages/wasm/assets/demo.wasm'
const pageBytes = 65536
const maximumPages = 4 // Declared in assets/demo.wat.

function integer(value) {
  const number = Number(value)
  if (String(value).trim() === '' || !Number.isInteger(number) || number < -2147483648 || number > 2147483647) {
    throw new Error('请输入 -2147483648 到 2147483647 之间的整数')
  }
  return number
}

function errorText(error) {
  return error && (error.errMsg || error.message) || String(error)
}

Page({
  data: {
    supported: false,
    capability: '正在检测 Wasm 能力',
    loading: false,
    ready: false,
    source: '',
    exportsText: '',
    left: '21',
    right: '21',
    hostValue: '21',
    memoryValue: '100',
    additionResult: '未运行',
    hostResult: '未运行',
    memoryFromWasm: 0,
    memoryFromJS: 0,
    memoryPages: 0,
    memoryKiB: 0,
    canGrow: false,
    growthResult: '未扩容',
    resultTitle: '等待加载',
    resultDetail: '选择普通或 Brotli 文件加载同一个 Wasm 模块。',
    resultType: 'info'
  },

  onLoad() {
    this._loadId = 0
    this._instances = Object.create(null)
    const supported = typeof WXWebAssembly !== 'undefined' && typeof WXWebAssembly.instantiate === 'function'
    this.setData({
      supported,
      capability: supported ? '当前环境支持 WXWebAssembly' : '当前环境不支持 WXWebAssembly',
      resultTitle: supported ? '等待加载' : 'Wasm 不可用',
      resultDetail: supported ? this.data.resultDetail : '请在支持 WXWebAssembly 的容器中打开此页面。'
    })
  },

  onUnload() {
    this._loadId++
    this._instance = null
    this._instances = null
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field
    if (['left', 'right', 'hostValue', 'memoryValue'].includes(field)) {
      this.setData({ [field]: event.detail.value })
    }
  },

  showResult(title, detail, type = 'success') {
    this.setData({ resultTitle: title, resultDetail: detail, resultType: type })
  },

  async loadWasm(event) {
    if (!this.data.supported || this.data.loading) return
    const compressed = event.currentTarget.dataset.format === 'br'
    const source = modulePath + (compressed ? '.br' : '')
    const loadId = ++this._loadId
    this.setData({ loading: true, ready: false, source })
    this.showResult('正在加载', source, 'info')
    try {
      // Reuse each source's instance when switching formats or loading again.
      let loaded = this._instances[source]
      if (!loaded) {
        loaded = await WXWebAssembly.instantiate(source, {
          env: { double: value => value * 2 }
        })
      }
      if (loadId !== this._loadId) return
      this._instances[source] = loaded
      this._instance = loaded.instance
      const exports = this._instance.exports
      const memoryPages = exports.memory.buffer.byteLength / pageBytes
      this.setData({
        ready: true,
        exportsText: WXWebAssembly.Module.exports(loaded.module).map(item => `${item.name} (${item.kind})`).join('\n'),
        additionResult: '未运行',
        hostResult: '未运行',
        memoryFromWasm: exports.read(0),
        memoryFromJS: exports.read(4),
        memoryPages,
        memoryKiB: memoryPages * 64,
        canGrow: memoryPages < maximumPages,
        growthResult: '未扩容'
      })
      this.showResult('加载成功', compressed ? 'Brotli 文件已解压并实例化。' : '包内 Wasm 文件已实例化。')
    } catch (error) {
      if (loadId === this._loadId) {
        this._instance = null
        this.showResult('加载失败', errorText(error), 'error')
      }
    } finally {
      if (loadId === this._loadId) this.setData({ loading: false })
    }
  },

  getExports() {
    if (!this.data.ready || !this._instance) throw new Error('请先加载 Wasm 模块')
    return this._instance.exports
  },

  runAddition() {
    try {
      const exports = this.getExports()
      const left = integer(this.data.left)
      const right = integer(this.data.right)
      const result = exports.add(left, right)
      this.setData({ additionResult: `${left} + ${right} = ${result}` })
      this.showResult('Wasm 函数调用成功', this.data.additionResult)
    } catch (error) { this.showResult('计算失败', errorText(error), 'error') }
  },

  runHostCallback() {
    try {
      const value = integer(this.data.hostValue)
      const result = this.getExports().callHost(value)
      this.setData({ hostResult: `Wasm → JS double(${value}) → Wasm：${result}` })
      this.showResult('JS 回调成功', this.data.hostResult)
    } catch (error) { this.showResult('回调失败', errorText(error), 'error') }
  },

  runMemory() {
    try {
      const exports = this.getExports()
      const value = integer(this.data.memoryValue)
      const view = new DataView(exports.memory.buffer)
      exports.write(0, value)
      const memoryFromWasm = view.getInt32(0, true)
      view.setInt32(4, value + 1, true)
      const memoryFromJS = exports.read(4)
      this.setData({ memoryFromWasm, memoryFromJS })
      this.showResult('共享内存读写成功', `Wasm 写入 ${value}，JS 读到 ${memoryFromWasm}；JS 写入下一个整数，Wasm 读到 ${memoryFromJS}。`)
    } catch (error) { this.showResult('内存操作失败', errorText(error), 'error') }
  },

  growMemory() {
    try {
      const exports = this.getExports()
      const oldBuffer = exports.memory.buffer
      const beforeValue = exports.read(0)
      const previousPages = exports.memory.grow(1)
      // Growth detaches the previous buffer; always obtain a new view.
      const newBuffer = exports.memory.buffer
      const memoryPages = newBuffer.byteLength / pageBytes
      const preserved = new DataView(newBuffer).getInt32(0, true) === beforeValue
      if (oldBuffer.byteLength !== 0 || !preserved) throw new Error('扩容后缓冲区分离或数据保留不符合预期')
      const growthResult = `${previousPages} → ${memoryPages} 页；旧 buffer 已分离，已有数据保留。`
      this.setData({ memoryPages, memoryKiB: memoryPages * 64, canGrow: memoryPages < maximumPages, growthResult })
      this.showResult('内存扩容成功', growthResult)
    } catch (error) { this.showResult('扩容失败', errorText(error), 'error') }
  }
})
