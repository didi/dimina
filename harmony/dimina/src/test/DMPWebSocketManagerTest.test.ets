import { describe, beforeEach, afterEach, it, expect } from '@ohos/hypium';
import {
  CallbackRecord,
  captureCallback,
  connectAndCapture,
  countEventsByCallbackId,
  findEventByCallbackId,
  firstFailMessage,
  firstSuccessErrMsg,
  flushMicrotasks,
  makeTestSetup,
  newBinarySendParams,
  newConnectParams,
  newEmptyParams,
  newLegacyCodeParams,
  newLegacyEventParams,
  newLegacySendParams,
  newSendParams,
  newSocketIdCodeParams,
  newSocketIdCodeReasonParams,
  newSocketIdParams,
  newTaskEventParams,
  newTransportError,
  payloadCloseCode,
  payloadCloseReason,
  payloadErrMsg,
  payloadHeaderValue,
  payloadMessageData,
  payloadMessageIsBuffer,
  payloadKeys,
  TestSetup,
} from './DMPWebSocketTestSupport';

/**
 * 注入 fake 传输 + 可控时钟，使并发上限、事件互斥与顺序、后台宽限、遗留绑定、销毁、
 * 空闲超时等竞态用例确定性可测。
 *
 * fake 传输/时钟/回调捕获与 payload 读取均在 DMPWebSocketTestSupport.ts 中实现
 * （ArkTS 静态检查禁止本文件内联对象字面量类型/索引签名/any/嵌套 function 声明）。
 */
