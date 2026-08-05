// dimina 原生 WebSocket 端到端冒烟测试页
// 用法：在设备/模拟器上打开本页，按需修改 wsUrl（Android 模拟器默认 10.0.2.2，iOS/HarmonyOS 模拟器一般用本机局域网 IP 或 localhost），
// 点击"运行全部用例"。结果直接渲染在页面上，无需看控制台。

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function waitOpen(task, ms = 5000) {
  return withTimeout(new Promise((resolve, reject) => {
    task.onOpen((res) => resolve(res))
    task.onError((res) => reject(new Error(res.errMsg || 'connect error')))
  }), ms, 'waitOpen')
}

function waitMessage(task, ms = 5000) {
  return withTimeout(new Promise((resolve) => {
    task.onMessage((res) => resolve(res))
  }), ms, 'waitMessage')
}

function waitClose(task, ms = 5000) {
  return withTimeout(new Promise((resolve) => {
    task.onClose((res) => resolve(res))
  }), ms, 'waitClose')
}

function waitError(task, ms = 5000) {
  return withTimeout(new Promise((resolve) => {
    task.onError((res) => resolve(res))
  }), ms, 'waitError')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

// 本页创建过的所有 SocketTask。用例失败时往往还留着没关的连接，名额只有 5 个，
// 不确认它们真的进了终态就开下一条，后面会连锁误报。
const openedTasks = []

// 所有用例都用它建连接，好让清场能逐个确认终态。
function connect(opts = {}) {
  // SocketTask 没有 readyState（微信也没有），所以名额是否已经释放只能靠终态事件判断。
  const tracked = { terminal: false }
  const markTerminal = () => {
    tracked.terminal = true
  }
  const { fail, ...rest } = opts
  const task = wx.connectSocket({
    ...rest,
    // 连接被直接拒绝（超并发上限、URL 不合法）时不会再有 error/close 事件，名额也
    // 从没占上，直接记成终态，否则 resetOwnerState 会一直等到超时。
    fail: (res) => {
      markTerminal()
      if (typeof fail === 'function') {
        fail(res)
      }
    },
  })
  task.onClose(markTerminal)
  task.onError(markTerminal)
  openedTasks.push(tracked)
  return task
}

// 吃掉同步 throw 和异步 reject 两种失败：这些接口在没有存活连接时会以 fail 拒绝，
// 不接住就变成未处理的 rejection。
function quiet(fn) {
  return Promise.resolve().then(fn).catch(() => {})
}

async function resetOwnerState() {
  await quiet(() => wx.closeSocket({ code: 1000, reason: 'reset' }))
  for (const off of [wx.offSocketOpen, wx.offSocketMessage, wx.offSocketError, wx.offSocketClose]) {
    // eslint-disable-next-line no-await-in-loop
    await quiet(() => off())
  }
  // closeSocket 的 success 只代表关闭被受理，条目要等传输层确认关闭才从并发名额里
  // 释放。所以逐个盯每条连接的终态事件，而不是拍一个固定延时。
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !openedTasks.every(entry => entry.terminal)) {
    // eslint-disable-next-line no-await-in-loop
    await delay(100)
  }
  // 超时还没全进终态就必须报出来。静默清空追踪数组继续往下跑的话，名额还占着，
  // 后面每条都会误报，报告就没法看了。
  if (!openedTasks.every(entry => entry.terminal)) {
    const pending = openedTasks.filter(entry => !entry.terminal).length
    openedTasks.length = 0
    throw new Error(`socket cleanup timed out, ${pending} socket(s) never reached a terminal event`)
  }
  openedTasks.length = 0
  // 原生把条目移出 owner 与 JS 收到 close 事件是两条消息，留一点余量。
  await delay(200)
}

