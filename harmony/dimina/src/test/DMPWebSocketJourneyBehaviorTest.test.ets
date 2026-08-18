import { describe, beforeEach, afterEach, it, expect } from '@ohos/hypium';
import { DMPWebSocketValidation } from '../main/ets/Bridges/Network/DMPWebSocketManager';
import {
  captureCallback,
  connectAndCapture,
  connectWithParams,
  countEventsByCallbackId,
  findEventByCallbackId,
  firstFailMessage,
  firstSuccessErrMsg,
  flushMicrotasks,
  makeTestSetup,
  newConnectParamsWithUrl,
  newEmptyParams,
  newLegacyEventParams,
  newLegacySendParams,
  newSocketIdParams,
  newTaskEventParams,
  openConnections,
  payloadErrMsg,
  TestSetup,
} from './DMPWebSocketTestSupport';

/** 超并发那条错误串逐字带两个 `fail`。 */
const MAX_CONNECT_ERR_MSG = 'connectSocket:fail fail reach max websocket connect count 5';

/** 连接失败识别不出具体原因时的通用兜底串。 */
const GENERIC_CONNECT_FAIL_ERR_MSG = 'connectSocket:fail WebSocket connection failed';

/** 超时只有这一条串：容器自己的连接计时器和传输层上报的超时共用它。 */
const TIMEOUT_ERR_MSG = 'connectSocket:fail timeout';

/** NetStack 约定的操作超时码（2300000 + CURLE 28）。 */
const TRANSPORT_TIMEOUT_CODE = 2300028;

/** `@ohos.net.webSocket` 文档化的一个非超时错误码，用来验证分类真的在看码。 */
const TRANSPORT_NON_TIMEOUT_CODE = 2302001;

/**
 * 用户旅程组合（一次操作之后的下一步交互）与三端逐字一致性。
 *
 * 单次操作的结果画面正确不代表后置状态正确——全局绑定、并发名额这类状态错误只在第二次
 * 交互上暴露。断言一律逐字全等。
 */
