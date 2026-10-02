const ASSETS = '/pages/libpag/assets/'
let pagPromise

function initPAG() {
  if (!pagPromise) {
    const { PAGInit } = require('libpag-miniprogram')
    pagPromise = PAGInit({ locateFile: name => ASSETS + name }).catch(error => {
      pagPromise = null
      throw error
    })
  }
  return pagPromise
}

function read(name) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({ filePath: ASSETS + name, success: res => resolve(res.data), fail: reject })
  })
}

async function dispose(view, file) {
  try {
    if (view) await view.destroy()
  } finally {
    if (file) file.destroy()
  }
}

Page({
  data: {
    supported: false, ready: false, busy: false, playing: false, progress: 0,
    status: '等待验证', capability: '', assetLabel: '等待加载', results: []
  },

  onLoad() {
    this.alive = true
    this.visible = true
    this.results = []
    const supported = typeof WXWebAssembly !== 'undefined'
    this.videoSupported = wx.canIUse('createVideoDecoder')
    this.setData({
      supported,
      status: supported ? '等待验证' : '当前环境不支持 WXWebAssembly',
      capability: `WXWebAssembly：${supported ? '可用' : '不可用'}；视频解码：${this.videoSupported ? '可用' : '不可用'}`
    })
  },

  onReady() { if (this.data.supported) this.validate() },
  onShow() { this.visible = true },
  onHide() {
    this.visible = false
    clearInterval(this.progressTimer)
    if (this.view) this.view.pause()
    this.setData({ playing: false })
  },
  onUnload() {
    this.alive = false
    clearInterval(this.progressTimer)
    if (this.decoder) this.decoder.remove().catch(() => {})
    this.release().catch(() => {})
  },

  ensureActive() {
    if (!this.alive || !this.visible) throw new Error('验证已中断，请回到页面后重新验证')
  },

  record(name, detail, state = 'pass') {
    if (!this.alive) return
    this.results.push({ name, detail, state })
    this.setData({ results: this.results.slice() })
  },

  async release() {
    clearInterval(this.progressTimer)
    const view = this.view
    const file = this.file
    this.view = null
    this.file = null
    await dispose(view, file)
  },

  async waitForFrame(decoder) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      this.ensureActive()
      const frame = decoder.getFrameData()
      if (frame) return frame
      // getFrameData 是同步取帧 API，解码期间轮询直到帧可用。
      await new Promise(resolve => setTimeout(resolve, 16))
    }
    throw new Error('等待视频帧超时')
  },

  async validateDecoder() {
    if (!this.videoSupported) {
      this.record('视频解码', '当前环境不支持 createVideoDecoder，仍验证纯图形 PAG。', 'skip')
      return false
    }
    const decoder = wx.createVideoDecoder()
    this.decoder = decoder
    try {
      await decoder.start({ source: ASSETS + 'colors.mp4', mode: 1 })
      const frame = await this.waitForFrame(decoder)
      const rgba = new Uint8Array(frame.data)
      if (frame.width !== 16 || frame.height !== 16 || rgba.length !== 1024 || rgba[0] < 180 || rgba[1] > 60 || rgba[2] > 60) {
        throw new Error('首帧尺寸或 RGBA 颜色不正确')
      }
      this.record('RGBA 视频帧', `16 × 16，${rgba.length} 字节，首像素 ${Array.from(rgba.slice(0, 4)).join(', ')}`)
      await decoder.seek(500)
      const sought = await this.waitForFrame(decoder)
      if (sought.pts < 500000) throw new Error('seek 返回了目标时间之前的帧')
      this.record('视频 seek', `目标 500 ms，返回帧 ${sought.pts / 1000} ms`)
      await decoder.stop()
      if (decoder.getFrameData() !== null) throw new Error('stop 后仍返回视频帧')
      this.ensureActive()
      await decoder.start({ source: ASSETS + 'colors.mp4', mode: 1 })
      const restarted = await this.waitForFrame(decoder)
      if (restarted.pts !== frame.pts) throw new Error('重新启动后没有回到首帧')
      await decoder.remove()
      if (decoder.getFrameData() !== null) throw new Error('remove 后仍返回视频帧')
      this.record('视频生命周期', 'stop、重新启动和 remove 通过')
      return true
    } finally {
      await decoder.remove().catch(() => {})
      if (this.decoder === decoder) this.decoder = null
    }
  },

  async loadAsset(name) {
    await this.release()
    this.ensureActive()
    let file
    let view
    try {
      const bytes = await read(name + '.pag')
      this.ensureActive()
      file = await this.PAG.PAGFile.load(bytes)
      this.ensureActive()
      view = await this.PAG.PAGView.init(file, this.canvas, { firstFrame: false })
      this.ensureActive()
      view.setRepeatCount(0)
      this.file = file
      this.view = view
      this.setData({ assetLabel: name === 'red' ? '纯图形 PAG' : '含视频 PAG', progress: 0, playing: false })
      this.record(name === 'red' ? '纯图形 PAG' : '含视频 PAG', `${file.width()} × ${file.height()}，时长 ${file.duration() / 1000000} 秒`)
    } catch (error) {
      await dispose(view, file)
      throw error
    }
  },

  async inspectFrame(progress, red = false) {
    this.ensureActive()
    this.view.setProgress(progress)
    await this.view.flush()
    this.ensureActive()
    const gl = this.canvas.getContext('webgl')
    const pixels = new Uint8Array(16 * 16 * 4)
    gl.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2), 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const error = gl.getError()
    if (error || !pixels.some(value => value)) throw new Error(`渲染为空或 WebGL 错误：${error}`)
    if (red && (pixels[0] < 240 || pixels[1] > 15 || pixels[2] > 15 || pixels[3] < 240)) throw new Error('纯图形 PAG 中心不是红色')
    const hash = pixels.reduce((sum, value, index) => (sum + value * (index + 1)) >>> 0, 0)
    this.record(`渲染 ${Math.round(progress * 100)}%`, `中心 RGBA：${Array.from(pixels.slice(0, 4)).join(', ')}；像素摘要：${hash}；GL：${error}`)
    this.setData({ progress: Math.round(progress * 100) })
    return hash
  },

  async validate() {
    if (this.data.busy || !this.data.supported) return
    this.results = []
    this.setData({ busy: true, ready: false, playing: false, results: [], status: '正在验证…' })
    try {
      await this.release()
      this.PAG = await initPAG()
      this.ensureActive()
      this.record('PAGInit', '真实 libpag-miniprogram 4.5.85 与本地 libpag.wasm.br 初始化成功')
      const oldSize = this.PAG.HEAPU8.byteLength
      const ptr = this.PAG._malloc(48 * 1024 * 1024)
      if (!ptr) throw new Error('48 MiB Wasm 内存分配失败')
      try {
        this.record('Wasm 内存', `48 MiB 分配成功；堆 ${oldSize} → ${this.PAG.HEAPU8.byteLength} 字节`)
      } finally { this.PAG._free(ptr) }
      if (!this.canvas) {
        const result = await new Promise(resolve => wx.createSelectorQuery().select('#pag').fields({ node: true, size: true }).exec(resolve))
        this.ensureActive()
        if (!result[0] || !result[0].node) throw new Error('未取得 WebGL Canvas')
        this.canvas = result[0].node
        this.canvas.width = Math.max(1, Math.round(result[0].width))
        this.canvas.height = Math.max(1, Math.round(result[0].height))
        if (!this.canvas.getContext('webgl', { preserveDrawingBuffer: true })) throw new Error('当前环境不支持 WebGL')
      }
      await this.loadAsset('red')
      await this.inspectFrame(0.5, true)
      let videoReady = false
      try { videoReady = await this.validateDecoder() } catch (error) {
        this.ensureActive()
        this.record('视频解码', error.errMsg || error.message || String(error), 'fail')
      }
      if (videoReady) {
        await this.loadAsset('video')
        const hashes = []
        for (const progress of [0, 0.5, 0.9]) hashes.push(await this.inspectFrame(progress))
        if (new Set(hashes).size !== hashes.length) throw new Error('不同视频进度的画面没有变化')
      }
      this.view.setProgress(0)
      await this.view.play()
      const deadline = Date.now() + 20000
      while (this.view.getProgress() < 0.03 && Date.now() < deadline) {
        this.ensureActive()
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      this.ensureActive()
      await this.view.pause()
      if (this.view.getProgress() < 0.03) throw new Error('播放后动画进度没有推进')
      this.record('播放与暂停', `播放推进至 ${(this.view.getProgress() * 100).toFixed(1)}%，已暂停`)
      const failed = this.results.some(result => result.state === 'fail')
      this.setData({ ready: true, status: failed ? '部分验证失败' : videoReady ? '全部验证通过' : '图形验证通过，视频未验证', progress: Math.round(this.view.getProgress() * 100) })
    } catch (error) {
      if (this.alive) {
        this.record('验证中断', error.errMsg || error.message || String(error), 'fail')
        this.setData({ status: '验证未完成' })
      }
      await this.release().catch(() => {})
    } finally {
      if (this.alive) this.setData({ busy: false })
    }
  },

  async control(action) {
    if (this.data.busy || !this.data.ready) return
    this.setData({ busy: true })
    try { await action() } catch (error) {
      if (!this.visible && this.view) this.view.pause()
      this.record('播放控制', error.errMsg || error.message || String(error), 'fail')
    } finally {
      if (this.alive) this.setData({ busy: false })
    }
  },

  togglePlayback() {
    this.control(async () => {
      this.ensureActive()
      if (this.data.playing) {
        await this.view.pause()
        clearInterval(this.progressTimer)
        if (this.alive) this.setData({ playing: false, progress: Math.round(this.view.getProgress() * 100) })
      } else {
        await this.view.play()
        this.ensureActive()
        this.setData({ playing: true })
        this.progressTimer = setInterval(() => {
          if (this.alive && this.view) this.setData({ progress: Math.round(this.view.getProgress() * 100) })
        }, 250)
      }
    })
  },

  seek(event) {
    const progress = Number(event.detail.value) / 100
    this.control(async () => {
      await this.view.pause()
      clearInterval(this.progressTimer)
      this.ensureActive()
      this.view.setProgress(progress)
      await this.view.flush()
      if (this.alive) this.setData({ playing: false, progress: Math.round(progress * 100) })
    })
  },
  rewind() { this.seek({ detail: { value: 0 } }) }
})