Page({
  data: {
    wsUrl: 'ws://10.0.2.2:8955',
    running: false,
    results: [],
    summaryText: '尚未运行',
    summaryClass: 'idle',
  },

  onLoad(options) {
    if (options && options.wsUrl) {
      this.setData({ wsUrl: decodeURIComponent(options.wsUrl) })
    }
    // 带上 autorun=1 打开本页就自动开跑，不用点按钮。模拟器上没法可靠地
    // 模拟点击时（比如 iOS 模拟器受 macOS 权限限制），靠它把这套用例跑完。
    if (options && options.autorun) {
      this.runTests()
    }
  },

  onUrlInput(e) {
    this.setData({ wsUrl: e.detail.value })
  },

  pushResult(name, ok, detail) {
    const results = this.data.results.concat([{ name, ok, detail: detail || '' }])
    this.setData({ results })
    console.log(`[socket-test] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
  },

  async runTests() {
    this.setData({ running: true, results: [], summaryText: '运行中...', summaryClass: 'idle' })
    openedTasks.length = 0
    const url = this.data.wsUrl
    const cases = [
      ['basic connect + open header', () => this.caseBasicOpen(url)],
      ['send/receive text echo', () => this.caseTextEcho(url)],
      ['two tasks stay isolated', () => this.caseTwoTaskIsolation(url)],
      ['max 5 concurrent connections per owner', () => this.caseMaxConcurrency(url)],
      ['slot is released after terminal close', () => this.caseSlotReuse(url)],
      ['close code 1000 accepted', () => this.caseCloseAccepted(url, 1000)],
      ['close code 3000 accepted (lower boundary)', () => this.caseCloseAccepted(url, 3000)],
      ['close code 4999 accepted (upper boundary)', () => this.caseCloseAccepted(url, 4999)],
      ['close code 5000 rejected, connection survives', () => this.caseCloseRejected(url, 5000)],
      ['close during CONNECTING -> exactly one close, no error', () => this.caseCloseDuringConnecting(url)],
      ['connect to unreachable host -> error only, no close', () => this.caseUnreachableHost()],
      ['requested connect timeout outlives the platform default', () => this.caseLongConnectTimeout()],
      ['close code NaN rejected, connection survives', () => this.caseCloseRejected(url, Number.NaN)],
      ['connection refused -> error still reaches a listener attached right after connect', () => this.caseRefusedConnection()],
      ['invalid send data rejected, connection survives', () => this.caseInvalidSend(url)],
      ['send after close is rejected', () => this.caseSendAfterClose(url)],
      ['connectSocket: success then complete, each once', () => this.caseConnectCallbacks(url)],
      ['connectSocket: fail then complete, each once', () => this.caseConnectFailCallbacks(url)],
      ['send: success then complete, each once', () => this.caseSendCallbacks(url)],
      ['close: success then complete, each once', () => this.caseCloseCallbacks(url)],
      ['offMessage removes only the given listener', () => this.caseTaskOffMessage(url)],
      ['legacy wx.onSocketMessage binds to first connection', () => this.caseLegacyBinding(url)],
      ['legacy full lifecycle: open/message/close events', () => this.caseLegacyLifecycle(url)],
      ['legacy offSocketMessage stops delivery', () => this.caseLegacyOffMessage(url)],
      ['legacy: two listeners on one event both fire, off removes only one', () => this.caseLegacyMultipleListeners(url)],
      ['close code accepts the string form "3000"', () => this.caseCloseCodeAsString(url, '3000')],
      ['close code accepts the hex string form "0xBB8"', () => this.caseCloseCodeAsString(url, '0xBB8')],
      ['illegal header name is rejected before dialing', () => this.caseInvalidHeaderName(url)],
      ['legacy wx.closeSocket sweeps every connection', () => this.caseLegacyCloseSweep(url)],
      ['legacy wx.onSocketError fires on failure', () => this.caseLegacyError()],
    ]

    let passCount = 0
    let aborted = false
    try {
      for (const [name, fn] of cases) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const detail = await fn()
          this.pushResult(name, true, detail)
          passCount++
          continue
        }
        catch (e) {
          this.pushResult(name, false, e.message || String(e))
        }
        // 失败的用例往往还留着没关的连接和全局监听。名额只有 5 个，不清掉的话
        // 后面每条都会被拖垮，报告就变成一串多米诺而不是各自独立的结论。
        // 通过的用例自己会收尾，不用再走一遍。
        try {
          // eslint-disable-next-line no-await-in-loop
          await resetOwnerState()
        }
        catch (cleanupError) {
          // 清场都没清干净，后面的结果没有参考价值，直接停在这里。
          this.pushResult('cleanup after failure', false, cleanupError.message || String(cleanupError))
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

  async caseBasicOpen(url) {
    const task = connect({ url })
    const openRes = await waitOpen(task)
    const closePromise = waitClose(task)
    task.close({})
    // Slot is only freed at terminal state, so wait for the
    // close handshake to fully complete before the next case starts, or it'll eat into that case's
    // max-5-concurrent budget.
    await closePromise
    if (typeof openRes.header !== 'object') {
      throw new Error('open event missing header object')
    }
    return 'open event received with header'
  },

  async caseTextEcho(url) {
    const task = connect({ url: `${url}?tag=echo-test` })
    await waitOpen(task)
    const msgPromise = waitMessage(task)
    const payload = `hello-${Date.now()}`
    task.send({ data: payload })
    const msg = await msgPromise
    const closePromise = waitClose(task)
    task.close({})
    await closePromise
    // 要求完全相等：用 indexOf 的话，回显被加了前后缀也会算通过。
    if (msg.data !== payload) {
      throw new Error(`echo mismatch, expected ${payload}, got: ${msg.data}`)
    }
    return `server echoed: ${msg.data}`
  },

  async caseMaxConcurrency(url) {
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=conc-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      let sixthFailed = false
      let sixthMsg = ''
      await new Promise((resolve) => {
        const sixth = connect({
          url: `${url}?tag=conc-5`,
          fail: (res) => {
            sixthFailed = true
            sixthMsg = res.errMsg || ''
            resolve()
          },
        })
        sixth.onOpen(() => resolve())
        setTimeout(resolve, 3000)
      })
      if (!sixthFailed) {
        throw new Error('6th connection was not rejected')
      }
      // 断言完整错误文案。只查有没有 "5" 的话，任何带数字的报错都能蒙混过去。
      const expected = 'reach max websocket connect count 5'
      if (sixthMsg.indexOf(expected) === -1) {
        throw new Error(`expected "${expected}", got: ${sixthMsg}`)
      }
      return `6th connection correctly rejected: ${sixthMsg}`
    }
    finally {
      // Await each close's terminal state (not just the fire-and-forget close() call) so this
      // case doesn't leave CLOSING-state sockets that eat into the next case's max-5 budget
      // (slot frees only at terminal state).
      await Promise.all(tasks.map((t) => {
        const p = waitClose(t)
        t.close({})
        return p.catch(() => {})
      }))
    }
  },

  // 关闭码被接受时，close 事件要原样带回请求的 code 和 reason，而且只能来一次。
  // 只看 close() 的 success 回调是不够的，code/reason 在路上被改掉也发现不了。
  async caseCloseAccepted(url, code) {
    const task = connect({ url: `${url}?tag=close-${code}` })
    await waitOpen(task)
    const reason = `bye-${code}-收尾`
    let closeCount = 0
    let closeRes = null
    const closeSeen = new Promise((resolve) => {
      task.onClose((res) => {
        closeCount++
        closeRes = res
        resolve(res)
      })
    })
    let accepted = false
    let failMsg = ''
    await new Promise((resolve) => {
      task.close({
        code,
        reason,
        success: () => { accepted = true; resolve() },
        fail: (res) => { failMsg = res.errMsg || ''; resolve() },
      })
      setTimeout(resolve, 3000)
    })
    if (!accepted) {
      throw new Error(`close(${code}) was not accepted: ${failMsg}`)
    }
    await withTimeout(closeSeen, 5000, `close event for ${code}`)
    // 多等一会，确认没有第二个 close 事件跟上来。
    await delay(300)
    if (closeCount !== 1) {
      throw new Error(`expected exactly one close event, got ${closeCount}`)
    }
    if (closeRes.code !== code) {
      throw new Error(`close event code mismatch, expected ${code}, got ${closeRes.code}`)
    }
    if (closeRes.reason !== reason) {
      throw new Error(`close event reason mismatch, expected "${reason}", got "${closeRes.reason}"`)
    }
    return `close ${code} echoed back with reason intact`
  },

  // 非法关闭码要被拒，而且拒绝不能顺手把连接弄坏——之后还得能正常收发。
  async caseCloseRejected(url, code) {
    const task = connect({ url: `${url}?tag=close-${code}` })
    await waitOpen(task)
    const seq = []
    await new Promise((resolve) => {
      task.close({
        code,
        success: () => { seq.push('success'); resolve() },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 3000)
    })
    if (seq.indexOf('success') !== -1) {
      throw new Error(`close(${code}) should not succeed, got: ${JSON.stringify(seq)}`)
    }
    let failEntry = ''
    for (const item of seq) {
      if (item.indexOf('fail:') === 0) {
        failEntry = item
      }
    }
    // 必须真的收到 fail。原来只断言 accepted 为 false，两个回调都不触发时也会"通过"。
    if (!failEntry) {
      throw new Error(`close(${code}) did not report fail, got: ${JSON.stringify(seq)}`)
    }
    const probe = `still-alive-${Date.now()}`
    const msgPromise = waitMessage(task)
    task.send({ data: probe })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`connection unusable after rejected close, got: ${msg.data}`)
    }
    const cleanup = waitClose(task)
    task.close({ code: 1000 })
    await cleanup
    return `close ${code} rejected, connection still usable`
  },

  async caseCloseDuringConnecting(url) {
    const task = connect({ url: `${url}?tag=connecting-close` })
    let gotError = false
    const closes = []
    task.onError(() => { gotError = true })
    // 数出到底来了几个 close 事件。原来只 await 第一个，用例名写着"exactly one"
    // 却根本没验证这一点。
    const closeSeen = new Promise((resolve) => {
      task.onClose((res) => {
        closes.push(res)
        resolve(res)
      })
    })
    task.close({ code: 1000, reason: 'cancel-while-connecting' })
    const closeRes = await withTimeout(closeSeen, 5000, 'close during CONNECTING')
    await delay(500)
    if (gotError) {
      throw new Error('unexpected error event alongside close during CONNECTING')
    }
    if (closes.length !== 1) {
      throw new Error(`expected exactly one close event, got ${closes.length}`)
    }
    if (closeRes.code !== 1000) {
      throw new Error(`expected requested close code 1000, got ${closeRes.code}`)
    }
    return 'exactly one close, no error, code matches request'
  },

  async caseUnreachableHost() {
    const task = connect({ url: 'ws://192.0.2.1:9', timeout: 3000 })
    let gotClose = false
    task.onClose(() => { gotClose = true })
    const errRes = await waitError(task, 6000)
    await delay(200)
    if (gotClose) {
      throw new Error('unexpected close event for a connection that never opened')
    }
    if (!errRes.errMsg) {
      throw new Error('error event missing errMsg')
    }
    return `error only, errMsg: ${errRes.errMsg}`
  },

  // 连接超时不只由容器自己的定时器驱动，还要交给平台传输层：Android 的 OkHttp 默认
  // 连接超时 10 秒，iOS 的 URLRequest 默认 60 秒，不跟着请求值走的话，调用方要求的
  // 更长超时会被平台先掐断。打一个黑洞地址（RFC 5737 的测试网段，不会回 RST，只能等
  // 超时），要求 15 秒，断言 error 确实是 12 秒之后才来的。
  async caseLongConnectTimeout() {
    const timeout = 15000
    const startedAt = Date.now()
    const task = connect({ url: 'ws://192.0.2.1:9', timeout })
    const errRes = await waitError(task, timeout + 6000)
    const elapsed = Date.now() - startedAt
    if (!errRes.errMsg) {
      throw new Error('error event missing errMsg')
    }
    if (elapsed < 12000) {
      throw new Error(`failed after ${elapsed}ms, the requested ${timeout}ms timeout was cut short by the platform default`)
    }
    return `failed after ${elapsed}ms, errMsg: ${errRes.errMsg}`
  },

  // 连一个本机没人监听的端口，TCP 会立刻被拒。原生随后就派发 error 并删掉连接条目，
  // 而调用方的 onError 是紧跟在 connectSocket 之后的另一条桥消息——这一条盯的就是
  // 「注册消息比事件晚到时，error 会不会被永久丢掉」。同 open 事件那个竞态同源。
  // 这个窗口只有一两毫秒，跑一次经常撞不上，所以连跑多轮。
  async caseRefusedConnection() {
    const rounds = 5
    const seen = []
    for (let i = 0; i < rounds; i++) {
      const task = connect({ url: 'ws://127.0.0.1:1', timeout: 3000 })
      // eslint-disable-next-line no-await-in-loop
      const errRes = await waitError(task, 6000).catch(e => ({ errMsg: '', failure: e.message || String(e) }))
      if (errRes.failure) {
        throw new Error(`round ${i + 1}/${rounds}: ${errRes.failure}`)
      }
      if (!errRes.errMsg) {
        throw new Error(`round ${i + 1}/${rounds}: error event missing errMsg`)
      }
      seen.push(errRes.errMsg)
    }
    return `${rounds} refused connections all reported: ${seen[0]}`
  },

  async caseLegacyBinding(url) {
    const taskA = connect({ url: `${url}?tag=legacy-A` })
    await waitOpen(taskA)
    const taskB = connect({ url: `${url}?tag=legacy-B` })
    await waitOpen(taskB)

    // echo server 只会原样回发送的内容，判断不出消息来自哪条连接，
    // 所以让 A、B 各自记录收到了什么，靠"谁收到"来验证 legacy API 绑的是 A。
    let aGot = null
    let bGot = null
    taskA.onMessage((res) => { aGot = res.data })
    taskB.onMessage((res) => { bGot = res.data })

    // 具名监听，用完摘掉；匿名的话会一直挂在全局注册表里漏到后面的用例。
    let legacyListener = null
    const legacyMsgPromise = new Promise((resolve) => {
      legacyListener = (res) => resolve(res)
      wx.onSocketMessage(legacyListener)
    })
    const payload = `legacy-ping-${Date.now()}`
    wx.sendSocketMessage({ data: payload })
    const res = await withTimeout(legacyMsgPromise, 5000, 'legacy onSocketMessage')
    const closeAPromise = waitClose(taskA)
    const closeBPromise = waitClose(taskB)
    taskA.close({})
    taskB.close({})
    await Promise.all([closeAPromise, closeBPromise])
    wx.offSocketMessage(legacyListener)
    if (res.data !== payload) {
      throw new Error(`legacy onSocketMessage got unexpected payload: ${res.data}`)
    }
    if (aGot !== payload) {
      throw new Error(`first connection (A) did not receive the legacy message, got: ${aGot}`)
    }
    if (bGot !== null) {
      throw new Error(`second connection (B) should not receive the legacy message, got: ${bGot}`)
    }
    return 'legacy API correctly targeted first connection'
  },

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
    taskA.send({ data: payloadA })
    taskB.send({ data: payloadB })
    await delay(1500)

    if (aGot.length !== 1 || aGot[0] !== payloadA) {
      throw new Error(`A should receive only its own payload, got: ${JSON.stringify(aGot)}`)
    }
    if (bGot.length !== 1 || bGot[0] !== payloadB) {
      throw new Error(`B should receive only its own payload, got: ${JSON.stringify(bGot)}`)
    }

    // 关掉 B 之后 A 必须还活着，用一次真实往返来证明，而不是只看没报错。
    const closeB = waitClose(taskB)
    taskB.close({})
    await closeB
    const probe = `iso-a-again-${Date.now()}`
    const probePromise = waitMessage(taskA)
    taskA.send({ data: probe })
    const probeMsg = await probePromise
    if (probeMsg.data !== probe) {
      throw new Error(`A broke after closing B, got: ${probeMsg.data}`)
    }
    const closeA = waitClose(taskA)
    taskA.close({})
    await closeA
    return 'two tasks routed independently'
  },

  // 占满 5 个名额后关掉一个，名额必须立刻能被新连接用上。
  // 这同时证明被拒绝的那次尝试没有偷偷占掉一个名额。
  async caseSlotReuse(url) {
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=slot-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      let rejected = false
      await new Promise((resolve) => {
        connect({
          url: `${url}?tag=slot-overflow`,
          fail: () => { rejected = true; resolve() },
        })
        setTimeout(resolve, 3000)
      })
      if (!rejected) {
        throw new Error('6th connection was not rejected, cannot test slot reuse')
      }
      const victim = tasks.pop()
      const victimClosed = waitClose(victim)
      victim.close({})
      await victimClosed
      const replacement = connect({ url: `${url}?tag=slot-replacement` })
      await waitOpen(replacement)
      tasks.push(replacement)
      return 'slot freed by close was immediately reusable'
    }
    finally {
      for (const t of tasks) {
        const p = waitClose(t)
        t.close({})
        // eslint-disable-next-line no-await-in-loop
        await p.catch(() => {})
      }
    }
  },

  // 非法的 data 要被拒，而且不能把连接搞坏。
  async caseInvalidSend(url) {
    const task = connect({ url: `${url}?tag=bad-send` })
    await waitOpen(task)
    const seq = []
    await new Promise((resolve) => {
      task.send({
        data: 123,
        success: () => { seq.push('success'); resolve() },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 3000)
    })
    assertCallbackSeq(seq, 'fail')
    const probe = `after-bad-send-${Date.now()}`
    const msgPromise = waitMessage(task)
    task.send({ data: probe })
    const msg = await msgPromise
    if (msg.data !== probe) {
      throw new Error(`connection unusable after rejected send, got: ${msg.data}`)
    }
    const closePromise = waitClose(task)
    task.close({})
    await closePromise
    return 'invalid send rejected, connection still usable'
  },

  async caseSendAfterClose(url) {
    const task = connect({ url: `${url}?tag=send-after-close` })
    await waitOpen(task)
    const closePromise = waitClose(task)
    task.close({})
    await closePromise
    const seq = []
    await new Promise((resolve) => {
      task.send({
        data: 'should-not-go-out',
        success: () => { seq.push('success'); resolve() },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 3000)
    })
    assertCallbackSeq(seq, 'fail')
    return 'send on a closed socket rejected'
  },

  // 下面这组盯的是 success / fail / complete 这三个回调本身。
  // 这条链路真的断过：shared/jssdk 是被 git 跟踪的构建产物，源码给 invokeAPI 补了
  // "非函数值原样透传" 的分支，产物却没跟着重新生成，设备上跑的旧产物会把已经登记成
  // 编号的 fail / complete 直接丢掉。事件监听走的是另一条路，测不出这个问题。
  async caseConnectCallbacks(url) {
    const seq = []
    let task = null
    await new Promise((resolve) => {
      task = connect({
        url: `${url}?tag=cb-ok`,
        success: () => { seq.push('success') },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 4000)
    })
    // 等真正连上，避免只验证了"请求被受理"就收工。
    await waitOpen(task)
    const closePromise = waitClose(task)
    task.close({})
    await closePromise
    assertCallbackSeq(seq, 'success')
    return 'success then complete, each exactly once'
  },

  async caseConnectFailCallbacks(url) {
    // 先占满 5 个名额，让第 6 个必定被原生拒绝，借此走一遍失败路径。
    const tasks = []
    try {
      for (let i = 0; i < 5; i++) {
        const t = connect({ url: `${url}?tag=cbfail-${i}` })
        // eslint-disable-next-line no-await-in-loop
        await waitOpen(t)
        tasks.push(t)
      }
      const seq = []
      await new Promise((resolve) => {
        connect({
          url: `${url}?tag=cbfail-5`,
          success: () => { seq.push('success') },
          fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
          complete: () => { seq.push('complete'); resolve() },
        })
        setTimeout(resolve, 4000)
      })
      assertCallbackSeq(seq, 'fail')
      return 'fail then complete, each exactly once'
    }
    finally {
      for (const t of tasks) {
        const p = waitClose(t)
        t.close({})
        // eslint-disable-next-line no-await-in-loop
        await p.catch(() => {})
      }
    }
  },

  async caseSendCallbacks(url) {
    const task = connect({ url: `${url}?tag=send-cb` })
    await waitOpen(task)
    const seq = []
    const payload = `cb-probe-${Date.now()}`
    const msgPromise = waitMessage(task)
    await new Promise((resolve) => {
      task.send({
        data: payload,
        success: () => { seq.push('success') },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 4000)
    })
    // 除了回调，还要收到这条消息的回显，证明它确实发出去了。
    const msg = await msgPromise
    if (msg.data !== payload) {
      throw new Error(`echo mismatch, expected ${payload}, got: ${msg.data}`)
    }
    const closePromise = waitClose(task)
    task.close({})
    await closePromise
    assertCallbackSeq(seq, 'success')
    return 'success then complete, each exactly once'
  },

  async caseCloseCallbacks(url) {
    const task = connect({ url: `${url}?tag=close-cb` })
    await waitOpen(task)
    const seq = []
    const closePromise = waitClose(task)
    await new Promise((resolve) => {
      task.close({
        code: 1000,
        success: () => { seq.push('success') },
        fail: (res) => { seq.push(`fail:${res.errMsg || ''}`) },
        complete: () => { seq.push('complete'); resolve() },
      })
      setTimeout(resolve, 4000)
    })
    // 这里以前写的是 .catch(() => {})，close 事件没来也会被吞掉，等于白测。
    await closePromise
    assertCallbackSeq(seq, 'success')
    return 'success then complete, each exactly once'
  },

  // offMessage 只能摘掉传进去的那一个监听，不能顺手清空全部。
  // 留下的那个监听同时充当正向信号，证明第二条消息真的送达了——
  // 只断言"被移除的没收到"的话，发送整体坏掉也会算通过。
  async caseTaskOffMessage(url) {
    const task = connect({ url: `${url}?tag=off-msg` })
    await waitOpen(task)
    const removedGot = []
    const keptGot = []
    const removed = (res) => { removedGot.push(res.data) }
    const kept = (res) => { keptGot.push(res.data) }
    task.onMessage(removed)
    task.onMessage(kept)

    const first = `before-off-${Date.now()}`
    task.send({ data: first })
    await delay(1500)
    if (removedGot.indexOf(first) === -1 || keptGot.indexOf(first) === -1) {
      throw new Error(`both listeners should get the first message, removed=${JSON.stringify(removedGot)} kept=${JSON.stringify(keptGot)}`)
    }

    task.offMessage(removed)
    const second = `after-off-${Date.now()}`
    task.send({ data: second })
    await delay(1500)
    const closePromise = waitClose(task)
    task.close({})
    await closePromise

    if (keptGot.indexOf(second) === -1) {
      throw new Error(`the kept listener should still receive, got: ${JSON.stringify(keptGot)}`)
    }
    if (removedGot.indexOf(second) !== -1) {
      throw new Error(`the removed listener still fired, got: ${JSON.stringify(removedGot)}`)
    }
    return 'offMessage removed only the given listener'
  },

  async caseLegacyLifecycle(url) {
    // 全局 API 完整走一遍：连接、收发、关闭三类事件都要到。
    let openFired = false
    const msgSeen = []
    // close 必须用全局的 wx.onSocketClose 收，不能拿任务侧的 close 当证据——
    // 那样 wx.onSocketClose 整个坏掉这条用例也照样通过。
    const closeSeen = []
    const onOpen = () => { openFired = true }
    const onMessage = (res) => { msgSeen.push(res.data) }
    const onClose = (res) => { closeSeen.push(res) }
    wx.onSocketOpen(onOpen)
    wx.onSocketMessage(onMessage)
    wx.onSocketClose(onClose)

    const task = connect({ url: `${url}?tag=legacy-life` })
    await waitOpen(task)
    const payload = `legacy-life-${Date.now()}`
    // 等的是任务侧的真实 close 事件，不再用固定延时糊过去。
    const closePromise = waitClose(task)
    wx.sendSocketMessage({ data: payload })
    await delay(1500)
    wx.closeSocket({ code: 3001, reason: 'legacy-bye' })
    await closePromise
    await delay(200)

    // 监听器用完摘干净，否则会漏到后面的用例里去。
    wx.offSocketOpen(onOpen)
    wx.offSocketMessage(onMessage)
    wx.offSocketClose(onClose)

    if (!openFired) {
      throw new Error('wx.onSocketOpen never fired')
    }
    if (msgSeen.indexOf(payload) === -1) {
      throw new Error(`legacy message mismatch, got: ${JSON.stringify(msgSeen)}`)
    }
    if (closeSeen.length !== 1) {
      throw new Error(`wx.onSocketClose should fire exactly once, got ${closeSeen.length}`)
    }
    if (closeSeen[0].code !== 3001 || closeSeen[0].reason !== 'legacy-bye') {
      throw new Error(`legacy close payload mismatch, got: ${JSON.stringify(closeSeen[0])}`)
    }
    return 'legacy open/message/close all fired with the requested code/reason'
  },

  async caseLegacyOffMessage(url) {
    const task = connect({ url: `${url}?tag=legacy-off` })
    await waitOpen(task)
    const removedGot = []
    const taskGot = []
    const removed = (res) => { removedGot.push(res.data) }
    wx.onSocketMessage(removed)
    // 任务侧的监听不受 offSocketMessage 影响，拿它当正向信号：
    // 只断言"全局监听没收到"的话，发送整体坏掉也会算通过。
    task.onMessage((res) => { taskGot.push(res.data) })

    const first = `legacy-before-off-${Date.now()}`
    wx.sendSocketMessage({ data: first })
    await delay(1500)
    if (removedGot.indexOf(first) === -1) {
      throw new Error(`legacy listener never received the first message, got: ${JSON.stringify(removedGot)}`)
    }

    wx.offSocketMessage(removed)
    const second = `legacy-after-off-${Date.now()}`
    wx.sendSocketMessage({ data: second })
    await delay(1500)
    const closePromise = waitClose(task)
    task.close({})
    await closePromise

    if (taskGot.indexOf(second) === -1) {
      throw new Error(`the second message never arrived at all, got: ${JSON.stringify(taskGot)}`)
    }
    if (removedGot.indexOf(second) !== -1) {
      throw new Error(`legacy listener still fired after offSocketMessage, got: ${JSON.stringify(removedGot)}`)
    }
    return 'offSocketMessage stopped delivery'
  },

  // 脚本层每个全局监听各存一个 callback id、各发一次 onSocketMessage。原生如果一个事件只留
  // 一个 id，先注册的那个会被后注册的顶掉；带 id 的 offSocketMessage 如果实现成无条件清空，
  // 摘掉一个会把另一个也带走。这条用例把这两种情况都卡住。
  async caseLegacyMultipleListeners(url) {
    const task = connect({ url: `${url}?tag=legacy-multi` })
    await waitOpen(task)
    const firstGot = []
    const secondGot = []
    const first = (res) => { firstGot.push(res.data) }
    const second = (res) => { secondGot.push(res.data) }
    wx.onSocketMessage(first)
    wx.onSocketMessage(second)

    const both = `legacy-multi-both-${Date.now()}`
    wx.sendSocketMessage({ data: both })
    await delay(1500)
    if (firstGot.indexOf(both) === -1) {
      throw new Error(`the first listener never fired, got: ${JSON.stringify(firstGot)}`)
    }
    if (secondGot.indexOf(both) === -1) {
      throw new Error(`the second listener never fired, got: ${JSON.stringify(secondGot)}`)
    }

    // 摘掉后注册的那个。摘先注册的话，单槽位实现里它早就被顶掉了，测不出 off 的问题。
    wx.offSocketMessage(second)
    const onlyFirst = `legacy-multi-first-${Date.now()}`
    wx.sendSocketMessage({ data: onlyFirst })
    await delay(1500)

    wx.offSocketMessage(first)
    const closePromise = waitClose(task)
    task.close({})
    await closePromise

    if (firstGot.indexOf(onlyFirst) === -1) {
      throw new Error(`the surviving listener stopped receiving, got: ${JSON.stringify(firstGot)}`)
    }
    if (secondGot.indexOf(onlyFirst) !== -1) {
      throw new Error(`the removed listener still fired, got: ${JSON.stringify(secondGot)}`)
    }
    return 'both listeners fired; off removed exactly one'
  },

  // code 走桥时是 JSON 里的一个值，调用方写成字符串是常见笔误。脚本层按 JavaScript
  // Number() 转换后再下发，和浏览器 WebSocket.close() 的行为一致。
  async caseCloseCodeAsString(url, code) {
    const task = connect({ url: `${url}?tag=code-${code}` })
    await waitOpen(task)
    const closePromise = waitClose(task)
    const settled = []
    task.close({
      code,
      success: () => { settled.push('success') },
      fail: (res) => { settled.push(`fail:${res && res.errMsg}`) },
    })
    const closeEvent = await closePromise
    if (settled.indexOf('success') === -1) {
      throw new Error(`close with code "${code}" was not accepted, settled: ${JSON.stringify(settled)}`)
    }
    if (closeEvent.code !== 3000) {
      throw new Error(`close event carried code ${closeEvent.code}, expected 3000`)
    }
    return `string code "${code}" accepted and closed with 3000`
  },

  // 字段名带冒号这种 header 过不了 HTTP 的 token 规则。校验放行的话，连接会先报 success，
  // 底层构造请求时才失败，调用方要等满连接超时才知道——所以必须在拨号之前就拒绝。
  async caseInvalidHeaderName(url) {
    const settled = []
    const startedAt = Date.now()
    const task = connect({
      url: `${url}?tag=bad-header`,
      header: { 'Bad:Name': 'x' },
      timeout: 30000,
      success: () => { settled.push('success') },
      fail: (res) => { settled.push(`fail:${(res && res.errMsg) || ''}`) },
    })
    let errored = false
    task.onError(() => { errored = true })
    await delay(2000)

    const failure = settled.filter(item => item.indexOf('fail:') === 0)[0]
    if (!failure) {
      throw new Error(`an illegal header name must be rejected, settled: ${JSON.stringify(settled)}`)
    }
    if (failure.indexOf('invalid header') === -1) {
      throw new Error(`expected an "invalid header" failure, got: ${failure}`)
    }
    if (errored) {
      throw new Error('a rejected connect must not also fire an error event')
    }
    // 只要不是等到 timeout 才报错就算达标；这里的余量远小于 30s 的连接超时。
    if (Date.now() - startedAt > 10000) {
      throw new Error('the rejection arrived far too late; it likely waited for the connect timeout')
    }
    return failure
  },

  // wx.closeSocket 只带 socketId 之外的参数时，绑定的第一条连接用请求的 code/reason 关，
  // 其余连接会被一并扫掉（默认 1000）。这个多连接行为容易漏，也最容易泄漏名额。
  async caseLegacyCloseSweep(url) {
    const taskA = connect({ url: `${url}?tag=sweep-A` })
    await waitOpen(taskA)
    const taskB = connect({ url: `${url}?tag=sweep-B` })
    await waitOpen(taskB)

    const aCloses = []
    const bCloses = []
    taskA.onClose((res) => { aCloses.push(res) })
    taskB.onClose((res) => { bCloses.push(res) })

    const reason = 'sweep-all'
    wx.closeSocket({ code: 3000, reason })
    await delay(2500)

    if (aCloses.length !== 1) {
      throw new Error(`A should close exactly once, got ${aCloses.length}`)
    }
    if (bCloses.length !== 1) {
      throw new Error(`B should close exactly once, got ${bCloses.length}`)
    }
    if (aCloses[0].code !== 3000 || aCloses[0].reason !== reason) {
      throw new Error(`A should use the requested code/reason, got ${aCloses[0].code}/${aCloses[0].reason}`)
    }
    // 被顺带清扫的 B 必须用默认的 1000/""，不能跟着 A 用请求里的 code/reason。
    // 不断言这一条的话，某端把 A 的参数原样套到 B 上也照样算通过。
    if (bCloses[0].code !== 1000 || bCloses[0].reason !== '') {
      throw new Error(`B should be swept with the default 1000/"", got ${bCloses[0].code}/${bCloses[0].reason}`)
    }
    return `A closed with 3000/${reason}, B swept with default 1000`
  },

  // wx.onSocketError / offSocketError 之前完全没有覆盖。
  async caseLegacyError() {
    const errors = []
    const onError = (res) => { errors.push(res.errMsg || '') }
    wx.onSocketError(onError)
    const task = connect({ url: 'ws://192.0.2.1:9', timeout: 3000 })
    let gotClose = false
    task.onClose(() => { gotClose = true })
    await waitError(task, 6000)
    await delay(500)
    wx.offSocketError(onError)
    if (errors.length === 0) {
      throw new Error('wx.onSocketError never fired')
    }
    if (!errors[0]) {
      throw new Error('legacy error event missing errMsg')
    }
    if (gotClose) {
      throw new Error('unexpected close event for a connection that never opened')
    }
    return `legacy error fired: ${errors[0]}`
  },
})
