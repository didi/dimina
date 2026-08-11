import { describe, beforeEach, afterEach, it, expect } from '@ohos/hypium';
import { DMPWebSocketValidation } from '../main/ets/Bridges/Network/DMPWebSocketManager';
import {
  CallbackRecord,
  captureCallback,
  connectAndCapture,
  connectWithParams,
  countEventsByCallbackId,
  findEventByCallbackId,
  firstFailMessage,
  firstSuccessErrMsg,
  flushMicrotasks,
  makeTestSetup,
  newConnectParamsWithTimeout,
  newConnectParamsWithUrl,
  newLegacyEventParams,
  newSocketIdCodeParams,
  newTaskEventParams,
  openConnections,
  payloadErrMsg,
  payloadHeaderValue,
  payloadKeys,
  TestSetup,
  updateNetworkTimeout,
} from './DMPWebSocketTestSupport';

/** 超并发那条错误串逐字带两个 `fail`，见 max_connections 组的注释。 */
const MAX_CONNECT_ERR_MSG = 'connectSocket:fail fail reach max websocket connect count 5';

/** HarmonyOS WebSocket 的公开能力与 Dimina 平台行为测试。 */
export default function dmpWebSocketDiminaBehaviorTest() {
  describe('DMPWebSocketDiminaBehaviorTest', () => {
    let setup: TestSetup = makeTestSetup();

    beforeEach(() => {
      setup = makeTestSetup();
    });

    afterEach(() => {
      setup.manager.setEventSinkForTest(null);
      setup.manager.resetTransportFactoryForTest();
      setup.manager.resetSchedulerForTest();
      setup.manager.resetAllForTest();
    });

    // ---------------- 并发上限与名额口径 ----------------

    /**
     * 上限文案逐字带两个 `fail`：微信的 `FE` 按 `${name}:fail ${errMsg}` 拼串，而传进去的
     * errMsg 本身就以 `fail ` 开头，重复的那个词是每个小程序实际收到的字面输出。收敛成
     * 一个 `fail` 是调用方可见的静默偏差。
     */
    it('max_connections_sixth_connect_against_five_open_fails_with_doubled_fail_text', 0, async () => {
      const appId = 'contract-max-doubled-fail';
      await openConnections(setup, appId, ['s0', 's1', 's2', 's3', 's4']);

      const sixth = connectAndCapture(setup.manager, appId, 1, 's5');
      await flushMicrotasks();

      expect(firstFailMessage(sixth)).assertEqual(MAX_CONNECT_ERR_MSG);
      // 被拒的连接一次都不能碰网络：不允许出现第六个传输层。
      expect(setup.createdTransports.length).assertEqual(5);
    });

    /** 握手中的连接已经“同时存在”，第六条必须被拒绝。 */
    it('max_connections_sixth_simultaneous_handshake_is_rejected', 0, async () => {
      const appId = 'contract-six-handshakes';
      const results: CallbackRecord[][] = [];
      for (let i = 0; i < 6; i++) {
        results.push(connectAndCapture(setup.manager, appId, 1, `s${i}`));
      }
      await flushMicrotasks();

      for (let i = 0; i < 5; i++) {
        expect(firstFailMessage(results[i])).assertEqual('');
        expect(firstSuccessErrMsg(results[i])).assertEqual('connectSocket:ok');
      }
      expect(firstFailMessage(results[5])).assertEqual(MAX_CONNECT_ERR_MSG);
      expect(setup.createdTransports.length).assertEqual(5);
    });

    it('max_connections_four_open_plus_one_pending_rejects_another_connect', 0, async () => {
      const appId = 'contract-four-open-plus-pending';
      await openConnections(setup, appId, ['open0', 'open1', 'open2', 'open3']);
      connectAndCapture(setup.manager, appId, 1, 'pending');
      await flushMicrotasks();

      const extra = connectAndCapture(setup.manager, appId, 1, 'extra');
      await flushMicrotasks();

      expect(firstFailMessage(extra)).assertEqual(MAX_CONNECT_ERR_MSG);
      expect(setup.createdTransports.length).assertEqual(5);
    });

    /**
     * 名额在 close **事件**到达时才归还，不在发起 close 请求时提前归还。提前归还会让
     * 「close 还没完成就再 connect」突破上限。
     */
    it('max_connections_slot_is_returned_on_the_close_event_not_on_the_close_request', 0, async () => {
      const appId = 'contract-slot-returned-on-event';
      const transports = await openConnections(setup, appId, ['s0', 's1', 's2', 's3', 's4']);

      setup.manager.closeSocket(appId, newSocketIdCodeParams('s0', 1000), captureCallback().fn);

      // s0 只是进了 CLOSING，握手尚未收尾，名额还没让出来。
      const duringClosing = connectAndCapture(setup.manager, appId, 1, 'during-closing');
      await flushMicrotasks();
      expect(firstFailMessage(duringClosing)).assertEqual(MAX_CONNECT_ERR_MSG);

      transports[0].fireClose(1000, '');

      const afterClose = connectAndCapture(setup.manager, appId, 1, 'after-close');
      await flushMicrotasks();
      expect(firstFailMessage(afterClose)).assertEqual('');
      expect(firstSuccessErrMsg(afterClose)).assertEqual('connectSocket:ok');
    });

    /** 名额同样在 error 事件到达时归还。 */
    it('max_connections_slot_is_returned_on_the_error_event', 0, async () => {
      const appId = 'contract-slot-returned-on-error';
      const transports = await openConnections(setup, appId, ['s0', 's1', 's2', 's3', 's4']);

      transports[2].fireError('network lost');

      const retry = connectAndCapture(setup.manager, appId, 1, 'retry');
      await flushMicrotasks();
      expect(firstFailMessage(retry)).assertEqual('');
      expect(firstSuccessErrMsg(retry)).assertEqual('connectSocket:ok');
    });

    /** 名额是按小程序算的，一个小程序占满不影响另一个。 */
    it('max_connections_quota_is_per_mini_program', 0, async () => {
      await openConnections(setup, 'contract-owner-a', ['a0', 'a1', 'a2', 'a3', 'a4']);

      const other = connectAndCapture(setup.manager, 'contract-owner-b', 2, 'b0');
      await flushMicrotasks();
      expect(firstFailMessage(other)).assertEqual('');
      expect(firstSuccessErrMsg(other)).assertEqual('connectSocket:ok');
    });

    // ---------------- 事件载荷字段全集 ----------------

    /** HarmonyOS 无真实分段指标时暂不返回 profile，不能用回填值冒充。 */
    it('payload_task_open_carries_header_without_synthetic_profile', 0, async () => {
      const appId = 'contract-task-open-keys';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'task-open'), captureCallback().fn);

      const transport = setup.createdTransports[0];
      transport.fireHeaderReceive('x-server', 'dimina');
      transport.fireOpen();

      const evt = findEventByCallbackId(setup.events, 'task-open');
      expect(evt !== undefined).assertTrue();
      expect(payloadKeys(evt!.payload)).assertEqual('header');
      expect(payloadHeaderValue(evt!.payload, 'x-server')).assertEqual('dimina');
    });

    it('payload_global_and_task_open_both_carry_header_without_synthetic_profile', 0, async () => {
      const appId = 'contract-global-open-keys';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'task-open'), captureCallback().fn);
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('global-open'), captureCallback().fn);

      const transport = setup.createdTransports[0];
      transport.fireHeaderReceive('x-server', 'dimina');
      transport.fireOpen();

      const taskEvt = findEventByCallbackId(setup.events, 'task-open');
      const globalEvt = findEventByCallbackId(setup.events, 'global-open');
      expect(taskEvt !== undefined).assertTrue();
      expect(globalEvt !== undefined).assertTrue();
      expect(payloadKeys(taskEvt!.payload)).assertEqual('header');
      expect(payloadKeys(globalEvt!.payload)).assertEqual('header');
      expect(payloadHeaderValue(globalEvt!.payload, 'x-server')).assertEqual('dimina');
    });

    /**
     * 补发路径也要守同一条不变量：连上之后才注册的全局 open 监听收到的补发载荷同样只有
     * `header`。只在正常派发那条路上投影字段，补发这条路就会把 profile 漏给全局监听。
     */
    it('payload_global_open_replayed_to_a_late_listener_also_carries_header_only', 0, async () => {
      const appId = 'contract-global-open-replay-keys';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const transport = setup.createdTransports[0];
      transport.fireHeaderReceive('x-server', 'dimina');
      transport.fireOpen();

      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('late-global-open'), captureCallback().fn);

      const evt = findEventByCallbackId(setup.events, 'late-global-open');
      expect(evt !== undefined).assertTrue();
      expect(payloadKeys(evt!.payload)).assertEqual('header');
      expect(payloadHeaderValue(evt!.payload, 'x-server')).assertEqual('dimina');
    });

    /** close 载荷正好是 `{ code, reason }`：`wasClean` 是 W3C 的字段，微信从不发。 */
    it('payload_close_carries_exactly_code_and_reason_with_no_wasClean', 0, async () => {
      const appId = 'contract-close-keys';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'task-close'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('global-close'), captureCallback().fn);
      const transport = setup.createdTransports[0];
      transport.fireOpen();

      transport.fireClose(4001, 'server bye');

      const taskEvt = findEventByCallbackId(setup.events, 'task-close');
      const globalEvt = findEventByCallbackId(setup.events, 'global-close');
      expect(taskEvt !== undefined).assertTrue();
      expect(globalEvt !== undefined).assertTrue();
      expect(payloadKeys(taskEvt!.payload)).assertEqual('code,reason');
      expect(payloadKeys(globalEvt!.payload)).assertEqual('code,reason');
    });

    /** error 载荷正好是 `{ errMsg }`：运行时另带的 errCode 按「可以少实现」不发。 */
    it('payload_error_carries_exactly_errMsg', 0, async () => {
      const appId = 'contract-error-keys';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'task-error'), captureCallback().fn);
      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('global-error'), captureCallback().fn);

      setup.createdTransports[0].fireError('handshake refused');

      const taskEvt = findEventByCallbackId(setup.events, 'task-error');
      const globalEvt = findEventByCallbackId(setup.events, 'global-error');
      expect(taskEvt !== undefined).assertTrue();
      expect(globalEvt !== undefined).assertTrue();
      expect(payloadKeys(taskEvt!.payload)).assertEqual('errMsg');
      expect(payloadKeys(globalEvt!.payload)).assertEqual('errMsg');
    });

    // ---------------- app.json networkTimeout.connectSocket ----------------

    /*
     * 60000 毫秒是最后一级回落，不是唯一来源：app.json 的 `networkTimeout.connectSocket`
     * 夹在它和调用方之间。优先级是 调用方 `timeout` > app.json > 60000，且这项配置是按
     * 小程序算的。
     *
     * Manager 因此需要一个按 owner 登记解析结果的入口，形状与 Android 的
     * `updateNetworkTimeout(appId, connectSocketMs)` 一致，`null` 表示小程序没配这一项。
     *
     * `webSocket.WebSocketRequestOptions` 没有超时字段，鸿蒙的超时不下沉到传输层（这是
     * 平台限制），所以生效与否只能看容器自己那个连接计时器什么时候触发。
     */

    it('network_timeout_connect_timer_uses_app_json_value_when_the_caller_omits_timeout', 0, async () => {
      const appId = 'contract-appjson-timeout';
      updateNetworkTimeout(setup.manager, appId, 8000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(7999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(1);
      const evt = findEventByCallbackId(setup.events, 'cb-err');
      expect(evt !== undefined).assertTrue();
      // 超时只有这一条串：容器自己的计时器和传输层上报的超时共用它，调用方判「是不是
      // 超时」不该分两个分支。
      expect(payloadErrMsg(evt!.payload)).assertEqual('connectSocket:fail timeout');
    });

    it('network_timeout_caller_supplied_timeout_outranks_the_app_json_value', 0, async () => {
      const appId = 'contract-caller-beats-appjson';
      updateNetworkTimeout(setup.manager, appId, 8000);
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithTimeout('s0', 3000));
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(2999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    /**
     * `timeout` 非正数说不出任何截止时间，等同于「没指定」，要继续回落到 app.json，而不是
     * 就地钉死成 60000 的默认值。
     */
    it('network_timeout_non_positive_caller_timeout_falls_back_to_the_app_json_value', 0, async () => {
      const appId = 'contract-zero-timeout-falls-to-appjson';
      updateNetworkTimeout(setup.manager, appId, 8000);
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithTimeout('s0', 0));
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(7999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    /**
     * `timeout` 落在 (0, 1) 之间时，截断成整数毫秒就成了 0，可「调用方有没有指定」却是拿
     * 截断**之前**的原始值判的，于是 0.5 被当成「指定了 0 毫秒」，排出一个立即到期的计时器——
     * 连接还没来得及拨号就先超时了。有效 timeout 的下限是 1 毫秒，不足 1 毫秒按「没指定」
     * 处理，继续回落 app.json。
     */
    it('network_timeout_a_sub_millisecond_caller_timeout_is_treated_as_unspecified', 0, async () => {
      const appId = 'contract-sub-millisecond-timeout';
      updateNetworkTimeout(setup.manager, appId, 8000);
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithTimeout('s0', 0.5));
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(7999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    /** 防收紧过头：1 毫秒是合法的最小值，必须照原样生效，不能被一并当成「没指定」。 */
    it('network_timeout_one_millisecond_is_a_valid_caller_timeout', 0, async () => {
      const appId = 'contract-one-millisecond-timeout';
      updateNetworkTimeout(setup.manager, appId, 8000);
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithTimeout('s0', 1));
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      // 当成「没指定」就会去等 app.json 的 8000，这一刻拿不到事件。
      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    it('network_timeout_app_json_value_above_int32_max_falls_back_to_60000', 0, async () => {
      const appId = 'contract-oversized-appjson-timeout';
      updateNetworkTimeout(setup.manager, appId, 0x80000000);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(59999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);
      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    it('network_timeout_falls_back_to_60000_only_when_app_json_declares_none', 0, async () => {
      const appId = 'contract-no-appjson-timeout';
      updateNetworkTimeout(setup.manager, appId, null);
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      setup.scheduler.advance(59999);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(1);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    it('network_timeout_is_per_mini_program_and_does_not_leak_to_another', 0, async () => {
      updateNetworkTimeout(setup.manager, 'contract-timeout-app-a', 8000);
      const appB = 'contract-timeout-app-b';
      connectAndCapture(setup.manager, appB, 2, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appB, newTaskEventParams('s0', 'cb-err'), captureCallback().fn);

      // appB 没配，必须走 60000，不能沾上 appA 的 8000。
      setup.scheduler.advance(8000);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(0);

      setup.scheduler.advance(52000);
      expect(countEventsByCallbackId(setup.events, 'cb-err')).assertEqual(1);
    });

    // ---------------- url 协议 ----------------

    it('url_accepts_wss_in_either_case_and_rejects_ws', 0, () => {
      const lowerWs = DMPWebSocketValidation.validateUrl('ws://example.com/socket');
      expect(lowerWs.ok).assertFalse();

      const upperWs = DMPWebSocketValidation.validateUrl('WS://example.com/socket');
      expect(upperWs.ok).assertFalse();

      const lowerWss = DMPWebSocketValidation.validateUrl('wss://example.com/socket');
      expect(lowerWss.ok).assertTrue();
      expect(lowerWss.scheme).assertEqual('wss:');

      const upperWss = DMPWebSocketValidation.validateUrl('WSS://example.com/socket');
      expect(upperWss.ok).assertTrue();
      expect(upperWss.scheme).assertEqual('wss:');
    });

    it('url_rejects_every_scheme_that_is_not_wss', 0, () => {
      const schemes: string[] = ['http://example.com/socket', 'https://example.com/socket',
        'wsx://example.com/socket', 'ftp://example.com/socket', 'example.com/socket'];
      for (const raw of schemes) {
        const result = DMPWebSocketValidation.validateUrl(raw);
        expect(result.ok).assertFalse();
        expect(result.errMsg).assertEqual('invalid url');
      }
    });

    it('url_plain_ws_is_rejected_before_dial', 0, async () => {
      const appId = 'contract-plain-ws-rejected';
      const calls = connectWithParams(setup.manager, appId, 1,
        newConnectParamsWithUrl('s0', 'ws://example.com:8080/socket'));
      await flushMicrotasks();

      expect(firstFailMessage(calls)).assertEqual('connectSocket:fail invalid url');
      expect(setup.createdTransports.length).assertEqual(0);
    });

    // ---------------- close code 的传输层范围校验 ----------------

    /*
     * `@ohos.net.webSocket` 自己就会拒绝非法的 close code，RFC6455 的 1000 / [3000,4999]
     * 是传输层现实，不算 API 面的多实现。这一组把它锁在 closeSocket 这条真实调用链上，
     * 而不只锁在纯校验函数上。
     */

    it('close_code_transport_range_accepts_1000_and_the_3000_to_4999_range', 0, async () => {
      const appId = 'contract-close-code-ok';
      const codes: number[] = [1000, 3000, 4999];
      for (let i = 0; i < codes.length; i++) {
        const socketId = `s${i}`;
        connectAndCapture(setup.manager, appId, 1, socketId);
        await flushMicrotasks();
        setup.createdTransports[i].fireOpen();

        const closeCap = captureCallback();
        setup.manager.closeSocket(appId, newSocketIdCodeParams(socketId, codes[i]), closeCap.fn);
        expect(firstSuccessErrMsg(closeCap.calls)).assertEqual('closeSocket:ok');
        expect(setup.createdTransports[i].closeCalls[0].code).assertEqual(codes[i]);
      }
    });

    it('close_code_transport_range_rejects_codes_outside_1000_and_3000_to_4999', 0, async () => {
      const appId = 'contract-close-code-rejected';
      const codes: number[] = [999, 1001, 1006, 2999, 5000];
      for (let i = 0; i < codes.length; i++) {
        const socketId = `s${i}`;
        connectAndCapture(setup.manager, appId, 1, socketId);
        await flushMicrotasks();
        setup.createdTransports[i].fireOpen();

        const closeCap = captureCallback();
        setup.manager.closeSocket(appId, newSocketIdCodeParams(socketId, codes[i]), closeCap.fn);
        expect(firstFailMessage(closeCap.calls)).assertEqual('closeSocket:fail invalid code');
        // 被拒的 close 一次都不能碰传输层。
        expect(setup.createdTransports[i].closeCalls.length).assertEqual(0);
      }
    });
  });
}
