// dimina 原生 WebSocket 端到端契约用例页。
//
// 用法：先在独立测试仓库中配置 TLS_KEY/TLS_CERT 并启动 `socket-echo-server.mjs`，
// 再在设备/模拟器上打开本页，按需修改 wsUrl（Android 模拟器默认 10.0.2.2，iOS/HarmonyOS 模拟器一般用
// 本机局域网 IP 或 localhost），点击「运行全部用例」。带 `?autorun=1` 打开则自动开跑。
//
// 官方明确的 API 面按公开契约断言；多连接路由、监听覆盖和错误文案属于 Dimina 行为断言。
// 两个源都没覆盖的项
// （data 大小上限、message 的 data 取 string 还是 ArrayBuffer、reason 超 123 字节的后果、
// tcpNoDelay / perMessageDeflate / forceCellularNetwork 的传输层行为、子协议协商结果如何回读）
// 不在这里断言。
//
// 回显服务端除回显外还有两个观测端点，用来做服务端侧交叉验证，不只信客户端回调：
//   GET /__stats  → { openCount, closeCount, live, handshakes: [{ at, url, headers }] }
//   GET /__reset  → 清零

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitOpen(task, ms = 8000) {
  return withTimeout(new Promise((resolve, reject) => {
    task.onOpen(res => resolve(res))
    task.onError(res => reject(new Error(res && res.errMsg ? res.errMsg : 'connect error')))
  }), ms, 'waitOpen')
}

function waitMessage(task, ms = 8000) {
  return withTimeout(new Promise((resolve) => {
    task.onMessage(res => resolve(res))
  }), ms, 'waitMessage')
}

function waitClose(task, ms = 8000) {
  return withTimeout(new Promise((resolve) => {
    task.onClose(res => resolve(res))
  }), ms, 'waitClose')
}

function waitError(task, ms = 8000) {
  return withTimeout(new Promise((resolve) => {
    task.onError(res => resolve(res))
  }), ms, 'waitError')
}

// 吃掉同步 throw 和异步 reject 两种失败：无存活连接时全局接口会以 fail 拒绝，
// 无参调用还会返回一个 rejected Promise，不接住就变成未处理的 rejection。
function quiet(fn) {
  return Promise.resolve().then(fn).catch(() => {})
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

function assertErrMsg(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} errMsg must be exactly "${expected}", got "${actual}"`)
  }
}

// 字段全集比较：多一个键就算多实现（isBuffer / socketId / errCode / wasClean 都不得泄漏）。
function assertKeys(value, expected, label) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} must be an object, got ${typeof value}`)
  }
  const actual = Object.keys(value).slice().sort().join('|')
  const want = expected.slice().sort().join('|')
  if (actual !== want) {
    throw new Error(`${label} field set must be exactly [${want}], got [${actual}]`)
  }
}

// 校验一次调用的回调序列：期望的那个恰好来一次，complete 收尾也恰好一次，
// 相对的那个绝不能出现。只用布尔标志的话，同时触发 success 和 fail、
// 触发两次、或者 complete 跑在前面，都会被漏掉。
function assertCallbackSeq(seq, expected) {
  const other = expected === 'success' ? 'fail' : 'success'
  let expectedHits = 0
  let otherHits = 0
  let completeHits = 0
  for (const item of seq) {
    if (item === 'complete') {
      completeHits++
    }
    else if (item.indexOf(expected) === 0) {
      expectedHits++
    }
    else if (item.indexOf(other) === 0) {
      otherHits++
    }
  }
  const dump = JSON.stringify(seq)
  if (otherHits !== 0) {
    throw new Error(`${other} must not fire, got: ${dump}`)
  }
  if (expectedHits !== 1) {
    throw new Error(`${expected} must fire exactly once, got: ${dump}`)
  }
  if (completeHits !== 1) {
    throw new Error(`complete must fire exactly once, got: ${dump}`)
  }
  if (seq[seq.length - 1] !== 'complete') {
    throw new Error(`complete must come last, got: ${dump}`)
  }
}

// 跑一次带 success / fail / complete 的调用，回一份结算记录。
// complete 一定会来，所以超时即判失败，而不是当成「没结算也行」。
// complete 收到的载荷也记下来，要求它与同一次调用的 success / fail 载荷相同。
function settle(invoke, ms = 8000, label = 'settle') {
  const out = {
    seq: [],
    successCalled: false,
    failCalled: false,
    successRes: null,
    failRes: null,
    completeRes: null,
  }
  const done = new Promise((resolve) => {
    invoke({
      success: (res) => { out.seq.push('success'); out.successCalled = true; out.successRes = res },
      fail: (res) => { out.seq.push(`fail:${(res && res.errMsg) || ''}`); out.failCalled = true; out.failRes = res },
      complete: (res) => { out.seq.push('complete'); out.completeRes = res; resolve(out) },
    })
  })
  return withTimeout(done, ms, label).catch((e) => {
    throw new Error(`${e.message}; callbacks so far: ${JSON.stringify(out.seq)}`)
  })
}

