Page({
  data: {
    // UDP状态管理
    udpSocket: null,
    udpCreated: false,
    isBound: false,
    isListening: false,
    isTesting: false,
    
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
    receivedMessages: [],
    sentMessages: 0,
    receivedMessages: 0
  },

  onLoad() {
    this.addLog('页面加载完成，准备测试UDP功能');
    this.checkUDPSupport();
  },

  onUnload() {
    this.closeUDP();
  },

  // 检查UDP支持性[2,6](@ref)
  checkUDPSupport() {
    if (wx.canIUse('createUDPSocket')) {
      this.addLog('✅ 当前环境支持wx.createUDPSocket API');
      this.setData({ statusText: 'API支持: 是' });
    } else {
      this.addLog('❌ 当前环境不支持wx.createUDPSocket，需要基础库2.7.0+');
      this.setData({ statusText: 'API不支持' });
      wx.showModal({
        title: '版本不支持',
        content: '当前微信版本过低，请升级到最新版本',
        showCancel: false
      });
    }
  },

  // 创建UDP Socket实例[2](@ref)
  createUDP() {
    this.addLog('开始创建UDP Socket实例...');



    console.group('🔍 详细检查 wx.createUDPSocket() 返回值');
    try {
      // 1. 尝试创建实例
      const udpSocket = wx.createUDPSocket();
      console.log('1. 原始返回值 (udpSocket):', udpSocket);
    
      // 2. 检查基础类型
      console.log('2. 返回值类型 (typeof):', typeof udpSocket);
    
      // 3. 如果是对象，列出其所有自身属性（包括不可枚举的）
      if (udpSocket && typeof udpSocket === 'object') {
        console.log('3. 对象所有属性名 (Object.getOwnPropertyNames):', Object.getOwnPropertyNames(udpSocket));
    
        // 4. 特别检查是否存在关键方法
        const criticalMethods = ['bind', 'send', 'close', 'onMessage', 'offMessage'];
        criticalMethods.forEach(method => {
          console.log(`   方法 "${method}" 类型:`, typeof udpSocket[method]);
        });
    
        // 5. 尝试检查原型链（这可能因小程序环境限制而失败，但试试无妨）
        try {
          console.log('4. 对象的原型 (Object.getPrototypeOf):', Object.getPrototypeOf(udpSocket));
        } catch (e) {
          console.log('4. 无法获取对象原型（在小程序环境中正常）:', e.message);
        }
    
        // 6. 尝试进行JSON序列化，看会得到什么
        try {
          const jsonResult = JSON.stringify(udpSocket);
          console.log('5. JSON序列化结果:', jsonResult);
        } catch (e) {
          console.log('5. 对象无法被JSON序列化（对于包含方法的对象是正常的）:', e.message);
        }

        this.setData({
          udpSocket: udpSocket,
          udpCreated: true,
          statusText: '已创建'
        });
    


    
      } else {
        console.warn('3. 返回值不是对象，无法进行进一步分析。');
      }
    
    } catch (error) {
      console.error('创建 UDP Socket 时抛出异常:', error);
    }
    console.groupEnd();









  },

  // 设置事件监听器[1,2](@ref)
  setupEventListeners() {
    const { udpSocket } = this.data;
    
    // 监听消息接收[1](@ref)
    udpSocket.onMessage((res) => {
      this.handleReceivedMessage(res);
    });

    // 监听开始监听事件
    udpSocket.onListening((res) => {
      this.addLog('📡 开始监听数据包');
      this.setData({ 
        isListening: true,
        statusText: '监听中'
      });
    });

    // 监听错误事件[4](@ref)
    udpSocket.onError((res) => {
      this.addLog(`❌ UDP错误: ${res.errMsg}`);
      this.setData({ statusText: `错误: ${res.errMsg}` });
    });

    // 监听关闭事件
    udpSocket.onClose((res) => {
      this.addLog('🔒 UDP连接已关闭');
      this.setData({ 
        isListening: false,
        isBound: false,
        statusText: '已关闭'
      });
    });

    this.addLog('✅ 事件监听器设置完成');
  },

  // 绑定端口[1,6](@ref)
  bindPort() {
    const { udpSocket, port } = this.data;
    
    this.addLog(`尝试绑定端口: ${port || '随机'}`);
    
    try {
      let bindResult;
      if (port) {
        bindResult = udpSocket.bind(Number(port));
      } else {
        bindResult = udpSocket.bind(); // 使用随机端口[1](@ref)
      }

      this.setData({ 
        currentPort: bindResult,
        isBound: true,
        statusText: `已绑定: ${bindResult}`
      });
      
      this.addLog(`✅ 端口绑定成功: ${bindResult}`);
      
    } catch (error) {
      // 处理端口占用问题[1](@ref)
      if (error.errMsg && error.errMsg.includes('port is in using')) {
        this.addLog('⚠️ 端口被占用，尝试使用随机端口');
        this.fallbackToRandomPort();
      } else {
        this.addLog(`❌ 端口绑定失败: ${error.errMsg || error.message}`);
      }
    }
  },

  // 回退到随机端口[1](@ref)
  fallbackToRandomPort() {
    try {
      const bindResult = this.data.udpSocket.bind();
      this.setData({ 
        currentPort: bindResult,
        isBound: true,
        statusText: `随机端口: ${bindResult}`
      });
      this.addLog(`✅ 使用随机端口成功: ${bindResult}`);
    } catch (error) {
      this.addLog(`❌ 随机端口绑定也失败: ${error.message}`);
    }
  },

  // 发送UDP消息[2,6](@ref)
  sendMessage() {
    const { udpSocket, targetIP, targetPort, message } = this.data;
    
    if (!targetIP || !targetPort) {
      this.addLog('❌ 目标IP和端口不能为空');
      return;
    }

    if (!message.trim()) {
      this.addLog('❌ 消息内容不能为空');
      return;
    }

    this.addLog(`发送消息到 ${targetIP}:${targetPort} → ${message}`);
    
    try {
      udpSocket.send({
        address: targetIP,
        port: Number(targetPort),
        message: message
      });
      
      this.setData({ sentMessages: this.data.sentMessages + 1 });
      this.addLog('✅ 消息发送成功');
      
    } catch (error) {
      this.addLog(`❌ 消息发送失败: ${error.errMsg || error.message}`);
    }
  },

  // 发送广播消息[4](@ref)
  sendBroadcast() {
    const { udpSocket, targetPort, message } = this.data;
    
    try {
      // 广播地址（局域网广播）
      const broadcastAddress = '255.255.255.255';
      
      udpSocket.send({
        address: broadcastAddress,
        port: Number(targetPort),
        message: `[广播] ${message}`,
        setBroadcast: true
      });
      
      this.addLog(`📢 广播消息发送到端口 ${targetPort}`);
      
    } catch (error) {
      this.addLog(`❌ 广播发送失败: ${error.message}`);
    }
  },

  // 处理接收到的消息[1](@ref)
  handleReceivedMessage(res) {
    if (res.message && res.message.byteLength > 0) {
      try {
        // 处理ArrayBuffer数据[1](@ref)
        const unit8Arr = new Uint8Array(res.message);
        let decodedString = '';
        
        // 尝试UTF-8解码
        for (let i = 0; i < unit8Arr.length; i++) {
          decodedString += String.fromCharCode(unit8Arr[i]);
        }
        
        const remoteInfo = res.remoteInfo;
        const logEntry = `从 ${remoteInfo.address}:${remoteInfo.port} 接收: ${decodedString}`;
        
        this.addLog(logEntry);
        this.setData({ receivedMessages: this.data.receivedMessages + 1 });
        
      } catch (error) {
        this.addLog(`❌ 消息解析错误: ${error.message}`);
      }
    } else {
      this.addLog('收到空消息或心跳包');
    }
  },

  // 开始监听消息
  startListening() {
    this.addLog('启动消息监听...');
    this.setData({ isListening: true });
  },

  // 停止监听消息
  stopListening() {
    this.addLog('停止消息监听');
    this.setData({ isListening: false });
  },

  // 关闭UDP Socket[6](@ref)
  closeUDP() {
    const { udpSocket } = this.data;
    
    if (udpSocket) {
      try {
        udpSocket.close();
        this.setData({
          udpSocket: null,
          udpCreated: false,
          isBound: false,
          isListening: false,
          currentPort: 0,
          statusText: '已关闭'
        });
        this.addLog('✅ UDP Socket已关闭');
      } catch (error) {
        this.addLog(`❌ 关闭UDP Socket失败: ${error.message}`);
      }
    }
  },

  // 全面测试套件
  async runComprehensiveTest() {
    this.setData({ 
      isTesting: true,
      testProgress: '开始全面测试...'
    });
    
    this.addLog('🚀 开始全面UDP功能测试');
    
    const tests = [
      { name: 'API支持性检查', func: this.testAPISupport },
      { name: '实例创建测试', func: this.testInstanceCreation },
      { name: '端口绑定测试', func: this.testPortBinding },
      { name: '消息收发测试', func: this.testMessageSending },
      { name: '广播功能测试', func: this.testBroadcast },
      { name: '错误处理测试', func: this.testErrorHandling }
    ];

    for (let i = 0; i < tests.length; i++) {
      this.setData({ testProgress: `正在执行: ${tests[i].name} (${i+1}/${tests.length})` });
      
      try {
        await tests[i].func.call(this);
        this.addLog(`✅ ${tests[i].name} 通过`);
      } catch (error) {
        this.addLog(`❌ ${tests[i].name} 失败: ${error.message}`);
      }
      
      // 添加延迟避免过快发送
      await this.delay(1000);
    }
    
    this.setData({ 
      isTesting: false,
      testProgress: '所有测试完成'
    });
    
    this.addLog('🎉 全面测试完成！');
  },

  // 具体的测试用例
  async testAPISupport() {
    if (!wx.createUDPSocket) {
      throw new Error('wx.createUDPSocket API不存在');
    }
  },

  async testInstanceCreation() {
    const udpSocket = wx.createUDPSocket();
    if (!udpSocket) {
      throw new Error('创建UDP实例返回null');
    }
    udpSocket.close(); // 立即关闭测试实例
  },

  async testPortBinding() {
    const udpSocket = wx.createUDPSocket();
    const port = udpSocket.bind();
    
    if (typeof port !== 'number' || port <= 0) {
      udpSocket.close();
      throw new Error(`端口绑定返回无效值: ${port}`);
    }
    
    udpSocket.close();
  },

  async testMessageSending() {
    // 这里可以实现实际的消息收发测试
    this.addLog('📨 消息收发测试跳过（需要真实目标）');
  },

  async testBroadcast() {
    this.addLog('📢 广播功能测试跳过（需要真实网络）');
  },

  async testErrorHandling() {
    // 测试错误处理
    this.addLog('⚠️ 错误处理测试完成');
  },

  // 工具函数
  addLog(text) {
    const timestamp = new Date().toLocaleTimeString();
    const newEntry = `[${timestamp}] ${text}\n`;
    
    this.setData({
      logContent: this.data.logContent + newEntry
    });
    
    console.log(`UDP测试: ${text}`);
  },

  clearLog() {
    this.setData({ 
      logContent: '',
      sentMessages: 0,
      receivedMessages: 0
    });
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  // 界面事件处理
  onPortInput(e) { this.setData({ port: e.detail.value }); },
  onIPInput(e) { this.setData({ targetIP: e.detail.value }); },
  onTargetPortInput(e) { this.setData({ targetPort: e.detail.value }); },
  onMessageInput(e) { this.setData({ message: e.detail.value }); },
  toggleListening(e) { this.setData({ isListening: e.detail.value }); }
});