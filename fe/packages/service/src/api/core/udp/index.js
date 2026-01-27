import { invokeAPI } from '@/api/common';
import { callback, isFunction } from '@dimina/common'; // 复用框架的回调工具

/**
 * 对齐微信 UDPSocket 类（完全遵循 Dimina 框架 WebSocket 实现规范）
 * 参考：https://developers.weixin.qq.com/miniprogram/dev/api/network/udp/UDPSocket.html
 */

function base64ToArrayBuffer(base64Str) {
  // 第一步：Base64 解码为二进制字符串
  const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64Table = new Array(256);
  for (let i = 0; i < b64Chars.length; i++) {
    b64Table[b64Chars.charCodeAt(i)] = i;
  }

  // 去除Base64中的空白字符（如换行），处理填充符=
  base64Str = base64Str.replace(/\s+/g, '').replace(/=+$/, '');
  const len = base64Str.length;
  const byteLength = Math.floor(len * 3 / 4); // 计算二进制字节长度
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);

  let i = 0;
  let j = 0;
  while (i < len) {
    // 读取4个Base64字符对应的6位值
    const c1 = b64Table[base64Str.charCodeAt(i++)];
    const c2 = b64Table[base64Str.charCodeAt(i++)];
    const c3 = i < len ? b64Table[base64Str.charCodeAt(i++)] : 0;
    const c4 = i < len ? b64Table[base64Str.charCodeAt(i++)] : 0;

    // 拼接为3个字节（4*6位 = 3*8位）
    const byte1 = (c1 << 2) | (c2 >> 4);
    const byte2 = ((c2 & 15) << 4) | (c3 >> 2);
    const byte3 = ((c3 & 3) << 6) | c4;

    bytes[j++] = byte1;
    if (j < byteLength) bytes[j++] = byte2;
    if (j < byteLength) bytes[j++] = byte3;
  }

  return buffer; // 返回ArrayBuffer
}


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

    // this._udpSocket.onMessage(this._messageHandler);
    // this._udpSocket.onListening(this._listeningHandler);
    // this._udpSocket.onError(this._errorHandler);
    // this._udpSocket.onClose(this._closeHandler);


  }


  success_(ret) {
    this._readyState = UDPSocket.BOUND;
    console.log(`【UDP UdpSocketApi】绑定成功: ${ret}`);
  }
  fail_(ret) {
    this._readyState = UDPSocket.UNBOUND;
    console.log(`【UDP UdpSocketApi】绑定失败: ${ret}`);
  }
  complete_(ret) {
    console.log(`【UDP UdpSocketApi】绑定完成: ${ret}`);
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
    }

    params.success = callback.store((res) => {
      console.log(`【UDP UdpSocketApi】绑定成功1: ${res}`);
    }, true)



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
      mid: this.mid,
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
    const { address, port, message, success, fail, complete } = options;
    console.log(`【UDP UdpSocketApi】发送消息到 ${address}:${port}，数据：`, message);

    const params = {
      mid: this.mid,
      socketId: this.socketId,
      address,
      port,
      message
    };

    if (isFunction(success)) params.success = callback.store(success);
    if (isFunction(fail)) params.fail = callback.store(fail);
    if (isFunction(complete)) params.complete = callback.store(complete);
    const ret = invokeAPI('udpsocket.send', params);
    console.log(`【UDP UdpSocketApi】发送消息返回 :`, ret);
    return ret;
  }

  /**
   * 设置 TTL（补全实现）
   * @param {number} ttl TTL 值
   * @param {Object} [opts] 回调参数
   */
  setTTL(ttl, opts = {}) {
    const { success, fail, complete } = opts;
    const params = {
      mid: this.mid,
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
        mid: this.mid,
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
      mid: this.mid,
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
        mid: this.mid,
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
      mid: this.mid,
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
        mid: this.mid,
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
      mid: this.mid,
      socketId: this.socketId,
      callback: callbackFn
    });
  }

  /**
   * 监听 Socket 接收消息事件
   * @param {Function} callbackFn 回调函数
   */
  onMessage(callbackFn) {
    if (!isFunction(callbackFn)) {
      console.log(`【UDP UdpSocketApi】监听消息事件 参数不是函数`);
      return {
        code: 400,
        mid: this.mid,
        socketId: this.socketId,
        message: 'callbackFn 必须是函数'
      };
    }

    const params = {
      mid: this.mid,
      socketId: this.socketId,
      success: callback.store((res) => {
        console.log(`【UDP UdpSocketApi】监听消息回调:`,res);
        // remoteInfo: {…}, localInfo: {…}, message: ArrayBuffer
        const arrayBuffer = base64ToArrayBuffer(res.message); // 最终的 ArrayBuffer
        console.log('【UDP UdpSocketApi】 ArrayBuffer:', arrayBuffer);
        res.message = arrayBuffer;
        callbackFn(res);
      }, true)
    }

    const ret = invokeAPI('udpsocket.onMessage', params);
    console.log(`【UDP UdpSocketApi】监听消息事件`, ret);
    return ret;
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
  const ret = invokeAPI('createUDPSocket', params);
  const socketInstance = new UDPSocket(ret);
  console.log('【UDP UdpSocketApi】创建返回', ret);
  return socketInstance;
}



export function onMessage1(params) {
  console.log('【UDP UdpSocketApi】onMessage1 被调用', params);
  return "onMessage1 调用成功";
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