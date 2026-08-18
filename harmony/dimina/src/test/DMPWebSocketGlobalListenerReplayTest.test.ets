import { describe, beforeEach, afterEach, it, expect } from '@ohos/hypium';
import {
  captureCallback,
  connectAndCapture,
  countEventsByCallbackId,
  findEventByCallbackId,
  flushMicrotasks,
  makeTestSetup,
  newLegacyEventParams,
  newSocketIdParams,
  newTaskEventParams,
  payloadCloseCode,
  payloadCloseReason,
  payloadErrMsg,
  payloadHeaderValue,
  TestSetup,
} from './DMPWebSocketTestSupport';

/**
 * 全局 wx.onSocketXxx 监听（params 不带 socketId）注册时机与派发时机之间的竞态：
 * 原生一旦拨号就可能立刻产生 open/error/close，如果这些事件先于监听注册消息到达，
 * 监听器必须能收到当时已经派发过的那份终态载荷，而不是永久丢失。
 *
 * message 没有终态语义，不参与补发。
 */
export default function dmpWebSocketGlobalListenerReplayTest() {
  describe('DMPWebSocketGlobalListenerReplayTest', () => {
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

    it('legacy_global_open_listener_registered_after_open_receives_replayed_payload', 0, async () => {
      const appId = 'app-legacy-open-replay';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];

      const earlyCap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('early-open'), earlyCap.fn);
      t.fireHeaderReceive('x-server', 'dimina');
      t.fireOpen();
      const earlyEvt = findEventByCallbackId(setup.events, 'early-open');
      expect(earlyEvt !== undefined).assertTrue();

      // A second global listener registered after open already happened must not miss
      // the event: it gets the same payload replayed immediately upon registration.
      const lateCap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('late-open'), lateCap.fn);
      const lateEvt = findEventByCallbackId(setup.events, 'late-open');
      expect(lateEvt !== undefined).assertTrue();
      expect(payloadHeaderValue(lateEvt!.payload, 'x-server'))
        .assertEqual(payloadHeaderValue(earlyEvt!.payload, 'x-server'));
      expect(countEventsByCallbackId(setup.events, 'late-open')).assertEqual(1);

      // Replay must not re-fire the already-registered listener a second time.
      expect(countEventsByCallbackId(setup.events, 'early-open')).assertEqual(1);
    });

    it('legacy_global_error_listener_registered_after_error_receives_replayed_payload', 0, async () => {
      const appId = 'app-legacy-error-replay';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];

      const earlyCap = captureCallback();
      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('early-err'), earlyCap.fn);
      t.fireError('handshake refused');
      const earlyEvt = findEventByCallbackId(setup.events, 'early-err');
      expect(earlyEvt !== undefined).assertTrue();

      const lateCap = captureCallback();
      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('late-err'), lateCap.fn);
      const lateEvt = findEventByCallbackId(setup.events, 'late-err');
      expect(lateEvt !== undefined).assertTrue();
      expect(payloadErrMsg(lateEvt!.payload)).assertEqual(payloadErrMsg(earlyEvt!.payload));
      expect(countEventsByCallbackId(setup.events, 'late-err')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'early-err')).assertEqual(1);
    });

    it('legacy_global_close_listener_registered_after_close_receives_replayed_payload', 0, async () => {
      const appId = 'app-legacy-close-replay';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      const earlyCap = captureCallback();
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('early-close'), earlyCap.fn);
      t.fireClose(1005, 'server done');
      const earlyEvt = findEventByCallbackId(setup.events, 'early-close');
      expect(earlyEvt !== undefined).assertTrue();

      const lateCap = captureCallback();
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('late-close'), lateCap.fn);
      const lateEvt = findEventByCallbackId(setup.events, 'late-close');
      expect(lateEvt !== undefined).assertTrue();
      expect(payloadCloseCode(lateEvt!.payload)).assertEqual(payloadCloseCode(earlyEvt!.payload));
      expect(payloadCloseReason(lateEvt!.payload)).assertEqual(payloadCloseReason(earlyEvt!.payload));
      expect(countEventsByCallbackId(setup.events, 'late-close')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'early-close')).assertEqual(1);
    });

    it('legacy_global_message_listener_registered_after_message_does_not_replay', 0, async () => {
      const appId = 'app-legacy-message-no-replay';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      t.fireMessage('hello');

      const lateCap = captureCallback();
      setup.manager.onSocketEvent('message', appId, newLegacyEventParams('late-msg'), lateCap.fn);
      expect(countEventsByCallbackId(setup.events, 'late-msg')).assertEqual(0);

      // Registration itself still works normally for traffic arriving afterward.
      t.fireMessage('world');
      expect(countEventsByCallbackId(setup.events, 'late-msg')).assertEqual(1);
    });

    it('legacy_global_listener_with_no_prior_connection_receives_no_replay', 0, async () => {
      const appId = 'app-legacy-no-binding';
      const cap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('no-binding-open'), cap.fn);
      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('no-binding-err'), cap.fn);
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('no-binding-close'), cap.fn);

      expect(setup.events.length).assertEqual(0);
    });

    it('legacy_global_listener_registered_while_still_connecting_receives_no_replay', 0, async () => {
      const appId = 'app-legacy-still-connecting';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      // Deliberately no fireOpen/fireError/fireClose - the bound connection is still
      // mid-handshake, so no terminal event exists yet to replay.

      const cap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('still-connecting-open'), cap.fn);
      expect(countEventsByCallbackId(setup.events, 'still-connecting-open')).assertEqual(0);
    });

    it('legacy_global_open_replay_does_not_prevent_future_real_open_events', 0, async () => {
      const appId = 'app-legacy-open-replay-then-real';
      const idBeforeCap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id-before'), idBeforeCap.fn);

      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      const tA = setup.createdTransports[0];
      tA.fireOpen();
      expect(countEventsByCallbackId(setup.events, 'id-before')).assertEqual(1);

      // A second global listener registered after A already opened gets the replay.
      const idAfterCap = captureCallback();
      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('id-after'), idAfterCap.fn);
      expect(countEventsByCallbackId(setup.events, 'id-after')).assertEqual(1);

      // Kill A via a real close handshake so the legacy binding goes dead, then bring up
      // a new connection - a genuinely new open must still reach BOTH registered ids,
      // proving the replay did not consume or corrupt the ordered listener set.
      setup.manager.closeSocket(appId, newSocketIdParams('A'), captureCallback().fn);
      tA.fireClose(1000, '');

      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      const tB = setup.createdTransports[1];
      tB.fireOpen();

      expect(countEventsByCallbackId(setup.events, 'id-before')).assertEqual(2);
      expect(countEventsByCallbackId(setup.events, 'id-after')).assertEqual(2);
    });

    // 补发要跟监听注册的去重共用同一份判定：监听集合本身按 callback id 去重，同一个 id 注册
    // 两次，集合里只增加一份;补发不能绕开这份去重独立触发——已经收到过补发的 id 再注册一次，
    // 集合里没有新增任何东西，就不该再补发一份。任务态（params 带 socketId）和全局态
    // （params 不带 socketId）都要满足。

    it('task_open_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-task-open-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'dup-open'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-open')).assertEqual(1);

      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'dup-open'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-open')).assertEqual(1);
    });

    it('task_error_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-task-error-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireError('handshake refused');

      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'dup-err'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-err')).assertEqual(1);

      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'dup-err'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-err')).assertEqual(1);
    });

    it('task_close_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-task-close-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      t.fireClose(1005, 'server done');

      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'dup-close'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-close')).assertEqual(1);

      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'dup-close'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-close')).assertEqual(1);
    });

    it('legacy_global_open_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-global-open-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();

      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('dup-global-open'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-open')).assertEqual(1);

      setup.manager.onSocketEvent('open', appId, newLegacyEventParams('dup-global-open'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-open')).assertEqual(1);
    });

    it('legacy_global_error_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-global-error-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireError('handshake refused');

      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('dup-global-err'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-err')).assertEqual(1);

      setup.manager.onSocketEvent('error', appId, newLegacyEventParams('dup-global-err'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-err')).assertEqual(1);
    });

    it('legacy_global_close_replay_same_callback_id_registering_again_does_not_double_deliver', 0, async () => {
      const appId = 'app-global-close-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const t = setup.createdTransports[0];
      t.fireOpen();
      t.fireClose(1005, 'server done');

      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('dup-global-close'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-close')).assertEqual(1);

      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('dup-global-close'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'dup-global-close')).assertEqual(1);
    });

    it('normal_open_delivery_same_callback_id_registering_again_does_not_replay_stale_payload', 0, async () => {
      const appId = 'app-normal-open-dup';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const params = newTaskEventParams('s0', 'normal-open');
      setup.manager.onSocketEvent('open', appId, params, captureCallback().fn);
      setup.createdTransports[0].fireOpen();
      expect(countEventsByCallbackId(setup.events, 'normal-open')).assertEqual(1);

      setup.manager.onSocketEvent('open', appId, params, captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'normal-open')).assertEqual(1);
    });

    it('normal_terminal_delivery_same_callback_id_registering_again_does_not_replay_stale_payload', 0,
      async () => {
        const appId = 'app-normal-close-dup';
        connectAndCapture(setup.manager, appId, 1, 's0');
        await flushMicrotasks();
        const params = newLegacyEventParams('normal-close');
        setup.manager.onSocketEvent('close', appId, params, captureCallback().fn);
        const transport = setup.createdTransports[0];
        transport.fireOpen();
        transport.fireClose(1000, '');
        expect(countEventsByCallbackId(setup.events, 'normal-close')).assertEqual(1);

        setup.manager.onSocketEvent('close', appId, params, captureCallback().fn);
        expect(countEventsByCallbackId(setup.events, 'normal-close')).assertEqual(1);
      });

    it('reused_socket_id_does_not_replay_previous_connections_terminal_events', 0, async () => {
      const appId = 'app-reused-socket-id';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const oldTransport = setup.createdTransports[0];
      oldTransport.fireOpen();
      oldTransport.fireError('old generation');

      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const newTransport = setup.createdTransports[1];

      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'new-task-error'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('new-global-close'), captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'new-task-error')).assertEqual(0);
      expect(countEventsByCallbackId(setup.events, 'new-global-close')).assertEqual(0);

      newTransport.fireOpen();
      newTransport.fireError('new generation');

      const errorEvent = findEventByCallbackId(setup.events, 'new-task-error');
      const closeEvent = findEventByCallbackId(setup.events, 'new-global-close');
      expect(errorEvent !== undefined).assertTrue();
      expect(closeEvent !== undefined).assertTrue();
      // 这一代的事件各只投递一次：上一代同 socketId 留下的终态没有被补发进来。
      // 载荷本身不再能用来区分两代——传输层文本既不进 errMsg 也不进本地合成的 1006
      // reason，两代拿到的是同一组固定串，所以「没被上一代污染」靠计数来守。
      expect(countEventsByCallbackId(setup.events, 'new-task-error')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'new-global-close')).assertEqual(1);
      expect(payloadErrMsg(errorEvent!.payload)).assertEqual('connectSocket:fail WebSocket connection failed');
      expect(payloadCloseReason(closeEvent!.payload)).assertEqual('');
    });

    it('late_callbacks_from_old_transport_cannot_mutate_reused_socket_id_entry', 0, async () => {
      const appId = 'app-reused-socket-id-late-callbacks';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const oldTransport = setup.createdTransports[0];
      oldTransport.fireOpen();
      oldTransport.fireClose(1000, 'old closed');

      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const newTransport = setup.createdTransports[1];
      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'new-open'), captureCallback().fn);
      setup.manager.onSocketEvent('message', appId, newTaskEventParams('s0', 'new-message'), captureCallback().fn);
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('s0', 'new-error'), captureCallback().fn);
      setup.manager.onSocketEvent('close', appId, newTaskEventParams('s0', 'new-close'), captureCallback().fn);

      // detachTransport has already removed these SDK listeners. The fake retains their old closures
      // solely to model callbacks that the SDK queued just before off() completed.
      oldTransport.fireDetachedHeaderReceive('x-old', '1');
      oldTransport.fireDetachedOpen();
      oldTransport.fireDetachedMessage('stale');
      oldTransport.fireDetachedError('stale failure');
      oldTransport.fireDetachedClose(4001, 'stale close');
      expect(countEventsByCallbackId(setup.events, 'new-open')).assertEqual(0);
      expect(countEventsByCallbackId(setup.events, 'new-message')).assertEqual(0);
      expect(countEventsByCallbackId(setup.events, 'new-error')).assertEqual(0);
      expect(countEventsByCallbackId(setup.events, 'new-close')).assertEqual(0);

      newTransport.fireOpen();
      newTransport.fireMessage('fresh');
      expect(countEventsByCallbackId(setup.events, 'new-open')).assertEqual(1);
      expect(countEventsByCallbackId(setup.events, 'new-message')).assertEqual(1);
    });

    it('task_terminal_replay_same_callback_id_can_replay_again_after_off', 0, async () => {
      const appId = 'app-task-error-lifecycle';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[0].fireError('boom');

      const params = newTaskEventParams('s0', 'task-error-lifecycle');
      setup.manager.onSocketEvent('error', appId, params, captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'task-error-lifecycle')).assertEqual(1);

      setup.manager.offSocketEvent('error', appId, params, captureCallback().fn);
      setup.manager.onSocketEvent('error', appId, params, captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'task-error-lifecycle')).assertEqual(2);
    });

    it('legacy_open_replay_same_callback_id_can_replay_again_after_off', 0, async () => {
      const appId = 'app-global-open-lifecycle';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.createdTransports[0].fireOpen();

      const params = newLegacyEventParams('global-open-lifecycle');
      setup.manager.onSocketEvent('open', appId, params, captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'global-open-lifecycle')).assertEqual(1);

      setup.manager.offSocketEvent('open', appId, params, captureCallback().fn);
      setup.manager.onSocketEvent('open', appId, params, captureCallback().fn);
      expect(countEventsByCallbackId(setup.events, 'global-open-lifecycle')).assertEqual(2);
    });
  });
}
