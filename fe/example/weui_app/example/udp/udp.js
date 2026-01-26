Page({
  // 修复点1：强化实例管理，使用私有变量挂载，避免存入data
  _udpSocket: null,
  // 修复点2：使用具名函数引用，用于安全移除事件监听
  _messageHandler: null,
  _listeningHandler: null,
  _errorHandler: null,
  _closeHandler: null,

  data: {
    // UDP状态管理（仅存简单数据，无复杂对象）
    udpCreated: false,
    isBound: false,
    isListening: false,
    isTesting: false,
    wasListening: false, // 新增：用于页面隐藏时恢复状态

    // 配置参数
    port: '',
    currentPort: 0,
    targetIP: '192.168.1.1',
    targetPort: '8080',
    message: 'Hello UDP!',

    // 界面状态
    statusText: '未初始化',
    testProgress: '',
    logContent: '',

    // 测试数据
    receivedMessages: 0,
    sentMessages: 0
  },

  onLoad() {
    this.addLog('页面加载完成，准备测试UDP功能');
    this.checkUDPSupport();
  },

  onUnload() {
    this.addLog('🔚 页面卸载，清理资源');
    this.closeUDP();
  },

  // 修复点3：增加页面生命周期管理
  onHide() {
    // 页面隐藏时暂停活动
    if (this.data.isListening && this._udpSocket) {
      this.addLog('⏸️ 页面隐藏，暂停监听');
      this.setData({ wasListening: true, isListening: false });
    }
  },

  onShow() {
    // 页面显示时恢复状态
    if (this.data.wasListening && this._udpSocket) {
      this.addLog('▶️ 页面显示，恢复监听');
      this.setData({ isListening: true, wasListening: false });
    }
  },

  // 检查UDP支持性
  checkUDPSupport() {
    if (wx.canIUse('createUDPSocket')) {
      this.addLog('✅ 当前环境支持wx.createUDPSocket API');
      this.setData({ statusText: 'API支持: 是' });
    } else {
      this.addLog('❌ 当前环境不支持wx.createUDPSocket，需要基础库2.7.0+');
      this.setData({ statusText: 'API不支持' });
      wx.showModal({
        title: '版本不支持',
        content: '当前环境不支持UDPSocket API，请确认基础库版本',
        showCancel: false
      });
    }
  },

  // 修复点4：增强实例创建逻辑，防止重复创建和状态不一致
  createUDP() {
    // 增强实例检查，包括关闭中的状态
    if (this._udpSocket && this.data.udpCreated) {
      this.addLog('⚠️ UDP Socket实例已存在，如需重新创建请先关闭当前实例');
      return;
    }

    try {
      // 确保之前实例完全清理
      if (this._udpSocket) {
        this._udpSocket.close();
        this._udpSocket = null;
      }

      this._udpSocket = wx.createUDPSocket();
      // 增加创建成功验证
      if (!this._udpSocket || typeof this._udpSocket.bind !== 'function') {
        throw new Error('UDP Socket实例创建异常');
      }

      this.setupEventListeners();
      this.setData({ 
        udpCreated: true,
        statusText: '已创建'
      });
      this.addLog('✅ UDP Socket实例创建成功');
    } catch (error) {
      this.addLog(`❌ 创建失败: ${error.message}`);
      this._udpSocket = null; // 确保异常时清空引用
      this.setData({ udpCreated: false });
    }
  },

  // 修复点5：安全的事件监听器管理，防止重复绑定
  setupEventListeners() {
    if (!this._udpSocket) {
      this.addLog('❌ 未创建UDP Socket实例，无法设置监听器');
      return;
    }

    // 先移除已存在监听器
    this.removeEventListeners();

    // 使用具名函数便于移除
    this._messageHandler = (res) => this.handleReceivedMessage(res);
    this._listeningHandler = (res) => {
      this.addLog('📡 UDP端口绑定成功，开始监听数据包');
      this.setData({ isListening: true, statusText: '监听中' });
    };
    this._errorHandler = (res) => this.handleError(res);
    this._closeHandler = (res) => this.handleClose(res);

    this._udpSocket.onMessage(this._messageHandler);
    this._udpSocket.onListening(this._listeningHandler);
    this._udpSocket.onError(this._errorHandler);
    this._udpSocket.onClose(this._closeHandler);

    this.addLog('✅ 事件监听器设置完成');
  },

  // 新增：安全移除监听器
  removeEventListeners() {
    if (!this._udpSocket) return;

    try {
      if (this._messageHandler) {
        this._udpSocket.offMessage?.(this._messageHandler);
      }
      if (this._listeningHandler) {
        this._udpSocket.offListening?.(this._listeningHandler);
      }
      if (this._errorHandler) {
        this._udpSocket.offError?.(this._errorHandler);
      }
      if (this._closeHandler) {
        this._udpSocket.offClose?.(this._closeHandler);
      }
    } catch (error) {
      console.warn('移除监听器异常:', error);
    }
  },

  // 修复点6：增强端口绑定逻辑，优先使用随机端口避免iOS兼容问题[1](@ref)
  bindPort() {
    const { port } = this.data;

    if (!this._udpSocket) {
      this.addLog('❌ 未创建UDP Socket实例，请先点击"创建实例"');
      return false;
    }

    if (this.data.isBound) {
      this.addLog(`⚠️ 已绑定端口 ${this.data.currentPort}，无需重复绑定`);
      return true;
    }

    // 修复点：iOS设备上指定端口易被占用，建议使用随机端口[1](@ref)
    if (!port) {
      this.addLog('尝试绑定随机端口（推荐，避免端口占用问题）');
      return this.bindRandomPort();
    }

    // 验证端口号合法性
    const portNum = Number.parseInt(port);
    if (portNum < 1024 || portNum > 65535) {
      this.addLog('❌ 端口范围应为1024-65535');
      return false;
    }

    this.addLog(`尝试绑定指定端口: ${port}`);
    try {
      const bindResult = this._udpSocket.bind(portNum);
      
      if (typeof bindResult === 'number' && bindResult > 0) {
        this.setData({
          currentPort: bindResult,
          isBound: true,
          statusText: `已绑定:${bindResult}`
        });
        this.addLog(`✅ 指定端口绑定成功: ${bindResult}`);
        return true;
      } else {
        throw new Error(`绑定返回异常: ${bindResult}`);
      }
    } catch (error) {
      this.handleBindError(error);
      return false;
    }
  },

  // 绑定随机端口（更稳定的方案）
  bindRandomPort() {
    if (!this._udpSocket) return false;

    try {
      const bindResult = this._udpSocket.bind();
      
      if (typeof bindResult === 'number' && bindResult > 0) {
        this.setData({
          currentPort: bindResult,
          isBound: true,
          statusText: `随机端口:${bindResult}`
        });
        this.addLog(`✅ 随机端口绑定成功: ${bindResult}`);
        return true;
      } else {
        throw new Error(`随机端口绑定返回异常: ${bindResult}`);
      }
    } catch (error) {
      this.addLog(`❌ 随机端口绑定失败: ${error.message}`);
      this.setData({ statusText: '绑定失败' });
      return false;
    }
  },

  // 新增：统一的端口绑定错误处理
  handleBindError(error) {
    const errMsg = error.errMsg || error.message;
    
    if (errMsg.includes('port is in using')) {
      this.addLog('⚠️ 指定端口被占用，自动切换随机端口...');
      this.bindRandomPort();
    } else if (errMsg.includes('permission')) {
      this.addLog('❌ 权限不足，请尝试1024以上端口');
      this.setData({ statusText: '权限错误' });
    } else {
      this.addLog(`❌ 绑定失败: ${errMsg}`);
      this.setData({ statusText: `绑定失败` });
    }
  },

  // 修复点7：增强数据发送的数据类型兼容性
  sendMessage() {
    if (!this.validateSendConditions()) return;

    const { targetIP, targetPort, message } = this.data;
    const sendData = message?.trim() || '';

    this.addLog(`发送消息到 ${targetIP}:${targetPort} → ${sendData}`);

    try {
      const sendParams = {
        address: targetIP,
        port: Number(targetPort),
        data: this.convertToBuffer(sendData)
      };

      this._udpSocket.send(sendParams);
      this.setData({ sentMessages: this.data.sentMessages + 1 });
      this.addLog('✅ 消息发送成功');

    } catch (error) {
      const errMsg = error.errMsg || error.message || '发送失败';
      this.addLog(`❌ 消息发送失败: ${errMsg}`);
    }
  },

  // 发送广播消息
  sendBroadcast() {
    if (!this.validateSendConditions()) return;

    const { targetPort, message } = this.data;
    const sendData = message?.trim() || '';
    const broadcastData = `[广播] ${sendData}`;

    try {
      const sendParams = {
        address: '255.255.255.255',
        port: Number(targetPort),
        data: this.convertToBuffer(broadcastData),
        setBroadcast: true
      };

      this._udpSocket.send(sendParams);
      this.addLog(`📢 广播消息发送到端口 ${targetPort}`);
      this.setData({ sentMessages: this.data.sentMessages + 1 });

    } catch (error) {
      const errMsg = error.message || error.errMsg || '广播失败';
      this.addLog(`❌ 广播发送失败: ${errMsg}`);
    }
  },

  // 新增：发送条件验证
  validateSendConditions() {
    if (!this._udpSocket) {
      this.addLog('❌ 未创建UDP Socket实例，请先创建');
      return false;
    }
    if (!this.data.isBound) {
      this.addLog('❌ 未绑定端口，请先绑定端口再发送消息');
      return false;
    }
    
    const { targetIP, targetPort, message } = this.data;
    if (!targetIP || !targetPort) {
      this.addLog('❌ 目标IP和端口不能为空');
      return false;
    }
    
    const sendData = message?.trim() || '';
    if (!sendData) {
      this.addLog('❌ 消息内容不能为空');
      return false;
    }

    return true;
  },

  // 修复点8：增强数据类型转换，兼容更多场景[1,4](@ref)
  convertToBuffer(data) {
    if (!data) return new ArrayBuffer(0);

    try {
      // 处理 ArrayBuffer 和 TypedArray
      if (data instanceof ArrayBuffer) return data;
      if (data.buffer instanceof ArrayBuffer) return data.buffer;
      
      // 处理字符串
      if (typeof data === 'string') {
        // 修复点：使用更标准的中文编码处理[1,4](@ref)
        const encoder = new TextEncoder();
        return encoder.encode(data).buffer;
      }
      
      // 处理数字、布尔等基本类型
      if (typeof data === 'number' || typeof data === 'boolean') {
        return this.convertToBuffer(String(data));
      }
      
      // 处理对象：转为JSON字符串
      if (typeof data === 'object') {
        return this.convertToBuffer(JSON.stringify(data));
      }
      
      throw new Error(`不支持的数据类型: ${typeof data}`);
    } catch (error) {
      console.error('数据转换失败:', error);
      return new ArrayBuffer(0);
    }
  },

  // 修复点9：优化消息接收处理，增强兼容性
  handleReceivedMessage(res) {
    const messageData = res.message || res.data;
    const remoteInfo = res.remoteInfo || res;

    if (messageData && messageData.byteLength > 0) {
      try {
        // 使用更健壮的数据解码方式[1,4](@ref)
        const decodedString = this.decodeArrayBuffer(messageData);
        const logEntry = `从 ${remoteInfo.address || '未知地址'}:${remoteInfo.port || '未知端口'} 接收: ${decodedString}`;

        this.addLog(logEntry);
        this.setData({ receivedMessages: this.data.receivedMessages + 1 });

      } catch (error) {
        this.addLog(`❌ 消息解析错误: ${error.message}`);
      }
    } else {
      this.addLog('收到空消息或心跳包');
    }
  },

  // 新增：ArrayBuffer解码方法（兼容中文）[1,4](@ref)
  decodeArrayBuffer(arrayBuffer) {
    try {
      // 方法1: 使用TextDecoder（首选）
      if (typeof TextDecoder !== 'undefined') {
        const decoder = new TextDecoder('utf-8');
        return decoder.decode(new Uint8Array(arrayBuffer));
      }
      
      // 方法2: 兼容性方案（处理中文乱码）[1](@ref)
      const unit8Arr = new Uint8Array(arrayBuffer);
      let encodedString = '';
      for (let i = 0; i < unit8Arr.length; i++) {
        encodedString += String.fromCharCode(unit8Arr[i]);
      }
      return decodeURIComponent(escape(encodedString));
    } catch (error) {
      throw new Error(`解码失败: ${error.message}`);
    }
  },

  // 错误处理
  handleError(res) {
    const errMsg = res.errMsg || res.message || '未知错误';
    this.addLog(`❌ UDP错误: ${errMsg}`);
    this.setData({ statusText: `错误: ${errMsg}` });
  },

  // 连接关闭处理
  handleClose(res) {
    this.addLog('🔒 UDP连接已关闭');
    this.removeEventListeners();
    this.setData({
      isListening: false,
      isBound: false,
      udpCreated: false,
      statusText: '已关闭'
    });
    this._udpSocket = null;
  },

  // 关闭UDP Socket
  closeUDP() {
    if (!this._udpSocket) return;

    try {
      this.removeEventListeners();
      this._udpSocket.close();
      this._udpSocket = null;
      
      this.setData({
        udpCreated: false,
        isBound: false,
        isListening: false,
        currentPort: 0,
        statusText: '已关闭'
      });
      this.addLog('✅ UDP Socket已关闭');
    } catch (error) {
      const errMsg = error.message || error.errMsg || '关闭失败';
      this.addLog(`❌ 关闭失败: ${errMsg}`);
    }
  },

  // 工具函数
  addLog(text) {
    const timestamp = new Date().toLocaleTimeString();
    const newEntry = `[${timestamp}] ${text}\n`;

    this.setData({
      logContent: this.data.logContent + newEntry
    });
  },

  clearLog() {
    this.setData({
      logContent: '',
      sentMessages: 0,
      receivedMessages: 0
    });
  },

  // 界面事件处理
  onPortInput(e) {
    this.setData({ port: e.detail.value });
  },
  onIPInput(e) {
    this.setData({ targetIP: e.detail.value });
  },
  onTargetPortInput(e) {
    this.setData({ targetPort: e.detail.value });
  },
  onMessageInput(e) {
    this.setData({ message: e.detail.value });
  }
});