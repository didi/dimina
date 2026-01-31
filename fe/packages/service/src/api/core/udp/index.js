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

function ArrayBufferToBase64(buffer) {
  // 1. 将 ArrayBuffer 转为 Uint8Array（方便逐字节处理）
  const uint8Array = new Uint8Array(buffer);
  // 2. Base64 编码表（标准 RFC 4648）
  const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  const len = uint8Array.length;

  // 3. 核心编码逻辑：每 3 个字节转为 4 个 Base64 字符
  while (i < len) {
    // 读取 3 个字节（不足则补 0）
    const byte1 = uint8Array[i++] || 0;
    const byte2 = i < len ? uint8Array[i++] : 0;
    const byte3 = i < len ? uint8Array[i++] : 0;

    // 将 3 个字节（24 位）拆分为 4 个 6 位值
    const enc1 = byte1 >> 2; // 取第一个字节的前 6 位
    const enc2 = ((byte1 & 0x03) << 4) | (byte2 >> 4); // 第一个字节后 2 位 + 第二个字节前 4 位
    const enc3 = ((byte2 & 0x0F) << 2) | (byte3 >> 6); // 第二个字节后 4 位 + 第三个字节前 2 位
    const enc4 = byte3 & 0x3F; // 第三个字节后 6 位

    // 映射到 Base64 字符（不足时补填充符 =）
    result += b64Chars[enc1];
    result += b64Chars[enc2];
    result += i > len + 1 ? '=' : b64Chars[enc3]; // 不足 2 个字节时补 =
    result += i > len ? '=' : b64Chars[enc4];     // 不足 3 个字节时补 =
  }

  return result;
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

class UDPSocket {
  constructor(ret) {
    this.mid = ret.mid;
    this.socketId = ret.socketId;
    this._readyState = 0; // 0:未绑定 1:已绑定 2:关闭中 3:已关闭


  }



  /**
   * 绑定端口和地址（核心修复：原型方法 + 可序列化参数 + 回调处理）
   * @param {number} port 端口号（不传则随机）
   * @param {string} address 绑定地址，默认 0.0.0.0
   */
  bind(port, address = '0.0.0.0', opts = {}) {
    console.log(`【UDP UdpSocketApi】绑定端口: ${port || '随机端口'}，地址：${address}`);
    const params = {
      mid: this.mid,
      socketId: this.socketId,
      port,
      address
    }
    // 调用原生api
    const ret = invokeAPI('udpsocket.bind', params);
    console.log(`【UDP UdpSocketApi】 返回参数:`, ret);
    if (ret.port) {
      this._readyState = UDP_CONSTANTS.BOUND;
    }
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

    const { address, port, message, length, offset, setBroadcast } = options;
    console.log(`【UDP UdpSocketApi】发送消息到 ${address}:${port}，数据：`, message);

    let isArrayBuffer = false;
    let messageArrayBuffer = null;

    if (typeof message === 'string') {
      console.log('【UDP UdpSocketApi】发送 消息是字符串:', message);
      isArrayBuffer = false;
    } else {
      console.log('【UDP UdpSocketApi】发送 消息是ArrayBuffer,长度为:', message.byteLength);
      messageArrayBuffer = ArrayBufferToBase64(message);
      isArrayBuffer = true;
    }



    const params = {
      mid: this.mid,
      socketId: this.socketId,

      isArrayBuffer,

      length,//选填 长度
      offset,//偏移量，默认0
      setBroadcast,//是否广播发送，默认false

      address,//必填
      port,//必填
      message:isArrayBuffer?messageArrayBuffer:message,//必填
    };


    const ret = invokeAPI('udpsocket.send', params);
    console.log(`【UDP UdpSocketApi】发送消息返回 :`, ret);
    return ret;






    /*

    console.log(`【UDP UdpSocketApi】发送消息参数`, params);


    // 判断是否为字符串
    if (typeof message === 'string') {
      console.log('【UDP UdpSocketApi】发送 消息是字符串:', message);
      params.isArrayBuffer = false;
    }else if (message instanceof ArrayBuffer) {
      console.log('【UDP UdpSocketApi】发送 消息是ArrayBuffer,长度为:', message.byteLength);
      // params.message = ArrayBufferToBase64(message);
      params.isArrayBuffer = true;
      if(!params.length){
        params.length = message.byteLength;
      }
    }

    params.mid = this.mid;
    params.socketId = this.socketId;
    // address,//必填
    // port,//必填
    // message//必填



    const ret = invokeAPI('udpsocket.send', params);
    console.log(`【UDP UdpSocketApi】发送消息返回 :`, ret);
    return ret;
    */


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
        console.log(`【UDP UdpSocketApi】监听消息回调:`, res);
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