export default function dmpWebSocketManagerTest() {
  describe('DMPWebSocketManagerTest', () => {
    let setup: TestSetup = makeTestSetup();

    beforeEach(() => {
      setup = makeTestSetup();
    });

    afterEach(() => {
      teardownAfterEach(setup);
    });

    // ---------------- 并发 ----------------

    // 所有未终态连接共同占用名额；完整边界验收在 DMPWebSocketDiminaBehaviorTest。

    it('concurrency_6th_connect_fails_others_unaffected', 0, async () => {
      const appId = 'app-concurrency';
      for (let i = 0; i < 5; i++) {
        const calls = connectAndCapture(setup.manager, appId, 1, `s${i}`);
        await flushMicrotasks();
        expect(firstSuccessErrMsg(calls)).assertEqual('connectSocket:ok');
        setup.createdTransports[i].fireOpen();
      }
      const sixth = connectAndCapture(setup.manager, appId, 1, 's5');
      await flushMicrotasks();
      expect(firstFailMessage(sixth)).assertEqual('connectSocket:fail fail reach max websocket connect count 5');
    });

    it('concurrency_different_owners_do_not_share_quota', 0, async () => {
      for (let i = 0; i < 5; i++) {
        connectAndCapture(setup.manager, 'owner-a', 1, `a${i}`);
        await flushMicrotasks();
        setup.createdTransports[i].fireOpen();
      }
      const otherOwner = connectAndCapture(setup.manager, 'owner-b', 2, 'b0');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(otherOwner)).assertEqual('connectSocket:ok');
    });

    it('concurrency_slot_freed_after_close', 0, async () => {
      const appId = 'app-freed';
      for (let i = 0; i < 5; i++) {
        connectAndCapture(setup.manager, appId, 1, `s${i}`);
        await flushMicrotasks();
        setup.createdTransports[i].fireOpen();
      }
      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdParams('s0'), closeCap.fn);
      expect(firstSuccessErrMsg(closeCap.calls)).assertEqual('closeSocket:ok');
      // 名额在 close 事件到达时才归还，光发出 close 请求不算。
      setup.createdTransports[0].fireClose(1000, '');

      const retry = connectAndCapture(setup.manager, appId, 1, 's-new');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(retry)).assertEqual('connectSocket:ok');
    });

    // ---------------- 容器注入的请求头 ----------------

    it('dial_carries_container_referer_and_no_origin', 0, async () => {
      const cap = captureCallback();
      setup.manager.connectSocket('app-ref', 1, '37', newConnectParams('s0'), cap.fn);
      await flushMicrotasks();

      const t = setup.createdTransports[0];
      expect(t.dialedHeader('Referer')).assertEqual('https://servicedimina.com/app-ref/37/page-frame.html');
      // 微信文档对 header 只规定「不能设置 Referer」，没说容器会补 Origin，所以不补。
      // HarmonyOS 上 SDK 自己还会补一个，那是平台行为，不在 Manager 下发的 header 里。
      expect(t.dialedHeader('Origin')).assertEqual('');
    });

    it('dial_referer_falls_back_to_zero_when_app_version_unknown', 0, async () => {
      const cap = captureCallback();
      setup.manager.connectSocket('app-ref', 1, '', newConnectParams('s0'), cap.fn);
      await flushMicrotasks();

      expect(setup.createdTransports[0].dialedHeader('Referer'))
        .assertEqual('https://servicedimina.com/app-ref/0/page-frame.html');
    });

    // ---------------- 生命周期 ----------------

    it('lifecycle_open_omits_profile_when_harmony_cannot_measure_it', 0, async () => {
      connectAndCapture(setup.manager, 'app-open', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('open', 'app-open', newTaskEventParams('s0', 'cb-open'), captureCallback().fn);

      setup.scheduler.advance(10);
      t.fireHeaderReceive('x-server', 'dimina');
      t.fireOpen();

      const openEvt = findEventByCallbackId(setup.events, 'cb-open');
      expect(openEvt !== undefined).assertTrue();
      expect(payloadHeaderValue(openEvt!.payload, 'x-server')).assertEqual('dimina');
      expect(payloadKeys(openEvt!.payload)).assertEqual('header');
    });

    it('lifecycle_text_and_binary_message', 0, async () => {
      connectAndCapture(setup.manager, 'app-msg', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('message', 'app-msg', newTaskEventParams('s0', 'cb-msg'), captureCallback().fn);
      t.fireOpen();

      t.fireMessage('hello');
      // 逐字钉死编码结果，不是只要求「非空」——空的断言让编码表写错、字节顺序反转、
      // 只编第一个字节这几种改法全都照样绿。三字节走整组分支，四字节走带 `=` 的收尾分支。
      t.fireMessage(new Uint8Array([1, 2, 3]).buffer);
      t.fireMessage(new Uint8Array([1, 2, 3, 4]).buffer);

      expect(countEventsByCallbackId(setup.events, 'cb-msg')).assertEqual(3);
      const msgEvents = setup.events.filter((e) => e.callbackId === 'cb-msg');
      expect(payloadMessageData(msgEvents[0].payload)).assertEqual('hello');
      expect(payloadMessageIsBuffer(msgEvents[1].payload)).assertTrue();
      expect(payloadMessageData(msgEvents[1].payload)).assertEqual('AQID');
      expect(payloadMessageIsBuffer(msgEvents[2].payload)).assertTrue();
      expect(payloadMessageData(msgEvents[2].payload)).assertEqual('AQIDBA==');
    });

    it('lifecycle_server_close_reports_code_and_reason', 0, async () => {
      connectAndCapture(setup.manager, 'app-close', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', 'app-close', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      t.fireClose(1005, 'server done');

      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(1005);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('server done');

      // 已终态：再次 close 应报 not connected
      const closeCap = captureCallback();
      setup.manager.closeSocket('app-close', newSocketIdParams('s0'), closeCap.fn);
      expect(firstFailMessage(closeCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');
    });

    it('lifecycle_handshake_failure_only_error_no_close', 0, async () => {
      connectAndCapture(setup.manager, 'app-fail', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('error', 'app-fail', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      setup.manager.onSocketEvent('close', 'app-fail', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);

      t.fireError('handshake refused');
      // 传输层随后仍可能吐出迟到的 close，应被丢弃（未知/已移除 socketId）
      t.fireClose(1002, 'late');

      expect(findEventByCallbackId(setup.events, 'cb-err') !== undefined).assertTrue();
      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();
    });

    it('lifecycle_close_before_open_reports_generic_error_and_never_leaks_wire_reason', 0, async () => {
      // 握手还没完成就收到 close 时，reason 完全由服务端决定，不能变成 API 层的错误串，
      // 三端在这条路径上都只报通用文案。
      connectAndCapture(setup.manager, 'app-preopen-close', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('error', 'app-preopen-close', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      setup.manager.onSocketEvent('close', 'app-preopen-close', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);

      t.fireClose(1002, 'policy denied');

      const errEvt = findEventByCallbackId(setup.events, 'cb-err');
      expect(errEvt !== undefined).assertTrue();
      expect(payloadErrMsg(errEvt!.payload)).assertEqual('connectSocket:fail WebSocket connection failed');
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();
    });

    /*
     * `connect()` 的结果回调与 open / message / close 三个事件回调，第一个参数都是
     * BusinessError；带错时第二个参数可能是 undefined。下面四条各自守住一处判错分支，
     * 断言选的都是「拿掉判错之后会变成什么」，而不是只看有没有 error 事件：
     * 拿掉 open 的判错会让连接进入 OPEN，拿掉 message 的会派发一条空的二进制消息，
     * 拿掉 close 的会按默认码报一次正常关闭，拿掉 connect 的则什么都不报。
     */

    it('transport_connect_callback_error_reports_error', 0, async () => {
      setup.pendingConnectError = newTransportError('dial refused');
      connectAndCapture(setup.manager, 'app-dial-err', 1, 's0');
      setup.manager.onSocketEvent('error', 'app-dial-err', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      await flushMicrotasks();

      const errEvt = findEventByCallbackId(setup.events, 'cb-err');
      expect(errEvt !== undefined).assertTrue();
      expect(payloadErrMsg(errEvt!.payload)).assertEqual('connectSocket:fail WebSocket connection failed');
    });

    it('transport_open_callback_error_does_not_open_the_connection', 0, async () => {
      connectAndCapture(setup.manager, 'app-open-err', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('open', 'app-open-err', newTaskEventParams('s0', 'cb-open'), captureCallback().fn);
      setup.manager.onSocketEvent('error', 'app-open-err', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      t.fireOpenError('handshake aborted');

      expect(findEventByCallbackId(setup.events, 'cb-open') === undefined).assertTrue();
      expect(payloadErrMsg(findEventByCallbackId(setup.events, 'cb-err')!.payload))
        .assertEqual('connectSocket:fail WebSocket connection failed');
      // 连接没进 OPEN，所以后续的 send 只能失败——这一条才是「没被打开」的证据。
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage('app-open-err', newSendParams('s0', 'ping'), sendCap.fn);
      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');
      expect(t.sendCalls.length).assertEqual(0);
    });

    it('transport_message_callback_error_does_not_deliver_an_empty_frame', 0, async () => {
      connectAndCapture(setup.manager, 'app-msg-err', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('message', 'app-msg-err', newTaskEventParams('s0', 'cb-msg'), captureCallback().fn);
      setup.manager.onSocketEvent('error', 'app-msg-err', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      t.fireOpen();

      t.fireMessageError('receive failed');

      expect(countEventsByCallbackId(setup.events, 'cb-msg')).assertEqual(0);
      expect(findEventByCallbackId(setup.events, 'cb-err') !== undefined).assertTrue();
    });

    it('transport_close_callback_error_is_not_reported_as_a_normal_close', 0, async () => {
      connectAndCapture(setup.manager, 'app-close-err', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', 'app-close-err', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      setup.manager.onSocketEvent('error', 'app-close-err', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      t.fireOpen();

      t.fireCloseError('close failed');

      // 带错的 close 回调走的是传输失败那条路：先报 error，再本地合成一个 1006 的 close。
      // 不判错直接当成正常关闭的话，既不会有 error，close 的 code 也会变成默认的那个。
      expect(findEventByCallbackId(setup.events, 'cb-err') !== undefined).assertTrue();
      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(1006);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('');
    });

    // ---------------- 后台/前台 ----------------

    it('background_grace_expired_open_connection_gets_close_1006', 0, async () => {
      connectAndCapture(setup.manager, 'app-bg-open', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', 'app-bg-open', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      setup.manager.onSocketEvent('error', 'app-bg-open', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      t.fireOpen();

      setup.manager.setAllBackgrounded(true);
      setup.scheduler.advance(5000);

      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(1006);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('interrupted');
      expect(findEventByCallbackId(setup.events, 'cb-err') === undefined).assertTrue();
      // 1006 是 RFC6455 保留的仅供上报码，不能真的发给 wire：JS 侧仍报 1006，
      // 但发给真实 transport.close() 的 code 必须是合法值。
      const lastClose = t.closeCalls[t.closeCalls.length - 1];
      expect(lastClose.code).assertEqual(1000);
    });

    it('transport_error_on_open_connection_frees_slot_even_without_native_close', 0, async () => {
      const appId = 'app-error-frees-slot';
      for (let i = 0; i < 5; i++) {
        connectAndCapture(setup.manager, appId, 1, `s${i}`);
        await flushMicrotasks();
        setup.createdTransports[i].fireOpen();
      }
      const t4 = setup.createdTransports[4];
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s4', 'cb-err'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s4', 'cb-close'), captureCallback().fn);

      // 传输层报错后，故意不再触发任何原生 close 事件（模拟 @ohos.net.webSocket
      // 未必总会在 error 后补发 close 的场景）——slot 必须仍然被释放。
      t4.fireError('network lost');

      expect(findEventByCallbackId(setup.events, 'cb-err') !== undefined).assertTrue();
      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(1006);
      expect(countEventsByCallbackId(setup.events, 'cb-close')).assertEqual(1);
      // Freeing the JS-facing slot isn't enough — the real native transport must also be
      // torn down, not just have its listeners detached.
      expect(t4.closeCalls.length).assertEqual(1);

      const sixth = connectAndCapture(setup.manager, appId, 1, 's5');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(sixth)).assertEqual('connectSocket:ok');
    });

    it('client_close_in_flight_then_transport_error_emits_close_only_with_requested_code', 0, async () => {
      // A transport failure while a CLIENT-initiated close is already in flight must report
      // close only (never error), with the CALLER's originally-requested code/reason, not
      // the synthesized 1006 fallback.
      const appId = 'app-close-in-flight-then-error';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.manager.closeSocket(appId, newSocketIdCodeReasonParams('s0', 4001, 'bye'), captureCallback().fn);
      t.fireError('boom');

      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(4001);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('bye');
      expect(countEventsByCallbackId(setup.events, 'cb-close')).assertEqual(1);
      expect(findEventByCallbackId(setup.events, 'cb-err') === undefined).assertTrue();
    });

    it('new_owner_created_while_backgrounded_fails_interrupted', 0, async () => {
      const appId = 'app-new-owner-while-bg';
      setup.manager.setAllBackgrounded(true);

      const connectCap = connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      expect(firstFailMessage(connectCap)).assertEqual('connectSocket:fail interrupted');

      setup.manager.setAllBackgrounded(false);
      const retry = connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(retry)).assertEqual('connectSocket:ok');
    });

    it('legacy_close_does_not_corrupt_inflight_task_close_code', 0, async () => {
      const appId = 'app-legacy-vs-task-close';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      const taskCloseCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdCodeParams('s0', 4000), taskCloseCap.fn);
      expect(firstSuccessErrMsg(taskCloseCap.calls)).assertEqual('closeSocket:ok');

      // 遗留 closeSocket 命中同一个已在 CLOSING 的绑定连接：收敛为
      // not connected（而不是 ok），且底层必须是 no-op —— 不能覆盖第一次请求
      // 的 code，也不能发起第二次 transport.close()。
      const legacyCloseCap = captureCallback();
      setup.manager.closeSocket(appId, newEmptyParams(), legacyCloseCap.fn);
      expect(firstFailMessage(legacyCloseCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');

      t.fireClose(4000, '');
      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(4000);
      expect(t.closeCalls.length).assertEqual(1);
    });

    it('send_binary_with_invalid_base64_fails_instead_of_corrupting_bytes', 0, async () => {
      const appId = 'app-bad-base64';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newBinarySendParams('s0', 'abc!'), sendCap.fn);
      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail data must be string or ArrayBuffer');
      expect(t.sendCalls.length).assertEqual(0);
    });

    it('send_binary_with_embedded_whitespace_fails_matching_android_ios_strictness', 0, async () => {
      // The decoder used to strip whitespace before validating, so "Y Q==" (a space in the
      // middle) was wrongly accepted - Android's Base64.getDecoder() and iOS's
      // Data(base64Encoded:) both reject it.
      const appId = 'app-bad-base64-whitespace';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newBinarySendParams('s0', 'Y Q=='), sendCap.fn);
      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail data must be string or ArrayBuffer');
      expect(t.sendCalls.length).assertEqual(0);
    });

    it('idle_timeout_mid_closing_does_not_override_pending_user_close', 0, async () => {
      const appId = 'app-idle-vs-close';
      setup.manager.setIdleTimeoutMs(1000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      setup.scheduler.advance(500);
      setup.manager.closeSocket(appId, newSocketIdCodeParams('s0', 4000), captureCallback().fn);
      // 空闲超时的到期点（open 时起 1000ms）本应在此之后触发；用户 close 必须赢：
      // 不能被空闲超时覆盖成 {1006,'idle timeout'}。
      setup.scheduler.advance(600);
      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();

      t.fireClose(4000, '');
      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(4000);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('');
    });

    it('background_grace_expired_handshaking_connection_gets_error_interrupted', 0, async () => {
      connectAndCapture(setup.manager, 'app-bg-handshake', 1, 's0'); // 不 fireOpen，模拟仍在握手
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', 'app-bg-handshake', newTaskEventParams('s0', 'cb-err'), captureCallback().fn);
      setup.manager.onSocketEvent('close', 'app-bg-handshake', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);

      setup.manager.setAllBackgrounded(true);
      setup.scheduler.advance(5000);

      const errEvt = findEventByCallbackId(setup.events, 'cb-err');
      expect(errEvt !== undefined).assertTrue();
      expect(payloadErrMsg(errEvt!.payload)).assertEqual('connectSocket:fail interrupted');
      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();
    });

    it('background_return_before_grace_expiry_cancels_teardown', 0, async () => {
      connectAndCapture(setup.manager, 'app-bg-cancel', 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', 'app-bg-cancel', newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      setup.manager.setAllBackgrounded(true);
      setup.scheduler.advance(4000);
      setup.manager.setAllBackgrounded(false);
      setup.scheduler.advance(5000);

      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();
      // 仍存活：sendSocketMessage 应可成功
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage('app-bg-cancel', newSendParams('s0', 'ping'), sendCap.fn);
      expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');
    });

    it('background_all_three_apis_fail_interrupted_while_backgrounded', 0, async () => {
      const appId = 'app-bg-apis';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      setup.manager.setAllBackgrounded(true);

      const connectCap = connectAndCapture(setup.manager, appId, 1, 's-new');
      expect(firstFailMessage(connectCap)).assertEqual('connectSocket:fail interrupted');

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newSendParams('s0', 'x'), sendCap.fn);
      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail interrupted');

      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdParams('s0'), closeCap.fn);
      expect(firstFailMessage(closeCap.calls)).assertEqual('closeSocket:fail interrupted');
    });

    // ---------------- 遗留全局 API ----------------

    // 新契约：全局遗留监听是「有序去重集合」（与任务态 DMPWebSocketListenerSet 同构），
    // 不再是单槽位覆盖式（旧行为见已删除的 legacy_slot_overwrite_no_stacking）。

    it('legacy_ordered_set_multiple_ids_receive_event_in_registration_order', 0, async () => {
      const appId = 'app-legacy-multi-open';
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id1'), captureCallback().fn);
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id2'), captureCallback().fn);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      expect(countEventsByCallbackId(setup.events, 'id1')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'id2')).assertEqual(1);
      const openEvents = setup.events.filter((e) => e.callbackId === 'id1' || e.callbackId === 'id2');
      expect(openEvents.length).assertEqual(2);
      expect(openEvents[0].callbackId).assertEqual('id1');
      expect(openEvents[1].callbackId).assertEqual('id2');
    });

    it('legacy_duplicate_registration_of_same_id_receives_event_once', 0, async () => {
      const appId = 'app-legacy-dedup';
      const dupCb = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('dup-id'), dupCb.fn);
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('dup-id'), dupCb.fn);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[0].fireOpen();

      expect(countEventsByCallbackId(setup.events, 'dup-id')).assertEqual(1);
    });

    it('legacy_off_with_callback_id_removes_only_that_id', 0, async () => {
      const appId = 'app-legacy-off-one';
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id-keep'), captureCallback().fn);
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id-remove'), captureCallback().fn);
      setup.manager.offSocketEvent('open', appId, newLegacyEventParams('id-remove'), captureCallback().fn);

      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[0].fireOpen();

      expect(countEventsByCallbackId(setup.events, 'id-keep')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'id-remove')).assertEqual(0);
    });

    it('legacy_off_without_callback_id_clears_all_ids_for_that_event', 0, async () => {
      const appId = 'app-legacy-off-all';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('c1'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('c2'), captureCallback().fn);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      // sanity：清空之前，c1/c2 都已经是真正注册上的（不是被单槽位覆盖掉的）
      t.fireClose(1000, 'first');
      expect(countEventsByCallbackId(setup.events, 'c1')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'c2')).assertEqual(1);

      setup.manager.offSocketEvent('close', appId, newEmptyParams(), captureCallback().fn);

      // s0 已终态（fireClose 后从 map 移除），legacy 绑定漂移到新连接 s1，
      // 借此再触发一次 close 验证 c1/c2 都已被摘除、不会再收到事件。
      connectAndCapture(setup.manager, appId, 1, 's1');
      await flushMicrotasks();
      const t2 = setup.createdTransports[1];
      t2.fireOpen();
      t2.fireClose(1000, 'second');

      expect(countEventsByCallbackId(setup.events, 'c1')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'c2')).assertEqual(1);
    });

    it('legacy_off_for_one_event_leaves_other_events_and_other_ids_intact', 0, async () => {
      const appId = 'app-legacy-off-cross-event';
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('other-id'), captureCallback().fn);
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('shared-id'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('shared-id'), captureCallback().fn);

      setup.manager.offSocketEvent('open', appId, newLegacyEventParams('shared-id'), captureCallback().fn);

      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      expect(countEventsByCallbackId(setup.events, 'other-id')).assertEqual(1); // 未被摘除的 id 不受影响
      expect(countEventsByCallbackId(setup.events, 'shared-id')).assertEqual(0); // open 上已摘除

      t.fireClose(1000, '');
      expect(countEventsByCallbackId(setup.events, 'shared-id')).assertEqual(1); // close 上的注册不受 open 上的摘除影响
    });

    it('legacy_owner_dispose_clears_all_registered_ids', 0, async () => {
      const appId = 'app-legacy-dispose-listeners';
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id-before-dispose'), captureCallback().fn);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[0].fireOpen();
      expect(countEventsByCallbackId(setup.events, 'id-before-dispose')).assertEqual(1);

      setup.manager.disposeOwner(appId);

      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[1].fireOpen();

      // owner 已重置：旧 id 的注册不会残留到新 owner
      expect(countEventsByCallbackId(setup.events, 'id-before-dispose')).assertEqual(1);
    });

    it('legacy_binds_to_first_live_connection_and_does_not_drift', 0, async () => {
      const appId = 'app-legacy-bind';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('legacy-close'), captureCallback().fn);

      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();

      // legacy sendSocketMessage 应打到 A（首活绑定），不是 B
      const tA = setup.createdTransports[0];
      tA.fireOpen();
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('hi'), sendCap.fn);
      expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');
      expect(tA.sendCalls.length).assertEqual(1);

      // 关闭 A（任务态，OPEN 状态需走真实关闭握手）：绑定不漂移到 B
      setup.manager.closeSocket(appId, newSocketIdParams('A'), captureCallback().fn);
      tA.fireClose(1000, ''); // 完成关闭握手，A 才真正从 map 移除（变为"死"）
      const sendAfterAClosed = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('hi2'), sendAfterAClosed.fn);
      expect(firstFailMessage(sendAfterAClosed.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');

      // 仅下一次 connect 且绑定已死才改绑到 C
      connectAndCapture(setup.manager, appId, 1, 'C');
      await flushMicrotasks();
      const tC = setup.createdTransports[2];
      tC.fireOpen();
      const sendToC = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('hi3'), sendToC.fn);
      expect(firstSuccessErrMsg(sendToC.calls)).assertEqual('sendSocketMessage:ok');
      expect(tC.sendCalls.length).assertEqual(1);
    });

    it('legacy_close_with_dead_binding_does_not_touch_other_tasks', 0, async () => {
      const appId = 'app-legacy-dead-binding';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('legacy-close'), captureCallback().fn);
      // A/B/C 全部先连上（A 存活期间 B/C 连接都不会改绑，绑定始终是首个存活连接 A）
      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      connectAndCapture(setup.manager, appId, 1, 'C');
      await flushMicrotasks();
      const tB = setup.createdTransports[1];
      const tC = setup.createdTransports[2];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('B', 'b-close'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('C', 'c-close'), captureCallback().fn);
      tB.fireOpen();
      tC.fireOpen();

      // A 此时仍处 CONNECTING（未 fireOpen），任务态关闭立即从 map 移除 -> 绑定成为"死"绑定，
      // 且由于关闭 A 之后没有再发生任何 connectSocket 调用，不会触发改绑。
      setup.manager.closeSocket(appId, newSocketIdParams('A'), captureCallback().fn);

      const legacyCloseCap = captureCallback();
      setup.manager.closeSocket(appId, newEmptyParams(), legacyCloseCap.fn);
      expect(firstFailMessage(legacyCloseCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');
      expect(tB.closeCalls.length).assertEqual(0);
      expect(tC.closeCalls.length).assertEqual(0);
      expect(findEventByCallbackId(setup.events, 'b-close') === undefined).assertTrue();
      expect(findEventByCallbackId(setup.events, 'c-close') === undefined).assertTrue();
    });

    it('legacy_close_with_an_invalid_code_fails_that_call_only_and_leaves_the_bound_connection_open', 0, async () => {
      // Invalid parameters fail without touching the bound connection or other SocketTasks.
      const appId = 'app-legacy-invalid-code-bound';
      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      const tA = setup.createdTransports[0];
      const tB = setup.createdTransports[1];
      tA.fireOpen();
      tB.fireOpen();

      const legacyCloseCap = captureCallback();
      setup.manager.closeSocket(appId, newLegacyCodeParams(500), legacyCloseCap.fn);

      expect(firstFailMessage(legacyCloseCap.calls)).assertEqual('closeSocket:fail invalid code');
      expect(tA.closeCalls.length).assertEqual(0);
      expect(tB.closeCalls.length).assertEqual(0);
    });

    it('legacy_close_hitting_closing_binding_does_not_touch_other_tasks', 0, async () => {
      // Distinct from the dead/never-opened-binding case above - here the bound target is
      // OPEN, gets moved to CLOSING by a first global close, then receives another global close.
      const appId = 'app-legacy-closing-invalid-code';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('legacy-close'), captureCallback().fn);
      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      setup.createdTransports[0].fireOpen();
      const tB = setup.createdTransports[1];
      tB.fireOpen();
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('B', 'b-close'), captureCallback().fn);

      // First legacy close moves the bound target (A) to CLOSING.
      setup.manager.closeSocket(appId, newEmptyParams(), captureCallback().fn);

      const legacyCloseCap = captureCallback();
      setup.manager.closeSocket(appId, newLegacyCodeParams(5000), legacyCloseCap.fn);

      expect(firstFailMessage(legacyCloseCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');
      expect(tB.closeCalls.length).assertEqual(0);
      expect(findEventByCallbackId(setup.events, 'b-close') === undefined).assertTrue();
    });

    it('legacy_close_does_not_take_over_a_task_mode_closing_binding',
      0, async () => {
        // Global close does not close or reroute a target already closing through SocketTask.close().
        const appId = 'app-legacy-close-frees-task-closing-binding';
        connectAndCapture(setup.manager, appId, 1, 'A');
        await flushMicrotasks();
        const tA = setup.createdTransports[0];
        tA.fireOpen();

        // Task-mode close leaves `A` CLOSING without marking it closed-by-global-door.
        setup.manager.closeSocket(appId, newSocketIdParams('A'), captureCallback().fn);

        // Global close reports not-connected against the CLOSING binding.
        const legacyCloseCap = captureCallback();
        setup.manager.closeSocket(appId, newEmptyParams(), legacyCloseCap.fn);
        expect(firstFailMessage(legacyCloseCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');

        // A fresh SocketTask may connect, but Dimina's unspecified global route remains unchanged.
        connectAndCapture(setup.manager, appId, 1, 'B');
        await flushMicrotasks();
        const tB = setup.createdTransports[1];
        tB.fireOpen();

        const sendCap = captureCallback();
        setup.manager.sendSocketMessage(appId, newLegacySendParams('hi'), sendCap.fn);

        expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');
        expect(tB.sendCalls.length).assertEqual(0);
        expect(tA.sendCalls.length).assertEqual(0);
      });

    it('onOff_registration_success_payload_carries_correct_errMsg', 0, async () => {
      // The completion used to resolve to an empty payload instead of the Android/iOS
      // "onSocketXxx:ok"/"offSocketXxx:ok" convention.
      const appId = 'app-onoff-errmsg';
      const onCap = captureCallback();
      setup.manager.onSocketEvent('message', appId, newTaskEventParams('s0', 'cb-msg'), onCap.fn);
      expect(firstSuccessErrMsg(onCap.calls)).assertEqual('onSocketMessage:ok');

      const offCap = captureCallback();
      setup.manager.offSocketEvent('message', appId, newTaskEventParams('s0', 'cb-msg'), offCap.fn);
      expect(firstSuccessErrMsg(offCap.calls)).assertEqual('offSocketMessage:ok');

      const onLegacyCap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('legacy-open'), onLegacyCap.fn);
      expect(firstSuccessErrMsg(onLegacyCap.calls)).assertEqual('onSocketOpen:ok');
    });

    // ---------------- 销毁 ----------------

    it('disposeOwner_is_silent_and_clears_timers_and_state', 0, async () => {
      const appId = 'app-dispose';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('legacy-close'), captureCallback().fn);
      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('legacy-err'), captureCallback().fn);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      setup.manager.disposeOwner(appId);

      expect(setup.events.length).assertEqual(0); // 全静默

      // 定时器已清空：即便推进很久也不应再有事件（没有 owner 了，advance 也应安全无副作用）
      setup.scheduler.advance(100000);
      expect(setup.events.length).assertEqual(0);

      // 同 appId 重开为全新状态：同一个 socketId 可再次使用
      const fresh = connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(fresh)).assertEqual('connectSocket:ok');
    });

    // ---------------- 空闲超时 ----------------

    it('idle_timeout_resets_on_traffic_and_fires_close_1006', 0, async () => {
      const appId = 'app-idle';
      setup.manager.setIdleTimeoutMs(1000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      setup.scheduler.advance(900);
      t.fireMessage('keep-alive'); // 重置计时
      setup.scheduler.advance(900);
      expect(findEventByCallbackId(setup.events, 'cb-close') === undefined).assertTrue();

      setup.scheduler.advance(1000); // 距上次流量已超过 1000ms
      const closeEvt = findEventByCallbackId(setup.events, 'cb-close');
      expect(closeEvt !== undefined).assertTrue();
      expect(payloadCloseCode(closeEvt!.payload)).assertEqual(1006);
      expect(payloadCloseReason(closeEvt!.payload)).assertEqual('idle timeout');
    });

    // ---------------- 迟到的 send 结果 ----------------

    it('send_completion_after_dispose_owner_is_dropped_and_arms_no_timer', 0, async () => {
      // 连接被拆掉之后传输层还会异步回一次结果。owner 已经销毁时它对应的 JS 上下文也没了，
      // 这时候再回调等于打进一个不存在的上下文，重排空闲定时器还会把已移除的 entry 留到超时。
      const appId = 'app-late-send-dispose';
      setup.manager.setIdleTimeoutMs(1000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      t.deferSendCompletions = true;
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newSendParams('s0', 'ping'), sendCap.fn);
      expect(sendCap.calls.length).assertEqual(0);

      setup.manager.disposeOwner(appId);
      setup.events.length = 0;
      t.flushSendCompletions();

      expect(sendCap.calls.length).assertEqual(0);
      setup.scheduler.advance(100000);
      expect(setup.events.length).assertEqual(0);
    });

    it('send_completion_after_close_still_settles_but_arms_no_idle_timer', 0, async () => {
      // 普通关闭跟销毁不一样：JS 上下文还在，调用方的回调必须结算，只是不能把空闲定时器复活。
      const appId = 'app-late-send-close';
      setup.manager.setIdleTimeoutMs(1000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'cb-close'), captureCallback().fn);
      t.fireOpen();

      t.deferSendCompletions = true;
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newSendParams('s0', 'ping'), sendCap.fn);

      setup.manager.closeSocket(appId, newSocketIdParams('s0'), captureCallback().fn);
      t.fireClose(1000, ''); // 传输层确认关闭，entry 从 owner 上摘掉
      t.flushSendCompletions();

      expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');

      setup.scheduler.advance(100000);
      expect(countEventsByCallbackId(setup.events, 'cb-close')).assertEqual(1);
    });
  });
}

function teardownAfterEach(setup: TestSetup): void {
  setup.manager.setEventSinkForTest(null);
  setup.manager.resetTransportFactoryForTest();
  setup.manager.resetSchedulerForTest();
  setup.manager.resetAllForTest();
}