// 键序无关的结构化比较，用来判定两个回调收到的是不是同一份结果。
function stableJson(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

// complete 必须收到与同一次调用的 success / fail 完全相同的 res。
// 三端曾分别给 undefined / {}，`complete: res => res.errMsg` 在其中一端直接 TypeError。
function assertCompleteMatchesSettler(out, label) {
  const settlerRes = out.successCalled ? out.successRes : out.failRes
  const settled = stableJson(settlerRes)
  const completed = stableJson(out.completeRes)
  if (completed !== settled) {
    throw new Error(`${label}: complete must receive the same res as success/fail; success/fail got ${settled}, complete got ${completed}`)
  }
  if (!out.completeRes || typeof out.completeRes !== 'object') {
    throw new Error(`${label}: complete must receive a result object, got ${completed}`)
  }
  if (typeof out.completeRes.errMsg !== 'string') {
    throw new Error(`${label}: complete res must carry errMsg so that "res => res.errMsg" cannot throw, got ${completed}`)
  }
}

function expectFail(out, expectedMsg, label) {
  assertCallbackSeq(out.seq, 'fail')
  if (!out.failRes) {
    throw new Error(`${label} did not deliver a fail result object`)
  }
  assertErrMsg(out.failRes.errMsg, expectedMsg, label)
  return out.failRes
}

function expectSuccess(out) {
  assertCallbackSeq(out.seq, 'success')
  return out.successRes
}

// errMsg 只能由容器自己的固定英文串构成，不得混入 OS / SDK 的本地化描述。
// 端到端只跑得了一种设备语言，所以这里守的是可观测的那一半：出现非 ASCII 字符即判失败。
// 完整的 locale 不变性（同一底层错误换两种本地化描述得到同一个 errMsg）由三端各自的单测覆盖。
function assertAsciiErrMsg(errMsg, label) {
  if (typeof errMsg !== 'string' || errMsg.length === 0) {
    throw new Error(`${label} errMsg must be a non-empty string, got ${JSON.stringify(errMsg)}`)
  }
  if (!/^[\x20-\x7E]+$/.test(errMsg)) {
    throw new Error(`${label} errMsg must be a container-owned ASCII string, not OS-localized text, got "${errMsg}"`)
  }
}

function describeCloseCode(code) {
  if (code === null) return 'null'
  if (typeof code === 'string') return `"${code}"`
  if (typeof code === 'number' && isNaN(code)) return 'NaN'
  return String(code)
}

// 容器计时器到期与传输层上报的超时统一到同一个串，调用方判「是不是超时」只需一个分支。
const TIMEOUT_ERR_MSG = 'connectSocket:fail timeout'

const PROFILE_FIELDS = [
  'fetchStart',
  'domainLookUpStart',
  'domainLookUpEnd',
  'connectStart',
  'connectEnd',
  'rtt',
  'handshakeCost',
  'cost',
]

// 只要求 8 个字段齐全且是数字，不要求精度或真实性。
function assertProfile(profile) {
  assertKeys(profile, PROFILE_FIELDS, 'open profile')
  for (const field of PROFILE_FIELDS) {
    const value = profile[field]
    if (typeof value !== 'number' || !isFinite(value)) {
      throw new Error(`open profile.${field} must be a finite number, got ${JSON.stringify(value)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 连接追踪与清场
// ---------------------------------------------------------------------------

// 本页创建过的所有 SocketTask。名额只有 5 个，用例失败时往往还留着没关的连接，
// 不确认它们真的让出了名额就开下一条，后面会连锁误报。
const trackedTasks = []

// 所有用例都用它建连接，好让清场能逐个确认状态。
function connect(opts = {}) {
  const entry = { task: null, opened: false, terminal: false }
  const { fail, ...rest } = opts
  const task = wx.connectSocket({
    ...rest,
    // 连接被直接拒绝（超并发上限）时不会再有 open / error / close 事件，名额也从没占上，
    // 直接记成终态，否则清场会一直等到超时。
    fail: (res) => {
      entry.terminal = true
      if (typeof fail === 'function') {
        fail(res)
      }
    },
  })
  entry.task = task
  trackedTasks.push(entry)
  if (task && typeof task.onOpen === 'function') {
    task.onOpen(() => { entry.opened = true })
    task.onClose(() => { entry.terminal = true })
    task.onError(() => { entry.terminal = true })
  }
  return task
}

const noop = () => {}

// 全局监听是单槽的，没有 off，只能用空实现覆盖掉上一条用例留下的回调。
function neutralizeGlobalHandlers() {
  const names = ['onSocketOpen', 'onSocketMessage', 'onSocketError', 'onSocketClose']
  for (const name of names) {
    if (typeof wx[name] === 'function') {
      try {
        wx[name](noop)
      }
      catch (e) {
        // 覆盖失败不影响清场：各用例的回调都写进自己闭包里的数组，串不到别的用例。
      }
    }
  }
}

// 所有未终态连接都占用并发名额，清场必须等每条任务收到 close/error 或 connect fail。
function stillHoldingResources() {
  return trackedTasks.filter(entry => entry.task && !entry.terminal)
}

async function resetOwnerState() {
  neutralizeGlobalHandlers()
  // 官方全局 close 只处理已打开的全局目标；清场主要依靠逐个 SocketTask.close。
  await quiet(() => wx.closeSocket({ code: 1000, reason: 'reset', complete: noop }))
  for (const entry of trackedTasks) {
    const task = entry.task
    if (!entry.terminal && task && typeof task.close === 'function') {
      try {
        task.close({ complete: noop })
      }
      catch (e) {
        // 忽略：下面的等待循环会决定清场到底成没成。
      }
    }
  }
  // 关闭被受理不等于名额已经归还，所以逐个盯状态，而不是拍一个固定延时。
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && stillHoldingResources().length > 0) {
    // eslint-disable-next-line no-await-in-loop
    await delay(100)
  }
  const pending = stillHoldingResources()
  trackedTasks.length = 0
  // 超时还没清干净就必须报出来。静默继续往下跑的话，名额还占着，后面每条都会误报。
  if (pending.length > 0) {
    throw new Error(`socket cleanup timed out, ${pending.length} socket(s) still hold a connection slot`)
  }
  // 原生把条目移出 owner 与 JS 收到事件是两条消息，留一点余量。
  await delay(200)
}

// ---------------------------------------------------------------------------
// 服务端侧观测
// ---------------------------------------------------------------------------

function httpBase(wsUrl) {
  const base = wsUrl.split('?')[0].replace(/\/+$/, '')
  if (/^wss:\/\//i.test(base)) {
    return base.replace(/^wss:\/\//i, 'https://')
  }
  return base.replace(/^ws:\/\//i, 'http://')
}

function requestJson(url) {
  return withTimeout(new Promise((resolve, reject) => {
    wx.request({
      url,
      success: (res) => {
        const body = res && res.data
        if (typeof body === 'string') {
          try {
            resolve(JSON.parse(body))
          }
          catch (e) {
            reject(new Error(`${url} returned non-JSON body: ${body}`))
          }
          return
        }
        if (body && typeof body === 'object') {
          resolve(body)
          return
        }
        reject(new Error(`${url} returned an empty body`))
      },
      fail: (res) => reject(new Error(`${url} request failed: ${(res && res.errMsg) || 'unknown'}`)),
    })
  }), 8000, `request ${url}`)
}

function findHandshake(stats, tag) {
  const matches = (stats.handshakes || []).filter(item => String(item.url || '').indexOf(tag) !== -1)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one handshake carrying "${tag}", got ${matches.length}`)
  }
  return matches[0]
}

Page({
  data: {
    wsUrl: 'wss://10.0.2.2:8955',
    e2ePlatform: '',
    running: false,
    results: [],
    summaryText: '尚未运行',
    summaryClass: 'idle',
  },

  onLoad(options) {
    if (options && options.wsUrl) {
      this.setData({ wsUrl: decodeURIComponent(options.wsUrl) })
    }
    if (options && options.e2ePlatform) {
      this.setData({ e2ePlatform: String(options.e2ePlatform).toLowerCase() })
    }
    // 带上 autorun=1 打开本页就自动开跑，不用点按钮。模拟器上没法可靠地模拟点击时
    // （比如 iOS 模拟器受 macOS 权限限制），靠它把这套用例跑完。
    if (options && options.autorun) {
      this.runTests()
    }
  },

  onUrlInput(e) {
    this.setData({ wsUrl: e.detail.value })
  },

  platformKind() {
    if (this.data.e2ePlatform) return this.data.e2ePlatform
    try {
      const info = wx.getSystemInfoSync()
      const value = String((info && (info.platform || info.system)) || '').toLowerCase()
      if (value.indexOf('android') !== -1) return 'android'
      if (value.indexOf('ios') !== -1 || value.indexOf('iphone') !== -1) return 'ios'
      if (value.indexOf('harmony') !== -1 || value.indexOf('ohos') !== -1) return 'harmony'
      if (value.indexOf('web') !== -1) return 'web'
    }
    catch (e) {}
    return ''
  },

  pushResult(name, ok, detail) {
    const results = this.data.results.concat([{ name, ok, detail: detail || '' }])
    this.setData({ results })
    console.log(`[socket-test] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
  },

  async runTests() {
    this.setData({ running: true, results: [], summaryText: '运行中...', summaryClass: 'idle' })
    trackedTasks.length = 0
    const url = this.data.wsUrl
    const cases = [
      // ---- SocketTask 公开形状 ----
      ['SocketTask exposes exactly the 6 documented methods', () => this.caseTaskShape(url)],
      ['wx exposes no SocketTask / readyState / offSocket*', () => this.caseWxSurface()],

      // ---- 事件 payload 字段全集 ----
      ['task open payload contains header; profile is validated when the platform provides it', () => this.caseOpenPayload(url)],
      ['task message payload is exactly {data} and echoes back byte-identical text', () => this.caseTextEcho(url)],
      ['task close payload is exactly {code, reason}, no wasClean', () => this.caseClosePayload(url)],
      ['task error payload is exactly {errMsg}, no errCode', () => this.caseErrorPayload()],
      ['global open payload is exactly {header}, no profile', () => this.caseGlobalOpenPayload(url)],

      // ---- connectSocket 参数校验与返回值 ----
      ['connectSocket without url: fail result contains only errMsg and returns undefined', () => this.caseConnectMissingUrl()],
      ['connectSocket with numeric url: fail result contains only errMsg and returns undefined', () => this.caseConnectNumericUrl()],
      ['connectSocket with empty url: exact invalid url "" and no errno', () => this.caseConnectEmptyUrl()],
      ['connectSocket with http scheme: exact invalid url "<url>" and no errno', () => this.caseConnectBadScheme()],
      ['connectSocket with a non-object argument: returns undefined, no throw, no dial', () => this.caseConnectNonObject(url)],
      ['wss:// is required and WSS:// remains case-insensitive', () => this.caseUppercaseScheme(url)],

      // ---- 并发上限 ----
      ['the sixth CONNECTING connection is rejected by the strict five-connection limit', () => this.caseConnectingConsumesBudget()],
      ['sixth OPEN connection is rejected with the exact double-fail errMsg', () => this.caseMaxConcurrency(url)],
      ['a slot is released only after the terminal event, then immediately reusable', () => this.caseSlotReuse(url)],

      // ---- send ----
      ['send before OPEN fails as not connected', () => this.caseSendBeforeOpen(url)],
      ['send after close fails as not connected', () => this.caseSendAfterClose(url)],
      ['ArrayBuffer send round-trips with identical bytes', () => this.caseArrayBufferEcho(url)],
      ['TypedArray data is not auto-converted, is rejected, and the connection survives', () => this.caseTypedArrayRejected(url)],
      ['numeric data is rejected and the connection survives', () => this.caseInvalidSend(url)],

      // ---- close（native RFC6455 例外）----
      ['close code 1000 echoes back with the reason intact', () => this.caseCloseAccepted(url, 1000)],
      ['close code 3000 echoes back with the reason intact', () => this.caseCloseAccepted(url, 3000)],
      ['close code 4999 echoes back with the reason intact', () => this.caseCloseAccepted(url, 4999)],
      ['close code "1000" (string) falls back to 1000', () => this.caseCloseCodeFallback(url, '1000')],
      ['close code null falls back to 1000', () => this.caseCloseCodeFallback(url, null)],
      ['close code NaN falls back to 1000 in the script layer', () => this.caseCloseCodeFallback(url, Number.NaN)],
      ['close code Infinity falls back to 1000 in the script layer', () => this.caseCloseCodeFallback(url, Number.POSITIVE_INFINITY)],
      ['close code -Infinity falls back to 1000 in the script layer', () => this.caseCloseCodeFallback(url, Number.NEGATIVE_INFINITY)],
      ['close code 5000 is rejected by native, connection survives', () => this.caseCloseRejected(url, 5000)],
      ['SocketTask.close while connecting produces exactly one terminal event', () => this.caseCloseWhileConnecting()],

      // ---- 监听器语义 ----
      ['SocketTask.on* keeps every distinct listener and dedupes the same function', () => this.caseMultipleListeners(url)],
      ['no event replay for listeners attached after the terminal event', () => this.caseNoEventReplay(url)],
      ['error still reaches a listener attached right after connect', () => this.caseRefusedConnection()],

      // ---- 全局接口 ----
      ['global handlers are single-slot: the last registration wins', () => this.caseGlobalHandlerOverwrite(url)],
      ['global handlers only receive the current connection events', () => this.caseGlobalHandlerScope(url)],
      ['wx.onSocketOpen(non-function) is not registered and keeps the previous handler', () => this.caseGlobalHandlerBadArg(url)],
      ['global binding stays on the earliest task and rebinds only on the next connectSocket', () => this.caseGlobalBinding(url)],
      ['a CONNECTING task keeps the global binding', () => this.caseConnectingHoldsBinding(url)],
      ['wx.sendSocketMessage with no current connection fails with the exact errMsg', () => this.caseGlobalSendNotConnected()],
      ['wx.closeSocket closes only the opened global target', () => this.caseCloseSocketOnlyTarget(url)],
      ['wx.closeSocket does not close a CONNECTING target or other tasks', () => this.caseCloseSocketRejectsConnecting(url)],
      ['wx.closeSocket with a terminal target fails and leaves other tasks untouched', () => this.caseCloseSocketFailLeavesOthers(url)],
      ['wx.closeSocket with no connection at all fails with the exact errMsg', () => this.caseCloseSocketNotConnected()],

      // ---- 返回值形态 ----
      ['return shapes: SocketTask vs void vs Promise', () => this.caseReturnShapes(url)],

      // ---- 回调结算 ----
      ['connectSocket: success then complete, each once', () => this.caseConnectCallbacks(url)],
      ['connectSocket: fail then complete, each once', () => this.caseConnectFailCallbacks(url)],
      ['send: success then complete, each once', () => this.caseSendCallbacks(url)],
      ['close: success then complete, each once', () => this.caseCloseCallbacks(url)],
      ['complete receives the same res as success on all four success paths', () => this.caseCompleteMatchesSuccessRes(url)],
      ['complete receives the same res as fail on all four failure paths', () => this.caseCompleteMatchesFailRes(url)],

      // ---- 握手交叉验证 ----
      ['handshake reflects platform header capabilities and carries requested protocols', () => this.caseHandshakeHeaders(url)],
      ['supported custom header values are normalized before the handshake', () => this.caseHeaderNormalization(url)],
      ['case-variant request headers follow documented platform behavior', () => this.caseHeaderCaseNotFolded(url)],
      ['a non-ASCII header value is rejected before dialing', () => this.caseNonAsciiHeaderRejected(url)],
      ['duplicate response headers follow documented platform behavior', () => this.caseDuplicateResponseHeader(url)],

      // ---- 路由与时序 ----
      ['two tasks stay isolated', () => this.caseTwoTaskIsolation(url)],
      ['requested connect timeout follows documented platform capability', () => this.caseLongConnectTimeout()],
      ['a short connect timeout follows documented platform capability', () => this.caseShortConnectTimeout()],
    ]

    let passCount = 0
    let aborted = false
    try {
      for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
        const [name, fn] = cases[caseIndex]
        try {
          // eslint-disable-next-line no-await-in-loop
          const detail = await fn()
          this.pushResult(name, true, detail)
          passCount++
        }
        catch (e) {
          this.pushResult(name, false, e.message || String(e))
        }
        // 每条非末尾用例跑完都清场，不只在失败之后。全局绑定和单槽监听是跨用例存活的，
        // 名额也只有 5 个；不清干净的话报告会变成一串多米诺而不是各自独立的结论。
        // 末尾用例已经确认连接进入终态，不再为一个不存在的后续用例执行桥清场。
        if (caseIndex === cases.length - 1) continue
        try {
          // eslint-disable-next-line no-await-in-loop
          await resetOwnerState()
        }
        catch (cleanupError) {
          // 清场都没清干净，后面的结果没有参考价值，直接停在这里。
          this.pushResult('cleanup after ' + name, false, cleanupError.message || String(cleanupError))
          aborted = true
          break
        }
      }
    }
    finally {
      const total = cases.length
      const allPass = !aborted && passCount === total
      let summaryText
      if (aborted) {
        summaryText = `清场失败，已中止；已跑 ${passCount} 条通过`
      }
      else {
        summaryText = allPass ? `全部通过 ${passCount}/${total}` : `${passCount}/${total} 通过，存在失败用例`
      }
      this.setData({
        running: false,
        summaryText,
        summaryClass: allPass ? 'pass' : 'fail',
      })
    }
  },

  // -------------------------------------------------------------------------
  // SocketTask 公开形状
  // -------------------------------------------------------------------------

  async caseTaskShape(url) {
    const task = connect({ url: `${url}?tag=shape` })
    if (!task || typeof task !== 'object') {
      throw new Error(`connectSocket must return a SocketTask, got ${typeof task}`)
    }
    for (const name of ['send', 'close', 'onOpen', 'onMessage', 'onError', 'onClose']) {
      if (typeof task[name] !== 'function') {
        throw new Error(`SocketTask.${name} must be a function, got ${typeof task[name]}`)
      }
    }
    for (const name of ['readyState', 'CONNECTING', 'OPEN', 'CLOSING', 'CLOSED', 'offOpen', 'offMessage', 'offError', 'offClose']) {
      if (name in task) {
        throw new Error(`SocketTask must not expose ${name}`)
      }
    }
    if ('socketId' in task) {
      throw new Error('SocketTask must not expose socketId; the bridge identifier stays internal')
    }
    if (Object.keys(task).length !== 0 || Object.getOwnPropertyNames(task).length !== 0) {
      throw new Error(`SocketTask must not expose own public properties, got ${Object.getOwnPropertyNames(task).join(',')}`)
    }
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'exactly 6 documented methods, no state constants/off*/socketId'
  },

  // 这些名字规范源与行为源双双为空，Proxy 也不得把它们伪装成存在。
  async caseWxSurface() {
    const forbidden = [
      'SocketTask',
      'readyState',
      'offSocketOpen',
      'offSocketMessage',
      'offSocketError',
      'offSocketClose',
    ]
    for (const name of forbidden) {
      if (typeof wx[name] !== 'undefined') {
        throw new Error(`wx.${name} must not exist, got ${typeof wx[name]}`)
      }
      if (name in wx) {
        throw new Error(`wx.${name} must not be reported as present by the "in" operator`)
      }
    }
    for (const name of ['connectSocket', 'sendSocketMessage', 'closeSocket', 'onSocketOpen', 'onSocketMessage', 'onSocketError', 'onSocketClose']) {
      if (typeof wx[name] !== 'function') {
        throw new Error(`wx.${name} must be a function, got ${typeof wx[name]}`)
      }
    }
    return `${forbidden.length} forbidden names absent, 7 socket entry points present`
  },

  // -------------------------------------------------------------------------
  // 事件 payload 字段全集
  // -------------------------------------------------------------------------

  // HarmonyOS 暂时无法取得真实 profile 分段指标，因此不允许用回填值冒充；其他平台
  // 提供 profile 时仍校验官方 8 个字段。
  async caseOpenPayload(url) {
    const task = connect({ url: `${url}?tag=open-payload` })
    const openRes = await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    const expectedKeys = openRes.profile === undefined ? ['header'] : ['header', 'profile']
    assertKeys(openRes, expectedKeys, 'task open')
    if (!openRes.header || typeof openRes.header !== 'object') {
      throw new Error(`task open header must be an object, got ${typeof openRes.header}`)
    }
    if (openRes.profile !== undefined) {
      assertProfile(openRes.profile)
      return `header + 8 numeric profile fields (cost=${openRes.profile.cost})`
    }
    return 'header only; platform profile unavailable'
  },

  async caseTextEcho(url) {
    const task = connect({ url: `${url}?tag=echo-test` })
    await waitOpen(task)
    const msgPromise = waitMessage(task)
    const payload = `hello-${Date.now()}`
    task.send({ data: payload, complete: noop })
    const msg = await msgPromise
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    assertKeys(msg, ['data'], 'task message')
    // 要求完全相等：用 indexOf 的话，回显被加了前后缀也会算通过。
    if (msg.data !== payload) {
      throw new Error(`echo mismatch, expected ${payload}, got: ${msg.data}`)
    }
    return `server echoed: ${msg.data}`
  },

  // close 恰好是 {code, reason}。W3C 的 wasClean 微信没有，出现即多实现。
  async caseClosePayload(url) {
    const task = connect({ url: `${url}?tag=close-payload` })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ code: 1000, reason: 'payload-check', complete: noop })
    const res = await closed
    assertKeys(res, ['code', 'reason'], 'task close')
    if (typeof res.code !== 'number') {
      throw new Error(`close code must be a number, got ${typeof res.code}`)
    }
    if (typeof res.reason !== 'string') {
      throw new Error(`close reason must be a string, got ${typeof res.reason}`)
    }
    return `close payload {code:${res.code}, reason:"${res.reason}"}`
  },

  // error 恰好是 {errMsg}。运行时另有的 errCode 按「少实现」不发。
  async caseErrorPayload() {
    const task = connect({ url: 'wss://127.0.0.1:1', timeout: 5000 })
    const res = await waitError(task, 10000)
    assertKeys(res, ['errMsg'], 'task error')
    assertAsciiErrMsg(res.errMsg, 'refused connection')
    await delay(300)
    return `error payload {errMsg:"${res.errMsg}"}`
  },

  // 全局 open 只有 header，没有 profile。两条通道共用一个投影就会在这里翻车。
  async caseGlobalOpenPayload(url) {
    const seen = []
    wx.onSocketOpen((res) => { seen.push(res) })
    const task = connect({ url: `${url}?tag=global-open` })
    await waitOpen(task)
    await delay(500)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    if (seen.length !== 1) {
      throw new Error(`wx.onSocketOpen must fire exactly once for the current connection, got ${seen.length}`)
    }
    assertKeys(seen[0], ['header'], 'global open')
    return 'global open payload is exactly {header}'
  },

  // -------------------------------------------------------------------------
  // connectSocket 参数校验与返回值
  // -------------------------------------------------------------------------

  // 参数校验失败一律走 fail 回调、不同步抛错，且返回 undefined。
  async caseConnectMissingUrl() {
    let returned = 'not-called'
    const out = await settle((settlers) => {
      returned = wx.connectSocket({ ...settlers })
    }, 5000, 'connectSocket({})')
    const failRes = expectFail(out, 'connectSocket:fail parameter error: parameter.url should be String instead of Undefined;', 'connectSocket({})')
    assertKeys(failRes, ['errMsg'], 'connectSocket missing-url failure')
    if (returned !== undefined) {
      throw new Error(`a parameter-validation failure must return undefined, got ${typeof returned}`)
    }
    return 'errMsg-only parameter error + undefined'
  },

  async caseConnectNumericUrl() {
    let returned = 'not-called'
    const out = await settle((settlers) => {
      returned = wx.connectSocket({ url: 123, ...settlers })
    }, 5000, 'connectSocket({url:123})')
    const failRes = expectFail(out, 'connectSocket:fail parameter error: parameter.url should be String instead of Number;', 'connectSocket({url:123})')
    assertKeys(failRes, ['errMsg'], 'connectSocket numeric-url failure')
    if (returned !== undefined) {
      throw new Error(`a parameter-validation failure must return undefined, got ${typeof returned}`)
    }
    return 'errMsg-only parameter error + undefined'
  },

  // 空串走 invalid url 而不是 parameter error，且这条不带 errno。
  async caseConnectEmptyUrl() {
    let returned = 'not-called'
    const out = await settle((settlers) => {
      returned = wx.connectSocket({ url: '', ...settlers })
    }, 5000, 'connectSocket({url:""})')
    const failRes = expectFail(out, 'connectSocket:fail invalid url ""', 'connectSocket({url:""})')
    if ('errno' in failRes) {
      throw new Error(`an invalid url failure must not carry errno, got ${JSON.stringify(failRes.errno)}`)
    }
    if (returned !== undefined) {
      throw new Error(`a url-validation failure must return undefined, got ${typeof returned}`)
    }
    return 'exact invalid url "" + no errno + undefined'
  },

  // 只放行 wss，其余协议原样回显在 errMsg 里。
  async caseConnectBadScheme() {
    const bad = 'http://10.0.2.2:8955/'
    let returned = 'not-called'
    const out = await settle((settlers) => {
      returned = wx.connectSocket({ url: bad, ...settlers })
    }, 5000, 'connectSocket(http)')
    const failRes = expectFail(out, `connectSocket:fail invalid url "${bad}"`, 'connectSocket(http)')
    if ('errno' in failRes) {
      throw new Error(`an invalid url failure must not carry errno, got ${JSON.stringify(failRes.errno)}`)
    }
    if (returned !== undefined) {
      throw new Error(`a url-validation failure must return undefined, got ${typeof returned}`)
    }
    return `exact invalid url "${bad}"`
  },

  // 没有 options 就没有 fail 通道，errMsg 在脚本层不可观测。
  // 能验的是：返回 undefined、不同步抛错、不下发 native（服务端看不到任何握手）。
  async caseConnectNonObject(url) {
    const base = httpBase(url)
    const canInspectServer = this.platformKind() !== 'web'
    if (canInspectServer) await requestJson(`${base}/__reset`)
    let returned = 'not-called'
    try {
      returned = wx.connectSocket(url)
    }
    catch (e) {
      throw new Error(`connectSocket must not throw synchronously, got: ${e.message || String(e)}`)
    }
    if (returned !== undefined) {
      throw new Error(`connectSocket with a non-object argument must return undefined, got ${typeof returned}`)
    }
    let undefinedArgReturn = 'not-called'
    try {
      undefinedArgReturn = wx.connectSocket()
    }
    catch (e) {
      throw new Error(`connectSocket() must not throw synchronously, got: ${e.message || String(e)}`)
    }
    if (undefinedArgReturn !== undefined) {
      throw new Error(`connectSocket() must return undefined, got ${typeof undefinedArgReturn}`)
    }
    await delay(1200)
    if (canInspectServer) {
      const stats = await requestJson(`${base}/__stats`)
      if (stats.openCount !== 0) {
        throw new Error(`a rejected connectSocket must not dial; the server saw ${stats.openCount} handshake(s)`)
      }
      return 'undefined returned twice, no throw, server saw no handshake'
    }
    return 'undefined returned twice and no synchronous throw; Web wire check is external'
  },

  async caseUppercaseScheme(url) {
    const lower = connect({ url: `${url}?tag=scheme-lower` })
    await waitOpen(lower)
    const lowerClosed = waitClose(lower)
    lower.close({ complete: noop })
    await lowerClosed

    const upper = url.replace(/^wss:\/\//i, 'WSS://')
    let urlRejected = ''
    const task = connect({
      url: `${upper}?tag=scheme-upper`,
      fail: (res) => { urlRejected = (res && res.errMsg) || '' },
    })
    // fe 层的 url 校验是同步的，返回 undefined 就说明正则把大写协议拒了。
    if (task === undefined) {
      throw new Error('an uppercase WSS scheme must pass url validation, but connectSocket returned undefined')
    }
    await delay(1500)
    if (urlRejected.indexOf('invalid url') !== -1) {
      throw new Error(`an uppercase WSS scheme must pass url validation, got: ${urlRejected}`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed.catch(() => {})
    const plainWs = url.replace(/^wss:\/\//i, 'ws://')
    const wsOut = await settle(settlers => wx.connectSocket({ url: plainWs, ...settlers }), 5000, 'connectSocket(ws)')
    expectFail(wsOut, `connectSocket:fail invalid url "${plainWs}"`, 'connectSocket(ws)')
    return 'wss/WSS accepted; ws rejected'
  },

  // -------------------------------------------------------------------------
  // 并发上限
  // -------------------------------------------------------------------------

  async caseConnectingConsumesBudget() {
    const failures = []
    for (let i = 0; i < 6; i++) {
      const task = connect({
        url: `wss://192.0.2.1:9?tag=budget-${i}`,
        timeout: 30000,
        fail: (res) => { failures.push((res && res.errMsg) || '') },
      })
      if (!task || typeof task.send !== 'function') {
        throw new Error(`connectSocket #${i + 1} must return a SocketTask`)
      }
    }
    await delay(500)
    if (failures.length !== 1 || failures[0] !== 'connectSocket:fail fail reach max websocket connect count 5') {
      throw new Error(`the sixth pending connection must be rejected, got: ${JSON.stringify(failures)}`)
    }
    return '5 pending connections accepted; sixth rejected'
  },

  // 5 条连接之后第 6 条被拒；返回的仍是一个已封存 SocketTask。
  async caseMaxConcurrency(url) {
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=conc-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      let sixth = null
      const failRes = await withTimeout(new Promise((resolve) => {
        sixth = connect({
          url: `${url}?tag=conc-5`,
          fail: res => resolve(res),
        })
        if (sixth && typeof sixth.onOpen === 'function') {
          sixth.onOpen(() => resolve(null))
        }
      }), 6000, 'sixth connection verdict')
      if (!failRes) {
        throw new Error('the 6th connection was not rejected once five were OPEN')
      }
      assertErrMsg(failRes.errMsg, 'connectSocket:fail fail reach max websocket connect count 5', 'over-limit connectSocket')
      if ('errno' in failRes) {
        throw new Error(`the over-limit failure must not carry errno, got ${JSON.stringify(failRes.errno)}`)
      }
      if (!sixth || typeof sixth.send !== 'function') {
        throw new Error('an over-limit connectSocket must still return a SocketTask (the limit is checked after construction)')
      }
      if (typeof sixth.then === 'function') {
        throw new Error('connectSocket must never return a Promise')
      }
      return 'exact double-fail errMsg, sealed SocketTask returned'
    }
    finally {
      // 等每条真正进终态再收工，名额是在 close 事件到达时才归还的。
      await Promise.all(tasks.map((t) => {
        const p = waitClose(t)
        t.close({ complete: noop })
        return p.catch(() => {})
      }))
    }
  },

  // 名额在 close / error 事件到达时才归还，进入关闭中间态不提前让出。
  // 同时证明被拒绝的那次尝试没有偷偷占掉一个名额。
  async caseSlotReuse(url) {
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=slot-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      const rejected = await withTimeout(new Promise((resolve) => {
        const overflow = connect({
          url: `${url}?tag=slot-overflow`,
          fail: () => resolve(true),
        })
        if (overflow && typeof overflow.onOpen === 'function') {
          overflow.onOpen(() => resolve(false))
        }
      }), 6000, 'overflow verdict')
      if (!rejected) {
        throw new Error('the 6th connection was not rejected, cannot test slot reuse')
      }
      const victim = tasks.pop()
      const victimClosed = waitClose(victim)
      victim.close({ complete: noop })
      await victimClosed
      const replacement = connect({ url: `${url}?tag=slot-replacement` })
      await waitOpen(replacement)
      tasks.push(replacement)
      return 'the slot freed by a terminal close was immediately reusable'
    }
    finally {
      for (const t of tasks) {
        const p = waitClose(t)
        t.close({ complete: noop })
        // eslint-disable-next-line no-await-in-loop
        await p.catch(() => {})
      }
    }
  },

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  async caseSendBeforeOpen(url) {
    const task = connect({ url: `${url}?tag=send-early` })
    const out = await settle(settlers => task.send({ data: 'too-early', ...settlers }), 5000, 'send while CONNECTING')
    expectFail(out, 'SocketTask.send:fail WebSocket is not connected', 'send while CONNECTING')
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'not-connected failure while CONNECTING'
  },

  async caseSendAfterClose(url) {
    const task = connect({ url: `${url}?tag=send-after-close` })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    const out = await settle(settlers => task.send({ data: 'should-not-go-out', ...settlers }), 5000, 'send after close')
    expectFail(out, 'SocketTask.send:fail WebSocket is not connected', 'send after close')
    return 'not-connected failure after close'
  },

  // ArrayBuffer 是 types 认可的两种 data 之一，必须能原样过 JSON 桥。
  // 回显帧的 data 到底回成 ArrayBuffer 还是 string，两个源都没规定，所以两种都接受，
  // 只断言字节内容没被改坏。
  async caseArrayBufferEcho(url) {
    const task = connect({ url: `${url}?tag=binary-echo` })
    await waitOpen(task)
    const bytes = [0x44, 0x49, 0x4D, 0x49, 0x4E, 0x41]
    const buffer = new ArrayBuffer(bytes.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) {
      view[i] = bytes[i]
    }
    const msgPromise = waitMessage(task)
    const out = await settle(settlers => task.send({ data: buffer, ...settlers }), 5000, 'send(ArrayBuffer)')
    expectSuccess(out)
    const msg = await msgPromise
    assertKeys(msg, ['data'], 'binary message')
    let got
    if (msg.data instanceof ArrayBuffer) {
      const back = new Uint8Array(msg.data)
      got = []
      for (let i = 0; i < back.length; i++) {
        got.push(back[i])
      }
    }
    else if (typeof msg.data === 'string') {
      got = []
      for (let i = 0; i < msg.data.length; i++) {
        got.push(msg.data.charCodeAt(i))
      }
    }
    else {
      throw new Error(`binary echo must arrive as ArrayBuffer or string, got ${typeof msg.data}`)
    }
    if (got.join(',') !== bytes.join(',')) {
      throw new Error(`binary echo bytes mismatch, expected [${bytes}], got [${got}]`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return `${bytes.length} bytes round-tripped intact`
  },

  // TypedArray / DataView 是浏览器 WebSocket 的语义，types 只认 string | ArrayBuffer。
  // 脚本层不得替调用方转换，原样下发由 native 拒绝。会自动转的实现在这里会「成功」。
  async caseTypedArrayRejected(url) {
    const task = connect({ url: `${url}?tag=typed-array` })
    await waitOpen(task)
    const out = await settle(settlers => task.send({ data: new Uint8Array([1, 2, 3]), ...settlers }), 5000, 'send(Uint8Array)')
    // native 拒绝时的文案两个源都没规定，所以这里只断言它确实是 fail 结算。
    assertCallbackSeq(out.seq, 'fail')
    const probe = `after-typed-array-${Date.now()}`
    const msgPromise = waitMessage(task)
    task.send({ data: probe, complete: noop })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`connection unusable after a rejected TypedArray send, got: ${msg.data}`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'Uint8Array was not auto-converted; it was rejected and the socket stayed usable'
  },

  async caseInvalidSend(url) {
    const task = connect({ url: `${url}?tag=bad-send` })
    await waitOpen(task)
    const out = await settle(settlers => task.send({ data: 123, ...settlers }), 5000, 'send(123)')
    assertCallbackSeq(out.seq, 'fail')
    const probe = `after-bad-send-${Date.now()}`
    const msgPromise = waitMessage(task)
    task.send({ data: probe, complete: noop })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`connection unusable after a rejected send, got: ${msg.data}`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'numeric data rejected, connection still usable'
  },

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  // 关闭码被接受时，close 事件要原样带回请求的 code 和 reason，而且只能来一次。
  // 只看 close() 的 success 回调是不够的，code / reason 在路上被改掉也发现不了。
  async caseCloseAccepted(url, code) {
    const task = connect({ url: `${url}?tag=close-${code}` })
    await waitOpen(task)
    const reason = `bye-${code}-收尾`
    const closes = []
    const closeSeen = new Promise((resolve) => {
      task.onClose((res) => {
        closes.push(res)
        resolve(res)
      })
    })
    const out = await settle(settlers => task.close({ code, reason, ...settlers }), 5000, `close(${code})`)
    expectSuccess(out)
    const closeRes = await withTimeout(closeSeen, 8000, `close event for ${code}`)
    // 多等一会，确认没有第二个 close 事件跟上来。
    await delay(400)
    if (closes.length !== 1) {
      throw new Error(`expected exactly one close event, got ${closes.length}`)
    }
    assertKeys(closeRes, ['code', 'reason'], 'task close')
    if (closeRes.code !== code) {
      throw new Error(`close event code mismatch, expected ${code}, got ${closeRes.code}`)
    }
    if (closeRes.reason !== reason) {
      throw new Error(`close event reason mismatch, expected "${reason}", got "${closeRes.reason}"`)
    }
    return `close ${code} echoed back with the reason intact`
  },

  // 非 Number、以及 Number 里的非有限数，都在脚本层静默回落 1000。
  // 这是刻意偏离原生各自行为的一点：NaN 过 Android 的 JSON 桥变 null、
  // 过 iOS 的 JSValue 桥保留，同一份代码两端结局相反，所以 `Number.isFinite` 归一化，
  // 让 native 永远见不到非有限数。用 Number() 强转字符串、或者把非 Number 直接拒掉的
  // 实现，都会在这里翻车。
  async caseCloseCodeFallback(url, code) {
    const label = describeCloseCode(code)
    const task = connect({ url: `${url}?tag=close-fallback` })
    await waitOpen(task)
    const closeSeen = waitClose(task)
    const out = await settle(settlers => task.close({ code, ...settlers }), 5000, `close(${label})`)
    expectSuccess(out)
    const closeRes = await closeSeen
    assertKeys(closeRes, ['code', 'reason'], 'task close')
    if (closeRes.code !== 1000) {
      throw new Error(`close code ${label} must fall back to 1000 in the script layer, got ${closeRes.code}`)
    }
    return `close code ${label} fell back to 1000`
  },

  // 有限数原样下发，由三端传输层按 RFC6455 拒绝（native 例外）。
  // 这是 caseCloseCodeFallback 的对照组：证明 native 的范围校验本身还在，
  // 回落 1000 不是靠「把所有异常 code 都拦在脚本层」蒙混过关的。
  // 拒绝不能顺手把连接弄坏——之后还得能正常收发。
  async caseCloseRejected(url, code) {
    const label = describeCloseCode(code)
    const task = connect({ url: `${url}?tag=close-${label}` })
    await waitOpen(task)
    const out = await settle(settlers => task.close({ code, ...settlers }), 5000, `close(${label})`)
    // 拒绝文案来自 native 的 RFC6455 校验，两个源都没规定，所以只断言它确实是 fail 结算。
    assertCallbackSeq(out.seq, 'fail')
    const probe = `still-alive-${Date.now()}`
    const msgPromise = waitMessage(task)
    task.send({ data: probe, complete: noop })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`connection unusable after a rejected close, got: ${msg.data}`)
    }
    const cleanup = waitClose(task)
    task.close({ code: 1000, complete: noop })
    await cleanup
    return `close ${label} rejected, connection still usable`
  },

  // SocketTask.close 可以取消自身的握手中连接，且终态事件只能来一次。
  async caseCloseWhileConnecting() {
    const task = connect({ url: 'wss://192.0.2.1:9?tag=connecting-close', timeout: 30000 })
    const closes = []
    const errors = []
    const settled = new Promise((resolve) => {
      task.onClose((res) => { closes.push(res); resolve('close') })
      task.onError((res) => { errors.push(res); resolve('error') })
    })
    task.close({ code: 1000, reason: 'cancel-while-connecting', complete: noop })
    const kind = await withTimeout(settled, 10000, 'terminal event while CONNECTING')
    await delay(800)
    if (closes.length + errors.length !== 1) {
      throw new Error(`expected exactly one terminal event, got ${closes.length} close(s) and ${errors.length} error(s)`)
    }
    if (kind === 'close') {
      assertKeys(closes[0], ['code', 'reason'], 'task close')
      if (typeof closes[0].code !== 'number') {
        throw new Error(`close code must be a number, got ${typeof closes[0].code}`)
      }
    }
    else {
      assertKeys(errors[0], ['errMsg'], 'task error')
    }
    return `exactly one ${kind} terminal event`
  },

  // -------------------------------------------------------------------------
  // 监听器语义
  // -------------------------------------------------------------------------

  // 任务态监听器是 Set，不同函数并存、同一函数对象重复注册被去重。
  // 换成单槽的实现会在这里丢掉前两个回调。
  async caseMultipleListeners(url) {
    const task = connect({ url: `${url}?tag=multi-listener` })
    await waitOpen(task)
    const hits = []
    const first = () => { hits.push('first') }
    const second = () => { hits.push('second') }
    const dup = () => { hits.push('dup') }
    task.onMessage(first)
    task.onMessage(second)
    task.onMessage(dup)
    task.onMessage(dup)
    const payload = `multi-${Date.now()}`
    task.send({ data: payload, complete: noop })
    await delay(1500)
    const counts = { first: 0, second: 0, dup: 0 }
    for (const name of hits) {
      counts[name]++
    }
    if (counts.first !== 1 || counts.second !== 1) {
      throw new Error(`every distinct listener must fire once, got ${JSON.stringify(counts)}`)
    }
    if (counts.dup !== 1) {
      throw new Error(`registering the same function twice must be deduped, got ${counts.dup} hits`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'two distinct listeners fired once each, the duplicate was deduped'
  },

  // 不得自造事件重放。终态之后才挂上的监听器必须什么也收不到。
  // 「记忆重放」的实现会在这里把早就结束的事件补给新监听器。
  async caseNoEventReplay(url) {
    const task = connect({ url: `${url}?tag=no-replay` })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ code: 1000, reason: 'replay-check', complete: noop })
    await closed
    await delay(400)
    const late = []
    task.onOpen(() => { late.push('open') })
    task.onMessage(() => { late.push('message') })
    task.onError(() => { late.push('error') })
    task.onClose(() => { late.push('close') })
    await delay(1200)
    if (late.length !== 0) {
      throw new Error(`listeners attached after the terminal event must never fire, got: ${JSON.stringify(late)}`)
    }
    return 'no replay to late listeners'
  },

  // error 是异步派发的，就是为了让 connectSocket 先返回、调用方来得及注册 onError。
  // 连一个本机没人监听的端口，TCP 会立刻被拒，注册消息和事件的竞态窗口只有一两毫秒，
  // 跑一次经常撞不上，所以连跑多轮。
  async caseRefusedConnection() {
    const rounds = 5
    const seen = []
    for (let i = 0; i < rounds; i++) {
      const task = connect({ url: `wss://127.0.0.1:1?tag=refused-${i}`, timeout: 5000 })
      // eslint-disable-next-line no-await-in-loop
      const res = await waitError(task, 10000).catch(e => ({ failure: e.message || String(e) }))
      if (res.failure) {
        throw new Error(`round ${i + 1}/${rounds}: ${res.failure}`)
      }
      assertKeys(res, ['errMsg'], `round ${i + 1} error`)
      assertAsciiErrMsg(res.errMsg, `round ${i + 1} error`)
      if (res.errMsg !== seen[0] && seen.length > 0) {
        throw new Error(`the same failure must always normalize to the same errMsg, round 1 gave "${seen[0]}" but round ${i + 1} gave "${res.errMsg}"`)
      }
      seen.push(res.errMsg)
    }
    return `${rounds} refused connections all reported: ${seen[0]}`
  },

  // -------------------------------------------------------------------------
  // 全局接口
  // -------------------------------------------------------------------------

  // 全局监听是 WeakMap.set 语义，同名事件只保留最后一次注册的回调。
  // 用 Map / Set 存多个 listener 的实现会让第一个也跟着触发。
  async caseGlobalHandlerOverwrite(url) {
    const firstHits = []
    const secondHits = []
    wx.onSocketMessage((res) => { firstHits.push(res.data) })
    wx.onSocketMessage((res) => { secondHits.push(res.data) })
    const task = connect({ url: `${url}?tag=global-overwrite` })
    await waitOpen(task)
    const payload = `overwrite-${Date.now()}`
    task.send({ data: payload, complete: noop })
    await delay(1500)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    if (firstHits.length !== 0) {
      throw new Error(`the replaced global handler must not fire, got: ${JSON.stringify(firstHits)}`)
    }
    if (secondHits.length !== 1 || secondHits[0] !== payload) {
      throw new Error(`the last registered global handler must receive the message once, got: ${JSON.stringify(secondHits)}`)
    }
    return 'only the last registration fired'
  },

  // 分发判据是「事件来自当前连接」，其他并发连接的事件静默丢弃。
  // 按 socketId 广播给所有全局监听的实现会在这里多收一条。
  async caseGlobalHandlerScope(url) {
    const globalHits = []
    wx.onSocketMessage((res) => { globalHits.push(res.data) })
    const current = connect({ url: `${url}?tag=scope-current` })
    await waitOpen(current)
    const other = connect({ url: `${url}?tag=scope-other` })
    await waitOpen(other)
    const currentPayload = `scope-current-${Date.now()}`
    const otherPayload = `scope-other-${Date.now()}`
    const otherEcho = waitMessage(other)
    current.send({ data: currentPayload, complete: noop })
    other.send({ data: otherPayload, complete: noop })
    // 等对方那条真的收到了自己的回显，再判断全局监听有没有被串到。
    await otherEcho
    await delay(1000)
    await Promise.all([current, other].map((t) => {
      const p = waitClose(t)
      t.close({ complete: noop })
      return p.catch(() => {})
    }))
    if (globalHits.length !== 1 || globalHits[0] !== currentPayload) {
      throw new Error(`global handler must only see the current connection message, got: ${JSON.stringify(globalHits)}`)
    }
    return 'the other connection message never reached the global handler'
  },

  // 非函数参数走 fail，只是这里没有 fail 通道，errMsg 不可观测。
  // 能验的是「监听器没被登记」：先挂一个正常回调，再用非函数调一次；
  // 如果实现把它写进了单槽，正常回调就被顶掉，下面这条消息就收不到了。
  async caseGlobalHandlerBadArg(url) {
    const hits = []
    wx.onSocketMessage((res) => { hits.push(res.data) })
    let returned = 'not-called'
    try {
      returned = wx.onSocketMessage(123)
    }
    catch (e) {
      throw new Error(`wx.onSocketMessage(123) must not throw synchronously, got: ${e.message || String(e)}`)
    }
    if (returned !== undefined) {
      throw new Error(`wx.onSocketMessage must return void, got ${typeof returned}`)
    }
    try {
      wx.onSocketOpen(undefined)
    }
    catch (e) {
      throw new Error(`wx.onSocketOpen(undefined) must not throw synchronously, got: ${e.message || String(e)}`)
    }
    const task = connect({ url: `${url}?tag=global-bad-arg` })
    await waitOpen(task)
    const payload = `bad-arg-${Date.now()}`
    task.send({ data: payload, complete: noop })
    await delay(1500)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    if (hits.length !== 1 || hits[0] !== payload) {
      throw new Error(`a non-function registration must not replace the live handler, got: ${JSON.stringify(hits)}`)
    }
    return 'the non-function registration was rejected and the live handler survived'
  },

  // 全局接口绑定的是「最早的、尚未 CLOSED 的那条」，判定发生在 connectSocket 当场。
  // 绑定不会因为那条自己关掉就漂移到次老的，只有下一次 connectSocket 才可能改绑。
  async caseGlobalBinding(url) {
    const a = connect({ url: `${url}?tag=bind-A` })
    await waitOpen(a)
    const b = connect({ url: `${url}?tag=bind-B` })
    await waitOpen(b)
    const aGot = []
    const bGot = []
    a.onMessage((res) => { aGot.push(res.data) })
    b.onMessage((res) => { bGot.push(res.data) })

    const first = `bind-first-${Date.now()}`
    expectSuccess(await settle(settlers => wx.sendSocketMessage({ data: first, ...settlers }), 5000, 'sendSocketMessage -> A'))
    await delay(1200)
    if (aGot.join('|') !== first) {
      throw new Error(`the global send must reach the earliest connection, A got: ${JSON.stringify(aGot)}`)
    }
    if (bGot.length !== 0) {
      throw new Error(`the global send must not reach a later connection, B got: ${JSON.stringify(bGot)}`)
    }

    // A 自己关掉之后绑定不漂移：全局 send 必须失败，而不是落到 B 上。
    const aClosed = waitClose(a)
    a.close({ complete: noop })
    await aClosed
    expectFail(
      await settle(settlers => wx.sendSocketMessage({ data: 'must-not-drift', ...settlers }), 5000, 'sendSocketMessage after A closed'),
      'sendSocketMessage:fail WebSocket is not connected',
      'sendSocketMessage after A closed',
    )
    await delay(800)
    if (bGot.length !== 0) {
      throw new Error(`the binding must not drift to B when A closes, B got: ${JSON.stringify(bGot)}`)
    }

    // 下一次 connectSocket 时旧绑定已 CLOSED，这才改绑到新建的 C，而不是补回 B。
    const c = connect({ url: `${url}?tag=bind-C` })
    await waitOpen(c)
    const cGot = []
    c.onMessage((res) => { cGot.push(res.data) })
    const second = `bind-second-${Date.now()}`
    expectSuccess(await settle(settlers => wx.sendSocketMessage({ data: second, ...settlers }), 5000, 'sendSocketMessage -> C'))
    await delay(1200)
    if (cGot.join('|') !== second) {
      throw new Error(`connectSocket must rebind to the new task once the old one is CLOSED, C got: ${JSON.stringify(cGot)}`)
    }
    if (bGot.length !== 0) {
      throw new Error(`the binding must never fall back to B, B got: ${JSON.stringify(bGot)}`)
    }
    await Promise.all([b, c].map((t) => {
      const p = waitClose(t)
      t.close({ complete: noop })
      return p.catch(() => {})
    }))
    return 'bound to A, no drift when A closed, rebound to C on the next connectSocket'
  },

  // 多连接绑定是 Dimina 的确定性行为：停在 CONNECTING 的最早连接继续占住全局路由。
  // 把改绑挪到 open 事件里的实现会让全局 send 落到后建的那条上。
  async caseConnectingHoldsBinding(url) {
    const stuck = connect({ url: 'wss://192.0.2.1:9?tag=hold-binding', timeout: 30000 })
    const later = connect({ url: `${url}?tag=hold-later` })
    await waitOpen(later)
    const laterGot = []
    later.onMessage((res) => { laterGot.push(res.data) })
    expectFail(
      await settle(settlers => wx.sendSocketMessage({ data: 'no-drift', ...settlers }), 5000, 'sendSocketMessage while CONNECTING holds the binding'),
      'sendSocketMessage:fail WebSocket is not connected',
      'sendSocketMessage while CONNECTING holds the binding',
    )
    await delay(1000)
    if (laterGot.length !== 0) {
      throw new Error(`a CONNECTING task must keep the binding; the later connection got: ${JSON.stringify(laterGot)}`)
    }
    return 'the CONNECTING task kept the binding and the global send failed instead of drifting'
  },

  // 全局 send 只作用于已打开的当前连接。
  async caseGlobalSendNotConnected() {
    expectFail(
      await settle(settlers => wx.sendSocketMessage({ data: 'nobody-home', ...settlers }), 5000, 'sendSocketMessage with no connection'),
      'sendSocketMessage:fail WebSocket is not connected',
      'sendSocketMessage with no connection',
    )
    return 'exact sendSocketMessage errMsg'
  },

  async caseCloseSocketOnlyTarget(url) {
    const a = connect({ url: `${url}?tag=global-target-A` })
    await waitOpen(a)
    const b = connect({ url: `${url}?tag=global-other-B` })
    await waitOpen(b)
    const aCloses = []
    const bCloses = []
    a.onClose((res) => { aCloses.push(res) })
    b.onClose((res) => { bCloses.push(res) })

    const reason = 'target-only'
    const out = await settle(settlers => wx.closeSocket({ code: 3000, reason, ...settlers }), 5000, 'wx.closeSocket')
    expectSuccess(out)
    await delay(2500)

    if (aCloses.length !== 1) {
      throw new Error(`A should close exactly once, got ${aCloses.length}`)
    }
    if (bCloses.length !== 0) {
      throw new Error(`wx.closeSocket must not close another SocketTask, B got ${bCloses.length} close event(s)`)
    }
    if (aCloses[0].code !== 3000 || aCloses[0].reason !== reason) {
      throw new Error(`A should use the requested code/reason, got ${aCloses[0].code}/${aCloses[0].reason}`)
    }
    const bClosed = waitClose(b)
    b.close({ complete: noop })
    await bClosed
    return `A closed with 3000/${reason}; B remained open`
  },

  async caseCloseSocketRejectsConnecting(url) {
    const stuck = connect({ url: 'wss://192.0.2.1:9?tag=global-close-connecting', timeout: 30000 })
    const open = connect({ url: `${url}?tag=global-close-other` })
    await waitOpen(open)
    const closes = []
    stuck.onClose(res => closes.push(['stuck', res]))
    open.onClose(res => closes.push(['open', res]))

    expectFail(
      await settle(settlers => wx.closeSocket({ code: 1000, ...settlers }), 5000, 'wx.closeSocket while target CONNECTING'),
      'closeSocket:fail WebSocket is not connected',
      'wx.closeSocket while target CONNECTING',
    )
    await delay(500)
    if (closes.length !== 0) {
      throw new Error(`wx.closeSocket must leave both tasks untouched, got ${JSON.stringify(closes)}`)
    }
    return 'CONNECTING global target rejected; other task untouched'
  },

  async caseCloseSocketFailLeavesOthers(url) {
    const a = connect({ url: `${url}?tag=global-terminal-A` })
    await waitOpen(a)
    const b = connect({ url: `${url}?tag=global-survivor-B` })
    await waitOpen(b)
    const aClosed = waitClose(a)
    a.close({ complete: noop })
    await aClosed

    expectFail(
      await settle(settlers => wx.closeSocket({ code: 3000, reason: 'ignored', ...settlers }), 5000, 'wx.closeSocket with a CLOSED current'),
      'closeSocket:fail WebSocket is not connected',
      'wx.closeSocket with a CLOSED current',
    )
    const probe = `still-open-${Date.now()}`
    const msgPromise = waitMessage(b)
    b.send({ data: probe, complete: noop })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`B must remain usable after the failing global close, got ${msg.data}`)
    }
    const bClosed = waitClose(b)
    b.close({ complete: noop })
    await bClosed
    return 'terminal global target failed; B remained usable'
  },

  async caseCloseSocketNotConnected() {
    expectFail(
      await settle(settlers => wx.closeSocket({ code: 1000, ...settlers }), 5000, 'wx.closeSocket with no connection'),
      'closeSocket:fail WebSocket is not connected',
      'wx.closeSocket with no connection',
    )
    return 'exact closeSocket errMsg'
  },

  // -------------------------------------------------------------------------
  // 返回值形态
  // -------------------------------------------------------------------------

  // 判据是「参数对象上有没有 success / fail / complete 这个键」，不是「值是不是函数」。
  // 用 isFunction 判定的实现会把 { success: undefined } 判成 Promise 分支。
  async caseReturnShapes(url) {
    const task = connect({ url: `${url}?tag=return-shape` })
    if (!task || typeof task.send !== 'function') {
      throw new Error('connectSocket must return a SocketTask')
    }
    if (typeof task.then === 'function') {
      throw new Error('connectSocket must never return a Promise')
    }
    await waitOpen(task)

    if (task.send({ data: 'ret-task-void' }) !== undefined) {
      throw new Error('SocketTask.send must return void')
    }
    const withSettler = wx.sendSocketMessage({ data: 'ret-1', success: noop, complete: noop })
    if (withSettler !== undefined) {
      throw new Error('wx.sendSocketMessage with settler keys must return void')
    }
    const undefinedSettler = wx.sendSocketMessage({ data: 'ret-2', success: undefined })
    if (undefinedSettler !== undefined) {
      throw new Error('a present-but-undefined success key must still take the void branch, not the Promise branch')
    }
    const promised = wx.sendSocketMessage({ data: 'ret-3' })
    if (!promised || typeof promised.then !== 'function') {
      throw new Error('wx.sendSocketMessage without any settler key must return a Promise')
    }
    promised.then(noop, noop)

    const closeVoid = wx.closeSocket({ code: 1000, complete: noop })
    if (closeVoid !== undefined) {
      throw new Error('wx.closeSocket with settler keys must return void')
    }
    const closePromise = wx.closeSocket({})
    if (!closePromise || typeof closePromise.then !== 'function') {
      throw new Error('wx.closeSocket without any settler key must return a Promise')
    }
    closePromise.then(noop, noop)
    if (task.close({ complete: noop }) !== undefined) {
      throw new Error('SocketTask.close must return void')
    }
    await delay(800)
    return 'SocketTask returned, void for settler keys, Promise only when no settler key is present'
  },

  // -------------------------------------------------------------------------
  // 回调结算
  // -------------------------------------------------------------------------

  // 这条链路真的断过：shared/jssdk 是被 git 跟踪的构建产物，源码给 invokeAPI 补了
  // 「非函数值原样透传」的分支，产物却没跟着重新生成，设备上跑的旧产物会把已经登记成
  // 编号的 fail / complete 直接丢掉。事件监听走的是另一条路，测不出这个问题。
  async caseConnectCallbacks(url) {
    let task = null
    const out = await settle((settlers) => {
      task = connect({ url: `${url}?tag=cb-ok`, ...settlers })
    }, 8000, 'connectSocket callbacks')
    expectSuccess(out)
    // 等真正连上，避免只验证了「请求被受理」就收工。
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'success then complete, each exactly once'
  },

  async caseConnectFailCallbacks(url) {
    // 先把 5 个名额推到 OPEN，第 6 条必定被拒，借此走一遍失败路径。
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=cbfail-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      const out = await settle((settlers) => {
        connect({ url: `${url}?tag=cbfail-5`, ...settlers })
      }, 8000, 'over-limit connectSocket callbacks')
      expectFail(out, 'connectSocket:fail fail reach max websocket connect count 5', 'over-limit connectSocket')
      return 'fail then complete, each exactly once'
    }
    finally {
      for (const t of tasks) {
        const p = waitClose(t)
        t.close({ complete: noop })
        // eslint-disable-next-line no-await-in-loop
        await p.catch(() => {})
      }
    }
  },

  async caseSendCallbacks(url) {
    const task = connect({ url: `${url}?tag=send-cb` })
    await waitOpen(task)
    const payload = `cb-probe-${Date.now()}`
    const msgPromise = waitMessage(task)
    const out = await settle(settlers => task.send({ data: payload, ...settlers }), 8000, 'send callbacks')
    expectSuccess(out)
    // 除了回调，还要收到这条消息的回显，证明它确实发出去了。
    const msg = await msgPromise
    if (msg.data !== payload) {
      throw new Error(`echo mismatch, expected ${payload}, got: ${msg.data}`)
    }
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return 'success then complete, each exactly once'
  },

  async caseCloseCallbacks(url) {
    const task = connect({ url: `${url}?tag=close-cb` })
    await waitOpen(task)
    const closed = waitClose(task)
    const out = await settle(settlers => task.close({ code: 1000, ...settlers }), 8000, 'close callbacks')
    expectSuccess(out)
    // 这里以前写的是 .catch(() => {})，close 事件没来也会被吞掉，等于白测。
    await closed
    return 'success then complete, each exactly once'
  },

  // -------------------------------------------------------------------------
  // 握手交叉验证
  // -------------------------------------------------------------------------

  // Native Referer 由容器固定注入；HarmonyOS 和浏览器会由平台添加 Origin。
  // protocols 必须真的进握手头 —— 只看客户端回调的话，参数被吞掉也发现不了。
  async caseHandshakeHeaders(url) {
    const base = httpBase(url)
    const platform = this.platformKind()
    if (platform !== 'web') await requestJson(`${base}/__reset`)
    const tag = 'handshake-headers'
    const task = connect({ url: `${url}?tag=${tag}`, protocols: ['chat.v1', 'superchat'] })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed.catch(() => {})
    if (platform === 'web') {
      return 'browser opened with both protocols; wire headers are checked by the external harness'
    }

    const stats = await requestJson(`${base}/__stats`)
    const handshake = findHandshake(stats, tag)
    const headers = handshake.headers || {}
    if ((platform === 'android' || platform === 'ios') && 'origin' in headers) {
      throw new Error(`Android/iOS must not inject Origin, got "${headers.origin}"`)
    }
    if (platform === 'harmony' && (typeof headers.origin !== 'string' || headers.origin.length === 0)) {
      throw new Error(`HarmonyOS must carry the platform-generated Origin, got ${JSON.stringify(headers.origin)}`)
    }
    const referer = headers.referer
    if (typeof referer !== 'string' || !/^https:\/\/[^/]+\/[^/]+\/[^/]+\/page-frame\.html$/.test(referer)) {
      throw new Error(`Referer must look like https://<host>/<appid>/<version>/page-frame.html, got ${JSON.stringify(referer)}`)
    }
    if (referer.indexOf('servicewechat.com') !== -1) {
      throw new Error(`dimina must not claim servicewechat.com in the handshake, got "${referer}"`)
    }
    const negotiated = headers['sec-websocket-protocol']
    if (typeof negotiated !== 'string') {
      throw new Error(`protocols must reach the handshake as Sec-WebSocket-Protocol, got ${JSON.stringify(negotiated)}`)
    }
    const parts = negotiated.split(',').map(item => item.trim())
    if (parts.join('|') !== 'chat.v1|superchat') {
      throw new Error(`Sec-WebSocket-Protocol must carry the requested list in order, got "${negotiated}"`)
    }
    return `${platform || 'unknown'} handshake headers and protocols "${negotiated}" verified`
  },

  // header 值统一归一化 —— string 原样、number 转字符串、其余一切类型变成
  // Object.prototype.toString.apply 的结果。丢掉 null / undefined 值、或者用 String()
  // 把数组拼成 "1,2" 的实现都会在这里露出来。调用方自带的 Referer 要被丢弃。
  async caseHeaderNormalization(url) {
    const base = httpBase(url)
    if (this.platformKind() !== 'web') await requestJson(`${base}/__reset`)
    const tag = 'header-normalize'
    const task = connect({
      url: `${url}?tag=${tag}`,
      header: {
        'x-dimina-str': 'plain',
        'x-dimina-num': 42,
        'x-dimina-obj': { a: 1 },
        'x-dimina-arr': [1, 2],
        'x-dimina-null': null,
        'x-dimina-undef': undefined,
        'Referer': 'https://caller.example/injected',
      },
    })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed.catch(() => {})
    if (this.platformKind() === 'web') {
      return 'browser accepted the call; omitted headers are checked by the external harness'
    }

    const stats = await requestJson(`${base}/__stats`)
    const headers = findHandshake(stats, tag).headers || {}
    const expected = {
      'x-dimina-str': 'plain',
      'x-dimina-num': '42',
      'x-dimina-obj': '[object Object]',
      'x-dimina-arr': '[object Array]',
      'x-dimina-null': '[object Null]',
      'x-dimina-undef': '[object Undefined]',
    }
    for (const name of Object.keys(expected)) {
      if (headers[name] !== expected[name]) {
        throw new Error(`header ${name} must be "${expected[name]}", got ${JSON.stringify(headers[name])}`)
      }
    }
    if (headers.referer === 'https://caller.example/injected') {
      throw new Error('a caller-supplied Referer must be dropped; the container Referer is the only one allowed')
    }
    return '6 header values normalized by service, caller Referer dropped'
  },

  // Android 可下发两个仅大小写不同的字段；iOS/HarmonyOS 按字段名字典序保留一个；
  // 浏览器不提供自定义握手请求头接口。
  async caseHeaderCaseNotFolded(url) {
    const base = httpBase(url)
    const platform = this.platformKind()
    if (platform !== 'web') await requestJson(`${base}/__reset`)
    const tag = 'header-case'
    const task = connect({
      url: `${url}?tag=${tag}`,
      header: {
        'X-Dimina-Case': 'upper',
        'x-dimina-case': 'lower',
      },
    })
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed.catch(() => {})
    if (platform === 'web') {
      return 'browser accepted the call; omitted case variants are checked by the external harness'
    }

    const stats = await requestJson(`${base}/__stats`)
    const headers = findHandshake(stats, tag).headers || {}
    const raw = headers['x-dimina-case']
    if (platform === 'ios' || platform === 'harmony') {
      if (raw !== 'upper') throw new Error(`${platform} must retain the dictionary-first variant, got ${JSON.stringify(raw)}`)
      return `${platform} retained the dictionary-first variant`
    }
    if (typeof raw !== 'string') {
      throw new Error(`the case-variant headers must reach the handshake, got ${JSON.stringify(raw)}`)
    }
    const values = raw.split(',').map(item => item.trim()).sort().join('|')
    if (values !== 'lower|upper') {
      throw new Error(`Android must send both case variants, got "${raw}"`)
    }
    return `both case variants reached the Android handshake: "${raw}"`
  },

  // -------------------------------------------------------------------------
  // 路由与时序
  // -------------------------------------------------------------------------

  // 两条连接各自收自己的消息，关掉一条不能影响另一条。
  // 这一条盯的是 socketId 路由：如果 send / onMessage / close 把 socketId 弄丢了、
  // 一律作用在第一条连接上，其余单连接用例都发现不了。
  async caseTwoTaskIsolation(url) {
    const taskA = connect({ url: `${url}?tag=iso-A` })
    await waitOpen(taskA)
    const taskB = connect({ url: `${url}?tag=iso-B` })
    await waitOpen(taskB)

    const aGot = []
    const bGot = []
    taskA.onMessage((res) => { aGot.push(res.data) })
    taskB.onMessage((res) => { bGot.push(res.data) })

    const payloadA = `iso-a-${Date.now()}`
    const payloadB = `iso-b-${Date.now()}`
    taskA.send({ data: payloadA, complete: noop })
    taskB.send({ data: payloadB, complete: noop })
    await delay(1500)

    if (aGot.length !== 1 || aGot[0] !== payloadA) {
      throw new Error(`A should receive only its own payload, got: ${JSON.stringify(aGot)}`)
    }
    if (bGot.length !== 1 || bGot[0] !== payloadB) {
      throw new Error(`B should receive only its own payload, got: ${JSON.stringify(bGot)}`)
    }

    // 关掉 B 之后 A 必须还活着，用一次真实往返来证明，而不是只看没报错。
    const closeB = waitClose(taskB)
    taskB.close({ complete: noop })
    await closeB
    const probe = `iso-a-again-${Date.now()}`
    const probePromise = waitMessage(taskA)
    taskA.send({ data: probe, complete: noop })
    const probeMsg = await probePromise
    if (probeMsg.data !== probe) {
      throw new Error(`A broke after closing B, got: ${probeMsg.data}`)
    }
    const closeA = waitClose(taskA)
    taskA.close({ complete: noop })
    await closeA
    return 'two tasks routed independently'
  },

  // 连接超时不只由容器自己的定时器驱动，还要交给平台传输层：Android 的 OkHttp
  // 默认连接超时 10 秒，iOS 的 URLRequest 默认 60 秒，不跟着请求值走的话，调用方要求的
  // 更长超时会被平台先掐断。打一个黑洞地址（RFC 5737 的测试网段，不回 RST，只能等超时），
  // 要求 15 秒，断言 error 确实是 12 秒之后才来的。
  async caseLongConnectTimeout() {
    const timeout = 15000
    const startedAt = Date.now()
    const task = connect({ url: 'wss://192.0.2.1:9?tag=long-timeout', timeout })
    const errRes = await waitError(task, timeout + 8000)
    const elapsed = Date.now() - startedAt
    assertKeys(errRes, ['errMsg'], 'task error')
    const platform = this.platformKind()
    if (platform === 'harmony' || platform === 'web') {
      assertAsciiErrMsg(errRes.errMsg, 'long connect timeout')
      if (errRes.errMsg !== TIMEOUT_ERR_MSG && errRes.errMsg !== 'connectSocket:fail WebSocket connection failed') {
        throw new Error(`${platform} returned an unexpected connection failure: ${errRes.errMsg}`)
      }
      return `${platform} transport reported "${errRes.errMsg}" after ${elapsed}ms`
    }
    assertErrMsg(errRes.errMsg, TIMEOUT_ERR_MSG, 'long connect timeout')
    if (elapsed < 12000) {
      throw new Error(`failed after ${elapsed}ms; the requested ${timeout}ms timeout was cut short by the platform default`)
    }
    return `failed after ${elapsed}ms with the exact timeout errMsg`
  },

  // 同一件事（连不上、超时了）原来在两条路径上给出两种文案 —— 容器自己的连接计时器
  // 到期给 `timed out`、传输层上报的超时经归一化给 `timeout` —— 调用方要判「是不是超时」
  // 得写两个分支。两条路径统一为 `connectSocket:fail timeout`。
  // 这条走的是「请求超时远小于平台默认」的那一侧，与上面那条 15 秒的一起把两侧都钉住。
  async caseShortConnectTimeout() {
    const timeout = 2000
    const startedAt = Date.now()
    const task = connect({ url: 'wss://192.0.2.1:9?tag=short-timeout', timeout })
    const errRes = await waitError(task, 12000)
    const elapsed = Date.now() - startedAt
    assertKeys(errRes, ['errMsg'], 'task error')
    if (this.platformKind() === 'web' && errRes.errMsg === 'connectSocket:fail WebSocket connection failed') {
      return `browser transport reported an earlier connection failure after ${elapsed}ms`
    }
    assertErrMsg(errRes.errMsg, TIMEOUT_ERR_MSG, 'short connect timeout')
    if (elapsed < 1200) {
      throw new Error(`failed after only ${elapsed}ms; the requested ${timeout}ms timeout was not honoured`)
    }
    if (elapsed > 8000) {
      throw new Error(`failed after ${elapsed}ms; the requested ${timeout}ms timeout was ignored in favour of a platform default`)
    }
    return `failed after ${elapsed}ms with the exact timeout errMsg`
  },

  // -------------------------------------------------------------------------
  // complete 载荷
  // -------------------------------------------------------------------------

  // complete 收到的 res 必须与同一次调用的 success 相同。
  // 三端曾分别给 undefined / {}，`wx.closeSocket({complete: res => res.errMsg})` 在
  // 其中一端直接 TypeError —— 事件监听走另一条路，测不出这个问题。
  async caseCompleteMatchesSuccessRes(url) {
    let task = null
    const connectOut = await settle((settlers) => {
      task = connect({ url: `${url}?tag=complete-ok`, ...settlers })
    }, 8000, 'connectSocket')
    expectSuccess(connectOut)
    assertCompleteMatchesSettler(connectOut, 'connectSocket success')
    await waitOpen(task)

    const sendOut = await settle(settlers => task.send({ data: 'complete-probe', ...settlers }), 5000, 'SocketTask.send')
    expectSuccess(sendOut)
    assertCompleteMatchesSettler(sendOut, 'SocketTask.send success')

    const globalSendOut = await settle(settlers => wx.sendSocketMessage({ data: 'complete-global', ...settlers }), 5000, 'wx.sendSocketMessage')
    expectSuccess(globalSendOut)
    assertCompleteMatchesSettler(globalSendOut, 'wx.sendSocketMessage success')

    const closed = waitClose(task)
    const closeOut = await settle(settlers => wx.closeSocket({ code: 1000, ...settlers }), 5000, 'wx.closeSocket')
    expectSuccess(closeOut)
    assertCompleteMatchesSettler(closeOut, 'wx.closeSocket success')
    await closed
    return '4 success paths handed complete the same res'
  },

  async caseCompleteMatchesFailRes(url) {
    // 参数校验失败这一路的 res 还带 errno，正好验「相同」不是「都给一个空对象」。
    const paramOut = await settle(settlers => wx.connectSocket({ ...settlers }), 5000, 'connectSocket({})')
    expectFail(paramOut, 'connectSocket:fail parameter error: parameter.url should be String instead of Undefined;', 'connectSocket({})')
    assertCompleteMatchesSettler(paramOut, 'connectSocket parameter failure')

    const globalSendOut = await settle(settlers => wx.sendSocketMessage({ data: 'x', ...settlers }), 5000, 'wx.sendSocketMessage')
    expectFail(globalSendOut, 'sendSocketMessage:fail WebSocket is not connected', 'wx.sendSocketMessage')
    assertCompleteMatchesSettler(globalSendOut, 'wx.sendSocketMessage failure')

    const closeOut = await settle(settlers => wx.closeSocket({ ...settlers }), 5000, 'wx.closeSocket')
    expectFail(closeOut, 'closeSocket:fail WebSocket is not connected', 'wx.closeSocket')
    assertCompleteMatchesSettler(closeOut, 'wx.closeSocket failure')

    const task = connect({ url: `${url}?tag=complete-fail` })
    const sendOut = await settle(settlers => task.send({ data: 'too-early', ...settlers }), 5000, 'SocketTask.send while CONNECTING')
    expectFail(sendOut, 'SocketTask.send:fail WebSocket is not connected', 'SocketTask.send while CONNECTING')
    assertCompleteMatchesSettler(sendOut, 'SocketTask.send failure')
    await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    return '4 failure paths handed complete the same res'
  },

  // -------------------------------------------------------------------------
  // 三端同构的额外约束
  // -------------------------------------------------------------------------

  // fe 保证 string 值原样穿透，所以中文 header 值是正常链路可达的合法输入。
  // Android 被 OkHttp 的 header 值校验拒（≥0x7F），iOS 照单放行 —— 一端连不上一端连得上。
  // 三端统一在校验阶段拒绝，且必须在拨号之前，不能像 Android 原来那样先回 ok、
  // 之后才补一个 error 事件。服务端那边一条握手都不该看到。
  async caseNonAsciiHeaderRejected(url) {
    const base = httpBase(url)
    const canInspectServer = this.platformKind() !== 'web'
    if (canInspectServer) await requestJson(`${base}/__reset`)
    const tag = 'non-ascii-header'
    let errored = false
    const startedAt = Date.now()
    const out = await settle((settlers) => {
      const task = connect({
        url: `${url}?tag=${tag}`,
        header: { 'X-Dimina-Text': '中文值' },
        // 超时给足，好让「等到连接超时才报错」这种迟到拒绝暴露成失败而不是蒙混过关。
        timeout: 30000,
        ...settlers,
      })
      if (task && typeof task.onError === 'function') {
        task.onError(() => { errored = true })
      }
    }, 12000, 'connectSocket with a non-ASCII header value')
    assertCallbackSeq(out.seq, 'fail')
    // 具体文案没有写死，但要求它是容器自己的固定英文串。
    assertAsciiErrMsg(out.failRes.errMsg, 'non-ASCII header rejection')
    const elapsed = Date.now() - startedAt
    if (elapsed > 8000) {
      throw new Error(`the rejection arrived after ${elapsed}ms; it must happen before dialing, not after the connect timeout`)
    }
    await delay(1500)
    if (canInspectServer) {
      const stats = await requestJson(`${base}/__stats`)
      const dialed = (stats.handshakes || []).filter(item => String(item.url || '').indexOf(tag) !== -1)
      if (dialed.length !== 0 || stats.openCount !== 0) {
        throw new Error(`a non-ASCII header value must be rejected before dialing; the server saw ${stats.openCount} handshake(s)`)
      }
    }
    if (errored) {
      throw new Error('a connect rejected before dialing must not also fire an error event')
    }
    return `rejected in ${elapsed}ms, before dialing, errMsg: ${out.failRes.errMsg}`
  },

  // 服务端回两个同名响应头时，open 载荷里该键的值按 RFC 7230 §3.2.2 逗号拼接。
  // 三端原来一个取第一个、一个取最后一个、一个拼接，业务拿到的 header 三端不同。
  // 键名大小写各端可能不一致，契约没规定，所以键按不区分大小写找，只把「值」钉死。
  // 需要回显服务端在 `?dupHeader=1` 时对同一个响应头名下发两行（如两行 X-Dimina-Dup）。
  async caseDuplicateResponseHeader(url) {
    const tag = 's13-dup'
    const task = connect({ url: `${url}?tag=${tag}&dupHeader=1` })
    const openRes = await waitOpen(task)
    const closed = waitClose(task)
    task.close({ complete: noop })
    await closed
    const header = openRes.header || {}
    let value = null
    for (const key of Object.keys(header)) {
      if (key.toLowerCase() === 'x-dimina-dup') {
        value = header[key]
        break
      }
    }
    const platform = this.platformKind()
    if (platform === 'web') {
      if (Object.keys(header).length !== 0) {
        throw new Error(`the browser open.header must be empty, got ${JSON.stringify(header)}`)
      }
      return 'browser exposed no handshake response headers'
    }
    if (platform === 'harmony') {
      if (value !== 'first') throw new Error(`HarmonyOS must expose the first duplicate value, got ${JSON.stringify(value)}`)
      return 'HarmonyOS exposed the first duplicate response header value'
    }
    if (value === null) {
      throw new Error('open header is missing the duplicated response header key; the echo server must answer ?dupHeader=1 with two X-Dimina-Dup lines')
    }
    const parts = String(value).split(',').map(item => item.trim())
    if (parts.join('|') !== 'first|second') {
      throw new Error(`duplicate response headers must be comma-joined in order per RFC 7230 3.2.2, expected first then second, got "${value}"`)
    }
    return `duplicate response header joined as "${value}"`
  },

})