export default function dmpWebSocketJourneyBehaviorTest() {
  describe('DMPWebSocketJourneyBehaviorTest', () => {
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

    // ---------------- wx.closeSocket → wx.connectSocket → wx.sendSocketMessage ----------------

    /*
     * `wx.closeSocket()` 之后**不等 close 事件到达**就马上建新连接，再用全局 send 发消息。
     *
     * Dimina 在全局 close 被接受后允许新连接接管全局路由，而原生条目要等真正的 close
     * 事件才从 sockets 移除，改绑判据又是「旧 id 不在 sockets 里」，于是新连接永远接不到
     * 绑定，后续全局 send 全打在那条正在关闭的旧连接上。
     */

    it('legacy_close_then_new_connect_hands_the_global_binding_to_the_new_connection', 0, async () => {
      const appId = 'journey-rebind-after-close';
      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      const tA = setup.createdTransports[0];
      tA.fireOpen();

      // 全局 close：A 进入关闭握手，close 事件还没回来。
      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newEmptyParams(), closeCap.fn);
      expect(firstSuccessErrMsg(closeCap.calls)).assertEqual('closeSocket:ok');

      // 不等 A 的 close 事件，直接建新连接并开起来。
      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      const tB = setup.createdTransports[1];
      tB.fireOpen();

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('hi'), sendCap.fn);

      expect(firstFailMessage(sendCap.calls)).assertEqual('');
      expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');
      // 打在 B 上，不能打在正在关闭的 A 上。
      expect(tB.sendCalls.length).assertEqual(1);
      expect(tA.sendCalls.length).assertEqual(0);
    });

    /**
     * 旧连接的 close 事件迟到时，不得把全局绑定从新连接抢回去，也不得误伤新连接。
     */
    it('late_close_event_of_the_old_connection_neither_steals_the_binding_back_nor_harms_the_new_one',
      0, async () => {
        const appId = 'journey-late-close-after-rebind';
        connectAndCapture(setup.manager, appId, 1, 'A');
        await flushMicrotasks();
        const tA = setup.createdTransports[0];
        tA.fireOpen();
        setup.manager.closeSocket(appId, newEmptyParams(), captureCallback().fn);

        connectAndCapture(setup.manager, appId, 1, 'B');
        await flushMicrotasks();
        const tB = setup.createdTransports[1];
        tB.fireOpen();
        setup.manager.onSocketEvent('close', appId, newTaskEventParams('B', 'b-close'), captureCallback().fn);

        // A 的关闭握手这时候才收尾。
        tA.fireClose(1000, '');

        const sendCap = captureCallback();
        setup.manager.sendSocketMessage(appId, newLegacySendParams('after-late-close'), sendCap.fn);
        expect(firstFailMessage(sendCap.calls)).assertEqual('');
        expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');
        expect(tB.sendCalls.length).assertEqual(1);
        expect(tA.sendCalls.length).assertEqual(0);
        // B 毫发无损：没收到 close，传输层也没被关。
        expect(countEventsByCallbackId(setup.events, 'b-close')).assertEqual(0);
        expect(tB.closeCalls.length).assertEqual(0);
      });

    /**
     * 任务态的 `SocketTask.close()` **不**让出全局绑定。
     *
     * CLOSING 有两个来源，Dimina 的全局路由处理不同：
     * - `wx.closeSocket()` 被接受后让位，见上面那条对照用例
     * - `SocketTask.close()` 只处理自身，不让位
     *
     * 只看容器内部的 CLOSING 状态分不出这两者，于是业务只对某一条 task 调了 close()，
     * 全局绑定就会被下一次 connectSocket 抢走。
     *
     * 判据用「A 的 close 事件到达时，全局 close 监听收不收得到」——全局事件只投递给当前
     * 绑定的那条连接，所以这直接问的就是「绑定还在不在 A」，不掺 send 在 CLOSING 期间
     * 该不该成功那类另有争议的语义。
     */
    it('task_close_does_not_hand_the_global_binding_to_the_next_connection', 0, async () => {
      const appId = 'a35-task-close-keeps-binding';
      setup.manager.onSocketEvent('close', appId, newLegacyEventParams('global-close'), captureCallback().fn);

      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      const tA = setup.createdTransports[0];
      tA.fireOpen();

      // 任务态 close（params 带 socketId），不是全局 wx.closeSocket()。
      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdParams('A'), closeCap.fn);
      expect(firstSuccessErrMsg(closeCap.calls)).assertEqual('closeSocket:ok');

      connectAndCapture(setup.manager, appId, 1, 'B');
      await flushMicrotasks();
      const tB = setup.createdTransports[1];
      tB.fireOpen();

      tA.fireClose(1000, '');

      // 绑定仍在 A：A 的 close 事件必须送达全局监听。
      expect(countEventsByCallbackId(setup.events, 'global-close')).assertEqual(1);
      // 而且绑定没有被 B 抢走：全局 send 一次都不该打到 B 上。
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('hi'), sendCap.fn);
      expect(tB.sendCalls.length).assertEqual(0);
    });

    /**
     * 名额在 close **事件**到达时才归还，`wx.closeSocket()` 只是发出请求，A 停在
     * 关闭握手中期间仍然占着自己那一格。
     *
     * 这条同时是上面那个改绑修复的护栏：如果把「让新连接接管绑定」实现成 close 请求当刻
     * 就把条目从 sockets 里删掉，名额会跟着提前归还，这条会立刻变红。
     */
    it('closing_connection_still_holds_its_concurrency_slot_until_the_close_event', 0, async () => {
      const appId = 'journey-closing-holds-slot';
      connectAndCapture(setup.manager, appId, 1, 'A');
      await flushMicrotasks();
      const tA = setup.createdTransports[0];
      tA.fireOpen();

      setup.manager.closeSocket(appId, newEmptyParams(), captureCallback().fn);

      // A 之外再开满四条：连 A 一共五格，名额应该正好用光。
      await openConnections(setup, appId, ['B', 'C', 'D', 'E']);

      const refused = connectAndCapture(setup.manager, appId, 1, 'F');
      await flushMicrotasks();
      expect(firstFailMessage(refused)).assertEqual(MAX_CONNECT_ERR_MSG);

      // A 的 close 事件到达，这一格才让出来。
      tA.fireClose(1000, '');
      const accepted = connectAndCapture(setup.manager, appId, 1, 'G');
      await flushMicrotasks();
      expect(firstFailMessage(accepted)).assertEqual('');
      expect(firstSuccessErrMsg(accepted)).assertEqual('connectSocket:ok');
    });

    // ---------------- send 被传输层拒绝时的文案 ----------------

    /**
     * 传输层拒绝这次发送时，回给小程序的必须是固定的非本地化英文串，不能把传输层自己的
     * 消息透传出去——那串东西随平台和系统语言变，三端对不上，小程序也没法据此判断。
     */
    it('send_rejected_by_the_transport_reports_the_fixed_non_localized_message', 0, async () => {
      const appId = 'journey-send-rejected-text';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const transport = setup.createdTransports[0];
      transport.fireOpen();

      transport.sendErrorMessage = 'Falha ao enviar: conexão perdida';
      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('ping'), sendCap.fn);

      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');
    });

    // ---------------- errMsg 里不得出现 OS / SDK 的本地化文案 ----------------

    /*
     * errMsg 是给小程序**判定**用的契约文本，跟着设备语言变等于没有契约。底层原始错误可以
     * 进日志，但不能进 errMsg——errMsg 只能由容器自己那套固定英文串构成。
     *
     * 下面两条都用「同一种失败，底层给两种不同措辞」的形状：断言派发出去的 errMsg 相同，
     * 而不是断言它等于某一条具体的串——具体取哪条兜底串不写死，这里只锁「不掺 SDK 文本」。
     */

    it('error_event_errMsg_is_locale_invariant_and_never_carries_transport_text', 0, async () => {
      const appId = 'a21-error-locale-invariance';

      connectAndCapture(setup.manager, appId, 1, 'sEn');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sEn', 'cb-en'), captureCallback().fn);
      setup.createdTransports[0].fireError('Connection refused by peer');

      connectAndCapture(setup.manager, appId, 1, 'sZh');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sZh', 'cb-zh'), captureCallback().fn);
      setup.createdTransports[1].fireError('对端拒绝了连接');

      // 底层什么消息都没给的那次，走的就是容器自己的兜底串。
      connectAndCapture(setup.manager, appId, 1, 'sNone');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sNone', 'cb-none'), captureCallback().fn);
      setup.createdTransports[2].fireError('');

      const enEvt = findEventByCallbackId(setup.events, 'cb-en');
      const zhEvt = findEventByCallbackId(setup.events, 'cb-zh');
      const noneEvt = findEventByCallbackId(setup.events, 'cb-none');
      expect(enEvt !== undefined).assertTrue();
      expect(zhEvt !== undefined).assertTrue();
      expect(noneEvt !== undefined).assertTrue();

      // 同一种失败换个语言不能变出另一条 errMsg。
      expect(payloadErrMsg(enEvt!.payload)).assertEqual(payloadErrMsg(zhEvt!.payload));
      // 而且必须收敛到「底层没给消息」时那条容器自己的串——只要还在拼 SDK 文本，这条就不成立。
      expect(payloadErrMsg(enEvt!.payload)).assertEqual(payloadErrMsg(noneEvt!.payload));
      // 逐字钉死那条串：只断言三者相等的话，实现把 errMsg 全置空也能过。
      expect(payloadErrMsg(enEvt!.payload)).assertEqual(GENERIC_CONNECT_FAIL_ERR_MSG);
    });

    /**
     * 超时的识别只看结构化错误码，不看消息文本。
     *
     * 分类必须做到三件事，缺一条这个用例就该红：
     * ① 认得出超时码 —— 带超时码的落 `connectSocket:fail timeout`；
     * ② 认得出「不是超时」—— 换个非超时码，哪怕消息文本明写着 timed out，也只能落通用兜底串；
     * ③ 与语言无关 —— 同一个码配中文消息，结果和配英文消息完全一样。
     *
     * ② 是这条用例的鉴别力所在：文案一律不参与分类之后，「各种措辞都相等」是恒真的，
     * 只有「同一段文本、不同的码 → 不同的结果」才证明分类真的在读结构化信息。
     */
    it('timeout_classification_is_driven_by_the_error_code_not_the_message_text', 0, async () => {
      const appId = 'a26-timeout-classified-by-code';

      connectAndCapture(setup.manager, appId, 1, 'sCodeEn');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sCodeEn', 'cb-code-en'), captureCallback().fn);
      setup.createdTransports[0].fireErrorWithCode(TRANSPORT_TIMEOUT_CODE, 'Connection timed out');

      connectAndCapture(setup.manager, appId, 1, 'sCodeZh');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sCodeZh', 'cb-code-zh'), captureCallback().fn);
      setup.createdTransports[1].fireErrorWithCode(TRANSPORT_TIMEOUT_CODE, '连接超时');

      // 非超时码，但消息文本照样写着 timed out。
      connectAndCapture(setup.manager, appId, 1, 'sOtherCode');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sOtherCode', 'cb-other-code'),
        captureCallback().fn);
      setup.createdTransports[2].fireErrorWithCode(TRANSPORT_NON_TIMEOUT_CODE, 'Connection timed out');

      // 完全没有结构化信息可用。
      connectAndCapture(setup.manager, appId, 1, 'sNoCode');
      await flushMicrotasks();
      setup.manager.onSocketEvent('error', appId, newTaskEventParams('sNoCode', 'cb-no-code'), captureCallback().fn);
      setup.createdTransports[3].fireError('Connection timed out');

      const codeEn = findEventByCallbackId(setup.events, 'cb-code-en');
      const codeZh = findEventByCallbackId(setup.events, 'cb-code-zh');
      const otherCode = findEventByCallbackId(setup.events, 'cb-other-code');
      const noCode = findEventByCallbackId(setup.events, 'cb-no-code');
      expect(codeEn !== undefined).assertTrue();
      expect(codeZh !== undefined).assertTrue();
      expect(otherCode !== undefined).assertTrue();
      expect(noCode !== undefined).assertTrue();

      expect(payloadErrMsg(codeEn!.payload)).assertEqual(TIMEOUT_ERR_MSG);
      expect(payloadErrMsg(codeZh!.payload)).assertEqual(TIMEOUT_ERR_MSG);
      expect(payloadErrMsg(otherCode!.payload)).assertEqual(GENERIC_CONNECT_FAIL_ERR_MSG);
      expect(payloadErrMsg(noCode!.payload)).assertEqual(GENERIC_CONNECT_FAIL_ERR_MSG);
    });

    it('send_fail_errMsg_is_locale_invariant_across_both_rejection_paths', 0, async () => {
      const appId = 'a21-send-locale-invariance';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      const transport = setup.createdTransports[0];
      transport.fireOpen();

      transport.sendErrorMessage = 'Falha ao enviar: conexão perdida';
      const ptCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('a'), ptCap.fn);

      transport.sendErrorMessage = '发送失败：连接已断开';
      const zhCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('b'), zhCap.fn);

      // 另一条拒绝路径：传输层不报错，只是回一个「没发出去」。
      transport.sendErrorMessage = '';
      transport.sendShouldSucceed = false;
      const plainCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('c'), plainCap.fn);

      expect(firstFailMessage(ptCap.calls)).assertEqual(firstFailMessage(zhCap.calls));
      expect(firstFailMessage(ptCap.calls)).assertEqual(firstFailMessage(plainCap.calls));
      expect(firstFailMessage(ptCap.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');
    });

    // ---------------- url 里的裸空格 ----------------

    /**
     * 路径/查询串里的裸空格必须拒。实现的正则把 `#` 之前的部分整段用 `[^#]*` 放过去了，
     * 空格这类 RFC 里不允许直接出现的字符也一并放行；Android 用 `java.net.URI` 解析，
     * 同样的地址在那边是 `invalid url`。
     */
    it('url_rejects_a_bare_space_in_the_path_or_query', 0, () => {
      const inPath = DMPWebSocketValidation.validateUrl('wss://example.com/a b');
      expect(inPath.ok).assertFalse();
      expect(inPath.errMsg).assertEqual('invalid url');

      const inQuery = DMPWebSocketValidation.validateUrl('wss://example.com/socket?q=a b');
      expect(inQuery.ok).assertFalse();
      expect(inQuery.errMsg).assertEqual('invalid url');
    });

    /*
     * url 与 header 值是**两套规则，不要互相蔓延**：
     * - header 值拒非 ASCII —— RFC 7230 的 obs-text 已废弃，OkHttp 直接拒
     *   （见 DMPWebSocketSettlerAndHeaderBehaviorTest）
     * - url 放行非 ASCII —— 属 IDN / 百分号编码范畴，只拒那批必须先编码的 ASCII 字符
     *
     * 实测 `java.net.URI("wss://example.com/中文")` 是接受的（`getHost()` 正常返回
     * `example.com`），Android 因此放行拨号，iOS 也显式放行 CJK 路径。url 上按 ASCII 白名单
     * 一刀切会把中文路径拒掉，等于换个方向重新造出三端分叉。
     */

    it('url_accepts_non_ascii_in_the_path_and_query', 0, () => {
      const cjkPath = DMPWebSocketValidation.validateUrl('wss://example.com/中文路径');
      expect(cjkPath.ok).assertTrue();
      expect(cjkPath.host).assertEqual('example.com');

      const cjkQuery = DMPWebSocketValidation.validateUrl('wss://example.com/socket?q=中文');
      expect(cjkQuery.ok).assertTrue();

      // 代理对（emoji）走的是两个码元，逐码元判定时容易另眼相看。
      const emojiPath = DMPWebSocketValidation.validateUrl('wss://example.com/p/\u{1F600}');
      expect(emojiPath.ok).assertTrue();
    });

    /** 非 ASCII 路径要真的拨出去，且原样下发——不能在容器这一层被悄悄改写成百分号编码。 */
    it('connect_with_a_non_ascii_path_dials_the_url_unchanged', 0, async () => {
      const appId = 'a34-non-ascii-path-dials';
      const url = 'wss://example.com/中文路径';
      const calls = connectWithParams(setup.manager, appId, 1, newConnectParamsWithUrl('s0', url));
      await flushMicrotasks();

      expect(firstFailMessage(calls)).assertEqual('');
      expect(firstSuccessErrMsg(calls)).assertEqual('connectSocket:ok');
      expect(setup.createdTransports.length).assertEqual(1);
      expect(setup.createdTransports[0].dialedUrl(0)).assertEqual(url);
    });

    /**
     * 放行非 ASCII 不等于放行一切：那批必须先百分号编码才能进 url 的 ASCII 字符仍要拒。
     * 这条守的是「放松过头」——把字符集判据从 ASCII 白名单改开之后，最容易顺手把这些也放了。
     */
    it('url_still_rejects_the_ascii_characters_that_must_be_percent_encoded', 0, () => {
      // 控制字符用转义写，别把裸字节放进源码。
      const forbidden: string[] = [' ', '"', '<', '>', '{', '}', '|', '\\', '^', '`',
        '\u0001', '\u007F'];
      for (const ch of forbidden) {
        const result = DMPWebSocketValidation.validateUrl(`wss://example.com/p${ch}q`);
        expect(result.ok).assertFalse();
        expect(result.errMsg).assertEqual('invalid url');
      }
    });

    /** 已经百分号编码的写法一律合法——调用方表达这些字符的正当途径就是它。 */
    it('url_accepts_percent_encoded_sequences', 0, () => {
      const wellFormed: string[] = [
        'wss://example.com/a%20b',
        'wss://example.com/%E4%B8%AD%E6%96%87',
        'wss://example.com/a%2Fb',
        'wss://example.com/a%aBc', // 十六进制大小写混写照收
        'wss://example.com/a%00b',
        'wss://example.com/socket?q=%E4%B8%AD',
      ];
      for (const raw of wellFormed) {
        const result = DMPWebSocketValidation.validateUrl(raw);
        expect(result.ok).assertTrue();
      }
    });

    /**
     * 残缺的百分号转义必须拒：`%` 后面必须紧跟两位十六进制数字。
     *
     * 放行非 ASCII 之后这条尤其要在——`%` 成了字符集判据里唯一还不受约束的字符，
     * 不查它就等于给 url 留了一个什么都能塞的口子。
     */
    it('url_rejects_incomplete_percent_escapes', 0, () => {
      const malformed: string[] = [
        'wss://example.com/a%zz', // 后面两位根本不是十六进制
        'wss://example.com/a%2', // 结尾处只剩一位
        'wss://example.com/a%', // 结尾处一个光杆 %
        'wss://example.com/%', // 整条路径就一个 %
        'wss://example.com/a%G0b', // 第一位越出十六进制
        'wss://example.com/a%2Gb', // 第二位越出十六进制
        'wss://example.com/socket?q=%', // 查询串里也要查
      ];
      for (const raw of malformed) {
        const result = DMPWebSocketValidation.validateUrl(raw);
        expect(result.ok).assertFalse();
        expect(result.errMsg).assertEqual('invalid url');
      }
    });

    // ---------------- 传输层错误消息的归一化 ----------------

    /**
     * 消息文本一律不参与分类：没有结构化错误码时，无论底层说了什么，都落通用兜底串。
     *
     * 逐条钉死兜底串（而不是只断言「它们彼此相等」）是这条用例的鉴别力所在——文案判据
     * 一旦回来，`timeout` 这种裸词就会被认成超时、分到另一条串，这里立刻红。
     * 数据里特意混了裸英文词、裸本地化词和成句描述：裸词是整串锚定的文案判据唯一还能
     * 命中的形状，也是它与本地化裸词分道扬镳的那个洞。
     */
    it('transport_message_text_never_classifies_the_error_and_always_falls_to_the_generic_errMsg',
      0, async () => {
        const appId = 'a26-text-never-classifies';
        const wordings: string[] = ['timeout', 'timed out', 'time out', '超时',
          'Connection timed out', 'Connection refused by peer', ''];

        for (let i = 0; i < wordings.length; i++) {
          const socketId = `s${i}`;
          const callbackId = `cb-${i}`;
          connectAndCapture(setup.manager, appId, 1, socketId);
          await flushMicrotasks();
          setup.manager.onSocketEvent('error', appId, newTaskEventParams(socketId, callbackId),
            captureCallback().fn);
          setup.createdTransports[i].fireError(wordings[i]);

          const evt = findEventByCallbackId(setup.events, callbackId);
          expect(evt !== undefined).assertTrue();
          expect(payloadErrMsg(evt!.payload)).assertEqual(GENERIC_CONNECT_FAIL_ERR_MSG);
        }
      });
  });
}
