import { describe, beforeEach, afterEach, it, expect } from '@ohos/hypium';
import { DMPWebSocketValidation } from '../main/ets/Bridges/Network/DMPWebSocketManager';
import {
  captureCallback,
  connectAndCapture,
  connectWithParams,
  countSuccessCalls,
  findEventByCallbackId,
  firstCompletePayloadJson,
  firstFailMessage,
  firstFailPayloadJson,
  firstSuccessErrMsg,
  firstSuccessPayloadJson,
  flushMicrotasks,
  makeTestSetup,
  newConnectParamsWithHeader,
  newConnectParamsWithHeaders,
  newConnectParamsWithUrl,
  newLegacySendParams,
  newSendParams,
  newSocketIdParams,
  newTaskEventParams,
  payloadHeaderValue,
  TestSetup,
} from './DMPWebSocketTestSupport';

/**
 * 一次性回调三件套的载荷一致性，以及请求头/响应头的字符集与合并规则。
 *
 * `complete` 拿到的 res 必须和 `success`/`fail` 那一次完全相同——调用方写
 * `complete: res => res.errMsg` 是官方文档里的常规写法，收到空载荷等于这个字段不存在。
 */
export default function dmpWebSocketSettlerAndHeaderBehaviorTest() {
  describe('DMPWebSocketSettlerAndHeaderBehaviorTest', () => {
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

    // ---------------- complete 的载荷 ----------------

    /*
     * 三条一次性回调路径（connect / send / close）共用同一个 complete 出口，所以这两条用例
     * 覆盖的是同一个单点，成功与失败两个方向各一条。逐字钉死每一条串而不是只断言
     * 「complete 等于 success/fail」——两边都是空载荷时那种写法也会通过。
     */

    it('complete_carries_the_same_res_as_success_on_connect_send_and_close', 0, async () => {
      const appId = 'settler-complete-success';

      const connectCalls = connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      expect(firstSuccessErrMsg(connectCalls)).assertEqual('connectSocket:ok');
      // 逐字比对整个载荷，不是只比 errMsg：契约管的是「complete 拿到与 success 同一个结果
      // 对象」，只比一个字段的话 complete 多带一个内部字段（socketId 之类）不会被发现。
      expect(firstCompletePayloadJson(connectCalls)).assertEqual(firstSuccessPayloadJson(connectCalls));

      setup.createdTransports[0].fireOpen();

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newSendParams('s0', 'ping'), sendCap.fn);
      expect(firstSuccessErrMsg(sendCap.calls)).assertEqual('sendSocketMessage:ok');
      expect(firstCompletePayloadJson(sendCap.calls)).assertEqual(firstSuccessPayloadJson(sendCap.calls));

      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdParams('s0'), closeCap.fn);
      expect(firstSuccessErrMsg(closeCap.calls)).assertEqual('closeSocket:ok');
      expect(firstCompletePayloadJson(closeCap.calls)).assertEqual(firstSuccessPayloadJson(closeCap.calls));
      // 载荷两边都空时上面那条也会通过，所以再钉一次实际内容。
      expect(firstCompletePayloadJson(closeCap.calls)).assertEqual('{"errMsg":"closeSocket:ok"}');
    });

    it('complete_carries_the_same_res_as_fail_on_connect_send_and_close', 0, async () => {
      const appId = 'settler-complete-fail';

      const connectCalls = connectWithParams(setup.manager, appId, 1,
        newConnectParamsWithUrl('s0', 'https://example.com/socket'));
      await flushMicrotasks();
      expect(firstFailMessage(connectCalls)).assertEqual('connectSocket:fail invalid url');
      expect(firstCompletePayloadJson(connectCalls)).assertEqual(firstFailPayloadJson(connectCalls));

      const sendCap = captureCallback();
      setup.manager.sendSocketMessage(appId, newLegacySendParams('ping'), sendCap.fn);
      expect(firstFailMessage(sendCap.calls)).assertEqual('sendSocketMessage:fail WebSocket is not connected');
      expect(firstCompletePayloadJson(sendCap.calls)).assertEqual(firstFailPayloadJson(sendCap.calls));

      const closeCap = captureCallback();
      setup.manager.closeSocket(appId, newSocketIdParams('nope'), closeCap.fn);
      expect(firstFailMessage(closeCap.calls)).assertEqual('closeSocket:fail WebSocket is not connected');
      expect(firstCompletePayloadJson(closeCap.calls)).assertEqual(firstFailPayloadJson(closeCap.calls));
      expect(firstCompletePayloadJson(closeCap.calls))
        .assertEqual('{"errMsg":"closeSocket:fail WebSocket is not connected"}');
      // 失败路径不能顺手也调一次 success。
      expect(countSuccessCalls(closeCap.calls)).assertEqual(0);
    });

    // ---------------- 请求头的值只允许 ASCII ----------------

    /*
     * fe 让 string 值原样穿透，所以中文这类非 ASCII 的 header 值是正常链路能走到的
     * 合法输入。RFC 7230 里 header 值的 obs-text（0x80–0xFF）已废弃，OkHttp 直接拒；
     * 放行的那一端连得上、拒绝的那一端连不上，同一份小程序代码在两端表现不同。
     * 三端统一在校验阶段拒，errMsg 沿用本文件既有的 `invalid header`。
     */

    it('header_value_rejects_non_ascii_characters', 0, () => {
      const cjk = DMPWebSocketValidation.validateHeader({ 'X-Custom': '中文' });
      expect(cjk.ok).assertFalse();
      expect(cjk.errMsg).assertEqual('invalid header');

      // 拉丁扩展区（é = U+00E9）同样是 obs-text，不能因为"看起来像 ASCII"就放行。
      const latin1 = DMPWebSocketValidation.validateHeader({ 'X-Custom': 'café' });
      expect(latin1.ok).assertFalse();
      expect(latin1.errMsg).assertEqual('invalid header');

      // 表情符号走代理对，逐码元检查时容易漏。
      const emoji = DMPWebSocketValidation.validateHeader({ 'X-Custom': 'ok\u{1F600}' });
      expect(emoji.ok).assertFalse();
      expect(emoji.errMsg).assertEqual('invalid header');
    });

    /** 防收紧过头：可打印 ASCII 全段（空格 0x20 到 `~` 0x7E）加水平制表符都必须照收。 */
    it('header_value_accepts_the_whole_printable_ascii_range', 0, () => {
      let printable = '\t';
      for (let code = 0x20; code <= 0x7e; code++) {
        printable += String.fromCharCode(code);
      }
      const result = DMPWebSocketValidation.validateHeader({ 'X-Custom': printable });
      expect(result.ok).assertTrue();
      expect(result.value.get('X-Custom')).assertEqual(printable);
    });

    /** 拒绝必须发生在拨号之前：不能先回 `connectSocket:ok`、连上之后才报错。 */
    it('connect_with_a_non_ascii_header_value_fails_before_any_dial', 0, async () => {
      const appId = 'settler-non-ascii-header-dial';
      const calls = connectWithParams(setup.manager, appId, 1,
        newConnectParamsWithHeader('s0', 'X-Custom', '中文'));
      await flushMicrotasks();

      expect(firstFailMessage(calls)).assertEqual('connectSocket:fail invalid header');
      expect(firstSuccessErrMsg(calls)).assertEqual('');
      expect(setup.createdTransports.length).assertEqual(0);
    });

    // ---------------- 仅大小写不同的请求头字段名 ----------------

    /**
     * `@ohos.net.webSocket` 把 header 存成大小写不敏感的结构，仅大小写不同的两个字段名
     * 交给 connect() 后落到线上只剩一个（真机实测确认）。校验层
     * （validateHeader）不折叠、两个变体都留着，这里守的是拨号前最后一步：
     * 折叠成一个不能靠 native 内部的遍历顺序决定，必须是这里自己按固定规则（字段名
     * 字典序最小者胜）选出来的，同一份 header 每次拨号都要选到同一个。
     */
    it('outgoing_dial_keeps_only_the_lexicographically_smaller_case_variant', 0, async () => {
      const appId = 'settler-header-case-collision';
      const header: Record<string, string> = { 'X-Dimina-Case': 'upper', 'x-dimina-case': 'lower' };
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithHeaders('s0', header));
      await flushMicrotasks();

      const transport = setup.createdTransports[0];
      expect(transport !== undefined).assertTrue();
      // 'X-Dimina-Case' < 'x-dimina-case'（大写字母的 code point 更小），字典序更小者胜。
      expect(transport.dialedHeader('X-Dimina-Case')).assertEqual('upper');
      expect(transport.dialedHeaderKeys().includes('x-dimina-case')).assertFalse();
    });

    /** 折叠只应该对真正撞车（大小写不敏感相等）的字段名生效，不相关的字段名必须原样都在。 */
    it('outgoing_dial_does_not_touch_header_names_that_do_not_collide', 0, async () => {
      const appId = 'settler-header-no-collision';
      const header: Record<string, string> = { 'X-Dimina-Case': 'upper', 'x-dimina-case': 'lower', 'X-Other': 'v' };
      connectWithParams(setup.manager, appId, 1, newConnectParamsWithHeaders('s0', header));
      await flushMicrotasks();

      const transport = setup.createdTransports[0];
      expect(transport !== undefined).assertTrue();
      expect(transport.dialedHeader('X-Other')).assertEqual('v');
      // 折叠只吃掉大小写撞车的那一对；X-Other 与容器注入的 Referer 都得原样在场。
      expect(transport.dialedHeaderKeys().length).assertEqual(3);
      expect(transport.dialedHeaderKeys().includes('Referer')).assertTrue();
    });

    // ---------------- 响应头的重复键合并 ----------------

    /**
     * 同名响应头按 RFC 7230 §3.2.2 用 `, ` 拼接，不是后到的覆盖先到的。响应头是 open 载荷
     * 的一部分、业务可见，覆盖会让先到的那份（比如第一条 Set-Cookie）凭空消失。
     */
    it('duplicate_response_header_keys_are_comma_joined_not_overwritten', 0, async () => {
      const appId = 'settler-dup-response-header';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'cb-open'), captureCallback().fn);
      const transport = setup.createdTransports[0];

      transport.fireHeaderReceive('x-dup', 'first');
      transport.fireHeaderReceive('x-dup', 'second');
      transport.fireOpen();

      const evt = findEventByCallbackId(setup.events, 'cb-open');
      expect(evt !== undefined).assertTrue();
      expect(payloadHeaderValue(evt!.payload, 'x-dup')).assertEqual('first, second');
      // 只有一个值的头不能被拼出多余的逗号。
      expect(payloadHeaderValue(evt!.payload, 'x-single')).assertEqual('');
    });

    /** 同一个头以数组形式一次性到达时同样是逗号拼接（这条现状已满足，锁住别退回去）。 */
    it('a_response_header_delivered_as_a_list_is_comma_joined', 0, async () => {
      const appId = 'settler-list-response-header';
      connectAndCapture(setup.manager, appId, 1, 's0');
      await flushMicrotasks();
      setup.manager.onSocketEvent('open', appId, newTaskEventParams('s0', 'cb-open'), captureCallback().fn);
      const transport = setup.createdTransports[0];

      transport.fireHeaderReceiveList('x-list', ['a', 'b']);
      transport.fireHeaderReceive('x-plain', 'solo');
      transport.fireOpen();

      const evt = findEventByCallbackId(setup.events, 'cb-open');
      expect(evt !== undefined).assertTrue();
      expect(payloadHeaderValue(evt!.payload, 'x-list')).assertEqual('a, b');
      expect(payloadHeaderValue(evt!.payload, 'x-plain')).assertEqual('solo');
    });
  });
}
