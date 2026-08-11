import { describe, it, expect } from '@ohos/hypium';
import { DMPWebSocketValidation } from '../main/ets/Bridges/Network/DMPWebSocketManager';

/**
 * 覆盖 connectSocket/closeSocket 的纯函数校验。
 */
export default function dmpWebSocketValidationTest() {
  describe('DMPWebSocketValidationTest', () => {
    // ---------------- url ----------------
    it('url_rejects_non_ws_scheme', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('https://example.com/socket');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_fragment', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('wss://example.com/socket#frag');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_malformed', 0, () => {
      const r = DMPWebSocketValidation.validateUrl('not a url');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_rejects_missing_or_non_string', 0, () => {
      expect(DMPWebSocketValidation.validateUrl(undefined).ok).assertFalse();
      expect(DMPWebSocketValidation.validateUrl(123).ok).assertFalse();
    });

    it('url_accepts_wss_and_rejects_ws', 0, () => {
      const ws = DMPWebSocketValidation.validateUrl('ws://example.com:8080/path');
      expect(ws.ok).assertFalse();

      const wss = DMPWebSocketValidation.validateUrl('wss://example.com/path');
      expect(wss.ok).assertTrue();
      expect(wss.scheme).assertEqual('wss:');
    });

    it('url_rejects_invalid_host_characters', 0, () => {
      // 之前用宽松正则放行、真正失败要等深到 SDK 内部才报错；现在必须在
      // connectSocket 校验阶段就同步拒绝，对齐 Android/iOS。
      const r = DMPWebSocketValidation.validateUrl('wss://bad host/path');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid url');
    });

    it('url_strips_userinfo_from_host', 0, () => {
      // host 只应包含 host[:port]，不应包含 userinfo/凭据。
      const r = DMPWebSocketValidation.validateUrl('wss://user:pass@example.com:8080/path');
      expect(r.ok).assertTrue();
      expect(r.host).assertEqual('example.com:8080');
    });

    // ---------------- timeout ----------------
    it('timeout_default_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(60000);
    });

    it('timeout_falls_back_when_non_positive', 0, () => {
      const zero = DMPWebSocketValidation.validateTimeout(0);
      expect(zero.ok).assertTrue();
      expect(zero.value).assertEqual(60000);

      const negative = DMPWebSocketValidation.validateTimeout(-10);
      expect(negative.ok).assertTrue();
      expect(negative.value).assertEqual(60000);
    });

    it('timeout_rejects_non_finite', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(Number.NaN);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid timeout');

      const inf = DMPWebSocketValidation.validateTimeout(Number.POSITIVE_INFINITY);
      expect(inf.ok).assertFalse();
    });

    it('timeout_rejects_non_number_types', 0, () => {
      // 逐个断言而不是塞进一个 Object[]：混合类型的数组字面量触发
      // arkts-no-noninferrable-arr-literals，数组元素位置上的对象字面量还会触发
      // arkts-no-untyped-obj-literals，整个测试模块编译不过。
      const asString = DMPWebSocketValidation.validateTimeout('5000');
      expect(asString.ok).assertFalse();
      expect(asString.errMsg).assertEqual('invalid timeout');

      const asBoolean = DMPWebSocketValidation.validateTimeout(true);
      expect(asBoolean.ok).assertFalse();
      expect(asBoolean.errMsg).assertEqual('invalid timeout');

      const asArray = DMPWebSocketValidation.validateTimeout([5000]);
      expect(asArray.ok).assertFalse();
      expect(asArray.errMsg).assertEqual('invalid timeout');

      const asObject = DMPWebSocketValidation.validateTimeout({ timeout: 5000 });
      expect(asObject.ok).assertFalse();
      expect(asObject.errMsg).assertEqual('invalid timeout');
    });

    it('timeout_rejects_over_max', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(0x7fffffff + 1);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid timeout');
    });

    it('timeout_truncates_positive', 0, () => {
      const r = DMPWebSocketValidation.validateTimeout(1500.7);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1500);
    });

    // ---------------- protocols ----------------
    it('protocols_default_empty', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols(undefined);
      expect(r.ok).assertTrue();
      expect(r.value.length).assertEqual(0);
    });

    it('protocols_rejects_non_array', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols('chat');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('protocols must be an array');
    });

    it('protocols_rejects_empty_or_non_string_items', 0, () => {
      const empty = DMPWebSocketValidation.validateProtocols(['chat', '']);
      expect(empty.ok).assertFalse();
      expect(empty.errMsg).assertEqual('invalid protocol');

      const nonString = DMPWebSocketValidation.validateProtocols(['chat', 1]);
      expect(nonString.ok).assertFalse();
      expect(nonString.errMsg).assertEqual('invalid protocol');
    });

    it('protocols_accepts_valid_list', 0, () => {
      const r = DMPWebSocketValidation.validateProtocols(['chat', 'superchat']);
      expect(r.ok).assertTrue();
      expect(r.value.length).assertEqual(2);
    });

    // ---------------- header ----------------
    it('header_rejects_non_object', 0, () => {
      const r = DMPWebSocketValidation.validateHeader(['a']);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('header must be an object');

      const r2 = DMPWebSocketValidation.validateHeader('str');
      expect(r2.ok).assertFalse();
    });

    it('header_silently_drops_disallowed_names', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({
        'Host': 'evil.com',
        'Sec-WebSocket-Key': 'x',
        'X-Custom': 'ok',
      });
      expect(r.ok).assertTrue();
      expect(r.value.has('Host')).assertFalse();
      expect(r.value.has('Sec-WebSocket-Key')).assertFalse();
      expect(r.value.get('X-Custom')).assertEqual('ok');
    });

    it('header_silently_drops_empty_name_and_null_value', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({
        '   ': 'x',
        'Null-Value': null,
      });
      expect(r.ok).assertTrue();
      expect(r.value.size).assertEqual(0);
    });

    it('header_rejects_crlf_injection', 0, () => {
      const inName = DMPWebSocketValidation.validateHeader({ 'X-Evil\r\nInjected': 'v' });
      expect(inName.ok).assertFalse();
      expect(inName.errMsg).assertEqual('invalid header');

      const inValue = DMPWebSocketValidation.validateHeader({ 'X-Ok': 'v\r\nInjected: 1' });
      expect(inValue.ok).assertFalse();
      expect(inValue.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_leading_trailing_crlf_before_trimming', 0, () => {
      // The CR/LF check must run on the raw (untrimmed) name, not the already-trimmed one,
      // otherwise a leading/trailing CR/LF is silently stripped away instead of being
      // rejected - matches Android/iOS, which both check the raw name.
      const r = DMPWebSocketValidation.validateHeader({ '\r\nX-Evil': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_that_would_trim_to_empty', 0, () => {
      // The raw-name CR/LF check must run BEFORE the trim-to-empty/forbidden-name/null-value
      // early-continues, otherwise a name like "\r\n" (trims to empty) silently falls through
      // as "dropped" instead of failing invalid header.
      const r = DMPWebSocketValidation.validateHeader({ '\r\n': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_that_would_trim_to_forbidden', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'Host\r\n': 'v' });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_crlf_name_paired_with_null_value', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'X-Evil\r\n': null });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid header');
    });

    it('header_rejects_names_that_are_not_rfc_tokens', 0, () => {
      // 只查 CRLF 的话这些都会放行，各端的请求构造器再各自决定拒绝还是改写，
      // 三端接受的字段名集合就对不上了。
      const names: string[] = ['Bad:Name', 'Bad Name', 'Bad\tName', 'Bad"Name', 'Bad(Name)', 'Bad/Name'];
      for (const name of names) {
        const header: Record<string, string> = {};
        header[name] = 'v';
        const r = DMPWebSocketValidation.validateHeader(header);
        expect(r.ok).assertFalse();
        expect(r.errMsg).assertEqual('invalid header');
      }
    });

    it('header_accepts_every_rfc_token_character_in_a_name', 0, () => {
      const name = '!#$%&\'*+-.^_`|~0Az';
      const header: Record<string, string> = {};
      header[name] = 'v';
      const r = DMPWebSocketValidation.validateHeader(header);
      expect(r.ok).assertTrue();
      expect(r.value.get(name)).assertEqual('v');
    });

    it('header_rejects_control_characters_in_value', 0, () => {
      // NUL、SOH、垂直制表符、单元分隔符、DEL 都不能出现在字段值里。
      const values: string[] = ['a\u0000b', 'a\u0001b', 'a\u000Bb', 'a\u001Fb', 'a\u007Fb'];
      for (const value of values) {
        const r = DMPWebSocketValidation.validateHeader({ 'X-Custom': value });
        expect(r.ok).assertFalse();
        expect(r.errMsg).assertEqual('invalid header');
      }
    });

    it('header_keeps_tab_and_space_in_value', 0, () => {
      const r = DMPWebSocketValidation.validateHeader({ 'X-Custom': 'a\tb c' });
      expect(r.ok).assertTrue();
      expect(r.value.get('X-Custom')).assertEqual('a\tb c');
    });

    // ---------------- close code ----------------
    it('close_code_default_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1000);
    });

    it('close_code_rejects_reserved_range', 0, () => {
      const cases = [999, 1001, 2999, 5000];
      for (let i = 0; i < cases.length; i++) {
        const r = DMPWebSocketValidation.validateCloseCode(cases[i]);
        expect(r.ok).assertFalse();
        expect(r.errMsg).assertEqual('invalid code');
      }
    });

    it('close_code_accepts_1000_and_3000_4999_range', 0, () => {
      const cases = [1000, 3000, 4999, 3500];
      for (let i = 0; i < cases.length; i++) {
        const r = DMPWebSocketValidation.validateCloseCode(cases[i]);
        expect(r.ok).assertTrue();
        expect(r.value).assertEqual(cases[i]);
      }
    });

    it('close_code_rejects_non_integer', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(3000.5);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    // ---------------- close code：三端对照边界用例表 ----------------
    // 缺失/null/undefined 通过取默认值 1000；只有有限整数 number 可以通过；
    // string/boolean/数组/对象等其他类型一律不通过；最后统一做范围校验
    // （必须等于 1000 或落在 [3000, 4999]）。errMsg 沿用本文件既有约定，所有不通过
    // 情形统一是 'invalid code'（校验函数当前对类型/范围两类失败共用同一条 errMsg）。
    // 本组用例会被拿去和 Android/iOS 的同名对照用例比对，命名与取值需保持一致。

    it('close_code_boundary_undefined_passes_with_default_1000', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1000);
    });

    it('close_code_boundary_null_passes_with_default_1000', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(null);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1000);
    });

    it('close_code_boundary_number_1000_passes', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(1000);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(1000);
    });

    it('close_code_boundary_number_999_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(999);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_1001_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(1001);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_2999_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(2999);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_3000_passes', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(3000);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(3000);
    });

    it('close_code_boundary_number_4999_passes', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(4999);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(4999);
    });

    it('close_code_boundary_number_5000_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(5000);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_3000_point_0_passes', 0, () => {
      // 3000.0 与 3000 数值上相等、Number.isInteger 为真，必须按整数通过。
      const r = DMPWebSocketValidation.validateCloseCode(3000.0);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(3000);
    });

    it('close_code_boundary_number_3000_point_5_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(3000.5);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_NaN_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(Number.NaN);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_number_Infinity_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(Number.POSITIVE_INFINITY);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_3000_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode('3000');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_padded_3000_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(' 3000 ');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_3000_point_0_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode('3000.0');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_3000_point_5_fails', 0, () => {
      // Number('3000.5') = 3000.5，不是整数，必须不通过。
      const r = DMPWebSocketValidation.validateCloseCode('3000.5');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_abc_fails', 0, () => {
      // Number('abc') = NaN。
      const r = DMPWebSocketValidation.validateCloseCode('abc');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_empty_fails', 0, () => {
      // 空串必须直接不通过——不能落到 Number('') === 0 的通用转换分支（0 不在
      // 合法范围内固然也会被范围校验拦下，但空串必须在解析阶段就判定不通过）。
      const r = DMPWebSocketValidation.validateCloseCode('');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_string_whitespace_only_fails', 0, () => {
      // trim 后为空串，同上必须不通过。
      const r = DMPWebSocketValidation.validateCloseCode('  ');
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_boolean_true_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(true);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_boolean_false_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode(false);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_array_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode([3000]);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    it('close_code_boundary_plain_object_fails', 0, () => {
      const r = DMPWebSocketValidation.validateCloseCode({ code: 3000 });
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('invalid code');
    });

    // ---------------- close reason ----------------
    it('close_reason_default_empty_when_missing', 0, () => {
      const r = DMPWebSocketValidation.validateCloseReason(undefined);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual('');
    });

    it('close_reason_rejects_non_string', 0, () => {
      const r = DMPWebSocketValidation.validateCloseReason(123);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('reason must be a string');
    });

    it('close_reason_rejects_over_123_utf8_bytes', 0, () => {
      const longAscii = new Array(124).fill('a').join('');
      const r = DMPWebSocketValidation.validateCloseReason(longAscii);
      expect(r.ok).assertFalse();
      expect(r.errMsg).assertEqual('reason must not exceed 123 UTF-8 bytes');
    });

    it('close_reason_accepts_up_to_123_utf8_bytes', 0, () => {
      const exact = new Array(123).fill('a').join('');
      const r = DMPWebSocketValidation.validateCloseReason(exact);
      expect(r.ok).assertTrue();
      expect(r.value).assertEqual(exact);
    });

    it('close_reason_counts_utf8_bytes_not_chars', 0, () => {
      // 41 个 3 字节 UTF-8 汉字 = 123 字节，应通过
      const cjk41 = new Array(41).fill('中').join('');
      const okResult = DMPWebSocketValidation.validateCloseReason(cjk41);
      expect(okResult.ok).assertTrue();

      // 42 个汉字 = 126 字节 > 123，应拒绝
      const cjk42 = new Array(42).fill('中').join('');
      const failResult = DMPWebSocketValidation.validateCloseReason(cjk42);
      expect(failResult.ok).assertFalse();
    });
  });
}
