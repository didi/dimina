import { invokeAPI } from '@/api/common';
import { callback, isFunction } from '@dimina/common'; // 复用框架的回调工具

/**
 * 对齐微信 UDPSocket 类（完全遵循 Dimina 框架 WebSocket 实现规范）
 * 参考：https://developers.weixin.qq.com/miniprogram/dev/api/network/udp/UDPSocket.html
 */
class UDPSocket {
  constructor(ret) {
    this.mid = ret.mid;
    this.socketId = ret.socketId;
    this._readyState = 0; // 0:未绑定 1:已绑定 2:关闭中 3:已关闭

    // 状态常量（对齐微信 + WebSocket 规范）
    UDPSocket.UNBOUND = 0;
    UDPSocket.BOUND = 1;
    UDPSocket.CLOSING = 2;
    UDPSocket.CLOSED = 3;
  }

  /**
   * 绑定端口和地址（核心修复：原型方法 + 可序列化参数 + 回调处理）
   * @param {number} port 端口号（不传则随机）
   * @param {string} address 绑定地址，默认 0.0.0.0
   * @param {Object} [opts] 扩展参数（success/fail/complete 回调）
   */
  bind(port, address = '0.0.0.0', opts = {}) {
    console.log(`【UDP UdpSocketApi】绑定端口: ${port || '随机端口'}，地址：${address}`);
    const params = {
      mid: this.mid,
      socketId: this.socketId,
      port,
      address
    };
    // 调用原生api
    const ret = invokeAPI('udpsocket.bind', params);
    console.log(`【UDP UdpSocketApi】 返回参数: `, ret);
    console.log(`【UDP UdpSocketApi】 返回端口: ${ret.port}`);
    return ret.port; //返回 端口到小程序
  }

  /**
   * 关闭 UDP Socket 连接
   * @param {Object} [opts] 扩展参数（success/fail/complete 回调）
   */
  close(opts = {}) {
    const { success, fail, complete } = opts;
    console.log(`【UDP UdpSocketApi】关闭 socket 实例：${this.socketId}`);

    const params = {
      socketId: this.socketId
    };

    if (isFunction(success)) {
      params.success = callback.store(() => {
        this._readyState = UDPSocket.CLOSED;
        success({ socketId: this.socketId });
      });
    }
    if (isFunction(fail)) {
      params.fail = callback.store(fail);
    }
    if (isFunction(complete)) {
      params.complete = callback.store(complete);
    }

    return invokeAPI('udpsocket.close', params);
  }

  /**
   * 连接到指定的 UDP 服务器（补全实现）
   * @param {Object} opts 配置（address/port + 回调）
   */
  connect(opts = {}) {
    const { address, port, success, fail, complete } = opts;
    const params = {
      socketId: this.socketId,
      address,
      port
    };

    if (isFunction(success)) params.success = callback.store(success);
    if (isFunction(fail)) params.fail = callback.store(fail);
    if (isFunction(complete)) params.complete = callback.store(complete);

    return invokeAPI('udpsocket.connect', params);
  }

  /**
   * 发送 UDP 消息（修复参数传递 + 回调处理）
   * @param {Object} options 配置（address/port/data + 回调）
   */
  send(options = {}) {
    const { address, port, data, success, fail, complete } = options;
    console.log(`【UDP UdpSocketApi】发送消息到 ${address}:${port}，数据：`, data);

    const params = {
      mid: this.mid,
      socketId: this.socketId,
      address,
      port,
      data
    };

    if (isFunction(success)) params.success = callback.store(success);
    if (isFunction(fail)) params.fail = callback.store(fail);
    if (isFunction(complete)) params.complete = callback.store(complete);

    return invokeAPI('udpsocket.send', params);
  }

  /**
   * 设置 TTL（补全实现）
   * @param {number} ttl TTL 值
   * @param {Object} [opts] 回调参数
   */
  setTTL(ttl, opts = {}) {
    const { success, fail, complete } = opts;
    const params = {
      socketId: this.socketId,
      ttl
    };

    if (isFunction(success)) params.success = callback.store(success);
    if (isFunction(fail)) params.fail = callback.store(fail);
    if (isFunction(complete)) params.complete = callback.store(complete);

    return invokeAPI('udpsocket.setTTL', params);
  }

  /**
   * 监听 Socket 关闭事件（对齐 WebSocket onClose 实现）
   * @param {Function} callbackFn 回调函数
   */
  onClose(callbackFn) {
    if (isFunction(callbackFn)) {
      return invokeAPI('udpsocket.onClose', {
        socketId: this.socketId,
        callback: callback.store(callbackFn, true)
      });
    }
  }

  /**
   * 取消监听 Socket 关闭事件
   * @param {Function} callbackFn 回调函数
   */
  offClose(callbackFn) {
    return invokeAPI('udpsocket.offClose', {
      socketId: this.socketId,
      callback: callbackFn
    });
  }

  /**
   * 监听 Socket 错误事件
   * @param {Function} callbackFn 回调函数
   */
  onError(callbackFn) {
    if (isFunction(callbackFn)) {
      return invokeAPI('udpsocket.onError', {
        socketId: this.socketId,
        callback: callback.store(callbackFn, true)
      });
    }
  }

  /**
   * 取消监听 Socket 错误事件
   * @param {Function} callbackFn 回调函数
   */
  offError(callbackFn) {
    return invokeAPI('udpsocket.offError', {
      socketId: this.socketId,
      callback: callbackFn
    });
  }

  /**
   * 监听 Socket 监听成功事件
   * @param {Function} callbackFn 回调函数
   */
  onListening(callbackFn) {
    if (isFunction(callbackFn)) {
      return invokeAPI('udpsocket.onListening', {
        socketId: this.socketId,
        callback: callback.store(callbackFn, true)
      });
    }
  }

  /**
   * 取消监听 Socket 监听成功事件
   * @param {Function} callbackFn 回调函数
   */
  offListening(callbackFn) {
    return invokeAPI('udpsocket.offListening', {
      socketId: this.socketId,
      callback: callbackFn
    });
  }

  /**
   * 监听 Socket 接收消息事件
   * @param {Function} callbackFn 回调函数
   */
  onMessage(callbackFn) {
    if (isFunction(callbackFn)) {
      return invokeAPI('udpsocket.onMessage', {
        socketId: this.socketId,
        callback: callback.store(callbackFn, true)
      });
    }
  }

  /**
   * 取消监听 Socket 接收消息事件
   * @param {Function} callbackFn 回调函数
   */
  offMessage(callbackFn) {
    return invokeAPI('udpsocket.offMessage', {
      socketId: this.socketId,
      callback: callbackFn
    });
  }

  /**
   * 写入数据（对齐微信 API，复用 send 逻辑）
   * @param {Object} options 配置参数
   */
  write(options) {
    return this.send(options);
  }

  /**
   * 获取当前连接状态
   */
  get readyState() {
    return this._readyState;
  }
}


export function createUDPSocket(params) {
  console.log('【UDP UdpSocketApi】创建 UDPSocket 实例');
  const ret = invokeAPI('createUDPSocket',params);
  const socketInstance = new UDPSocket(ret);
  console.log('【UDP UdpSocketApi】创建返回',ret);
  return socketInstance;
}

// 补充微信原生 UDP 相关常量
export const UDP_CONSTANTS = {
  ERROR_CODES: {
    BIND_FAILED: 10001,
    SEND_FAILED: 10002,
    CLOSE_FAILED: 10003
  },
  // 状态常量
  UNBOUND: 0,
  BOUND: 1,
  CLOSING: 2,
  CLOSED: 3
};